import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import type { ReviewBoardDeps } from '../boards/review/deps';
import { reviewKind, type ReviewView, type ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND } from '../boards/review/recipe';
import { registerKind } from '../sessions/boardKind';
import { SessionManager, type BoardState } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { RequirementsSourceResult } from '../services/TicketService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// The review board after its first step: the pass suggestion and picker, Run selected (persona
// passes, then the critic), Stop, the banners for a stopped, interrupted, failed or refused pass,
// Run again, the requirements re-check and the token usage per pass. A pull request whose files
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

type CallKind = 'reword' | 'regular' | 'whole-files' | 'security' | 'performance' | 'reliability' | 'maintainability' | 'critic' | 'requirements';

function kindOf(prompt: string): CallKind {
  if (prompt.startsWith('You are verifying the findings')) return 'critic';
  if (prompt.startsWith('You are checking whether a pull request')) return 'requirements';
  if (prompt.startsWith('A developer typed the goal')) return 'reword';
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
let ticketResult: RequirementsSourceResult;
let clock: number;
let jiraConfigured: boolean;

function requirementsReply(): string {
  return readFileSync(resolve(process.cwd(), 'src/test/fixtures/requirements-reply-clean-spec.json'), 'utf-8');
}

/** The regular pass finds one warning per file and suggests the security pass. */
const defaultRespond = (call: Call): string => {
  if (call.kind === 'requirements') return requirementsReply();
  if (call.kind === 'reword') return JSON.stringify({ inScope: ['Only the backend export endpoint'], outOfScope: ['The export button'], openPoints: [] });
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
      const text = await respond(call);
      if (signal.aborted) throw new ModelRequestCancelledError();
      return { text: (async function* () { yield text; })() };
    },
  };
}

function deps(): ReviewBoardDeps {
  return {
    bitbucket: async () => ({ configured: true, client }),
    jira: async () => (jiraConfigured ? { readRequirements: async () => ticketResult } : undefined),
    models: { list: async () => [MODEL], handle: async id => (id === MODEL.id ? handle(id) : undefined) },
    modelSettings: { reviewModel: () => MODEL.id, writeReviewModel: async () => {} },
    // One file per batch.
    settings: async () => ({ confidenceThreshold: 0.7, modelContextTokens: 2000, contextBudgetRatio: 1 }),
    recordTokens: async () => {},
    confirm: async question => { confirms.push(question.title); return confirmAnswer; },
    now: () => clock,
    sleep: async () => {},
  };
}

function manager(): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir), kinds: [registerKind(reviewKind, deps)], now: () => clock, confirm: async () => true, saveFile: async () => true,
  });
}

async function open(m: SessionManager): Promise<BoardState> {
  const opened = await m.open(REVIEW_KIND, { url: PR_URL });
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

/** Writes explanations and drafts into the stored session, as Explain and the drafts would. */
async function storeWork(id: string, work: Pick<ReviewWorking, 'explanations' | 'drafts'>): Promise<void> {
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
  ticketResult = {
    ok: true,
    source: { key: 'PROJ-12', summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false, comments: [], omittedComments: 0, commentsUnavailable: false },
  };
  clock = 1_000;
  jiraConfigured = true;
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
    await storeWork(state.id, { explanations: { [numbers['Token logged in f1']]: { text: 'The token reaches the log.' } }, drafts: { [numbers['Unchecked input in f2']]: { text: 'Please validate.' } } });

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
      ['Unchecked input in f2', ['probably a false alarm']],
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
    state = await act(m, state, { type: 'question', text: 'does this handle retries?' });
    state = await runAndWait(m, state, { type: 'start' });
    state = await runAndWait(m, state, { type: 'passes' });
    await storeWork(state.id, { explanations: { 1: { text: 'Explained.' } }, drafts: {} });
    const m2 = manager();
    state = await open(m2);

    calls = [];
    confirmAnswer = false;
    state = await runAndWait(m2, state, { type: 'again' });
    expect(confirms).toEqual(['Run the whole review again?']);
    expect(calls).toEqual([]);
    expect(resultsOf(state).notice).toMatch(/kept/);
    expect((await storedWorking(state.id)).explanations).toEqual({ 1: { text: 'Explained.' } });
    expect(resultsOf(state).passesRun).toEqual(['Regular', 'Security']);

    confirmAnswer = true;
    state = await runAndWait(m2, state, { type: 'again' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(c => c.kind === 'regular').every(c => c.prompt.includes('does this handle retries?'))).toBe(true);
    expect(resultsOf(state).passesRun).toEqual(['Regular']);
    expect((await storedWorking(state.id)).explanations).toEqual({});
  });

  it('a review with nothing worked on runs again without asking', async () => {
    const m = manager();
    const state = await reviewed(m, 2);
    await runAndWait(m, state, { type: 'again' });
    expect(confirms).toEqual([]);
  });
});

