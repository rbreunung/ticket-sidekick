import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Recorded-reply harness (KTD1): drives the real `@bitbucket` chat handler end to end with
// scripted model replies. `vscode` is mocked per the repo's per-test-file convention
// (docs/solutions/workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md)
// with only the surface BitbucketParticipant.ts touches; the Bitbucket client is swapped for
// MockBitbucketClient so no network is involved.
const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  /** The participant object `createChatParticipant` returned, so tests can reach its `followupProvider`. */
  participant: undefined as undefined | { followupProvider?: { provideFollowups(result: unknown): Array<{ prompt: string; label?: string }> } },
  client: undefined as unknown,
  /** The Jira client the participant's `JiraApiClient` constructor hands back. */
  jiraClient: undefined as unknown,
  /** What the last `vscode.env.clipboard.writeText` call wrote, or undefined when nothing was written. */
  clipboard: undefined as string | undefined,
  /** When set, the clipboard write rejects with this error. */
  clipboardError: undefined as Error | undefined,
  /** Every line written to the "Ticket Sidekick" output channel. */
  log: [] as string[],
  /** Arguments of every `vscode.commands.executeCommand` call. */
  commands: [] as unknown[][],
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
        h.participant = { };
        return Object.assign(h.participant, { dispose: () => undefined });
      },
    },
    LanguageModelChatMessage: {
      User: (content: string) => ({ role: 'user', content }),
      Assistant: (content: string) => ({ role: 'assistant', content }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line: string) => { h.log.push(line); } }),
      withProgress: (_opts: unknown, task: (progress: { report: () => void }) => unknown) => task({ report: () => undefined }),
    },
    ProgressLocation: { Window: 10 },
    commands: { executeCommand: async (...args: unknown[]) => { h.commands.push(args); } },
    env: {
      clipboard: {
        writeText: async (text: string) => {
          if (h.clipboardError) throw h.clipboardError;
          h.clipboard = text;
        },
      },
    },
    ChatResponseTurn,
    ChatRequestTurn,
    MarkdownString,
  };
});

vi.mock('../bitbucket/BitbucketApiClient', () => ({
  BitbucketApiClient: vi.fn().mockImplementation(() => h.client),
}));

vi.mock('../jira/JiraApiClient', () => ({
  JiraApiClient: vi.fn().mockImplementation(() => h.jiraClient),
}));

import * as vscode from 'vscode';
import { createBitbucketParticipant } from '../participant/BitbucketParticipant';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import { MockJiraClient } from './mocks/MockJiraClient';
import { JiraApiError } from '../utils/apiError';
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
  /** The fake Jira behind the participant; `getIssue` is spied so tests can count lookups. */
  jira: MockJiraClient;
  getIssueSpy: ReturnType<typeof vi.spyOn>;
  workspaceState: Map<string, unknown>;
  prompts: string[];
  /** Output-channel lines and executed commands, since this harness was created. */
  log: string[];
  commands: unknown[][];
  /** Run one chat turn. A reply list is consumed in call order, and running out fails the call. */
  turn(prompt: string, script: Script, history?: unknown[], options?: { freezeModel?: boolean; command?: string }): Promise<{ text: string; result: unknown }>;
  /** The chips VS Code would render under a response that returned `result`. */
  chips(result: unknown): Array<{ prompt: string; label?: string }>;
}

