import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Covers the VS Code glue of the MCP server: it runs exactly while 127.0.0.1 is in http.noProxy,
// the provider offers it to VS Code only then, the resolve hook hands out the current URL and key,
// users without the entry get a notice at every start, and nothing is ever written to settings or
// extension state. `vscode` is mocked per this repo's per-test-file convention.

interface Definition { label: string; uri: { toString(): string }; headers?: Record<string, string>; version?: string }
interface Provider {
  provideMcpServerDefinitions: () => unknown;
  resolveMcpServerDefinition?: (server: Definition) => unknown;
  onDidChangeMcpServerDefinitions?: (listener: () => void) => unknown;
}
type ConfigListener = (e: { affectsConfiguration(key: string): boolean }) => unknown;

const h = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  infoMessages: [] as string[],
  infoChoice: undefined as string | undefined,
  pendingNotification: undefined as Promise<unknown> | undefined,
  clipboard: undefined as string | undefined,
  configUpdates: 0,
  lm: {} as Record<string, unknown>,
  providers: [] as Array<{ id: string; provider: unknown }>,
  changeEvents: 0,
  noProxy: ['127.0.0.1'] as unknown,
  executed: [] as unknown[][],
  configListeners: [] as Array<(e: { affectsConfiguration(key: string): boolean }) => unknown>,
  logLines: [] as string[],
  token: undefined as string | undefined,
  bitbucketToken: undefined as string | undefined,
  chatSettings: {} as Record<string, unknown>,
  progressOptions: undefined as { cancellable?: boolean } | undefined,
  cancelRequested: false,
  folderListeners: [] as Array<() => unknown>,
  canvasesEnabled: true as unknown,
  panels: [] as Array<{ title: string; webview: { html: string; options?: unknown }; revealed: number; disposed: boolean }>,
  serializers: [] as Array<{ deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }>,
  defaultProject: undefined as string | undefined,
  folders: [{ uri: { fsPath: '/work/a', scheme: 'file' } }] as Array<{ uri: { fsPath: string; scheme: string } }>,
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => { this.listeners.push(listener); return { dispose: () => undefined }; };
    fire(e: T) { h.changeEvents++; this.listeners.forEach(l => l(e)); }
    dispose() { this.listeners = []; }
  }
  class McpHttpServerDefinition {
    constructor(public label: string, public uri: { toString(): string }, public headers?: Record<string, string>, public version?: string) {}
  }
  const configuration = (section?: string) => ({
    ...(section === 'chat' ? h.chatSettings : {}),
    get: (key: string, fallback?: unknown) => {
      if (section === 'http' && key === 'noProxy') return h.noProxy;
      if (section === 'chat' && key === 'canvases.enabled') return h.canvasesEnabled;
      if (section === 'ticketSidekick' && key === 'jira.baseUrl') return 'https://jira.example.com';
      if (section === 'ticketSidekick' && key === 'jira.defaultProject') return h.defaultProject ?? fallback;
      return fallback;
    },
    update: async () => { h.configUpdates++; },
    has: () => false,
    inspect: () => undefined,
  });
  return {
    version: '1.144.0',
    EventEmitter,
    McpHttpServerDefinition,
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    lm: h.lm,
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => { h.commands.set(id, fn); return { dispose: () => undefined }; },
      executeCommand: async (...args: unknown[]) => { h.executed.push(args); },
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line: string) => { h.logLines.push(line); } }),
      showInformationMessage: (message: string, ...choices: string[]) => {
        h.infoMessages.push(message);
        const result = Promise.resolve(choices.length ? h.infoChoice : undefined);
        if (choices.length) h.pendingNotification = result;
        return result;
      },
      showWarningMessage: async (message: string) => { h.infoMessages.push(message); return undefined; },
      activeColorTheme: { kind: 2 },
      registerWebviewPanelSerializer: (_viewType: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }) => {
        h.serializers.push(serializer);
        return { dispose: () => undefined };
      },
      showInputBox: async () => undefined,
      createWebviewPanel: (_viewType: string, title: string) => {
        const panel = {
          title, webview: { html: '' }, revealed: 0, disposed: false,
          reveal() { panel.revealed++; },
          dispose() { panel.disposed = true; },
          onDidDispose: () => ({ dispose: () => undefined }),
        };
        h.panels.push(panel);
        return panel;
      },
      showErrorMessage: async (message: string) => { h.infoMessages.push(message); return undefined; },
      withProgress: (options: { cancellable?: boolean }, task: (progress: unknown, token: unknown) => Promise<unknown>) => {
        h.progressOptions = options;
        return task({ report: () => undefined }, { isCancellationRequested: h.cancelRequested, onCancellationRequested: () => ({ dispose: () => undefined }) });
      },
    },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Active: -1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    workspace: {
      get workspaceFolders() { return h.folders; },
      onDidChangeWorkspaceFolders: (listener: () => unknown) => { h.folderListeners.push(listener); return { dispose: () => undefined }; },
      getConfiguration: (section?: string) => configuration(section),
      onDidChangeConfiguration: (listener: (e: { affectsConfiguration(key: string): boolean }) => unknown) => {
        h.configListeners.push(listener);
        return { dispose: () => undefined };
      },
    },
    env: { clipboard: { writeText: async (text: string) => { h.clipboard = text; } } },
  };
});

