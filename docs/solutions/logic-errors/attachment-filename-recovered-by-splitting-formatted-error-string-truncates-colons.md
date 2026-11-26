---
title: Recovering a filename by splitting a formatted error string on ':' truncates filenames that contain a colon
date: 2026-09-04
last_updated: 2026-11-26
category: logic-errors
module: "jira/load-ticket-attachment-download (src/tools/jiraTools/loadCore.ts)"
problem_type: logic_error
component: assistant
symptoms:
  - "An attachment whose filename contains a colon (e.g. \"log:2024-01-15.txt\") that fails to download shows up in the skipped-attachments list under a truncated, wrong filename (e.g. \"log\")"
  - "The skipped-list entry for that attachment carries placeholder values instead of real ones: content empty, size 0, mimeType 'unknown'"
  - "A retry of the failed download has nothing to work with: the entry's content URL is empty and the filename shown is wrong"
root_cause: logic_error
resolution_type: code_fix
severity: low
related_components: [loadCore]
tags: [string-parsing, error-handling, filename-handling, attachment-download, code-review-finding, unsafe-string-roundtrip]
---

# Recovering a filename by splitting a formatted error string on ':' truncates filenames that contain a colon

## Problem

`loadTicketToWorkspace` recovered which attachment had failed to download by re-parsing an already-formatted, human-readable log string (`"<filename>: <message>"`) instead of keeping the original attachment object around. Splitting that string on `:` to recover the filename silently truncated any filename that itself contained a colon, a legal filename character that Jira does not reject on upload. The load now lives in `src/tools/jiraTools/loadCore.ts` (the `@jira` participant it was written for was removed on 2026-11-16).

## Symptoms

- A failed attachment download whose filename contains a colon (e.g. `log:2024-01-15.txt`) shows up in the skipped list under a truncated, wrong filename (`log`) instead of its real name.
- Because the truncated filename doesn't match any real attachment (`toDownload.find(a => a.filename === filename)` finds nothing), the skipped-list entry silently falls back to `content: ''`, `size: 0`, `mimeType: 'unknown'`, none of which are the real attachment's data.
- The skipped entry's `content` URL is what lets a caller fetch the attachment again; with it empty and the filename wrong, there is nothing to retry with.
- The bug is entirely silent: no thrown error, no extra log line beyond the correct diagnostic one, just wrong data quietly flowing into a user-facing list.

## What Didn't Work

There was no user-reported reproduction and no rejected alternative fix tried first. It was caught by a code review reading the code path directly, by noticing that the failure list was declared as a `string[]` and then had structured per-attachment data (filename, content URL, size, mimeType) recovered back out of it via string-splitting.

## Solution

**Before:**

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

**After** (`loadTicketToWorkspace` in `src/tools/jiraTools/loadCore.ts`): the failure list holds the real objects (`const downloadFailures: JiraAttachment[] = [];`), the catch block pushes `att` itself and keeps the formatted text for the log line only, and the skipped list is mapped straight from those objects:

```ts
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onDiag?.('warn', `Attachment download failed — ${att.filename}`, { fileName: att.filename, error: message });
        downloadFailures.push(att);
        skippedUrls.set(att.filename, att.content);
      }
// ...
    ...downloadFailures.map(a => skippedEntry(a, 'download-failed')),
```

`skippedEntry` copies filename, content URL, size and MIME type from the object and takes the reason from `SKIP_REASONS`. The test "keeps the exact filename in the skipped list for a download failure, even when the filename contains a colon" in `src/test/loadTicketCore.test.ts` guards the case with `log:2024-01-15.txt`.

## Why This Works

A string formatted for human or log consumption (`"${filename}: ${message}"`) is lossy to round-trip back into structured data, because the format's own separator can also legally appear inside the data being formatted. `.split(':')[0]` assumed "the first colon is always the separator, never part of the data", which happened to hold for most filenames but was never guaranteed.

Keeping the real `JiraAttachment` in scope sidesteps the round-trip: there is no serialize step, so there is no lossy deserialize step either. The formatted log line still exists for a human reading the Output Channel, but it is no longer a second, implicit source of truth that downstream code parses apart.

## Prevention

- Never format structured data into a string for logging or display and then parse that same string back into structured data later in the same code path. Keep the original object in scope for as long as anything downstream needs its fields, and use the formatted string only as a log line.
- When choosing a separator for a formatted string, check whether that character can legally appear inside the data. A colon is a legal filename character and Jira's upload doesn't reject it.
- A round-trip through `string → parse → lookup-by-parsed-value` is a smell in itself. When the lookup can fail, silently falling through to `?? ''` / `?? 0` / `?? 'unknown'` hides the failure instead of surfacing it, compounding one silent bug with another.

## Related Issues

- [`concurrent-attachment-download-same-filename-race-silently-drops-one.md`](concurrent-attachment-download-same-filename-race-silently-drops-one.md): a companion finding from the same code review of the same load flow, but a different bug: a concurrency race (two same-named attachments racing to write the same path), where this one is a string-parsing data-loss bug. Two independent findings, not one root cause.
