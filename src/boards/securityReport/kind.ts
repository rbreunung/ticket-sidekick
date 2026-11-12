import type { BoardKind } from '../../sessions/boardKind';
import type { Session } from '../../sessions/sessionTypes';
import type { TicketService } from '../../services/TicketService';
import { normalizeProjectKey } from '../../services/configValidation';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import { buildOverview, type Overview, type OverviewFlag, type OverviewInput, type OverviewRow, type OverviewSource } from '../../utils/securityOverview';
import { renderOverviewCsv } from '../../utils/securityOverviewCsv';
import { renderOverviewXlsx } from '../../utils/securityOverviewXlsx';

// The security report as a board kind: a project's unresolved Veracode and Waltz tickets by Fix
// Version. It has no writes. Its derived data is the Jira reading the report is built from; its
// working state is the filters and the sort, kept so a restored report looks as it was left.

export const SECURITY_REPORT_KIND = 'security-report';

export interface SecurityReportRecipe {
  project: string;
}

export interface SecurityReportData {
  input: OverviewInput;
  /** More tickets matched than were read. */
  truncated: boolean;
  /** The release dates could not be read, so nothing is flagged as due before its release. */
  versionsFailed: boolean;
}

export type FlagFilter = 'overdue' | 'due-before-release' | 'none';
export type SortColumn = 'source' | 'summary' | 'rating' | 'ticket' | 'due' | 'flag';

export interface SecurityReportWorking {
  /** A Fix Version name, or '' for the tickets not assigned to a release. */
  release: string | null;
  flag: FlagFilter | null;
  tool: OverviewSource | null;
  sort: { column: SortColumn; descending: boolean } | null;
}

export type SecurityReportAction =
  | { type: 'filter'; release?: string | null; flag?: FlagFilter | null; tool?: OverviewSource | null }
  | { type: 'sort'; column: SortColumn }
  | { type: 'clear' };

export interface SecurityReportDeps {
  /** The ticket service and base URL when Jira is set up in this window. */
  jira(): Promise<{ ticketService: TicketService; baseUrl: string } | undefined>;
  /** `ticketSidekick.jira.defaultProject`, possibly empty. */
  defaultProject(): string;
  csvDelimiter(): string;
  /** Today as `YYYY-MM-DD` in local time. */
  today(): string;
  now(): number;
  onDiag?: DiagLogger;
}

export interface ReportRowView {
  source: OverviewSource;
  summary: string;
  rating: string;
  ticketKey: string | null;
  ticketUrl: string | null;
  status: string | null;
  dueDate: string | null;
  flag: OverviewFlag;
}

export interface ReportTableView {
  fixVersion: string | null;
  releaseDate: string | null;
  jiraUrl: string | null;
  tickets: number;
  overdue: number;
  dueBeforeRelease: number;
  noDueDate: number;
  rows: ReportRowView[];
}

export interface SecurityReportView {
  project: string;
  /** Tickets in the full report and in the rows shown under the filters. */
  totalTickets: number;
  shownTickets: number;
  bySource: Record<OverviewSource, number>;
  unreadCount: number;
  warnings: string[];
  /** The releases the filter offers; '' stands for "not assigned". */
  releases: string[];
  filters: Pick<SecurityReportWorking, 'release' | 'flag' | 'tool'>;
  sort: SecurityReportWorking['sort'];
  tables: ReportTableView[];
}

const SORT_COLUMNS: readonly SortColumn[] = ['source', 'summary', 'rating', 'ticket', 'due', 'flag'];
const FLAG_FILTERS: readonly FlagFilter[] = ['overdue', 'due-before-release', 'none'];
const NO_FILTERS: SecurityReportWorking = { release: null, flag: null, tool: null, sort: null };

function overviewOf(data: SecurityReportData): Overview {
  return buildOverview(data.input);
}

function sortValue(row: OverviewRow, column: SortColumn): string {
  switch (column) {
    case 'source': return row.source;
    case 'summary': return row.summary.toLowerCase();
    case 'rating': return row.rating.toLowerCase();
    case 'ticket': return row.ticketKey ?? '';
    case 'due': return row.dueDate ?? '9999-99-99';
    case 'flag': return row.flag === 'overdue' ? '0' : row.flag === 'due-before-release' ? '1' : '2';
  }
}

