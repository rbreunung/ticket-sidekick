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
/** Replies in call order, or a responder that picks a reply from the prompt it was sent. */
type Script = ScriptedReply[] | ((prompt: string, callIndex: number) => ScriptedReply);

/** A transient provider error, the kind the retry layer retries (`code: 'Unknown'`). */
function transientError(message = 'provider hiccup'): Error {
  return Object.assign(new Error(message), { code: 'Unknown' });
}

interface Harness {
  client: MockBitbucketClient;
  workspaceState: Map<string, unknown>;
  prompts: string[];
  /** Run one chat turn. A reply list is consumed in call order, and running out fails the call. */
  turn(prompt: string, script: Script, history?: unknown[]): Promise<{ text: string; result: unknown }>;
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
    async turn(prompt, script, history = []) {
      const queue = Array.isArray(script) ? [...script] : [];
      let callIndex = 0;
      const model = {
        vendor: 'test', family: 'test', id: 'test-model', version: '1', maxInputTokens: 128_000,
        sendRequest: async (messages: Array<{ content: string }>) => {
          const sent = messages.map((m) => m.content).join('\n');
          prompts.push(sent);
          const next = Array.isArray(script) ? queue.shift() : script(sent, callIndex++);
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

/** A unified diff of added-only files; each file's lines are added at new-file line 1 onward. */
function makeDiff(files: Array<{ path: string; lines: string[] }>): string {
  return files.map(({ path, lines }) => [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`),
  ].join('\n')).join('\n') + '\n';
}

/** A file body big enough (~5k chars) that each file fills its own chunk at a 3k-token budget. */
function bulkyLines(tag: string): string[] {
  return [`const ${tag}Value = compute${tag}();`, ...Array.from({ length: 120 }, (_, i) => `// ${tag} filler line ${i} ${'x'.repeat(30)}`)];
}

const isPersonaPrompt = (prompt: string, lens: string): boolean => prompt.includes(`through a ${lens} lens ONLY`);
const isCriticPrompt = (prompt: string): boolean => prompt.includes('You are verifying the findings of a code review');

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

describe('a bad reply never sinks the review (U7)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const threeFiles = makeDiff([
    { path: 'src/f1.ts', lines: bulkyLines('One') },
    { path: 'src/f2.ts', lines: bulkyLines('Two') },
    { path: 'src/f3.ts', lines: bulkyLines('Three') },
  ]);
  const smallBudget = { modelContextTokens: 3_000, contextBudgetRatio: 1 };

  // AE1 / R1: one persona answering with prose must not throw away every other chunk's findings.
  it('completes a deep review when one persona answers a chunk with prose on every try', async () => {
    const harness = createHarness({ ...smallBudget, reviewMode: 'deep' });
    harness.client.rawDiff = threeFiles;
    const { text } = await harness.turn(PR_URL, (prompt) => {
      if (isCriticPrompt(prompt)) return '{"keep":[1]}';
      if (isPersonaPrompt(prompt, 'security') && prompt.includes('### File: src/f2.ts')) return 'No security issues found.';
      if (prompt.includes('lens ONLY')) return META_LINE;
      const n = ['One', 'Two', 'Three'].find((t) => prompt.includes(`### File: src/f${['One', 'Two', 'Three'].indexOf(t) + 1}.ts`))!;
      const idx = ['One', 'Two', 'Three'].indexOf(n) + 1;
      return [findingLine(`src/f${idx}.ts`, `const ${n}Value = compute${n}();`, `Issue in ${n}`), META_LINE].join('\n');
    });

    expect(text).not.toContain('Review failed');
    for (const n of ['One', 'Two', 'Three']) expect(text).toContain(`Issue in ${n}`);
    expect(text).toContain('Security pass — batch 2 — could not review src/f2.ts');
  });

  it('shows the other chunks when one chunk returns an empty reply on every try', async () => {
    const harness = createHarness(smallBudget);
    harness.client.rawDiff = threeFiles;
    const { text } = await harness.turn(PR_URL, (prompt) => {
      if (prompt.includes('### File: src/f1.ts')) return '';
      if (prompt.includes('### File: src/f2.ts')) return [findingLine('src/f2.ts', 'const TwoValue = computeTwo();', 'Issue in Two'), META_LINE].join('\n');
      return META_LINE;
    });

    expect(text).not.toContain('Review failed');
    expect(text).toContain('Issue in Two');
    expect(text).toContain('could not review src/f1.ts');
  });

  it('retries a prose reply and uses the valid reply that follows, with no notice', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [
      'Looks good to me.',
      [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n'),
    ]);

    expect(harness.prompts).toHaveLength(2);
    expect(text).toContain('SQL injection');
    expect(text).not.toContain('could not review');
  });

  // AE2 / R4: a reply missing only its meta line is complete.
  it('makes exactly one call and shows no truncation warning when the meta line is missing', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [
      findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'),
    ]);

    expect(harness.prompts).toHaveLength(1);
    expect(text).not.toContain('truncated');
    expect(text).toContain('SQL injection');
  });

  // R5 / KTD4: the continuation re-reviews the whole batch with what was already reported.
  it('runs one continuation over the whole batch, listing what was already reported, after a cut-off reply', async () => {
    const harness = createHarness();
    const cut = [
      findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'),
      findingLine('src/auth/tokenStore.ts', TOKEN_ANCHOR, 'Token in localStorage'),
      '{"file":"src/auth/login.ts","anchorCode":"res.json',
    ].join('\n');
    const continuation = [
      findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'Unvalidated username'),
      findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'),
      META_LINE,
    ].join('\n');
    const { text } = await harness.turn(PR_URL, [cut, continuation]);

    expect(harness.prompts).toHaveLength(2);
    const contPrompt = harness.prompts[1];
    expect(contPrompt).toContain('Already reported');
    expect(contPrompt).toContain('SQL injection');
    expect(contPrompt).toContain('Token in localStorage');
    expect(contPrompt).toContain('### File: src/auth/login.ts');
    expect(contPrompt).toContain('### File: src/auth/tokenStore.ts');
    expect(text).toContain('Unvalidated username');
    const session = harness.workspaceState.get('bitbucket.session.review') as { findings: Array<{ title: string }> };
    expect(session.findings.filter((f) => f.title === 'SQL injection')).toHaveLength(1);
  });

  it('runs a continuation for a persona pass whose reply is cut off', async () => {
    const harness = createHarness({ reviewMode: 'smart' });
    const { text } = await harness.turn(PR_URL, (prompt) => {
      if (isPersonaPrompt(prompt, 'security')) {
        if (prompt.includes('Already reported')) return [findingLine('src/auth/tokenStore.ts', TOKEN_ANCHOR, 'Token readable by scripts', 'critical'), META_LINE].join('\n');
        return [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'Injection risk', 'critical'), '{"file":"src/auth/tok'].join('\n');
      }
      return [META_LINE.replace('}', ',"recommendedPersonas":["security"]}')].join('\n');
    });

    const securityPrompts = harness.prompts.filter((p) => isPersonaPrompt(p, 'security'));
    expect(securityPrompts).toHaveLength(2);
    expect(securityPrompts[1]).toContain('Injection risk');
    expect(text).toContain('Token readable by scripts');
  });
});
