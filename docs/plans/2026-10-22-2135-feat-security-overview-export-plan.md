---
title: Security Overview Export - Plan
type: feat
date: 2026-10-22
topic: security-overview-export
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Security Overview Export - Plan

## Goal Capsule

- **Objective:** A team member can see, for all open Veracode and Waltz items, which Jira ticket owns each, when it is due and which release should carry the fix, and can spot tickets with no release or a deadline the release misses.
- **Product authority:** The requirements below. The export reads Jira Fix Version and Due Date as the source of truth for release and deadline.
- **Open blockers:** None.

## Product Contract

### Summary

An overview export groups open Veracode and Waltz items by Jira Fix Version, with a final table for items not assigned to a release. Each row is one ticket, with its Due Date and a flag when the deadline is passed or falls before the release. It shows in chat and saves as a CSV. It starts from an `export` reply in a Veracode or Waltz import (one report, compared with Jira) or from a standalone Jira-only command that lists both tools together.

To make Veracode and Waltz tickets readable without their report, every ticket the import creates or rewrites also carries a table with one row per finding or component, and the export reads it back.

### Problem Frame

Veracode and Waltz findings are tracked as Jira tickets, but nobody can see in one place which items are due when, which ticket owns each and which release should carry the fix. Tickets with no release, or a Due Date earlier than the release date, are found by hand.

A Veracode ticket does not keep a finding's file, line and module in a form that can be read back. A folded ticket's overview table joins path, file and line into one cell, and the module appears only in per-finding sections that are the first thing dropped when a ticket is too big. A Jira-only view of Veracode locations is therefore not possible today.

### Actors

- A1. A developer or support engineer who reviews the open security backlog and plans fixes against releases.

### Key Decisions