function createHarness(config: Partial<BitbucketConfig> = {}, options: { jira?: boolean } = {}): Harness {
  const client = new MockBitbucketClient();
  h.client = client;
  const jira = new MockJiraClient();
  const getIssueSpy = vi.spyOn(jira, 'getIssue');
  h.jiraClient = jira;
  h.clipboard = undefined;
  h.clipboardError = undefined;
  h.log.length = 0;
  h.commands.length = 0;
  const workspaceState = new Map<string, unknown>();
  const globalState = new Map<string, unknown>();
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
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
    subscriptions: [] as unknown[],
  };
  const configService = {
    getBitbucketConfig: async () => fullConfig,
    isBitbucketConfigured: () => true,
    // Jira is unconfigured unless a test asks for it, as for a user who only uses @bitbucket.
    getConfig: async () => ({ baseUrl: 'https://jira.example.com', authType: 'datacenter', token: 'jira-token' }),
    isConfigured: () => options.jira === true,
  };
  createBitbucketParticipant(context as never, configService as never);

  return {
    client,
    jira,
    getIssueSpy,
    workspaceState,
    prompts,
    log: h.log,
    commands: h.commands,
    chips: (result) => h.participant!.followupProvider!.provideFollowups(result),
    async turn(prompt, script, history = [], options = {}) {
      const queue = Array.isArray(script) ? [...script] : [];
      let callIndex = 0;
      const model = {
        vendor: 'test', family: 'test', id: 'test-model', version: '1', maxInputTokens: 128_000,
        // Deterministic stand-in for the editor's tokenizer: one token per four characters.
        countTokens: async (input: string | { content: string }) => Math.ceil((typeof input === 'string' ? input : input.content).length / 4),
        sendRequest: async (messages: Array<{ content: string }>) => {
          const sent = messages.map((m) => m.content).join('\n');
          prompts.push(sent);
          const next = Array.isArray(script) ? queue.shift() : script(sent, callIndex++);
          if (next === undefined) throw new Error('recorded-reply harness: no scripted reply left');
          if (next instanceof Error) throw next;
          const reply = { text: (async function* () { yield next; })() };
          // The editor hands over frozen replies as well as a frozen model.
          return options.freezeModel ? Object.freeze(reply) : reply;
        },
      };
      if (options.freezeModel) Object.freeze(model);
      const out: string[] = [];
      const stream = { markdown: (m: string | { value: string }) => { out.push(typeof m === 'string' ? m : m.value); } };
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
      const run = h.handler!({ prompt, command: options.command, model }, { history }, stream, token);
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
const isPass2Prompt = (prompt: string): boolean => prompt.includes('This is a second-pass review');

/** A critic verdict keeping every candidate finding listed in the prompt. */
function keepAll(prompt: string): string {
  const section = prompt.slice(prompt.indexOf('Candidate findings:'), prompt.indexOf('Diff (untrusted'));
  const indices = [...section.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
  return JSON.stringify({ keep: indices, additionalFilesNeeded: [] });
}

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

});

describe('failed reviews and read-only host objects', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ONLY_LINE = 'const a = 1;';
  const oneFileDiff = makeDiff([{ path: 'src/only.ts', lines: [ONLY_LINE] }]);
  const logText = (harness: Harness): string => harness.log.join('\n');
  const reviewCompletedSignals = (harness: Harness): unknown[][] =>
    harness.commands.filter((c) => c[1] === 'ticketSidekick.firstReviewCompleted');

  // AE1 / R1
  it('completes a review when the editor freezes the model and its replies', async () => {
    const harness = createHarness();
    harness.client.rawDiff = oneFileDiff;
    const { text } = await harness.turn(
      PR_URL,
      [[findingLine('src/only.ts', ONLY_LINE, 'Magic number'), META_LINE].join('\n')],
      [],
      { freezeModel: true },
    );

    expect(text).toContain('Magic number');
    expect(text).not.toContain('Review failed');
    const session = harness.workspaceState.get('bitbucket.session.review') as { findings: Array<{ title: string }> };
    expect(session.findings.map((f) => f.title)).toEqual(['Magic number']);
  });

  // AE2 / R4, R5, R7, R8, R9, R10
  it('reports a failed review when a one-file PR fails with a plain TypeError, and stores nothing', async () => {
    const harness = createHarness();
    harness.client.rawDiff = oneFileDiff;
    const { text, result } = await harness.turn(PR_URL, () => new TypeError('proxy invariant'));

    expect(harness.prompts).toHaveLength(1);
    expect(text).toContain('Review failed');
    expect(text).toContain('proxy invariant');
    expect(text).not.toContain('No issues found');
    expect(text).toContain('could not review src/only.ts');
    expect(text).not.toContain('after retrying');
    expect(result).toBeUndefined();
    expect(harness.workspaceState.get('bitbucket.session.review')).toBeUndefined();
    expect(reviewCompletedSignals(harness)).toHaveLength(0);

    const log = logText(harness);
    expect(log).toContain('not retrying: TypeError');
    expect(log).toContain('"errorName":"TypeError"');
    expect(log).toMatch(/\[ERROR\] \[bitbucket\.review\] Review failed/);
    expect(log).not.toContain('PR review completed — 0 finding(s)');
  });

  // AE4 / R7
  it('says "after retrying" when a one-file PR fails on a transient error every try', async () => {
    const harness = createHarness();
    harness.client.rawDiff = oneFileDiff;
    const { text } = await harness.turn(PR_URL, () => transientError());

    expect(harness.prompts).toHaveLength(3);
    expect(text).toContain('could not review src/only.ts after retrying');
    expect(text).toContain('Review failed');
  });

  // AE2 / R4, R5
  it('reports a failed review when every batch of a multi-file PR fails on every try', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [transientError(), transientError(), transientError(), transientError()]);

    expect(harness.prompts).toHaveLength(4);
    expect(text).toContain('Review failed');
    expect(text).not.toContain('No issues found');
    expect(text).not.toContain('Some batches had failures');
    expect(harness.workspaceState.get('bitbucket.session.review')).toBeUndefined();
  });

  // R5
  it('does not ask for specialist lenses in smart mode when nothing was reviewed', async () => {
    const harness = createHarness({ reviewMode: 'smart' });
    const { text, result } = await harness.turn(PR_URL, () => transientError());

    expect(text).toContain('Review failed');
    expect(text).not.toContain('persona recommendation');
    expect(result).toBeUndefined();
  });

  // AE3 / R6, R10
  it('keeps partial results under a neutral warning when only some batches fail', async () => {
    const harness = createHarness({ modelContextTokens: 3_000, contextBudgetRatio: 1 });
    harness.client.rawDiff = makeDiff([
      { path: 'src/f1.ts', lines: bulkyLines('One') },
      { path: 'src/f2.ts', lines: bulkyLines('Two') },
    ]);
    const { text, result } = await harness.turn(PR_URL, (prompt) => (prompt.includes('### File: src/f1.ts')
      ? transientError()
      : [findingLine('src/f2.ts', 'const TwoValue = computeTwo();', 'Issue in Two'), META_LINE].join('\n')));

    expect(text).toContain('Some batches had failures');
    expect(text).not.toContain('Review failed');
    expect(text).toContain('Issue in Two');
    expect(result).toMatchObject({ metadata: { bitbucketFollowup: { kind: 'reviewCompleted' } } });
    expect(harness.workspaceState.get('bitbucket.session.review')).toBeDefined();
    expect(logText(harness)).toMatch(/"reviewedFileCount":1,"failedFileCount":1/);
  });

  // R5 / KTD3: persona batches count as review
  it('keeps a deep review partial, not failed, when pass 1 fails but persona passes succeed', async () => {
    const harness = createHarness({ reviewMode: 'deep' });
    const { text } = await harness.turn(PR_URL, (prompt) => {
      if (isCriticPrompt(prompt)) return keepAll(prompt);
      if (isPersonaPrompt(prompt, 'security')) return [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n');
      if (prompt.includes('lens ONLY')) return META_LINE;
      return transientError();
    });

    expect(text).not.toContain('Review failed');
    expect(text).toContain('SQL injection');
    expect(text).toContain('Some batches had failures');
  });

  // R11
  it('records on the opening log line whether metering is on and whether the host model is frozen', async () => {
    const harness = createHarness();
    await harness.turn(PR_URL, [[findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n')], [], { freezeModel: true });

    expect(logText(harness)).toMatch(/"metering":"on","frozen":true/);
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

describe('Pass 2 refines Pass 1, and the critic sees the same context (U8)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const pass1WithRequest = [
    findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'),
    findingLine('src/auth/tokenStore.ts', TOKEN_ANCHOR, 'Token in localStorage'),
    '{"additionalFilesNeeded":["src/util.ts"]}',
  ].join('\n');
  const pass2NewFinding = findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'Username not validated');

  function sessionTitles(harness: ReturnType<typeof createHarness>): string[] {
    return (harness.workspaceState.get('bitbucket.session.review') as { findings: Array<{ title: string }> }).findings.map((f) => f.title);
  }

  // AE4 / R6 / R7
  it('gives Pass 2 the fetched file and Pass 1\'s findings, then applies its retraction and addition', async () => {
    const harness = createHarness();
    harness.client.fileContents.set('src/util.ts', 'export const sanitize = (s: string) => s;');
    const { text } = await harness.turn(PR_URL, (prompt) => (isPass2Prompt(prompt)
      ? [pass2NewFinding, '{"additionalFilesNeeded":[],"retract":[2]}'].join('\n')
      : pass1WithRequest));

    const pass2Prompt = harness.prompts.find(isPass2Prompt)!;
    expect(pass2Prompt).toContain('export const sanitize = (s: string) => s;');
    expect(pass2Prompt).toContain('SQL injection');
    expect(pass2Prompt).toContain('Token in localStorage');
    expect(sessionTitles(harness).sort()).toEqual(['SQL injection', 'Username not validated']);
    expect(text).not.toContain('Token in localStorage');
  });

  // AE5 / R8
  it('keeps every Pass 1 finding when the Pass 2 reply is cut off before its meta line', async () => {
    const harness = createHarness();
    harness.client.fileContents.set('src/util.ts', 'export const x = 1;');
    await harness.turn(PR_URL, (prompt) => {
      if (prompt.includes('Already reported')) return META_LINE;
      if (isPass2Prompt(prompt)) return [pass2NewFinding, '{"file":"src/auth/lo'].join('\n');
      return pass1WithRequest;
    });

    expect(sessionTitles(harness).sort()).toEqual(['SQL injection', 'Token in localStorage', 'Username not validated']);
  });

  it('keeps Pass 1 findings with a notice when Pass 2 fails on every try', async () => {
    const harness = createHarness();
    harness.client.fileContents.set('src/util.ts', 'export const x = 1;');
    const { text } = await harness.turn(PR_URL, (prompt) => (isPass2Prompt(prompt) ? transientError() : pass1WithRequest));

    expect(text).toContain('Pass 2 (whole-file context) failed');
    expect(sessionTitles(harness).sort()).toEqual(['SQL injection', 'Token in localStorage']);
  });

  it('ignores a retraction index that names no Pass 1 finding', async () => {
    const harness = createHarness();
    harness.client.fileContents.set('src/util.ts', 'export const x = 1;');
    await harness.turn(PR_URL, (prompt) => (isPass2Prompt(prompt)
      ? '{"additionalFilesNeeded":[],"retract":[7]}'
      : pass1WithRequest));

    expect(sessionTitles(harness).sort()).toEqual(['SQL injection', 'Token in localStorage']);
  });

  // R10
  it('shows the deep-mode critic the file Pass 2 used', async () => {
    const harness = createHarness({ reviewMode: 'deep' });
    harness.client.fileContents.set('src/util.ts', 'export const criticCanSeeThis = true;');
    await harness.turn(PR_URL, (prompt) => {
      if (isCriticPrompt(prompt)) return keepAll(prompt);
      if (prompt.includes('lens ONLY')) return META_LINE;
      if (isPass2Prompt(prompt)) return META_LINE;
      return pass1WithRequest;
    });

    const criticPrompt = harness.prompts.find(isCriticPrompt)!;
    expect(criticPrompt).toContain('export const criticCanSeeThis = true;');
  });

  it('gives critic round 2 both the Pass 2 file and the file the critic asked for', async () => {
    const harness = createHarness({ reviewMode: 'deep' });
    harness.client.fileContents.set('src/util.ts', 'export const fromPass2 = true;');
    harness.client.fileContents.set('src/db.ts', 'export const fromCritic = true;');
    await harness.turn(PR_URL, (prompt) => {
      if (isCriticPrompt(prompt)) {
        return prompt.includes('final verification round')
          ? keepAll(prompt)
          : '{"keep":[1,2],"additionalFilesNeeded":["src/db.ts"]}';
      }
      if (prompt.includes('lens ONLY') || isPass2Prompt(prompt)) return META_LINE;
      return pass1WithRequest;
    });

    const round2 = harness.prompts.find((p) => isCriticPrompt(p) && p.includes('final verification round'))!;
    expect(round2).toContain('export const fromPass2 = true;');
    expect(round2).toContain('export const fromCritic = true;');
  });

  // AE6 at handler level
  it('keeps findings unverified with a notice when the critic verdict is 0-based', async () => {
    const harness = createHarness({ reviewMode: 'deep' });
    const { text } = await harness.turn(PR_URL, (prompt) => {
      if (isCriticPrompt(prompt)) return '{"keep":[0,1]}';
      if (prompt.includes('lens ONLY')) return META_LINE;
      return [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), findingLine('src/auth/tokenStore.ts', TOKEN_ANCHOR, 'Token in localStorage'), META_LINE].join('\n');
    });

    expect(text).toContain('unreadable verdict');
    expect(sessionTitles(harness).sort()).toEqual(['SQL injection', 'Token in localStorage']);
  });

  // AE8 / R14
  it('says how many findings were dropped when every finding named a file outside the PR', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [
      [findingLine('src/invented.ts', 'x();', 'Ghost issue'), findingLine('lib/nowhere.ts', 'y();', 'Another ghost'), META_LINE].join('\n'),
    ]);

    expect(text).toContain('No issues found');
    expect(text).toContain('2 findings were dropped because they named files outside this PR');
  });
});

