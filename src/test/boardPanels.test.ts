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

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1 },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') }) },
  window: { createWebviewPanel: (_type: string, title: string) => { const p = fakePanel(title); created.push(p); return p; } },
}));

import { BoardPanels } from '../boards/boardPanels';
import { securityReportKind, type SecurityReportDeps } from '../boards/securityReport/kind';
import { registerKind } from '../sessions/boardKind';
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
let errors: string[];

beforeEach(async () => {
  created.length = 0;
  errors = [];
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-panels-'));
  const manager = new SessionManager({
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
