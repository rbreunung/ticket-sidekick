---
title: "Import Board for Veracode and Waltz - Plan"
type: feat
date: 2026-11-14
topic: import-board-veracode-waltz-parity
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Import Board for Veracode and Waltz - Plan

## Goal Capsule

- **Objective:** A developer runs every Veracode and Waltz report import from a board in an editor tab, with today's rules and results, and an unfinished import survives a VS Code restart. `@jira` is left with the email import only.
- **Means:** A new import board kind on the existing session model, a session model that saves after each write, and removal of `@jira`'s Veracode and Waltz imports in the same preview. Closes the Veracode and Waltz part of O7 in [`docs/architecture/migration-status.md`](../architecture/migration-status.md).
- **Product authority:** The maintainer's decisions below. They narrow R14 and R16 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md) to the Veracode and Waltz kinds. The email kind, the model settings and the PR review board are not active scope.
- **Open blockers:** None.

---

## Product Contract

### Summary

An import board opens one session per Veracode or Waltz report and shows its groups as tabs (New, Already ticketed, Stale, and Accepted for Waltz), each with its own controls and its own Preview and Apply. A running ticket merge gets a tab of its own. Every Veracode and Waltz row the parity ledger marks "Carry over" works on the board. The same preview removes the two chat imports and their Command Palette commands.

### Problem Frame

Veracode and Waltz imports are the last Jira work that still needs the deprecated `@jira` participant. All of their rules (dedup, folding, accepted CVEs and components, rewrite with Due Dates, stale close, the two-mode ticket merge, export) sit in a chat flow driven by typed row ids and paged screens. As long as they stay there, `@jira` and its import code cannot be removed, and every import fix has to be made in a flow that is going away.

A typical run has about 5 New rows. It grows when Veracode stops matching existing tickets or changes its algorithms, to sizes like 10 New and 40 Already ticketed. The chat flow then means paging and typed row ids.

The session store is built for boards like the ticket list, whose writes are moves and field updates. Imports create tickets and run multi-step merges, and the store saves a session only once a whole Apply has finished.

### Key Decisions

- **This slice is the full Veracode and Waltz parity.** (session-settled: user-directed — chosen over a core-first slice, a session-model-only slice and the email kind first: one plan that finishes both report kinds.) Governs R13, R14.
- **The chat imports go in this slice.** (session-settled: user-approved — chosen over keeping them for one preview and over keeping them until email moves: one way to import, no double maintenance.) Governs R17.
- **Board and removal ship in one preview.** (session-settled: user-directed — chosen over removing in the preview that reaches full parity and over removing per kind: no in-between state with two ways to import.) Governs R18.
- **One tab per group.** (session-settled: user-directed — chosen over stacked collapsible sections and over an overview-plus-detail split, after rough sketches at 10 New and 40 Already ticketed.) Governs R7, R8, R9.
- **Already ticketed opens on the rows that need a decision.** (session-settled: user-approved — chosen over all rows with changed ones on top and over report order: most of 40 rows are unchanged and default to `leave`.) Governs R10.
- **A running ticket merge has its own tab.** (session-settled: user-approved — chosen over a panel inside Already ticketed and over an overlay that blocks the board.) Governs R11.
- **Refresh on an out-of-date tab keeps every choice whose rows still exist.** (session-settled: user-directed — chosen over today's rule, which drops the tab's unfinished choices on refresh.) Governs R12.
- **The session model saves after each write, for all boards.** (session-settled: user-approved — chosen over saving per write for the import board only and over relying on the dedup check after a restart.) Governs R1.
- **A format change discards the session, and a merge run again skips what Jira shows as done.** (session-settled: user-approved — chosen over migrating import sessions and over a warning before updates: no migration code, and the merge steps already recognise finished work.) Governs R2, R3.
- **The board-wide native confirmation rule stays as it is.** (session-settled: user-approved — chosen over confirming only closes and merges natively and over a ticket-count threshold.) Governs R15.
- **Done means scenario tests plus a PR checklist run on the pre-release build.** (session-settled: user-directed — chosen over requiring a separate real-restart check and a removal check as their own signals; the restart is a checklist item.) Governs R20, R21.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers the Veracode and Waltz kinds of the import board, Step 2 of the migration. The rest of Step 2 is the current understanding, not a committed roadmap:

- The email kind (O8): start screen entry, boilerplate cleanup with consent, add one email as a comment, and the search for tickets matching an email's subject.
  - Depends on this plan's board kind and start screen.
  - Depends on the open question of whether the extension can call a language model outside a chat participant on the managed machine.