describe('Data Center diff recovery (U9)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const fileLines = (n: number) => [`const value${n} = read${n}();`];
  const fileDiff = (n: number) => makeDiff([{ path: `src/f${n}.ts`, lines: fileLines(n) }]);
  const reviewEachFile = (prompt: string): string => {
    const lines = [...prompt.matchAll(/### File: src\/f(\d+)\.ts/g)]
      .map((m) => findingLine(`src/f${m[1]}.ts`, `const value${m[1]} = read${m[1]}();`, `Issue in f${m[1]}`));
    return [...lines, META_LINE].join('\n');
  };

  // AE9 / R17
  it('fetches each cut file on its own and reviews every file', async () => {
    const harness = createHarness();
    harness.client.rawDiff = [1, 2, 3].map(fileDiff).join('');
    harness.client.cutFiles = [{ path: 'src/f4.ts' }, { path: 'src/f5.ts' }];
    harness.client.perFileDiffs.set('src/f4.ts', { raw: fileDiff(4), truncated: false });
    harness.client.perFileDiffs.set('src/f5.ts', { raw: fileDiff(5), truncated: false });
    const { text } = await harness.turn(PR_URL, reviewEachFile);

    expect(harness.client.getPullRequestFileDiffCalls.map((c) => c.path)).toEqual(['src/f4.ts', 'src/f5.ts']);
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`Issue in f${n}`);
    expect(text).not.toContain('reviewed partially');
  });

  it('names a file that is still cut after its own fetch as reviewed partially', async () => {
    const harness = createHarness();
    harness.client.rawDiff = fileDiff(1);
    harness.client.cutFiles = [{ path: 'src/f2.ts' }];
    harness.client.perFileDiffs.set('src/f2.ts', { raw: fileDiff(2), truncated: true });
    const { text } = await harness.turn(PR_URL, reviewEachFile);

    expect(text).toContain('src/f2.ts');
    expect(text).toContain('reviewed partially');
    expect(text).toContain('Issue in f2');
  });

  it('names a file whose own fetch fails as not reviewed, and reviews the rest', async () => {
    const harness = createHarness();
    harness.client.rawDiff = fileDiff(1);
    harness.client.cutFiles = [{ path: 'src/f2.ts' }];
    const { text } = await harness.turn(PR_URL, reviewEachFile);

    expect(text).toMatch(/src\/f2\.ts.*not reviewed/);
    expect(text).toContain('Issue in f1');
  });

  it('makes no per-file calls for a complete diff', async () => {
    const harness = createHarness();
    harness.client.rawDiff = fileDiff(1);
    await harness.turn(PR_URL, reviewEachFile);
    expect(harness.client.getPullRequestFileDiffCalls).toEqual([]);
  });

  // #4: a cut file matching reviewExcludePatterns must never be re-fetched or named
  // in a recovery warning — it's dropped by the exclusion filter regardless.
  it('skips a cut file matching reviewExcludePatterns without fetching or warning about it', async () => {
    const harness = createHarness({ reviewExcludePatterns: ['*.lock'] });
    harness.client.rawDiff = fileDiff(1);
    harness.client.cutFiles = [{ path: 'src/f2.lock' }, { path: 'src/f3.ts' }];
    harness.client.perFileDiffs.set('src/f3.ts', { raw: fileDiff(3), truncated: false });
    const { text } = await harness.turn(PR_URL, reviewEachFile);

    expect(harness.client.getPullRequestFileDiffCalls.map((c) => c.path)).toEqual(['src/f3.ts']);
    expect(text).not.toContain('src/f2.lock');
    expect(text).not.toContain('not reviewed');
    expect(text).not.toContain('reviewed partially');
    expect(text).toContain('Issue in f1');
    expect(text).toContain('Issue in f3');
  });
});

