---
title: The import board's parity list misses the functional import work done just before the rewrite
date: 2026-11-13
category: workflow-issues
module: architecture/migration-parity-import-board
problem_type: workflow_issue
component: development_workflow
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - Planning or building a board, tool or skill that replaces a deprecated @jira or @bitbucket flow
  - Writing or reviewing the open points in docs/architecture/migration-status.md or a requirement that says "same rules and results"
  - A technical rewrite starts right after a stretch of feature work on the surface it replaces
symptoms:
  - Open point O7 (import board) lists the review-screen actions but not search, reload report, the Due Date rules or the auto-finish of a drained import
  - The boards plan never mentions Due Dates, auto-finish or the out-of-date marking, although each changes what an import writes or shows
tags: [migration, parity, import-board, veracode, waltz, due-date, sla, auto-finish, technical-rewrite, report-import]
---

# The import board's parity list misses the functional import work done just before the rewrite

## Context

The work since PR #114 is a technical rewrite: Jira tools, skills and boards replace the `@jira` and `@bitbucket` chat participants (see `copilot-host-surface-answered-from-source-but-blocked-on-managed-machine.md` for the surface choice). The two weeks before it were functional work on the Veracode and Waltz imports, all inside the participant:

- **2026-10-23, Veracode SLA Due Dates:** an SLA day table (`ticketSidekick.veracode.slaDays`), first-found and due-date columns in the Findings table, the Due Date written on create, on a new ticket and on rewrite, open tickets without a Due Date flagged for a rewrite (backfill), due dates in the export, and Waltz giving its rewrite Due Date through the same hook.
- **2026-11-02/03, import review screens:** a compact page line, a Commands line and a help link backed by a command catalog (`src/participant/session/importCommands.ts`), help printed after a refused reply, `accept CVE`, one-line answers to `next`/`prev` at a page boundary, and **finishing a drained import without a `done` reply** (`isNewGroupDrained()` in `importScreens.ts`).

Earlier work in the same area added `search`/`show`, `reload report`, and screens marked out of date after `unaccept` or a ticket merge. All of it is described in `docs/report-import.md`.

The boards plan (`docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`) states parity as one requirement: R16 says every action of today's import review screens becomes a board control "with the same rules and results", followed by a list of actions. The working list a later session plans from, open point O7 in `docs/architecture/migration-status.md`, copies a shorter version of that list. On 2026-11-13:

| Behaviour from the functional work | Plan R16 | Status O7 |
| --- | --- | --- |
| `search` (and `show`) | named | missing |
| `reload report`, out-of-date screens after `unaccept`/merge | not named (`reload` appears only in other contexts) | missing |
| Veracode SLA Due Date on create/new ticket/rewrite, backfill flag, Waltz rewrite Due Date | not named ("Due Date" appears nowhere in the plan) | missing |
| Drained import finishes without `done` | not named | missing |
| Export with due-date columns | "export" named | "export" named |

Nothing in the tree checks this. The command guard tests (`importCommandsGuard.test.ts`, `jiraCommandsGuard.test.ts`) tie the chat reply parsers to their catalog, and both are deleted together with the participant.

## Guidance

1. **Build a parity list from the old surface's spec and code, not from memory of its actions.** For the imports, the sources are `docs/report-import.md`, the `ReportImportDescriptor` capabilities (`fold`, `changeTracking` with `dueDateBackfill`, `accepted`, `ticketMerge`, `overviewExport`, `rewriteDueDate`/`dueDateNote`) and the reply kinds in `IMPORT_COMMAND_ENTRIES`. Every capability and every behaviour that changes what is written to Jira gets its own line.
2. **Treat the most recent functional work as the most likely to be lost.** It is the least settled in anyone's memory and often not yet in the design summary. When a rewrite follows a feature stretch, go through `git log` for that stretch and check each feature against the parity list.
3. **Separate behaviour from chat presentation.** The Commands line, the help link and "help after a refused reply" exist because a chat reply has to be typed; a board shows controls instead and does not need them. Due Dates, auto-finish, refresh and out-of-date marking are behaviour and must carry over, or be dropped by a recorded decision.
4. **Keep the working list as detailed as the requirement.** "Same rules and results" in R16 does not help a session that plans from O7. If a rule matters, name it in the open point.
5. **Recommended check (not written yet):** a guard test, written like `userDocsSync.test.ts`, that fails when a `ReportImportDescriptor` capability or an `IMPORT_COMMAND_ENTRIES` reply kind is named neither in O7/O8 nor in a "dropped on the board" list. It was not added in this run because it would fail on today's tree until the plan and the status page are updated. Reply kinds alone would not catch the Due Date or auto-finish gaps, so the check needs the capability list too.

## Why This Matters

The import board is the step that lets `@jira` be removed (O11). If it ships from the O7 list, a Veracode import on the board could create tickets without the SLA Due Date, stop flagging tickets without one, and leave a drained import waiting. Nothing would fail, because the participant code and its tests are deleted in the same step. The Due Date is what the security report's `overdue` and `due-before-release` flags are computed from, so the loss would also show up later, as missing flags on the security report board.

## When to Apply

- Before planning or reviewing the import board (O7, O8), and again before removing the imports (O11).
- For the PR review board in step 3: run the same check on `docs/review-process.md` (modes, requirements pass, follow-ups, token usage, truncated Data Center diffs) before `@bitbucket` is removed.
- Whenever a requirement promises parity with "same rules and results".

## Examples

O7 as written on 2026-11-13:

```text
Import board: start screen, Veracode, Waltz and email kinds on the session model,
every review-screen action as a board control (create, merge and unmerge, accept and
unaccept, add to ticket, rewrite, stale close, ticket merge with its resumable run, export)
```

O7 with the functional rules named (a suggestion; the wording is for the plan's owner to decide):

```text
... export (with due-date columns), search and show, reload report and the out-of-date
marking after unaccept and merge; Veracode SLA Due Date on create, new ticket and rewrite
plus the backfill flag; Waltz rewrite Due Date; a drained import finishes without `done`.
Dropped on the board: Commands line, help link, help after a refused reply, paging words.
```

## Related

- `docs/report-import.md`: the behaviour that has to carry over
- `docs/architecture/migration-status.md`: O7, O8, O11
- `docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`: R16, R18, R33, R34
- `docs/solutions/workflow-issues/copilot-host-surface-answered-from-source-but-blocked-on-managed-machine.md`: the rewrite's surface choice
- `docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md`: the same pattern for docs, where content was assumed to be covered at its new place
