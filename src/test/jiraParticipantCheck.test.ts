import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drives the real `@jira` chat handler for the connection check (`check`, `check connection`,
// `/check`) and pins its exact output, so the check can be shared with the MCP check connection
// tool without changing what `@jira check` shows. `vscode` is mocked per the repo's per-test-file
// convention with just the surface JiraParticipant.ts touches before it reaches the check.
const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  getCurrentUser: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock('vscode', () => {
  class ChatResponseTurn {
    constructor(public response: unknown[], public result: unknown, public participant = 'ticket-sidekick.jira') {}
  }
  class ChatRequestTurn {
    constructor(public prompt: string) {}
  }
  class MarkdownString {
    isTrusted?: unknown;
    constructor(public value = '') {}
  }
  return {
    chat: {
      createChatParticipant: (_id: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        h.handler = handler;
        return { dispose: () => undefined };
      },
    },
    LanguageModelChatMessage: {
      User: (content: string) => ({ role: 'user', content }),
      Assistant: (content: string) => ({ role: 'assistant', content }),
    },
    window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
    workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) },
    commands: { executeCommand: async () => undefined },
    ChatResponseTurn,
    ChatRequestTurn,
    MarkdownString,
  };
});

vi.mock('../jira/JiraApiClient', () => ({
  JiraApiClient: vi.fn().mockImplementation(function () {
    return { getCurrentUser: () => h.getCurrentUser!() };
  }),
}));

import { createJiraParticipant } from '../participant/JiraParticipant';

interface TestConfig {
  baseUrl: string | undefined;
  authType: 'datacenter' | 'cloud';
  token: string | undefined;
  showConnectionInfo?: boolean;
}

function createContext() {
  const state = new Map<string, unknown>();
  return {
    workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    globalState: { get: () => undefined, update: async () => undefined },
    subscriptions: [] as unknown[],
    extension: { packageJSON: { version: '9.9.9' } },
  };
}

interface Part { value: string; isTrusted?: unknown }

async function check(config: TestConfig, prompt = 'check', command?: string): Promise<Part[]> {
  const configService = {
    getConfig: async () => ({ showConnectionInfo: false, ...config }),
    isConfigured: (c: TestConfig) => !!(c.baseUrl && c.token),
  };
  createJiraParticipant(createContext() as never, configService as never);
  const parts: Part[] = [];
  const stream = {
    markdown: (m: unknown) => {
      parts.push(typeof m === 'string' ? { value: m } : { value: (m as Part).value, isTrusted: (m as Part).isTrusted });
    },
    progress: () => undefined,
  };
  await h.handler!({ prompt, command, model: undefined }, { history: [] }, stream, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
  return parts;
}

const dc: TestConfig = { baseUrl: 'https://jira.example.com', authType: 'datacenter', token: 'secret-token' };

describe('@jira check output', () => {
  beforeEach(() => {
    h.handler = undefined;
    h.getCurrentUser = async () => ({ displayName: 'Test User', name: 'tuser' });
  });

  it.each([
    ['check', undefined],
    ['check connection', undefined],
    ['Check Setup', undefined],
    ['', 'check'],
  ])('reports a working connection for prompt %j / command %j', async (prompt, command) => {
    const parts = await check(dc, prompt, command);

    expect(parts).toEqual([{
      value:
        '**Jira connection OK**\n\n' +
        '| Setting | Value |\n' +
        '|---|---|\n' +
        '| Base URL | `https://jira.example.com` |\n' +
        '| API version | v2 |\n' +
        '| Auth type | datacenter |\n' +
        '| Token | present (12 chars) |\n' +
        '| Logged in as | Test User |\n',
    }]);
  });

  it('puts the connection info line first when showConnectionInfo is on', async () => {
    const parts = await check({ ...dc, authType: 'cloud', showConnectionInfo: true });

    expect(parts[0]).toEqual({ value: '_https://jira.example.com · API v2 · cloud_\n\n' });
    expect(parts[1].value).toContain('| Auth type | cloud |');
  });

  it('reports a failed connection with the settings table and the error', async () => {
    h.getCurrentUser = async () => { throw new Error('Jira API error 401: Unauthorized'); };

    const parts = await check(dc);

    expect(parts).toEqual([{
      value:
        '**Jira connection failed**\n\n' +
        '| Setting | Value |\n' +
        '|---|---|\n' +
        '| Base URL | `https://jira.example.com` |\n' +
        '| API version | v2 |\n' +
        '| Auth type | datacenter |\n' +
        '| Token | present (12 chars) |\n\n' +
        'Error: Jira API error 401: Unauthorized',
    }]);
  });

  it('reports a malformed base URL as a configuration problem without calling Jira', async () => {
    h.getCurrentUser = async () => { throw new Error('must not be called'); };

    const parts = await check({ ...dc, baseUrl: 'ftp://jira.example.com' });

    expect(parts).toEqual([{
      value: '**Jira configuration problem**\n\nBase URL "ftp://jira.example.com" must start with http:// or https:// (got "ftp:").',
    }]);
  });

  it('points at the base URL setting when none is configured', async () => {
    const parts = await check({ ...dc, baseUrl: undefined });

    expect(parts).toEqual([{
      value:
        '**Jira base URL not configured.**\n\n' +
        'Add `ticketSidekick.jira.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`), ' +
        'or [open Settings](command:workbench.action.openSettings?%22ticketSidekick.jira.baseUrl%22) directly.',
      isTrusted: { enabledCommands: ['workbench.action.openSettings'] },
    }]);
  });

  it.each([
    ['datacenter', 'Ticket Sidekick: Set Jira Personal Access Token', 'ticket-sidekick.setDataCenterToken'],
    ['cloud', 'Ticket Sidekick: Configure Jira Cloud Credentials', 'ticket-sidekick.configureCloud'],
  ] as const)('points at the %s credentials command when no token is stored', async (authType, label, command) => {
    const parts = await check({ ...dc, authType, token: undefined });

    expect(parts).toEqual([{
      value: `**Jira credentials not configured.**\n\nRun [${label}](command:${command}) from the chat, or find it in the Command Palette.`,
      isTrusted: { enabledCommands: [command] },
    }]);
  });
});
