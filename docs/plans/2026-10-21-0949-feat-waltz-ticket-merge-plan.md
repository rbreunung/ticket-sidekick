---
title: Waltz ticket merge - Plan
type: feat
date: 2026-10-21
topic: waltz-ticket-merge
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Waltz ticket merge - Plan

## Goal Capsule

- **Objective:** When a Waltz import shows several tickets for the same piece of work, the user combines them in one confirmed step, and a later scan of Jira shows which ticket took over the items.
- **Means:** A `merge <source…> into <survivor>` reply on the Waltz review, composed from the existing rewrite, link and close machinery.
- **Authority:** The Product Contract below wins on behavior. `docs/report-import.md` stays the developer reference and is updated with the code, and the user manual (README and `docs/manual/`) is updated for the new reply, the reload option and the changed ignore-list behavior.
- **Open blockers:** None. Deferred questions are listed under Outstanding Questions.
- **Execution profile:** Code. Run `npm run compile` and `npm test` before any commit.

---

## Product Contract

### Summary

On the Waltz review's overview and Already ticketed screens, the user replies `merge A5 A6 into A3` (or with ticket keys) to combine tickets. One confirmation shows the tickets and the plan. The survivor is rewritten once from the items of all tickets, and each other ticket is linked as Duplicate of it, marked as merged in its summary and description, and closed with resolution Duplicate. The review then refreshes itself, and the overview gets a reload option. The same refresh keeps the screens in step with the ignore list.

### Problem Frame

Two Waltz tickets for the same piece of work cannot be combined today. The user closes one by hand in Jira, links it, and edits both texts. The next import then has nothing that says which ticket took over the items, so a later scan cannot tell.

The open review also goes stale. Removing an entry from the ignore list leaves its items hidden until the next import, and a merge would leave the cancelled ticket listed as a target.

### Requirements

**The merge reply**

- R1. On the overview and the Already ticketed screen, `merge <source…> into <survivor>` combines tickets. Each side is an `A` id or a ticket key, several sources may name one survivor, and an `A` id stands for the ticket its row points to, so every row of that ticket is covered.
- R2. The reply is not offered on the New and Stale screens. There, `merge` with row numbers keeps combining New rows and `add … to <KEY>` is unchanged; the new form is answered with a pointer to the overview.
- R3. The bare command writes nothing. It shows each ticket's key, summary and status, the planned steps, any warning or fallback (R9, R10), and one link that confirms.
- R4. A reply naming the same ticket on both sides, or an id or key that cannot be resolved, is refused with nothing written.

**What the merge writes**

- R5. The survivor's summary, description and labels are rewritten once, as the existing rewrite does, from the report rows ticketed to the survivor and to every source. Labels are the union. A comment names the absorbed tickets, the findings added, and recorded findings the report no longer covers.
- R6. Each source gets a Duplicate link to the survivor, its summary prefixed `[Merged into <KEY>]`, and a description banner naming the survivor, with the original body kept below. Its marker labels stay.
- R7. Each source is then closed with resolution Duplicate.
- R8. Steps run in this order: survivor rewrite and comment, then for each source the link and rewrite, with each close last.

**Missing pieces and risky pairs**

- R9. A missing Duplicate link type falls back to a Relates link with a warning. A missing Duplicate resolution or workflow path falls back to the existing stepped close for that ticket. The confirmation names any fallback before the user clicks.
- R10. The confirmation warns about a resolved survivor, about a ticket not created by an import (listing the findings a rewrite would drop), and about an already-resolved source, which skips only the close. The user decides by clicking.
- R11. When a step fails, the merge stops and reports every ticket with its link, the failed step and the error, and offers retry or ignore. Ignore skips that step and continues, and the final report lists what is missing.

**Staying in step**

- R12. After a merge, the merged rows show a result in place, and the review refreshes itself when that loses none of the user's unfinished choices (New merges, exclusions, pending Already-ticketed picks). Otherwise the overview marks the screens out of date and offers the reload.
- R13. The overview offers **reload report**. It re-reads the same report file, re-runs the Jira searches, and rebuilds all screens. It warns that unfinished choices are lost and waits for a confirming link, and it asks for a file when the original is gone.
- R14. After `accept` or `unaccept`, the same refresh rule applies, so an item removed from the ignore list appears in New when it is still in the report and not ticketed.
- R15. A later import needs no stored merge record. The survivor carries the combined labels and is the open target, and the resolved source is never the target.

**Scope**

- R16. Waltz only. Veracode and email imports are unchanged.

### Key Decisions

