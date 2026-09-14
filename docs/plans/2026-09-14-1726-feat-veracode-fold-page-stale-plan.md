---
title: Veracode Fold, Page & Stale Check - Plan
type: feat
date: 2026-09-14
topic: veracode-fold-page-stale
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Veracode Fold, Page & Stale Check - Plan

## Goal Capsule

- **Objective:** A support engineer running the Veracode (and Waltz) import can create one ticket per vulnerable line instead of one per flaw, browse and choose which batch of new candidates to create tickets from, and see — and close — open tickets whose findings have disappeared or been remediated, all without leaving the `@jira` chat flow.
- **Product authority:** `ce-brainstorm` dialogue, this session.
- **Open blockers:** none.

---

## Product Contract

### Summary

The shared Veracode/Waltz report-import flow (`reportImportHandler.ts`) gains three related capabilities. Same-line Veracode findings fold into one review row and one ticket instead of one per flaw. The "New — will create" section of the review screen becomes pageable, so a user can browse to and confirm any page of new candidates without first creating the ones before it. Every import run also flags open tickets whose findings have vanished from the scan or been remediated, letting the user select and close them inline through the existing bulk-transition mechanism. Paging and the stale-ticket check extend to the Waltz OSS import; folding stays Veracode-only.

### Requirements

**Stale-ticket detection (Veracode + Waltz)**

- R1. On every Veracode import run, after the report is parsed, the flow searches the target project for open (`resolution is EMPTY`) tickets carrying the `veracode` label and compares each one's `veracode-issue-<id>` labels against the current report's flaws.
- R2. A ticket is flagged stale when every `veracode-issue-<id>` label it carries corresponds to a finding that is either absent from the raw parsed report or present but no longer matching `ticketSidekick.veracode.includeRemediationStatuses`. A single-label ticket is the one-finding case of this same rule; a multi-label (folded, see R9-R11) ticket needs all its findings gone.
- R3. Flagged tickets render in their own review section, one reply-driven toggle per ticket (the same "Include?" pattern as the new/already-ticketed rows), defaulting to unselected so nothing transitions without an explicit choice.
- R4. On confirm, selected stale tickets transition through the same `cleanupRules`-driven mechanism `@jira cleanup` already uses: match a rule by project + issue type, resolve the transition path, and prompt for resolution exactly as the existing cleanup flow does.
- R5. The same stale check runs during the Waltz OSS import: an open ticket carrying the `oss-dependency` label is flagged stale when its component is either absent from the current Waltz report or present but no longer matching `ticketSidekick.waltz.includeRemediationActions`.

**Pageable review screen (Veracode + Waltz)**

- R6. The "New — will create" section becomes navigable in pages of up to `BATCH_LIMIT` (50) rows; the user can move to the next, previous, or a specific page number without leaving the session.
- R7. Each page defaults every one of its rows to included; navigating away does not preserve toggles made on a page the user has left — confirming from whichever page is currently visible creates that page's included rows.
- R8. Paging applies to both the Veracode and Waltz review screens' "New" section. The "Already ticketed" section is unaffected — shown in full, as today.

**Same-line finding folding (Veracode only)**

- R9. Veracode flaws sharing the same source file and line number fold into a single review row and, on creation, a single ticket — regardless of CWE or category — instead of one row/ticket per flaw.
- R10. A folded ticket's description covers every folded flaw (severity, CWE, description, recommendation per flaw), and its labels include one `veracode-issue-<id>` per folded flaw plus one `cwe-<id>` per distinct CWE among them.
- R11. A folded line is treated as already-ticketed in dedup search as soon as any one of its flaws' `veracode-issue-<id>` labels matches an existing open ticket; it is not recreated, and the review screen shows the matched ticket the same way a single-flaw match does today.
- R12. A flaw missing a source file or line number is never folded with another flaw — it stays its own row/ticket, regardless of whether other flaws also lack a location.
- R13. When a new flaw lands on a file+line that already has an open ticket (the R11 already-ticketed case), the import automatically adds that flaw's `veracode-issue-<id>` label to the existing ticket and posts a comment on it summarizing the new flaw (severity, CWE, description) — no separate selection or confirmation step. Skipped when that label is already present, so re-running the import never reposts the same comment.

