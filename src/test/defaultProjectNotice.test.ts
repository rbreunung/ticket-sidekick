import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The warning about a wrong ticketSidekick.jira.defaultProject: shown at start and once typing in
// the setting has stopped, with a button that opens the setting, which the extension never writes.

const h = vi.hoisted(() => ({
  defaultProject: undefined as string | undefined,
  warnings: [] as string[],
  choice: undefined as string | undefined,
  executed: [] as unknown[][],
  configUpdates: 0,
  listeners: [] as Array<(e: { affectsConfiguration(key: string): boolean }) => void>,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'jira.defaultProject' ? h.defaultProject : undefined),
      update: async () => { h.configUpdates++; },
    }),
    onDidChangeConfiguration: (listener: (e: { affectsConfiguration(key: string): boolean }) => void) => {
      h.listeners.push(listener);
      return { dispose: () => undefined };
    },
  },
  window: {
    showWarningMessage: async (message: string) => { h.warnings.push(message); return h.choice; },
    createOutputChannel: () => ({ appendLine: () => undefined }),
  },
  commands: { executeCommand: async (...args: unknown[]) => { h.executed.push(args); } },
}));

import { registerDefaultProjectCheck, DEFAULT_PROJECT_CHECK_DELAY_MS } from '../participant/jira/defaultProjectNotice';

// Jira is not set up in these tests, so only the key's shape is checked and no request is made.
const configService = {
  getConfig: async () => ({ baseUrl: undefined, token: undefined, authType: 'datacenter' }),
  isConfigured: () => false,
};

function register() {
  const context = { subscriptions: [] as Array<{ dispose(): void }> };
  registerDefaultProjectCheck(context as never, configService as never);
  return context;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function change(key: string) {
  for (const l of h.listeners) l({ affectsConfiguration: k => k === key });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.defaultProject = undefined;
  h.warnings = [];
  h.choice = undefined;
  h.executed = [];
  h.configUpdates = 0;
  h.listeners = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the default project warning', () => {
  it('appears at start for a value that is not a project key, and Open Setting opens the setting', async () => {
    h.defaultProject = 'PROJ-1';
    h.choice = 'Open Setting';
    register();
    await flush();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('"PROJ-1"');
    expect(h.executed).toEqual([['workbench.action.openSettings', 'ticketSidekick.jira.defaultProject']]);
    expect(h.configUpdates).toBe(0);
  });

  it('does not appear for a well-formed key or an empty setting', async () => {
    h.defaultProject = 'PROJ';
    register();
    await flush();
    h.defaultProject = '';
    change('ticketSidekick.jira.defaultProject');
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_CHECK_DELAY_MS);
    expect(h.warnings).toEqual([]);
  });

  it('checks a changed setting once typing has stopped, not at every keystroke', async () => {
    h.defaultProject = 'PROJ';
    register();
    await flush();
    for (const typed of ['P', 'PR', 'PR ', 'PR O']) {
      h.defaultProject = typed;
      change('ticketSidekick.jira.defaultProject');
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(h.warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_CHECK_DELAY_MS);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('"PR O"');
  });

  it('ignores changes to other settings', async () => {
    h.defaultProject = 'PROJ';
    register();
    await flush();
    h.defaultProject = 'bad key';
    change('ticketSidekick.jira.baseUrl');
    await vi.advanceTimersByTimeAsync(DEFAULT_PROJECT_CHECK_DELAY_MS * 2);
    expect(h.warnings).toEqual([]);
  });
});