describe('the requirements check', () => {
  it('a ticket that cannot be read: the findings stand, the coverage position names the failed read, and Re-check runs only the check', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    ticketResult = { ok: false, reason: 'not-found', message: 'Issue does not exist' };
    const m = manager();
    let state = await reviewed(m, 2);
    let results = resultsOf(state);
    expect(results.findings).toHaveLength(2);
    expect(results.requirementsLine).toMatch(/the ticket PROJ-12 could not be read \(Issue does not exist\)/);
    expect(results.canRecheck).toBe(true);
    expect(results.coverage).toBeUndefined();

    ticketResult = {
      ok: true,
      source: { key: 'PROJ-12', summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false, comments: [], omittedComments: 0, commentsUnavailable: false },
    };
    calls = [];
    const started = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'recheck' });
    expect(started.running).toEqual([expect.objectContaining({ size: 'call', what: 'recheck' })]);
    state = await idle(m, state.id);
    results = resultsOf(state);
    expect(calls.map(c => c.kind)).toEqual(['requirements']);
    expect(results.coverage).toMatch(/Requirements coverage \(PROJ-12\)/);
    expect(results.requirementsLine).toBeUndefined();
    expect(results.findings).toHaveLength(2);
    expect(results.tokens.map(t => t.pass)).toEqual(['Regular pass', 'Requirements re-check']);
  });

  it('a check whose model reply is unreadable says it failed and offers Re-check', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    respond = call => (call.kind === 'requirements' ? 'no json here' : defaultRespond(call));
    const results = resultsOf(await reviewed(manager(), 2));
    expect(results.requirementsLine).toMatch(/^The requirements check failed/);
    expect(results.canRecheck).toBe(true);
    expect(results.findings).toHaveLength(2);
  });
});

describe('changing the requirements source after a review', () => {
  async function reviewedAgainstTicket(m: SessionManager): Promise<BoardState> {
    client.prOverride.title = 'PROJ-12 Add export';
    const state = await reviewed(m, 2);
    expect(resultsOf(state).coverage).toMatch(/Requirements coverage \(PROJ-12\)/);
    return state;
  }

  it('switching from the ticket to a reworded goal and re-checking makes one requirements call, replaces the coverage and leaves the findings', async () => {
    const m = manager();
    let state = await reviewedAgainstTicket(m);
    const before = resultsOf(state).findings;
    expect(resultsOf(state).requirementsForm).toMatchObject({ source: 'ticket', ticketKey: 'PROJ-12' });

    state = await act(m, state, { type: 'source', source: 'goal' });
    state = await act(m, state, { type: 'goal', text: 'export only the backend endpoint' });
    expect(resultsOf(state).requirementsForm).toMatchObject({ source: 'goal', goal: 'export only the backend endpoint', canReword: true });
    expect(resultsOf(state).coverage).toMatch(/PROJ-12/);

    calls = [];
    state = await runAndWait(m, state, { type: 'reword' });
    expect(calls.map(c => c.kind)).toEqual(['reword']);
    expect(resultsOf(state).requirementsForm!.points).toMatch(/Only the backend export endpoint/);

    calls = [];
    const started = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'recheck' });
    expect(started.running).toEqual([expect.objectContaining({ size: 'call', what: 'recheck' })]);
    state = await idle(m, state.id);
    expect(calls.map(c => c.kind)).toEqual(['requirements']);
    expect(calls[0].prompt).toContain('Only the backend export endpoint');
    const results = resultsOf(state);
    expect(results.requirements).toBe('the stated goal');
    expect(results.coverage).toMatch(/Stated goal/);
    expect(results.coverage).not.toMatch(/PROJ-12/);
    expect(results.findings).toEqual(before);
    expect(results.passesRun).toEqual(['Regular']);
  });

  it('switching to none and re-checking makes no call and removes the coverage', async () => {
    const m = manager();
    let state = await reviewedAgainstTicket(m);
    const before = resultsOf(state).findings;
    state = await act(m, state, { type: 'source', source: 'none' });
    expect(resultsOf(state).canRecheck).toBe(true);

    calls = [];
    state = await runAndWait(m, state, { type: 'recheck' });
    expect(calls).toEqual([]);
    const results = resultsOf(state);
    expect(results.coverage).toBeUndefined();
    expect(results.requirements).toBe('none');
    expect(results.findings).toEqual(before);
    // Nothing is left to check or remove.
    expect(results.canRecheck).toBe(false);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'recheck' })).rejects.toThrow(/ticket or a goal/);
  });

  it('a goal re-check needs the goal typed; the ticket is not offered while Jira is not configured', async () => {
    jiraConfigured = false;
    const m = manager();
    let state = await reviewed(m, 2);
    let form = resultsOf(state).requirementsForm!;
    expect(form.sources.find(s => s.id === 'ticket')).toMatchObject({ available: false, reason: expect.stringMatching(/Jira is not configured/) });
    await expect(act(m, state, { type: 'source', source: 'ticket' })).rejects.toThrow(/Jira is not configured/);

    state = await act(m, state, { type: 'source', source: 'goal' });
    form = resultsOf(state).requirementsForm!;
    expect(resultsOf(state).canRecheck).toBe(false);
    expect(form.recheckBlocker).toBe('Type the goal.');
  });

  it('the question and the model stay as the review was started', async () => {
    const m = manager();
    const state = await reviewed(m, 2);
    await expect(act(m, state, { type: 'question', text: 'other question' })).rejects.toThrow(/New review/);
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
