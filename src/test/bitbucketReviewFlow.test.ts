import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Recorded-reply harness (KTD1): drives the real `@bitbucket` chat handler end to end with
// scripted model replies. `vscode` is mocked per the repo's per-test-file convention
// (docs/solutions/workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md)
// with only the surface BitbucketParticipant.ts touches; the Bitbucket client is swapped for
// MockBitbucketClient so no network is involved.
const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  client: undefined as unknown,
}));

vi.mock('vscode', () => {
  class ChatResponseTurn {
    constructor(public response: unknown[], public result: unknown, public participant = 'ticket-sidekick.bitbucket') {}
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
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined }),
      withProgress: (_opts: unknown, task: (progress: { report: () => void }) => unknown) => task({ report: () => undefined }),
    },
    ProgressLocation: { Window: 10 },
    commands: { executeCommand: async () => undefined },
    ChatResponseTurn,
    ChatRequestTurn,
    MarkdownString,
  };
});

vi.mock('../bitbucket/BitbucketApiClient', () => ({
  BitbucketApiClient: vi.fn().mockImplementation(() => h.client),
}));

import * as vscode from 'vscode';
import { createBitbucketParticipant } from '../participant/BitbucketParticipant';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { BitbucketConfig } from '../bitbucket/IBitbucketClient';

const PR_URL = 'https://bb.example.com/projects/PROJ/repos/repo/pull-requests/42';

/** A scripted reply: model text, or an error the stream throws. */
type ScriptedReply = string | Error;

/** A transient provider error, the kind the retry layer retries (`code: 'Unknown'`). */
function transientError(message = 'provider hiccup'): Error {
  return Object.assign(new Error(message), { code: 'Unknown' });
}

interface Harness {
  client: MockBitbucketClient;
  workspaceState: Map<string, unknown>;
  prompts: string[];
  /** Run one chat turn; `replies` is consumed in call order, and running out fails the call. */
  turn(prompt: string, replies: ScriptedReply[], history?: unknown[]): Promise<{ text: string; result: unknown }>;
}

function createHarness(config: Partial<BitbucketConfig> = {}): Harness {
  const client = new MockBitbucketClient();
  h.client = client;
  const workspaceState = new Map<string, unknown>();
  const prompts: string[] = [];
  const fullConfig = {
    authType: 'datacenter', baseUrl: 'https://bb.example.com', token: 'test-token',
    reviewMode: 'standard', confidenceThreshold: 0.7, reviewContextLines: 12,
    ...config,
  } as BitbucketConfig;
  const context = {
    workspaceState: {
      get: (key: string) => workspaceState.get(key),
      update: async (key: string, value: unknown) => { workspaceState.set(key, value); },
    },
    subscriptions: [] as unknown[],
  };
  const configService = {
    getBitbucketConfig: async () => fullConfig,
    isBitbucketConfigured: () => true,
  };
  createBitbucketParticipant(context as never, configService as never);

  return {
    client,
    workspaceState,
    prompts,
    async turn(prompt, replies, history = []) {
      const queue = [...replies];
      const model = {
        vendor: 'test', family: 'test', id: 'test-model', version: '1', maxInputTokens: 128_000,
        sendRequest: async (messages: Array<{ content: string }>) => {
          prompts.push(messages.map((m) => m.content).join('\n'));
          const next = queue.shift();
          if (next === undefined) throw new Error('recorded-reply harness: no scripted reply left');
          if (next instanceof Error) throw next;
          return { text: (async function* () { yield next; })() };
        },
      };
      const out: string[] = [];
      const stream = { markdown: (m: string | { value: string }) => { out.push(typeof m === 'string' ? m : m.value); } };
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
      const run = h.handler!({ prompt, command: undefined, model }, { history }, stream, token);
      // Retry backoff runs on fake timers; advance until the turn settles.
      let settled = false;
      const result = run.finally(() => { settled = true; });
      while (!settled) await vi.advanceTimersByTimeAsync(1_000);
      return { text: out.join(''), result: await result };
    },
  };
}

/** A prior assistant turn carrying session metadata, so the next turn continues that session. */
function sessionTurn(result: unknown): unknown {
  return new (vscode as unknown as { ChatResponseTurn: new (r: unknown[], res: unknown) => unknown }).ChatResponseTurn([], result);
}

/** One NDJSON finding line. */
function findingLine(file: string, anchorCode: string, title: string, severity = 'warning'): string {
  return JSON.stringify({
    file, anchorCode, title, severity, confidence: 0.9,
    description: `${title} description`, recommendation: `Fix ${title}`,
  });
}

const META_LINE = '{"additionalFilesNeeded":[]}';

// The `bitbucket-diff.json` fixture's added lines, usable as anchors.
const LOGIN_ANCHOR = 'const user = await db.query(`SELECT * FROM users WHERE username = ${username}`);';
const TOKEN_ANCHOR = "localStorage.setItem('auth_token', token);";

describe('recorded-reply harness (U6)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs a standard review end to end and stores the review session', async () => {
    const harness = createHarness();
    const { text, result } = await harness.turn(PR_URL, [
      [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n'),
    ]);

    expect(text).toContain('SQL injection');
    expect(text).toContain('src/auth/login.ts:L39');
    expect(harness.prompts).toHaveLength(1);
    expect(result).toMatchObject({ metadata: { bitbucketSession: { kinds: ['review-session'] } } });
    const session = harness.workspaceState.get('bitbucket.session.review') as { findings: Array<{ title: string }> };
    expect(session.findings.map((f) => f.title)).toEqual(['SQL injection']);
  });

  it('shows the partial-failure banner when a batch fails on every try', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [
      transientError(), transientError(), transientError(), transientError(),
    ]);

    expect(text).toContain('Some batches had failures after retrying');
    expect(text).toContain('No issues found');
  });
});
