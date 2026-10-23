---
title: Veracode SLA due dates - Plan
type: feat
date: 2026-10-23
topic: veracode-sla-due-dates
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Veracode SLA due dates - Plan

## Goal Capsule

- **Objective:** A Veracode ticket carries the due date the company's remediation policy gives its flaws, as the Jira Due Date, so deadlines can be filtered, flagged and exported like those of Waltz tickets.
- **Authority:** The Product Contract wins on behavior. `docs/report-import.md` stays the developer reference. The user manual (`README.md`, `docs/manual/report-imports.md`, `docs/manual/settings-reference.md`) is updated for the new setting, the ticket content and the changed Already ticketed behavior. `CONCEPTS.md` and `docs/known-limitations.md` are updated with the code.
- **Open blockers:** None.
- **Execution profile:** Code, implemented in a separate session. Test-first for the date helpers and the change detection. `npm run compile` and `npm test` pass before any commit. This plan builds on `docs/plans/2026-10-22-1929-feat-waltz-due-dates-plan.md`, which is implemented; reuse its mechanics instead of building parallel ones.

---

## Product Contract

### Summary

A new setting maps each Veracode severity to a number of days. A flaw's due date is the date Veracode first found it plus the days for its severity. The import writes the earliest due date of a ticket's flaws to the Jira Due Date and shows the dates in the description. The Already ticketed screen detects open tickets whose Due Date is empty or differs from the policy and offers `rewrite` to set it. `@jira /overview` and the import `export` show the same dates and flags they already show for Waltz.

### Problem Frame

The company's remediation policy sets a deadline per severity. A Veracode ticket carries none of it: it is created with no Due Date, so Jira's overdue filters and dashboards cannot see it, and `@jira /overview` counts every Veracode ticket under "no due date".

The Veracode Detailed Report records when each flaw was first found, and the policy clock starts then. An old flaw can therefore already be past its deadline on the day its ticket is created, which is the information the team needs. Tickets that already exist are the larger share of the work, so a feature that only dates new tickets would leave most of the backlog unflagged.

### Requirements

**The policy table**

- R1. A setting maps each Veracode severity to a number of days. It ships empty, with no built-in day counts.
- R2. A severity with no configured number gets no due date. With an empty table, imports behave exactly as they do today.

**The due date**

- R3. A flaw's due date is its first-found date plus the configured days for its severity. The first-found date is the calendar date Veracode records in the report.
- R4. A flaw whose report entry has no readable first-found date uses the creation date of its ticket as its start: the import date for a new ticket, the Jira creation date for an existing one.
- R5. A due date already in the past is written as it is.
- R6. A folded ticket takes the earliest due date of its flaws, each flaw counted with its own severity and first-found date. A fold in which no flaw has a due date gets none.

**On the ticket**

- R7. A new ticket's Jira Due Date is the ticket's due date (R6), and its description shows each flaw's first-found date and due date.
- R8. When Jira refuses the Due Date, the ticket is still created or rewritten without it, the result warns, and the dates stay in the description.
- R9. Creating a ticket, `rewrite`, `new ticket` and `add … to <KEY>` with `as rewrite` write the Due Date. `add … to <KEY>` with `as comment` adds the dates of the added flaws to the comment and leaves the Due Date alone.

**Backfill and refresh**

- R10. The Already ticketed screen counts an open ticket as changed when its Jira Due Date is empty or differs from the date the policy gives its flaws. This covers tickets created before this feature and tickets affected by a changed setting.
- R11. For an open ticket changed under R10, `rewrite` is the default action. It sets the Due Date from the policy, including over a date edited by hand, and the user manual and the result message say so.
- R12. A date difference alone does not change a ticket whose targets are all resolved. Such a ticket keeps its existing handling.
- R13. A flaw's severity, its start date (R3, R4) and the table are the only inputs to the date, and a start date does not move once the ticket exists, so an unchanged table and report give the same date on every import.
- R14. A ticket whose flaws have no due date (R2) is never flagged under R10 and never has its Due Date cleared.

**Overview and export**

