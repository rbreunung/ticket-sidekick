---
title: Duplicate Open Tickets in Report Import - Plan
type: feat
date: 2026-10-23
topic: duplicate-open-tickets-merge
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Duplicate Open Tickets in Report Import - Plan

## Goal Capsule

- **Objective:** The work for one Waltz or Veracode item lives in exactly one open Jira ticket. The Already ticketed screen shows a second ticket only when it is really open, and the user can resolve that duplicate from the same screen.
- **Product authority:** The requesting user (rbreunung); the choices in Key Decisions are theirs.
- **Open blockers:** None.

## Product Contract

### Summary

The Ticket cell on the Already ticketed screen stops counting closed tickets and names any other open ticket by key. Waltz keeps its existing ticket merge unchanged. Veracode gets the same `merge <sources> into <survivor>` reply with a lighter behavior: it closes the duplicate, linking and commenting on it, and folds in flaws the survivor lacks.

### Problem Frame

An Already ticketed row shows its target ticket plus `(+N more)`, where N counts every other ticket carrying one of the row's labels, closed ones included. A row like `PROJ-1234 (+1)` therefore looks like a live duplicate even when the extra ticket was closed long ago. When the extra ticket is genuinely open, only a number is shown, so the user cannot tell which ticket it is and has no way to close it from the review. Veracode imports have no ticket merge at all.

### Key Decisions

- **Closed means a resolution is set.** The importer already uses this test everywhere (target choice, stale check). Tickets moved to a Done-like status without a resolution still count as open. (session-settled: user-directed — chosen over also treating the Done status category as closed: keeps one definition of closed across the importer.) Governs R1, R2.
- **Waltz merge stays as it is.** It rewrites the survivor, adds a banner and a summary prefix to the closed ticket, and closes it. (session-settled: user-directed — chosen over making Waltz merge close-only: that merge also serves tickets covering different items.) Governs R4.
- **Veracode merge is lighter than Waltz merge.** The two importers behave differently on purpose. (session-settled: user-directed — chosen over copying the Waltz merge: Veracode duplicates are the same issue, so no banner or summary edit is wanted.) Governs R5, R6, R7.
- **Veracode merge folds flaws only when needed.** The survivor is rewritten from the report only when the closing ticket carries flaws it lacks, so all flaws end up on one ticket. (session-settled: user-directed — chosen over close-only with a warning or refusal.) Governs R8, R9.
- **The user picks the direction.** The cell and the hint never suggest which ticket survives. (session-settled: user-directed.) Governs R2.

### Requirements

**Ticket cell (Waltz and Veracode)**

- R1. The Ticket cell counts only other tickets that are still open; closed tickets never appear in it.
- R2. When another ticket is open, the cell names its key, e.g. `PROJ-1234 (also open: PROJ-1190)`, and on a screen where merge is available says the two can be merged, without suggesting a direction.
- R3. A row whose other tickets are all closed shows only its target ticket.

**Waltz**

- R4. `merge <sources> into <survivor>` behaves exactly as it does today.

**Veracode ticket merge**

- R5. The Already ticketed and overview screens accept `merge <sources> into <survivor>` with row ids or ticket keys, resolved and refused under the same rules as Waltz merge.
- R6. Merging closes each source using the existing per-issue-type choice of target status and resolution, adds a Jira duplicate link from the source to the survivor, and posts a short comment on the closed source naming the survivor. The source's summary and description are not edited.
- R7. When every flaw on the source is already on the survivor, nothing is rewritten.
- R8. When the source carries flaws the survivor lacks and the current report still lists them, the survivor is rewritten from the report first so it carries all of them, then the source is closed.
- R9. A flaw on the source that the report no longer lists is not folded; its id is named in the comment on the closed source.

**Unchanged behavior**

- R10. Closed tickets still feed change detection and the target-ticket choice, and their labels still keep their flaws or components known, so closing a duplicate never makes its items reappear as new.

### Key Flows

- F1. Resolve an open duplicate on Veracode
  - **Trigger:** An Already ticketed row shows `PROJ-1234 (also open: PROJ-1190)`.
  - **Steps:** The user replies `merge PROJ-1190 into PROJ-1234`; merge checks the flaws, folds in any missing ones, then links, comments and closes PROJ-1190.
  - **Outcome:** One open ticket remains; PROJ-1190 is closed with a link and a comment.
  - **Covered by:** R2, R5, R6, R7, R8, R9

### Acceptance Examples

- AE1. **Covers R1, R3.** Given a row whose only other ticket has a resolution, when the screen renders, then the cell shows the target ticket and no count.
- AE2. **Covers R2.** Given a row with a second open ticket PROJ-1190, when the screen renders, then the cell reads `PROJ-1234 (also open: PROJ-1190)`; on Waltz and Veracode it mentions merge and names no survivor.
- AE3. **Covers R6, R7.** Given a Veracode merge where the source's flaws are all on the survivor, when the user merges, then the source is closed, linked and commented, and the survivor is untouched.
- AE4. **Covers R8.** Given a source with a flaw the survivor lacks and the report lists it, when the user merges, then the survivor carries that flaw afterwards and the source is closed.
- AE5. **Covers R9.** Given a source flaw the report no longer lists, when the user merges, then the survivor does not gain it and the comment on the closed source names its id.

### Scope Boundaries

**Deferred for later**

- A plain per-row `close` action that skips link and merge.
- Treating the Done status category as closed when no resolution is set.
- Making Waltz merge close-only.

### Dependencies / Assumptions

- The user manual (`README.md` tables and the matching `docs/manual/` page) and `docs/report-import.md` must describe the new cell wording and Veracode merge, including that the two importers' merges differ.
- Veracode's existing row-rewrite already rebuilds a ticket from every report row pointing at it; R8 reuses that rather than adding a second rebuild path.

### Outstanding Questions

**Deferred to Planning**

- How to cap the `also open` list when a row has many open tickets.
- How the Veracode survivor rewrite interacts with its Due Date rules and with the rewrite's all-or-none rule per target ticket.
- Whether Veracode's merge reuses the Waltz merge's step runner and retry handling or needs its own.

### Sources / Research

- `src/participant/session/importScreens.ts` — `ticketedTicketCell` builds `(+N more)` from `ticketKeys`.
- `src/utils/reportImport.ts` — `buildReviewRows`, `pickTargetTicket`, the `resolved` flag.
- `src/participant/jira/importMerge.ts`, `src/utils/ticketMerge.ts` — current Waltz ticket merge; enabled by `ticketMerge` in `src/participant/jira/waltzHandler.ts`.
- `docs/report-import.md` — "Merging tickets (Waltz)" and the Veracode rewrite sections.
