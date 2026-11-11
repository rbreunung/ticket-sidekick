import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { LocalhostServer } from '../mcp/localhostServer';
import { generateKey } from '../mcp/keys';
import { createCanvasHandler } from '../canvas/canvasRoutes';
import { PageStore } from '../canvas/securityReport/pageStore';
import { REPORT_ERRORS, reportRoutes, SAVE_TEXTS, type PageReport, type ReportApiDeps, type SaveOutcome } from '../canvas/securityReport/reportApi';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeComponent, makeFlaw, seedOverviewJira, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';
import { buildOverview, type Overview, type OverviewFormat } from '../utils/securityOverview';
import { gatherOverview } from '../utils/securityOverviewGather';
import { renderOverviewCsv } from '../utils/securityOverviewCsv';
import { JiraApiError } from '../utils/apiError';

// The security report page's routes over a real loopback socket, with a mock Jira: the report,
// the save of the reading the page shows, and the replaced-page status.

const BASE_URL = 'https://jira.example.com';
let server: LocalhostServer | undefined;
let client: MockJiraClient;

const tickets = [
  veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
  waltzTicket('SEC-2', [makeComponent('netty-codec:4.1.100')], { fixVersions: ['2026.11'] }),
  veracodeTicket('SEC-3', [makeFlaw('3', { line: 3 })], { dueDate: '2026-10-01' }),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  client = new MockJiraClient();
  seedOverviewJira(client, tickets);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
});

interface Harness {
  port: number;
  key: string;
  saves: Array<{ overview: Overview; project: string; format: OverviewFormat }>;
  logs: Array<{ message: string; details?: Record<string, unknown> }>;
  store: PageStore;
}

async function start(opts: { configured?: boolean; defaultProject?: string; saveOutcome?: SaveOutcome } = {}): Promise<Harness> {
  const saves: Harness['saves'] = [];
  const logs: Harness['logs'] = [];
  const store = new PageStore();
  const deps: ReportApiDeps = {
    getJira: async () => (opts.configured === false
      ? { configured: false, config: {} as never }
      : { configured: true, config: { baseUrl: BASE_URL, token: 't', authType: 'datacenter' } as never, client }),
    defaultProject: () => opts.defaultProject ?? '',
    themeKind: () => 'dark',
    save: async (overview, project, format) => { saves.push({ overview, project, format }); return opts.saveOutcome ?? { kind: 'saved', path: '/work/security-overview-SEC.csv' }; },
    store,
    onDiag: (_level, message, details) => logs.push({ message, details }),
  };
  server = new LocalhostServer({ onMcp: async (_req, res) => { res.end(); }, onCanvas: createCanvasHandler(reportRoutes(deps)) });
  const key = generateKey();
  const port = await server.start(generateKey(), key);
  return { port, key, saves, logs, store };
}

function call(h: Harness, method: 'GET' | 'POST', path: string, body?: unknown, contentType = 'application/json') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path: `/${h.key}${path}`, method, headers: body === undefined ? {} : { 'Content-Type': contentType } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const readReport = (h: Harness, body: unknown = { project: 'SEC' }) => call(h, 'POST', '/api/report', body);

async function expectedOverview(): Promise<Overview> {
  const result = await gatherOverview(new TicketService(client), 'SEC', BASE_URL);
  if (!result.ok) throw new Error('expected a reading');
  return buildOverview(result.input);
}