- R15. `@jira /overview` shows Veracode tickets with the overdue and due-before-release flags, with no change to the overview itself.
- R16. The import `export` and `export csv` give a report-only Veracode row its due date and the overdue flag, using the same columns and rendering as Waltz. A report-only row has no Fix Version, so it never gets the due-before-release flag.

**Unchanged**

- R17. Waltz and email imports behave as before. Veracode's other actions, wording and screens stay as they are.

### Key Decisions

- **The date comes from a company table in settings, not from the report.** Chosen over using Veracode's own grace-period dates and over a report-first fallback: the written policy is the authority, and it works with any report. Governs R1, R3.
- **The clock starts at the flaw's first-found date.** Chosen over the import date and the report date: the policy runs from discovery, and counting from the import would hand out extra time on a late or repeated import. Governs R3, R4.
- **A flaw without a first-found date starts at its ticket's creation date.** Chosen over no due date and over the date of each import: the flaw still gets a date, and the date stays stable across imports. A report field that dates these flaws, if one turns up, would replace the fallback. Governs R4, R13.
- **No built-in day counts.** Numbers are the company's to set; shipping guesses would put wrong deadlines on real tickets. Governs R1, R2.
- **Existing tickets are backfilled through the Already ticketed screen.** Chosen over new tickets only and over a separate command: one place, one set of actions, and the date is deterministic so the refresh needs no newer-report logic. Governs R10, R11.
- **The backfill action is `rewrite`.** Chosen over a Due-Date-only action and over filling empty dates only: Veracode and Waltz keep one action set. The cost is that `rewrite` replaces hand-added description text and a hand-edited Due Date; the manual says so. Governs R11.
- **A date gap alone does not make a resolved ticket a change.** A resolved ticket's Due Date has no use, and treating it as a change would create a new ticket for every resolved ticket that predates the feature. Governs R12.
- **A folded ticket takes its earliest flaw date.** The ticket is due when its most urgent flaw is. Governs R6.
- **A refused Due Date does not stop the write.** Some projects keep the field off the screen. Governs R8.
- **Overview and export reuse the Waltz rendering.** The only Veracode change is that its rows now carry a due date. Governs R15, R16.

### Key Flows

- F1. Create tickets with policy dates
  - **Trigger:** The user imports a Veracode report after filling the setting.
  - **Steps:** Each flaw gets a due date from its first-found date and severity. Folded flaws take the earliest. New tickets are created with the Due Date and a dates section.
  - **Outcome:** New tickets show the policy deadline in Jira, overdue ones included.
  - **Covered by:** R3, R4, R5, R6, R7, R8
- F2. Backfill existing tickets
  - **Trigger:** The user imports a report whose flaws already have open tickets without a matching Due Date.
  - **Steps:** The Already ticketed screen lists those tickets as changed, defaulting to `rewrite`. The user adjusts rows and applies.
  - **Outcome:** Open tickets hold the policy Due Date and the current description.
  - **Covered by:** R10, R11, R12, R14

### Acceptance Examples

The dates and day counts below are invented.

- AE1. **Covers R3, R5, R7.** Given Very High set to 30 days and a Very High flaw first found on 2026-09-01, when its ticket is created on 2026-10-23, then the Due Date is 2026-10-01, already past, and the description shows both dates.
- AE2. **Covers R2, R14.** Given no number for Low and a Low flaw, when its ticket is created, then no Due Date is sent.
- AE3. **Covers R2, R17.** Given an empty table, when a report is imported, then no ticket gets a Due Date and the Already ticketed screen flags nothing for dates.
- AE4. **Covers R4.** Given a flaw with no readable first-found date and High set to 60 days, when its ticket is created on 2026-10-23, then its due date is 2026-12-22.
- AE5. **Covers R6.** Given a fold of a flaw due 2026-12-01, one due 2026-11-15 and one with no configured severity, when the ticket is created, then the Due Date is 2026-11-15.
- AE6. **Covers R8.** Given a project whose screen has no Due Date field, when a ticket is created, then it is created without it, the result warns, and the description still shows the dates.
- AE7. **Covers R10, R11.** Given an open ticket created before this feature and a table giving its flaws a date, when the report is imported, then the row shows a change and defaults to `rewrite`, which sets the Due Date.
- AE8. **Covers R10, R11.** Given an open ticket with Due Date 2026-12-01 and a table that now gives 2026-11-01, when the report is imported, then the row defaults to `rewrite`, and the rewrite sets 2026-11-01 even if someone had moved the date by hand.
- AE9. **Covers R12.** Given a resolved ticket with no Due Date, no new flaw and a table that gives its flaws a date, when the report is imported, then the date alone does not change the row.
- AE10. **Covers R9.** Given an `add … to <KEY>` with `as comment`, when it is applied, then the comment lists the added flaws' dates and the ticket's Due Date is not written.
- AE11. **Covers R16.** Given a New row whose due date is before today, when the user replies `export`, then the row shows its due date and the overdue flag and carries no due-before-release flag.
- AE12. **Covers R15.** Given a Veracode ticket created with a Due Date before today's date, when `@jira /overview` runs, then it shows the overdue flag.
- AE13. **Covers R4, R13.** Given an open ticket created on 2026-10-23 for a flaw with no readable first-found date, High set to 60 days and the ticket's Due Date 2026-12-22, when the same report is imported on 2026-11-20, then the row is not a change.