- Model settings for the review passes and the email check, with a pick step (O9, O10). Shares the "prompts are board steps" rule with the email kind.
- Removal of the email import, the last import command, `@jira` itself and its help screen (O11). Depends on the email kind.
- The PR review board (Step 3). Can proceed independently of this plan. It also benefits from R1.

### Actors

- A1. The developer, who opens the board, makes the choices and approves each write.
- A2. The Copilot agent, which only opens the board and learns whether that worked (R5).
- A3. Jira Data Center or Cloud, which the board reads and writes.

### Requirements

**Session model (all boards)**

- R1. The session is saved after each single write during an Apply. A board restored after an interrupted Apply shows the finished targets as done, and a new Preview covers only the rest.
- R2. A stored session of another format is discarded, and the reopened board says the stored import was from an older version and was rebuilt from the report and Jira.
- R3. An unfinished ticket merge run is part of the session. After a restart its finished, failed and pending steps and its open question are back as they were (R19 of the boards plan).

**Opening an import**

- R4. An "Open import board" Command Palette command opens a start screen where the developer picks the kind (Veracode or Waltz) and the report file. The template and issue-type choice follow as board steps.
- R5. A workspace path typed in chat or a report file dragged into the chat opens the board already loaded through the open-board tool (R15 of the boards plan). The agent learns only whether the board opened (R17 of the boards plan).
- R6. Asking again for the same report file finds the same session.

**Review tabs**

- R7. The review shows one tab per group: New, Already ticketed, Stale, and Accepted for Waltz, each with its row count. One tab is visible at a time.
- R8. Each tab has its own controls and its own Preview and Apply, so writes of different groups never share a preview.
- R9. A Waltz session's Accepted tab lists the accepted CVEs and components, with `unaccept` and `unaccept component` controls.
- R10. Already ticketed opens filtered to changed rows and rows without a Due Date. Filters show Unchanged and All. "Set all shown to" changes only the rows in the current filter, and Apply acts on every row's choice, shown or not.
- R11. Starting a ticket merge opens a merge tab that shows each step with its status. The tab offers Retry, Ignore and Stop on a failed step and asks the target status per issue type and the resolution. While the run is unfinished, Apply on the other tabs is refused, and their other controls stay usable. The tab closes once the finished run has been acknowledged.
- R12. When `unaccept` or a finished ticket merge changes what another tab should show, a tab without unfinished choices refreshes at once. A tab with unfinished choices gets an out-of-date mark and offers only Refresh. Refresh keeps every choice whose rows still exist and names the choices it dropped.

**Parity with today's import**

- R13. Every Veracode and Waltz row the import board parity ledger in [`docs/architecture/migration-status.md`](../architecture/migration-status.md) marks "Carry over" works on the board, with the same rules and results as today's chat flow. Rows marked "Dropped" stay dropped. The email-only rows are out of scope.
- R14. A choice that names rows in chat today (merge and unmerge, add to ticket as comment or rewrite, accept, the row actions, merge tickets, marking stale tickets) is made by selecting rows on the board.
- R15. Every import write follows the board-wide confirmation rules: a preview and a second Apply click (R3 of the boards plan), and the native VS Code confirmation for a write that changes more than one ticket or closes one (R39 of the boards plan).
- R16. Search runs over the tickets the review matched without a Jira call, and export saves the overview as CSV or Excel with the due-date columns, built from the reading the board shows.

**Removal**

- R17. `@jira`'s Veracode and Waltz imports, the "Import Veracode report" and "Import Waltz report" commands, and the code only they use are removed. `@jira` keeps the email import, and its help, notice and the parity ledger are brought in line with that.
- R18. The board and the removal ship together in one preview release. No release has both ways to import Veracode or Waltz reports.
- R19. The README, the user manual pages, `docs/report-import.md`, the migration status page and `CLAUDE.md` describe the import board as the way to import Veracode and Waltz reports.

**Verification**

- R20. Every Veracode and Waltz "Carry over" row of the parity ledger has a board scenario test that checks the same result today's chat flow gives.
- R21. The PR carries a checklist of every use case, which the maintainer runs on the PR's pre-release build against Jira Data Center. It includes a real VS Code restart with a half-finished ticket merge and unapplied choices. The same items are added to [`docs/architecture/manual-checklist.md`](../architecture/manual-checklist.md).

### Key Flows