import { registerMcp, deactivateMcp, MCP_COMMANDS, MCP_PROVIDER_ID } from '../mcp/register';
import { ConfigService } from '../services/ConfigService';
import { CHECK_CONNECTION_TOOL } from '../mcp/jiraTools/catalog';
import { McpServerController } from '../mcp/serverController';
import { LocalhostServer } from '../mcp/localhostServer';
import { sessionIdFor } from '../sessions/sessionId';

let tmp: string;
let stateUpdates: number;
let secretWrites: number;

function makeContext() {
  const memento = { get: () => undefined, update: async () => { stateUpdates++; }, keys: () => [], setKeysForSync: () => undefined };
  return {
    extensionPath: path.join(tmp, 'ext'),
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: memento,
    workspaceState: memento,
    secrets: {
      get: async (key: string) => (key === 'ticket-sidekick.bitbucket.token' ? h.bitbucketToken : h.token),
      store: async () => { secretWrites++; },
      delete: async () => { secretWrites++; },
      onDidChange: () => ({ dispose: () => undefined }),
    },
    logUri: { fsPath: path.join(tmp, 'logs', 'session', 'exthost', 'ticket-sidekick') },
    globalStorageUri: { fsPath: path.join(tmp, 'User', 'globalStorage', 'ticket-sidekick') },
    storageUri: undefined,
    extension: { packageJSON: { version: '0.0.0-test' } },
  };
}

function provider(): Provider {
  return h.providers[0].provider as Provider;
}

function offered(): Definition[] {
  return provider().provideMcpServerDefinitions() as Definition[];
}

function bearerOf(definition: Definition): string {
  return definition.headers?.Authorization?.slice('Bearer '.length) ?? '';
}

async function activate(opts: { withApi: boolean; choice?: string }) {
  if (opts.withApi) {
    h.lm.registerMcpServerDefinitionProvider = (id: string, p: unknown) => {
      h.providers.push({ id, provider: p });
      return { dispose: () => undefined };
    };
  } else {
    delete h.lm.registerMcpServerDefinitionProvider;
  }
  h.infoChoice = opts.choice;
  const context = makeContext();
  await registerMcp(context as never, new ConfigService(context as never));
  await h.pendingNotification;
  return context;
}

async function changeNoProxy(value: unknown): Promise<void> {
  h.noProxy = value;
  await Promise.all(h.configListeners.map(l => l({ affectsConfiguration: key => key === 'http.noProxy' })));
}

