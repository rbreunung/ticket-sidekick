---
title: Already-ticketed screen paging - Plan
type: feat
date: 2026-10-21
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Already-ticketed screen paging - Plan

## Goal Capsule

- **Objective:** A user reviewing a large Veracode or Waltz import can read and work through the "Already ticketed" results a page at a time instead of one long table.
- **Means:** Reuse the Stale screen's 20-row paging on the Already-ticketed screen (KTD1), with row actions staying global (KTD2).
- **Authority:** R-IDs win on behavior; KTDs win on mechanism; units override neither.
- **Stop conditions:** Stop and ask if paging would change what `apply`, `update tickets` or `re-create tickets` run, or the 50-actions-per-reply cap.
- **Execution profile:** Single PR, no migration or setting.

## Product Contract

### Summary

The Already-ticketed screen of the Veracode and Waltz importers shows 20 rows per page. `next`, `prev` and `page <n>` move between pages. Actions and counts still cover every page, as they do on the Stale screen.

### Problem Frame

A large report can match hundreds of already-ticketed rows. The New screen pages at 50 and the Stale screen at 20, but Already ticketed renders every row in one table, which is hard to read in a chat reply. Email imports have no Already-ticketed screen.

### Requirements

**Paging**

- R1. The Already-ticketed screen lists 20 rows per page, in row-id order, for Veracode and Waltz.
- R2. When there is more than one page, the screen shows "Page X of Y" and accepts `next`, `prev` and `page <n>` (and the existing `next page` / `previous` variants). A page number or move past either end clamps to the nearest page. A single page looks as it does today.
- R3. The page is independent of the New and Stale pages: navigating one never moves another.
- R4. When rows leave the screen (Waltz `accept component`), a page left past the last page clamps to the last page.

**Actions**

- R5. Paging is display only. `<row> <action>` and `all <action>` work on any row on any page, and `apply`, `update tickets`, `re-create tickets` and their counts cover every page.
- R6. The 50-actions-per-reply cap and the all-or-none `rewrite` rule per target ticket are unchanged.

**Guidance**

- R7. The screen's reply help and the user manual mention paging, and the known-limitation entry for page sizes names all three screens.

### Scope Boundaries

- Email import is unchanged; it has no Already-ticketed screen.
- The New screen's page size (50) and the Stale screen's (20) are unchanged.
- No page-size setting: KL16 already records that 20 is fixed.

**Considered and not built**

- Page-local `apply`: it would split one ticket's `rewrite` rows across pages and break the all-or-none rule. Revisit if users ask for it.
- Remembering the page across imports: the session ends with the import, as for New and Stale.

## Planning Contract

### Key Technical Decisions

- KTD1. **One shared 20-row page size for Stale and Already ticketed.** Generalize the existing Stale constant and its total/clamp helpers in `src/participant/session/importScreens.ts` instead of adding a parallel copy. A separate field `ticketedPage` on the review session keeps the two pages independent (R3). Governs R1, R3.
- KTD2. **Selection and actions stay global; only rendering is sliced.** The reply context already lists every open row, so `A25 update` resolves on any page, and `countImportGroups` already counts across pages. The handler's batch runner is not touched. Governs R5, R6.
- KTD3. **Clamp at render time, as the Stale screen does.** The stored page may go stale (rows dropped by an accept); the screen builder clamps it when it renders, so no handler code needs to repair it. Governs R4.

### Patterns to follow

- Stale paging: `STALE_PAGE_SIZE`, `staleTotalPages`, `clampStalePage` and the page line in `buildStaleGroupScreen` (`src/participant/session/importScreens.ts`); the `pageNav` branch and `stalePage` field in `src/participant/jira/reportImportHandler.ts` and `src/participant/session/importTypes.ts`.
- Reply parsing: `parseStaleGroupReply` in `src/participant/session/importReplies.ts` checks `parseReviewPageNav` before row-level parsing.

### Assumptions

- `next`, `prev`, `previous`, `page <n>` collide with no Already-ticketed vocabulary. `page 2` matches the `<row> <action>` shape but `2` is not an action word, so it falls through today; the nav check goes first anyway.

## Implementation Units

### U1. Slice and label the Already-ticketed table

