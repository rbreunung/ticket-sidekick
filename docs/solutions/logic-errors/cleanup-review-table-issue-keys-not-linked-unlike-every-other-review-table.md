---
title: Cleanup/transition review table rendered ticket keys as plain text instead of clickable Jira links, unlike every other review table
date: 2026-09-04
category: logic-errors
module: jira/cleanup-review-table
problem_type: logic_error
component: assistant
symptoms:
  - "Ticket keys in the @jira run cleanup / bulk-transition review table rendered as plain, non-clickable text, unlike every other review table in the extension (search results via TicketService.searchTickets(), the Veracode/Waltz/email batch-import review table, @jira view, and ticket-created confirmation messages) which already rendered a clickable Jira link via the shared formatKeyLink() helper when baseUrl was configured"
  - "A user reviewing a cleanup/bulk-transition batch had no quick way to open a listed parent or subtask ticket in Jira to double-check it before confirming the transition, unlike every other list-of-tickets screen in the extension"
  - "The gap existed at every call site feeding buildReviewTable() since baseUrl was never threaded through, so the fix required plumbing a new parameter across three call sites, not a one-line change inside the function"
  - "No test failure and no compile error — the table rendered correctly, just without links, so nothing flagged the inconsistency until it was noticed as a side-fix bundled into PR #49, shortly after PR #48 had merged"
root_cause: logic_error
resolution_type: code_fix
severity: low
related_components: [sessionState, cleanupHandler, JiraParticipant, TicketService]
tags: [consistency-gap, feature-parity, formatKeyLink, review-table, cleanup-flow, bulk-transition, clickable-links, missing-convention]
---

# Cleanup/transition review table rendered ticket keys as plain text instead of clickable Jira links, unlike every other review table

## Problem

The cleanup/bulk-transition batch review table (`buildReviewTable()` in `src/participant/sessionState.ts`, shown by `@jira run cleanup` and the ad-hoc "bulk transition from search results" flow) was the one review table in the extension that rendered ticket keys as plain text, while every other review table in the codebase — search results, the Veracode/Waltz/email batch-import review table, `@jira view`, and ticket-created confirmation messages — already ran keys through the shared `formatKeyLink()` helper to render a clickable Jira link when `baseUrl` was configured.

## Symptoms

- Ticket keys in the cleanup/bulk-transition review screen rendered as plain text (`PROJ-1`, `↳ PROJ-1a`) with no link, even when `baseUrl` was configured and every other list-of-tickets screen in the same extension linked its keys.
- The gap was only visible by comparison: no error, no crash, no failing test — the table rendered correctly, just with a plain string instead of a Markdown link.
- A user reviewing a cleanup batch (potentially dozens of tickets about to be transitioned) had no quick way to click through to a listed ticket in Jira to double-check it before confirming the batch — unlike search results, import review, or `@jira view`, where clicking the key was the expected way to sanity-check a row.
- Because both the parent-ticket row and the subtask row (`↳ ${s.key}`) built their `key` field directly from the raw string, the inconsistency applied to both row types, not just top-level tickets.

## What Didn't Work

There was no failed investigation here, but the actual discovery path is worth recording precisely, since it wasn't a static-analysis catch like some other bugs in this codebase — it came from a direct user hunch. While working an unrelated `ce-brainstorm` session for the batch email-import feature, the user interrupted with: *"on that way also check whether all those table views do link the issue keys properly - I believe in some of the preview screens, maybe in transition workflow, this was missing."* *(session history)* The agent ran a live grep-based audit across the codebase's review/preview tables (`cleanupHandler.ts`, `TicketService.ts`, `sessionState.ts`) and confirmed the suspicion: `buildReviewTable()` built its `key` column from the bare ticket key with no `formatKeyLink()` call and didn't even accept a `baseUrl` parameter — the one holdout among all the review/preview tables in the codebase. *(session history)* The fix was deliberately deferred and treated as a quick side-fix rather than folded into the in-progress brainstorm work — the agent noted "I'll fix the cleanup review table's missing issue-key links right after we finish this plan" and applied it about 15 minutes later as its own standalone commit, separate from the plan-doc commit. *(session history)* No investigation was ever needed into *why* this one table had originally been missed — only the current-state gap (no `baseUrl` parameter, no `formatKeyLink()` call) was diagnosed and fixed; there's no record of when or how the omission was introduced in the first place.

## Solution