/** Resolves true when something accepts a TCP connection on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST' }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function portOf(definition: Definition): number {
  return Number(new URL(definition.uri.toString()).port);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mcp-life-'));
  process.env.COPILOT_HOME = path.join(tmp, 'copilot-home');
  stateUpdates = 0;
  secretWrites = 0;
  h.commands.clear();
  h.infoMessages = [];
  h.panels = [];
  h.serializers = [];
  h.infoChoice = undefined;
  h.pendingNotification = undefined;
  h.providers = [];
  h.changeEvents = 0;
  h.configUpdates = 0;
  h.clipboard = undefined;
  h.noProxy = ['127.0.0.1'];
  h.executed = [];
  h.configListeners = [];
  h.logLines = [];
  h.token = undefined;
  h.bitbucketToken = undefined;
  h.chatSettings = {};
  h.progressOptions = undefined;
  h.cancelRequested = false;
  h.folderListeners = [];
  h.canvasesEnabled = true;
  h.defaultProject = undefined;
  h.folders = [{ uri: { fsPath: '/work/a', scheme: 'file' } }];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deactivateMcp();
  delete process.env.COPILOT_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function windowNote(): { port: number; canvasKey: string; workspaceFolders: string[] } | undefined {
  const file = path.join(tmp, 'copilot-home', 'ticket-sidekick', 'windows', `window-${process.pid}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
}

/** Lets the note keeper finish the write or removal a lifecycle change started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

describe('the window note for canvases', () => {
  it('is written with the server\'s port, a canvas key and the window\'s folders while the server runs', async () => {
    await activate({ withApi: true });
    const note = windowNote();
    expect(note?.port).toBe(portOf(offered()[0]));
    expect(note?.canvasKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(note?.canvasKey).not.toBe(bearerOf(offered()[0]));
    expect(note?.workspaceFolders).toEqual(['/work/a']);
  });

  it('is removed when the http.noProxy entry is removed, and written again when it comes back', async () => {
    await activate({ withApi: true });
    await changeNoProxy([]);
    await settle();
    expect(windowNote()).toBeUndefined();
    await changeNoProxy(['127.0.0.1']);
    await settle();
    expect(windowNote()?.port).toBe(portOf(offered()[0]));
  });

  it('lists a workspace folder added while the server runs', async () => {
    await activate({ withApi: true });
    h.folders = [...h.folders, { uri: { fsPath: '/work/b', scheme: 'file' } }];
    h.folderListeners.forEach(l => l());
    await settle();
    expect(windowNote()?.workspaceFolders).toEqual(['/work/a', '/work/b']);
  });

  it('is removed on deactivation', async () => {
    await activate({ withApi: true });
    await deactivateMcp();
    expect(windowNote()).toBeUndefined();
  });

  it('is not written while the server is not running', async () => {
    h.noProxy = [];
    await activate({ withApi: true });
    await settle();
    expect(windowNote()).toBeUndefined();
  });
});

/** A GET to the window's own server under its canvas key, as the canvas program sends it. */
function canvasGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: res.headers['content-type']?.includes('json') ? JSON.parse(text) : text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const openPath = (key: string, input: unknown) => `/${key}/api/open?kind=security-report&input=${encodeURIComponent(JSON.stringify(input))}`;

describe('the open request the canvas program sends before it opens a board', () => {
  it('answers through the window\'s server, under the key its note names, with the session of the asked or the default project', async () => {
    h.token = 'jira-pat';
    h.defaultProject = 'PAY';
    await activate({ withApi: true });
    const note = windowNote()!;
    expect(await canvasGet(note.port, openPath(note.canvasKey, { project: 'proj' })))
      .toEqual({ status: 200, body: { ok: true, id: sessionIdFor('security-report', 'PROJ'), title: 'Security report: PROJ' } });
    expect((await canvasGet(note.port, openPath(note.canvasKey, {}))).body)
      .toEqual({ ok: true, id: sessionIdFor('security-report', 'PAY'), title: 'Security report: PAY' });
  });

  it('says Jira is not set up when this window has no Jira token, and asks for a project when none is known', async () => {
    await activate({ withApi: true });
    const note = windowNote()!;
    expect((await canvasGet(note.port, openPath(note.canvasKey, { project: 'PROJ' }))).body).toMatchObject({ ok: false, reason: expect.stringContaining('Jira is not set up') });
    expect((await canvasGet(note.port, openPath(note.canvasKey, {}))).body).toMatchObject({ ok: false, reason: expect.stringContaining('no project was named') });
  });

  it('refuses a board it does not know', async () => {
    await activate({ withApi: true });
    const note = windowNote()!;
    expect((await canvasGet(note.port, `/${note.canvasKey}/api/open?kind=other&input=%7B%7D`)).body).toEqual({ ok: false, reason: 'Unknown board.' });
  });

  it('refuses the bearer key of the MCP endpoint in place of the canvas key', async () => {
    await activate({ withApi: true });
    const note = windowNote()!;
    expect((await canvasGet(note.port, openPath(bearerOf(offered()[0]), { project: 'PROJ' }))).status).toBe(401);
  });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const definition = offered()[0];
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(definition.uri.toString()), { requestInit: { headers: definition.headers } }));
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  return ((result as { content: Array<{ text?: string }> }).content).map(c => c.text).join('\n');
}