function keepsRow(row: OverviewRow, working: SecurityReportWorking): boolean {
  if (working.tool && row.source !== working.tool) return false;
  if (working.flag === 'none' && row.flag !== null) return false;
  if (working.flag && working.flag !== 'none' && row.flag !== working.flag) return false;
  return true;
}

export function buildReportView(session: Session<SecurityReportRecipe, SecurityReportData, SecurityReportWorking>): SecurityReportView {
  const { data } = session.derived;
  const working = session.working;
  const overview = overviewOf(data);
  const baseUrl = data.input.baseUrl?.replace(/\/+$/, '');
  const warnings: string[] = [];
  if (data.truncated) warnings.push(`More tickets matched than can be listed; showing the first ${data.input.tickets.length}.`);
  if (data.versionsFailed) warnings.push('The release dates could not be read, so nothing is flagged as due before its release.');
  if (overview.unreadCount > 0) warnings.push(`${overview.unreadCount} ticket description(s) could not be read; their detail comes from the title and labels.`);

  const tables: ReportTableView[] = [];
  let shown = 0;
  for (const table of overview.tables) {
    if (working.release !== null && (table.fixVersion ?? '') !== working.release) continue;
    let rows = table.rows.filter(row => keepsRow(row, working));
    if (working.sort) {
      const { column, descending } = working.sort;
      rows = [...rows].sort((a, b) => sortValue(a, column).localeCompare(sortValue(b, column)) * (descending ? -1 : 1));
    }
    shown += new Set(rows.map(r => r.ticketKey).filter(Boolean)).size;
    tables.push({
      fixVersion: table.fixVersion, releaseDate: table.releaseDate, jiraUrl: table.jira?.url ?? null,
      tickets: table.counts.tickets, overdue: table.counts.overdue, dueBeforeRelease: table.counts.dueBeforeRelease, noDueDate: table.counts.noDueDate,
      rows: rows.map(row => ({
        source: row.source, summary: row.summary, rating: row.rating, ticketKey: row.ticketKey,
        ticketUrl: row.ticketKey && baseUrl ? `${baseUrl}/browse/${encodeURIComponent(row.ticketKey)}` : null,
        status: row.status, dueDate: row.dueDate, flag: row.flag,
      })),
    });
  }
  return {
    project: session.recipe.project, totalTickets: overview.ticketCount, shownTickets: shown, bySource: overview.bySource,
    unreadCount: overview.unreadCount, warnings, releases: overview.tables.map(t => t.fixVersion ?? ''),
    filters: { release: working.release, flag: working.flag, tool: working.tool }, sort: working.sort, tables,
  };
}

export const securityReportKind: BoardKind<
  SecurityReportRecipe, SecurityReportData, SecurityReportWorking, SecurityReportAction, SecurityReportView, SecurityReportDeps
