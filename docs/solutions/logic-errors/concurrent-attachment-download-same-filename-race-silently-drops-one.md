---
title: Concurrent attachment downloads with a shared filename race to write the same path, silently dropping one attachment with no error or skipped-list entry
date: 2026-09-04
last_updated: 2026-11-26
category: logic-errors
module: "jira/load-ticket-attachment-download (src/tools/jiraTools/loadCore.ts, src/utils/attachmentEligibility.ts)"
problem_type: logic_error
component: assistant
symptoms:
  - "A ticket with two same-named attachments loads with only one file present in attachments/, and the second is nowhere to be found"
  - "The rendered ticket.md attachment list shows no indication a second attachment with that name ever existed or was skipped"
  - "No error is thrown, no warning is logged, and no entry appears in the skipped-attachments list"
  - "Which of the two attachments survives is non-deterministic: a filesystem last-write-wins race between two Promise.all-scheduled writes"
root_cause: concurrency
resolution_type: code_fix
severity: medium
related_components: [loadCore, attachmentEligibility, TicketService]
tags: [concurrency, race-condition, attachment-download, silent-data-loss, code-review-finding, filename-collision]
---

# Concurrent attachment downloads with a shared filename race to write the same path, silently dropping one attachment with no error or skipped-list entry

## Problem

Jira does not enforce attachment-filename uniqueness on an issue, so two attachments can share a filename (e.g. a log re-uploaded after a fix attempt). `loadTicketToWorkspace` downloads attachments concurrently in batches of three, writing each to `attachments/<filename>`, so two same-named attachments raced to write the same path and one was silently overwritten with no error, no log and no mention in the skipped list. The load now lives in `src/tools/jiraTools/loadCore.ts` (the `@jira` participant it was written for was removed on 2026-11-16).

## Symptoms

- Only one file is present in `attachments/`; the second same-named attachment is nowhere to be found.
- The `ticket.md` attachment list shows the surviving file as if it were the only one.
- No error, no log line, no skipped-list entry. The loss is only discoverable by checking the ticket in Jira.

## What Didn't Work

Nothing was tried and ruled out: a code review found the race by reading a `Promise.all(...map(... writeFile ...))` pattern directly, before a user hit it.

## Solution

Two fixes were needed together; the download-side fix alone would have stopped the data loss but still misreported what happened.

1. **De-duplicate before building the concurrent batch.** `dedupeByLatestFilename` in `src/utils/attachmentEligibility.ts` keeps, per filename, the attachment with the latest `created` timestamp and returns the rest as `duplicates`. `loadTicketToWorkspace` calls it on everything it is about to download, the eligible and the explicitly named attachments alike (`dedupeByLatestFilename([...eligible, ...named])`), so no two items in the batch can target the same path. The losers go to the skipped list (`skippedEntry(a, 'duplicate')`, reason `SKIP_REASONS.duplicate`).
2. **Key the `ticket.md` render check on `.id`.** The render loop still iterates the full attachment list, losers included, and a filename-keyed "downloaded" set cannot tell winner and loser apart because they share the filename. `const duplicateIds = new Set(duplicates.map(a => a.id));` is checked before the filename lookup, so the loser reads "skipped (duplicate filename)".

The reasoning for both is also stated beside the code: the docstring of `dedupeByLatestFilename` (the race and the latest-`created` rule) and the comment in `loadCore.ts` ("A losing duplicate shares its filename with the attachment that was written, so it is recognised by id before the filename lookup"). Tests: the `dedupeByLatestFilename (code-review fix: concurrent-download filename collision)` block in `src/test/attachmentEligibility.test.ts`, and "downloads only the most-recently-created attachment when two share a filename" in `src/test/loadTicketCore.test.ts`.

## Why This Works

The fix removes the race by construction instead of coordinating the writes: if no two items entering the concurrent batch share a destination path, there is nothing left to race over. Once a collection has been de-duplicated for one purpose, any other code that still iterates the original collection needs its own way to tell winner and loser apart, and only the stable identifier can, because the filename is exactly the value just proven ambiguous.

## Prevention

- Before processing items concurrently into paths derived from external-system data (not an internal unique id), check whether that data guarantees uniqueness. Jira attachment filenames explicitly do not.
- After de-duplicating a collection for one purpose, key every other pass over the original collection (a summary, a render, a count) on the stable identifier, never on the value that was just proven ambiguous.
- Treat silent data loss with no thrown error as the most dangerous class of concurrency bug: no stack trace, no log line, no failing test. During review, give any `Promise.all(...map(... writeFile ...))` pattern a dedicated look for path collisions.

## Related Issues

- [`attachment-filename-recovered-by-splitting-formatted-error-string-truncates-colons.md`](attachment-filename-recovered-by-splitting-formatted-error-string-truncates-colons.md): a companion finding from the same review of the same load flow, but a different bug (string-parsing data loss, not a race). Two independent findings, not one root cause.
- [`combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md`](combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md): another instance of a silent failure with no log line or user-visible signal, by a different mechanism (a fallback chain bottoming out in a fabricated default).
