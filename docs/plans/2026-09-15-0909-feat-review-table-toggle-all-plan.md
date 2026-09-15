---
title: Review Table Toggle All - Plan
type: feat
date: 2026-09-15
topic: review-table-toggle-all
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Review Table Toggle All - Plan

## Goal Capsule

- **Objective:** In the report-import review screen, a user can include or exclude every "New" row on the currently visible page with a single action, instead of toggling rows one at a time.
- **Means:** Two bulk controls — "Include all" and "Exclude all" — added to the shared import review table, reusing the existing per-row toggle mechanism (KTD1–KTD3).
- **Product authority:** antrophos (the user). Surrounding areas are not active scope: already-ticketed rows, the stale section, and cross-page reach.
- **Execution profile:** Standard; three units (pure helpers → render → handler wiring); test-first for the pure helpers in U1/U2.
- **Stop conditions:** Stop if a bulk reply token collides with an existing reply vocabulary (verified disjoint — KTD1), or if page-local persistence would require changing `allRows` semantics (it does not — KTD2).
- **Who finishes and ships:** `ce-work` executes the units; `npm run compile` + `npm test` gate before commit.
- **Open blockers:** None.

---

## Product Contract

_Product Contract unchanged (R1–R6, F1, AE1–AE3 preserved). The one Deferred-to-Planning question — reply-token syntax and collision handling — is resolved in KTD1._

### Summary

Add two bulk controls — "Include all" and "Exclude all" — to the report-import review table so a user can set every New row on the current page to included or excluded in one action, instead of toggling rows individually. The controls appear for all three importers (Veracode, Waltz, email) because they share one table renderer.

### Key Decisions

