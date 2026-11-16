// Report-import review rows: the New-row page slice, merged New rows, the per-row action change, the result groups and
// view state a review starts with, the Stale and Already-ticketed page counts, and the ticket search match. Pure, vscode-free.

import { BATCH_LIMIT, type TicketInfo } from '../utils/reportImport';
import {
  emptyImportOutcomes, isTicketedRowFinished, ticketedRowActions,
  type ImportResultGroup, type ImportReviewView, type ReviewRowBase, type ReviewSession, type ReviewSessionStale, type TicketedAction,
} from './types';

export interface ReviewPage<TRow extends ReviewRowBase> {
  rows: TRow[];
  page: number; // clamped 0-based page actually returned
  totalPages: number;
}

/**
 * Slices a review session's full candidate set (`allRows`) into one displayable page: every
 * "already ticketed" row (shown in full regardless of page) plus one `BATCH_LIMIT`-sized page
 * of "new" rows, selected by `page` (0-based, clamped into `[0, totalPages - 1]` — an out-of-range
 * request, e.g. `next` from the last page or a `page <n>` beyond the end, lands on the nearest
 * valid page rather than erroring). `totalPages` is always at least 1, even when there are zero
 * "new" rows, so a caller never divides by / indexes a zero-page result.
 *
 * Deliberately re-derives `rows` fresh from `allRows` every time rather than mutating in place —
 * `allRows` itself is never touched here, which is what makes a "new" row's toggle page-local:
 * a toggle applied only to a page's returned `rows` (see `applyReviewSessionToggle()`)
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

/**
 * Finding folding: after a page is rebuilt from `allRows` (which keeps the originals), puts each
 * of `merged` back in place of its members when all of them are still on the page. A merged row
 * whose members were split across pages falls back to its originals. Pure.
 */
export function restoreMergedRows<TRow extends ReviewRowBase>(rows: TRow[], merged: TRow[]): TRow[] {
  return merged.reduce((acc, row) => {
    const ids = new Set(row.memberIds ?? [row.id]);
    const members = acc.filter(r => r.existingTicketKey === null && ids.has(r.id));
    if (members.length !== ids.size) return acc;
    return acc.flatMap(r => (r === members[0] ? [row] : members.includes(r) ? [] : [r]));
  }, rows);
}

/**
 * Finding folding: replaces the named visible New rows with one merged row. It keeps the
 * first member's id and position, lists every original id in `memberIds` (a member that is itself
 * merged contributes all of its originals) and starts included. `buildFields` supplies the
 * importer-specific fields from the members; identity and fold bookkeeping are set here so no
 * importer can get them wrong. Already-ticketed rows are never merged, even when named. Pure.
 */
export function mergeNewRows<TRow extends ReviewRowBase>(
  rows: TRow[],
  ids: string[],
  buildFields: (members: TRow[]) => Omit<TRow, keyof ReviewRowBase>,
): TRow[] {
  const wanted = new Set(ids);
  const members = rows.filter(r => r.existingTicketKey === null && wanted.has(r.id));
  if (members.length < 2) return rows;
  const merged = {
    ...buildFields(members),
    id: members[0].id,
    existingTicketKey: null,
    included: true,
    memberIds: members.flatMap(m => m.memberIds ?? [m.id]),
  } as unknown as TRow;
  const memberSet = new Set(members);
  return rows.flatMap(r => (r === members[0] ? [merged] : memberSet.has(r) ? [] : [r]));
}

/**
 * Finding folding: puts a merged row's original rows (still held, untouched, in `allRows`) back in
 * its place. A row that is not merged, or whose originals are missing, leaves `rows` unchanged. Pure.
 */
export function unmergeNewRow<TRow extends ReviewRowBase>(rows: TRow[], allRows: TRow[], id: string): TRow[] {
  const merged = rows.find(r => r.existingTicketKey === null && r.id === id && r.memberIds !== undefined);
  if (!merged) return rows;
  const originals = merged.memberIds!
    .map(memberId => allRows.find(a => a.existingTicketKey === null && a.id === memberId))
    .filter((r): r is TRow => r !== undefined);
  if (originals.length !== merged.memberIds!.length) return rows;
  return rows.flatMap(r => (r === merged ? originals : [r]));
}

/** The result groups that have at least one row — the basis of the overview (evaluated once, at build). */
export function computeImportResultGroups<TRow extends ReviewRowBase>(
  allRows: TRow[],
  stale?: ReviewSessionStale,
): ImportResultGroup[] {
  const groups: ImportResultGroup[] = [];
  if (allRows.some(r => r.existingTicketKey === null)) groups.push('new');
  if (allRows.some(r => r.existingTicketKey !== null)) groups.push('ticketed');
  if (stale && (stale.groups.some(g => g.tickets.length > 0) || stale.ineligible.length > 0)) groups.push('stale');
  return groups;
}

/**
 * Fixes the session's groups, single-group flag and initial view once, when the session is
 * built. Exactly one group (or none) → that group opens directly with "Done" and there is no
 * overview; two or three → the overview comes first.
 */
export function initImportViewState<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
  const groups = computeImportResultGroups(session.allRows, session.staleTickets);
  const singleGroup = groups.length <= 1;
  const view: ImportReviewView = singleGroup ? (groups[0] ?? 'new') : 'overview';
  return { ...session, groups, singleGroup, view, outcomes: emptyImportOutcomes() };
}

