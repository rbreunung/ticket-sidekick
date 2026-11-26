import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import type { ReviewBoardDeps, ReviewSettings } from '../boards/review/deps';
import { reviewKind, type ReviewView, type ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND } from '../boards/review/recipe';
import { registerKind } from '../sessions/boardKind';
import { SessionManager, type BoardState } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { RequirementsSourceResult } from '../services/TicketService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// The review board after its first step: the pass suggestion and picker, Run selected (persona
// passes, then the critic), Stop, the banners for a stopped, interrupted, failed or refused pass,
// Run again and the token usage per pass. A pull request whose files
// each land in a batch of their own, a scripted model that answers by what the prompt asks, and a
// fake native confirmation. Every scenario goes through the session manager, as a board tab does.

const PR_URL = 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482';
const HEAD = 'abc123def456abc123def456abc123def456abc1';
const MODEL = { id: 'gpt-review', name: 'GPT Review', vendor: 'copilot', family: 'gpt' };

function codeLine(file: number, line: number): string {
  return `export const value${file}_${line} = compute(${line}); // keeps the diff long enough`;
}

function prDiff(fileCount: number): string {
  return Array.from({ length: fileCount }, (_, i) => {
    const n = i + 1;
    const lines = Array.from({ length: 16 }, (_, l) => `+${codeLine(n, l + 1)}`);
    return `diff --git a/src/f${n}.ts b/src/f${n}.ts\n--- a/src/f${n}.ts\n+++ b/src/f${n}.ts\n@@ -0,0 +1,16 @@\n${lines.join('\n')}\n`;
  }).join('');
}

function findingLine(file: number, line: number, title: string, severity = 'warning'): string {
  return JSON.stringify({
    file: `src/f${file}.ts`, line, anchorCode: codeLine(file, line), severity, confidence: 0.9, title,
    description: `${title} described`, recommendation: `Fix ${title}`,
  });
}

function reviewReply(findings: string[], meta: { recommendedPersonas?: string[]; additionalFilesNeeded?: string[] } = {}): string {
  return [...findings, JSON.stringify({ additionalFilesNeeded: meta.additionalFilesNeeded ?? [], ...(meta.recommendedPersonas ? { recommendedPersonas: meta.recommendedPersonas } : {}) })].join('\n');
}

type CallKind = 'regular' | 'whole-files' | 'security' | 'performance' | 'reliability' | 'maintainability' | 'critic';

function kindOf(prompt: string): CallKind {
  if (prompt.startsWith('You are verifying the findings')) return 'critic';
  for (const lens of ['security', 'performance', 'reliability', 'maintainability'] as const) {
    if (prompt.includes(`through a ${lens} lens ONLY`)) return lens;
  }
  return prompt.includes('First-pass findings (numbered)') ? 'whole-files' : 'regular';
}

function fileOf(prompt: string): number {
  const m = /### File: src\/f(\d+)\.ts/.exec(prompt);
  return m ? Number(m[1]) : 0;
}

interface Call { kind: CallKind; file: number; prompt: string }

let dir: string;
let client: MockBitbucketClient;
let calls: Call[];
let respond: (call: Call) => string | Promise<string>;
let confirms: string[];
let confirmAnswer: boolean;
let clock: number;
let jiraConfigured: boolean;
/** The keys of the Jira tickets read. */
let ticketReads: string[];
/** Settings a test adds to the board's. */
let extraSettings: Partial<ReviewSettings>;
/** The review passes' diagnostic lines. */
let reviewLines: string[];
/** A reply the model had under way still arrives after Stop, as if the model ignored the stop. */
let repliesAfterStop: boolean;
/** Every wait the board asked for, in ms. */
let sleeps: number[];
/** How a wait of the given length ends; by default at once. */
let sleepFor: (ms: number) => Promise<void>;

/** The regular pass finds one warning per file and suggests the security pass. */
const defaultRespond = (call: Call): string => {
  if (call.kind === 'critic') return JSON.stringify({ keep: [] });
  if (call.kind === 'regular') return reviewReply([findingLine(call.file, 2, `Unchecked input in f${call.file}`)], { recommendedPersonas: ['security'] });
  if (call.kind === 'security') return reviewReply([findingLine(call.file, 6, `Token logged in f${call.file}`, 'critical')]);
  return reviewReply([]);
};

function handle(id: string): BoardModelHandle {
  return {
    id,
    maxInputTokens: 100_000,
    countTokens: async text => Math.ceil((typeof text === 'string' ? text : text.content).length / 4),
    sendRequest: async (messages, { signal }) => {
      if (signal.aborted) throw new ModelRequestCancelledError();
      const prompt = messages.map(m => m.content).join('\n');
      const call = { kind: kindOf(prompt), file: fileOf(prompt), prompt };
      calls.push(call);
      // As the real handle does, a stop ends the request at once; a test may let a reply land after it.
      const reply = Promise.resolve().then(() => respond(call));
      const text = repliesAfterStop ? await reply : await Promise.race([reply, new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ModelRequestCancelledError()), { once: true });
      })]);
      if (signal.aborted && !repliesAfterStop) throw new ModelRequestCancelledError();
      return { text: (async function* () { yield text; })() };
    },
  };
}

function deps(): ReviewBoardDeps {
  return {
    bitbucket: async () => ({ configured: true, client }),
    jira: async () => (jiraConfigured ? {
      readRequirements: async (key: string): Promise<RequirementsSourceResult> => {
        ticketReads.push(key);
        return { ok: false, reason: 'not-found', message: 'Issue does not exist' };
      },
    } : undefined),
    models: { list: async () => [MODEL], handle: async id => (id === MODEL.id ? handle(id) : undefined) },
    modelSettings: { reviewModel: () => MODEL.id, writeReviewModel: async () => {} },
    // One file per batch.
    settings: async () => ({ confidenceThreshold: 0.7, modelContextTokens: 2000, contextBudgetRatio: 1, ...extraSettings }),
    recordTokens: async () => {},
    confirm: async question => { confirms.push(question.title); return confirmAnswer; },
    now: () => clock,
    reviewDiag: (_level, message) => { reviewLines.push(message); },
    sleep: ms => { sleeps.push(ms); return sleepFor(ms); },
  };
}

function manager(): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir), kinds: [registerKind(reviewKind, deps)], now: () => clock, confirm: async () => true, saveFile: async () => true,
  });
}