describe('boards as editor tabs', () => {
  it('opens a board in an editor tab when Copilot calls the open board tool, and tells Copilot only that it opened', async () => {
    h.token = 'jira-pat';
    await activate({ withApi: true });
    const text = await callTool('jira_open_board', { board: 'security-report', project: 'proj' });
    expect(text).toBe('Opened in an editor tab: Security report: PROJ.');
    const note = windowNote()!;
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0].title).toBe('Security report: PROJ');
    expect(h.panels[0].webview.html).toContain(`<iframe src="http://127.0.0.1:${note.port}/${note.canvasKey}/board/security-report/?s=${sessionIdFor('security-report', 'PROJ')}"`);
  });

  it('brings the tab forward when the same board is asked for again', async () => {
    h.token = 'jira-pat';
    await activate({ withApi: true });
    await callTool('jira_open_board', { board: 'security-report', project: 'PROJ' });
    await callTool('jira_open_board', { board: 'security-report', project: 'PROJ' });
    expect(h.panels).toHaveLength(1);
    expect(h.panels[0].revealed).toBe(1);
  });

  it('says why a board does not open, and opens no tab', async () => {
    await activate({ withApi: true });
    expect(await callTool('jira_open_board', { board: 'security-report', project: 'PROJ' })).toContain('Not opened: Jira is not set up');
    expect(h.panels).toEqual([]);
  });

  it('opens the stored sessions from the Command Palette', async () => {
    await activate({ withApi: true });
    await h.commands.get('ticket-sidekick.boards.sessions')!();
    expect(h.panels.map(p => p.title)).toEqual(['Stored sessions']);
    expect(h.panels[0].webview.html).toContain('/board/sessions/"');
  });

  it('gives a tab VS Code brings back after a restart the page of its session at the new address', async () => {
    h.token = 'jira-pat';
    await activate({ withApi: true });
    const restored = { title: '', webview: { html: '' }, revealed: 0, disposed: false, reveal() { /* not used */ }, dispose() { restored.disposed = true; }, onDidDispose: () => ({ dispose: () => undefined }) };
    const id = sessionIdFor('security-report', 'PROJ');
    await h.serializers[0].deserializeWebviewPanel(restored, { kind: 'security-report', id, title: 'Security report: PROJ' });
    const note = windowNote()!;
    expect(restored.title).toBe('Security report: PROJ');
    expect(restored.webview.html).toContain(`http://127.0.0.1:${note.port}/${note.canvasKey}/board/security-report/?s=${id}`);
  });

  it('closes a restored tab whose stored state is not a board\'s', async () => {
    await activate({ withApi: true });
    const restored = { title: '', webview: { html: '' }, disposed: false, dispose() { restored.disposed = true; }, onDidDispose: () => ({ dispose: () => undefined }) };
    await h.serializers[0].deserializeWebviewPanel(restored, { kind: 'no-such-board', id: '', title: 'x' });
    expect(restored.disposed).toBe(true);
  });

  it('shows no notice about canvases at start', async () => {
    h.canvasesEnabled = false;
    await activate({ withApi: true });
    expect(h.infoMessages.filter(m => /canvas/i.test(m))).toEqual([]);
  });
});