- **Two separate controls, not a single flip-all.** Include all and Exclude all are distinct actions rather than one "flip every row" toggle. (session-settled: user-directed — chosen over a single literal flip-each-row control and over offering only one direction: two explicit controls read the same regardless of the table's current mixed state, whereas a literal flip is only predictable when rows already agree.) Governs R1, R2.
- **Page-scoped to New rows only.** Both controls act on the "New — will create" rows on the currently visible page and nothing else. (session-settled: user-directed — chosen over applying across all pages and over including the always-visible Already-ticketed section: every existing action on this screen is page-context, so a bulk control that reaches beyond what's on screen would be surprising.) Governs R3, R4.
- **Shown for all three importers.** The controls live in the shared table renderer with no per-importer gating. (session-settled: user-directed — chosen over Veracode-only: the table is one code path, so gating would add complexity for no behavioral difference.) Governs R5.

### Requirements

**Bulk controls**

- R1. The review screen offers an "Include all" control that sets every New row on the current page to included (will be created).
- R2. The review screen offers an "Exclude all" control that sets every New row on the current page to excluded (will not be created).

**Scope of effect**

- R3. Both controls affect only the "New — will create" rows on the currently visible page; they do not change rows on other pages.
- R4. Both controls leave the Already-ticketed section untouched.
- R5. The controls appear for all three importers (Veracode, Waltz, email).

**Feedback**

- R6. After a bulk action, the screen re-renders so the user sees each New row's updated Include? state and the updated "N ticket(s) will be created" count.

### Key Flows

- F1. Bulk include / exclude on the review screen
  - **Trigger:** User clicks "Include all" or "Exclude all" (or types the equivalent reply).
  - **Steps:** The control resubmits a bulk command; the handler sets `included` for every New row on the current page; the screen re-renders.
  - **Outcome:** All New rows on the page reflect the new state; Already-ticketed rows and other pages are unchanged (R3, R4).

### Acceptance Examples

- AE1. Covers R1, R6. Given a page of 5 New rows all included by default, When the user clicks "Exclude all", Then all 5 show as excluded and the count reads "0 ticket(s) will be created".
- AE2. Covers R2, R4. Given a page with 3 New rows and 2 already-ticketed rows, When the user clicks "Include all", Then the 3 New rows become included and the 2 already-ticketed rows remain excluded.
- AE3. Covers R3. Given a multi-page report, When the user clicks "Exclude all" on page 1 then navigates to page 2, Then page 2's New rows are unaffected by page 1's action.

### Scope Boundaries

- Already-ticketed rows: not affected by the bulk controls (R4).
- Stale section: uses a different toggle vocabulary (ticket keys); out of scope.
- Cross-page reach ("select all across pages"): deliberately not supported (R3).

### Dependencies / Assumptions

- Bulk New-row actions follow the same page-local persistence as existing per-row New toggles: navigating away from a page and back resets that page's New rows to their default-included state. This keeps bulk and per-row behavior consistent (R3).

### Sources / Research

- `src/participant/sessionState.ts` — `buildImportReviewTable()` (renders the table and per-row Include? toggle links), `parseReviewInput()` (parses row-id toggle replies), `applyReviewSessionToggle()` / `applyReviewToggle()` (flip logic), `buildReviewPage()` (paging: New rows page-local, Already-ticketed always shown in full).
- `src/participant/jira/reportImportHandler.ts` — `handleImportReviewReply()` (reply routing order) and `executeImportBatch()`.
- `docs/plans/2026-08-20-1055-refactor-unify-review-table-rendering-plan.md` — the shared table renderer this feature extends.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Dedicated exact-match predicate, not a `parseReviewInput` extension.** A new pure `parseBulkNewRowReply(reply)` returns `true` (include), `false` (exclude), or `null` (not a bulk reply); the handler checks it before `parseReviewInput`, mirroring the existing `isUpdateExistingTicketsReply` precedent. This keeps `parseReviewInput`'s shared contract — also used by the template-generation flow — untouched. The tokens `include all` / `exclude all` are verified disjoint from every existing reply vocabulary: not a confirmation word (the list has `load all`/`show all`, not these), not a cancellation, not a page-nav token (`next`/`prev`/`page <n>`), not a hyphenated stale-ticket key, and not a row-id token (row ids are single tokens; `include all` is two). Governs R1, R2.
- KTD2. **Page-local persistence — touch `session.rows` only.** The bulk set applies to the current page's New rows via a new pure `applyBulkNewRowSet(rows, value)` and leaves `session.allRows` untouched, exactly matching how per-row New toggles are page-local (the Dependencies/Assumptions note). Navigating away from a page and back re-derives it from `allRows`, which still holds the default-included state. Governs R3.
- KTD3. **Controls rendered adjacent to the New section, gated on New rows existing.** The two links render as a hint line inside the New section (only when at least one New row exists), using `buildChatCommandLink` with static labels and static command text — no untrusted content, so no extra sanitization beyond the table's existing `trustedChatMarkdown` gate. Placing them in the New section (not the shared footer) ties them visually to the rows they affect and avoids implying reach into Already-ticketed or Stale sections. Governs R1, R2, R4, R5.

### Assumptions

- The reply tokens are `include all` and `exclude all`, matched case-insensitively after trimming (KTD1).
- No per-importer gating is needed: the controls live in the shared renderer and apply to all three importers (R5), so no `ReportImportDescriptor` field changes.

### Sequencing

U1 (pure helpers) → U2 (render) → U3 (handler wiring). U2 and U3 both depend on U1's functions existing; U3 depends on U2 only in that the rendered links must resubmit the exact tokens U1 parses. They are independent files and can land as separate commits.

---

## Implementation Units

### U1. Pure bulk-reply parser and apply function

- **Goal:** Add the two pure, vscode-free functions that recognize a bulk reply and set New-row inclusion, so both the renderer and the handler can reuse them.
- **Requirements:** R1, R2, R3 (mechanism).
- **Dependencies:** none.
- **Files:** `src/participant/sessionState.ts` (add `parseBulkNewRowReply`, `applyBulkNewRowSet`); `src/test/sessionState.test.ts` (tests).
- **Approach:**
  1. `parseBulkNewRowReply(reply: string): boolean | null` — trim + lowercase; return `true` for `include all`, `false` for `exclude all`, else `null`. Exact-match only, mirroring `isUpdateExistingTicketsReply`.
  2. `applyBulkNewRowSet<TRow extends ReviewRowBase>(rows: TRow[], value: boolean): TRow[]` — map over `rows`, setting `included: value` only where `existingTicketKey === null` (New rows); leave already-ticketed rows untouched. Operates on the passed page array only; never touches `allRows`.
- **Patterns to follow:** `isUpdateExistingTicketsReply()` (exact-match predicate shape), `applyReviewToggle()` / `applyStaleTicketToggle()` (pure map-over-rows set/flip shape).
- **Test scenarios:**
  - `parseBulkNewRowReply('include all')` → `true`; `'INCLUDE ALL'` and `'  include all  '` → `true`.
  - `parseBulkNewRowReply('exclude all')` → `false`; case/whitespace variants → `false`.
  - `parseBulkNewRowReply('2 4')`, `'A1'`, `'next'`, `'post it'`, `'cancel'`, `'PROJ-123'`, `'include'`, `'all'`, `''` → `null` (no false positives against existing vocabularies).
  - `applyBulkNewRowSet(rows, true)` sets `included: true` on every New row and leaves already-ticketed rows unchanged.
  - `applyBulkNewRowSet(rows, false)` sets `included: false` on every New row; already-ticketed rows unchanged (Covers AE2).
  - A page with zero New rows returns an array where only already-ticketed rows exist, all untouched.
- **Verification:** `npm run compile` passes; the new `sessionState.test.ts` cases are green under `npm test`.

### U2. Render the two controls in the review table

- **Goal:** Show "Include all" and "Exclude all" as clickable links on the review screen, tied to the New section.
- **Requirements:** R1, R2, R4, R5, R6 (render half).
- **Dependencies:** U1 (the command text must match KTD1's tokens; no code dependency on U1's functions).
- **Files:** `src/participant/sessionState.ts` (`buildImportReviewTable`); `src/test/sessionState.test.ts` (render tests).
- **Approach:**
  1. In `buildImportReviewTable`, after rendering the New table and only when `fresh.length > 0`, push a hint line: `Reply [Include all] / [Exclude all] to set every New row on this page.` where each label is a `buildChatCommandLink(label, '@jira', commandText)` with command text `include all` / `exclude all`.
  2. Do not add the links when there are no New rows (they would be no-ops).
  3. No new sanitization — labels and command text are static; the table output is already trust-gated by the caller's `trustedChatMarkdown`.
- **Patterns to follow:** the per-row Include? cells (`buildChatCommandLink(r.included ? '✓' : '_excluded_', '@jira', r.id)`) and the existing footer links.
- **Test scenarios:**
  - A page with New rows renders both `Include all` and `Exclude all` links, each resubmitting its exact token (`include all` / `exclude all`).
  - A page with zero New rows (all already ticketed) renders neither link.
  - The links appear for the Waltz column set too (shared renderer — R5).
- **Verification:** `npm run compile` passes; render tests green under `npm test`.

### U3. Wire bulk replies into the review handler

- **Goal:** Recognize a bulk reply in the chat flow, apply it to the current page's New rows, and re-render.
- **Requirements:** R1, R2, R3, R6 (behavior half).
- **Dependencies:** U1 (`parseBulkNewRowReply`, `applyBulkNewRowSet`), U2 (the links that produce these replies).
- **Files:** `src/participant/jira/reportImportHandler.ts` (`handleImportReviewReply`).
- **Approach:**
  1. In `handleImportReviewReply`, after the page-nav and stale-ticket-key checks and alongside the "update existing tickets" check, call `parseBulkNewRowReply(reply)`.
  2. When it returns non-null, set `session.rows = applyBulkNewRowSet(session.rows, value)` (leave `session.allRows` untouched — KTD2) and return `streamImportReview(...)` to re-render.
  3. Do not gate on any descriptor field (available to all three importers — R5).
- **Patterns to follow:** the existing "update existing tickets" branch in the same function (predicate check → mutate session → `streamImportReview`).
- **Test scenarios:** This unit is vscode-dependent glue; per the project's testing convention it is covered by the e2e suite, not Vitest. The pure logic it calls is fully tested in U1/U2.
  - E2E: on a Veracode review screen with New rows, replying `exclude all` re-renders with every New row excluded and the count at 0 (Covers AE1); replying `include all` includes them (Covers AE2).
  - E2E: after `exclude all` on page 1, navigating to page 2 shows page 2's New rows still default-included (Covers AE3).
- **Verification:** `npm run compile` passes; e2e scenarios pass under `npm run test:e2e`.

---

## Verification Contract

- `npm run compile` — TypeScript type check; must pass before commit.
- `npm test` — Vitest unit tests (no VS Code required); must be green before every commit. New coverage lands in `src/test/sessionState.test.ts` (U1, U2).
- `npm run test:e2e` — `@vscode/test-electron` participant tests; covers the vscode glue in U3. Not run in CI (needs a real VS Code instance).
- Regression guard: existing reply behaviors must be unchanged — row-id toggles (`2 4`, `A1`), page-nav (`next`/`prev`/`page <n>`), `post it`, `cancel`, stale-ticket-key toggles, and "update existing tickets".

---

## Definition of Done

- `npm run compile` and `npm test` are green.
- Both controls render for all three importers (R5) and only when New rows exist.
- Bulk actions are page-local to New rows: Already-ticketed rows and other pages are unaffected (R3, R4; AE2, AE3).
- No regression to any existing review-reply behavior.
- Abandoned-attempt code removed from the diff before commit.