async function open(m: SessionManager, input: Record<string, unknown> = { url: PR_URL }): Promise<BoardState> {
  const opened = await m.open(REVIEW_KIND, input);
  if (!opened.ok) throw new Error(opened.reason);
  let state = await m.state(REVIEW_KIND, opened.id);
  while (state.status === 'building' || state.status === 'checking') state = await m.state(REVIEW_KIND, opened.id, state.tick, 1000);
  return state;
}

async function idle(m: SessionManager, id: string): Promise<BoardState> {
  let state = await m.state(REVIEW_KIND, id);
  while (state.running || state.status === 'checking') state = await m.state(REVIEW_KIND, id, state.tick, 1000);
  return state;
}

async function act(m: SessionManager, state: BoardState, action: Record<string, unknown>): Promise<BoardState> {
  return m.action(REVIEW_KIND, state.id, state.revision, action);
}

async function runAndWait(m: SessionManager, state: BoardState, request: Record<string, unknown>): Promise<BoardState> {
  await m.startRun(REVIEW_KIND, state.id, state.revision, request);
  return idle(m, state.id);
}

/** Waits until the board says `test` holds. */
async function until(m: SessionManager, id: string, test: (state: BoardState) => boolean): Promise<BoardState> {
  let state = await m.state(REVIEW_KIND, id);
  for (let i = 0; i < 200 && !test(state); i++) state = await m.state(REVIEW_KIND, id, state.tick, 50);
  if (!test(state)) throw new Error('The board never got there.');
  return state;
}

const viewOf = (state: BoardState) => state.view as ReviewView;
const resultsOf = (state: BoardState) => viewOf(state).results!;
const titles = (state: BoardState) => resultsOf(state).findings.map(f => f.title).sort();

/** A blocker that holds the replies to the calls `holds` picks until it is released. */
function hold(holds: (call: Call) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const before = respond;
  respond = async call => {
    if (holds(call)) await gate;
    return before(call);
  };
  return () => release();
}

async function reviewed(m: SessionManager, files: number): Promise<BoardState> {
  client.rawDiff = prDiff(files);
  return runAndWait(m, await open(m), { type: 'start' });
}

async function storedWorking(id: string): Promise<ReviewWorking> {
  return (await new SessionStore(dir).load(id))!.session.working as ReviewWorking;
}

/** Writes discussions and drafts into the stored session, as Explain and the drafts would. */
async function storeWork(id: string, work: Pick<ReviewWorking, 'threads' | 'drafts'>): Promise<void> {
  const store = new SessionStore(dir);
  const stored = (await store.load(id))!.session;
  await store.save({ ...stored, working: { ...(stored.working as ReviewWorking), ...work } });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runs-'));
  client = new MockBitbucketClient();
  client.prOverride = { id: 482, title: 'Add export', fromCommitHash: HEAD };
  calls = [];
  respond = defaultRespond;
  confirms = [];
  confirmAnswer = true;
  clock = 1_000;
  jiraConfigured = true;
  ticketReads = [];
  extraSettings = {};
  reviewLines = [];
  repliesAfterStop = false;
  sleeps = [];
  sleepFor = async () => {};
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the pass suggestion and the picker', () => {
  it('preselects the suggested pass and offers all four persona passes and the critic', async () => {
    const state = await reviewed(manager(), 2);
    const picker = resultsOf(state).picker!;
    expect(picker.suggestion).toBe('Suggested: the security pass.');
    expect(picker.choices.map(c => [c.step, c.available, c.picked, c.run])).toEqual([
      ['security', true, true, false],
      ['performance', true, false, false],
      ['reliability', true, false, false],
      ['maintainability', true, false, false],
      ['critic', true, false, false],
    ]);
    expect(picker.canRun).toBe(true);
  });

  it('with no extra pass suggested, says so and still offers every pass to pick', async () => {
    respond = call => (call.kind === 'regular' ? reviewReply([findingLine(call.file, 2, 'Unchecked input')], { recommendedPersonas: [] }) : defaultRespond(call));
    const state = await reviewed(manager(), 2);
    const picker = resultsOf(state).picker!;
    expect(picker.suggestion).toBe('No extra pass is suggested. You can still pick any of them.');
    expect(picker.choices.every(c => c.available && !c.picked)).toBe(true);
    expect(picker.choices).toHaveLength(5);
    expect(picker.canRun).toBe(false);
  });

  it('when no batch gave a usable recommendation, says so and suggests nothing', async () => {
    respond = call => (call.kind === 'regular' ? [findingLine(call.file, 2, 'Unchecked input')].join('\n') : defaultRespond(call));
    const picker = resultsOf(await reviewed(manager(), 2)).picker!;
    expect(picker.suggestion).toMatch(/No batch gave a usable recommendation, so nothing is suggested/);
    expect(picker.choices.every(c => !c.picked)).toBe(true);
  });

  it('Keep as is leaves the review as it is: nothing is picked and Run selected is refused', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    calls = [];
    state = await act(m, state, { type: 'keep-as-is' });
    expect(resultsOf(state).picker!.choices.every(c => !c.picked)).toBe(true);
    expect(resultsOf(state).picker!.canRun).toBe(false);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' })).rejects.toThrow('Pick at least one pass.');
    expect(calls).toEqual([]);
  });

  it('picking and unpicking passes is kept in the session', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await act(m, state, { type: 'pick-pass', step: 'security', picked: false });
    expect(resultsOf(state).picker!.choices.filter(c => c.picked).map(c => c.step)).toEqual(['critic']);
  });
});

