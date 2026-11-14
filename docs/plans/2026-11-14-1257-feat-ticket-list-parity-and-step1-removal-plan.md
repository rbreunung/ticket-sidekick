---
title: "Ticket List Parity and Step 1 Removal - Plan"
type: feat
date: 2026-11-14
topic: ticket-list-parity-and-step1-removal
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Ticket List Parity and Step 1 Removal - Plan

## Goal Capsule

- **Objective:** A developer does every Jira task except the report imports, cleanup and bulk changes included, from a Copilot chat and the boards; `@jira` is left with the imports only, and Step 1 of the migration is done on the preview channel.
- **Means:** The ticket list board gains a cleanup mode and the remaining list-flow features; the same PR removes every `@jira` flow the boards plan's Replacement Map lists for Step 1. Closes O1, O2 and O5 of [`docs/architecture/migration-status.md`](../architecture/migration-status.md) and writes Step 1's part of O6.
- **Product authority:** The maintainer's decisions below. They amend R7 to R9, R33 and R35 and AE9 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md). Steps 2 and 3 (imports, Bitbucket) are not active scope.
- **Open blockers:** None.

---

## Product Contract

### Summary

The ticket list board learns cleanup by `cleanupRules`, configurable columns, narrowing at open, paging, list-value add and remove, and an out-of-date state. In the same PR every Step 1 `@jira` flow is removed, the Jira walkthrough is rewritten, and the docs and the Step 1 manual checklist are brought in line. The migration releases only on the preview channel until it is complete.

### Problem Frame

The single-ticket Jira work already has tools and skills, but the list flows (search, filters, bulk transition, bulk field update, cleanup) still exist fully only in `@jira`. The maintainer still switches to `@jira` for daily cleanup, and every replaced flow left in `@jira` is code that still needs fixes and has to stay in sync with its replacement. KL25 records the board's gaps. Two of them, reading more than 300 tickets and a side-by-side conflict view, turned out not to be `@jira` features: `@jira` reads 50 tickets for search and cleanup, and it never notices a ticket that changed.

### Key Decisions

