import { CanvasRequestError, readJson, sendJson, type CanvasRoute } from '../canvasRoutes';
import { PageStore } from './pageStore';
import { TicketService } from '../../services/TicketService';
import { normalizeProjectKey, validateBaseUrl } from '../../services/configValidation';
import type { JiraAccess } from '../../mcp/jiraTools/jiraAccess';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import { buildOverview, type Overview, type OverviewCounts, type OverviewFlag, type OverviewFormat } from '../../utils/securityOverview';
import { gatherOverview, overviewWarningText } from '../../utils/securityOverviewGather';

// The routes the security report page talks to, under the canvas key: the report (a fresh Jira
// reading, kept for the page's Save), the save (VS Code's save dialog, writing the reading the page
// shows) and the page status (replaced by a newer page, and the current theme). Report data goes
// only to the page and, through the developer's own Save, to a file; logs carry counts, never text.

export const REPORT_PATH = '/api/report';
export const SAVE_PATH = '/api/save';
export const PAGE_STATUS_PATH = '/api/page-status';

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

/** What a save came to; the same outcomes the chat's save reports. */
export type SaveOutcome =
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

export interface ReportApiDeps {
  getJira(): Promise<JiraAccess>;
  /** `ticketSidekick.jira.defaultProject` of this window, possibly empty. */
  defaultProject(): string;
  themeKind(): ThemeKind;
  /** Opens VS Code's save dialog and writes the overview; the chat's save without its chat text. */
  save(overview: Overview, project: string, format: OverviewFormat): Promise<SaveOutcome>;
  store: PageStore;
  onDiag?: DiagLogger;
}

/** One row as the page shows it; every text is Jira text, which the page inserts only as text. */
export interface PageRow {
  source: 'veracode' | 'waltz';
  summary: string;
  otherFixVersions: string[];
  rating: string;
  ticketKey: string | null;
  /** A link to the ticket in Jira, only for a well-formed key and an http(s) base URL. */
  ticketUrl: string | null;
  status: string | null;
  dueDate: string | null;
  flag: OverviewFlag;
}

export interface PageTable {
  /** Null for the Not assigned table. */
  fixVersion: string | null;
  releaseDate: string | null;
  counts: OverviewCounts;
  noTicket: number;
  jira: { url: string; tickets: number; fellBack: boolean } | null;
  rows: PageRow[];
}

export interface PageReport {
  pageId: string;
  project: string;
  /** When Jira was read, as an ISO time. */
  readAt: string;
  themeKind: ThemeKind;
  warnings: string[];
  ticketCount: number;
  bySource: { veracode: number; waltz: number };
  unreadCount: number;
  tables: PageTable[];
}

/** Why a report could not be built, for the page to show. */
export type ReportErrorKind = 'no-project' | 'invalid-project' | 'not-configured' | 'jira';

export const REPORT_ERRORS: Record<Exclude<ReportErrorKind, 'jira'>, string> = {
  'no-project': 'No project was named and ticketSidekick.jira.defaultProject is not set. Name a project in the chat, for example "security report for PROJ".',
  'invalid-project': 'The project named is not a Jira project key.',
  'not-configured': 'Jira is not set up in this window\'s Ticket Sidekick settings.',
};

export const SAVE_TEXTS = {
  refreshFirst: 'This reading is no longer held. Press Refresh, then save again.',
  replaced: 'A newer report for this project is open; save from that page.',
} as const;

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** The base URL for links, only when it is a well-formed http(s) URL, without a trailing slash. */
function linkBase(baseUrl: string | undefined): string | undefined {
  if (!baseUrl || validateBaseUrl(baseUrl) !== null) return undefined;
  return baseUrl.replace(/\/+$/, '');
}

/** The overview in the shape the page renders. */
export function toPageReport(
  overview: Overview,
  meta: { pageId: string; project: string; readAt: Date; themeKind: ThemeKind; warnings: string[]; baseUrl?: string },
): PageReport {
  const base = linkBase(meta.baseUrl);
  return {
    pageId: meta.pageId,
    project: meta.project,
    readAt: meta.readAt.toISOString(),
    themeKind: meta.themeKind,
    warnings: meta.warnings,
    ticketCount: overview.ticketCount,
    bySource: { ...overview.bySource },
    unreadCount: overview.unreadCount,
    tables: overview.tables.map(table => ({
      fixVersion: table.fixVersion,
      releaseDate: table.releaseDate,
      counts: { ...table.counts },
      noTicket: table.noTicket,
      jira: table.jira?.url && base && table.jira.url.startsWith(`${base}/`)
        ? { url: table.jira.url, tickets: table.counts.tickets, fellBack: table.jira.fellBack }
        : null,
      rows: table.rows.map(row => ({
        source: row.source,
        summary: row.summary,
        otherFixVersions: [...row.otherFixVersions],
        rating: row.rating,
        ticketKey: row.ticketKey,
        ticketUrl: base && row.ticketKey && ISSUE_KEY.test(row.ticketKey) ? `${base}/browse/${row.ticketKey}` : null,
        status: row.status,
        dueDate: row.dueDate,
        flag: row.flag,
      })),
    })),
  };
}