describe('Run selected', () => {
  it('runs the picked persona passes first and the critic last, in one run, and marks them as run', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await act(m, state, { type: 'pick-pass', step: 'reliability', picked: true });
    calls = [];
    const started = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    expect(started.running).toEqual([expect.objectContaining({ size: 'pass', what: 'passes', label: 'the security pass, the reliability pass and the critic' })]);
    state = await idle(m, state.id);
    expect(calls.map(c => c.kind).filter((k, i, all) => all.indexOf(k) === i)).toEqual(['security', 'reliability', 'critic']);
    const results = resultsOf(state);
    expect(results.passesRun).toEqual(['Regular', 'Security', 'Reliability', 'Critic']);
    expect(results.picker!.choices.filter(c => c.run).map(c => c.step)).toEqual(['security', 'reliability', 'critic']);
    expect(results.picker!.choices.find(c => c.step === 'security')).toMatchObject({ available: false, picked: false });
    expect(results.tokens.map(t => t.pass)).toEqual(['Regular pass', 'Security pass', 'Reliability pass', 'Critic']);
  });

  it('the critic added the next day checks the unchecked findings; an explained or drafted finding stays labelled, the security pass stays marked', async () => {
    let m = manager();
    let state = await reviewed(m, 2);
    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Security']);
    const numbers = Object.fromEntries(resultsOf(state).findings.map(f => [f.title, f.number]));
    await storeWork(state.id, { threads: { [numbers['Token logged in f1']]: [{ answer: 'The token reaches the log.' }] }, drafts: { [numbers['Unchecked input in f2']]: { text: 'Please validate.' } } });

    clock += 24 * 60 * 60 * 1000;
    calls = [];
    m = manager();
    state = await open(m);
    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await runAndWait(m, state, { type: 'passes' });

    expect(calls.map(c => c.kind)).toEqual(['critic', 'critic']);
    expect(calls.every(c => c.prompt.includes('Unchecked input') && c.prompt.includes('Token logged'))).toBe(true);
    expect(client.getFileContentCalls.every(c => c.commitHash === HEAD)).toBe(true);
    const results = resultsOf(state);
    expect(results.passesRun).toEqual(['Regular', 'Security', 'Critic']);
    expect(results.findings.map(f => [f.title, f.markers])).toEqual([
      ['Token logged in f1', ['probably a false alarm']],
      ['Unchecked input in f2', ['probably a false alarm', 'draft']],
    ]);
    expect(results.findings.map(f => f.number)).toEqual([numbers['Token logged in f1'], numbers['Unchecked input in f2']]);
  });

  it('while a pass runs, every other action is refused, the progress reads per pass, and Stop keeps the finished batches; the stopped pass is not marked and is offered again', async () => {
    const m = manager();
    let state = await reviewed(m, 5);
    const release = hold(call => call.kind === 'security' && call.file === 3);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Security pass: 2 of 5 batches');
    expect(state.running).toEqual([expect.objectContaining({ size: 'pass', done: 2, total: 5 })]);
    await expect(act(m, state, { type: 'pick-pass', step: 'critic', picked: true })).rejects.toThrow(/the security pass is running/);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'again' })).rejects.toThrow(/the security pass is running/);

    await m.stopRun(REVIEW_KIND, state.id);
    release();
    state = await idle(m, state.id);

    const results = resultsOf(state);
    expect(viewOf(state).progress).toBeUndefined();
    expect(results.statuses).toEqual([expect.stringMatching(/^The security pass was stopped: 2 of 5 batches finished, and their findings are kept\. It is not marked as run/)]);
    expect(titles(state).filter(t => t.startsWith('Token logged'))).toEqual(['Token logged in f1', 'Token logged in f2']);
    expect(results.passesRun).toEqual(['Regular']);
    expect(results.picker!.choices.find(c => c.step === 'security')).toMatchObject({ available: true, run: false, picked: true });

    calls = [];
    state = await runAndWait(m, state, { type: 'passes' });
    expect(calls.filter(c => c.kind === 'security')).toHaveLength(5);
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Security']);
  });

  it('an extra pass whose reviewed commit can no longer be read does not run, stays unmarked, and the banner offers Run again', async () => {
    respond = call => (call.kind === 'regular' && call.file === 1
      ? reviewReply([findingLine(1, 2, 'Unchecked input in f1')], { additionalFilesNeeded: ['src/ctx.ts'], recommendedPersonas: ['security'] })
      : defaultRespond(call));
    client.fileContents.set('src/ctx.ts', 'export const ctx = 1;');
    const m = manager();
    let state = await reviewed(m, 2);
    vi.spyOn(client, 'getFileContent').mockRejectedValue(new Error('404 commit not found'));
    calls = [];
    state = await runAndWait(m, state, { type: 'passes' });
    expect(calls).toEqual([]);
    const results = resultsOf(state);
    expect(results.statuses).toEqual([expect.stringMatching(/The security pass did not run: src\/ctx\.ts can no longer be read at the reviewed commit.*Run again/)]);
    expect(results.passesRun).toEqual(['Regular']);
    expect(results.canRunAgain).toBe(true);
  });
});