describe('MCP server lifecycle', () => {
  it('without 127.0.0.1 in http.noProxy, activation starts no server and the provider offers nothing', async () => {
    h.noProxy = ['localhost'];
    await activate({ withApi: true });
    expect(h.providers.map(p => p.id)).toEqual([MCP_PROVIDER_ID]);
    expect(offered()).toEqual([]);
    expect(await provider().resolveMcpServerDefinition?.({ label: 'Ticket Sidekick', uri: { toString: () => 'http://127.0.0.1:1/mcp' } })).toBeUndefined();
  });

  it('with the entry, activation starts the server and offers one HTTP definition with a bearer header', async () => {
    await activate({ withApi: true });
    const definitions = offered();
    expect(definitions).toHaveLength(1);
    expect(definitions[0].label).toBe('Ticket Sidekick');
    expect(definitions[0].uri.toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(definitions[0].headers?.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(await listening(portOf(definitions[0]))).toBe(true);
  });

  it('adding the entry starts the server, fires the change event and offers one definition', async () => {
    h.noProxy = [];
    await activate({ withApi: true });
    const before = h.changeEvents;
    await changeNoProxy(['127.0.0.1']);
    expect(h.changeEvents).toBe(before + 1);
    const definitions = offered();
    expect(definitions).toHaveLength(1);
    expect(definitions[0].headers?.Authorization).toMatch(/^Bearer /);
    expect(await listening(portOf(definitions[0]))).toBe(true);
  });

  it('removing the entry stops the server, fires the change event and offers nothing', async () => {
    await activate({ withApi: true });
    const port = portOf(offered()[0]);
    const before = h.changeEvents;
    await changeNoProxy([]);
    expect(h.changeEvents).toBe(before + 1);
    expect(offered()).toEqual([]);
    expect(await listening(port)).toBe(false);
  });

  it('keeps running when another setting changes', async () => {
    await activate({ withApi: true });
    const first = offered()[0];
    await Promise.all(h.configListeners.map(l => l({ affectsConfiguration: key => key === 'editor.fontSize' })));
    const now = offered();
    expect(now).toHaveLength(1);
    expect(now[0].uri.toString()).toBe(first.uri.toString());
    expect(now[0].headers?.Authorization).toBe(first.headers?.Authorization);
  });

  it('adding another http.noProxy entry while 127.0.0.1 is there keeps the server as it is', async () => {
    await activate({ withApi: true });
    const first = offered()[0];
    const before = h.changeEvents;
    await changeNoProxy(['127.0.0.1', 'build.corp.internal']);
    expect(h.changeEvents).toBe(before);
    const now = offered();
    expect(now).toHaveLength(1);
    expect(now[0].uri.toString()).toBe(first.uri.toString());
    expect(bearerOf(now[0])).toBe(bearerOf(first));
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    const history = h.clipboard!.split('## Server history')[1].split('Current port')[0];
    expect(history.match(/^- .*$/gm)).toEqual([expect.stringMatching(/: started on port \d+ \(activation\)$/)]);
  });

  it('a restart of the server yields a different bearer key', async () => {
    await activate({ withApi: true });
    const first = bearerOf(offered()[0]);
    await changeNoProxy([]);
    await changeNoProxy(['127.0.0.1']);
    expect(bearerOf(offered()[0])).not.toBe(first);
  });

  it('after a restart the resolve hook returns the new port and key; while stopped it refuses', async () => {
    await activate({ withApi: true });
    const old = offered()[0];
    await changeNoProxy([]);
    expect(await provider().resolveMcpServerDefinition?.(old)).toBeUndefined();
    await changeNoProxy(['127.0.0.1']);
    const current = offered()[0];
    const resolved = await provider().resolveMcpServerDefinition?.(old) as Definition;
    expect(resolved.uri.toString()).toBe(current.uri.toString());
    expect(resolved.headers?.Authorization).toBe(current.headers?.Authorization);
    expect(resolved.headers?.Authorization).not.toBe(old.headers?.Authorization);
  });

  it('serves the Jira tools without Jira being configured, answering with the setup hint', async () => {
    await activate({ withApi: true });
    const definition = offered()[0];
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(definition.uri.toString()), {
      requestInit: { headers: definition.headers },
    }));
    const result = await client.callTool({ name: CHECK_CONNECTION_TOOL, arguments: {} });
    await client.close();
    const text = ((result as { content: Array<{ text?: string }> }).content).map(c => c.text).join('\n');
    expect(text).toMatch(/token/i);
    const log = h.logLines.join('\n');
    expect(log).toContain(`${CHECK_CONNECTION_TOOL}: ok`);
    expect(log).not.toContain(bearerOf(definition));
  });

  it('logs start, stop and refused requests, never the key', async () => {
    await activate({ withApi: true });
    const definition = offered()[0];
    await listening(portOf(definition));
    await changeNoProxy([]);
    const log = h.logLines.join('\n');
    expect(log).toMatch(/\[mcp\] MCP server started on 127\.0\.0\.1:\d+ \(activation\)/);
    expect(log).toMatch(/\[mcp\] MCP request refused: mcp-key-invalid/);
    expect(log).toMatch(/\[mcp\] MCP server stopped \(entry removed\)/);
    expect(log).not.toContain(bearerOf(definition));
  });

  it('deactivation stops the server', async () => {
    await activate({ withApi: true });
    const port = portOf(offered()[0]);
    await deactivateMcp();
    expect(await listening(port)).toBe(false);
    expect(offered()).toEqual([]);
  });

  it('writes no setting, extension state or secret across start, stop, restart and the diagnostics report', async () => {
    await activate({ withApi: true });
    await changeNoProxy([]);
    await changeNoProxy(['127.0.0.1']);
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    await deactivateMcp();
    expect(h.configUpdates).toBe(0);
    expect(stateUpdates).toBe(0);
    expect(secretWrites).toBe(0);
  });

  it('without the provider API, activation registers no provider, starts nothing, logs once and does not throw', async () => {
    await expect(activate({ withApi: false })).resolves.toBeDefined();
    expect(h.providers).toEqual([]);
    expect(h.configListeners).toEqual([]);
    expect(h.logLines.filter(l => l.includes('[mcp]'))).toHaveLength(1);
    expect(h.logLines.join('\n')).toMatch(/MCP server provider API/);
  });
});

