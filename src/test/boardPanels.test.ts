import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A board's editor tab as the extension hosts it: the tab is opened once per session, its page's
// requests are answered over the tab's own message channel, and VS Code can hand a tab back after
// a restart. `vscode` is replaced by the few calls the host makes.

interface FakePanel {
  title: string;
  state: unknown;
  revealed: number;
  disposed: boolean;
  posted: any[];
  webview: { html: string; options: unknown; cspSource: string; asWebviewUri(uri: { fsPath: string }): string; onDidReceiveMessage(fn: (m: unknown) => unknown): { dispose(): void }; postMessage(m: unknown): Promise<boolean> };
  send(message: unknown): Promise<void>;
  close(): void;
  reveal(): void;
  dispose(): void;
  onDidDispose(fn: () => void): { dispose(): void };
}

const created: FakePanel[] = [];
const clipboard: string[] = [];
/** Board tabs VS Code lists but has not handed to the extension yet, by label. */
const unrestored: string[] = [];
const closedTabs: string[] = [];

function fakePanel(title = ''): FakePanel {
  let receive: ((m: unknown) => unknown) | undefined;
  const closers: Array<() => void> = [];
  const panel: FakePanel = {
    title, state: undefined, revealed: 0, disposed: false, posted: [],
    webview: {
      html: '', options: undefined, cspSource: 'vscode-resource:',
      asWebviewUri: uri => `vscode-resource:${uri.fsPath}`,
      onDidReceiveMessage: fn => { receive = fn; return { dispose: () => { receive = undefined; } }; },
      postMessage: async m => { panel.posted.push(m); return true; },
    },
    send: async message => { await receive?.(message); },
    close: () => { panel.disposed = true; closers.forEach(fn => fn()); },
    reveal: () => { panel.revealed++; },
    dispose: () => panel.close(),
    onDidDispose: fn => { closers.push(fn); return { dispose: () => undefined }; },
  };
  return panel;
}

vi.mock('vscode', () => {
  const TabInputWebview = class { constructor(public viewType: string) {} };
  return {
  ViewColumn: { Active: -1 },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
  TabInputWebview,
  window: {
    createWebviewPanel: (_type: string, title: string) => { const p = fakePanel(title); created.push(p); return p; },
    tabGroups: {
      get all() { return [{ tabs: unrestored.map(label => ({ label, input: new TabInputWebview('mainThreadWebview-ticketSidekick.board') })) }]; },
      close: async (tabs: Array<{ label: string }>) => { closedTabs.push(...tabs.map(t => t.label)); unrestored.length = 0; return true; },
    },
  },
};
});

import { BoardPanels } from '../boards/boardPanels';
import { ImportStartScreen, type ImportStartDeps } from '../boards/import/startScreen';
import { ReviewStartScreen } from '../boards/review/startScreen';
import { securityReportKind, type SecurityReportDeps } from '../boards/securityReport/kind';
import { ticketListKind, type TicketListDeps } from '../boards/ticketList/kind';
import { registerKind } from '../sessions/boardKind';
import { sessionIdFor } from '../sessions/sessionId';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { TicketService } from '../services/TicketService';

const ticketService = {
  listOverviewTickets: async () => ({ tickets: [], truncated: false }),
  getProjectVersions: async () => [],
  readDescriptions: async () => ({ texts: {}, failed: [] }),
} as unknown as TicketService;

const deps: SecurityReportDeps = {
  jira: async () => ({ ticketService, baseUrl: 'https://jira.example.com' }),
  defaultProject: () => '',
  csvDelimiter: () => ',',
  today: () => '2026-11-12',
  now: () => Date.now(),
};

let dir: string;
let panels: BoardPanels;
let manager: SessionManager;

function startScreen(over: Partial<ImportStartDeps> = {}): ImportStartScreen {
  return new ImportStartScreen({
    jira: async () => ({ configured: false, config: { baseUrl: undefined, token: undefined, authType: 'datacenter' } as never }),
    defaultProject: () => 'PROJ',
    templateSetting: () => '',
    writeTemplateSetting: async () => undefined,
    writeDefaultProject: async () => undefined,
    templates: () => [],
    reportReader: () => ({ read: async () => ({ items: [1], rawItems: [] }), noMatchMessage: 'none', fileFilter: { label: 'OSS report', extensions: ['xlsx'] } }),
    pickReportFile: async () => undefined,
    pickEmailFiles: async () => undefined,
    emailFiles: { checkCaps: async () => null, read: async () => ({}) },
    openSetting: async () => undefined,
    hasSession: async () => false,
    discardSession: async () => undefined,
    openImport: async () => ({ ok: true }),
    ...over,
  });
}
let errors: string[];