describe('picked persona passes running at the same time', () => {
  const rateLimited = (message = 'Sorry, you have been rate-limited.') => Object.assign(new Error(message), { name: 'ChatRateLimited' });
  const blocked = () => Object.assign(new Error('The request was blocked'), { code: 'Blocked' });
  const lines = (state: BoardState) => (resultsOf(state).running?.passes ?? []).map(p => p.text);
  const kinds = (kind: CallKind) => calls.map((c, i) => [c, i] as const).filter(([c]) => c.kind === kind).map(([, i]) => i);

  async function picking(m: SessionManager, files: number, steps: string[]): Promise<BoardState> {
    let state = await reviewed(m, files);
    for (const step of steps) state = await act(m, state, { type: 'pick-pass', step, picked: true });
    calls = [];
    return state;
  }

  it('Security and Performance on a three-batch review run at the same time, each with its own progress line, and the critic starts only after both end', async () => {
    const m = manager();
    let state = await picking(m, 3, ['performance', 'critic']);
    const releaseSecurity = hold(c => c.kind === 'security' && c.file === 1);
    const releasePerformance = hold(c => c.kind === 'performance' && c.file === 1);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    state = await until(m, state.id, s => lines(s).length === 2 && calls.length === 2);

    expect(calls.map(c => [c.kind, c.file])).toEqual([['security', 1], ['performance', 1]]);
    expect(lines(state)).toEqual(['Security pass: 0 of 3 batches', 'Performance pass: 0 of 3 batches']);
    expect(viewOf(state).progress).toBe('Security pass: 0 of 3 batches; Performance pass: 0 of 3 batches');
    releasePerformance();
    state = await until(m, state.id, s => lines(s).length === 1);
    expect(kinds('critic')).toEqual([]);
    releaseSecurity();
    state = await idle(m, state.id);

    const lastPersona = Math.max(...kinds('security'), ...kinds('performance'));
    expect(kinds('critic').length).toBeGreaterThan(0);
    expect(Math.min(...kinds('critic'))).toBeGreaterThan(lastPersona);
    // The passes are listed in the order they ended.
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Performance', 'Security', 'Critic']);
    // The diagnostic lines of the two passes interleave; each configuration line names its pass.
    expect(reviewLines.filter(l => / passes=(security|performance) /.test(l))).toHaveLength(2);
  });

  it('on a six-batch review with three passes picked, at most two run at once and the third starts when one ends', async () => {
    const m = manager();
    let state = await picking(m, 6, ['performance', 'reliability']);
    const releaseSecurity = hold(c => c.kind === 'security' && c.file === 1);
    const releasePerformance = hold(c => c.kind === 'performance' && c.file === 1);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    state = await until(m, state.id, s => lines(s).length === 2 && calls.length === 2);
    expect(kinds('reliability')).toEqual([]);

    releasePerformance();
    state = await until(m, state.id, s => lines(s).some(l => l.startsWith('Reliability')));
    expect(kinds('security')).toHaveLength(1);
    expect(lines(state).map(l => l.split(':')[0])).toEqual(['Security pass', 'Reliability pass']);
    releaseSecurity();
    state = await idle(m, state.id);
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Performance', 'Reliability', 'Security']);
  });

  it('batches finishing in interleaved order give unique, gap-free numbers across both passes, a duplicate across passes merges, and neither prompt carries the other\'s findings', async () => {
    respond = call => {
      if (call.kind === 'security') {
        return call.file === 1
          ? reviewReply([findingLine(1, 6, 'Shared issue', 'critical'), findingLine(1, 8, 'Security only in f1')])
          : reviewReply([findingLine(2, 6, 'Security only in f2')]);
      }
      if (call.kind === 'performance') {
        return call.file === 1
          ? reviewReply([findingLine(1, 6, 'Shared issue'), findingLine(1, 10, 'Performance only in f1')])
          : reviewReply([findingLine(2, 8, 'Performance only in f2')]);
      }
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 2, ['performance']);
    const releaseSecurity = hold(c => c.kind === 'security' && c.file === 1);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, s => lines(s).length === 1 && lines(s)[0].startsWith('Security'));
    releaseSecurity();
    state = await idle(m, state.id);

    const byTitle = Object.fromEntries(resultsOf(state).findings.map(f => [f.title, f]));
    expect(resultsOf(state).findings.map(f => f.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.fromEntries(Object.entries(byTitle).map(([t, f]) => [t, f.number]))).toEqual({
      'Unchecked input in f1': 1, 'Unchecked input in f2': 2,
      'Shared issue': 3, 'Performance only in f1': 4, 'Performance only in f2': 5, 'Security only in f1': 6, 'Security only in f2': 7,
    });
    expect(byTitle['Shared issue']).toMatchObject({ severity: 'critical', facts: expect.arrayContaining(['source: security, performance']) });
    const persona = calls.filter(c => c.kind === 'security' || c.kind === 'performance');
    expect(persona.every(c => !/Shared issue|only in f|Unchecked input/.test(c.prompt))).toBe(true);
  });

  it('a Performance batch refused as rate-limited while Security runs waits, runs once more after Security ends, and the board says the passes now run one after another', async () => {
    let refusals = 0;
    respond = call => {
      if (call.kind === 'performance' && call.file === 2 && refusals++ === 0) throw rateLimited();
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 3, ['performance']);
    const releaseSecurity = hold(c => c.kind === 'security' && c.file === 2);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    state = await until(m, state.id, s => resultsOf(s).running?.note !== undefined);

    expect(resultsOf(state).running!.note).toBe('The model limited the requests, so the passes now run one after another.');
    expect(lines(state)).toEqual(['Security pass: 1 of 3 batches', 'Performance pass: 1 of 3 batches, runs again after the others']);
    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2]);
    releaseSecurity();
    state = await idle(m, state.id);

    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2, 2, 3]);
    expect(kinds('performance')[2]).toBeGreaterThan(Math.max(...kinds('security')));
    expect(sleeps).toEqual([30_000]);
    const results = resultsOf(state);
    expect(results.passesRun).toEqual(['Regular', 'Security', 'Performance']);
    expect(results.notice).toMatch(/one after another/);
  });

  it('the rerun round waits as long as the refusal asked before it starts', async () => {
    let refusals = 0;
    respond = call => {
      if (call.kind === 'performance' && call.file === 2 && refusals++ === 0) throw rateLimited('Rate limited. Please wait 45 seconds before trying again.');
      return defaultRespond(call);
    };
    let endWait!: () => void;
    sleepFor = ms => (ms === 45_000 ? new Promise<void>(r => { endWait = r; }) : Promise.resolve());
    const m = manager();
    let state = await picking(m, 3, ['performance']);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, () => sleeps.includes(45_000));
    const before = calls.length;
    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2]);
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toHaveLength(before);
    endWait();
    state = await idle(m, state.id);
    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2, 2, 3]);
  });

  it('Stop while a rate-limited pass waits for its rerun records it as stopped, not refused, and claims no rerun', async () => {
    let refusals = 0;
    respond = call => {
      if (call.kind === 'performance' && call.file === 2 && refusals++ === 0) throw rateLimited();
      return defaultRespond(call);
    };
    sleepFor = () => new Promise<void>(() => {});
    const m = manager();
    let state = await picking(m, 3, ['performance']);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, () => sleeps.includes(30_000));
    await m.stopRun(REVIEW_KIND, state.id);
    state = await idle(m, state.id);

    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2]);
    const results = resultsOf(state);
    expect(results.statuses).toContainEqual(expect.stringMatching(/^The performance pass was stopped: 1 of 3 batches finished/));
    expect(results.statuses.some(s => /refused/.test(s))).toBe(false);
    expect(results.notice).toBeUndefined();
  });

  it('a rerun refused again stops the run with the quota message, and offers the refused pass again', async () => {
    respond = call => {
      if (call.kind === 'performance' && call.file === 2) throw rateLimited();
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 3, ['performance', 'critic']);
    state = await runAndWait(m, state, { type: 'passes' });

    expect(calls.filter(c => c.kind === 'performance').map(c => c.file)).toEqual([1, 2, 2]);
    expect(kinds('critic')).toEqual([]);
    const results = resultsOf(state);
    expect(results.notice).toMatch(/^The model refused further requests: the request limit or quota is used up/);
    expect(results.statuses).toContainEqual(expect.stringMatching(/^The performance pass was refused by the model: 1 of 3 batches finished.*pick it again/));
    expect(results.passesRun).toEqual(['Regular', 'Security']);
    expect(results.picker!.choices.filter(c => c.picked).map(c => c.step)).toEqual(['performance', 'critic']);
  });

  it('a two-file batch whose first call is refused as blocked ends the other running pass, and no model call starts after the run ends', async () => {
    extraSettings = { modelContextTokens: 2300 };
    respond = call => {
      if (call.kind === 'performance') throw blocked();
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 4, ['performance']);
    const releaseSecurity = hold(c => c.kind === 'security');
    state = await runAndWait(m, state, { type: 'passes' });

    expect(calls.map(c => c.kind)).toEqual(['security', 'performance']);
    releaseSecurity();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toHaveLength(2);
    const results = resultsOf(state);
    expect(results.notice).toMatch(/^The model refused further requests/);
    expect(results.statuses).toEqual([
      expect.stringMatching(/^The performance pass was refused by the model: 0 of 2 batches/),
      expect.stringMatching(/^The security pass was refused by the model: 0 of 2 batches/),
    ]);
  });

  it('a second batch refused as rate-limited while the passes already run one after another joins the same rerun round', async () => {
    const refused = new Set<string>();
    const once = (key: string) => (refused.has(key) ? false : (refused.add(key), true));
    respond = call => {
      if (call.kind === 'performance' && call.file === 1 && once('p1')) throw rateLimited();
      if (call.kind === 'reliability' && call.file === 3 && once('r3')) throw rateLimited();
      return defaultRespond(call);
    };
    let callsAtWait = -1;
    sleepFor = async ms => { if (ms === 30_000) callsAtWait = calls.length; };
    const m = manager();
    let state = await picking(m, 6, ['performance', 'reliability']);
    state = await runAndWait(m, state, { type: 'passes' });

    expect(sleeps).toEqual([30_000]);
    expect(Math.min(...kinds('reliability'))).toBeGreaterThan(Math.max(...kinds('security')));
    const rerun = calls.slice(callsAtWait).map(c => [c.kind, c.file]);
    expect(rerun).toEqual([
      ...[1, 2, 3, 4, 5, 6].map(f => ['performance', f]),
      ...[3, 4, 5, 6].map(f => ['reliability', f]),
    ]);
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Security', 'Performance', 'Reliability']);
  });

  it('a blocked refusal starts no further batch or pass, stops with the quota message, and offers the refused pass and the passes not started', async () => {
    respond = call => {
      if (call.kind === 'performance' && call.file === 2) throw blocked();
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 6, ['performance', 'reliability']);
    state = await runAndWait(m, state, { type: 'passes' });

    const blockedAt = calls.findIndex(c => c.kind === 'performance' && c.file === 2);
    expect(kinds('reliability')).toEqual([]);
    expect(calls.slice(blockedAt + 1).every(c => c.kind === 'security')).toBe(true);
    expect(calls.slice(blockedAt + 1).length).toBeLessThanOrEqual(1);
    const results = resultsOf(state);
    expect(results.notice).toMatch(/^The model refused further requests/);
    expect(results.passesRun).toEqual(['Regular']);
    expect(results.picker!.choices.filter(c => c.picked).map(c => c.step)).toEqual(['security', 'performance', 'reliability']);
    expect(results.picker!.offered).toEqual(['security', 'performance', 'reliability', 'maintainability', 'critic']);
  });

  it('with Security failing on every batch and Performance finishing, the picked critic still checks the findings there are, and Security is offered again', async () => {
    respond = call => {
      if (call.kind === 'security') throw new Error('The model is overloaded');
      if (call.kind === 'performance') return reviewReply([findingLine(call.file, 9, `Slow loop in f${call.file}`)]);
      return defaultRespond(call);
    };
    const m = manager();
    let state = await picking(m, 2, ['performance', 'critic']);
    state = await runAndWait(m, state, { type: 'passes' });

    const critic = calls.filter(c => c.kind === 'critic');
    expect(critic.length).toBeGreaterThan(0);
    expect(critic.some(c => c.prompt.includes('Slow loop in f1'))).toBe(true);
    const results = resultsOf(state);
    expect(results.passesRun).toEqual(['Regular', 'Performance', 'Critic']);
    expect(results.statuses).toContainEqual(expect.stringMatching(/^The security pass failed: .*pick it again/));
    expect(results.picker!.choices.find(c => c.step === 'security')).toMatchObject({ available: true, picked: true });
  });

  it('Stop ends both passes and keeps what each found, the critic does not run, and a reply landing after Stop changes nothing', async () => {
    repliesAfterStop = true;
    respond = call => (call.kind === 'performance' ? reviewReply([findingLine(call.file, 9, `Slow loop in f${call.file}`)]) : defaultRespond(call));
    const m = manager();
    let state = await picking(m, 3, ['performance', 'critic']);
    const release = hold(c => (c.kind === 'security' || c.kind === 'performance') && c.file === 2);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, s => lines(s).join() === 'Security pass: 1 of 3 batches,Performance pass: 1 of 3 batches' && calls.length === 4);
    await m.stopRun(REVIEW_KIND, state.id);
    release();
    state = await idle(m, state.id);

    expect(kinds('critic')).toEqual([]);
    expect(titles(state)).toEqual(['Slow loop in f1', 'Token logged in f1', 'Unchecked input in f1', 'Unchecked input in f2', 'Unchecked input in f3']);
    const results = resultsOf(state);
    expect(results.statuses).toEqual([
      expect.stringMatching(/^The security pass was stopped: 1 of 3 batches finished/),
      expect.stringMatching(/^The performance pass was stopped: 1 of 3 batches finished/),
    ]);
    expect(results.passesRun).toEqual(['Regular']);
    expect(results.notice).toBeUndefined();
  });

  it('a restart during two running passes keeps both passes\' finished batches and records both as cut off', async () => {
    respond = call => (call.kind === 'performance' ? reviewReply([findingLine(call.file, 9, `Slow loop in f${call.file}`)]) : defaultRespond(call));
    const m = manager();
    const state = await picking(m, 3, ['performance']);
    hold(c => (c.kind === 'security' || c.kind === 'performance') && c.file === 2);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, s => lines(s).join() === 'Security pass: 1 of 3 batches,Performance pass: 1 of 3 batches');

    const restored = await open(manager());
    const results = resultsOf(restored);
    expect(results.statuses).toEqual([
      expect.stringMatching(/^The security pass was cut off by a restart: 1 of 3 batches finished/),
      expect.stringMatching(/^The performance pass was cut off by a restart: 1 of 3 batches finished/),
    ]);
    expect(titles(restored)).toEqual(['Slow loop in f1', 'Token logged in f1', 'Unchecked input in f1', 'Unchecked input in f2', 'Unchecked input in f3']);
    expect(results.findings.map(f => f.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(results.picker!.choices.filter(c => c.picked).map(c => c.step)).toEqual(['security', 'performance']);
  });

  it('after Security and Performance it offers Reliability, Maintainability and the critic; after the critic, the critic is offered again only once a later pass adds findings', async () => {
    respond = call => (call.kind === 'reliability' ? reviewReply([findingLine(call.file, 11, `Unclosed stream in f${call.file}`)]) : defaultRespond(call));
    const m = manager();
    let state = await picking(m, 2, ['performance']);
    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).picker!.offered).toEqual(['reliability', 'maintainability', 'critic']);

    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).picker!.offered).toEqual(['reliability', 'maintainability']);

    respond = call => (call.kind === 'reliability' ? reviewReply([findingLine(call.file, 11, `Unclosed stream in f${call.file}`)]) : defaultRespond(call));
    state = await act(m, state, { type: 'pick-pass', step: 'reliability', picked: true });
    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).picker!.offered).toEqual(['maintainability', 'critic']);
  });
});

