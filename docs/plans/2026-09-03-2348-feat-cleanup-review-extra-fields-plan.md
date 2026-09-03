---
title: Cleanup Review Table Extra Fields - Plan
type: feat
date: 2026-09-03
topic: cleanup-review-extra-fields
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Cleanup Review Table Extra Fields - Plan

## Goal Capsule

- **Objective:** A user reviewing a cleanup or bulk-transition batch in `@jira` can see extra ticket fields — starting with Fix Version — as columns in the review table, the same way `@jira search` results already can, without those fields appearing unless the user opts in. Misconfiguring either setting (an unknown field ID) is diagnosable rather than silently rendering nothing useful.
- **Means:** Add an opt-in `ticketSidekick.jira.cleanupFields` setting (mirroring `searchFields`) and extend the cleanup/transition review table to render configured fields through the same shared, field-metadata-driven column-building mechanism search's own extra columns now use too (KTD1-KTD5).
- **Product authority:** User-directed (this conversation, brainstorm and planning sessions).
- **Stop conditions:** None — no open blockers.
- **Execution profile:** `code`, Standard depth, 6 implementation units.
- **Tail ownership:** Automated tests cover `TicketService.ts` (fully Vitest-loadable) and `cleanupHandler.ts` (tested via `vi.mock('vscode')`, per its existing test suite). `JiraParticipant.ts`'s wiring — especially the `bulkTransition` case — imports `vscode` with no unit-test coverage of its own; the implementer verifies both entry points manually in the Extension Development Host.

---

## Product Contract

**Product Contract preservation:** changed — R7 added during planning dialogue (a user-directed decision, not a brainstorm reversal): a misconfigured field ID must log clearly rather than silently degrade, for both the new `cleanupFields` and the existing `searchFields`. Scope Boundaries reworded to reflect that search's own table-building is internally consolidated (KTD2) even though its user-visible output and requirements are unchanged. Following document review, R7/AE6 were reworded from "once per run" to "once per review-table render" to match what the mechanism actually does (see Key Technical Decisions).

### Summary

Add an opt-in setting, `ticketSidekick.jira.cleanupFields`, that adds one column per configured field to `@jira`'s cleanup/transition review table. The mechanism is generic (any field ID valid for `searchFields` works here too) and shares one column-building/rendering path with search's own extra columns and the existing batch-import review table, rather than a second, independent implementation. A field ID that doesn't match any known field logs clearly, for both settings.

### Problem Frame

`@jira search` already lets a user add extra field columns (including Fix Version) to its results table via `ticketSidekick.jira.searchFields` — the field is already fetched on every search request and rendered generically via the same field-metadata-driven logic used for the ticket-detail view. The cleanup/transition review table (`buildReviewTable` in `src/participant/sessionState.ts`, shown by `@jira run cleanup` and the ad-hoc "bulk transition from search results" flow) has no equivalent: its columns are fixed (Type, Key, Summary, From, → To, Resolution), and the tickets/subtasks it builds from carry no extra field data at all. A user doing release-based cleanup work — deciding which tickets in a batch belong to which fix version before transitioning them — has no way to see that context on the review screen itself.

### Requirements

**Configuring extra columns**

- R1. A new setting, `ticketSidekick.jira.cleanupFields` (array of field IDs, default empty), controls which extra fields appear as columns in the cleanup/transition review table. Empty (the default) renders the table exactly as it does today — no extra columns.
- R2. The mechanism is generic: any field ID valid for `ticketSidekick.jira.searchFields` (standard or custom) works the same way in `cleanupFields` — the initial implementation is not limited to Fix Version.

**Rendering**

- R3. When `cleanupFields` is non-empty, each configured field renders as a column using the same field-metadata-driven rendering search's extra columns use, so formatting (arrays, dates, users, truncation, etc.) stays consistent between the two tables.
- R4. Extra-field columns render for both parent-ticket rows and subtask rows in the review table.
- R5. The setting applies to both `@jira run cleanup` (cleanup-rule-based) batches and the ad-hoc "bulk transition" flow built from a prior search's results, since both render through the same review table.
- R6. Extra columns append after the table's existing columns (Type, Key, Summary, From, → To, and Resolution when present).
- R7. A configured field ID (in `cleanupFields` or `searchFields`) that does not match any known field is logged via the existing `logDiag` Output Channel convention, once per review-table render — distinct from a recognized field that is simply unset on a given ticket, which renders `_Not set_` with no log line.

