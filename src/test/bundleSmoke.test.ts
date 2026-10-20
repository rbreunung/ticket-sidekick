import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';

// Loads the *bundled* extension (out/extension.js, what the .vsix ships) with a stubbed `vscode`
// and runs activate(). Unit tests import the TypeScript sources, so a dependency that breaks only
// once bundled (a CJS/ESM mismatch after an upgrade, a missing external) would otherwise first show
// up when a user installs the extension. It also checks that everything package.json declares
// (commands, chat participants, language model tools) is actually registered on activation.

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands?: { command: string }[];
    chatParticipants?: { id: string }[];
    languageModelTools?: { name: string }[];
  };
};

const registered = { commands: [] as string[], participants: [] as string[], tools: [] as string[] };

// A permissive stand-in for everything the extension touches at import time or on activation:
// any property is a callable, constructible stub; the three registration points record their ids.
function stub(): unknown {
  const target = function () { /* callable + constructible */ };
  return new Proxy(target, {
    get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : stub()),
    apply: () => stub(),
    construct: () => stub() as object,
  });
}

function memento() {
  const store = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: async (key: string, value: unknown) => { store.set(key, value); },
    keys: () => [...store.keys()],
    setKeysForSync: () => undefined,
  };
}

function buildVscodeStub(): Record<string, unknown> {
  const disposable = { dispose: () => undefined };
  // A plain object, not a Proxy: esbuild's `import * as vscode` interop copies the module's own
  // properties, so every top-level name the sources use has to exist as a real key.
  return {
    commands: {
      registerCommand: (id: string) => { registered.commands.push(id); return disposable; },
      executeCommand: async () => undefined,
    },
    chat: {
      createChatParticipant: (id: string) => {
        registered.participants.push(id);
        return { dispose: () => undefined, iconPath: undefined, followupProvider: undefined };
      },
    },
    lm: {
      registerTool: (name: string) => { registered.tools.push(name); return disposable; },
      selectChatModels: async () => [],
      tools: [],
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (_k: string, fallback?: unknown) => fallback, update: async () => undefined, has: () => false }),
      onDidChangeConfiguration: () => disposable,
      fs: stub(),
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, show: () => undefined, dispose: () => undefined }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    env: stub(),
    Uri: { file: (p: string) => ({ fsPath: p }), joinPath: (u: { fsPath: string }, ...s: string[]) => ({ fsPath: path.join(u.fsPath, ...s) }) },
    MarkdownString: class { constructor(public value = '') {} },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15, Window: 10 },
    LanguageModelChatMessage: { User: (content: unknown) => ({ role: 1, content }), Assistant: (content: unknown) => ({ role: 2, content }) },
    LanguageModelError: class extends Error {},
    LanguageModelTextPart: class { constructor(public value: string) {} },
    LanguageModelToolResult: class { constructor(public content: unknown[]) {} },
    ChatRequestTurn: class {},
    ChatResponseTurn: class {},
    ChatResponseMarkdownPart: class {},
    Location: class {},
    Disposable: class { constructor(public dispose: () => void = () => undefined) {} },
  };
}

function buildContext() {
  return {
    subscriptions: [] as { dispose?: () => void }[],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    workspaceState: memento(),
    globalState: memento(),
    extensionUri: { fsPath: root },
    extensionPath: root,
    extension: { id: 'rbreunung.ticket-sidekick' },
    globalStorageUri: { fsPath: path.join(root, '.smoke-storage') },
  };
}

describe('bundled extension (out/extension.js)', () => {
  type ModuleWithLoad = { _load: (request: string, ...rest: unknown[]) => unknown };
  const nodeRequire = createRequire(__filename);
  const Module = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = Module._load;
  const bundle = path.join(root, 'out', 'extension.js');

  beforeAll(() => {
    execFileSync(process.execPath, ['esbuild.js'], { cwd: root, stdio: 'pipe' });
    const vscodeStub = buildVscodeStub();
    Module._load = (request: string, ...rest: unknown[]) => (request === 'vscode' ? vscodeStub : originalLoad.call(Module, request, ...rest));
  }, 120_000);

  afterAll(() => {
    Module._load = originalLoad;
    delete nodeRequire.cache[bundle];
  });

  it('activates without throwing', () => {
    const extension = nodeRequire(bundle) as { activate: (ctx: unknown) => void };
    expect(() => extension.activate(buildContext())).not.toThrow();
  });

  it('registers every command package.json declares', () => {
    const declared = (manifest.contributes.commands ?? []).map(c => c.command);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(id => !registered.commands.includes(id))).toEqual([]);
  });

  it('creates exactly the chat participants package.json declares', () => {
    const declared = (manifest.contributes.chatParticipants ?? []).map(p => p.id).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...registered.participants].sort()).toEqual(declared);
  });

  it('registers exactly the language model tools package.json declares', () => {
    const declared = (manifest.contributes.languageModelTools ?? []).map(t => t.name).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...registered.tools].sort()).toEqual(declared);
  });
});