- **Subtasks follow their parent; only parents are selectable.** (session-settled: user-directed — chosen over a selection that cascades both ways as `@jira` does, and over flat rows: simpler, and a parent never closes over a skipped child.) Governs R3, R4.
- **Both column settings stay.** (session-settled: user-approved — chosen over merging them into one setting and over a column picker: existing settings keep working.) Governs R10.
- **A board opened with a proposed transition counts as a cleanup.** (session-settled: user-approved — chosen over "only rule-loaded boards" and over merged columns: matches `@jira`'s ad-hoc bulk close today.) Governs R10, R8.
- **300 tickets, 50 per page.** (session-settled: user-directed — chosen over one 300-row table, over reading only 50, and over reading past 300: `@jira`'s 50 was a page and safety limit, not a read limit.) Governs R7.
- **Cleanup applies one page at a time.** (session-settled: user-directed — chosen over an approval flow across pages, which comes later as a known limitation.) Governs R8.
- **A changed board offers only Refresh.** (session-settled: user-directed — chosen over a "select again" control and over a side-by-side view.) Governs R13, R14.
- **Narrowing happens when the board opens.** (session-settled: user-approved — chosen over controls on the board and over an editable JQL box.) Governs R11.
- **A failed subtask skips its parent.** (session-settled: user-approved — chosen over trying the parent anyway as `@jira` does, and over stopping the whole Apply.) Governs R5.
- **The over-50 confirmation counts selected rows only.** (session-settled: user-directed — chosen over counting subtasks too, and over always confirming a cleanup.) Governs R9.
- **Every replaced `@jira` flow goes in this work, and a removed request gets one generic notice.** (session-settled: user-directed — chosen over removing only the list flows, and over per-command pointers or the general fallback.) Governs R15, R17.
- **One plan, one PR, board work first.** (session-settled: user-directed — chosen over two PRs or two plans.) Governs R24.
- **Preview-only releases until the whole migration is done and tested; stable stays frozen with no hotfix releases.** (session-settled: user-directed — chosen over a normal release per step and over a hotfix branch: colleagues are not interrupted, and work in the middle of a branch never has to stop for a release.) Governs R22, R23.

### Requirements

**Cleanup on the ticket list board**

- R1. The developer starts a cleanup by naming a `cleanupRules` rule in chat (`/ts-jira cleanup "rule" [in …]` or a plain request), or from a new Command Palette command that picks a rule from `.jira-templates.json`; either opens the ticket list board loaded from that rule.
- R2. A cleanup board selects tickets and target states with the same rule fields and prompt overrides as today's `@jira run cleanup` (see `docs/jira-flows.md` "Bulk cleanup").
- R3. With `closeSubtasks`, each parent row shows its open subtasks indented beneath it, each with its own target status and resolution from the rule.
- R4. Only parent rows are selectable; a parent's subtasks are applied exactly when the parent is selected.
- R5. Apply moves a parent's subtasks before the parent; when any of them fails, the parent is not attempted and its result names the failed subtask.
- R6. A missing resolution for a closed target state is chosen on the board before Apply is possible.

**Paging and Apply**

- R7. The board reads at most 300 tickets, shows them 50 per page, and keeps its "more tickets match, narrow the query" notice when more match.
- R8. On a cleanup board (rule-loaded, or opened with a proposed transition), Apply acts only on the selected rows of the page being viewed.
- R9. On any other board the selection holds across pages, and an Apply on more than 50 selected rows asks for a native confirmation that names the count.

**Columns, narrowing and field changes**

- R10. A search or filter board shows the `ticketSidekick.jira.searchFields` columns, and a cleanup board shows the `ticketSidekick.jira.cleanupFields` columns, with the column rules `@jira` uses today.
- R11. Opening a ticket list board accepts the same fix version, sprint, assignee and `myTeam` narrowing as `jira_find_tickets`, resolved the same way, and the board shows the resulting JQL.
- R12. A bulk field change on a list field can add or remove single values and keep the rest, as `jira_update_field` does.

**Out-of-date board**

- R13. When the background check finds that a listed ticket changed or left the query, the board says it is out of date and offers Refresh as its only action.
- R14. Refresh reloads the rows, keeps the selection of every ticket still in the list, and drops the tickets that no longer match.

**Removing `@jira` flows**

- R15. Every flow in the Replacement Map's Step 1 rows is removed from `@jira`, together with its slash commands, help entries, follow-up chips and disambiguation entries.
- R16. `@jira` keeps only the three report imports and their Command Palette commands.
- R17. Any `@jira` request that is not an import gets one fixed notice saying `@jira` now only imports reports and pointing to `/ts-jira` and Agent mode.

**Docs, onboarding and testing**

- R18. The Jira Getting-Started walkthrough teaches Agent mode, `/ts-jira` and the boards instead of `@jira`.
- R19. README, the user manual, `CLAUDE.md` and the domain docs describe the board features and no longer describe the removed flows as usable.
- R20. `docs/known-limitations.md` closes KL25 and adds an entry for cleanup applying one page at a time; the migration status page closes O1, O2 and O5 and drops "more than 300 tickets" and "side-by-side conflict" as gaps.
- R21. The written manual checklist gets its Step 1 part, run on the managed machine against the preview build of this work.
- R22. The release strategy is recorded where later migration work reads it (the migration status page and the boards plan's R35 and AE9): every migration release is a preview, stable stays on its current version with no hotfix release, each step adds and runs its checklist part on preview, and the one normal release at the end reruns the whole checklist.

**Delivery**

- R23. The work is released on the preview channel only.
- R24. One PR, with commits ordered as board work first, then the removals, then docs and walkthrough, and `npm test` green at every commit.

### Key Flows

- F1. Cleanup run
  - **Trigger:** The developer types `/ts-jira cleanup "Close released bugs"` or picks the rule from the Command Palette.
  - **Steps:** The board opens loaded from the rule, with parents and their subtasks; the developer chooses a resolution if the rule has none; deselects parents to leave; presses Apply for page 1; moves to page 2 and applies again.
  - **Outcome:** Each row shows its result; a parent whose subtask failed shows as skipped.
  - **Covered by:** R1 to R8, R10.
- F2. Bulk field change across pages
  - **Trigger:** The agent opens the board for a filter with a proposed "add label X" change.
  - **Steps:** The developer deselects some rows on pages 1 and 3 and presses Apply with 120 rows selected; a native confirmation names 120.
  - **Outcome:** The 120 tickets get the label added; their other labels stay.
  - **Covered by:** R7, R9, R10, R12.

### Acceptance Examples

- AE1. **Covers R4, R5.** Given parent PROJ-10 with subtasks PROJ-11 and PROJ-12 is selected, when PROJ-12 fails to move, then PROJ-11 is moved, PROJ-10 is not attempted, and PROJ-10's result names PROJ-12.
- AE2. **Covers R8.** Given a cleanup board with 120 tickets and all rows selected on pages 1 to 3, when the developer applies from page 2, then only page 2's selected rows change.
- AE3. **Covers R9.** Given a search board with 40 rows selected, when Apply is pressed, then no count confirmation appears; with 51 rows it does.
- AE4. **Covers R8, R10.** Given the agent opens a board for "close PROJ bugs in 3.2" with a proposed transition, then it shows the `cleanupFields` columns and applies per page.
- AE5. **Covers R13, R14.** Given PROJ-5 is selected and a colleague moves it to Done, when the background check runs, then the board shows it is out of date with only Refresh; after Refresh PROJ-5 is still selected if it still matches the query, and gone if it does not.
- AE6. **Covers R17.** Given this release, when a developer types `@jira move PROJ-1 Done`, then `@jira` answers with the fixed notice and changes nothing.
- AE7. **Covers R22, R23.** Given this work is released, when a colleague on the stable channel types `@jira search`, then it still works, because no normal release has shipped since the migration began.

### Scope Boundaries

- Reading more than 300 tickets on one board.
- A side-by-side view of a changed ticket, or a "select again" control.
- An approval flow that applies a cleanup across several pages at once (recorded as a known limitation by R20).
- Narrowing controls or an editable JQL box on the board.
- Removing the imports, `@jira` itself or anything of `@bitbucket` (Steps 2 and 3).
- Any stable-channel release, including hotfixes, before the whole migration is done.

### Dependencies / Assumptions

- `cleanupRules`, `ticketSidekick.jira.searchFields` and `ticketSidekick.jira.cleanupFields` keep their current format; no settings migration.
- Removing `@jira`'s single-ticket flows does not touch the shared services `@bitbucket`'s requirements pass uses (`TicketService`, `JiraApiClient`).
- `@jira`'s slash commands (`check`, `create`, `view`, `load`, `comment`, `field`, `move`, `search`, `security-report`) all belong to removed flows, so `@jira` keeps no slash command.

### Outstanding Questions

- Deferred to Planning: whether the subtask failure in R5 also counts a parent as skipped when a subtask has no workflow path to its target, as `@jira` warns today.
- Deferred to Planning: where on the board the resolution choice of R6 sits, and how it reads for a rule with different parent and subtask resolutions.

### Sources / Research

- `src/boards/ticketList/kind.ts` (`MAX_LIST_ROWS`, `reconcile`), `src/boards/ticketList/jiraDeps.ts`: the board as built.
- `src/participant/jira/cleanupHandler.ts` (50-ticket read and notice, subtask-before-parent loop): today's cleanup behaviour.
- `src/tools/jiraTools/findTickets.ts` (narrowing), `src/tools/jiraTools/updateField.ts` (`operation` add or remove): behaviour R11 and R12 reuse.
- `docs/jira-flows.md` "Bulk cleanup": rule fields, overrides and `cleanupFields` column rules.
- `skills/ts-jira/SKILL.md`: the command table that gains a `cleanup` row.
- `walkthroughs/jira/`: the pages R18 rewrites.
