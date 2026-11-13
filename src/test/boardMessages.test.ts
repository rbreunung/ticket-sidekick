import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerBoardRequest, asBoardRequest, type BoardHost } from '../boards/boardMessages';
import { securityReportKind, type SecurityReportDeps } from '../boards/securityReport/kind';
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { TicketService } from '../services/TicketService';

// A board page talking to the extension over the editor tab's message channel: it loads its
// session, changes it, saves a file, and the sessions board lists, reopens and deletes what is
// stored. `ask` stands for the tab: it knows which board and session it shows, the page does not
// say.

let dir: string;
let manager: SessionManager;
let reopened: string[];
let errors: string[];
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

const host: BoardHost = {
  openStored: async (kind, id) => {
    if (kind !== 'security-report') return { ok: false, reason: 'there is no board of that name.' };
    reopened.push(`${kind}:${id}`);
    return { ok: true };
  },
};

let nextId = 1;

/** One request of the page in the tab that shows `target`; `status` is 200 when it was answered. */
async function ask(target: { kind: string; id: string }, op: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const request = asBoardRequest({ id: nextId++, op, body });
  if (!request) throw new Error('the test built a request the tab would ignore');
  const reply = await answerBoardRequest(manager, target, request, host, message => errors.push(message));
  expect(reply.id).toBe(request.id);
  return reply.ok ? { status: 200, body: reply.data } : { status: reply.status, body: { error: reply.error } };
}

const report = (id: string) => ({ kind: 'security-report', id });
const SESSIONS = { kind: 'sessions', id: '' };