- **Jira Fix Version is the release.** The Waltz "Fixed Version" (the component version that resolves a CVE) and affected versions are not part of the export. Governs R1, R4. (session-settled: user-directed — chosen over Waltz fixed version and affected version: the team plans fixes against its own releases.)
- **"Due before release" is the warning, not "due after release".** A Due Date earlier than the release date means the release ships after the deadline. Governs R4. (session-settled: user-directed — chosen over flagging a Due Date after the release: that fix lands in time.)
- **Report and Jira are compared in an import export; the standalone command is Jira-only and covers both tools.** Governs R6, R7. (session-settled: user-directed — chosen over a report-only export and over one tool per standalone export: grouping by release matters more than grouping by tool.)
- **Both entry points ship.** Governs R6, R7. (session-settled: user-directed — chosen over an import-only or standalone-only entry point.)
- **JQL uses `resolution is EMPTY`.** It matches the rest of the project. Governs R5. (session-settled: user-directed — chosen over `resolution = Unresolved`.)
- **Every ticket gets the table, single-finding ones included.** One reader then covers all new and rewritten tickets. Governs R13, R14. (session-settled: user-directed — chosen over tables only for folded tickets: two layouts would need two readers.)
- **The table is display-sanitized, and an exact raw-data block is deferred.** Text fields may differ slightly from the report, so the reader marks them approximate. Governs R15. (session-settled: user-directed — chosen over a raw JSON block in the description or a hidden issue property: smaller first version, and the reader's layers allow adding it later.)
- **Veracode's CSV has one row per finding.** File and line are how people scan findings, and per-row output filters and sorts in Excel. Governs R9. (session-settled: user-approved — chosen over a `;`-joined location column or aligned columns: sorting and filtering by file and line.)

### Requirements

**Overview tables**

- R1. The overview has one table per Jira Fix Version that has assigned tickets, ordered by release date, and a final **Not assigned to a release** table for tickets with no Fix Version (and, in an import export, for report items with no ticket).
- R2. Each table states its counts: Assigned (tickets in that Fix Version), Overdue, Due before release and No Due Date.
- R3. A row is one ticket, so a folded or merged ticket is one row with no member sub-line. Columns: item, rating or severity, ticket key with its Jira status, Due Date and flag. An import export adds a **Report match** column (tracked, stale, or in report with no ticket). The standalone export adds a **Source** column (Veracode or Waltz) and has no Report match. Rows sort by flag (overdue first, then due before release), then by Due Date.
- R4. A ticket is **overdue** when its Due Date is earlier than today. It is **due before release** when its Due Date is earlier than its Fix Version's release date. Overdue takes precedence when both apply. A Due Date after the release date is not flagged, and a Fix Version without a release date is never flagged.
- R5. Each table links to the matching list in Jira using JQL with `resolution is EMPTY`. The standalone export filters by the importers' labels and the Fix Version (or `fixVersion is EMPTY`). An import export uses an explicit key list, so stale tickets are included and the list matches the table. A table that holds items with no ticket says how many, since no list can show them.

**Entry points and delivery**

- R6. In a Veracode or Waltz import, an `export` reply on the overview builds the export for that one report, compared with Jira (tracked, stale, in report with no ticket).
- R7. A standalone command builds the export from Jira alone, with Veracode and Waltz tickets together in the same tables.
- R8. The result is a chat summary first, then a CSV on request, saved through a file dialog.

**CSV content**

- R9. For Veracode, the CSV has one row per finding: ticket key, status, Due Date, Fix Version, release date, flag, issue id, severity, CWE id, CWE name, module, path, file, line, function, Report match (import export only) and Detail source. A folded ticket's findings repeat the ticket columns.
- R10. For Waltz, the CSV has one row per ticket: the same ticket columns, rating, remediation action, the four remediation dates, and a Members column of the component names joined by `;`.
- R11. Every CSV row has a **Detail source** value saying where its detail came from: report, table, legacy layout, or title and labels.
- R12. CSV cells that start with `=`, `+`, `-` or `@` are neutralized so a spreadsheet cannot run them. Jira- and report-sourced text in chat tables is neutralized like other untrusted text in the chat.

**Ticket records**

- R13. Every Veracode ticket the import creates or rewrites, including single-finding tickets, carries a findings table with Issue ID, Severity, CWE id, CWE name, Module, Path, File, Line and Function as separate cells. The table stays complete when the ticket's other text is shortened for size.
- R14. Every Waltz ticket the import creates or rewrites, including single-component tickets, carries a components table with name and version, rating, remediation action and the four remediation dates.
- R15. A reader turns the ticket text back into per-finding or per-component data in layers: the table first, then the older layouts (single-finding Location block, previous folded table, Waltz "Remediation dates" section), then title and labels only. Issue id, CWE id, severity, line, rating and dates are exact. Text fields are marked approximate, because the import's sanitizer changes unusual characters. A table whose ids do not match the ticket's `veracode-issue-<id>` labels counts as edited and is reported. An unreadable row falls back field by field.
- R16. The standalone export reads each ticket's description, 8 at a time like the Waltz import does. A read that fails leaves that ticket at the title and labels level.
- R17. Tickets created before the tables existed are read best-effort and are not migrated in bulk. A rewrite upgrades them.

### Key Flows

- F1. Export from an import
  - **Trigger:** The user has loaded a Veracode or Waltz report and replies `export` on the import overview.
  - **Actors:** A1
  - **Steps:** The import's existing match of report rows to tickets is reused. Release tables and the Not assigned table are built from the tickets' Fix Version and Due Date plus the report-only items. The chat shows the summary and offers the CSV.
  - **Outcome:** One report's items by release, with Report match, flags and Jira links.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R8

- F2. Standalone Jira-only export
  - **Trigger:** The user runs the standalone command.
  - **Actors:** A1
  - **Steps:** Jira is searched for unresolved tickets with the Veracode or Waltz labels. Each ticket's description is read for detail. Tables are built as in F1 with a Source column.
  - **Outcome:** Both tools' tickets by release, with flags and Jira links.
  - **Covered by:** R1, R2, R3, R4, R5, R7, R8, R16

### Acceptance Examples

- AE1. **Covers R4.** Given today is 2026-10-22 and a ticket in Fix Version 2026.11 (released 2026-11-15) has Due Date 2026-11-01, when the overview is built, the ticket is flagged due before release. With Due Date 2026-12-01 it carries no flag.
- AE2. **Covers R4.** Given a ticket with Due Date 2026-10-10 in Fix Version 2026.11, it is flagged overdue (not due before release), and the table's Overdue count includes it.
- AE3. **Covers R1, R3.** Given a Veracode import with a report finding that has no ticket, when the user replies `export`, the finding appears in the Not assigned to a release table with Report match "in report, no ticket", and its table count says it has no Jira list.
- AE4. **Covers R3, R9.** Given a folded Veracode ticket with 7 findings, the chat table shows one row for it, and the CSV has 7 rows with the ticket key repeated and each finding's file and line.
- AE5. **Covers R10.** Given a merged Waltz ticket with 7 components, the CSV has one row whose Members column lists the 7 component names joined by `;`.
- AE6. **Covers R15, R11.** Given an older single-finding Veracode ticket with no table, the export reads the file and line from its Location block and sets Detail source to legacy layout. If the Location block is also gone, the row shows only the file from the title and labels' ids, with Detail source "title and labels".
- AE7. **Covers R12.** Given a file name that starts with `=`, the CSV cell is neutralized so a spreadsheet does not evaluate it.

### Success Criteria

- A reader can answer "what blocks release X?" and "which tickets have no release?" from one export without opening Jira.
- The same Jira-only export gives file and line for every Veracode finding on a ticket created after this change, without the report.

### Scope Boundaries

**Deferred for later**

- Excel (`.xlsx`) output. The first version ships CSV.
- An exact raw-data block (a `{code}` JSON block in the description, or a hidden issue property) for text fields the sanitizer changes.
- Changing tickets from the overview, such as setting Fix Versions or Due Dates.
- Bulk migration of old tickets to the new tables.
- Scheduled or recurring exports.

**Outside this work**

- Sources other than Veracode and Waltz.
- The Waltz "Fixed Version" and CVE details beyond what the tickets already record.

### Dependencies / Assumptions

- Jira exposes Fix Versions with release dates for the projects involved. A version without a date is shown but never flagged.
- The Jira search cannot return Veracode descriptions in a usable form on every instance (on Jira Cloud they come back as ADF), so a per-ticket read is assumed.
- The description size budget (about 30,000 characters) still applies to the added tables.

### Outstanding Questions

**Deferred to Planning**

- A ticket with more than one Fix Version: which release table holds it, or whether it appears in each.
- A slimmer last-resort table for a very large fold that exceeds the description budget even with only the table.
- The standalone command's name and how it is introduced to users alongside the existing slash commands and Agent Mode tools.
- Whether an import export may also offer the Jira-only items outside its report (other tickets with the same labels).

### Sources / Research

- `docs/report-import.md` and `docs/manual/report-imports.md`: the overview hub, Already ticketed / Stale split, folding, and the Waltz Due Date and remediation dates.
- `src/utils/veracodeReport.ts`: the finding fields, the folded overview table (Issue ID, Severity, CWE, Location, Function) and the sanitizers.
- `src/utils/waltzReport.ts` and `src/utils/waltzDates.ts`: the existing recorded-dates reader with its round-trip test, which the new readers can follow.
- `src/utils/reportImport.ts`: the JQL used by the dedup and stale searches (`resolution is EMPTY`) and the size budgets.
