import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerBoardRequest, asBoardRequest, type BoardHost } from '../boards/boardMessages';
import { ImportStartScreen } from '../boards/import/startScreen';
import { ReviewStartScreen } from '../boards/review/startScreen';
import { reviewKind } from '../boards/review/kind';
import { emptyFirstStep } from '../boards/review/firstStep';
import type { ReviewBoardDeps } from '../boards/review/deps';
import { REVIEW_KIND, reviewSessionId } from '../boards/review/recipe';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import { importKind } from '../boards/import/kind';
import { securityReportKind, type SecurityReportDeps } from '../boards/securityReport/kind';
import { registerKind, type BoardKind } from '../sessions/boardKind';
import { importSessionId, importSourceKey, type ImportRecipe } from '../boards/import/recipe';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { TicketService } from '../services/TicketService';
import { EmptyProjectJira, emptyProjectImportDeps, veracodeReport } from './helpers/importBoardFixture';

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
  closeSession: (kind, id) => { closed.push(`${kind}:${id}`); },
};
let closed: string[] = [];

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
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('a board page and the extension', () => {
  it('ignores a message that is not a request', () => {
    expect(asBoardRequest(undefined)).toBeUndefined();
    expect(asBoardRequest('state')).toBeUndefined();
    expect(asBoardRequest({ op: 'state' })).toBeUndefined();
    expect(asBoardRequest({ id: 1, op: 'state', body: [] })).toBeUndefined();
    expect(asBoardRequest({ id: 1, op: 'state' })).toEqual({ id: 1, op: 'state', body: {} });
  });

  it('closes the tab when the page closes the board, and the session is gone', async () => {
    closed = [];
    const state = await openReady();
    expect((await ask(report(state.id), 'discard')).status).toBe(200);
    expect(closed).toEqual([`security-report:${state.id}`]);
    expect((await ask(SESSIONS, 'list')).body.sessions).toEqual([]);
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

  it('has no Copy: only the review board copies findings, and nothing reaches the clipboard', async () => {
    const state = await openReady();
    const copied: string[] = [];
    host.copyText = async text => { copied.push(text); };
    try {
      expect(await ask(report(state.id), 'copy', { format: 'teams', numbers: [], text: 'anything' })).toMatchObject({ status: 404 });
    } finally {
      delete host.copyText;
    }
    expect(copied).toEqual([]);
  });

  it('opens a web link the page names through the host, and refuses any other scheme', async () => {
    const state = await openReady();
    const opened: string[] = [];
    host.openExternal = async url => { opened.push(url); };
    try {
      expect(await ask(report(state.id), 'open-link', { url: 'https://example.com/docs?a=1' })).toEqual({ status: 200, body: { outcome: 'opened' } });
      for (const url of ['command:workbench.action.openSettings', 'vscode:extension/x.y', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'mailto:a@b.c', '/relative', 42]) {
        expect((await ask(report(state.id), 'open-link', { url })).status).toBe(400);
      }
    } finally {
      delete host.openExternal;
    }
    expect(opened).toEqual(['https://example.com/docs?a=1']);
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

describe('a setting the board keeps for itself', () => {
  it('is refused for a board that keeps none, and for a request that names no setting', async () => {
    const state = await openReady();
    expect(await ask(report(state.id), 'preference', { name: 'loud', value: true })).toMatchObject({ status: 404 });
    expect(await ask(report(state.id), 'preference', { value: true })).toMatchObject({ status: 400, body: { error: 'Invalid setting.' } });
  });
});

describe('a model run asked for by a board page', () => {
  /** A board whose one run is a pass of two steps that ends only when the page stops it. */
  const passKind: BoardKind<{ name: string }, null, { pass: string }, unknown, { pass: string }, null> = {
    kind: 'pass-demo',
    formatVersion: 1,
    title: r => `Pass: ${r.name}`,
    validate: async input => ({ ok: true, recipe: { name: String((input as { name?: unknown }).name) } }),
    sourceKey: r => r.name,
    sourceLabel: r => r.name,
    initialWorking: () => ({ pass: 'idle' }),
    read: async () => ({ readAt: 1, fingerprints: {}, data: null }),
    reconcile: (session, fresh) => ({ derived: fresh, working: session.working }),
    reduce: () => ({ ok: false, reason: 'Unknown action.' }),
    beginRun: (session, request) => (request === 'pass'
      ? { ok: true, size: 'pass', what: 'pass', label: 'the pass', total: 2, working: { pass: 'running' } }
      : { ok: false, reason: 'Unknown run.' }),
    run: async (_session, _request, _deps, progress, signal) => {
      await progress({ done: 1, total: 2 });
      await new Promise(resolve => signal.addEventListener('abort', resolve));
      return { update: () => ({ pass: 'stopped after 1 of 2' }) };
    },
    view: session => session.working,
  };

  it('starts the run, shows it running with the board locked, and stops it on Stop', async () => {
    manager = new SessionManager({
      store: new SessionStore(path.join(dir, 'sessions')),
      kinds: [registerKind(passKind, () => null)],
      now: () => Date.now(),
      confirm: async () => true,
      saveFile: async () => true,
    });
    const opened = await manager.open('pass-demo', { name: 'one' });
    if (!opened.ok) throw new Error(opened.reason);
    const tab = { kind: 'pass-demo', id: opened.id };
    let state = (await ask(tab, 'state')).body;
    while (state.status !== 'ready') state = (await ask(tab, 'state', { tick: state.tick, wait: 2000 })).body;

    expect((await ask(tab, 'run', { request: 'pass' })).status).toBe(400);
    const started = await ask(tab, 'run', { revision: state.revision, request: 'pass' });
    expect(started.body.running).toEqual([{ size: 'pass', what: 'pass', label: 'the pass', done: 0, total: 2 }]);
    state = started.body;
    while (state.running?.[0].done !== 1) state = (await ask(tab, 'state', { tick: state.tick, wait: 2000 })).body;
    expect((await ask(tab, 'run', { revision: state.revision, request: 'pass' })).status).toBe(409);

    expect((await ask(tab, 'stop', { what: 3 })).status).toBe(400);
    expect((await ask(tab, 'stop')).status).toBe(200);
    while (state.running) state = (await ask(tab, 'state', { tick: state.tick, wait: 2000 })).body;
    expect(state.view).toEqual({ pass: 'stopped after 1 of 2' });
    expect((await ask(tab, 'stop')).status).toBe(409);
  });

  it('refuses a run on a board that runs no model', async () => {
    const state = await openReady();
    expect(await ask(report(state.id), 'run', { revision: state.revision, request: 'pass' })).toMatchObject({ status: 400, body: { error: 'This board runs no model.' } });
    expect((await ask(report(state.id), 'stop')).status).toBe(409);
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

describe('the import start screen', () => {
  const START = { kind: 'import-start', id: '' };

  function startHost(picked: string | undefined, written: string[]): BoardHost {
    const screen = new ImportStartScreen({
      jira: async () => ({ configured: false, config: { baseUrl: undefined, token: undefined, authType: 'datacenter' } as never }),
      defaultProject: () => 'PROJ',
      templateSetting: () => '',
      writeTemplateSetting: async (_kind, name) => { written.push(name); },
      templates: () => [{ name: 'OSS finding', issueType: 'Vulnerability', defaultFields: {} }],
      reportReader: () => ({ read: async () => ({ items: [1], rawItems: [] }), noMatchMessage: 'none', fileFilter: { label: 'OSS report', extensions: ['xlsx'] } }),
      pickReportFile: async () => picked,
      writeDefaultProject: async () => undefined,
      pickEmailFiles: async () => undefined,
      emailFiles: { checkCaps: async () => null, read: async () => ({}) },
      openSetting: async () => undefined,
      hasSession: async () => false,
      discardSession: async () => undefined,
      openImport: async () => ({ ok: true }),
    });
    return { ...host, importStart: screen };
  }

  async function askStart(boardHost: BoardHost, op: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const reply = await answerBoardRequest(manager, START, { id: nextId++, op, body }, boardHost, message => errors.push(message));
    return reply.ok ? { status: 200, body: reply.data } : { status: reply.status, body: { error: reply.error } };
  }

  it('answers the page through the start screen: the file comes from the native dialog and the template is written by the host', async () => {
    const written: string[] = [];
    const boardHost = startHost(path.join(dir, 'report.xlsx'), written);
    expect((await askStart(boardHost, 'kind', { kind: 'waltz' })).body.kind).toBe('waltz');
    const picked = (await askStart(boardHost, 'pick-file', { path: '/etc/passwd' })).body;
    expect(picked.report.path).toBe(path.join(dir, 'report.xlsx'));
    expect((await askStart(boardHost, 'template', { name: 'OSS finding' })).status).toBe(200);
    expect(written).toEqual([]);
    expect((await askStart(boardHost, 'template', { name: 'OSS finding', setAsDefault: true })).status).toBe(200);
    expect(written).toEqual(['OSS finding']);
    const blocked = await askStart(boardHost, 'open');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/^Jira base URL not configured/);
  });

  it('knows no session requests, and is not there where the host has no start screen', async () => {
    const boardHost = startHost(undefined, []);
    expect((await askStart(boardHost, 'state')).status).toBe(404);
    expect((await askStart(boardHost, 'apply', { planId: 'x' })).status).toBe(404);
    expect(await askStart(host, 'view')).toEqual({ status: 404, body: { error: 'There is no import start screen here.' } });
  });
});

describe('Discuss in chat on the review board', () => {
  const PR_URL = 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482';
  const REVIEWED = '4f2a91c0d1e24f2a91c0d1e24f2a91c0d1e24f2a';
  const SECRET_TITLE = 'Transfer amount is never checked';
  let reviewManager: SessionManager;
  let chats: string[];
  let copied: string[];
  let chatFails: boolean;
  let reviewHost: BoardHost;

  /** A stored review of the pull request with finding #12, as the board leaves it after a regular pass. */
  async function storedReview(): Promise<string> {
    const id = reviewSessionId({ url: PR_URL });
    const store = new SessionStore(path.join(dir, 'review-sessions'));
    await store.save({
      id, kind: REVIEW_KIND, formatVersion: reviewKind.formatVersion, revision: 3, createdAt: 1, lastUsedAt: 1,
      recipe: { url: PR_URL, host: 'bitbucket.example.com', project: 'PROJ', repo: 'app', prId: 482 },
      derived: { readAt: 1, fingerprints: { head: REVIEWED }, data: { pr: { title: 'Add transfers', author: 'Jane', headCommit: REVIEWED }, jiraConfigured: false, models: { options: [] } } },
      working: {
        stage: 'review', firstStep: emptyFirstStep(), passes: [], threads: {}, drafts: {},
        review: {
          snapshot: { target: { project: 'PROJ', repo: 'app', prId: 482 }, pr: {}, reviewedCommit: REVIEWED, batches: [] },
          store: {
            findings: [{ id: 12, file: 'src/TransferController.java', line: 40, severity: 'critical', title: SECRET_TITLE, description: 'The amount goes straight to the ledger.', recommendation: 'Check it.' }],
            nextNumber: 13, stepsRun: ['regular'], criticChecked: [],
          },
          suggestion: { kind: 'none-suggested' },
        },
      },
    } as never);
    return id;
  }

  async function askReview(id: string, op: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const reply = await answerBoardRequest(reviewManager, { kind: REVIEW_KIND, id }, { id: nextId++, op, body }, reviewHost, message => errors.push(message));
    return reply.ok ? { status: 200, body: reply.data } : { status: reply.status, body: { error: reply.error } };
  }

  beforeEach(() => {
    chats = [];
    copied = [];
    chatFails = false;
    const client = new MockBitbucketClient();
    client.prOverride = { fromCommitHash: REVIEWED };
    const reviewDeps = { bitbucket: async () => ({ configured: true, client }), jira: async () => undefined, models: { list: async () => [], handle: async () => undefined } } as unknown as ReviewBoardDeps;
    reviewManager = new SessionManager({
      store: new SessionStore(path.join(dir, 'review-sessions')),
      kinds: [registerKind(reviewKind, () => reviewDeps)],
      now: () => Date.now(), confirm: async () => true, saveFile: async () => true,
    });
    reviewHost = {
      ...host,
      openChat: async query => {
        if (chatFails) throw new Error('command workbench.action.chat.open not found');
        chats.push(query);
      },
      copyText: async text => { copied.push(text); },
    };
  });

  it('opens Copilot Chat with a prompt naming the pull request link, the finding number and the reviewed commit, and no finding text', async () => {
    const id = await storedReview();

    const reply = await askReview(id, 'discuss', { number: 12 });

    expect(reply).toEqual({ status: 200, body: { outcome: 'opened' } });
    expect(chats).toHaveLength(1);
    const prompt = chats[0];
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain('#12');
    expect(prompt).toContain('4f2a91c0d1e2');
    expect(prompt).toContain('#bitbucketReadFindings');
    expect(prompt).not.toContain(SECRET_TITLE);
    expect(prompt).not.toContain('ledger');
    expect(copied).toEqual([]);
  });

  it('copies the prompt to the clipboard and says so when the chat cannot be opened', async () => {
    const id = await storedReview();
    chatFails = true;

    const reply = await askReview(id, 'discuss', { number: 12 });

    expect(reply).toEqual({ status: 200, body: { outcome: 'copied' } });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain(PR_URL);
    expect(copied[0]).toContain('#12');
  });

  it('refuses a finding the review does not have, and is not offered on another board', async () => {
    const id = await storedReview();
    expect((await askReview(id, 'discuss', { number: 99 })).status).toBe(400);
    expect((await askReview(id, 'discuss', { number: 'x' })).status).toBe(400);
    const state = await openReady();
    host.openChat = async query => { chats.push(query); };
    try {
      expect((await ask(report(state.id), 'discuss', { number: 12 })).status).toBe(404);
    } finally {
      delete host.openChat;
    }
    expect(chats).toEqual([]);
  });
});

describe('the review start screen', () => {
  const START = { kind: 'review-start', id: '' };

  async function askReview(boardHost: BoardHost, op: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const reply = await answerBoardRequest(manager, START, { id: nextId++, op, body }, boardHost, message => errors.push(message));
    return reply.ok ? { status: 200, body: reply.data } : { status: reply.status, body: { error: reply.error } };
  }

  it('answers the page through the start screen, which opens the review board for the link', async () => {
    const opened: Array<{ url: string }> = [];
    const boardHost: BoardHost = {
      ...host,
      reviewStart: new ReviewStartScreen({ bitbucketHint: async () => undefined, openReview: async input => { opened.push(input); return { ok: true, title: 'Review: PROJ/app#7' }; } }),
    };
    const reply = await askReview(boardHost, 'open', { url: 'https://bitbucket.org/team/app/pull-requests/7/overview' });
    expect(reply).toEqual({ status: 200, body: { url: 'https://bitbucket.org/team/app/pull-requests/7/overview', opened: 'Review: PROJ/app#7' } });
    expect(opened).toEqual([{ url: 'https://bitbucket.org/team/app/pull-requests/7' }]);
    expect((await askReview(boardHost, 'state')).status).toBe(404);
  });

  it('is not there where the host has no review start screen', async () => {
    expect(await askReview(host, 'view')).toEqual({ status: 404, body: { error: 'There is no review start screen here.' } });
  });
});

describe('picking the report file of an import again', () => {
  /** An import board whose reading is its recipe's report path, so the move can be seen without Jira. */
  const importStub: BoardKind<ImportRecipe, { path: string }, { tab: string }, { type: 'tab'; tab: string }, unknown, null> = {
    kind: 'import',
    formatVersion: 1,
    title: r => `Import: ${path.basename(r.reportPath)}`,
    validate: async input => ({ ok: true, recipe: input as ImportRecipe }),
    revalidate: async stored => ({ ok: true, recipe: stored as ImportRecipe }),
    sourceKey: r => importSourceKey(r),
    sourceLabel: r => r.reportPath,
    initialWorking: () => ({ tab: 'new' }),
    read: async r => ({ readAt: 1, fingerprints: {}, data: { path: r.reportPath } }),
    reconcile: (session, fresh) => ({ derived: fresh, working: session.working }),
    reduce: (_session, action) => ({ ok: true, working: { tab: action.tab } }),
    view: session => ({ path: session.derived.data.path, tab: session.working.tab }),
  };
  const recipeAt = (file: string): ImportRecipe => ({ kind: 'veracode', projectKey: 'PROJ', reportPath: file, templateName: 'T', issueType: 'Bug' });
  let followed: string[];
  let picks: Array<string | undefined>;
  let importHost: BoardHost;

  beforeEach(() => {
    followed = [];
    picks = [];
    manager = new SessionManager({
      store: new SessionStore(path.join(dir, 'sessions')),
      kinds: [registerKind(importStub, () => null)],
      now: () => Date.now(),
      confirm: async () => true,
      saveFile: async () => true,
    });
    importHost = {
      ...host,
      pickReportFile: async kind => { picks.push(kind); return pickedPath; },
      followSession: async (kind, from, to) => { followed.push(`${kind}:${from}->${to}`); },
    };
  });
  let pickedPath: string | undefined;

  async function askImport(target: { kind: string; id: string }, op: string, body: Record<string, unknown> = {}) {
    const reply = await answerBoardRequest(manager, target, { id: nextId++, op, body }, importHost, message => errors.push(message));
    return reply.ok ? { status: 200, body: reply.data as any } : { status: reply.status, body: { error: reply.error } };
  }

  it('moves the session to the picked file, keeps its choices and points the tab at the new session', async () => {
    const opened = await manager.open('import', recipeAt(path.join(dir, 'old.xml')));
    if (!opened.ok) throw new Error(opened.reason);
    const tab = { kind: 'import', id: opened.id };
    let state = (await askImport(tab, 'state')).body;
    while (state.status !== 'ready') state = (await askImport(tab, 'state', { tick: state.tick, wait: 2000 })).body;
    await askImport(tab, 'action', { revision: state.revision, action: { type: 'tab', tab: 'stale' } });

    pickedPath = path.join(dir, 'moved', 'old.xml');
    // The page names no path: the file comes from the native dialog only.
    const picked = await askImport(tab, 'pick-file', { path: '/etc/passwd' });

    expect(picked.status).toBe(200);
    expect(picks).toEqual(['veracode']);
    const newId = importSessionId(recipeAt(pickedPath));
    expect(picked.body).toMatchObject({ outcome: 'picked', id: newId, state: { view: { path: pickedPath, tab: 'stale' } } });
    expect(followed).toEqual([`import:${opened.id}->${newId}`]);
  });

  it('changes nothing when the dialog is cancelled, and is no request of other boards', async () => {
    const opened = await manager.open('import', recipeAt(path.join(dir, 'old.xml')));
    if (!opened.ok) throw new Error(opened.reason);
    pickedPath = undefined;
    let state = (await askImport({ kind: 'import', id: opened.id }, 'state')).body;
    while (state.status !== 'ready') state = (await askImport({ kind: 'import', id: opened.id }, 'state', { tick: state.tick, wait: 2000 })).body;
    expect((await askImport({ kind: 'import', id: opened.id }, 'pick-file')).body).toEqual({ outcome: 'cancelled' });
    expect(followed).toEqual([]);
    expect((await askImport({ kind: 'security-report', id: opened.id }, 'pick-file')).status).toBe(404);
  });
});

describe('the import board page and the extension', () => {
  let jira: EmptyProjectJira;
  let confirmed: string[];

  beforeEach(() => {
    jira = new EmptyProjectJira();
    confirmed = [];
    manager = new SessionManager({
      store: new SessionStore(path.join(dir, 'sessions')),
      kinds: [registerKind(importKind, () => emptyProjectImportDeps(dir, jira))],
      now: () => Date.now(),
      confirm: async plan => { confirmed.push(plan.title); return true; },
      saveFile: async file => { saved.push(file.fileName); return true; },
    });
  });

  async function openImport(files: string[]): Promise<{ tab: { kind: string; id: string }; state: any }> {
    const reportPath = path.join(dir, 'report.xml');
    fs.writeFileSync(reportPath, veracodeReport(files));
    const opened = await manager.open('import', { kind: 'veracode', projectKey: 'PROJ', reportPath, templateName: 'Security bug', issueType: 'Bug' });
    if (!opened.ok) throw new Error(opened.reason);
    const tab = { kind: 'import', id: opened.id };
    let state = (await ask(tab, 'state')).body;
    while (state.status === 'building' || state.status === 'checking') state = (await ask(tab, 'state', { tick: state.tick, wait: 2000 })).body;
    return { tab, state };
  }

  it('shows the tabs, switches them, previews a create and applies it without a native confirmation, even for more than one ticket', async () => {
    const { tab, state } = await openImport(['Login.java', 'Report.java']);
    expect(state.view.tabs.map((t: { id: string; count: number }) => [t.id, t.count])).toEqual([['new', 2], ['ticketed', 0], ['stale', 0]]);

    const switched = (await ask(tab, 'action', { revision: state.revision, action: { type: 'tab', tab: 'ticketed' } })).body;
    expect(switched.view.tab).toBe('ticketed');
    const back = (await ask(tab, 'action', { revision: switched.revision, action: { type: 'tab', tab: 'new' } })).body;

    const plan = (await ask(tab, 'preview', { revision: back.revision, action: { type: 'new-create' } })).body;
    expect(plan).toMatchObject({ title: 'Create 2 ticket(s) in PROJ', risky: false });
    expect(plan.lines.map((l: { target: string }) => l.target)).toEqual(['Flaw 101', 'Flaw 102']);
    const applied = (await ask(tab, 'apply', { planId: plan.planId })).body;

    expect(confirmed).toEqual([]);
    expect(applied.results.map((r: { target: string; outcome: string }) => [r.target, r.outcome])).toEqual([['Flaw 101: PROJ-100', 'done'], ['Flaw 102: PROJ-101', 'done']]);
    expect(applied.state.view.new.rows.map((r: { created?: string }) => r.created)).toEqual(['PROJ-100', 'PROJ-101']);
    // A plan is used once.
    expect((await ask(tab, 'apply', { planId: plan.planId })).status).toBe(409);
  });

  it('works on the import of its own tab: a session the page names is not looked at', async () => {
    const { tab, state } = await openImport(['Login.java']);
    const other = { kind: 'import', id: 'import-ffffffffffffffff' };
    expect((await ask(other, 'state')).status).toBe(404);
    const reply = await ask(tab, 'action', { revision: state.revision, id: 'import-ffffffffffffffff', session: 'import-ffffffffffffffff', action: { type: 'tab', tab: 'stale' } });
    expect(reply.body.id).toBe(tab.id);
    expect(reply.body.view.tab).toBe('stale');
  });
});