Verified against the current tree (`src/participant/sessionState.ts`, `buildReviewTable()` now spans lines 119–169+, having grown a `fieldIds`/`fieldMeta`/`onUnknownField` extra-columns parameter set in the later, unrelated PR #50):

1. `buildReviewTable()` gained a `baseUrl?: string` parameter (now the second parameter, ahead of PR #50's later-added `onUnknownField?: (fieldId: string) => void` third parameter):

   ```ts
   // src/participant/sessionState.ts:119-123
   export function buildReviewTable(
     session: TransitionBatchSession,
     baseUrl?: string,
     onUnknownField?: (fieldId: string) => void,
   ): string {
   ```

2. The parent-row key construction (line 134) changed from `key: t.key` to:

   ```ts
   key: formatKeyLink(t.key, baseUrl),
   ```

3. The subtask-row key construction (line 144) changed from `` key: `↳ ${s.key}` `` to:

   ```ts
   key: `↳ ${formatKeyLink(s.key, baseUrl)}`,
   ```

4. `baseUrl` was threaded through all three call sites that build a `TransitionBatchSession` review screen, confirmed via `git show 739858a`:
   - `streamReviewScreen()` in `src/participant/jira/cleanupHandler.ts` gained a `baseUrl?: string` parameter and forwards it into `buildReviewTable(session, baseUrl)` (now `buildReviewTable(session, baseUrl, (fieldId) => ...)` post-PR #50, per current `cleanupHandler.ts:28`).
   - `handleRunCleanup()`'s own direct `buildReviewTable()` call in the same file was updated the same way (now at `cleanupHandler.ts:251`).
   - `src/participant/JiraParticipant.ts` needed its own direct edits at all three call sites of `streamReviewScreen()` (the resolution-selection resume path, the invalid-skip-input retry path, and the ad-hoc bulk-transition-from-search-results path) — each call added a trailing `config.baseUrl` argument, since `streamReviewScreen`'s new `baseUrl` parameter had to be supplied by every caller, not just declared.

   The historical "before" state (from `git show 739858a`), for contrast:

   ```diff
   -export function buildReviewTable(session: TransitionBatchSession): string {
   +export function buildReviewTable(session: TransitionBatchSession, baseUrl?: string): string {
   ...
   -      key: t.key,
   +      key: formatKeyLink(t.key, baseUrl),
   ...
   -        key: `↳ ${s.key}`,
   +        key: `↳ ${formatKeyLink(s.key, baseUrl)}`,
   ```

5. Two new tests were added to `src/test/cleanupHandler.test.ts`, inside the existing `describe('buildReviewTable', ...)` block:
   - `'renders keys as bare text when no baseUrl is given'` — asserts `buildReviewTable(session)` contains `| PROJ-1 |` and does not contain `](`.
   - `'renders parent and subtask keys as clickable links when baseUrl is given'` — asserts `buildReviewTable(session, 'https://jira.example.com')` contains `| [PROJ-1](https://jira.example.com/browse/PROJ-1) |` and `` ↳ [PROJ-1a](https://jira.example.com/browse/PROJ-1a) ``.

`npm test` and `npm run compile` were both green for this change. Landed as the first commit of PR #49 (`739858a`, "fix(jira): link issue keys in cleanup/transition review table") — a small, separate fix bundled alongside that PR's unrelated batch-email-import feature rather than shipped as its own PR; PR #49's own description calls it out explicitly as an included side-fix.

## Why This Works

`formatKeyLink()` is the established, single shared helper every other review table in the codebase already used for exactly this purpose — rendering a ticket key as a Markdown link to `<baseUrl>/browse/<KEY>` when `baseUrl` is configured, or plain text otherwise. As of this fix it's used across six files (`src/participant/JiraParticipant.ts`, `src/participant/sessionState.ts`, `src/services/TicketService.ts`, `src/participant/jira/reportImportHandler.ts`, `src/participant/jira/loadHandler.ts`, `src/participant/jira/templateGenerationHandler.ts`) — a well-established convention across search results, ticket-created confirmations, batch-import review, and `@jira view`. `buildReviewTable()` simply hadn't been wired up to call it, most likely because the cleanup/bulk-transition flow was developed somewhat independently of the search/import review-table work and never picked up the pattern. The fix isn't a new mechanism — it's applying an existing, already-proven helper to the one call site that had been missed, which is why it's a small, low-risk, three-file diff rather than a redesign.

## Prevention

- When building a new list/table UI element in a codebase that already has several similar list/table UI elements, audit the existing ones for shared conventions (a common formatting helper, a common footer line, a common column set) before writing new rendering logic from scratch. Grep for the helper function name (`formatKeyLink`) across the codebase to see everywhere it's already used — the same discipline [`docs/solutions/workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md`](../workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md) recommends for test-mocking conventions, applied here to a rendering convention instead.
- A feature-parity gap like this is easy to miss because nothing breaks — the table still renders correctly, just with plain text instead of a link, so there's no error, no failing test, no crash to catch it. It's the kind of gap best caught by deliberately comparing new UI against existing UI for the same category of screen (e.g. "does every review/list table in this extension link its ticket keys the same way?"), not by running the code and checking that it "works." In this case it took a user's own hunch during unrelated work to trigger the check — an audit specifically targeting "does this shared convention apply everywhere it should?" would have caught it without needing that.
- When a codebase has several structurally similar features (here: four other review-table call sites) that all converged on the same helper independently, that convergence is itself a signal worth checking new or recently-added similar features against — a quick `grep -rn "formatKeyLink" src/` before or shortly after building a new review table would have caught this at build time rather than as a follow-up fix.

## Related Issues

[`docs/solutions/workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md`](../workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md) — shares the same abstract lesson (an existing codebase convention wasn't checked/applied before building something new), but is otherwise unrelated in concrete subject: that one is a knowledge-track finding about test-mocking infrastructure, caught before shipping by `/simplify`'s reuse pass; this one is a bug-track finding about a UI-rendering helper, shipped to `main` and caught afterward by a user's own suspicion. Worth reading together as two instances of the same discipline ("grep for the existing convention first") applied to different kinds of shared conventions.
