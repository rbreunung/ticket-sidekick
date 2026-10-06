// Pageable New-section slicing, page navigation and bulk include/exclude for report-import reviews.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { VeracodeReviewRow } from '../../utils/veracodeReport';
import type { WaltzReviewRow } from '../../utils/waltzReport';
import { BATCH_LIMIT } from '../../utils/reportImport';
import { ReviewRowBase } from './importTypes';
import { ReviewTableColumn, neutralizeMarkdownLinks, normalizeReply, safeCellText } from './primitives';

// ---------------------------------------------------------------------------------------------
// U4: pageable review-session "New" section (R6-R8). `allRows` (the full, unpaged candidate set)
// is the source of truth; `buildReviewPage()` slices out one page's worth of "new" rows plus every
// "already ticketed" row (never paged, R8) any time the visible page needs to change. Kept
// separate from the screen renderers below (`buildNewGroupScreen()`) so the slicing logic is
// independently testable.
// ---------------------------------------------------------------------------------------------

export interface ReviewPage<TRow extends ReviewRowBase> {
  rows: TRow[];
  page: number; // clamped 0-based page actually returned
  totalPages: number;
}

/**
 * Slices a review session's full candidate set (`allRows`) into one displayable page: every
 * "already ticketed" row (R8 — shown in full regardless of page) plus one `BATCH_LIMIT`-sized page
 * of "new" rows, selected by `page` (0-based, clamped into `[0, totalPages - 1]` — an out-of-range
 * request, e.g. `next` from the last page or a `page <n>` beyond the end, lands on the nearest
 * valid page rather than erroring). `totalPages` is always at least 1, even when there are zero
 * "new" rows, so a caller never divides by / indexes a zero-page result.
 *
 * Deliberately re-derives `rows` fresh from `allRows` every time rather than mutating in place —
 * `allRows` itself is never touched here, which is what makes a "new" row's toggle page-local
 * (R7): a toggle applied only to a page's returned `rows` (see `applyReviewSessionToggle()`)
 * evaporates the next time this function re-slices that page from `allRows`.
 */
export function buildReviewPage<TRow extends ReviewRowBase>(allRows: TRow[], page: number): ReviewPage<TRow> {
  const ticketed = allRows.filter(r => r.existingTicketKey !== null);
  const fresh = allRows.filter(r => r.existingTicketKey === null);
  const totalPages = Math.max(1, Math.ceil(fresh.length / BATCH_LIMIT));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * BATCH_LIMIT;
  return { rows: [...ticketed, ...fresh.slice(start, start + BATCH_LIMIT)], page: clampedPage, totalPages };
}

export type ReviewPageNav =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'goto'; page: number }; // 0-based

/**
 * U4/R6: recognizes a page-navigation reply — `next`/`prev`/`page <n>`, case-insensitive, plus the
 * `next page`/`prev page`/`previous`/`previous page` variants — ahead of `parseReviewInput`'s own
 * toggle/ok/cancel parsing. The caller checks this FIRST: none of these strings collide with
 * `isConfirmation`/`isCancellation`'s word lists or with a numeric row-id toggle, so falling
 * through to `parseReviewInput` for anything this returns `null` for is always safe. `page <n>`
 * takes a 1-based page number (as typed or clicked); the returned `page` is 0-based to match
 * `buildReviewPage`'s indexing directly.
 */
export function parseReviewPageNav(reply: string): ReviewPageNav | null {
  const normalized = normalizeReply(reply);
  if (normalized === 'next' || normalized === 'next page') return { kind: 'next' };
  if (normalized === 'prev' || normalized === 'previous' || normalized === 'prev page' || normalized === 'previous page') {
    return { kind: 'prev' };
  }
  const match = normalized.match(/^page (\d+)$/);
  if (match) return { kind: 'goto', page: parseInt(match[1], 10) - 1 };
  return null;
}

/**
 * U4/R7: applies a toggle reply's row ids to the currently-visible "new" rows only. `allRows` is
 * deliberately left untouched: R7's per-page reset relies on `allRows` staying at its
 * default-included state for "new" rows, so a page revisited later always renders with every row
 * back to its default-included state. Already-ticketed rows are never toggled — they carry a
 * per-row action instead (import ticket updates parity, U4).
 */
export function applyReviewSessionToggle<TRow extends ReviewRowBase>(
  rows: TRow[],
  allRows: TRow[],
  ids: string[],
): { rows: TRow[]; allRows: TRow[] } {
  const idSet = new Set(ids);
  const newRows = rows.map(r => (r.existingTicketKey === null && idSet.has(r.id) ? { ...r, included: !r.included } : r));
  return { rows: newRows, allRows };
}

/**
 * "Include all" / "Exclude all" bulk-reply keyword for the review table's New section — a distinct
 * outcome from `ok`/`cancel`/a row-id toggle/a page-nav token (U4)/a stale-ticket-key toggle (U6),
 * checked in the same order `handleImportReviewReply` already threads those through. Returns
 * `true` for "include all", `false` for "exclude all", and `null` when the reply is not a bulk
 * New-row action at all — the caller then falls through to its existing parsing unchanged.
 * Case-insensitive exact match only (no fuzzy/partial matching) — deliberately narrow so it can
 * never collide with a row-id toggle list, a page-nav token, a stale-ticket key, or any other
 * reply shape (verified disjoint from every existing vocabulary).
 */
export function parseBulkNewRowReply(reply: string): boolean | null {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'include all') return true;
  if (normalized === 'exclude all') return false;
  return null;
}

/**
 * Sets `included` to `value` on every "new" row (`existingTicketKey === null`) in the passed page
 * array — the bulk counterpart of `applyReviewToggle`'s per-row flip. Already-ticketed rows are
 * left untouched (R4). Operates on the passed page array only and never touches `allRows`, exactly
 * matching how a per-row New toggle is page-local: navigating away from a page and back re-derives
 * it from `allRows`, which still holds the default-included state (R3). Pure so it's independently
 * testable; the caller (`handleImportReviewReply`) only assigns the result to `session.rows`.
 */
export function applyBulkNewRowSet<TRow extends ReviewRowBase>(rows: TRow[], value: boolean): TRow[] {
  return rows.map(r => (r.existingTicketKey === null ? { ...r, included: value } : r));
}

// Summary/component name are untrusted, scan-report-derived free text — this table's whole output
// is trust-gated (KTD5, U6) once it carries the per-row toggle links below, so both go through
// neutralizeMarkdownLinks() (see its own doc comment). Severity/CWE-id/rating stay unsanitized —
// enum-shaped/numeric values from the report's own schema, not free text.
export const VERACODE_REVIEW_COLUMNS: ReviewTableColumn<VeracodeReviewRow>[] = [
  { header: 'Severity', accessor: (r) => `${r.severityLabelText} (${r.severity})` },
  { header: 'CWE', accessor: (r) => (r.cweId ? `CWE-${r.cweId}` : '—') },
  { header: 'Summary', accessor: (r) => neutralizeMarkdownLinks(r.summary) },
];

export const WALTZ_REVIEW_COLUMNS: ReviewTableColumn<WaltzReviewRow>[] = [
  { header: 'Component', accessor: (r) => neutralizeMarkdownLinks(r.nameVersion) },
  { header: 'Rating', accessor: (r) => safeCellText(r.maxVulnRating) },
];