describe('the report route', () => {
  it('returns the overview @jira builds for the project, with the read time, theme and a page id', async () => {
    const h = await start();
    const res = await readReport(h);
    expect(res.status).toBe(200);
    const report = res.body as PageReport;
    const expected = await expectedOverview();
    expect(report).toMatchObject({ project: 'SEC', readAt: '2026-10-15T12:00:00.000Z', themeKind: 'dark', warnings: [], ticketCount: 3, bySource: { veracode: 2, waltz: 1 } });
    expect(report.pageId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(report.tables.map(t => t.fixVersion)).toEqual(expected.tables.map(t => t.fixVersion));
    expect(report.tables.flatMap(t => t.rows.map(r => r.ticketKey))).toEqual(expected.tables.flatMap(t => t.rows.map(r => r.ticketKey)));
    expect(report.tables[0].rows[0].ticketUrl).toBe(`${BASE_URL}/browse/${report.tables[0].rows[0].ticketKey}`);
    expect(report.tables[0].jira?.url).toMatch(new RegExp(`^${BASE_URL}/`));
  });

  it('logs the reading with counts and never ticket text', async () => {
    const h = await start();
    await readReport(h);
    expect(h.logs.map(l => l.message)).toContain('Security report read');
    expect(JSON.stringify(h.logs)).not.toContain(tickets[0].ticket.summary);
  });

  it('carries the warnings the chat shows, word for word', async () => {
    const h = await start();
    vi.spyOn(client, 'getProject').mockRejectedValue(new Error('boom'));
    const report = (await readReport(h)).body as PageReport;
    expect(report.warnings).toEqual(['Warning: could not read the release dates, so nothing is flagged as due before its release.']);
  });

  it('uses the default project when the page names none, and refuses when neither is set', async () => {
    const withDefault = await start({ defaultProject: 'sec' });
    expect((await readReport(withDefault, {})).body.project).toBe('SEC');
    await server!.stop();
    const without = await start();
    expect(await readReport(without, {})).toEqual({ status: 400, body: { error: REPORT_ERRORS['no-project'], kind: 'no-project' } });
  });

  it('refuses a project that is not a project key instead of reading the default project', async () => {
    const h = await start({ defaultProject: 'SEC' });
    expect((await readReport(h, { project: 'SEC-1' })).body.kind).toBe('invalid-project');
  });

  it('says when Jira is not set up in this window', async () => {
    const h = await start({ configured: false });
    expect(await readReport(h)).toEqual({ status: 409, body: { error: REPORT_ERRORS['not-configured'], kind: 'not-configured' } });
  });

  it('answers a Jira failure with the HTTP status and none of Jira\'s response body', async () => {
    const h = await start();
    vi.spyOn(client, 'searchJql').mockRejectedValue(new JiraApiError('Jira API error 503: <html>maintenance page</html>', 503, `${BASE_URL}/rest/api/2/search`, '<html>maintenance page</html>'));
    const res = await readReport(h);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Could not read Jira. Jira answered HTTP 503 (Service Unavailable).', kind: 'jira' });
  });

  it('gives no links when the base URL is not http(s)', async () => {
    const h = await start();
    const routes = reportRoutes({
      getJira: async () => ({ configured: true, config: { baseUrl: 'javascript:alert(1)//', token: 't', authType: 'datacenter' } as never, client }),
      defaultProject: () => '', themeKind: () => 'light', save: async () => ({ kind: 'cancelled' }), store: new PageStore(),
    });
    await server!.stop();
    server = new LocalhostServer({ onMcp: async (_req, res) => { res.end(); }, onCanvas: createCanvasHandler(routes) });
    h.port = await server.start(generateKey(), h.key);
    const report = (await readReport(h)).body as PageReport;
    expect(report.tables.flatMap(t => t.rows).every(r => r.ticketUrl === null)).toBe(true);
    expect(report.tables.every(t => t.jira === null)).toBe(true);
  });
});

describe('the save route', () => {
  it('saves the reading the page shows, the same overview @jira saves for that reading', async () => {
    const h = await start();
    const { pageId } = (await readReport(h)).body as PageReport;
    // Jira changes after the page was read; the save still writes what the page shows.
    seedOverviewJira(client, tickets.slice(0, 1));
    const res = await call(h, 'POST', '/api/save', { pageId, format: 'xlsx' });
    expect(res).toEqual({ status: 200, body: { outcome: 'saved', path: '/work/security-overview-SEC.csv' } });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ project: 'SEC', format: 'xlsx' });
    seedOverviewJira(client, tickets);
    const expected = await expectedOverview();
    expect(h.saves[0].overview).toEqual(expected);
    expect(renderOverviewCsv(h.saves[0].overview, ',')).toBe(renderOverviewCsv(expected, ','));
  });

  it('writes nothing and asks for Refresh when the page\'s reading is no longer held', async () => {
    const h = await start();
    const res = await call(h, 'POST', '/api/save', { pageId: 'gone', format: 'csv' });
    expect(res).toEqual({ status: 409, body: { outcome: 'refresh-first', message: SAVE_TEXTS.refreshFirst } });
    expect(h.saves).toEqual([]);
  });

  it('reports a cancelled dialog and a failed write as such', async () => {
    const cancelled = await start({ saveOutcome: { kind: 'cancelled' } });
    let pageId = (await readReport(cancelled)).body.pageId;
    expect((await call(cancelled, 'POST', '/api/save', { pageId, format: 'csv' })).body).toEqual({ outcome: 'cancelled' });
    await server!.stop();
    const failed = await start({ saveOutcome: { kind: 'failed', reason: 'EACCES: permission denied' } });
    pageId = (await readReport(failed)).body.pageId;
    expect((await call(failed, 'POST', '/api/save', { pageId, format: 'csv' })).body).toEqual({ outcome: 'failed', reason: 'EACCES: permission denied' });
  });

  it('refuses a format other than csv or xlsx, and a body that is not JSON', async () => {
    const h = await start();
    const pageId = (await readReport(h)).body.pageId;
    expect((await call(h, 'POST', '/api/save', { pageId, format: 'pdf' })).status).toBe(400);
    expect((await call(h, 'POST', '/api/save', `pageId=${pageId}&format=csv`, 'application/x-www-form-urlencoded')).status).toBe(415);
    expect(h.saves).toEqual([]);
  });
});

describe('a newer page for the same project', () => {
  it('marks the older page replaced: its status says so and its save is refused', async () => {
    const h = await start();
    const first = (await readReport(h)).body.pageId;
    const other = (await readReport(h, { project: 'PAY' })).body.pageId;
    await readReport(h);
    expect((await call(h, 'GET', `/api/page-status?pageId=${first}`)).body).toEqual({ replaced: true, themeKind: 'dark' });
    expect((await call(h, 'GET', `/api/page-status?pageId=${other}`)).body).toEqual({ replaced: false, themeKind: 'dark' });
    expect((await call(h, 'POST', '/api/save', { pageId: first, format: 'csv' })).body).toEqual({ outcome: 'replaced', message: SAVE_TEXTS.replaced });
  });

  it('is not what a page\'s own Refresh makes', async () => {
    const h = await start();
    const first = (await readReport(h)).body.pageId;
    const refreshed = (await readReport(h, { project: 'SEC', previousPageId: first })).body.pageId;
    expect((await call(h, 'GET', `/api/page-status?pageId=${first}`)).body.replaced).toBe(false);
    expect((await call(h, 'GET', `/api/page-status?pageId=${refreshed}`)).body.replaced).toBe(false);
  });
});
