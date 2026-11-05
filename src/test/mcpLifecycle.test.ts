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
    get: (key: string, fallback?: unknown) => {
      if (section === 'http' && key === 'noProxy') return h.noProxy;
      if (section === 'ticketSidekick' && key === 'jira.baseUrl') return 'https://jira.example.com';
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
      showErrorMessage: async (message: string) => { h.infoMessages.push(message); return undefined; },
      withProgress: (_options: unknown, task: () => Promise<unknown>) => task(),
    },
    ProgressLocation: { Notification: 15 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/work/a' } }],
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
      get: async () => h.token,
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
});

afterEach(async () => {
  await deactivateMcp();
  delete process.env.COPILOT_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
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
  it('copies a report naming the running server, with neither the key nor the Jira token', async () => {
    h.token = 'jira-pat-secret-value-123';
    await activate({ withApi: true });
    const definition = offered()[0];
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    expect(h.clipboard).toContain(`State: running on 127.0.0.1:${portOf(definition)}`);
    expect(h.clipboard).toContain('MCP server offered: yes');
    expect(h.clipboard).toContain('Token present: yes');
    expect(h.clipboard).not.toContain(bearerOf(definition));
    expect(h.clipboard).not.toContain(h.token);
    expect(h.clipboard).not.toContain('jira.example.com');
  });

  it('is registered and reports the missing provider API on an older VS Code', async () => {
    await activate({ withApi: false });
    await h.commands.get(MCP_COMMANDS.copyDiagnostics)!();
    expect(h.clipboard).toContain('MCP server provider API present: no');
    expect(h.clipboard).toContain('MCP server offered: no (MCP server provider API missing)');
  });
});