describe('MCP server lifecycle with overlapping and failing starts', () => {
  let controller: McpServerController<object> | undefined;
  let allowed: boolean;

  function newController(): McpServerController<object> {
    controller = new McpServerController<object>({
      tools: [], toolDeps: {}, serverInfo: { name: 'test', version: '0.0.0' }, isMcpAllowed: () => allowed,
    });
    return controller;
  }

  function events(c: McpServerController<object>): string[] {
    return c.snapshot().history.map(e => (e.port === undefined ? `${e.event} (${e.trigger})` : `${e.event} ${e.port} (${e.trigger})`));
  }

  beforeEach(() => { allowed = true; });
  afterEach(async () => {
    allowed = false;
    await controller?.stop('deactivate');
    controller = undefined;
  });

  it('records a failed start, offers nothing, and a later start works', async () => {
    vi.spyOn(LocalhostServer.prototype, 'start').mockRejectedValueOnce(new Error('listen EADDRINUSE'));
    const c = newController();
    await expect(c.start('activation')).resolves.toBeUndefined();
    expect(events(c)).toEqual(['start failed (activation)']);
    expect(c.isRunning()).toBe(false);
    expect(c.definition()).toBeUndefined();

    await c.start('entry added');
    expect(events(c)).toEqual(['start failed (activation)', `started ${c.port()} (entry added)`]);
    expect(c.definition()).toBeDefined();
    expect(await listening(c.port()!)).toBe(true);
  });

  it('two starts at the same time open one server', async () => {
    const c = newController();
    await Promise.all([c.start('activation'), c.start('entry added')]);
    expect(c.snapshot().history.filter(e => e.event === 'started')).toHaveLength(1);
    expect(c.isRunning()).toBe(true);
  });

  it('a stop asked for while a start is under way leaves the server stopped when the entry is gone', async () => {
    const c = newController();
    const starting = c.start('entry added');
    allowed = false;
    const stopping = c.stop('entry removed');
    await Promise.all([starting, stopping]);
    const [started] = c.snapshot().history;
    expect(events(c)).toEqual([`started ${started.port} (entry added)`, `stopped ${started.port} (entry removed)`]);
    expect(c.isRunning()).toBe(false);
    expect(c.definition()).toBeUndefined();
    expect(await listening(started.port!)).toBe(false);
  });

  it('a stop finishes before the next start begins, so the history is in real order', async () => {
    const c = newController();
    await c.start('activation');
    const firstPort = c.port()!;
    // A close that takes a while, as with open connections, so a start could overtake it.
    const close = LocalhostServer.prototype.stop;
    vi.spyOn(LocalhostServer.prototype, 'stop').mockImplementationOnce(async function (this: LocalhostServer) {
      const closed = close.call(this);
      await new Promise(resolve => setTimeout(resolve, 50));
      await closed;
    });
    allowed = false;
    const stopping = c.stop('entry removed');
    allowed = true;
    const starting = c.start('entry added');
    await Promise.all([stopping, starting]);
    const secondPort = c.port()!;
    expect(events(c)).toEqual([
      `started ${firstPort} (activation)`,
      `stopped ${firstPort} (entry removed)`,
      `started ${secondPort} (entry added)`,
    ]);
    expect(await listening(secondPort)).toBe(true);
  });

  it('entry added, removed and added again before the first start finishes ends with the server running', async () => {
    h.noProxy = [];
    await activate({ withApi: true });
    const fire = (value: unknown) => {
      h.noProxy = value;
      return Promise.all(h.configListeners.map(l => l({ affectsConfiguration: key => key === 'http.noProxy' })));
    };
    const added = fire(['127.0.0.1']);
    const removed = fire([]);
    const addedAgain = fire(['127.0.0.1']);
    await Promise.all([added, removed, addedAgain]);
    const definitions = offered();
    expect(definitions).toHaveLength(1);
    expect(await listening(portOf(definitions[0]))).toBe(true);
  });
});