describe('follow-ups keep the review\'s context (U10)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const reviewReply = [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n');

  // R18
  it('gives a #N follow-up the upfront question and the PR description', async () => {
    const harness = createHarness();
    const first = await harness.turn(`${PR_URL} -- does this break concurrent writes?`, [reviewReply]);
    await harness.turn('#1 why is this critical?', ['Because the query is built from input.'], [sessionTurn(first.result)]);

    const followUp = harness.prompts.at(-1)!;
    expect(followUp).toContain('does this break concurrent writes?');
    expect(followUp).toContain('Implements OAuth 2.0 login with Google.');
    expect(followUp).toContain('Title: SQL injection');
  });

  // R19 / AE10
  it('explains the finding the matcher names as "#1"', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const { text } = await harness.turn('tell me more about the query problem', ['#1', 'It concatenates input.'], [sessionTurn(first.result)]);

    expect(text).toContain('Finding #1 — SQL injection');
    expect(text).toContain('It concatenates input.');
  });

  // R20 / AE10
  it('answers a question that mentions review and add instead of opening a comment preview', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const { text } = await harness.turn('Can you review whether #1 would add latency?', ['No noticeable latency.'], [sessionTurn(first.result)]);

    expect(text).toContain('No noticeable latency.');
    expect(text).not.toContain('Preview:');
  });

  // R22
  it('stores only the reviewed files\' diff for later follow-ups', async () => {
    const harness = createHarness({ reviewExcludePatterns: ['*.md'] });
    harness.client.rawDiff = makeDiff([
      { path: 'src/app.ts', lines: ['const app = start();'] },
      { path: 'README.md', lines: ['# Docs'] },
    ]);
    await harness.turn(PR_URL, [META_LINE]);

    const session = harness.workspaceState.get('bitbucket.session.review') as { rawDiff: string };
    expect(session.rawDiff).toContain('src/app.ts');
    expect(session.rawDiff).not.toContain('README.md');
  });
});

