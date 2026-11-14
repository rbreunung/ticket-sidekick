import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drives the real `@jira` chat handler: the help turn, a request for a removed flow and an import request. `vscode` is
// mocked per the repo's per-test-file convention with just the surface JiraParticipant.ts touches; the Jira client is a
// stub that fails the test when it is called, and the model answers the intent parse with a fixed operation.
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
  JiraApiClient: vi.fn().mockImplementation(function () {
    return new Proxy({}, { get: (_t, name) => () => { throw new Error(`Jira was called: ${String(name)}`); } });
  }),
}));

const imports = vi.hoisted(() => ({ veracode: [] as unknown[] }));
vi.mock('../participant/jira/veracodeHandler', () => ({
  handleImportVeracodeReport: async (...args: unknown[]) => { imports.veracode.push(args[6]); },
  handleVeracodeTemplateSelection: async () => undefined,
  handleVeracodeReviewReply: async () => undefined,
  handleVeracodeAwaitIssueType: async () => undefined,
  handleVeracodeStaleClose: async () => undefined,
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

/** A model whose intent parse answers with the given operation. */
function modelAnswering(intent: Record<string, unknown>) {
  return { sendRequest: async () => ({ text: (async function* () { yield JSON.stringify(intent); })() }) };
}

async function turn(prompt: string, extension: unknown = { packageJSON: { version: '9.9.9' } }, model: unknown = undefined): Promise<{ text: string; result: unknown }> {
  createJiraParticipant(createContext(extension) as never, configService as never);
  const parts: string[] = [];
  const stream = { markdown: (m: unknown) => { parts.push(typeof m === 'string' ? m : (m as { value: string }).value); }, progress: () => undefined };
  const result = await h.handler!({ prompt, command: undefined, model }, { history: [] }, stream, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) });
  return { text: parts.join(''), result };
}

describe('@jira help screen', () => {
  beforeEach(() => { h.handler = undefined; });

  it.each(['', 'hi', 'help', 'what can you do'])('shows the imports-only help with the version for %j', async (prompt) => {
    const { text } = await turn(prompt);

    expect(text).toContain('**Ticket Sidekick `@jira` · v9.9.9 — Help**');
    expect(text).toContain('`import veracode report`');
    expect(text).toContain('`@jira` now only imports reports');
    expect(text).toContain('`/ts-jira help`');
    expect(text).not.toContain('/security-report');
    expect(text).not.toContain('`/create`');
  });

  it('still shows the help, with version unknown, when the extension has no package.json data', async () => {
    const { text } = await turn('help', null);

    expect(text).toContain('**Ticket Sidekick `@jira` · vunknown — Help**');
  });
});

describe('@jira and the flows it no longer runs', () => {
  beforeEach(() => { h.handler = undefined; imports.veracode = []; });

  it('answers a request for a removed flow with the notice and changes nothing in Jira', async () => {
    const { text } = await turn('move PROJ-1 to Done', undefined, modelAnswering({ operation: 'other', ticketKey: 'PROJ-1', projectKey: null }));

    expect(text).toContain('`@jira` now only imports reports');
    expect(text).toContain('Agent mode');
  });

  it('treats an operation it does not know as a removed flow', async () => {
    const { text } = await turn('transition these tickets', undefined, modelAnswering({ operation: 'bulkTransition' }));

    expect(text).toContain('`@jira` now only imports reports');
  });

  it('still starts a report import', async () => {
    const { text } = await turn('import veracode report for PROJ', undefined, modelAnswering({ operation: 'importVeracode', ticketKey: null, projectKey: 'PROJ' }));

    expect(imports.veracode).toEqual(['PROJ']);
    expect(text).not.toContain('now only imports reports');
  });
});