beforeEach(async () => {
  unrestored.length = 0;
  closedTabs.length = 0;
  created.length = 0;
  errors = [];
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-panels-'));
  manager = new SessionManager({
    store: new SessionStore(path.join(dir, 'sessions')),
    kinds: [registerKind(securityReportKind, () => deps)],
    now: () => Date.now(),
    confirm: async () => true,
    saveFile: async () => true,
  });
  panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message));
});

afterEach(async () => {
  // A session may still be storing its first reading in the background.
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('opening a board', () => {
  it('opens an editor tab that loads the board\'s page from the extension\'s own files', async () => {
    expect(await panels.open('security-report', { project: 'PROJ' })).toEqual({ ok: true, title: 'Security report: PROJ' });
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Security report: PROJ');
    expect(created[0].webview.html).toContain('src="vscode-resource:/ext/out/board-pages/security-report/page.js"');
    expect(created[0].webview.options).toEqual({ enableScripts: true, localResourceRoots: [{ fsPath: '/ext/out/board-pages' }] });
    expect(panels.stats()).toEqual({ openTabs: 1, requestsAnswered: 0 });
  });

  it('brings the tab forward instead of opening the same session twice', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    await panels.open('security-report', { project: 'proj' });
    expect(created).toHaveLength(1);
    expect(created[0].revealed).toBe(1);
  });

  it('opens a tab again after it was closed', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    created[0].close();
    expect(panels.stats().openTabs).toBe(0);
    await panels.open('security-report', { project: 'PROJ' });
    expect(created).toHaveLength(2);
  });

  it('says why and opens nothing for a board that does not exist or a request the board refuses', async () => {
    expect(await panels.open('nonsense', {})).toEqual({ ok: false, reason: 'there is no board of that name.' });
    expect((await panels.open('security-report', { project: 'not a key!' })).ok).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('opens the stored sessions without a session', async () => {
    expect(await panels.open('sessions', {})).toEqual({ ok: true, title: 'Stored sessions' });
    expect(created[0].webview.html).toContain('data-kind="sessions" data-session=""');
  });
});

describe('a page\'s requests', () => {
  it('are answered over the tab\'s message channel, each with the id it was sent with', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    await created[0].send({ id: 7, op: 'state', body: {} });
    expect(created[0].posted).toHaveLength(1);
    expect(created[0].posted[0]).toMatchObject({ id: 7, ok: true, data: { title: 'Security report: PROJ' } });
    expect(panels.stats().requestsAnswered).toBe(1);
  });

  it('are ignored when they are not requests, and refused when the board does not know them', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    await created[0].send('hello');
    expect(created[0].posted).toEqual([]);
    await created[0].send({ id: 1, op: 'explode' });
    expect(created[0].posted).toEqual([{ id: 1, ok: false, status: 404, error: 'Unknown request.' }]);
    expect(errors).toEqual([]);
  });

  it('get no answer once the tab is closed', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    const send = created[0].send;
    created[0].close();
    await send({ id: 1, op: 'state' });
    expect(created[0].posted).toEqual([]);
  });

  it('let the stored sessions board reopen a session in its own tab', async () => {
    await panels.open('security-report', { project: 'PROJ' });
    await created[0].send({ id: 1, op: 'state' });
    const id = created[0].posted[0].data.id;
    // Stored once the first read finished.
    while (created[0].posted.at(-1).data.status !== 'ready') await created[0].send({ id: 2, op: 'state', body: { tick: created[0].posted.at(-1).data.tick, wait: 2000 } });
    created[0].close();
    await panels.open('sessions', {});
    await created[1].send({ id: 3, op: 'open', body: { kind: 'security-report', id } });
    expect(created[1].posted).toEqual([{ id: 3, ok: true, data: { ok: true } }]);
    expect(created).toHaveLength(3);
    expect(created[2].title).toBe('Security report: PROJ');
  });
});