describe('findings while the regular pass runs', () => {
  it('after two of five batches the results list those batches\' findings, with the numbers they keep at the end, and say the pass is running', async () => {
    const m = manager();
    client.rawDiff = prDiff(5);
    let state = await open(m);
    const release = hold(call => call.kind === 'regular' && call.file === 3);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 2 of 5 batches');

    expect(viewOf(state).stage).toBe('review');
    expect(viewOf(state).firstStep).toBeUndefined();
    const live = resultsOf(state);
    expect(live.running).toEqual({ what: 'regular', step: 'regular', done: 2, total: 5 });
    expect(live.hasReview).toBe(true);
    expect(live.picker).toBeUndefined();
    expect(live.statuses).toEqual([]);
    expect(live.findings.map(f => [f.number, f.title])).toEqual([[1, 'Unchecked input in f1'], [2, 'Unchecked input in f2']]);

    release();
    state = await idle(m, state.id);
    const final = resultsOf(state);
    expect(final.running).toBeUndefined();
    expect(final.findings.filter(f => f.number <= 2).map(f => [f.number, f.title])).toEqual([[1, 'Unchecked input in f1'], [2, 'Unchecked input in f2']]);
    expect(final.findings).toHaveLength(5);
  });

  it('before the first batch finishes, Start shows the empty results with the pass running', async () => {
    const m = manager();
    client.rawDiff = prDiff(3);
    let state = await open(m);
    const release = hold(call => call.kind === 'regular' && call.file === 1);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 0 of 3 batches');

    expect(viewOf(state).stage).toBe('review');
    expect(resultsOf(state)).toMatchObject({ running: { what: 'regular', done: 0, total: 3 }, hasReview: false, findings: [] });
    release();
    await idle(m, state.id);
  });

  it('Run again shows the new review\'s findings so far, not the one it replaces', async () => {
    const m = manager();
    let state = await reviewed(m, 3);
    respond = call => (call.kind === 'regular' ? reviewReply([findingLine(call.file, 4, `Second look at f${call.file}`)]) : defaultRespond(call));
    const release = hold(call => call.kind === 'regular' && call.file === 2);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'again' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 1 of 3 batches');

    expect(resultsOf(state).findings.map(f => [f.number, f.title])).toEqual([[1, 'Second look at f1']]);
    release();
    await idle(m, state.id);
  });
});