### Key Decisions

- **A folded line is dedup'd and staled as one unit** — already-ticketed as soon as any of its findings has an existing ticket; not flagged stale until every finding at that line is gone. (session-settled: user-approved — chosen over per-finding dedup/staleness, which could open a duplicate ticket for a line still covered by an existing one.) Governs R2, R11.
- **Paging resets inclusion per page** rather than tracking a selection across the whole scan — confirming from whichever page is visible creates that page. (session-settled: user-approved — chosen over persistent cross-page selection state, which would allow mixing rows from different pages into one confirm at the cost of extra session-state complexity the "pick a page to create from" ask doesn't need.) Governs R7.
- **Stale-ticket transitions reuse the existing `cleanupRules` mechanism** instead of a new dedicated setting, so target status and resolution are configured in one place for both this flow and `@jira cleanup`. (session-settled: user-approved — chosen over a new `ticketSidekick.veracode` setting.) Governs R4.
- **"No longer on the scan" covers both outright absence and a remediation status the importer's filter now excludes**, not absence alone. (session-settled: user-approved.) Governs R2, R5.
- **The stale check runs automatically inside the existing import flow**, not as a separate command — the report is already parsed for ticket creation, so the same pass covers reconciliation. (session-settled: user-approved — chosen over a standalone audit command.) Governs R1, R5.
- **Stale tickets support inline selection and transition**, not just a list of links. (session-settled: user-directed — chosen over list-and-links-only: closing a ticket shouldn't require leaving chat.) Governs R3, R4.
- **Paging and stale-detection extend to the Waltz import; folding stays Veracode-only.** (session-settled: user-directed — chosen over scoping all three to Veracode only: the review/dedup machinery behind paging and staleness is already shared, and Waltz already creates one ticket per component, so there's no same-line case to fold.) Governs R5, R8, R9.
- **A new flaw on an already-ticketed line updates that ticket automatically** — its id joins the ticket's labels and a comment summarizes it — rather than leaving the ticket untouched for the user to update by hand. (session-settled: user-approved — chosen over manual follow-up: keeps the ticket's label coverage and history complete without extra user steps.) Governs R13.

### Key Flows

- F1. **Import run, end to end.**
  - **Trigger:** user runs `@jira import veracode report` (or resumes an in-progress session).
  - **Steps:** parse + filter the report → dedup search against the current flaws (existing behavior) → reverse stale search across the project's open tickets (R1) → build review rows, folding same-line flaws (R9) → render three sections in order — Already ticketed, New (page 1 of R6-R7), Stale (R3) — then wait for the user to page, toggle, and confirm.
  - **Outcome:** included New rows create tickets; included Stale rows transition.
  - **Covered by:** R1, R3, R6, R9.
- F2. **Paging the New section.**
  - **Trigger:** the user replies with a page-navigation command while a review session is active.
  - **Steps:** the session holds the full "new" row set (no longer pre-capped, unlike today) → the requested page's rows render, each defaulting to included → a toggle the user makes applies only to the currently visible page.
  - **Outcome:** confirming from that page creates its rows; a page the user has left keeps no toggle state.
  - **Covered by:** R6, R7.

### Acceptance Examples

- AE1. **Covers R2.** Given a ticket labeled `veracode-issue-1001` and the current report's flaw 1001 now has a `remediationStatus` outside `includeRemediationStatuses` (e.g. "Fixed") — When the import runs — Then the ticket is flagged stale even though flaw 1001 still appears in the raw XML.
- AE2. **Covers R2, R11.** Given a folded ticket labeled `veracode-issue-2001` and `veracode-issue-2002` (same file+line) and the new report still contains flaw 2002 as active — When the import runs — Then the ticket is *not* flagged stale, because at least one finding it covers is still active.
- AE3. **Covers R11, R13.** Given flaw 3001 already has a ticket, and a new flaw 3002 appears on the same file+line as 3001 in this scan — When the import runs — Then that line's row shows in "Already ticketed" (not recreated), 3002 is not separately ticketed, and the existing ticket gains a `veracode-issue-3002` label plus a comment describing flaw 3002.
- AE4. **Covers R13.** Given the ticket from AE3 already carries a `veracode-issue-3002` label from a prior run — When the import runs again with flaw 3002 unchanged — Then no duplicate comment is posted and the label is left as-is.
- AE5. **Covers R7.** Given the user is viewing page 2 of the New section with three rows toggled off — When the user pages to page 3 and replies "post it" — Then only page 3's rows (all included by default) are created; page 2's toggles have no effect.
- AE6. **Covers R9, R12.** Given two flaws share a source file and line, and a third flaw has no source file — When review rows are built — Then the two same-line flaws fold into one row/ticket, and the flaw with no location stays its own separate row/ticket.

### Scope Boundaries

- Folding does not extend to Waltz — a Waltz ticket already covers a whole component, so there is no same-line case.
- Stale-ticket transitions never happen automatically; a ticket transitions only after the user explicitly selects it and confirms.
- No new setting is added for the stale-ticket target status — `cleanupRules` in `.jira-templates.json` is the sole source, same as `@jira cleanup`.

### Dependencies / Assumptions

- Assumes `ticketSidekick.waltz.includeRemediationActions` plays the same per-item filter role for Waltz that `ticketSidekick.veracode.includeRemediationStatuses` plays for Veracode (`filterComponents()`, `src/utils/waltzReport.ts:307-312`) — R5 reuses it as the "filtered-out" half of the Waltz stale rule.
- Assumes the existing marker labels are sufficient to scope the reverse ticket search without a new label: `veracode` on every Veracode-created ticket (`buildLabels()`, `src/utils/veracodeReport.ts:242-246`) and `oss-dependency` on every Waltz-created ticket (`buildLabels()`, `src/utils/waltzReport.ts:346-347`).
- Assumes a cleanup rule (project + issue type) exists for a project where the stale check is meant to offer transitions — same precondition `@jira cleanup` already has; where none is configured, R4's transition step has nothing to run against for that project (a planning-time detail, not a new product behavior).

### Outstanding Questions

**Deferred to Planning:**

- Exact reply syntax for page navigation (e.g. `next page` vs. `page 3`) and whether it extends `parseReviewInput`/`applyReviewToggle` or needs new session-state fields.
- How the stale-ticket section composes into the existing review-table renderer (`buildImportReviewTable`) — a new section using the same column/toggle pattern, or a separate table.
- Exact JQL shape for the reverse "open veracode/oss-dependency tickets in this project" search, and how it's chunked for large projects.

### Sources / Research

- `src/utils/reportImport.ts` — shared `findAlreadyTicketed`, `capNewRows`, `buildReviewRows`, `BATCH_LIMIT` (50) (`src/utils/reportImport.ts:19`).
- `src/participant/jira/reportImportHandler.ts` — shared session flow all three importers drive through `ReportImportDescriptor`; `capNewRows` currently caps "new" rows *before* the review session is built (`src/participant/jira/reportImportHandler.ts:402-416`), which R6-R7 changes to a pageable session instead.
- `src/utils/veracodeReport.ts` — `parseVeracodeReport`, `buildLabels` (`:242-246`), `VeracodeReviewRow` shape; flaws carry `sourceFile`/`sourceFilePath`/`line`, each nullable (`:16-18`).
- `src/utils/waltzReport.ts` — `filterComponents`/`WaltzFilterOptions` (`:295-312`), `buildLabels` (`:346-347`).
- `src/participant/jira/cleanupHandler.ts` — existing `cleanupRules` matching, transition-path resolution, and resolution prompt (`:104-263`), reused by R4/R5's transition step; `resolution is EMPTY` as the project's existing convention for "open" (`:128`).
- `docs/report-import.md` — current Veracode/Waltz/email import flow description; update alongside this work per CLAUDE.md's "Where documentation belongs."
- `src/services/TicketService.ts` — `addComment()` (`:403-404`) and `updateField()`/`client.updateIssue()` (`:413-442`) already exist, so R13's label-add-plus-comment has a mechanism to build on rather than needing new client methods.