describe('a resumed smart review finishes like an uninterrupted one (U11)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // A phase-1 reply with no meta line gives smart mode no persona signal, so it asks the user.
  const noSignalReply = findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical');

  // AE11 / R23
  it('carries the upfront question into the resumed persona passes and stores the diff for follow-ups', async () => {
    const harness = createHarness({ reviewMode: 'smart' });
    const first = await harness.turn(`${PR_URL} -- does this break concurrent writes?`, [noSignalReply]);
    expect(first.text).toContain('couldn\'t determine a persona recommendation');

    const resumed = await harness.turn('all', (prompt) => (prompt.includes('lens ONLY') ? META_LINE : 'unexpected'), [sessionTurn(first.result)]);
    const personaPrompts = harness.prompts.filter((p) => p.includes('lens ONLY'));
    expect(personaPrompts).toHaveLength(4);
    for (const p of personaPrompts) expect(p).toContain('does this break concurrent writes?');
    expect(resumed.text).toContain('SQL injection');
    expect(resumed.text).not.toContain('Tokens:');
    expect(resumed.result).toMatchObject({
      metadata: { bitbucketFollowup: { kind: 'reviewCompleted' }, bitbucketSession: { kinds: ['review-session'] } },
    });

    const session = harness.workspaceState.get('bitbucket.session.review') as { rawDiff?: string; upfrontQuestion?: string };
    expect(session.upfrontQuestion).toBe('does this break concurrent writes?');
    expect(session.rawDiff).toContain('src/auth/login.ts');
  });

  it('shows the partial-failure banner after resuming when phase 1 had a failed batch', async () => {
    const harness = createHarness({ reviewMode: 'smart', modelContextTokens: 3_000, contextBudgetRatio: 1 });
    harness.client.rawDiff = makeDiff([
      { path: 'src/f1.ts', lines: bulkyLines('One') },
      { path: 'src/f2.ts', lines: bulkyLines('Two') },
    ]);
    const first = await harness.turn(PR_URL, (prompt) => (prompt.includes('### File: src/f1.ts')
      ? transientError()
      : findingLine('src/f2.ts', 'const TwoValue = computeTwo();', 'Issue in Two')));
    expect(first.text).toContain('couldn\'t determine a persona recommendation');

    const resumed = await harness.turn('standard', [], [sessionTurn(first.result)]);
    expect(resumed.text).toContain('Some batches had failures');
    expect(resumed.text).toContain('Issue in Two');
  });
});

describe('Copy for Teams', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const TWO_FINDINGS = [
    findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'),
    findingLine('src/auth/tokenStore.ts', "localStorage.setItem('auth_token', token);", 'Token kept in localStorage', 'warning'),
    META_LINE,
  ].join('\n');

  async function reviewed(harness: Harness): Promise<unknown> {
    const { result } = await harness.turn(PR_URL, [TWO_FINDINGS]);
    return result;
  }

  it('stores the PR author and target branch with the review session', async () => {
    const harness = createHarness();
    await reviewed(harness);

    const session = harness.workspaceState.get('bitbucket.session.review') as { prAuthor?: string; prTargetBranch?: string };
    expect(session.prAuthor).toBe('Jane Smith');
    expect(session.prTargetBranch).toBe('main');
  });

  it('copies the whole review from the chip prompt and keeps the session alive', async () => {
    const harness = createHarness();
    const review = await reviewed(harness);

    const { text, result } = await harness.turn('copy for teams', [], [sessionTurn(review)]);

    expect(h.clipboard).toBeDefined();
    const lines = h.clipboard!.split('\n');
    expect(lines[0]).toBe('PR #42 — Add OAuth login flow');
    expect(lines[1]).toBe('by Jane Smith → main · 2 findings');
    expect(lines[2]).toBe(PR_URL);
    expect(h.clipboard).toContain('🔴 Critical (1)');
    expect(h.clipboard).toContain('🟡 Warning (1)');
    expect(text).toContain('Copied 2 findings');
    expect(text).toContain('Teams');
    expect(result).toMatchObject({ metadata: { bitbucketSession: { kinds: ['review-session'] } } });

    // The session still answers a follow-up after the copy.
    const followUp = await harness.turn('#1 is this exploitable?', ['Yes, through the login form.'], [sessionTurn(result)]);
    expect(followUp.text).toContain('Yes, through the login form.');
  });

  it('copies only the findings asked for', async () => {
    const harness = createHarness();
    const review = await reviewed(harness);

    const { text } = await harness.turn('copy #2', [], [sessionTurn(review)]);

    expect(h.clipboard).toContain('1 of 2 findings');
    expect(h.clipboard).toContain('Token kept in localStorage');
    expect(h.clipboard).not.toContain('SQL injection');
    expect(text).toContain('Copied 1 of 2 findings');
  });

  it('copies nothing and names the valid range when a finding number does not exist', async () => {
    const harness = createHarness();
    const review = await reviewed(harness);

    const { text, result } = await harness.turn('copy #9', [], [sessionTurn(review)]);

    expect(h.clipboard).toBeUndefined();
    expect(text).toContain('Finding #9 not found. The review has findings #1–#2.');
    expect(result).toMatchObject({ metadata: { bitbucketSession: { kinds: ['review-session'] } } });
  });

  it('reports a failed clipboard write and keeps the session alive', async () => {
    const harness = createHarness();
    const review = await reviewed(harness);
    h.clipboardError = new Error('clipboard unavailable');

    const { text, result } = await harness.turn('copy', [], [sessionTurn(review)]);

    expect(text).toContain('Could not copy the review');
    expect(result).toMatchObject({ metadata: { bitbucketSession: { kinds: ['review-session'] } } });
  });

  it('does not copy once the user has moved on from the review', async () => {
    const harness = createHarness();
    await reviewed(harness);

    await harness.turn('copy', []);

    expect(h.clipboard).toBeUndefined();
  });
});

describe('token usage line and the usage command', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const reviewReply = [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n');
  const footer = /_Tokens: [\d,]+ in · [\d,]+ out · test-model(?: · budget [\d,]+)?_/;

  // AE1
  it('shows no token line by default', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(PR_URL, [reviewReply]);
    expect(text).not.toContain('Tokens:');
    expect(text).not.toContain('estimated tokens');
  });

  // AE2
  it('ends a review with the input/output line and the budget when the setting is on', async () => {
    const harness = createHarness({ showTokenUsage: true });
    const { text } = await harness.turn(PR_URL, [reviewReply]);
    expect(text).toMatch(/_Tokens: [\d,]+ in · [\d,]+ out · test-model · budget [\d,]+_/);
  });

  it('ends a follow-up answer with the line, without a budget', async () => {
    const harness = createHarness({ showTokenUsage: true });
    const first = await harness.turn(PR_URL, [reviewReply]);
    const { text } = await harness.turn('#1 why is this critical?', ['Because the query is built from input.'], [sessionTurn(first.result)]);
    expect(text).toMatch(footer);
    expect(text).not.toContain('budget');
  });

  // AE4 / AE6
  it('records usage even with the footer off and shows it with the usage command', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    await harness.turn('#1 why is this critical?', ['Because.'], [sessionTurn(first.result)]);
    const calls = harness.prompts.length;

    const { text } = await harness.turn('usage', []);
    expect(harness.prompts).toHaveLength(calls);
    expect(text).toContain('| Month | Model | Input | Output | Calls |');
    expect(text).toMatch(/\| \d{4}-\d{2} \| test-model \| [\d,]+ \| [\d,]+ \| 2 \|/);
  });

  it('says so when nothing has been recorded yet', async () => {
    const harness = createHarness();
    const { text } = await harness.turn('usage', []);
    expect(text).toBe('_No token usage recorded yet._');
  });

  it('still reviews when a PR URL comes with the word usage', async () => {
    const harness = createHarness();
    const { text } = await harness.turn(`usage ${PR_URL}`, [reviewReply]);
    expect(text).toContain('SQL injection');
  });
});

