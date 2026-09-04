---
title: Recovering a filename by splitting a formatted error string on ':' truncates filenames that contain a colon
date: 2026-09-04
category: logic-errors
module: jira/load-ticket-attachment-download
problem_type: logic_error
component: assistant
symptoms:
  - "An attachment whose filename contains a colon (e.g. \"log:2024-01-15.txt\") that fails to download shows up in the skipped-attachments list under a truncated, wrong filename (e.g. \"log\")"
  - "The skipped-list entry for that attachment carries placeholder values instead of real ones: content empty, size 0, mimeType 'unknown'"
  - "A retry of the failed download has nothing to work with, since the re-lookup by truncated filename never matches the original attachment and only fallback placeholders are used"
  - "Caught only by a post-implementation ce-code-review pass on the finished diff (part of the load-ticket entry-point parity work, PR #48), not by planning-phase review or by the implementer"
root_cause: logic_error
resolution_type: code_fix
severity: low
related_components: [loadHandler]
tags: [string-parsing, error-handling, filename-handling, attachment-download, load-ticket-parity, code-review-finding, unsafe-string-roundtrip]
---

# Recovering a filename by splitting a formatted error string on ':' truncates filenames that contain a colon

## Problem

`loadTicketToWorkspace` (`src/participant/jira/loadHandler.ts`) recovered which attachment had failed to download by re-parsing an already-formatted, human-readable log string (`"<filename>: <message>"`) instead of keeping the original attachment object around. Splitting that string on `:` to recover the filename silently truncated any filename that itself contained a colon — a legal filename character that Jira does not reject on upload.

## Symptoms

- A failed attachment download whose filename contains a colon (e.g. `log:2024-01-15.txt`) shows up in the "skipped" list under a truncated, wrong filename (`log`) instead of its real name.
- Because the truncated filename doesn't match any real attachment (`toDownload.find(a => a.filename === filename)` finds nothing), the skipped-list entry silently falls back to `content: ''`, `size: 0`, `mimeType: 'unknown'` — none of which are the real attachment's data.
- The documented recovery hint for a skipped attachment ("use `jira_downloadAttachment` to fetch it by name") doesn't actually work for this entry: there's no real download URL left (`content` is empty), and even the filename shown to the user to retry with is wrong.
- The bug is entirely silent — no thrown error, no extra log line beyond the correct diagnostic one (`logDiag('jira.load', 'warn', ...)`), just wrong data quietly flowing into a user-facing list.

## What Didn't Work

There was no user-reported reproduction and no rejected alternative fix tried first — this is a single found-and-fixed defect, not an iterated one. It was caught by `/code-review` reading the code path directly during review of the "load ticket entry-point parity" work (PR #48), specifically by noticing that `downloadErrors` was declared as a `string[]` and then had structured per-attachment data (filename, content URL, size, mimeType) recovered back out of it via string-splitting.

## Solution

**Before** (the version PR #48 shipped before the code-review fix, per `git show 0ed17b8~1:src/participant/jira/loadHandler.ts`):

```ts
const downloadErrors: string[] = [];
// ... inside the catch block for a failed download:
downloadErrors.push(`${att.filename}: ${message}`);
// ... later, building the "skipped" list shown to the user:
...downloadErrors.map(e => {
  const filename = e.split(':')[0];
  const att = toDownload.find(a => a.filename === filename);
  return { filename, content: att?.content ?? '', size: att?.size ?? 0, mimeType: att?.mimeType ?? 'unknown', reason: 'download failed' };
}),
```

**After** (current tree, `src/participant/jira/loadHandler.ts`):

- Declaration, now a `JiraAttachment[]` instead of a `string[]` — line 112:

```ts
const downloadFailures: JiraAttachment[] = [];
```

- Inside the download catch block — lines 119–124, the real `att` object is pushed directly, and the formatted log line is kept purely as a diagnostics side-effect, no longer doubling as the only record of which attachment failed:

```ts
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.load', 'warn', `Attachment download failed — ${att.filename}`, { fileName: att.filename, error: message });
        downloadFailures.push(att);
        skippedUrls.set(att.filename, att.content);
      }
```

- Building the skipped list — lines 192–194, mapped straight from the real objects, no parsing or lookup required:

```ts
    ...downloadFailures.map(a => ({
      filename: a.filename, content: a.content, size: a.size, mimeType: a.mimeType, reason: 'download failed',
    })),
```

**Test coverage:** `src/test/loadTicketCore.test.ts:154` — "keeps the exact filename in the skipped list for a download failure, even when the filename contains a colon (code-review fix)" — simulates a failed download of an attachment named `log:2024-01-15.txt` and asserts the resulting skipped-list entry carries `filename: 'log:2024-01-15.txt'` (untruncated), `reason: 'download failed'`, `size: 50`, `mimeType: 'text/plain'` — the real values, not the `''`/`0`/`'unknown'` fallbacks the old code would have produced. `npm test` and `npm run compile` both green.

Shipped as part of PR #48 (`rbreunung/ticket-sidekick`), merged into `main`, in commit `0ed17b8` ("fix(jira): resolve code-review findings for the load-ticket-parity work").

## Why This Works

A string formatted for human/log consumption (`"${filename}: ${message}"`) is lossy and ambiguous to round-trip back into structured data, because the format's own separator character can also legally appear inside the data being formatted — a colon is a valid filename character and Jira's attachment upload doesn't reject it. `.split(':')[0]` implicitly assumed "the first colon in this string is always the format separator, never part of the data" — an assumption that happened to hold for most filenames but was never actually guaranteed, and nothing in the code enforced it.

Keeping the real `JiraAttachment` object (`att`) in scope and pushing that directly into `downloadFailures` sidesteps the round-trip entirely: there is no serialize step, so there is no lossy deserialize step either. The formatted log line still exists (`logDiag(...)`) and is still useful for a human reading the Output Channel, but it is now purely a side-effect for diagnostics, not a second, implicit source of truth that downstream code has to parse back apart.

## Prevention

- Never format structured data into a string for logging/display and then parse that same string back into structured data later in the same code path. Keep the original structured object in scope (a variable, array, or map) for as long as anything downstream needs its fields, and use the formatted string only for its actual purpose — a human-readable log line — never as a second, implicit source of truth.
- When choosing a separator character for a formatted string (here, `': '`), check whether that same character can legally appear inside the data being formatted. A colon is a legal filename character on common filesystems and isn't rejected by Jira's attachment upload, so `.split(':')[0]` was never actually safe — just usually correct.
- A round-trip through `string → parse → lookup-by-parsed-value` is a code smell in itself. If the lookup can fail (as `toDownload.find(...)` could here), silently falling through to `?? ''`/`?? 0`/`?? 'unknown'` fallbacks hides the failure instead of surfacing it — compounding one silent bug with another.
- Test coverage: `src/test/loadTicketCore.test.ts:154` exercises a colon-containing filename specifically to guard against this class of regression.

## Related Issues

- [`docs/solutions/logic-errors/concurrent-attachment-download-same-filename-race-silently-drops-one.md`](concurrent-attachment-download-same-filename-race-silently-drops-one.md) — a companion finding from the same code-review pass, same file (`loadHandler.ts`), same PR (#48) and fix commit (`0ed17b8`), but a genuinely different bug: that one is a concurrency race (two same-named attachments racing to write the same disk path), this one is a string-parsing/data-loss bug (recovering a filename by splitting a formatted log string on `:` instead of tracking the real object). Worth reading together as two independent findings the same review pass caught in the same downstream flow — not as two instances of one root cause.