/** Fills in view state for a session built without it (e.g. by a test or an older call site). */
export function ensureImportViewState<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
  if (session.view !== undefined && session.groups !== undefined && session.singleGroup !== undefined && session.outcomes !== undefined) {
    return session;
  }
  const initial = initImportViewState(session);
  return {
    ...session,
    view: session.view ?? initial.view,
    groups: session.groups ?? initial.groups,
    singleGroup: session.singleGroup ?? initial.singleGroup,
    outcomes: session.outcomes ?? initial.outcomes,
  };
}

/**
 * Sets `action` on one already-ticketed row (`target` = its id) or on every row (`'all'`).
 * Only unfinished rows that offer the action change; everything else (new rows, finished rows, rows
 * not offering it) is returned untouched. Pure — the handler applies it to `rows` and `allRows`.
 */
export function applyTicketedActionChange<TRow extends ReviewRowBase>(
  rows: TRow[],
  target: string | 'all',
  action: TicketedAction,
): TRow[] {
  return rows.map(r => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return r;
    if (target !== 'all' && r.id !== target) return r;
    if (!ticketedRowActions(r).allowedActions.includes(action)) return r;
    return { ...r, action };
  });
}

/** Rows shown per page on the chat's Stale and Already-ticketed screens. Fixed, not a setting. */
export const GROUP_PAGE_SIZE = 20;

/** Every row the Stale screen lists: eligible tickets, then the ones that cannot be closed. */
function staleRowCount(stale: ReviewSessionStale | undefined): number {
  if (!stale) return 0;
  return stale.groups.reduce((n, g) => n + g.tickets.length, 0) + stale.ineligible.length;
}

export function groupTotalPages(rowCount: number): number {
  return Math.max(1, Math.ceil(rowCount / GROUP_PAGE_SIZE));
}

/** The 0-based page `target` clamped to the pages `rowCount` rows fill. */
export function clampGroupPage(target: number, rowCount: number): number {
  return Math.min(Math.max(0, target), groupTotalPages(rowCount) - 1);
}

export function staleTotalPages(stale: ReviewSessionStale | undefined): number {
  return groupTotalPages(staleRowCount(stale));
}

/** The 0-based Stale page `target` clamped to the pages that exist. */
export function clampStalePage(target: number, stale: ReviewSessionStale | undefined): number {
  return clampGroupPage(target, staleRowCount(stale));
}

export function ticketedTotalPages<TRow extends ReviewRowBase>(allRows: TRow[]): number {
  return groupTotalPages(allRows.filter(r => r.existingTicketKey !== null).length);
}

/** The 0-based Already-ticketed page `target` clamped to the pages that exist. */
export function clampTicketedPage<TRow extends ReviewRowBase>(target: number, allRows: TRow[]): number {
  return clampGroupPage(target, allRows.filter(r => r.existingTicketKey !== null).length);
}

/** How many matching tickets one `search` reply lists. */
export const SEARCH_RESULT_LIMIT = 20;

export interface TicketSearchResult {
  key: string;
  /** Ids of the Already-ticketed rows whose main ticket this is; empty for an extra open ticket of a row. */
  ids: string[];
  status: string | null;
  summary: string;
}

export type TicketSearchOutcome =
  | { kind: 'usage' }
  | { kind: 'no-info' }
  | { kind: 'results'; results: TicketSearchResult[]; total: number };

/** A row that finished as a ticket merge: its ticket is closed in Jira though the row's target still reads unresolved. */
function isFinishedMerge(row: ReviewRowBase): boolean {
  return row.result?.status === 'done' && row.result.action === 'merge';
}

/**
 * The open tickets of the Already-ticketed rows whose summary contains every word of `keyword` (case-insensitive,
 * each word as a substring). A ticket is listed once, in the order its first row appears, with the ids of the rows it
 * is the main ticket of; an extra open ticket of a row carries no id, because an id resolves to its row's main ticket only.
 */
export function findTicketsBySummary(rows: ReviewRowBase[], ticketInfo: TicketInfo | undefined, keyword: string): TicketSearchOutcome {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: 'usage' };
  if (!ticketInfo) return { kind: 'no-info' };

  const byKey = new Map<string, { ids: string[] }>();
  const note = (key: string, rowId: string | null) => {
    const entry = byKey.get(key) ?? { ids: [] };
    if (rowId !== null && !entry.ids.includes(rowId)) entry.ids.push(rowId);
    byKey.set(key, entry);
  };
  for (const row of rows) {
    if (row.existingTicketKey === null || isFinishedMerge(row)) continue;
    if (row.target && !row.target.resolved) note(row.target.key, row.id);
    for (const key of row.openTicketKeys ?? []) note(key, null);
  }

  const matches: TicketSearchResult[] = [];
  for (const [key, { ids }] of byKey) {
    const info = ticketInfo[key];
    if (!info) continue;
    const summary = info.summary.toLowerCase();
    if (words.every(w => summary.includes(w))) matches.push({ key, ids, status: info.status, summary: info.summary });
  }
  return { kind: 'results', results: matches.slice(0, SEARCH_RESULT_LIMIT), total: matches.length };
}