describe('the import start screen', () => {
  it('opens as a tab without a session that loads its own page, and answers its page through the start screen', async () => {
    panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message), startScreen());
    expect(await panels.open('import-start', { kind: 'waltz', reportPath: path.join(dir, 'report.xlsx') })).toEqual({ ok: true, title: 'Jira Import Board' });
    expect(created[0].webview.html).toContain('data-kind="import-start" data-session=""');
    expect(created[0].webview.html).toContain('src="vscode-resource:/ext/out/board-pages/import-start/page.js"');
    await created[0].send({ id: 1, op: 'view', body: {} });
    expect(created[0].posted[0]).toMatchObject({ id: 1, ok: true, data: { kind: 'waltz', report: { path: path.join(dir, 'report.xlsx') } } });

    await panels.open('import-start', {});
    expect(created).toHaveLength(1);
    expect(created[0].revealed).toBe(1);
  });

  it('asked to open loaded, opens the import board when nothing is missing and the start screen otherwise', async () => {
    const recipes: unknown[] = [];
    const ready = startScreen({
      jira: async () => ({ configured: true, client: { getProject: async () => ({ issueTypes: [] }) }, config: {} }) as never,
      templateSetting: () => 'OSS finding',
      templates: () => [{ name: 'OSS finding', issueType: 'Vulnerability' }] as never,
      openImport: async recipe => { recipes.push(recipe); return { ok: true, title: 'Import: report.xlsx' }; },
    });
    const file = path.join(dir, 'report.xlsx');
    panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message), ready);
    expect(await panels.open('import-start', { kind: 'waltz', reportPath: file, openWhenReady: true })).toEqual({ ok: true, title: 'Import: report.xlsx' });
    expect(recipes).toHaveLength(1);
    expect(created).toHaveLength(0);

    panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message), startScreen());
    expect(await panels.open('import-start', { kind: 'waltz', reportPath: file, openWhenReady: true })).toEqual({ ok: true, title: 'Jira Import Board' });
    expect(created[0].webview.html).toContain('data-kind="import-start"');
  });

  it('is no board where the extension has no start screen', async () => {
    expect(await panels.open('import-start', {})).toEqual({ ok: false, reason: 'there is no board of that name.' });
    expect(created).toHaveLength(0);
  });

  it('opens the import board through the session manager, which says when there is no such board', async () => {
    expect(await panels.open('import', { kind: 'waltz' })).toEqual({ ok: false, reason: 'there is no board of that name.' });
  });

  it('comes back after a restart', async () => {
    panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message), startScreen());
    const restored = fakePanel();
    await panels.serializer().deserializeWebviewPanel(restored as never, { kind: 'import-start', id: '', title: 'Open import' });
    expect(restored.disposed).toBe(false);
    await restored.send({ id: 1, op: 'view' });
    expect(restored.posted[0]).toMatchObject({ id: 1, ok: true });
  });
});

describe('the clipboard', () => {
  it('is VS Code\'s own: the review board\'s Copy writes the text the extension built there', async () => {
    clipboard.length = 0;
    await panels.copyText('PR #482 — Add export');
    expect(clipboard).toEqual(['PR #482 — Add export']);
  });
});

describe('the review start screen', () => {
  const reviewStart = () => new ReviewStartScreen({ bitbucketHint: async () => undefined, openReview: async () => ({ ok: true, title: 'Review: PROJ/app#7' }) });

  it('opens as a tab without a session that loads its own page and answers it, and comes back after a restart', async () => {
    panels = new BoardPanels(manager, ['security-report'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message), undefined, undefined, reviewStart());
    expect(await panels.open('review-start', {})).toEqual({ ok: true, title: 'Review a pull request' });
    expect(created[0].webview.html).toContain('data-kind="review-start" data-session=""');
    expect(created[0].webview.html).toContain('src="vscode-resource:/ext/out/board-pages/review-start/page.js"');
    await created[0].send({ id: 1, op: 'view', body: {} });
    expect(created[0].posted[0]).toEqual({ id: 1, ok: true, data: { url: '' } });

    const restored = fakePanel();
    await panels.serializer().deserializeWebviewPanel(restored as never, { kind: 'review-start', id: '', title: 'Review a pull request' });
    expect(restored.disposed).toBe(false);
  });

  it('is no board where the extension has no review start screen', async () => {
    expect(await panels.open('review-start', {})).toEqual({ ok: false, reason: 'there is no board of that name.' });
  });
});

describe('a tab VS Code brings back after a restart', () => {
  it('shows its board again from the state the page stored', async () => {
    const restored = fakePanel();
    await panels.serializer().deserializeWebviewPanel(restored as never, { kind: 'security-report', id: 'a'.repeat(24), title: 'Security report: PROJ' });
    expect(restored.disposed).toBe(false);
    expect(restored.title).toBe('Security report: PROJ');
    expect(restored.webview.html).toContain(`data-session="${'a'.repeat(24)}"`);
    await restored.send({ id: 1, op: 'state' });
    expect(restored.posted).toEqual([{ id: 1, ok: false, status: 404, error: expect.any(String) }]);
  });

  it('is closed when what was stored is not one of this extension\'s boards', async () => {
    const restored = fakePanel();
    await panels.serializer().deserializeWebviewPanel(restored as never, { kind: 'import', id: '', title: 'x' });
    expect(restored.disposed).toBe(true);
  });
});