### Key Decisions

- **Opt-in, not shown by default.** (session-settled: user-directed — chosen over always showing the column whenever at least one ticket in the batch has the field set: keeps the table uncluttered for cleanups where the field doesn't matter.) Governs R1.
- **A generic field-list setting, not a dedicated Fix Version toggle.** (session-settled: user-directed — chosen over a single boolean flag: lets other fields be added to this table the same way later, and the initial implementation is genuinely generic rather than Fix-Version-only code behind a generic-sounding setting name.) Governs R1, R2, R3.
- **One shared column-building path across search, cleanup, and the existing batch-import review table — not a second, independent implementation for cleanup.** (session-settled: user-directed — chosen after reviewing the codebase's two existing "extra column" precedents (search's own string-built table vs. the `ReviewTableColumn`/`renderReviewTable` abstraction Veracode/Waltz/email's batch-import table already shares): search's table-building is migrated onto the latter so all three tables render through one mechanism.) Governs R2, R3, R7.
- **A misconfigured field ID is logged, not silently swallowed — for both settings.** (session-settled: user-directed — chosen over inheriting search's current quiet fallback: since the new shared mechanism (previous decision) now serves both `cleanupFields` and `searchFields`, both settings gain the same clear diagnostic when a configured field ID doesn't exist.) Governs R7.
- **`@jira search`'s user-visible output is unaffected.** (session-settled: user-directed — the existing `searchFields` setting already covers the search use case; Fix Version is already fetched on every search request today. Its internal table-building changes per the shared-path decision above, but its requirements and rendered output do not.) Governs Scope Boundaries.

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
- AE6. **Covers R7.** Given `cleanupFields: ["gixVersions"]` (a typo'd, unknown field ID), When the review table renders, Then the Ticket Sidekick Output Channel records a warning naming `gixVersions` as unrecognized — once for that render, not once per row — and this is distinct from a recognized field that's simply unset (which logs nothing).

### Scope Boundaries

- `@jira search`'s user-visible results and requirements — already covered by the existing `searchFields` setting; unaffected by this work's output. (Its internal table-building is consolidated as part of this work — see Key Decisions and the Planning Contract.)
- Cleanup-rule JQL filtering by fix version (`fixVersionFilter`/`fixVersionPattern`) — a separate, existing feature that narrows *which* tickets match a rule; unrelated to this display-only feature.
- The `@jira view` ticket-detail table — out of scope; not part of the stated priority (search and transition/cleanup).

### Dependencies / Assumptions

- Assumes `ConfigService` gains a `cleanupFields: string[]` property read from `ticketSidekick.jira.cleanupFields`, symmetric to its existing `searchFields` property (`src/services/ConfigService.ts:13,34`).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A shared, generic column-building helper** (e.g. `buildExtraFieldColumns<TRow>(fieldIds, fieldMeta, valueOf, onUnknownField)`) is built on the existing pure `renderFieldValue()` (`src/services/TicketService.ts`), returning `ReviewTableColumn<TRow>[]` entries. `valueOf` lets each caller supply its own way of reading a field's raw value off a row (an issue's `fields` object for search, a ticket's own extra-fields bag for cleanup); `onUnknownField` is called once per unrecognized field ID per helper invocation, not per row. Each column's rendered value is pipe-escaped (`.replace(/\|/g, '\\|')`) exactly as search's existing `extraCols`/`renderExtra` logic already does — the helper replaces that logic, so it must preserve the same protection against a field value breaking the markdown table structure. Governs R2, R3, R7.
- KTD2. **`TicketService.searchTickets()`'s table construction is migrated from hand-built markdown row strings onto `ReviewTableColumn`/`renderReviewTable`** (the abstraction the batch-import review table already uses), output-preserving — existing `searchTickets` tests continue to assert the same rendered table, including a pipe-containing field value (new test case, per KTD1). This is a full-table migration, not just the extra columns, because leaving the fixed columns (Key/Summary/Status/Assignee) hand-built while only the extra columns route through the shared helper would leave one table built by two different mechanisms — the same fragmentation this work is meant to remove. Governs R3, R7 (search side).
- KTD3. **The two ticket-fetch paths need different plumbing — including for subtasks, not just parent tickets.** `TicketService.searchTicketsRaw` (used by `@jira run cleanup`'s ticket *and* subtask searches) gains a 3rd `extraFields` parameter, threaded to the already-existing `extraFields` support in `IJiraClient.searchJql`/`JiraApiClient.searchJql`. The ad-hoc bulk-transition path's `jiraClient.getIssue()` call already returns every field with no restriction for the **parent** ticket, so that half needs no fetch-layer change. Its **subtasks**, however, come from `issue.fields.subtasks` — Jira's embedded-subtask representation (typed `JiraSubtask` in `IJiraClient.ts`), which carries only `key`/`summary`/`status` regardless of what fields the parent issue was fetched with. Populating a bulk-transition subtask's extra-field values requires an additional batched search (`ticketService.searchTicketsRaw` with a `parent in (...)` JQL clause, passing `cleanupFields` as `extraFields`), mirroring the same pattern `handleRunCleanup`'s own subtask search already uses. Governs R4, R5.
- KTD4. **`TransitionBatchTicket`/`TransitionSubtask` (`src/participant/sessionState.ts`) gain a field-value bag** (e.g. `extra: Record<string, unknown>`), populated at ticket-construction time in both `handleRunCleanup` (from `searchTicketsRaw` results) and the `bulkTransition` case (from `getIssue()` plus KTD3's added subtask search). **`TransitionBatchSession` itself gains `fieldIds: string[]` and `fieldMeta: JiraFieldMeta[]`, set once when the session is built** and carried in `workspaceState` alongside `resolution`/`ruleName`/`issueType` exactly as those fields already are. `buildReviewTable(session, baseUrl)` reads `session.fieldIds`/`session.fieldMeta` directly rather than taking them as separate parameters — every call site that re-renders the review screen from a stored session (the initial render, the post-resolution-selection resume, and the invalid-input retry) gets the extra columns automatically, with nothing to remember to thread through at each call site. Governs R1, R4, R6.
- KTD5. **An unrecognized field ID is detected once per review-table render** — a configured ID with no matching entry in the fetched field metadata (`getFieldMeta()`) — and logged via `logDiag` (scope `jira.search` or `jira.cleanup`) naming the field ID, via KTD1's `onUnknownField` hook. A recognized field simply absent on a given row still renders `_Not set_` with no log line. Re-rendering the same session (e.g. after an invalid reply) logs again — this is accepted as the honest scope of "once per render," not "once per user-initiated cleanup," since the latter would require session-scoped dedup state for a cosmetic double-log that costs nothing beyond an extra Output Channel line. Governs R7.

### Assumptions

- `getFieldMeta()`'s existing "fetch only when the setting is non-empty" pattern (`config.searchFields.length > 0 ? await ticketService.getFieldMeta() : []`, `JiraParticipant.ts:1158`) is mirrored for `cleanupFields`, so an unused setting costs no extra API call on either path.
- KTD3's added subtask search for the bulk-transition path is a batched `parent in (...)` query (one extra API call per bulk-transition run when `cleanupFields` is set), not one `getIssue()` call per subtask — matching `handleRunCleanup`'s existing subtask-fetch pattern rather than adding N+1 calls for a batch with many subtasks.

---

## Implementation Units

### U1. Shared extra-field-column helper, invalid-field logging, and `searchTicketsRaw`'s extra-fields param

- **Goal:** Add the shared, generic column-building mechanism (KTD1) and its invalid-field detection (KTD5) to `TicketService.ts`, and give `searchTicketsRaw` the `extraFields` parameter the cleanup-rule path needs (KTD3).
- **Requirements:** R2, R3, R7. KTD1, KTD3, KTD5.
- **Dependencies:** None.
- **Files:**
  - `src/services/TicketService.ts`
  - `src/test/TicketService.test.ts`
- **Approach:**
  1. Add `buildExtraFieldColumns<TRow>(fieldIds, fieldMeta, valueOf, onUnknownField)` returning `ReviewTableColumn<TRow>[]`: for each field ID, look up its meta by ID; if absent, call `onUnknownField(fieldId)` once and render `_Not set_` for every row; if present, each column's accessor calls `renderFieldValue(valueOf(row, fieldId), meta)` and pipe-escapes the result (`.replace(/\|/g, '\\|')`), matching the escaping search's current `extraCols`/`renderExtra` logic already applies.
  2. Add a `searchTicketsRaw(jql, maxResults, extraFields = [])` parameter, forwarded to `this.client.searchJql(jql, maxResults, undefined, extraFields)`.
- **Test scenarios:**
  - `buildExtraFieldColumns` builds one column per field ID, header from the field's display name.
  - A recognized field with a real value renders via `renderFieldValue` (matches existing `renderFieldValue` test expectations for that type).
  - A recognized field absent on a given row renders `_Not set_`, and `onUnknownField` is not called.
  - An unrecognized field ID calls `onUnknownField` exactly once total across multiple rows, not once per row.
  - A field value containing a literal `|` is escaped so the rendered table isn't corrupted.
  - `searchTicketsRaw` forwards a non-empty `extraFields` array to `client.searchJql`'s 4th parameter; omitting it preserves today's call shape.
- **Verification:** `npm test` passes for the new and updated `TicketService.test.ts` cases.

### U2. Migrate `searchTickets()` onto the shared column mechanism

- **Goal:** `TicketService.searchTickets()` builds its table via `ReviewTableColumn`/`renderReviewTable` and U1's shared helper, with no change to its rendered output, and gains invalid-field-ID logging for `searchFields`.
- **Requirements:** R7 (search side). KTD1, KTD2, KTD5.
- **Dependencies:** U1.
- **Files:**
  - `src/services/TicketService.ts`
  - `src/test/TicketService.test.ts`
- **Approach:**
  1. Replace `searchTickets()`'s hand-built `extraCols`/`renderExtra`/header/separator string construction with: fixed `ReviewTableColumn`s for Key/Summary/Status/Assignee, plus `buildExtraFieldColumns(...)` for `extraFields`, passed to `renderReviewTable`.
  2. Wire `onUnknownField` to a `logDiag('jira.search', 'warn', ...)` call naming the field ID.
  3. Confirm the surrounding non-table lines ("Found N ticket(s):", the `[View in Jira]` link) are unchanged — only the table itself is rebuilt.
- **Test scenarios:**
  - Existing "renders configured extra columns" / "falls back to default 4 columns when none configured" tests (`TicketService.test.ts`'s `searchTickets extra columns` suite) pass unmodified in their assertions (output-preserving refactor).
  - `searchFields: ["gixVersions"]` (unknown) logs a warning naming `gixVersions` and still renders the table (with the column showing `_Not set_` for every row).
- **Verification:** `npm test` passes; `searchTickets`'s rendered markdown is byte-identical to before this unit for every pre-existing test case.

### U3. `cleanupFields` setting

- **Goal:** Add the new setting end to end: `package.json` declaration and `ConfigService` field.
- **Requirements:** R1.
- **Dependencies:** None.
- **Files:**
  - `package.json`
  - `src/services/ConfigService.ts`
  - `src/test/ConfigService.test.ts` (if it covers config field reads; add a case if so)
- **Approach:**
  1. Add `ticketSidekick.jira.cleanupFields` to `package.json`'s `contributes.configuration`, same shape as `searchFields` (`type: array`, `items: string`, `default: []`), description referencing the cleanup/transition review table.
  2. Add `cleanupFields: string[]` to `ConfigService`'s Jira config type and its `getConfig()` read (`config.get<string[]>('jira.cleanupFields') ?? []`), mirroring `searchFields` exactly.
- **Test scenarios:**
  - `ConfigService.getConfig()` returns `cleanupFields` from the configured setting, defaulting to `[]` when unset.
- **Verification:** `npm test` passes; the setting appears in VS Code's settings UI with the same shape as `searchFields`.

### U4. `sessionState.ts`: extra-fields bag, session-carried field config, and `buildReviewTable` columns

- **Goal:** `TransitionBatchTicket`/`TransitionSubtask` can carry configured field values; `TransitionBatchSession` carries the configured field IDs and metadata itself; `buildReviewTable` reads both off the session to render extra columns via U1's shared helper.
- **Requirements:** R1, R4, R6. KTD1, KTD4.
- **Dependencies:** U1.
- **Files:**
  - `src/participant/sessionState.ts`
  - `src/test/cleanupHandler.test.ts`
- **Approach:**
  1. Add `extra?: Record<string, unknown>` to `TransitionBatchTicket` and `TransitionSubtask`.
  2. Add `fieldIds: string[]` and `fieldMeta: JiraFieldMeta[]` to `TransitionBatchSession` (set once, at session-construction time — see U5), so every stored/resumed session already carries them.
  3. `buildReviewTable(session, baseUrl)` reads `session.fieldIds`/`session.fieldMeta` (no new parameters): when `fieldIds` is non-empty, append `buildExtraFieldColumns(...)` columns (reading each row's value via its `.extra` bag) after the existing fixed columns, calling the shared `onUnknownField` hook the same way U2 does for search (`logDiag('jira.cleanup', 'warn', ...)`).
  4. Subtask rows read their own `.extra` bag the same way parent rows do — no inheritance from the parent ticket.
- **Test scenarios:**
  - `buildReviewTable` with `fieldIds: []` (default) renders exactly as today (existing tests unmodified).
  - `buildReviewTable` with `fieldIds: ["fixVersions"]` and a ticket whose `.extra.fixVersions` is set renders a Fix Version column with that value.
  - A subtask with its own `.extra` value renders that value, independent of the parent ticket's value (Covers AE4).
  - An unrecognized field ID in `fieldIds` triggers the same once-per-render logging behavior as U1/U2 (Covers AE6).
- **Verification:** `npm test` passes for `cleanupHandler.test.ts`'s `buildReviewTable` suite, extended with the above cases.

### U5. `cleanupHandler.ts` and `JiraParticipant.ts` wiring

- **Goal:** Both ticket-creation paths — `@jira run cleanup` and the ad-hoc bulk-transition flow — populate `extra` on their tickets/subtasks (including bulk-transition's subtasks, which need their own fetch per KTD3) and set `fieldIds`/`fieldMeta` once when building each `TransitionBatchSession`.
- **Requirements:** R1, R3, R4, R5, R6, R7 (cleanup side). KTD3, KTD4, KTD5.
- **Dependencies:** U3, U4.
- **Files:**
  - `src/participant/jira/cleanupHandler.ts`
  - `src/participant/JiraParticipant.ts`
  - `src/test/cleanupHandler.test.ts`
- **Approach:**
  1. `handleRunCleanup` (`cleanupHandler.ts`): add `cleanupFields`/`cleanupFieldMeta` parameters; pass `cleanupFields` as `searchTicketsRaw`'s new `extraFields` argument in both the main and subtask searches; read each configured field off `issue.fields`/`s.fields` into the ticket's/subtask's `.extra` bag at construction time; set `fieldIds`/`fieldMeta` on the `TransitionBatchSession` object once, at construction. Because U4 moved these onto the session itself, every place that re-renders the review screen from a stored session — the initial render, the post-resolution-selection resume, and the invalid-skip-input retry — carries them automatically; no new parameter to remember at each of those call sites.
  2. `JiraParticipant.ts`: mirror the existing `searchFieldMeta` precedent (`config.searchFields.length > 0 ? await ticketService.getFieldMeta() : []`) as `cleanupFieldMeta`, fetched once before the `handleRunCleanup` call and once before the `bulkTransition` case's ticket loop. In `bulkTransition`, read each configured field off the already-fetched `issue.fields` (from `getIssue()`) into the parent ticket's `.extra`. For **subtasks**, `issue.fields.subtasks` only carries `key`/`summary`/`status` (KTD3) — run one additional `ticketService.searchTicketsRaw` call with a `parent in (...)` JQL clause and `cleanupFields` as `extraFields` (mirroring `handleRunCleanup`'s own subtask search) to get real field values for each subtask's `.extra` bag. Set `fieldIds`/`fieldMeta` on the `bulkTransition` path's `TransitionBatchSession` the same way.
- **Test scenarios:**
  - `handleRunCleanup` with `cleanupFields: ["fixVersions"]` passes `["fixVersions"]` to both `searchTicketsRaw` calls and builds tickets whose `.extra.fixVersions` matches the search result's field value.
  - The final review-table markdown from `handleRunCleanup` includes the configured extra column (Covers AE2, AE3).
  - The `TransitionBatchSession` built by `handleRunCleanup` carries `fieldIds`/`fieldMeta`, so a post-resolution-selection resume (`streamReviewScreen` called again on the same session) still renders the extra column without any new argument at that call site.
  - Integration: a cleanup-rule run and a bulk-transition run configured with the same `cleanupFields` produce review tables with the same extra-column shape, including subtask rows (Covers AE5) — exercised at the `buildReviewTable`/ticket-construction level, since `JiraParticipant.ts`'s `bulkTransition` case itself is not Vitest-loadable.
- **Verification:** `npm test` passes for `cleanupHandler.test.ts`. The `bulkTransition` half of this unit (in `JiraParticipant.ts`, which imports `vscode` with no unit coverage) is verified manually in the Extension Development Host: run a bulk transition from search results with `cleanupFields` set and confirm the review table shows the configured column with correct per-ticket **and per-subtask** values.

### U6. Documentation

- **Goal:** Record the new setting per the project's documentation convention.
- **Requirements:** none (documentation only).
- **Dependencies:** U1-U5.
- **Files:**
  - `docs/jira-flows.md` (Bulk cleanup section: mention `cleanupFields` alongside the existing cleanup-rule fields, and the shared rendering path with search)
  - `CLAUDE.md` (if the "Adding a new Jira operation" convention calls for a one-line index update — check whether this counts as a new flow or an extension of the existing bulk-cleanup flow already indexed there)
- **Test expectation:** none — documentation only, no behavioral change.
- **Verification:** `docs/jira-flows.md`'s bulk-cleanup section mentions `cleanupFields` and its relationship to `searchFields`.

---

## Verification Contract

| Command | Applies to | Done signal |
|---|---|---|
| `npm run compile` | All units | `tsc` reports no errors |
| `npm test` | All units | All Vitest suites pass, including the tests added/updated in U1-U5, and `cleanupHandler.test.ts`'s existing suite unmodified in behavior |

Manual verification (Extension Development Host): with `cleanupFields` set, run `@jira run cleanup` and confirm the extra column renders correctly for parent and subtask rows, including after a resolution-selection resume; run a bulk transition from prior search results with the same setting and confirm the review table matches for both parent and subtask rows; set an unknown field ID in both `cleanupFields` and `searchFields` and confirm a warning appears in the "Ticket Sidekick" Output Channel naming the field.

## Definition of Done

- `npm run compile` and `npm test` are both green, including new coverage from U1-U5.
- `TicketService.searchTickets()`'s rendered output is unchanged for every pre-existing test case after the KTD2 migration (output-preserving refactor verified, not assumed), including a pipe-containing field value.
- Both `@jira run cleanup` and the ad-hoc bulk-transition flow render the same extra-column shape for the same `cleanupFields` configuration, for both parent and subtask rows.
- An unrecognized field ID in either `cleanupFields` or `searchFields` produces a Ticket Sidekick Output Channel warning naming the field, verified manually since this crosses into `vscode`-coupled code.
- `docs/jira-flows.md` reflects the new setting (U6).
- Manual verification in the Extension Development Host confirms both entry points, including the bulk-transition subtask fetch (U5's tail ownership note).