- **Goal:** The screen renders one page of 20 rows with a page line, and counts and hints say they cover all pages.
- **Requirements:** R1, R2, R4, R5, R7
- **Dependencies:** none
- **Files:** `src/participant/session/importScreens.ts`, `src/participant/session/importTypes.ts`, `src/test/sessionImportReview.test.ts`
- **Approach:**
  - Generalize the page-size constant and total/clamp helpers so both screens use them (KTD1); keep `STALE_PAGE_SIZE` exported only if other code imports it.
  - Add the optional `ticketedPage` field next to `stalePage`.
  - In `buildTicketedGroupScreen`, slice the `ticketed` rows by the clamped page (KTD3) and add the same "Page X of Y … Reply next / prev or `page <n>`" line, shown only for more than one page.
  - When more than one page exists, say that `Apply N actions`, the shortcuts and `all <action>` cover every page.
- **Patterns to follow:** `buildStaleGroupScreen`.
- **Test scenarios:**
  - 45 already-ticketed rows render rows A1-A20 and "Page 1 of 3"; `ticketedPage` 2 renders A41-A45 and "Page 3 of 3".
  - 20 rows render all rows and no page line.
  - A stored `ticketedPage` of 9 with 45 rows renders the last page.
  - With 45 rows the `Apply N actions` count equals the open non-leave rows on all pages, not the visible 20.
- **Verification:** Screen tests pass; a single-page screen's output is byte-identical to before.

### U2. Navigate pages on the Already-ticketed screen

- **Goal:** `next`, `prev` and `page <n>` change `ticketedPage` and re-render.
- **Requirements:** R2, R3, R5, R6
- **Dependencies:** U1
- **Files:** `src/participant/session/importReplies.ts`, `src/participant/jira/reportImportHandler.ts`, `src/test/reportImportTicketedActions.test.ts`, `src/test/reportImportReviewPaging.test.ts`
- **Approach:**
  - `parseTicketedGroupReply` returns `pageNav` for the nav tokens, before the row/action parsing, and the `ticketed` line of `describeImportReplyVocabulary` lists them.
  - The handler's `pageNav` case gets a `ticketed` branch beside `stale`, moving only `ticketedPage` (KTD1).
  - Row actions, `apply` and the batch runner stay untouched (KTD2).
- **Patterns to follow:** The `stale` branch of the `pageNav` case; `parseStaleGroupReply`.
- **Test scenarios:**
  - Covers R2. `next`, `prev`, `page 3`, `page 99` and `prev` on page 1 land on pages 2, 1, 3, last and first.
  - Covers R3. Moving the Already-ticketed page leaves the New page and the Stale page unchanged, for a Veracode and a Waltz session.
  - Covers R5. With page 1 showing, `A25 follow-up` sets that row's action and `all leave` sets rows on every page.
  - Covers R6. `apply` with 60 pending rows on 3 pages runs the first 50 and reports the remaining 10; rewrite rows of one ticket spread across pages are still all-or-none.
  - Covers R4. After `accept component A2` removes rows on a Waltz import, a page past the new end renders the last page.
  - The "didn't understand" help for the screen mentions `next` / `prev`.
- **Verification:** The handler tests pass for both importers; a bare `next` on the New screen still pages New rows.

### U3. Update user and developer docs

- **Goal:** Users and maintainers can find the new paging and the corrected page-size note.
- **Requirements:** R7
- **Dependencies:** U1, U2
- **Files:** `docs/manual/report-imports.md`, `docs/report-import.md`, `docs/known-limitations.md`
- **Approach:**
  - In the manual's Already-ticketed bullet, add that the screen lists 20 rows per page, `next` / `prev` / `page 3` move between pages, and `Apply`, `Update tickets` and `Re-create tickets` act on every page.
  - In `docs/report-import.md`, add the paging note and the global-actions rule beside the Already-ticketed actions text, and the Stale paragraph's page-size sentence.
  - Update KL16 to say Stale and Already ticketed page at 20, New at 50, the closing/apply batch at 50, and that the size is still fixed; keep its date and severity logic.
- **Test expectation:** none -- documentation only; `src/test/userDocsSync.test.ts` checks settings and commands, which do not change.
- **Verification:** The manual, domain doc and KL16 agree on the three sizes.

## Verification Contract

| Check | Command | Applies to |
| --- | --- | --- |
| Type check | `npm run compile` | U1, U2 |
| Unit tests | `npm test` | U1, U2, U3 |

## Definition of Done

- R1-R7 hold for Veracode and Waltz, and the email import is unchanged.
- `npm run compile` and `npm test` pass.
- A single-page Already-ticketed screen renders as it did before.
- The manual, `docs/report-import.md` and KL16 describe the same page sizes.
- No abandoned experiment code remains in the diff.