describe('a ticket list opened again', () => {
  const rows = ['PROJ-1', 'PROJ-2'].map(key => ({ key, summary: key, status: 'Open', issueType: 'Bug', assignee: '', priority: '', updated: 't1' }));
  const listDeps = {
    jiraConfigured: async () => true, baseUrl: async () => undefined, extraColumns: async () => ({ search: [], cleanup: [] }),
    search: async () => ({ rows, truncated: false }), now: () => 1000,
  } as unknown as TicketListDeps;
  const request = { jql: 'project = PROJ' };
  const idOfList = () => sessionIdFor('ticket-list', ticketListKind.sourceKey({ source: { type: 'jql', jql: 'project = PROJ' } }));

  function listBoards() {
    const m = new SessionManager({
      store: new SessionStore(path.join(dir, 'list-sessions')),
      kinds: [registerKind(ticketListKind, () => listDeps)],
      now: () => Date.now(), confirm: async () => true, saveFile: async () => true,
    });
    return { m, p: new BoardPanels(m, ['ticket-list'], { fsPath: '/ext/out/board-pages' } as never, message => errors.push(message)) };
  }
  async function selected(m: SessionManager, id: string): Promise<number> {
    let state = await m.state('ticket-list', id);
    while (state.status === 'building' || state.status === 'checking') state = await m.state('ticket-list', id, state.tick, 1000);
    if (state.status !== 'ready') throw new Error(`The list did not load: ${state.error}`);
    return (state.view as { selectedCount: number }).selectedCount;
  }

  it('keeps its selection while its tab is open, and starts clean once the tab was closed', async () => {
    const { m, p } = listBoards();
    expect(await p.open('ticket-list', request)).toMatchObject({ ok: true });
    const id = idOfList();
    expect(await selected(m, id)).toBe(0);
    const state = await m.state('ticket-list', id);
    await m.action('ticket-list', id, state.revision, { type: 'select-all' });
    expect(await selected(m, id)).toBe(2);

    await p.open('ticket-list', request);
    expect(created).toHaveLength(1);
    expect(await selected(m, id)).toBe(2);

    created[0].close();
    await p.open('ticket-list', request);
    expect(created).toHaveLength(2);
    expect(await selected(m, id)).toBe(0);
  });

  it('reads the list again when VS Code brings its tab back after a restart, so nothing old is shown', async () => {
    const { m, p } = listBoards();
    await p.open('ticket-list', request);
    const id = idOfList();
    await selected(m, id);
    const state = await m.state('ticket-list', id);
    await m.action('ticket-list', id, state.revision, { type: 'select-all' });
    expect(await selected(m, id)).toBe(2);
    created[0].close();

    const restored = fakePanel();
    await p.serializer().deserializeWebviewPanel(restored as never, { kind: 'ticket-list', id, title: created[0].title });
    expect(restored.disposed).toBe(false);
    expect(await selected(m, id)).toBe(0);
  });

  it('keeps its selection and opens one tab when its tab is waiting to be restored after a restart', async () => {
    const { m, p } = listBoards();
    await p.open('ticket-list', request);
    const id = idOfList();
    await selected(m, id);
    const state = await m.state('ticket-list', id);
    await m.action('ticket-list', id, state.revision, { type: 'select-all' });
    const title = created[0].title;
    created[0].close();
    closedTabs.length = 0;

    // VS Code lists the board's tab after a restart but has not handed it to the extension yet.
    unrestored.push(title);
    await p.open('ticket-list', request);
    expect(await selected(m, id)).toBe(2);
    expect(created).toHaveLength(2);
    expect(closedTabs).toEqual([title]);

    // Asked for from the sessions board's Reopen, it does not start over either.
    unrestored.push(title);
    expect(await p.openStored('ticket-list', id)).toEqual({ ok: true });
    expect(await selected(m, id)).toBe(2);
  });

  it('does not start over from the sessions board\'s Reopen while its tab is open', async () => {
    const { m, p } = listBoards();
    await p.open('ticket-list', request);
    const id = idOfList();
    await selected(m, id);
    const state = await m.state('ticket-list', id);
    await m.action('ticket-list', id, state.revision, { type: 'select-all' });

    expect(await p.openStored('ticket-list', id)).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0].revealed).toBeGreaterThan(0);
    expect(await selected(m, id)).toBe(2);
  });

  it('starts clean from the sessions board\'s Reopen too, but keeps what a restored tab shows', async () => {
    const { m, p } = listBoards();
    await p.open('ticket-list', request);
    const id = idOfList();
    await selected(m, id);
    const state = await m.state('ticket-list', id);
    await m.action('ticket-list', id, state.revision, { type: 'select-all' });
    created[0].close();

    // VS Code brings the tab back after a restart: it asks for the state of the session, which is kept.
    expect(await selected(m, id)).toBe(2);

    // The sessions board's Reopen of a session with no tab starts over from the stored list.
    expect(await p.openStored('ticket-list', id)).toEqual({ ok: true });
    expect(created).toHaveLength(2);
    expect(await selected(m, id)).toBe(0);
  });
});