### Scope Boundaries

**Deferred for later**

- Using Veracode's own grace-period dates from the report, alone or as a fallback.
- Finding a report field that dates flaws with no first-found timestamp, to replace the creation-date fallback (R4).
- A Due-Date-only action, so a backfill can leave the description alone.
- Protection for a Due Date edited by hand, such as keeping it or asking per row.
- A setting to turn the Due Date write off.
- Clearing a Due Date, and date handling in the Stale close.
- A due-date column in the review tables.
- Built-in or suggested day counts.

**Outside this plan**

- Waltz and email imports.
- A Due Date for resolved tickets.

### Dependencies / Assumptions

- The Detailed Report records a first-found timestamp on each flaw (`date_first_occurrence`, for example `2026-05-01T10:00:00.000-0000` in `src/test/fixtures/veracode/sample-report.xml`). It has been seen only in the fixtures and a test report, not across real reports; flaws without it fall back per R4.
- The Waltz Due Date mechanics are implemented and shared: `dueDateFields` in `src/utils/waltzReport.ts`, `refusedFieldsOf` in `src/utils/jiraFieldErrors.ts`, the optional-field retry in `TicketService.createTicket`/`rewriteTicket`, and `deriveRewriteActions` in `src/utils/reportImport.ts`, which Veracode already uses.
- Veracode's overview export currently returns no due date (`dueDateOf: () => null` in `src/participant/jira/veracodeHandler.ts`, commented "a Veracode report carries no dates"); R16 replaces that.
- The Due Date write and its refusal fallback are unverified against a live Jira instance; KL17 in `docs/known-limitations.md` tracks that and is extended to Veracode.

### Outstanding Questions

**Deferred to Planning**

- The setting's key and shape (keyed by severity label or number), its validation, and how it is documented in `docs/manual/settings-reference.md`.
- How the backfill reads a ticket's current Due Date and creation date (R4, R10): from Jira's fields through the dedup search or the issue read, or from the description as Waltz does (see KL18). The Waltz description-read switch (`readsTargetDescriptions`) also runs a dropped-member pass, so reusing it must not change Veracode's other Already ticketed behavior (R17).
- Where the dates sit in the description and the Findings table, given the readers that accept older layouts in `src/utils/veracodeFindingsTable.ts`.
- The calendar date of a first-found timestamp when its offset differs from local time.

### Sources / Research

- `docs/plans/2026-10-22-1929-feat-waltz-due-dates-plan.md` — the Waltz design this plan reuses; its R8, R11 and R12 carry the same refusal, hand-edit and resolved-ticket rules.
- `docs/report-import.md` — "Already-ticketed rows: per-row actions", "Finding folding", "Remediation dates and the Due Date (Waltz)" and "Security overview".
- `src/participant/jira/veracodeHandler.ts` — `buildTicketFields`, `changeTracking` and `overviewExport` of the Veracode descriptor.
- `src/utils/securityOverview.ts` — `flagFor` and the Jira links that overview and export share.
- `src/utils/veracodeReport.ts` — the flaw model, which does not yet read the first-found date.