describe('proxy-entry notice', () => {
  it('without the entry, activation shows the notice and Open Setting opens http.noProxy', async () => {
    h.noProxy = [];
    await activate({ withApi: true, choice: 'Open Setting' });
    expect(h.infoMessages).toHaveLength(1);
    expect(h.infoMessages[0]).toMatch(/Jira tools for Copilot chats need 127\.0\.0\.1 in the http\.noProxy setting/);
    expect(h.infoMessages[0]).toMatch(/network proxy/);
    expect(h.executed).toContainEqual(['workbench.action.openSettings', 'http.noProxy']);
    expect(h.configUpdates).toBe(0);
  });

  it('dismissing the notice opens nothing', async () => {
    h.noProxy = [];
    await activate({ withApi: true });
    expect(h.infoMessages).toHaveLength(1);
    expect(h.executed).toEqual([]);
  });

  it('with the entry, no notice appears', async () => {
    await activate({ withApi: true });
    expect(h.infoMessages).toEqual([]);
  });

  it('without the provider API, no notice appears even when the entry is missing', async () => {
    h.noProxy = [];
    await activate({ withApi: false });
    expect(h.infoMessages).toEqual([]);
  });
});

describe('Copy MCP diagnostics', () => {
  it('copies a report naming the running server, without the key, the Jira token or the Bitbucket token', async () => {
    h.token = 'jira-pat-secret-value-123';
    h.bitbucketToken = 'bitbucket-pat-secret-value-456';
    await activate({ withApi: true });
    const definition = offered()[0];
    h.chatSettings = { mcp: { serverSampling: { note: `Bearer ${bearerOf(definition)} ${h.token} ${h.bitbucketToken}` } } };
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    expect(h.clipboard).toContain(`State: running on 127.0.0.1:${portOf(definition)}`);
    expect(h.clipboard).toContain('MCP server offered: yes');
    expect(h.clipboard).toContain('Token present: yes');
    expect(h.clipboard).toContain('chat.mcp.serverSampling.note = "Bearer [redacted] [redacted] [redacted]"');
    expect(h.clipboard).not.toContain(bearerOf(definition));
    expect(h.clipboard).not.toContain(h.token);
    expect(h.clipboard).not.toContain(h.bitbucketToken);
    expect(h.clipboard).not.toContain('jira.example.com');
  });

  it('can be cancelled during the key search and still copies the report, with the search marked as cancelled', async () => {
    const copilot = path.join(tmp, 'copilot-home');
    fs.mkdirSync(copilot, { recursive: true });
    fs.writeFileSync(path.join(copilot, 'config.json'), '{}');
    await activate({ withApi: true });
    h.cancelRequested = true;
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    expect(h.progressOptions?.cancellable).toBe(true);
    expect(h.clipboard).toContain('State: running on 127.0.0.1:');
    expect(h.clipboard).toContain('search cancelled: 0 files checked; the rest was not searched');
    expect(h.infoMessages.at(-1)).toMatch(/copied to the clipboard/);
  });

  it('is registered and reports the missing provider API on an older VS Code', async () => {
    await activate({ withApi: false });
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    expect(h.clipboard).toContain('MCP server provider API present: no');
    expect(h.clipboard).toContain('MCP server offered: no (MCP server provider API missing)');
  });
});