describe('the order of the findings', () => {
  it('lists by severity, then confidence from highest, a finding without confidence last, then by number', async () => {
    const line = (file: number, n: number, title: string, severity: string, confidence?: number) => JSON.stringify({
      file: `src/f${file}.ts`, line: n, anchorCode: codeLine(file, n), severity, ...(confidence !== undefined ? { confidence } : {}), title,
      description: `${title} described`, recommendation: `Fix ${title}`,
    });
    respond = call => {
      if (call.kind !== 'regular') return defaultRespond(call);
      if (call.file === 1) return reviewReply([line(1, 2, 'Warning sure', 'warning', 0.9), line(1, 5, 'Critical unsure', 'critical', 0.6)]);
      return reviewReply([line(2, 2, 'Critical sure', 'critical', 0.95), line(2, 5, 'Warning no confidence', 'warning'), line(2, 8, 'Warning also sure', 'warning', 0.9)]);
    };
    const results = resultsOf(await reviewed(manager(), 2));
    expect(results.findings.map(f => f.title)).toEqual(['Critical sure', 'Critical unsure', 'Warning sure', 'Warning also sure', 'Warning no confidence']);
  });
});

describe('the regular pass ends', () => {
  it('stopped after 3 of 7 batches: the findings of those 3 under a banner', async () => {
    const m = manager();
    client.rawDiff = prDiff(7);
    let state = await open(m);
    const release = hold(call => call.kind === 'regular' && call.file === 4);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 3 of 7 batches');
    await m.stopRun(REVIEW_KIND, state.id);
    release();
    state = await idle(m, state.id);
    expect(resultsOf(state).statuses).toEqual([expect.stringMatching(/^The regular pass was stopped: 3 of 7 batches finished, and their findings are kept\./)]);
    expect(titles(state)).toEqual(['Unchecked input in f1', 'Unchecked input in f2', 'Unchecked input in f3']);
  });

  it('with no findings shows "No issues found" with the picker, the token usage and Run again', async () => {
    respond = call => (call.kind === 'regular' ? reviewReply([], { recommendedPersonas: [] }) : defaultRespond(call));
    const results = resultsOf(await reviewed(manager(), 2));
    expect(results.hasReview).toBe(true);
    expect(results.findings).toEqual([]);
    expect(results.picker).toBeDefined();
    expect(results.tokens).toEqual([{ pass: 'Regular pass', text: expect.stringMatching(/input and .* output tokens in 2 call\(s\)/) }]);
    expect(results.canRunAgain).toBe(true);
  });

  it('whose batches all failed shows the failure banner and Run again, and no picker or findings', async () => {
    respond = call => {
      if (call.kind === 'regular') throw new Error('The model is overloaded');
      return defaultRespond(call);
    };
    const results = resultsOf(await reviewed(manager(), 2));
    expect(results.hasReview).toBe(false);
    expect(results.statuses).toEqual([expect.stringMatching(/^The regular pass failed: .*overloaded.*Run again/)]);
    expect(results.picker).toBeUndefined();
    expect(results.canRunAgain).toBe(true);
  });

  it('with one batch that failed after its retries shows the findings of the others under the partial-results banner', async () => {
    respond = call => {
      if (call.kind === 'regular' && call.file === 2) throw new Error('The model is overloaded');
      return defaultRespond(call);
    };
    const results = resultsOf(await reviewed(manager(), 3));
    expect(results.statuses).toEqual(['1 of 3 batches of the regular pass had a part that failed; the findings of the others are shown.']);
    expect(results.findings.map(f => f.title)).toEqual(['Unchecked input in f1', 'Unchecked input in f3']);
    expect(results.picker).toBeDefined();
  });
});

