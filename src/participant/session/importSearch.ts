// Report-import ticket search: the `search <keyword>` reply lists the open tickets the review already matched whose
// summary contains the keyword. Pure (vscode-free); no Jira call is made here.

import { formatKeyLink } from '../../services/TicketService';
import { IMPORT_COMMANDS } from './importScreens';
import { ReviewRowBase } from './importTypes';
import { neutralizeMarkdownLinks } from './primitives';

/** How many matching tickets one `search` reply lists. */
export const SEARCH_RESULT_LIMIT = 20;

/** Summary and build-time status of the tickets the dedup search matched, by key (`ReviewSession.ticketInfo`). */
export type TicketInfoMap = Record<string, { summary: string; status: string | null }>;

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
export function findTicketsBySummary(rows: ReviewRowBase[], ticketInfo: TicketInfoMap | undefined, keyword: string): TicketSearchOutcome {
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

/** The chat text for a search outcome. Summaries are untrusted Jira text: markdown link syntax is neutralized. */
export function buildSearchResults(outcome: TicketSearchOutcome, keyword: string, baseUrl?: string): string {
  if (outcome.kind === 'usage') return 'Search the matched tickets like this: `search <keyword>` (a class or component name, for example).';
  if (outcome.kind === 'no-info') {
    return `_This review holds no ticket summaries to search (it was saved by an older version). Reply \`${IMPORT_COMMANDS.reload}\` to read them again._`;
  }
  const shown = neutralizeMarkdownLinks(keyword.trim());
  if (outcome.results.length === 0) return `No open tickets in this review have a summary containing “${shown}”.`;
  const lines = outcome.results.map(r => {
    const ids = r.ids.length > 0 ? `${r.ids.join(', ')} · ` : '';
    const status = r.status ? ` · ${neutralizeMarkdownLinks(r.status)}` : '';
    return `- ${ids}${formatKeyLink(r.key, baseUrl)}${status} · ${neutralizeMarkdownLinks(r.summary)}`;
  });
  const more = outcome.total > outcome.results.length ? `\n\n_${outcome.total - outcome.results.length} more match — narrow the keyword to see them._` : '';
  const plural = outcome.total === 1 ? 'ticket' : 'tickets';
  return `**${outcome.total} open ${plural} with a summary containing “${shown}”:**\n\n${lines.join('\n')}${more}`;
}
