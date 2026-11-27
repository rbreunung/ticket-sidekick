---
title: Cleanup Board Apply Flow - Plan
type: feat
date: 2026-11-27
topic: cleanup-board-apply-flow
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Cleanup Board Apply Flow - Plan

## Goal Capsule

- **Objective:** On the ticket list, the cleanup board and the import board, a person applies a change with one click and then either sees it written or is told plainly why a ticket was not and can refresh. Closing tickets is no longer blocked by "changed in Jira" refusals when nothing changed.
- **Means:** A tolerant and logged write check with a board-level off switch (ticket list and cleanup board), and removal of the plan dialog, the native confirmation and the conflicts banner.
- **Product authority:** The Product Contract below wins on behavior. `CLAUDE.md` wins on repo conventions (vscode-free modules, tests, docs in the same change).
- **Open blockers:** None.

---

## Product Contract

### Summary

The ticket list and cleanup board get one action line holding the change controls, one Apply button that names its action, Refresh, and a checkbox that turns off the per-ticket "changed in Jira" check. Apply writes at once on those two boards and on the import board, with no plan dialog and no native confirmation. The conflicts banner is removed from every board; a refusal because a ticket changed marks the view out of date and Refresh is the way forward. The Close button leaves the ticket list and cleanup board, and closing their tab discards the session.

### Problem Frame

On a Data Center Jira, a cleanup of 50 tickets refused every ticket with "changed in Jira since the board read it", including tickets nobody had touched, and repeated attempts gave the same result. The cause is not known. Retrying piled up conflict entries until the banner counted 100 for 50 tickets, and its Drop button only removed a line of text.

Around that failure the Apply flow adds friction. The board already shows the selected tickets and the change, yet Apply opens a plan dialog that lists them again, and a bulk or closing write then asks for a native VS Code confirmation. A Close button duplicates closing the tab. The import board has the same Preview, dialog and confirmation steps. The person using the board wants to select, click once and read the result.

### Key Decisions

- **The false refusals get diagnostics and a tolerant check, not a guess at the cause.** A refusal logs both timestamps, and equal instants never count as a change. Governs R1, R2.
- **The check can be switched off from the board.** This gives a way to keep closing tickets while the cause is open. The default stays on because, once the dialogs are gone, the check is the only guard against overwriting someone else's change. Governs R3, R4.
- **The off switch lives on the board and is remembered across boards and restarts.** The session is discarded when the tab closes (R15), so a per-session switch would reset on every reopen. Governs R4.
- **The board is the preview.** The Apply button names the action and count, so a plan dialog and a native confirmation add nothing. This reverses decision D11 (native confirmation for risky writes) on the three boards named in R6. Governs R6, R7, R16.
- **A refusal marks the view out of date instead of raising a conflict entry.** The ticket list's existing out-of-date state already offers Refresh and nothing else. Governs R10, R11.
- **The email model check keeps its preview and the review board keeps its confirmation.** The first asks for consent to send email text to a language model; the second guards a write to Bitbucket that others read. Governs R8, R9.

### Requirements

**Write check (ticket list and cleanup board)**

- R1. Before writing a ticket, the board compares the ticket's current `updated` time with the one it read as instants, so two spellings of the same moment are not a change.
- R2. When the check refuses a ticket, it writes the ticket key and both timestamps to the Ticket Sidekick output channel.
- R3. A checkbox on the board, "Check each ticket before writing", is on by default; when off, Apply writes without reading each ticket first.
- R4. The checkbox's state is stored by the extension outside the board session, shared by both boards, kept across restarts, and not offered in the Settings screen; its label or tooltip says that off means a change made by someone else is overwritten unnoticed.

**Apply flow (ticket list, cleanup board, import board)**

- R5. The import board's Already ticketed tab keeps its changed-in-Jira check, and the checkbox in R3 does not cover it.
- R6. On the ticket list, cleanup board and import board, Apply is one click: there is no Preview step, plan dialog or native confirmation, and the write starts at once with the progress and per-row results the boards show today.
- R7. The Apply button names the action and count, such as "Move 12 tickets to Done"; it reads "Apply" and is disabled when nothing is selected or no change is chosen, and it is disabled while a write runs or the view is out of date.
- R8. The email import's boilerplate cleanup keeps its preview and consent step for the model check.
- R9. The review board's flow, including the confirmation before Post, is unchanged.

**Refusals and out-of-date**

- R10. No board shows a conflicts banner or Drop buttons; the reason a ticket was not written stays in the Apply result message and on its row.
- R11. When a write is refused because a ticket changed in Jira, the ticket list, cleanup board and the import board's Already ticketed tab mark the view out of date, so only paging and Refresh stay active and the board says why.