- The user names the survivor with `into`. (session-settled: user-directed — chosen over a proposed default and over always keeping the newest: the target after `into` survives, with no guessing.) Governs R1.
- The cancelled ticket is rewritten with a prefix and banner and keeps its body. (session-settled: user-directed — chosen over replacing the body and over link and comment only: the original detail stays and a scan shows where it went.) Governs R6.
- The shape is a ticket-level reply. (session-settled: user-directed — chosen over a per-row action in the Action column and over stored merge records: it extends the existing rewrite and close machinery with the least new surface.) Governs R1, R15.
- The screens are the overview and Already ticketed only. (session-settled: user-directed — chosen over also offering it on Stale and on New: a stale ticket has no items to hand over, and New rows join a ticket through `add … to <KEY>`.) Governs R2.
- A failed step stops with retry or ignore. (session-settled: user-directed — chosen over a silent retry and over rollback: Jira writes cannot be undone cleanly.) Governs R11.
- Ignore skips the failed step and continues with the rest. (session-settled: user-directed — chosen over abandoning the merge and over skipping only the close.) Governs R11.
- Missing Jira pieces fall back and say so. (session-settled: user-approved — proposed with refusal as the alternative: projects differ in link types and resolutions.) Governs R9.
- Risky pairs warn and the user decides. (session-settled: user-approved — proposed with blocking as the alternative.) Governs R10.
- Many tickets merge into one survivor in one reply. (session-settled: user-approved — proposed over one pair per reply: related tickets often come in threes and the survivor is then rewritten once.) Governs R1, R5.
- Merge state lives only in Jira. (session-settled: user-approved — proposed over a table note and over a stored file: the survivor's labels already steer later imports.) Governs R15.
- Reload re-reads the same file after a warning. (session-settled: user-approved — proposed over a file picker each time and over re-applying choices: row ids shift, so choices could land on the wrong row.) Governs R13.
- The refresh is automatic when nothing is lost, and covers the ignore list too. (session-settled: user-approved — proposed over always asking for a reload and over a separate plan: the user expects results in step with the list.) Governs R12, R14.
- The reply keeps the verb `merge`. (session-settled: user-approved — proposed over `duplicate … of …` and `close … into …`: the form always has `into` plus an `A` id or key, so it cannot be mistaken for the row merge.) Governs R1, R2.

### Key Flows

- F1. Merge related tickets
  - **Trigger:** The user sees related tickets on the Already ticketed screen or the overview.
  - **Steps:** The user sends `merge A5 A6 into A3`. The review shows the tickets, the plan, and any warning or fallback. The user clicks the confirming link. The survivor is rewritten, each source is linked, rewritten and closed, and the review refreshes or marks itself out of date.
  - **Outcome:** One open ticket holds all items. Each other ticket is closed as Duplicate and says where its items went.
  - **Covered by:** R1, R3, R5, R6, R7, R8, R12

### Acceptance Examples

- AE1. **Covers R5, R6, R7.** Given tickets PROJ-12 and PROJ-15 for two components of one library family, when the user confirms `merge A5 into A3` where A3 is PROJ-12, then PROJ-12 lists both components, PROJ-15 is linked as Duplicate, titled `[Merged into PROJ-12] …`, and closed with resolution Duplicate.
- AE2. **Covers R11.** Given the link step fails for one source, when the merge stops, then the report lists every ticket with its link, names the failed step and error, and offers retry or ignore. After ignore, the remaining steps run and the final report says the link is missing.
- AE3. **Covers R9.** Given a project with no Duplicate resolution, when the user views the confirmation, then it states that the stepped close is used for that ticket, and the merge does not skip the close.
- AE4. **Covers R2.** Given the New screen, when the user sends `merge 2 4`, then rows 2 and 4 combine as today. When the user sends `merge PROJ-12 into PROJ-40` there, then no change is made and the reply points to the overview.
- AE5. **Covers R14.** Given an accepted component that is in the report and has no ticket, when the user sends `unaccept` for it and no choices are pending, then the component appears in New without a new import.
- AE6. **Covers R12, R13.** Given the user has excluded New rows and then merges two tickets, when the merge ends, then the overview marks the screens out of date, and the reload link warns that the exclusions are lost before it runs.

### Scope Boundaries

**Deferred for later**

- Merging stale tickets, and merging directly from the New screen by key.
- A stored record of merged pairs, and a note on Already-ticketed rows saying a ticket absorbed others.
- Re-applying the user's row choices after a reload.
- Merge for the Veracode and email imports.

### Dependencies / Assumptions

- The Jira project allows a Duplicate link and a Duplicate resolution, or the fallbacks in R9 apply.
- The review keeps enough of the loaded report to rebuild the screens without re-reading the file for a refresh (R12, R14). Planning checks this against the session state.
- The cancelled ticket's marker labels stay, so a resolved ticket still maps to its findings.

### Outstanding Questions

**Deferred to Planning**

- The cap on sources per reply, and whether it reuses the per-reply batch limit.
- How "not created by an import" is detected for the R10 warning.
- Whether the cancel step can pick the workflow path to a final status without asking in common projects.
- Whether a retry reruns only the failed step or repeats earlier steps idempotently.

### Sources / Research

- `docs/report-import.md` — "Finding folding" (`add … to <KEY>`, `rewrite` on Already ticketed), "Already-ticketed rows: per-row actions", "Stale-ticket detection and inline close", and "Accepted CVEs and components (Waltz)".
- `docs/plans/2026-10-05-1912-feat-report-import-finding-folding-plan.md`, `docs/plans/2026-10-20-1847-feat-waltz-accepted-components-plan.md`, `docs/plans/2026-10-21-0814-feat-ticketed-screen-paging-plan.md` — adjacent plans.
- `src/participant/jira/importAccept.ts` — `unacceptEntry` leaves hidden rows hidden until the next import; this is the gap R14 closes.
- `src/services/TicketService.ts` — `rewriteTicket`, `linkIssues` (Relates only today) and `transitionAlongPath` (accepts a resolution).