- F1. Review and create from a Veracode report
  - **Trigger:** The developer runs "Open import board", or drags a Veracode XML into the chat.
  - **Actors:** A1, A2, A3
  - **Steps:** Pick kind and file, then template and issue type. The board reads the report and searches Jira for already-ticketed findings. On New, select rows, merge two, and Preview create. Apply, then confirm in VS Code's dialog. Switch to Already ticketed, set its six changed rows, Preview and Apply.
  - **Outcome:** The tickets are created with their SLA Due Dates, the rewrites are written, and each tab shows its results.
  - **Covered by:** R4, R5, R7, R8, R10, R13, R14, R15
- F2. Ticket merge interrupted by a restart
  - **Trigger:** On Already ticketed, the developer merges SEC-90 and SEC-91 into SEC-88.
  - **Actors:** A1, A3
  - **Steps:** The merge tab opens and runs the steps. One step fails, and the developer closes VS Code. On reopen, the board and its merge tab come back with the failed step. Retry, then answer target status and resolution.
  - **Outcome:** The run finishes, the affected tabs refresh or get their out-of-date mark, and the merge tab closes after acknowledgement.
  - **Covered by:** R1, R3, R11, R12

### Acceptance Examples

- AE1. **Covers R1.** Given an Apply creating 7 tickets is interrupted after 4, when the board is restored, then those 4 rows show as created and a new Preview lists only the remaining 3.
- AE2. **Covers R12.** Given two New rows are merged but not created, when the developer unaccepts a CVE on the Accepted tab, then New gets the out-of-date mark. Refresh brings the CVE's component back onto New and keeps the merge, because both rows still exist.
- AE3. **Covers R12.** Given Already ticketed has no unfinished choices, when a ticket merge finishes, then Already ticketed refreshes without a click.
- AE4. **Covers R11.** Given a merge waits for a resolution, when the developer tries Apply on New, then it is refused with a note to finish or stop the merge first. Selecting rows on New still works.
- AE5. **Covers R10.** Given 6 changed and 34 unchanged rows, when the developer picks the Changed filter and sets all shown to `leave`, then only those 6 rows change and the 34 keep their own choice.
- AE6. **Covers R15.** Given one Stale ticket is marked, when the developer applies the close, then the native confirmation is asked, because the write closes a ticket.
- AE7. **Covers R2, R3.** Given an update changes the stored format while a merge is half done, when the board opens, then it says it was rebuilt. Starting the same merge again skips the comment, link and close steps Jira already shows as done.

### Scope Boundaries

- The email kind, its boilerplate cleanup and its consent step.
- The model settings, their pick step, and the check that the extension can call a model outside a chat participant.
- The PR review board and the Bitbucket tools.
- Approving several Applies at once, across tabs or pages.
- Migrating stored sessions to a new format.
- Any change to the import rules themselves: the board keeps them as they are (R13).

### Dependencies / Assumptions

- The import rules can be reused from today's importer code. The pure helpers (dedup, rewrite defaults, Due Dates, merge text, table readers) already live in `src/utils/`. The flow modules in `src/participant/jira/` import `vscode` and hold the chat wording.
- A merge run again after a discarded session gives the kept ticket the same text only while its `Merged into` banner is at the start of the description. A banner moved by an edit is added a second time. This is recorded as a known limitation, not fixed (`src/utils/ticketMerge.ts`).
- The organisation's Copilot policy keeps allowing extension tools (V4 of the migration status page). If it changes, the Command Palette command still opens the board.

### Outstanding Questions

**Deferred to Planning**

- How the importer's flow logic is split off from its chat wording so the board kind can call it without `vscode`.
- How the parity ledger test is reshaped once only email rows still point at the chat flow.
- Whether the start screen shows the email kind as "not on the board yet" or leaves it out until it moves.
- Whether reload report counts as an action that marks other tabs under R12.

### Sources / Research

- [`docs/architecture/migration-status.md`](../architecture/migration-status.md): the import board parity ledger (R13) and open points O7 to O11.
- [`docs/architecture/boards-and-sessions.md`](../architecture/boards-and-sessions.md): the board kind members, the security model and the "adding a board" checklist.
- [`docs/report-import.md`](../report-import.md): today's review screens, ticket merge, accepted list and Due Date rules.
- `src/sessions/sessionManager.ts`: the single save at the end of `apply` and the discard of another format (R1, R2).
- `src/participant/jira/importMerge.ts`: the "already commented", "already linked" and "already resolved" skips a rerun relies on (R3, AE7).
- `src/utils/reportImport.ts`: `deriveRewriteActions` and `alignRewriteDefaults`, behind R10's defaults.
- `src/boards/ticketList/kind.ts`: the out-of-date state and the risky-plan rules that R12 and R15 follow.
