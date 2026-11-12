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

  it('registers no Jira Agent Mode tool, since the Jira tools are on the MCP server', () => {
    expect(registered.tools.filter(name => name.startsWith('jira_'))).toEqual([]);
  });
});

describe('the agent plugin with the canvas program', () => {
  const pluginPath = (manifest.contributes as { chatPlugins?: Array<{ path: string }> }).chatPlugins?.[0]?.path ?? '';
  const pluginDir = path.join(root, pluginPath);
  const canvasDir = path.join(pluginDir, 'com.github.copilot', 'extensions', 'ticket-sidekick');

  beforeAll(() => {
    execFileSync(process.execPath, ['esbuild.js'], { cwd: root, stdio: 'pipe' });
  }, 120_000);

  it('is contributed from the build output and carries the extension\'s version', () => {
    expect(pluginPath).toBe('./out/plugin');
    const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    expect(plugin.name).toBe('ticket-sidekick');
    expect(plugin.version).toBe((manifest as { version?: string }).version);
  });

  it('contains the bundled canvas program as an ES module', () => {
    expect(fs.existsSync(path.join(canvasDir, 'extension.mjs'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(canvasDir, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', main: 'extension.mjs' });
  });

  it('carries a skill, so VS Code 1.146 does not drop it as an empty plugin', () => {
    const skill = fs.readFileSync(path.join(pluginDir, 'skills', 'ts-boards', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: ts-boards\n/);
    for (const id of ['security-report', 'ticket-list', 'sessions']) expect(skill).toContain(`\`${id}\``);
  });

  it('is packaged into the .vsix', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('!out/plugin/**');
  });

  it('ships the board pages with the shared client, style and the VS Code Elements bundle', () => {
    const pages = path.join(root, 'out', 'canvas-pages');
    for (const file of ['shared/board.js', 'shared/board.css', 'shared/vscode-elements.js', 'security-report/index.html', 'security-report/page.js', 'ticket-list/index.html', 'ticket-list/page.js', 'sessions/index.html', 'sessions/page.js']) {
      expect(fs.existsSync(path.join(pages, file)), file).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')).toContain('!out/canvas-pages/**');
  });

  it('loads no script or style from the web in a board page', () => {
    const pages = path.join(root, 'canvas-pages');
    for (const board of ['security-report', 'ticket-list', 'sessions']) {
      const html = fs.readFileSync(path.join(pages, board, 'index.html'), 'utf8');
      expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|style=/);
    }
  });
});

