---
title: Concurrent attachment downloads with a shared filename race to write the same path, silently dropping one attachment with no error or skipped-list entry
date: 2026-09-04
category: logic-errors
module: jira/load-ticket-attachment-download
problem_type: logic_error
component: assistant
symptoms:
  - "A ticket with two same-named attachments loads with only one file present in attachments/, and the second is nowhere to be found"
  - "The rendered ticket.md attachment list shows no indication a second attachment with that name ever existed or was skipped — it lists the surviving file as if it were the only one"
  - "No error is thrown, no warning is logged via logDiag, and no entry appears in the Skipped attachments summary shown to the user"
  - "Which of the two attachments survives is non-deterministic — a filesystem last-write-wins race between two Promise.all-scheduled writes, not a deliberate choice"
  - "Caught only by a post-implementation ce-code-review pass on the finished diff (part of the load-ticket entry-point parity work, PR #48), not by planning-phase review or by the implementer"
root_cause: concurrency
resolution_type: code_fix
severity: medium
related_components: [loadHandler, attachmentEligibility, TicketService]
tags: [concurrency, race-condition, attachment-download, silent-data-loss, vscode-fs, load-ticket-parity, code-review-finding, filename-collision]
---

# Concurrent attachment downloads with a shared filename race to write the same path, silently dropping one attachment with no error or skipped-list entry

## Problem

Jira does not enforce attachment-filename uniqueness on an issue, so two attachments can legitimately share a filename (e.g. a log re-uploaded after a fix attempt). `loadTicketToWorkspace` (`src/participant/jira/loadHandler.ts`) downloaded its eligible attachments concurrently in batches of 3, writing each to `attachments/<filename>` — so two same-named attachments raced to write the identical destination path, and one was silently overwritten with no error, no log, and no mention in the skipped-attachments list.

## Symptoms

- A ticket with two same-named attachments loads with only one file present in `attachments/`, and the second is nowhere to be found.
- The rendered `ticket.md` attachment list shows no indication that a second attachment with that name ever existed or was skipped — it lists the surviving file as if it were the only one.
- No error is thrown, no warning is logged via `logDiag`, and no entry appears in the "Skipped attachments" summary shown to the user.
- Which of the two attachments survives is non-deterministic — a filesystem last-write-wins race between two `Promise.all`-scheduled writes, not a deliberate choice.
- The loss is only discoverable by cross-checking the ticket in Jira itself and noticing it actually has two attachments with that filename.

## What Didn't Work

