import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Covers the VS Code glue of the Copilot harness prototype: the start notification, the commands,
// the MCP server definition the provider offers, and that nothing is ever written to settings or
// extension state. `vscode` is mocked per this repo's per-test-file convention.

const h = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  infoMessages: [] as string[],
  infoChoice: undefined as string | undefined,
  pendingNotification: undefined as Promise<unknown> | undefined,
  clipboard: undefined as string | undefined,
  configUpdates: 0,
  lm: {} as Record<string, unknown>,
  providers: [] as Array<{ provideMcpServerDefinitions: () => unknown; onDidChangeMcpServerDefinitions?: (l: () => void) => unknown }>,
  changeEvents: 0,
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
  const configuration = {
    get: (_key: string, fallback?: unknown) => (_key === 'jira.defaultProject' ? 'PROJ' : fallback),
    update: async () => { h.configUpdates++; },
    has: () => false,
    inspect: () => undefined,
  };
  return {
    version: '1.144.0',
    EventEmitter,
    McpHttpServerDefinition,
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    lm: h.lm,
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => { h.commands.set(id, fn); return { dispose: () => undefined }; },
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined }),
      showInformationMessage: (message: string, ...choices: string[]) => {
        h.infoMessages.push(message);
        const result = Promise.resolve(choices.length ? h.infoChoice : undefined);
        if (choices.length) h.pendingNotification = result;
        return result;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async (message: string) => { h.infoMessages.push(message); return undefined; },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/work/a' } }],
      getConfiguration: () => configuration,
    },
    env: { clipboard: { writeText: async (text: string) => { h.clipboard = text; } } },
  };
});

import { registerPrototype, deactivatePrototype, PROTOTYPE_COMMANDS } from '../prototype/register';
import { ConfigService } from '../services/ConfigService';

let tmp: string;
let stateUpdates: number;

function makeContext() {
  const extensionPath = path.join(tmp, 'ext');
  const launcher = path.join(extensionPath, 'out', 'prototype-launcher');
  fs.mkdirSync(launcher, { recursive: true });
  fs.writeFileSync(path.join(launcher, 'extension.mjs'), 'export {};');
  fs.writeFileSync(path.join(launcher, 'package.json'), '{}');
  const memento = { get: () => undefined, update: async () => { stateUpdates++; }, keys: () => [], setKeysForSync: () => undefined };
  return {
    extensionPath,
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: memento,
    workspaceState: memento,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    logUri: { fsPath: path.join(tmp, 'logs', 'session', 'exthost', 'ticket-sidekick') },
    globalStorageUri: { fsPath: path.join(tmp, 'User', 'globalStorage', 'ticket-sidekick') },
    storageUri: undefined,
    extension: { packageJSON: { version: '0.0.0-test' } },
  };
}

function prototypeFolder(): string {
  return path.join(tmp, 'copilot-home', 'extensions', 'ticket-sidekick');
}

function offeredDefinitions(): Array<{ label: string; uri: { toString(): string }; headers?: Record<string, string> }> {
  return h.providers[0].provideMcpServerDefinitions() as Array<{ label: string; uri: { toString(): string }; headers?: Record<string, string> }>;
}

async function activate(opts: { withApi: boolean; choice?: string }) {
  if (opts.withApi) {
    h.lm.registerMcpServerDefinitionProvider = (_id: string, provider: (typeof h.providers)[number]) => {
      h.providers.push(provider);
      return { dispose: () => undefined };
    };
  } else {
    delete h.lm.registerMcpServerDefinitionProvider;
  }
  h.infoChoice = opts.choice;
  const context = makeContext();
  registerPrototype(context as never, new ConfigService(context as never));
  await h.pendingNotification;
  await new Promise(resolve => setTimeout(resolve, 50));
  return context;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-life-'));
  process.env.COPILOT_HOME = path.join(tmp, 'copilot-home');
  stateUpdates = 0;
  h.commands.clear();
  h.infoMessages = [];
  h.pendingNotification = undefined;
  h.providers = [];
  h.changeEvents = 0;
  h.configUpdates = 0;
  h.clipboard = undefined;
});

