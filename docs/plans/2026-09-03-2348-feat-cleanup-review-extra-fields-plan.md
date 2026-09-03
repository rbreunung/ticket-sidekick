---
title: Cleanup Review Table Extra Fields - Plan
type: feat
date: 2026-09-03
topic: cleanup-review-extra-fields
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Cleanup Review Table Extra Fields - Plan

## Goal Capsule

- **Objective:** A user reviewing a cleanup or bulk-transition batch in `@jira` can see extra ticket fields — starting with Fix Version — as columns in the review table, the same way `@jira search` results already can, without those fields appearing unless the user opts in.
- **Means:** Add an opt-in `ticketSidekick.jira.cleanupFields` setting (a field-ID list, mirroring the existing `searchFields` setting) and extend the shared transition/cleanup review table to render any configured field using the same field-metadata-driven rendering search already uses.
- **Product authority:** User-directed (this conversation).
- **Open blockers:** None.
- **Execution profile:** `code`, Standard depth. Extends an existing, working review table and mirrors an existing settings pattern (`searchFields`) rather than inventing a new one.

---

## Product Contract

### Summary

Add an opt-in setting, `ticketSidekick.jira.cleanupFields`, that adds one column per configured field to `@jira`'s cleanup/transition review table — the screen shown before a batch of tickets is transitioned. The mechanism is generic (any field ID valid for `searchFields` works here too), not hardcoded to Fix Version, and stays off by default.

### Problem Frame

`@jira search` already lets a user add extra field columns (including Fix Version) to its results table via `ticketSidekick.jira.searchFields` — the field is already fetched on every search request and rendered generically via the same field-metadata-driven logic used for the ticket-detail view. The cleanup/transition review table (`buildReviewTable` in `src/participant/sessionState.ts`, shown by `@jira run cleanup` and the ad-hoc "bulk transition from search results" flow) has no equivalent: its columns are fixed (Type, Key, Summary, From, → To, Resolution), and the tickets/subtasks it builds from carry no extra field data at all. A user doing release-based cleanup work — deciding which tickets in a batch belong to which fix version before transitioning them — has no way to see that context on the review screen itself.

### Requirements

- R1. A new setting, `ticketSidekick.jira.cleanupFields` (array of field IDs, default empty), controls which extra fields appear as columns in the cleanup/transition review table. Empty (the default) renders the table exactly as it does today — no extra columns.
- R2. The mechanism is generic: any field ID valid for `ticketSidekick.jira.searchFields` (standard or custom) works the same way in `cleanupFields` — the initial implementation is not limited to Fix Version.
- R3. When `cleanupFields` is non-empty, each configured field renders as a column using the same field-metadata-driven rendering search already uses, so formatting (arrays, dates, users, truncation, etc.) stays consistent between the two tables.
- R4. Extra-field columns render for both parent-ticket rows and subtask rows in the review table.
- R5. The setting applies to both `@jira run cleanup` (cleanup-rule-based) batches and the ad-hoc "bulk transition" flow built from a prior search's results, since both render through the same review table.
- R6. Extra columns append after the table's existing columns (Type, Key, Summary, From, → To, and Resolution when present).

### Key Decisions

- **Opt-in, not shown by default.** (session-settled: user-directed — chosen over always showing the column whenever at least one ticket in the batch has the field set: keeps the table uncluttered for cleanups where the field doesn't matter.) Governs R1.
- **A generic field-list setting, not a dedicated Fix Version toggle.** (session-settled: user-directed — chosen over a single boolean flag: lets other fields be added to this table the same way later, and the initial implementation is genuinely generic rather than Fix-Version-only code behind a generic-sounding setting name.) Governs R1, R2, R3.
- **`@jira search` itself needs no change.** (session-settled: user-directed — the existing `searchFields` setting already covers the search use case; Fix Version is already fetched on every search request today.) Governs Scope Boundaries.

### Key Flows

- F1. Reviewing a cleanup/transition batch with extra columns configured
  - **Trigger:** User has set `ticketSidekick.jira.cleanupFields` and runs `@jira run cleanup` (a named rule) or a bulk transition from prior search results.
  - **Actors:** User, `@jira` chat participant.
  - **Steps:** Tickets (and their subtasks) matching the batch are fetched with the configured fields included; the review table renders one extra column per configured field, alongside the existing columns; the user reviews, optionally toggles rows, and confirms exactly as today.
  - **Covers:** R1, R2, R3, R4, R5, R6.

### Acceptance Examples

- AE1. **Covers R1.** Given `cleanupFields` is empty (the default), When a user runs `@jira run cleanup`, Then the review table renders exactly as it does today — no extra columns.
- AE2. **Covers R1, R2, R3.** Given `cleanupFields: ["fixVersions"]`, When a batch includes tickets with different fix versions set, Then the review table shows a Fix Version column, each value rendered the same way `@jira search` would render it.
- AE3. **Covers R2.** Given `cleanupFields: ["priority"]` (a field unrelated to Fix Version), When a cleanup batch runs, Then the review table shows a Priority column — confirming the mechanism is not hardcoded to Fix Version.
- AE4. **Covers R4.** Given a ticket with subtasks is in the batch and `cleanupFields` is set, When the review table renders, Then subtask rows also show their own value for each configured field, not left blank or inherited from the parent.
- AE5. **Covers R5.** Given a bulk-transition batch built from prior search results (no named cleanup rule involved) and `cleanupFields` is set, When the review table renders, Then it shows the same extra columns a cleanup-rule batch would show.

### Scope Boundaries

- `@jira search`'s own results table — already covered by the existing `searchFields` setting; unaffected by this work.
- Cleanup-rule JQL filtering by fix version (`fixVersionFilter`/`fixVersionPattern`) — a separate, existing feature that narrows *which* tickets match a rule; unrelated to this display-only feature.
- The `@jira view` ticket-detail table — out of scope; not part of the stated priority (search and transition/cleanup).

### Dependencies / Assumptions

- Assumes `TicketService.searchTicketsRaw` (used by the cleanup-rule path to find matching tickets) needs to accept an extra-fields parameter, since it does not request configured fields today beyond its fixed base set.
- Assumes the ad-hoc bulk-transition flow's existing per-ticket `getIssue()` call already returns full field data, so no equivalent fetch change is needed on that path — to be confirmed during planning.
- Assumes fetching field metadata for `cleanupFields` follows the same "only when the setting is non-empty" pattern `searchFields` already uses, so an unused setting costs no extra API call.