There was no user-reported failure or reproduction attempt here — no dead-end investigation to report. The bug was caught by `/code-review` reading the concurrent-download code path directly (as part of reviewing the "load ticket entry-point parity" work, PR #48) and recognizing the write-race before it could manifest for a real user. This is worth naming explicitly because it means the usual "what we tried and ruled out" narrative doesn't apply — the finding came from static analysis of a `Promise.all(...map(...writeFile...))` pattern, not from chasing a symptom.

## Solution

Two fixes were needed together — the download-side fix alone would have stopped the data loss but still misreported what happened to the user.

**1. De-duplicate before building the concurrent download batch.** A new pure helper, `dedupeByLatestFilename` (`src/utils/attachmentEligibility.ts:65-82`), groups attachments by filename and, for any group with more than one member, keeps only the attachment with the latest `created` timestamp as the winner — the same tie-break rule the sibling function `findAttachmentByFilename` (`attachmentEligibility.ts:41-56`) already used for the single-file `jira_downloadAttachment` tool, mirroring how the Jira web UI itself resolves a same-named attachment:

```ts
// src/utils/attachmentEligibility.ts:65-82
export function dedupeByLatestFilename(
  attachments: JiraAttachment[],
): { unique: JiraAttachment[]; duplicates: JiraAttachment[] } {
  const byFilename = new Map<string, JiraAttachment[]>();
  for (const att of attachments) {
    const group = byFilename.get(att.filename);
    if (group) group.push(att); else byFilename.set(att.filename, [att]);
  }
  const unique: JiraAttachment[] = [];
  const duplicates: JiraAttachment[] = [];
  for (const group of byFilename.values()) {
    if (group.length === 1) { unique.push(group[0]); continue; }
    const winner = group.reduce((latest, current) => (current.created > latest.created ? current : latest));
    unique.push(winner);
    duplicates.push(...group.filter(a => a !== winner));
  }
  return { unique, duplicates };
}
```

`loadTicketToWorkspace` calls it right after classifying eligibility and before the concurrent batch is built (`src/participant/jira/loadHandler.ts:98-102`):

```ts
// src/participant/jira/loadHandler.ts:98-102
const { toDownload: classified, toSkip } = classifyAttachmentEligibility(attachments);
const { unique: toDownload, duplicates } = dedupeByLatestFilename(classified);
```

Only `unique` winners ever enter the `Promise.all` loop at `loadHandler.ts:113-126`, so by construction no two items in that loop can ever target the same `attachments/<filename>` path. The `duplicates` are folded into the same skipped-attachments reporting path used for oversized/unknown-binary files (`loadHandler.ts:183-195`), with an actionable reason string:

```ts
// src/participant/jira/loadHandler.ts:188-191
...duplicates.map(a => ({
  filename: a.filename, content: a.content, size: a.size, mimeType: a.mimeType,
  reason: 'duplicate filename — use jira_downloadAttachment to fetch it by name',
})),
```

**2. Fix the `ticket.md` render loop's own filename-keyed check.** Even with the race eliminated, the attachment-list render loop (inside the `if (attachments.length > 0)` block at `loadHandler.ts:140`, with the check itself at `loadHandler.ts:144-151`) iterates the *original, full* `attachments` array — including the losing duplicates — and originally decided "downloaded" status via `downloaded.has(att.filename)`, a `Set<string>` of filenames. Since the winner and loser share the identical filename string, that check can't tell them apart: both the winner and the loser attachment objects would read as "downloaded" from the same `attachments/<filename>` path in the rendered summary. This was fixed with an ID-keyed set, checked before the filename check:

```ts
// src/participant/jira/loadHandler.ts:144-151
const duplicateIds = new Set(duplicates.map(a => a.id));
const attLines = attachments.map(att => {
  const size = formatFileSize(att.size);
  if (duplicateIds.has(att.id)) return `- \`${att.filename}\` — ${size} — skipped (duplicate filename)`;
  if (downloaded.has(att.filename)) return `- \`attachments/${att.filename}\` — ${size} (${att.mimeType})`;
  if (att.size > ATTACHMENT_SIZE_LIMIT) return `- \`${att.filename}\` — ${size} — skipped (over 100 MB size limit)`;
  return `- \`${att.filename}\` — ${size} — skipped (binary non-image)`;
});
```

Because `.id` is unique per attachment while `.filename` is exactly the value just proven ambiguous, this check correctly labels the loser "skipped (duplicate filename)" while the winner still reports as downloaded.

## Why This Works

This is a classic race condition — two independent async operations, no coordination, both targeting the same mutable resource (a filesystem path). The chosen fix eliminates the race by construction rather than adding locking or coordination around the write: if no two items ever entering the concurrent batch share a destination path, there is nothing left to race over. Doing the de-duplication as a pre-filter (before the batch is built) also keeps the concurrency logic itself unchanged and reuses the exact tie-break convention (`findAttachmentByFilename`'s "latest `created` wins") already established elsewhere in the same file, rather than introducing a second, different disambiguation rule.

The render-loop fix addresses a separate but related trap: once a collection has been de-duplicated for one purpose (deciding what to download), any other code that still iterates the *original, non-deduplicated* collection (here, the ticket.md summary pass) needs its own way to tell winner and loser apart. A `Set` of filenames can't do this, because filename is exactly the dimension that was just proven non-unique for this group. Only the stable per-object identifier (`.id`) can distinguish them.

**Test coverage:**
- `src/test/attachmentEligibility.test.ts`, describe block `dedupeByLatestFilename (code-review fix: concurrent-download filename collision)` — covers a no-duplicates set passing through unchanged, latest-created-wins with the loser reported as a duplicate, and a three-way duplicate group correctly keeping only the single latest.
- `src/test/loadTicketCore.test.ts:150` — asserts `loadTicketToWorkspace` writes exactly one file to disk for a same-named pair, that it holds the newer attachment's content, and that the skipped list carries the exact reason string `'duplicate filename — use jira_downloadAttachment to fetch it by name'`.

`npm test` and `npm run compile` are both green with these changes. Shipped as part of PR #48 ("load ticket entry-point parity") on `rbreunung/ticket-sidekick`, merged into `main` — the specific fix commit within that PR is `0ed17b8` ("fix(jira): resolve code-review findings for the load-ticket-parity work").

## Prevention

- Whenever a set of items is about to be processed concurrently and written to filenames/paths derived from external-system data (not from an internal unique ID), check upfront whether that data guarantees uniqueness. Jira attachments are a concrete case where it explicitly does not — don't assume a display name or filename is a safe path key just because it usually looks unique.
- When de-duplicating a collection for one purpose (e.g. "which item wins the download"), remember that any other code path that still iterates the *original*, non-deduplicated collection (a summary, a render pass, a count) needs its own way to recognize duplicates — key that check on the *stable identifier* (`.id`), never on the *disambiguating value that was just proven ambiguous* (`.filename`).
- Treat silent data loss with no thrown error as the most dangerous class of concurrency bug: it leaves no stack trace, no log line, and no failing test to point at it. This one was only caught by direct code review of a concurrent-write path, not by a reproduction — which argues for treating any `Promise.all(...map(... writeFile ...))` pattern as worth a dedicated look for path-collision potential during review.
- When a "latest wins" or similar tie-break convention already exists elsewhere in the codebase for the same kind of ambiguity (here, `findAttachmentByFilename`'s latest-`created`-wins rule), reuse it rather than inventing a second rule — consistency makes the resolved outcome predictable to users across different entry points (`@jira load` vs. `jira_downloadAttachment`).

## Related Issues

[`docs/solutions/logic-errors/attachment-filename-recovered-by-splitting-formatted-error-string-truncates-colons.md`](attachment-filename-recovered-by-splitting-formatted-error-string-truncates-colons.md) — a companion finding from the same code-review pass, same file (`loadHandler.ts`), same PR (#48) and fix commit (`0ed17b8`), but a genuinely different bug: this one is a concurrency race (two same-named attachments racing to write the same disk path), that one is a string-parsing/data-loss bug (recovering a filename by splitting a formatted log string on `:` instead of tracking the real object). Worth reading together as two independent findings the same review pass caught in the same downstream flow — not as two instances of one root cause.

[`docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md`](combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md) is worth a passing mention as another instance of this codebase's recurring "silent failure with no log line or user-visible signal" shape — a different mechanism (a fallback chain bottoming out in a fabricated default, not a concurrency race), but the same underlying lesson that silent failure paths are easy to miss without deliberate review.