afterEach(async () => {
  await deactivatePrototype();
  delete process.env.COPILOT_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('prototype glue without the MCP provider API', () => {
  it('registers every prototype command, shows no notification and starts nothing', async () => {
    await activate({ withApi: false });
    expect([...h.commands.keys()]).toEqual(expect.arrayContaining(Object.values(PROTOTYPE_COMMANDS)));
    expect(h.infoMessages).toEqual([]);
    await h.commands.get(PROTOTYPE_COMMANDS.start)!();
    expect(h.infoMessages.join('\n')).toMatch(/needs a VS Code version/);
    expect(fs.existsSync(prototypeFolder())).toBe(false);
  });
});

describe('prototype glue with the MCP provider API', () => {
  it('choosing "Not now" opens nothing, places nothing and offers no MCP server', async () => {
    await activate({ withApi: true, choice: 'Not now' });
    expect(h.infoMessages[0]).toMatch(/start a key-protected server on 127\.0\.0\.1/);
    expect(offeredDefinitions()).toEqual([]);
    expect(fs.existsSync(prototypeFolder())).toBe(false);
  });

  it('"Start for this session" offers one HTTP definition with a bearer header and places the launcher', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    const definitions = offeredDefinitions();
    expect(definitions).toHaveLength(1);
    expect(definitions[0].label).toBe('Ticket Sidekick (prototype)');
    expect(definitions[0].uri.toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(definitions[0].headers?.Authorization).toMatch(/^Bearer /);
    expect(h.changeEvents).toBe(1);
    expect(fs.existsSync(path.join(prototypeFolder(), 'extension.mjs'))).toBe(true);
  });

  it('a stop and a new start offer a different key', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    const first = offeredDefinitions()[0].headers?.Authorization;
    await h.commands.get(PROTOTYPE_COMMANDS.stop)!();
    expect(offeredDefinitions()).toEqual([]);
    await h.commands.get(PROTOTYPE_COMMANDS.start)!();
    expect(offeredDefinitions()[0].headers?.Authorization).not.toBe(first);
  });

  it('stop removes the launcher folder and the MCP server', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    await h.commands.get(PROTOTYPE_COMMANDS.stop)!();
    expect(fs.existsSync(prototypeFolder())).toBe(false);
    expect(offeredDefinitions()).toEqual([]);
  });

  it('writes no setting or extension state across start, report, stop and cleanup', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    await h.commands.get(PROTOTYPE_COMMANDS.copyReport)!();
    await h.commands.get(PROTOTYPE_COMMANDS.stop)!();
    await h.commands.get(PROTOTYPE_COMMANDS.start)!();
    await h.commands.get(PROTOTYPE_COMMANDS.removeLeftovers)!();
    expect(stateUpdates).toBe(0);
    expect(h.configUpdates).toBe(0);
    expect(fs.existsSync(prototypeFolder())).toBe(false);
  });

  it('copies a report that names the running server and contains neither key', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    const bearer = offeredDefinitions()[0].headers?.Authorization?.slice('Bearer '.length) ?? '';
    await h.commands.get(PROTOTYPE_COMMANDS.copyReport)!();
    expect(h.clipboard).toContain('State: running on 127.0.0.1:');
    expect(h.clipboard).not.toContain(bearer);
    const entry = JSON.parse(fs.readFileSync(path.join(prototypeFolder(), 'rendezvous', `window-${process.pid}.json`), 'utf8')) as { canvasKey: string };
    expect(h.clipboard).not.toContain(entry.canvasKey);
  });

  it('deactivation stops the prototype and removes its folder', async () => {
    await activate({ withApi: true, choice: 'Start for this session' });
    await deactivatePrototype();
    expect(fs.existsSync(prototypeFolder())).toBe(false);
  });
});