> = {
  kind: SECURITY_REPORT_KIND,
  formatVersion: 1,
  title: recipe => `Security report: ${recipe.project}`,

  // A named project is used as named: one that is not a project key is refused, never swapped
  // for the default project, so the report shown is always the one asked for.
  validate: async (input, deps) => {
    const raw = typeof input === 'object' && input !== null ? (input as { project?: unknown }).project : undefined;
    const named = typeof raw === 'string' && raw.trim() !== '';
    const project = normalizeProjectKey(named ? (raw as string) : deps.defaultProject());
    if (named && !project) {
      return { ok: false, reason: 'the project named is not a Jira project key. Ask again with a key such as PROJ.' };
    }
    if (!project) {
      return { ok: false, reason: 'no project was named and ticketSidekick.jira.defaultProject is not set. Ask again with a project key, for example "security report for PROJ".' };
    }
    if (!(await deps.jira())) return { ok: false, reason: 'Jira is not set up in that window\'s Ticket Sidekick settings.' };
    return { ok: true, recipe: { project } };
  },

  sourceKey: recipe => recipe.project,
  sourceLabel: recipe => `Jira project ${recipe.project}`,
  initialWorking: () => ({ ...NO_FILTERS }),

  read: async (recipe, deps) => {
    const jira = await deps.jira();
    if (!jira) throw new Error('Jira is not set up in this window.');
    const { ticketService, baseUrl } = jira;
    let list;
    try {
      list = await ticketService.listOverviewTickets(recipe.project);
    } catch (err) {
      deps.onDiag?.('error', 'Security report search failed', { projectKey: recipe.project, error: err instanceof Error ? err.message : String(err) });
      // Status and a short reason only; Jira's response body never reaches the page.
      throw new Error(describeJiraFailure(err));
    }
    let versions: OverviewInput['versions'] = [];
    let versionsFailed = false;
    try {
      versions = await ticketService.getProjectVersions(recipe.project);
    } catch (err) {
      versionsFailed = true;
      deps.onDiag?.('warn', 'Could not read the project versions', { projectKey: recipe.project, error: err instanceof Error ? err.message : String(err) });
    }
    const { texts } = await ticketService.readDescriptions(
      list.tickets.map(t => t.key),
      (key, err) => deps.onDiag?.('warn', `Could not read the description of ${key}`, { issueKey: key, error: err instanceof Error ? err.message : String(err) }),
    );
    return {
      readAt: deps.now(),
      fingerprints: {},
      data: {
        input: { tickets: list.tickets, descriptions: texts, versions, today: deps.today(), baseUrl, projectKey: recipe.project },
        truncated: list.truncated,
        versionsFailed,
      },
    };
  },

  // A report has no choices that can clash with Jira; only a filter on a release that is gone is cleared.
  reconcile: (session, fresh) => {
    const releases = new Set(overviewOf(fresh.data).tables.map(t => t.fixVersion ?? ''));
    const release = session.working.release !== null && releases.has(session.working.release) ? session.working.release : null;
    return { derived: fresh, working: { ...session.working, release }, conflicts: [] };
  },

  reduce: (session, action) => {
    const working = session.working;
    if (action?.type === 'clear') return { ok: true, working: { ...NO_FILTERS } };
    if (action?.type === 'sort') {
      if (!SORT_COLUMNS.includes(action.column)) return { ok: false, reason: 'Unknown column.' };
      // A second click on the same column turns the order around; a third takes the sort off.
      const current = working.sort?.column === action.column ? working.sort : null;
      const sort = !current ? { column: action.column, descending: false } : current.descending ? null : { column: action.column, descending: true };
      return { ok: true, working: { ...working, sort } };
    }
    if (action?.type === 'filter') {
      const next = { ...working };
      if ('release' in action) {
        if (action.release !== null && typeof action.release !== 'string') return { ok: false, reason: 'Unknown release.' };
        next.release = action.release ?? null;
      }
      if ('flag' in action) {
        if (action.flag !== null && !FLAG_FILTERS.includes(action.flag as FlagFilter)) return { ok: false, reason: 'Unknown flag.' };
        next.flag = action.flag ?? null;
      }
      if ('tool' in action) {
        if (action.tool !== null && action.tool !== 'veracode' && action.tool !== 'waltz') return { ok: false, reason: 'Unknown tool.' };
        next.tool = action.tool ?? null;
      }
      return { ok: true, working: next };
    }
    return { ok: false, reason: 'Unknown action.' };
  },

  // Always the full report of the reading shown, whatever the filters.
  exportFile: async (session, format, deps) => {
    const overview = overviewOf(session.derived.data);
    const base = `security-overview-${session.recipe.project}-${deps.today()}`;
    if (format === 'xlsx') return { fileName: `${base}.xlsx`, filterName: 'Excel', extension: 'xlsx', bytes: await renderOverviewXlsx(overview) };
    if (format === 'csv') {
      return { fileName: `${base}.csv`, filterName: 'CSV', extension: 'csv', bytes: new TextEncoder().encode(renderOverviewCsv(overview, deps.csvDelimiter())) };
    }
    throw new Error('Unknown file format.');
  },

  view: buildReportView,
};
