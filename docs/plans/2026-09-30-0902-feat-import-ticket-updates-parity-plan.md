---
title: Import Ticket Updates Parity - Plan
type: feat
date: 2026-09-30
topic: import-ticket-updates-parity
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Import Ticket Updates Parity - Plan

## Goal Capsule

- **Objective:** A user re-importing a Veracode or Waltz report can bring already-ticketed items up to date with what changed, choosing per item whether the change goes onto the existing ticket or onto a new one, and both importers behave the same way while doing it.
- **Product authority:** This Product Contract. The overview-hub rule that nothing is created, updated, re-created or closed except by an action the user chose inside its group (`docs/plans/2026-09-23-1400-feat-report-import-overview-hub-plan.md`, R11) stays in force.
- **Open blockers:** None.

---

## Product Contract

### Summary

Both importers get one Already-ticketed screen where every row shows what changed since its ticket was made and a proposed action — update, follow-up, re-create or leave — which the user can change per row before replying `apply`.
Waltz learns to detect changes on components it already ticketed (new CVEs on the same version, a higher rating).
Veracode's bulk `update tickets` and `re-create tickets` become shortcuts into the same per-row model.

### Problem Frame

Re-importing a Waltz report today lists every previously ticketed component as "Already ticketed" and offers only a full re-create.
A component that gained CVEs or moved from High to Critical looks identical to one that did not change, so the existing ticket silently falls behind the report.

Veracode can already add new findings to existing tickets, but only for every changed row at once.
A user cannot say "this one goes on the existing ticket, that one needs its own ticket", which matters when the existing ticket is already in a sprint, owned by another team, or resolved.
The dedup search also matches resolved tickets, so the bulk update can add findings to a ticket nobody is looking at anymore.

Stale-ticket closing and the overview hub are already shared by both importers on `main` and are not part of this problem.

### Key Decisions

- **What counts as a Waltz change: new CVEs on the same component version, and a higher worst rating.** Governs R1. (session-settled: user-directed — chosen over also treating a newer version of the same library as the same ticket: a version bump keeps producing a new ticket plus a stale one.)
- **One per-row action model for both importers, replacing the bulk commands.** Governs R5–R10. (session-settled: user-directed — chosen over separate bulk commands per action and over a sub-menu per action: one screen, smart defaults, one `apply`.)
- **Both a follow-up (new findings only) and a full re-create are offered.** Governs R6, R14, R15. (session-settled: user-directed — chosen over offering only one of the two: not everything fits in one ticket, and a full fresh ticket is still sometimes wanted.)
- **A resolved ticket defaults to follow-up, but the user may still update it.** Governs R7. (session-settled: user-directed — chosen over blocking updates to resolved tickets and over no special case.)
- **Pre-existing Waltz tickets get a baseline recorded through `apply`, not automatically.** Governs R4, R13. (session-settled: user-directed — chosen over parsing old descriptions, over an automatic write during the dedup step, and over an in-memory-only comparison: keeps the no-write-without-action rule and avoids a flood of "new CVE" comments.)
- **Several tickets per item are read as one union; updates target the newest open one.** Governs R3, R11. (session-settled: user-directed — chosen over comparing against the newest ticket only and over one row per ticket.)
- **A rating rise rewrites the summary's rating suffix as well as commenting.** Governs R12. (session-settled: user-directed — chosen over comment only and over also changing Jira priority: the ticket list should show the current rating, and no rating-to-priority mapping exists.)
- **Follow-ups are joined to the original by a real Jira "relates to" link.** Governs R14. (session-settled: user-directed — chosen over a text mention only and over link plus text mention.)
- **`update tickets` and `re-create tickets` stay as shortcuts.** Governs R10. (session-settled: user-directed — chosen over removing them: existing habits keep working.)

### Requirements

**Change detection**

- R1. A Waltz already-ticketed component has a change when the report lists a CVE that none of the component's tickets record, or when its worst rating is higher than the highest rating any of its tickets record.
- R2. A Veracode already-ticketed row has a change when its folded group contains a flaw id that none of the group's tickets carry — today's rule, unchanged.
- R3. An item's known findings are the union across every ticket carrying its dedup key; a finding recorded on any of them is not new.
- R4. A Waltz ticket that records no CVEs or rating (created before this feature) shows its change as "baseline" rather than listing every CVE as new.

**Already-ticketed screen**

- R5. Veracode and Waltz show the same Already-ticketed screen: each row names its target ticket and that ticket's status, a one-line change summary (e.g. "+2 CVEs, High→Critical", "+1 flaw", "baseline", "—"), and its current action, alongside the importer's own item columns.
- R6. The row actions are `update`, `follow-up`, `re-create` and `leave`; `follow-up` is offered only on a row with new findings, and `update` only on a row with a change or a baseline.
- R7. Each row's proposed action is: no change → `leave`; change and the target ticket is open → `update`; change and every ticket for the item is resolved → `follow-up`; baseline → `update`.
- R8. The user changes a row with `<row id> <action>` (e.g. `A2 follow-up`) or every eligible row with `all <action>`; an action not offered on a row is rejected with a message and changes nothing.
- R9. Replying `apply` runs every row whose action is not `leave`, at most 50 (`BATCH_LIMIT`) rows per reply; rows beyond the cap stay pending and the reply says how many remain.
- R10. `update tickets` runs only the rows currently set to `update`, and `re-create tickets` only the rows currently set to `re-create`, under the same cap as R9.

