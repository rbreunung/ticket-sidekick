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
    expect(resumed.text).toMatch(/estimated tokens/);
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
    expect(resumed.text).toContain('Some batches had failures after retrying');
    expect(resumed.text).toContain('Issue in Two');
  });
});
