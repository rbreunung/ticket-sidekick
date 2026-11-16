import type { ExportedFile } from '../../sessions/boardKind';
import { findTicketsBySummary } from '../../imports/rows';
import { buildOverview, localDate, type Overview, type ReportOnlyItem } from '../../utils/securityOverview';
import { renderOverviewCsv, resolveCsvDelimiter } from '../../utils/securityOverviewCsv';
import { renderOverviewXlsx } from '../../utils/securityOverviewXlsx';
import type { TicketFinding } from '../../utils/veracodeFindingsTable';
import type { TicketComponent } from '../../utils/waltzComponentsTable';
import { descriptorOf, type ImportHandler, type ImportSession } from './handlers';
import type { ImportDeps } from './read';

// The import board's handler for search over the matched tickets, the overview export and the finished state. vscode-free.

const NAME = 'search-export';
const MAX_QUERY = 200;

const FINISHED_MESSAGE = 'Nothing left to do: every tab of this import is handled. You can still save the overview, or close the import.';
const EMAIL_FINISHED_MESSAGE = 'Nothing left to do: every email of this import has a ticket or a comment, or is left out. Close the import when you are done.';

interface SearchState {
  query: string;
}

export interface SearchResultView {
  key: string;
  summary: string;
  status: string | null;
  url: string | null;
}

export interface SearchView {
  query: string;
  total: number;
  results: SearchResultView[];
  /** A line instead of results, when there are none. */
  message?: string;
}

export interface SearchExportView {
  /** The search over the matched tickets; null while there is none. */
  search: SearchView | null;
  /** Shown when no tab has work left. */
  finishedMessage: string;
}

function stateOf(session: ImportSession): SearchState | undefined {
  const state = session.working.ext[NAME] as SearchState | undefined;
  return state && typeof state.query === 'string' ? state : undefined;
}

/** The ticket's browse link, or null without a base URL. */
export function browseUrl(baseUrl: string | undefined, key: string): string | null {
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}` : null;
}

function searchView(session: ImportSession, query: string): SearchView {
  const { data } = session.derived;
  const outcome = findTicketsBySummary(data.review.allRows, data.review.ticketInfo, query);
  if (outcome.kind === 'no-info') {
    return { query, total: 0, results: [], message: 'This import holds no ticket summaries to search. Refresh to read them again.' };
  }
  if (outcome.kind === 'usage') return { query, total: 0, results: [] };
  const results = outcome.results.map(r => ({ key: r.key, summary: r.summary, status: r.status, url: browseUrl(data.baseUrl, r.key) }));
  const view: SearchView = { query, total: outcome.total, results };
  if (outcome.total === 0) view.message = `No open ticket of this import has a summary containing "${query}".`;
  else if (outcome.total > results.length) view.message = `${outcome.total - results.length} more match. Narrow the search to see them.`;
  return view;
}

/** The report's records for one ticket: the findings or components of every row that points to it, each once. */
function mergeDetail(into: { findings?: TicketFinding[]; components?: TicketComponent[] }, from: { findings?: TicketFinding[]; components?: TicketComponent[] }): void {
  if (from.findings) {
    const seen = new Set((into.findings ??= []).map(f => f.issueId));
    for (const f of from.findings) if (!seen.has(f.issueId)) into.findings.push(f);
  }
  if (from.components) {
    const seen = new Set((into.components ??= []).map(c => c.nameVersion));
    for (const c of from.components) if (!seen.has(c.nameVersion)) into.components.push(c);
  }
}

/**
 * The overview of this one report, over the reading the board shows: the
 * open targets of the Already-ticketed rows are tracked, the stale tickets not closed from the board are stale, and the
 * other rows are the report's items with no open ticket.
 */
function overviewOf(session: ImportSession, deps: ImportDeps): Overview {
  const { recipe, working } = session;
  const { data } = session.derived;
  const descriptor = descriptorOf(session, deps);
  const exporter = descriptor.overviewExport;
  if (!exporter) throw new Error('Export is not available for this import.');

  const matchByKey: Record<string, 'tracked' | 'stale'> = {};
  const detailByKey: Record<string, { findings?: TicketFinding[]; components?: TicketComponent[] }> = {};
  const reportOnly: ReportOnlyItem[] = [];
  for (const row of data.review.allRows) {
    if (row.target && !row.target.resolved) {
      matchByKey[row.target.key] = 'tracked';
      mergeDetail(detailByKey[row.target.key] ??= {}, exporter.detailOf(row));
    } else {
      reportOnly.push({ source: exporter.source, summary: exporter.summaryOf(row), dueDate: exporter.dueDateOf(row), ...exporter.detailOf(row) });
    }
  }
  const stale = data.review.staleTickets;
  const staleKeys = [
    ...(stale?.groups.flatMap(g => g.tickets.map(t => t.key)) ?? []),
    ...(stale?.ineligible.map(t => t.key) ?? []),
  ].filter(key => !(stale?.closedKeys ?? []).includes(key) && working.writes.tickets[key] === undefined);
  for (const key of staleKeys) matchByKey[key] ??= 'stale';

  return buildOverview({
    tickets: data.export.tickets.filter(t => t.key in matchByKey),
    descriptions: data.export.descriptions,
    versions: data.export.versions,
    today: localDate(new Date(deps.now())),
    baseUrl: data.baseUrl,
    projectKey: recipe.projectKey,
    report: { matchByKey, reportOnly, detailByKey },
  });
}

async function exportOverview(session: ImportSession, format: 'csv' | 'xlsx', deps: ImportDeps): Promise<ExportedFile> {
  const problem = session.derived.data.export.ticketsProblem;
  if (problem) throw new Error(`The overview cannot be saved, because the tickets could not be read with the review: ${problem}`);
  const overview = overviewOf(session, deps);
  const base = `security-overview-${session.recipe.kind}-${localDate(new Date(deps.now()))}`;
  if (format === 'xlsx') return { fileName: `${base}.xlsx`, filterName: 'Excel', extension: 'xlsx', bytes: await renderOverviewXlsx(overview) };
  // The board has no delimiter setting of its own yet, so the CSV uses the default.
  return { fileName: `${base}.csv`, filterName: 'CSV', extension: 'csv', bytes: new TextEncoder().encode(renderOverviewCsv(overview, deps.csvDelimiter?.() ?? resolveCsvDelimiter(undefined))) };
}

export const searchExportHandler: ImportHandler = {
  name: NAME,

  reduce: (session, action) => {
    if (action.type !== 'search') return undefined;
    if (typeof action.query !== 'string' || action.query.length > MAX_QUERY) {
      return { ok: false, reason: `A search is text of at most ${MAX_QUERY} characters.` };
    }
    const query = action.query.trim();
    const ext = { ...session.working.ext };
    if (query) ext[NAME] = { query } satisfies SearchState;
    else delete ext[NAME];
    return { ok: true, working: { ...session.working, ext } };
  },

  exportFile: (session, format, deps) => {
    if (format !== 'csv' && format !== 'xlsx') return undefined;
    return exportOverview(session, format, deps);
  },

  view: (session): SearchExportView => {
    const state = stateOf(session);
    return { search: state ? searchView(session, state.query) : null, finishedMessage: session.recipe.kind === 'email' ? EMAIL_FINISHED_MESSAGE : FINISHED_MESSAGE };
  },
};