**Layout and header (ticket list and cleanup board)**

- R12. One action line holds the change controls (the status or field inputs, or the resolution picker on a cleanup board), the Apply button, Refresh, the checkbox from R3, and the selected count at its right end.
- R13. The header has no Close button on these two boards; the other boards keep theirs.
- R14. Closing the tab of these two boards discards its session, so reopening the same list or rule starts with no selection or results.
- R15. A window close or restart still restores an open tab of these boards.

**Documentation**

- R16. Everything that describes the preview or native confirmation for these boards is updated in the same change: the architecture doc (decision D11, the threat table, the flow diagram), the boards manual page, `CONCEPTS.md` and the boards paragraph of `CLAUDE.md`.

### Key Flows

- F1. Close released bugs from a cleanup board
  - **Trigger:** The person opens a cleanup rule and selects tickets on the page in view.
  - **Steps:** The action line shows "Move 12 tickets to Done" with the resolution picker. The person clicks it. Rows show progress and then their results, and one message gives the written count and the tickets not written with reasons.
  - **Outcome:** Written tickets are done. A ticket refused for a change in Jira marks the view out of date and Refresh is the next step.
  - **Covered by:** R1, R6, R7, R10, R11, R12

### Acceptance Examples

- AE1. **Covers R1, R6.** Given 50 selected tickets whose current `updated` time is the same moment as the board read but spelled differently, when the person clicks Apply, all 50 are written.
- AE2. **Covers R2, R10, R11.** Given one selected ticket was really changed in Jira after the board read it, when the person clicks Apply, that ticket is refused and its key and both timestamps are logged, the other tickets are written, the view is marked out of date, and no conflicts banner appears.
- AE3. **Covers R3, R4.** Given the checkbox is off, when the person clicks Apply, tickets are written without a per-ticket read first; after a restart a reopened board still shows the checkbox off.
- AE4. **Covers R7.** Given 12 tickets are selected and the cleanup rule needs a resolution that is not chosen yet, the button is disabled; once chosen it reads "Move 12 tickets to Done".
- AE5. **Covers R13, R14.** Given a cleanup board with tickets selected, when the person closes its tab and opens the same rule again, no tickets are selected and no earlier results show.
- AE6. **Covers R5, R6.** Given a Veracode report on the import board, when the person clicks Apply on the New tab, tickets are created at once with no dialog, and Already ticketed still refuses a ticket that changed in Jira.

### Scope Boundaries

Deferred or excluded:

- Finding why the two Jira reads disagree on Data Center. This plan adds the diagnostics only.
- The check toggle on the import board's Already ticketed tab.
- Any change to the review board's flow, and to the email model check's preview and consent.
- A Close button change on the import, review, sessions or security report boards.
- Renaming Refresh to "Reload".
- Other cleanup board issues the person finds later; each gets its own pass.

### Dependencies / Assumptions

- The reversal of D11 is at the requester's direction; the decision table records the date and reason (R16).
- The board's own rows, counts and the Apply button's label are enough of a review on the import board; its duplicate check on New and the choices on each tab remain.
- With the check off, the board does not read a ticket after writing it, so it may see its own writes as changes and mark the view out of date after an Apply. This is accepted: Refresh is one click and a cleanup's written tickets leave the list anyway.

### Outstanding Questions

**Resolve Before Planning**

- None.

**Deferred to Planning**

- Why the search read and the single-ticket read return different `updated` values for every ticket on the reporter's Data Center Jira, or whether another cause applies. It needs the diagnostics from R2 and a real Jira.
- How to tell the person closing a tab from VS Code closing it on a window close or restart (R14, R15). If it cannot be told reliably, the session is kept on tab close, as before.
- Where the extension stores the checkbox state (R4).
- What the Apply button names on import tabs other than New, such as the stale close and a running merge (R7).

### Sources / Research

- Write check: `src/boards/ticketList/kind.ts` (`writeOne`, the `updated` comparison and the conflict it records), `src/boards/ticketList/jiraDeps.ts` (`search` and `readTicket`).
- Plan dialog, conflicts banner and header buttons: `board-pages/shared/board.js` (`showPlan`, `banners`, header bar), `board-pages/ticket-list/page.js`, `board-pages/import/page.js`.
- Native confirmation and conflict accumulation: `src/sessions/sessionManager.ts` (the risky-plan confirm, `conflicts` in Apply).
- The only other conflict producer: `src/boards/import/ticketedTab.ts`.
- Tab disposal: `src/boards/boardPanels.ts` (`onDidDispose`), `src/boards/registerBoards.ts` (panel serializer).
- Decisions D11 and D14, the threat table and the flow diagram: `docs/architecture/boards-and-sessions.md`; user manual: `docs/manual/boards.md`.