describe('Run again', () => {
  it('asks first when explanations would be lost; declining keeps the review, agreeing redoes it from the regular pass with the same choices', async () => {
    const m = manager();
    let state = await open(m);
    client.rawDiff = prDiff(2);
    state = await act(m, state, { type: 'background', choice: 'text' });
    state = await act(m, state, { type: 'own-text', text: 'does this handle retries?' });
    state = await runAndWait(m, state, { type: 'start' });
    state = await runAndWait(m, state, { type: 'passes' });
    await storeWork(state.id, { threads: { 1: [{ answer: 'Explained.' }] }, drafts: {} });
    const m2 = manager();
    state = await open(m2);

    calls = [];
    confirmAnswer = false;
    state = await runAndWait(m2, state, { type: 'again' });
    expect(confirms).toEqual(['Run the whole review again?']);
    expect(calls).toEqual([]);
    expect(resultsOf(state).notice).toMatch(/kept/);
    expect((await storedWorking(state.id)).threads).toEqual({ 1: [{ answer: 'Explained.' }] });
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Security']);

    confirmAnswer = true;
    state = await runAndWait(m2, state, { type: 'again' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(c => c.kind === 'regular').every(c => c.prompt.includes('does this handle retries?'))).toBe(true);
    expect(resultsOf(state).passesRun).toEqual(['Regular']);
    expect((await storedWorking(state.id)).threads).toEqual({});
  });

  it('a review with nothing worked on runs again without asking', async () => {
    const m = manager();
    const state = await reviewed(m, 2);
    await runAndWait(m, state, { type: 'again' });
    expect(confirms).toEqual([]);
  });
});

describe('the results of a review', () => {
  it('with a ticket key in the pull request title, read no ticket, have no requirements check, coverage or source form, and refuse Re-check and Reword', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    const state = await reviewed(m, 2);
    const results = resultsOf(state);

    expect(ticketReads).toEqual([]);
    expect(calls.map(c => c.kind)).toEqual(['regular', 'regular']);
    expect(results.findings).toHaveLength(2);
    for (const gone of ['coverage', 'requirementsLine', 'requirementsForm', 'canRecheck', 'requirements']) expect(results).not.toHaveProperty(gone);
    expect(results.tokens.map(t => t.pass)).toEqual(['Regular pass']);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'recheck' })).rejects.toThrow('Unknown run.');
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'reword' })).rejects.toThrow('Unknown run.');
    await expect(act(m, state, { type: 'background', choice: 'none' })).rejects.toThrow(/New review/);
    await expect(act(m, state, { type: 'ticket-key', key: 'PROJ-99' })).rejects.toThrow(/New review/);
  });

  it('the background and the model stay as the review was started', async () => {
    const m = manager();
    const state = await reviewed(m, 2);
    await expect(act(m, state, { type: 'own-text', text: 'other text' })).rejects.toThrow(/New review/);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'read-ticket' })).rejects.toThrow(/New review/);
  });
});

describe('a restart during a pass', () => {
  it('a security pass cut off by a restart during batch 3 of 5 keeps the findings of batches 1 and 2, stays unmarked and is offered again', async () => {
    const m = manager();
    let state = await reviewed(m, 5);
    hold(call => call.kind === 'security' && call.file === 3);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    await until(m, state.id, s => viewOf(s).progress === 'Security pass: 2 of 5 batches');

    // A new window: the first manager never finishes.
    const restored = await open(manager());
    expect(restored.running).toBeUndefined();
    const results = resultsOf(restored);
    expect(viewOf(restored).progress).toBeUndefined();
    expect(results.statuses).toEqual([expect.stringMatching(/^The security pass was cut off by a restart: 2 of 5 batches finished, and their findings are kept\..*not marked as run/)]);
    expect(titles(restored)).toEqual([
      'Token logged in f1', 'Token logged in f2',
      'Unchecked input in f1', 'Unchecked input in f2', 'Unchecked input in f3', 'Unchecked input in f4', 'Unchecked input in f5',
    ]);
    expect(results.passesRun).toEqual(['Regular']);
    expect(results.picker!.choices.find(c => c.step === 'security')).toMatchObject({ available: true, run: false, picked: true });
  });

  it('a regular pass cut off by a restart during batch 4 of 7 shows the findings of batches 1 to 3 under the interrupted banner, and the review takes extra passes', async () => {
    const m = manager();
    client.rawDiff = prDiff(7);
    const state = await open(m);
    hold(call => call.kind === 'regular' && call.file === 4);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
    await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 3 of 7 batches');

    const m2 = manager();
    let restored = await open(m2);
    expect(restored.running).toBeUndefined();
    expect(viewOf(restored).stage).toBe('review');
    const results = resultsOf(restored);
    expect(results.statuses).toEqual([expect.stringMatching(/^The regular pass was cut off by a restart: 3 of 7 batches finished, and their findings are kept\./)]);
    expect(results.hasReview).toBe(true);
    expect(titles(restored)).toEqual(['Unchecked input in f1', 'Unchecked input in f2', 'Unchecked input in f3']);
    expect(results.passesRun).toEqual([]);
    expect(results.canRunAgain).toBe(true);

    // As after a stop, the kept review takes an extra pass over every batch of the pull request.
    calls = [];
    restored = await runAndWait(m2, restored, { type: 'passes' });
    expect(calls.filter(c => c.kind === 'security')).toHaveLength(7);
    expect(resultsOf(restored).passesRun).toEqual(['Security']);
  });

  it('a regular pass cut off before its first batch finished has no findings and offers Run again', async () => {
    const m = manager();
    client.rawDiff = prDiff(4);
    const state = await open(m);
    hold(call => call.kind === 'regular' && call.file === 1);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
    await until(m, state.id, s => viewOf(s).progress === 'Regular pass: 0 of 4 batches');

    const restored = await open(manager());
    const results = resultsOf(restored);
    expect(results.statuses).toEqual([expect.stringMatching(/^The regular pass was cut off by a restart: 0 of 4 batches finished/)]);
    expect(results.hasReview).toBe(false);
    expect(results.canRunAgain).toBe(true);
  });
});