**Actions**

- R11. `update` writes to the newest open ticket for the item: it records the new findings on the ticket and posts one comment listing them, and for Waltz the comment also names a rating rise.
- R12. On a Waltz rating rise, `update` also replaces the rating at the end of the ticket's summary; a summary that no longer ends in the previously imported rating is left untouched and the comment says so.
- R13. `update` on a baseline row records the component's current CVEs and rating on the ticket without posting a comment or changing the summary.
- R14. `follow-up` creates a new ticket with the batch's picked template and issue type, containing only the new findings, carrying the item's dedup record plus the new findings, and linked "relates to" the item's newest ticket; if the link fails, the ticket is kept and the user sees a warning that is also logged.
- R15. `re-create` creates a full ticket as today, and that ticket counts as one of the item's tickets on later imports.
- R16. After `apply`, each row reports its own result; one row failing does not stop the others, and the overview counts updates, follow-ups and re-creates separately.

**Documentation**

- R17. The user manual (`docs/manual/report-imports.md`) and `docs/report-import.md` describe the per-row actions, defaults, reply words, the baseline, and the Waltz change rules.

### Key Flows

- F1. Re-import with changes
  - **Trigger:** The user imports a Veracode or Waltz report whose items were ticketed before, and opens the Already-ticketed group from the overview.
  - **Steps:** The screen lists every already-ticketed row with its change and proposed action (R5, R7). The user overrides some rows (R8). The user replies `apply` (R9). Each row runs its action (R11–R15) and reports its result (R16). The overview returns with updated counts.
  - **Outcome:** Existing tickets reflect the report where the user chose `update`; separate linked tickets exist where the user chose `follow-up`; nothing else was written.
  - **Covered by:** R5–R16

### Acceptance Examples

- AE1. **Covers R7.** Given three already-ticketed Waltz components — log4j-core 2.14.1 with 2 new CVEs and ticket PROJ-12 In Progress, jackson-databind 2.9 with 1 new CVE and ticket PROJ-8 Done, commons-text 1.9 with no change — when the screen opens, the proposed actions are `update`, `follow-up` and `leave`.
- AE2. **Covers R3, R11.** Given jackson-databind 2.9 has PROJ-8 (Done, CVE-A) and follow-up PROJ-30 (Open, CVE-B), when the report lists CVE-A, CVE-B and CVE-C, only CVE-C is new and `update` writes to PROJ-30.
- AE3. **Covers R4, R13.** Given PROJ-5 was created by a Waltz import before this feature, when the report is re-imported, the row shows "baseline" with action `update`; after `apply`, PROJ-5 records its CVEs and rating, has no new comment, and the next import shows the row as "—".
- AE4. **Covers R12.** Given PROJ-12's summary is `[OSS] log4j-core 2.14.1 — High` and the rating is now Critical, `update` changes it to `[OSS] log4j-core 2.14.1 — Critical`; given a user renamed it to `log4j upgrade`, the summary stays and the comment notes the rating rise.
- AE5. **Covers R14.** Given `follow-up` on PROJ-8 and the link request fails, the new ticket exists, the row reports it with a warning that the link is missing, and the Output Channel logs the failure.
- AE6. **Covers R6, R8.** Given row A3 has no change, `A3 follow-up` is rejected with a message and A3 keeps `leave`.

### Scope Boundaries

- A newer version of the same library stays a new ticket, and the older version's ticket goes stale; linking the two is not part of this work.
- Stale detection and closing, the overview hub and the New group are unchanged.
- Email import is unchanged; it has no dedup and no Already-ticketed group.
- Jira priority is not changed by a rating rise.
- Descriptions of existing tickets are never rewritten; changes arrive as comments.

### Dependencies / Assumptions

- The Jira client can read issue links but cannot create them, so `follow-up` needs a new issue-link write operation.
- A "resolved" ticket means a ticket with a resolution set, the same test the stale search uses (`resolution is EMPTY` for open).

### Outstanding Questions

**Deferred to Planning**

- How a Waltz ticket records its CVEs and rating so later imports can read them back (Veracode uses one label per flaw id); planning weighs label count per ticket and search cost.
- How "newest open ticket" is chosen (creation date or key order) when an item has several open tickets.
- Whether the review session's schema version needs a bump and how an in-flight session from the previous version is handled.

### Sources / Research

- `src/participant/jira/reportImportHandler.ts` — `executeUpdateExistingTickets` (Veracode's current bulk update) and `recreateTicketedRows` (current re-create) are what the per-row actions replace.
- `src/utils/reportImport.ts` — `buildDedupJql` has no resolution filter; `buildReviewRows` sets `hasUnsyncedFindings`, today's change flag.
- `src/participant/jira/waltzHandler.ts`, `src/utils/waltzReport.ts` — Waltz dedup key is `sanitizeComponentLabel(nameVersion)`; summary format `[OSS] <nameVersion> — <maxVulnRating>`.
- `src/participant/sessionState.ts` — Already-ticketed screen and reply parsing (`buildTicketedGroupScreen`, `parseImportReviewReply`).
- `docs/plans/2026-09-14-1726-feat-veracode-fold-page-stale-plan.md` — origin of Veracode's update action; `docs/plans/2026-09-23-1400-feat-report-import-overview-hub-plan.md` — per-group screens and the no-write-without-action rule.