describe('leaving a review session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const reviewReply = [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), META_LINE].join('\n');
  const ENDED_KEYS = ['bitbucket.session.review', 'bitbucket.session.commentPreview', 'bitbucket.session.smartFallback'];

  // AE1 / R1
  it('shows a Done chip under the review and under every follow-up answer', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    expect(harness.chips(first.result).map((c) => c.label)).toEqual([
      'Add findings to review', 'Explain finding #1', 'Copy for Teams', 'Done',
    ]);

    const answer = await harness.turn('#1 why is this critical?', ['Because.'], [sessionTurn(first.result)]);
    expect(harness.chips(answer.result)).toEqual([{ prompt: 'done', label: 'Done' }]);
  });

  // AE1 / R1
  it('ends the session on done, so later messages get no follow-up treatment', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const calls = harness.prompts.length;

    const ended = await harness.turn('done', [], [sessionTurn(first.result)]);
    expect(ended.text).toContain('Review session ended');
    expect(ended.result).toBeUndefined();
    for (const key of ENDED_KEYS) expect(harness.workspaceState.get(key)).toBeUndefined();

    // Even with the stale session marker still in the history, nothing is answered from the old review.
    const later = await harness.turn('#1 why is this critical?', [], [sessionTurn(first.result)]);
    expect(later.text).toContain('Point me at a PR to review');
    expect(harness.prompts).toHaveLength(calls);
  });

  // AE2 / R2
  it('offers Post it and Cancel on a preview; Cancel keeps the review session', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const preview = await harness.turn('add #1 to review', [], [sessionTurn(first.result)]);
    expect(harness.chips(preview.result)).toEqual([
      { prompt: 'post it', label: 'Post it' },
      { prompt: 'cancel', label: 'Cancel' },
    ]);

    const cancelled = await harness.turn('cancel', [], [sessionTurn(preview.result)]);
    expect(cancelled.text).toContain('Cancelled');
    expect(harness.workspaceState.get('bitbucket.session.commentPreview')).toBeUndefined();
    expect(harness.chips(cancelled.result)).toEqual([{ prompt: 'done', label: 'Done' }]);

    const followUp = await harness.turn('#1 is this exploitable?', ['Yes.'], [sessionTurn(cancelled.result)]);
    expect(followUp.text).toContain('Yes.');
  });

  // R3
  it('offers Cancel on the smart-fallback question', () => {
    const harness = createHarness();
    const result = { metadata: { bitbucketSession: { kinds: ['smart-fallback-session'] } } };
    expect(harness.chips(result)).toEqual([{ prompt: 'cancel', label: 'Cancel' }]);
  });

  // R1
  it('treats a typed done under a comment preview like Cancel, and under the fallback question as the end', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const preview = await harness.turn('add #1 to review', [], [sessionTurn(first.result)]);
    const calls = harness.prompts.length;

    const doneUnderPreview = await harness.turn('done', [], [sessionTurn(preview.result)]);

    expect(doneUnderPreview.text).toContain('Cancelled');
    expect(harness.prompts).toHaveLength(calls);
    expect(harness.workspaceState.get('bitbucket.session.commentPreview')).toBeUndefined();
    expect(harness.workspaceState.get('bitbucket.session.review')).toBeDefined();

    harness.workspaceState.set('bitbucket.session.smartFallback', { prUrl: PR_URL });
    const fallbackTurn = sessionTurn({ metadata: { bitbucketSession: { kinds: ['smart-fallback-session'] } } });
    const doneUnderFallback = await harness.turn('done', [], [fallbackTurn]);

    expect(doneUnderFallback.text).toContain('Fallback question cancelled');
    expect(harness.workspaceState.get('bitbucket.session.smartFallback')).toBeUndefined();
  });

  // R5
  it('drops a stored preview from an earlier review when a new PR URL arrives', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    await harness.turn('add #1 to review', [], [sessionTurn(first.result)]);
    expect(harness.workspaceState.get('bitbucket.session.commentPreview')).toBeDefined();

    await harness.turn(PR_URL, [reviewReply]);

    expect(harness.workspaceState.get('bitbucket.session.commentPreview')).toBeUndefined();
  });

  // AE3 / R5
  it('starts a fresh review when a PR URL arrives, whatever the mode word or question', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);

    const second = await harness.turn(
      `quick ${PR_URL} -- new focus`,
      [[findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'Brand new finding', 'warning'), META_LINE].join('\n')],
      [sessionTurn(first.result)],
    );

    expect(second.text).toContain('Brand new finding');
    expect(harness.prompts.at(-1)).toContain('new focus');
    const session = harness.workspaceState.get('bitbucket.session.review') as { findings: Array<{ title: string }> };
    expect(session.findings.map((f) => f.title)).toEqual(['Brand new finding']);
  });

  // AE4 / R6
  it('ends the session on a bare /review and on a bare mode word', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    const calls = harness.prompts.length;

    const review = await harness.turn('', [], [sessionTurn(first.result)], { command: 'review' });
    expect(review.text).toContain('paste a PR URL');
    for (const key of ENDED_KEYS) expect(harness.workspaceState.get(key)).toBeUndefined();

    const again = createHarness();
    const second = await again.turn(PR_URL, [reviewReply]);
    const mode = await again.turn('smart', [], [sessionTurn(second.result)]);
    expect(mode.text).toContain('Point me at a PR to review');
    for (const key of ENDED_KEYS) expect(again.workspaceState.get(key)).toBeUndefined();
    expect(harness.prompts).toHaveLength(calls);
  });

  // AE7 / R6
  it('still answers a question that merely contains a mode word', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);

    const { text } = await harness.turn('is this quick to fix?', ['none', 'Fairly quick.'], [sessionTurn(first.result)]);

    expect(text).toContain('Fairly quick.');
    expect(harness.workspaceState.get('bitbucket.session.review')).toBeDefined();
  });

  // AE6 / R8
  it('keeps the session alive through usage and check', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);

    for (const word of ['usage', 'check']) {
      const neutral = await harness.turn(word, [], [sessionTurn(first.result)]);
      expect(neutral.result).toMatchObject({ metadata: { bitbucketSession: { kinds: ['review-session'] } } });
      expect(harness.chips(neutral.result)).toEqual([{ prompt: 'done', label: 'Done' }]);

      const followUp = await harness.turn('#1 why is this critical?', ['Because.'], [sessionTurn(neutral.result)]);
      expect(followUp.text).toContain('Because.');
    }
  });

  // R7 + R8
  it('does not offer Done after usage once an @jira request has ended the session', async () => {
    const harness = createHarness();
    const first = await harness.turn(PR_URL, [reviewReply]);
    for (const key of ENDED_KEYS) harness.workspaceState.delete(key);

    const { result } = await harness.turn('usage', [], [sessionTurn(first.result)]);

    expect(result).toBeUndefined();
  });

  // R8
  it('leaves usage and check without a session marker when no session is active', async () => {
    const harness = createHarness();

    expect((await harness.turn('usage', [])).result).toBeUndefined();
    expect((await harness.turn('check', [])).result).toBeUndefined();
  });
});