describe('what the review did not review, and what it dropped', () => {
  it('lists the batch that failed with its file, the finding outside the pull request and the findings the critic removed', async () => {
    respond = call => {
      if (call.kind === 'regular' && call.file === 2) throw new Error('The model is overloaded');
      if (call.kind === 'regular' && call.file === 1) {
        const outside = JSON.stringify({
          file: 'src/elsewhere.ts', line: 3, anchorCode: codeLine(1, 3), severity: 'warning', confidence: 0.9, title: 'Elsewhere', description: 'd', recommendation: 'r',
        });
        return reviewReply([findingLine(1, 2, 'Unchecked input in f1'), outside]);
      }
      return defaultRespond(call);
    };
    const m = manager();
    let state = await reviewed(m, 3);
    expect(resultsOf(state).notes).toEqual([
      'regular batch 2/3 — could not review src/f2.ts: The model is overloaded',
      '1 finding was dropped because it named a file outside this pull request.',
    ]);

    state = await act(m, state, { type: 'keep-as-is' });
    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await runAndWait(m, state, { type: 'passes' });

    expect(resultsOf(state).findings).toEqual([]);
    expect(resultsOf(state).notes).toEqual([
      'regular batch 2/3 — could not review src/f2.ts: The model is overloaded',
      '1 finding was dropped because it named a file outside this pull request.',
      '2 findings were removed by the critic as unverifiable: #1, #2.',
    ]);
  });

  it('names the files left out by the exclude patterns', async () => {
    extraSettings = { excludePatterns: ['f2.ts'] };
    const results = resultsOf(await reviewed(manager(), 2));
    expect(results.notes).toEqual(['1 file excluded by pattern.']);
  });
});

describe('a finding in full', () => {
  it('shows its description, recommendation, line with the related lines, provenance, confidence and source', async () => {
    respond = call => {
      if (call.kind !== 'regular') return defaultRespond(call);
      const finding = JSON.stringify({
        file: `src/f${call.file}.ts`, line: 2, anchorCode: codeLine(call.file, 2), relatedCode: [codeLine(call.file, 5), codeLine(call.file, 7)],
        severity: 'warning', confidence: 0.6, title: 'Unchecked input', description: 'The id reaches the query unchecked.', recommendation: 'Validate the id first.',
      });
      return reviewReply([finding]);
    };
    const [finding] = resultsOf(await reviewed(manager(), 1)).findings;
    expect(finding).toMatchObject({
      title: 'Unchecked input',
      description: 'The id reaches the query unchecked.',
      recommendation: 'Validate the id first.',
      facts: ['L2 (also L5, L7)', 'new code', 'confidence 0.6', 'source: general'],
      markers: ['low confidence'],
    });
  });
});

describe('the diagnostic timeline of a board review', () => {
  it('goes to the review\'s own logger, with the structured run record only when detailed diagnostics is on', async () => {
    await reviewed(manager(), 2);
    expect(reviewLines.some(line => /^\[pr=PROJ\/app#482\] pass1 batch 1\/2 attempt 1 — /.test(line))).toBe(true);
    expect(reviewLines.some(line => line.startsWith('Findings funnel — raw 2'))).toBe(true);
    expect(reviewLines).not.toContain('Configuration:');

    reviewLines = [];
    extraSettings = { detailedDiagnostics: true };
    const m = manager();
    await runAndWait(m, await open(m), { type: 'again' });
    expect(reviewLines).toContain('Configuration:');
    expect(reviewLines).toContain('Run: pr=PROJ/app#482');
  });
});

describe('the summary band above the findings', () => {
  it('after the regular pass the band is open with the counts and the suggested pass preselected; it folds, opens again, and a run of extra passes opens it', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    const results = resultsOf(state);
    expect(results.band).toMatchObject({
      state: 'open', counts: { total: 2, critical: 0, warning: 2, suggestion: 0, againstGoal: 0 }, background: 'None', notReviewed: [],
    });
    expect(results.band.tokens).toMatch(/input and .* output tokens/);
    expect(results.picker!.choices.find(c => c.step === 'security')?.picked).toBe(true);

    state = await act(m, state, { type: 'band', open: false });
    expect(resultsOf(state).band.state).toBe('folded');
    state = await act(m, state, { type: 'band', open: true });
    expect(resultsOf(state).band.state).toBe('open');
    state = await act(m, state, { type: 'band', open: false });

    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).band.state).toBe('open');
    expect(resultsOf(state).band.counts).toMatchObject({ total: 4, critical: 2 });
  });

  it('Not now folds the band', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'keep-as-is' });
    expect(resultsOf(state).band.state).toBe('folded');
  });

  it('while a pass runs the band is running, with the tokens of the run so far', async () => {
    const m = manager();
    let state = await reviewed(m, 5);
    const release = hold(call => call.kind === 'security' && call.file === 3);
    await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'passes' });
    state = await until(m, state.id, s => viewOf(s).progress === 'Security pass: 2 of 5 batches');
    const band = resultsOf(state).band;
    expect(band.state).toBe('running');
    expect(band.tokens).toMatch(/^[1-9][\d,]* input and \d[\d,]* output tokens in 2 call\(s\)/);
    expect(resultsOf(state).running?.passes).toEqual([{ step: 'security', text: 'Security pass: 2 of 5 batches', done: 2, total: 5 }]);
    release();
    await idle(m, state.id);
  });

  it('the review board leaves the run line and Stop of the shared header to its band', async () => {
    const state = await reviewed(manager(), 1);
    expect(viewOf(state).ownRunLine).toBe(true);
  });

  it('says what was reviewed: the files, the batches and the reviewed commit', async () => {
    const state = await reviewed(manager(), 2);
    expect(resultsOf(state).reviewed).toEqual({ files: ['src/f1.ts', 'src/f2.ts'], batches: 2, commit: HEAD.slice(0, 12) });
  });
});
