import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardRoutes } from '../boards/boardRoutes';
import { securityReportKind, type SecurityReportDeps } from '../boards/securityReport/kind';
import { createCanvasHandler } from '../canvas/canvasRoutes';
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { TicketService } from '../services/TicketService';

// A board page talking to the extension: it loads its session, changes it, saves a file, and the
// sessions board lists and deletes what is stored. The server here stands for the part behind the
// canvas key.

let dir: string;
let server: http.Server;
let port: number;
let saved: string[];
let jiraFails: boolean;

const ticketService = {
  listOverviewTickets: async () => {
    if (jiraFails) throw Object.assign(new Error('secret internals'), { status: 500 });
    return {
      tickets: [{ key: 'PROJ-1', summary: 'SQL injection', status: 'Open', labels: [], dueDate: '2026-01-10', fixVersions: ['1.0'], source: 'veracode' as const }],
      truncated: false,
    };
  },
  getProjectVersions: async () => [{ name: '1.0', releaseDate: '2026-12-01', released: false }],
  readDescriptions: async (keys: string[]) => ({ texts: Object.fromEntries(keys.map(k => [k, ''])), failed: [] }),
} as unknown as TicketService;

const deps: SecurityReportDeps = {
  jira: async () => ({ ticketService, baseUrl: 'https://jira.example.com' }),
  defaultProject: () => '',
  csvDelimiter: () => ',',
  today: () => '2026-11-12',
  now: () => Date.now(),
};

async function call(method: string, urlPath: string, body?: unknown, contentType = 'application/json'): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: body === undefined ? {} : { 'Content-Type': contentType } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* a page asset */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function openReady(project = 'PROJ'): Promise<any> {
  const opened = (await call('GET', `/api/open?kind=security-report&input=${encodeURIComponent(JSON.stringify({ project }))}`)).body;
  let state = (await call('GET', `/board/security-report/state?s=${opened.id}`)).body;
  while (state.status === 'building' || state.status === 'checking') {
    state = (await call('GET', `/board/security-report/state?s=${opened.id}&tick=${state.tick}&wait=2000`)).body;
  }
  return state;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-boards-'));
  const pages = path.join(dir, 'pages');
  await fs.promises.mkdir(path.join(pages, 'security-report'), { recursive: true });
  await fs.promises.writeFile(path.join(pages, 'security-report', 'index.html'), '<!doctype html><title>Security report</title>');
  await fs.promises.writeFile(path.join(pages, 'security-report', 'notes.txt'), 'not a page asset');
  saved = [];
  jiraFails = false;
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, 'sessions')),
    kinds: [registerKind(securityReportKind, () => deps)],
    now: () => Date.now(),
    confirm: async () => true,
    saveFile: async file => { saved.push(file.fileName); return true; },
  });
  const handler = createCanvasHandler(boardRoutes({ manager, kinds: ['security-report'], pagesDir: pages, theme: () => 'dark' }));
  server = http.createServer((req, res) => { void handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('a board page and the extension', () => {
  it('serves the page, for the folder and by file name, with the canvas security headers', async () => {
    const page = await call('GET', '/board/security-report/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await call('GET', '/board/security-report/index.html')).status).toBe(200);
    expect((await call('GET', '/board/security-report/notes.txt')).status).toBe(404);
    expect((await call('GET', '/board/security-report/../../sessions/x.json')).status).toBe(404);
  });

  it('tells the page the theme of the window', async () => {
    expect((await call('GET', '/board/theme')).body).toEqual({ kind: 'dark' });
  });

  it('shows the session, applies a filter, and waits for changes', async () => {
    const state = await openReady();
    expect(state.view.tables[0].rows[0].ticketKey).toBe('PROJ-1');
    const filtered = await call('POST', '/board/security-report/action', { s: state.id, revision: state.revision, action: { type: 'filter', tool: 'waltz' } });
    expect(filtered.status).toBe(200);
    expect(filtered.body.view).toMatchObject({ shownTickets: 0, totalTickets: 1 });
    const unchanged = await call('GET', `/board/security-report/state?s=${state.id}&tick=${filtered.body.tick}&wait=50`);
    expect(unchanged.body.tick).toBe(filtered.body.tick);
  });

  it('answers an action on an older revision with 409, and an unknown action with 400', async () => {
    const state = await openReady();
    await call('POST', '/board/security-report/action', { s: state.id, revision: state.revision, action: { type: 'clear' } });
    expect((await call('POST', '/board/security-report/action', { s: state.id, revision: state.revision, action: { type: 'clear' } })).status).toBe(409);
    const now = (await call('GET', `/board/security-report/state?s=${state.id}`)).body;
    const bad = await call('POST', '/board/security-report/action', { s: state.id, revision: now.revision, action: { type: 'explode' } });
    expect(bad).toMatchObject({ status: 400, body: { error: 'Unknown action.' } });
  });

  it('refuses a body that is not JSON, a made-up session and a session id that is not one', async () => {
    const state = await openReady();
    expect((await call('POST', '/board/security-report/action', `s=${state.id}`, 'application/x-www-form-urlencoded')).status).toBe(415);
    expect((await call('GET', `/board/security-report/state?s=${'f'.repeat(24)}`)).status).toBe(404);
    expect((await call('GET', '/board/security-report/state?s=../../x')).status).toBe(400);
  });

  it('has no write path: a preview is refused', async () => {
    const state = await openReady();
    const preview = await call('POST', '/board/security-report/preview', { s: state.id, revision: state.revision, action: { type: 'clear' } });
    expect(preview).toMatchObject({ status: 400, body: { error: 'This board does not write.' } });
  });

  it('saves the full report through the save dialog', async () => {
    const state = await openReady();
    expect((await call('POST', '/board/security-report/save', { s: state.id, format: 'csv' })).body).toEqual({ outcome: 'saved' });
    expect(saved).toEqual(['security-overview-PROJ-2026-11-12.csv']);
  });

  it('shows a Jira failure as status and short reason, and recovers on Refresh', async () => {
    jiraFails = true;
    const failed = await openReady('BAD');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Jira answered HTTP 500/);
    expect(JSON.stringify(failed)).not.toContain('secret internals');
    jiraFails = false;
    const refreshed = await call('POST', '/board/security-report/refresh', { s: failed.id });
    expect(refreshed.body.status).toBe('ready');
  });
});

describe('the sessions board', () => {
  it('lists the stored sessions, deletes one, and deletes all', async () => {
    const a = await openReady('AAA');
    await openReady('BBB');
    const list = (await call('GET', '/board/sessions/list')).body.sessions;
    expect(list.map((s: any) => s.source).sort()).toEqual(['Jira project AAA', 'Jira project BBB']);
    expect(list[0]).toMatchObject({ kind: 'security-report' });

    const afterDelete = (await call('POST', '/board/sessions/delete', { id: a.id })).body.sessions;
    expect(afterDelete.map((s: any) => s.source)).toEqual(['Jira project BBB']);
    expect((await call('GET', `/board/security-report/state?s=${a.id}`)).status).toBe(404);

    expect((await call('POST', '/board/sessions/delete-all', {})).body).toEqual({ sessions: [] });
  });

  it('opens without a session of its own', async () => {
    expect((await call('GET', '/api/open?kind=sessions')).body).toEqual({ ok: true, id: '', title: 'Stored sessions' });
  });
});