describe('requirements-aware review (U4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const SMART_TRAILER = '{"additionalFilesNeeded":[],"recommendedPersonas":[]}';
  const isRequirementsPrompt = (prompt: string): boolean => prompt.includes('does what its Jira ticket asks for');
  // A distinctive phrase from the bug-report ticket's last comment; it must reach only the requirements call.
  const TICKET_SENTINEL = 'idempotency key to the capture request';

  function requirementsReply(name: string, patch: Record<string, unknown> = {}): string {
    const base = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures', `requirements-reply-${name}.json`), 'utf-8')) as object;
    return JSON.stringify({ ...base, ...patch });
  }

  /** Replies by call type: the requirements call gets `requirements`, everything else a normal review reply. */
  function reviewScript(requirements: ScriptedReply | ((prompt: string) => ScriptedReply)): (prompt: string) => ScriptedReply {
    return (prompt) => {
      if (isRequirementsPrompt(prompt)) return typeof requirements === 'function' ? requirements(prompt) : requirements;
      if (isCriticPrompt(prompt)) return keepAll(prompt);
      if (prompt.includes('lens ONLY')) return META_LINE;
      return [findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical'), SMART_TRAILER].join('\n');
    };
  }

  function withTitleKey(harness: Harness, key = 'REQ-2'): Harness {
    harness.client.prOverride = { title: `${key} fix double charge` };
    return harness;
  }

  const linkQueries = (text: string): string[] =>
    [...text.matchAll(/command:workbench\.action\.chat\.open\?([^)]+)\)/g)]
      .map((m) => (JSON.parse(decodeURIComponent(m[1])) as { query: string }).query);

  // AE1
  it('pauses a smart review whose title has a key, offering use and skip, before any diff fetch or model call', async () => {
    const harness = withTitleKey(createHarness({}, { jira: true }));
    const { text, result } = await harness.turn(`review smart ${PR_URL}`, []);

    expect(text).toContain('Found **REQ-2** in the PR title');
    expect(linkQueries(text)).toEqual([`@bitbucket review smart ${PR_URL} REQ-2`, `@bitbucket review smart ${PR_URL} no ticket`]);
    expect(harness.prompts).toHaveLength(0);
    expect(harness.client.getPullRequestDiffCalls).toHaveLength(0);
    expect(harness.getIssueSpy).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  // AE1
  it('runs the requirements pass once the key is named, shows the coverage above the tables, and keeps ticket text out of every other call', async () => {
    const harness = withTitleKey(createHarness({}, { jira: true }));
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-2`, reviewScript(requirementsReply('bug-comment-fix', { additionalFilesNeeded: [] })));

    const coverageAt = text.indexOf('### Requirements coverage — REQ-2');
    expect(coverageAt).toBeGreaterThan(text.indexOf('## PR #42'));
    expect(coverageAt).toBeLessThan(text.indexOf('### 🔴 Critical'));
    expect(text).toContain('SQL injection');
    const requirementsPrompts = harness.prompts.filter(isRequirementsPrompt);
    expect(requirementsPrompts).toHaveLength(1);
    expect(requirementsPrompts[0]).toContain(TICKET_SENTINEL);
    for (const other of harness.prompts.filter((p) => !isRequirementsPrompt(p))) expect(other).not.toContain(TICKET_SENTINEL);
  });

  it('keeps ticket text out of the persona and critic calls of a deep review', async () => {
    const harness = withTitleKey(createHarness({}, { jira: true }));
    const { text } = await harness.turn(`review deep ${PR_URL} REQ-2`, reviewScript(requirementsReply('bug-comment-fix', { additionalFilesNeeded: [] })));

    expect(text).toContain('### Requirements coverage — REQ-2');
    expect(harness.prompts.filter((p) => p.includes('lens ONLY')).length).toBe(4);
    expect(harness.prompts.some(isCriticPrompt)).toBe(true);
    for (const other of harness.prompts.filter((p) => !isRequirementsPrompt(p))) expect(other).not.toContain(TICKET_SENTINEL);
    expect(harness.prompts.filter(isRequirementsPrompt)).toHaveLength(1);
  });

  // AE7
  it('reviews exactly as before when the user skips the ticket, with no Jira lookup and no extra call', async () => {
    const harness = withTitleKey(createHarness({}, { jira: true }));
    const { text } = await harness.turn(`review smart ${PR_URL} no ticket`, reviewScript('unexpected'));

    expect(harness.getIssueSpy).not.toHaveBeenCalled();
    expect(harness.prompts.some(isRequirementsPrompt)).toBe(false);
    expect(text).not.toContain('Requirements coverage');
    expect(text).toContain('SQL injection');
  });

  // AE2
  it('only hints in a standard review, showing the exact smart command, without a pause or a Jira call', async () => {
    const harness = withTitleKey(createHarness({}, { jira: true }));
    const { text } = await harness.turn(PR_URL, reviewScript('unexpected'));

    expect(text).toContain(`review smart ${PR_URL} REQ-2`);
    expect(text).toContain('SQL injection');
    expect(harness.getIssueSpy).not.toHaveBeenCalled();
    expect(harness.prompts).toHaveLength(1);
  });

  it('ignores an explicit key in a quick review with one line', async () => {
    const harness = createHarness({}, { jira: true });
    const { text } = await harness.turn(`review quick ${PR_URL} REQ-2`, reviewScript('unexpected'));

    expect(text).toContain('ignored');
    expect(harness.getIssueSpy).not.toHaveBeenCalled();
    expect(text).toContain('SQL injection');
  });

  // AE6
  it('says Jira is not configured and reviews as usual', async () => {
    const harness = withTitleKey(createHarness({}));
    const { text } = await harness.turn(`review smart ${PR_URL}`, reviewScript('unexpected'));

    expect(text).toContain("Jira isn't configured");
    expect(text).toContain('SQL injection');
    expect(harness.getIssueSpy).not.toHaveBeenCalled();
  });

  it('says there is no key when a smart review has none in the prompt or the title', async () => {
    const harness = createHarness({}, { jira: true });
    const { text } = await harness.turn(`review smart ${PR_URL}`, reviewScript('unexpected'));

    expect(text).toContain('No Jira key in the PR title');
    expect(text).toContain('SQL injection');
  });

  it('reviews without a ticket that Jira cannot find, and says so on one line', async () => {
    const harness = createHarness({}, { jira: true });
    harness.jira.getIssue = async () => { throw new JiraApiError('HTTP 404', 404, 'https://jira.example.com/x'); };
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-9`, reviewScript('unexpected'));

    expect(text).toContain('REQ-9 was not found in Jira');
    expect(text).toContain('SQL injection');
    expect(harness.prompts.some(isRequirementsPrompt)).toBe(false);
  });

  it('reviews without a ticket when Jira rejects the credentials', async () => {
    const harness = createHarness({}, { jira: true });
    harness.jira.getIssue = async () => { throw new JiraApiError('HTTP 401', 401, 'https://jira.example.com/x'); };
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-2`, reviewScript('unexpected'));

    expect(text).toContain('rejected the credentials');
    expect(text).toContain('SQL injection');
  });

  it('completes the review with a one-line notice when every requirements reply is unreadable, and shows no partial-review warning', async () => {
    const harness = createHarness({}, { jira: true });
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-2`, reviewScript('I am unable to produce JSON.'));

    expect(harness.prompts.filter(isRequirementsPrompt)).toHaveLength(3);
    expect(text).toContain('requirements check could not be completed');
    expect(text).not.toContain('Requirements coverage');
    expect(text).not.toContain('Some batches had failures');
    expect(text).toContain('SQL injection');
  });

  it('asks for one round of extra files and makes no second round', async () => {
    const harness = createHarness({}, { jira: true });
    harness.client.fileContents.set('src/payments/client.ts', 'export class PaymentsClient {}');
    const asksForFile = requirementsReply('bug-comment-fix', { additionalFilesNeeded: ['src/payments/client.ts'] });
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-2`, reviewScript(asksForFile));

    const requirementsPrompts = harness.prompts.filter(isRequirementsPrompt);
    expect(requirementsPrompts).toHaveLength(2);
    expect(requirementsPrompts[0]).not.toContain('### Context file: src/payments/client.ts');
    expect(requirementsPrompts[1]).toContain('### Context file: src/payments/client.ts');
    expect(harness.client.getFileContentCalls.filter((c) => c.path === 'src/payments/client.ts')).toHaveLength(1);
    expect(text).toContain('### Requirements coverage — REQ-2');
  });

  it('lists the files it was not shown when a large PR does not fit, and says how many', async () => {
    const harness = createHarness({ modelContextTokens: 5_000, contextBudgetRatio: 1 }, { jira: true });
    harness.client.rawDiff = makeDiff([
      { path: 'src/f1.ts', lines: bulkyLines('One') },
      { path: 'src/f2.ts', lines: bulkyLines('Two') },
      { path: 'src/f3.ts', lines: bulkyLines('Three') },
      { path: 'src/f4.ts', lines: bulkyLines('Four') },
    ]);
    const { text } = await harness.turn(`review smart ${PR_URL} REQ-2`, reviewScript(requirementsReply('clean-spec', { outOfScope: [] })));

    const requirementsPrompt = harness.prompts.find(isRequirementsPrompt)!;
    expect(requirementsPrompt).toContain('NOT SHOWN');
    expect(requirementsPrompt).toMatch(/src\/f\d\.ts \(\d+ changed lines\)/);
    expect(text).toMatch(/\d+ files? (was|were) not shown to this check/);
  });

  it('gives a resumed smart review its coverage block after the fallback question', async () => {
    const harness = createHarness({ reviewMode: 'smart' }, { jira: true });
    const noSignalReply = findingLine('src/auth/login.ts', LOGIN_ANCHOR, 'SQL injection', 'critical');
    const first = await harness.turn(`${PR_URL} REQ-2`, [noSignalReply]);
    expect(first.text).toContain('couldn\'t determine a persona recommendation');
    expect(harness.prompts.some(isRequirementsPrompt)).toBe(false);

    const resumed = await harness.turn('all', reviewScript(requirementsReply('bug-comment-fix', { additionalFilesNeeded: [] })), [sessionTurn(first.result)]);
    expect(resumed.text).toContain('### Requirements coverage — REQ-2');
    expect(harness.prompts.filter(isRequirementsPrompt)).toHaveLength(1);
    expect(resumed.text).toContain('SQL injection');
  });
});