async function openReady(project = 'PROJ'): Promise<any> {
  const opened = await manager.open('security-report', { project });
  if (!opened.ok) throw new Error(opened.reason);
  let state = (await ask(report(opened.id), 'state')).body;
  while (state.status === 'building' || state.status === 'checking') {
    state = (await ask(report(opened.id), 'state', { tick: state.tick, wait: 2000 })).body;
  }
  return state;
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-boards-'));
  saved = [];
  reopened = [];
  errors = [];
  jiraFails = false;
  manager = new SessionManager({
    store: new SessionStore(path.join(dir, 'sessions')),
    kinds: [registerKind(securityReportKind, () => deps)],
    now: () => Date.now(),
    confirm: async () => true,
    saveFile: async file => { saved.push(file.fileName); return true; },
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('a board page and the extension', () => {
  it('ignores a message that is not a request', () => {
    expect(asBoardRequest(undefined)).toBeUndefined();
    expect(asBoardRequest('state')).toBeUndefined();
    expect(asBoardRequest({ op: 'state' })).toBeUndefined();
    expect(asBoardRequest({ id: 1, op: 'state', body: [] })).toBeUndefined();
    expect(asBoardRequest({ id: 1, op: 'state' })).toEqual({ id: 1, op: 'state', body: {} });
  });

  it('shows the session, applies a filter, and waits for changes', async () => {
    const state = await openReady();
    expect(state.view.tables[0].rows[0].ticketKey).toBe('PROJ-1');
    const filtered = await ask(report(state.id), 'action', { revision: state.revision, action: { type: 'filter', tool: 'waltz' } });
    expect(filtered.status).toBe(200);
    expect(filtered.body.view).toMatchObject({ shownTickets: 0, totalTickets: 1 });
    const unchanged = await ask(report(state.id), 'state', { tick: filtered.body.tick, wait: 50 });
    expect(unchanged.body.tick).toBe(filtered.body.tick);
  });

  it('answers an action on an older revision with 409, and an unknown action with 400', async () => {
    const state = await openReady();
    await ask(report(state.id), 'action', { revision: state.revision, action: { type: 'clear' } });
    expect((await ask(report(state.id), 'action', { revision: state.revision, action: { type: 'clear' } })).status).toBe(409);
    const now = (await ask(report(state.id), 'state')).body;
    const bad = await ask(report(state.id), 'action', { revision: now.revision, action: { type: 'explode' } });
    expect(bad).toMatchObject({ status: 400, body: { error: 'Unknown action.' } });
  });

  it('works on the session of its own tab only: a session the page names is not looked at', async () => {
    const a = await openReady('AAA');
    const b = await openReady('BBB');
    const answered = await ask(report(a.id), 'state', { s: b.id, id: b.id });
    expect(answered.body.title).toBe(a.title);
  });

  it('refuses a session that is gone, a request without a revision and a request it does not know', async () => {
    const state = await openReady();
    expect((await ask(report('f'.repeat(24)), 'state')).status).toBe(404);
    expect((await ask(report(state.id), 'action', { action: { type: 'clear' } })).status).toBe(400);
    expect((await ask(report(state.id), 'explode')).status).toBe(404);
  });

  it('has no write path: a preview is refused', async () => {
    const state = await openReady();
    const preview = await ask(report(state.id), 'preview', { revision: state.revision, action: { type: 'clear' } });
    expect(preview).toMatchObject({ status: 400, body: { error: 'This board does not write.' } });
  });

  it('saves the full report through the save dialog', async () => {
    const state = await openReady();
    expect((await ask(report(state.id), 'save', { format: 'csv' })).body).toEqual({ outcome: 'saved' });
    expect(saved).toEqual(['security-overview-PROJ-2026-11-12.csv']);
  });

  it('shows a Jira failure as status and short reason, and recovers on Refresh', async () => {
    jiraFails = true;
    const failed = await openReady('BAD');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Jira answered HTTP 500/);
    expect(JSON.stringify(failed)).not.toContain('secret internals');
    jiraFails = false;
    const refreshed = await ask(report(failed.id), 'refresh');
    expect(refreshed.body.status).toBe('ready');
  });

  it('answers an unexpected error with a fixed sentence and keeps the detail for the log', async () => {
    const state = await openReady();
    manager.refresh = async () => { throw new Error('secret internals'); };
    const answered = await ask(report(state.id), 'refresh');
    expect(answered).toEqual({ status: 500, body: { error: 'The extension could not answer. See the Ticket Sidekick output for details.' } });
    expect(errors).toEqual(['secret internals']);
  });
});

describe('the sessions board', () => {
  it('lists the stored sessions, deletes one, and deletes all', async () => {
    const a = await openReady('AAA');
    await openReady('BBB');
    const list = (await ask(SESSIONS, 'list')).body.sessions;
    expect(list.map((s: any) => s.source).sort()).toEqual(['Jira project AAA', 'Jira project BBB']);
    expect(list[0]).toMatchObject({ kind: 'security-report' });

    const afterDelete = (await ask(SESSIONS, 'delete', { id: a.id })).body.sessions;
    expect(afterDelete.map((s: any) => s.source)).toEqual(['Jira project BBB']);
    expect((await ask(report(a.id), 'state')).status).toBe(404);

    expect((await ask(SESSIONS, 'delete-all')).body).toEqual({ sessions: [] });
  });

  it('reopens a stored session in its own tab, and says why when it cannot', async () => {
    const a = await openReady('AAA');
    expect((await ask(SESSIONS, 'open', { kind: 'security-report', id: a.id })).status).toBe(200);
    expect(reopened).toEqual([`security-report:${a.id}`]);
    expect(await ask(SESSIONS, 'open', { kind: 'nonsense', id: a.id })).toEqual({ status: 404, body: { error: 'Not opened: there is no board of that name.' } });
    expect((await ask(SESSIONS, 'open', { kind: 'security-report', id: '../x' })).status).toBe(400);
  });

  it('cannot be asked for a session\'s requests, nor a session board for the list', async () => {
    const a = await openReady('AAA');
    expect((await ask(SESSIONS, 'state')).status).toBe(404);
    expect((await ask(report(a.id), 'list')).status).toBe(404);
  });
});