function bodyField(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function optionalString(body: unknown, name: string): string | undefined {
  const value = bodyField(body, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CanvasRequestError(400, `${name} must be text.`);
  return value;
}

export function reportRoutes(deps: ReportApiDeps): CanvasRoute[] {
  const log = deps.onDiag ?? (() => undefined);

  const report: CanvasRoute = {
    method: 'POST',
    path: REPORT_PATH,
    handle: async (req, res) => {
      const body = await readJson(req);
      const asked = optionalString(body, 'project')?.trim() ?? '';
      const previousPageId = optionalString(body, 'previousPageId');
      let project: string | undefined;
      if (asked) {
        project = normalizeProjectKey(asked);
        if (!project) return sendJson(res, 400, { error: REPORT_ERRORS['invalid-project'], kind: 'invalid-project' });
      } else {
        project = normalizeProjectKey(deps.defaultProject());
        if (!project) return sendJson(res, 400, { error: REPORT_ERRORS['no-project'], kind: 'no-project' });
      }
      const jira = await deps.getJira();
      if (!jira.configured) return sendJson(res, 409, { error: REPORT_ERRORS['not-configured'], kind: 'not-configured' });

      const started = Date.now();
      const result = await gatherOverview(new TicketService(jira.client), project, jira.config.baseUrl, log);
      if (!result.ok) {
        const reason = describeJiraFailure(result.error);
        log('warn', 'Security report: Jira could not be read', { project, ms: Date.now() - started });
        return sendJson(res, 502, { error: `Could not read Jira. ${reason}`, kind: 'jira' });
      }
      const overview = buildOverview(result.input);
      const { pageId, replaced } = deps.store.add(project, overview, previousPageId);
      const reading = deps.store.get(pageId)!;
      log('info', 'Security report read', { project, tickets: overview.ticketCount, tables: overview.tables.length, ms: Date.now() - started, replacedPages: replaced.length });
      sendJson(res, 200, toPageReport(overview, {
        pageId, project, readAt: reading.readAt, themeKind: deps.themeKind(),
        warnings: result.warnings.map(overviewWarningText), baseUrl: jira.config.baseUrl,
      }));
    },
  };

  const save: CanvasRoute = {
    method: 'POST',
    path: SAVE_PATH,
    handle: async (req, res) => {
      const body = await readJson(req);
      const pageId = optionalString(body, 'pageId') ?? '';
      const format = bodyField(body, 'format');
      if (format !== 'csv' && format !== 'xlsx') throw new CanvasRequestError(400, 'format must be csv or xlsx.');
      if (deps.store.state(pageId) === 'replaced') return sendJson(res, 409, { outcome: 'replaced', message: SAVE_TEXTS.replaced });
      const reading = deps.store.get(pageId);
      if (!reading) return sendJson(res, 409, { outcome: 'refresh-first', message: SAVE_TEXTS.refreshFirst });
      const outcome = await deps.save(reading.overview, reading.project, format);
      log(outcome.kind === 'failed' ? 'warn' : 'info', `Security report save: ${outcome.kind}`, { project: reading.project, format });
      if (outcome.kind === 'saved') return sendJson(res, 200, { outcome: 'saved', path: outcome.path });
      if (outcome.kind === 'cancelled') return sendJson(res, 200, { outcome: 'cancelled' });
      sendJson(res, 200, { outcome: 'failed', reason: outcome.reason });
    },
  };

  const status: CanvasRoute = {
    method: 'GET',
    path: PAGE_STATUS_PATH,
    handle: async (_req, res, ctx) => {
      const pageId = ctx.query.get('pageId') ?? '';
      sendJson(res, 200, { replaced: deps.store.state(pageId) === 'replaced', themeKind: deps.themeKind() });
    },
  };

  return [report, save, status];
}
