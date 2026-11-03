import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drives the real `@jira` chat handler for the greeting/help turn only. `vscode` is mocked per the repo's per-test-file
// convention with just the surface JiraParticipant.ts touches before it reaches the greeting check; the Jira client is a
// stub because a help turn never calls it.
const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
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
  JiraApiClient: vi.fn().mockImplementation(function () { return {}; }),
}));

import { createJiraParticipant } from '../participant/JiraParticipant';

function createContext(extension: unknown) {
  const state = new Map<string, unknown>();
  return {
    workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
    globalState: { get: () => undefined, update: async () => undefined },
    subscriptions: [] as unknown[],
    extension,
  };
}

const configService = {
  getConfig: async () => ({ baseUrl: 'https://jira.example.com', authType: 'datacenter', token: 't', showConnectionInfo: false }),
  isConfigured: () => true,
};

async function turn(prompt: string, extension: unknown = { packageJSON: { version: '9.9.9' } }, command?: string): Promise<{ text: string; result: unknown }> {
  createJiraParticipant(createContext(extension) as never, configService as never);
  const parts: string[] = [];
  const stream = { markdown: (m: unknown) => { parts.push(typeof m === 'string' ? m : (m as { value: string }).value); }, progress: () => undefined };
  const result = await h.handler!({ prompt, command, model: undefined }, { history: [] }, stream, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
  return { text: parts.join(''), result };
}

describe('@jira help screen', () => {
  beforeEach(() => { h.handler = undefined; });

  it.each(['', 'hi', 'help', 'what can you do'])('shows the full help with the version for %j and keeps the greeting chips', async (prompt) => {
    const { text, result } = await turn(prompt);

    expect(text).toContain('**Ticket Sidekick `@jira` · v9.9.9 — Help**');
    expect(text).toContain('**Security report**');
    expect(text).toContain('`/security-report PROJ`');
    expect(text).not.toContain('manages Jira tickets in natural language');
    expect((result as { metadata: { jiraFollowup: { kind: string } } }).metadata.jiraFollowup.kind).toBe('greeting');
  });

  it('still shows the help, with version unknown, when the extension has no package.json data', async () => {
    const { text } = await turn('help', null);

    expect(text).toContain('**Ticket Sidekick `@jira` · vunknown — Help**');
  });

  it('does not show the help for an operation prompt that merely contains a greeting word', async () => {
    const { text } = await turn('update HI-1 status');

    expect(text).not.toContain('— Help**');
  });
});
