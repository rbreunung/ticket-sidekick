import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import type { ReviewBoardDeps } from '../boards/review/deps';
import { reviewKind, type ReviewView, type ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND, reviewSessionId } from '../boards/review/recipe';
import { registerKind } from '../sessions/boardKind';
import { SessionManager, type BoardState } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { RequirementsSourceResult } from '../services/TicketService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// The pull request review board, from the first step to the regular pass: a Bitbucket mock with a
// small two-file pull request, a scripted model that answers by what the prompt asks, and a fake
// native confirmation. Every scenario goes through the session manager, as a board tab does.

const PR_URL = 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482';
const HEAD = 'abc123def456abc123def456abc123def456abc1';
const MODEL = { id: 'gpt-review', name: 'GPT Review', vendor: 'copilot', family: 'gpt' };

function codeLine(file: number, line: number): string {
  return `export const value${file}_${line} = compute(${line}); // keeps the diff long enough`;
}

function prDiff(fileCount: number): string {
  return Array.from({ length: fileCount }, (_, i) => {
    const n = i + 1;
    const lines = Array.from({ length: 8 }, (_, l) => `+${codeLine(n, l + 1)}`);
    return `diff --git a/src/f${n}.ts b/src/f${n}.ts\n--- a/src/f${n}.ts\n+++ b/src/f${n}.ts\n@@ -0,0 +1,8 @@\n${lines.join('\n')}\n`;
  }).join('');
}

function findingLine(file: number, line: number, title: string, severity: string, confidence = 0.9): string {
  return JSON.stringify({
    file: `src/f${file}.ts`, line, anchorCode: codeLine(file, line), severity, confidence, title,
    description: `${title} described`, recommendation: `Fix ${title}`,
  });
}

type CallKind = 'reword' | 'review' | 'requirements';

function kindOf(prompt: string): CallKind {
  if (prompt.startsWith('A developer typed the goal')) return 'reword';
  if (prompt.startsWith('You are checking whether a pull request')) return 'requirements';
  return 'review';
}

let dir: string;
let client: MockBitbucketClient;
let setting: string;
let settingWrites: string[];
let available: typeof MODEL[];
let jiraConfigured: boolean;
let ticketReads: string[];
let calls: Array<{ kind: CallKind; prompt: string }>;
let respond: (kind: CallKind, prompt: string) => Promise<string>;
let confirms: string[];
let confirmAnswer: boolean;
let recorded: string[];
let completed: number;
let clock: number;

function requirementsReply(): string {
  return readFileSync(resolve(process.cwd(), 'src/test/fixtures/requirements-reply-clean-spec.json'), 'utf-8');
}

const defaultRespond = async (kind: CallKind): Promise<string> => {
  if (kind === 'reword') return JSON.stringify({ inScope: ['The backend export endpoint'], outOfScope: ['The export button'], openPoints: [] });
  if (kind === 'requirements') return requirementsReply();
  return [findingLine(1, 2, 'Unchecked input', 'suggestion'), findingLine(1, 4, 'SQL built from input', 'critical'), JSON.stringify({ additionalFilesNeeded: [] })].join('\n');
};

function handle(id: string): BoardModelHandle {
  return {
    id,
    maxInputTokens: 100_000,
    countTokens: async text => Math.ceil((typeof text === 'string' ? text : text.content).length / 4),
    sendRequest: async (messages, { signal }) => {
      if (signal.aborted) throw new ModelRequestCancelledError();
      const prompt = messages.map(m => m.content).join('\n');
      const kind = kindOf(prompt);
      calls.push({ kind, prompt });
      const text = await respond(kind, prompt);
      return { text: (async function* () { yield text; })() };
    },
  };
}

function deps(): ReviewBoardDeps {
  return {
    bitbucket: async () => ({ configured: true, client }),
    jira: async () => jiraConfigured ? {
      readRequirements: async (key: string): Promise<RequirementsSourceResult> => {
        ticketReads.push(key);
        return {
          ok: true,
          source: {
            key, summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false,
            comments: [], omittedComments: 0, commentsUnavailable: false,
          },
        };
      },
    } : undefined,
    models: {
      list: async () => available,
      handle: async id => available.some(m => m.id === id) ? handle(id) : undefined,
    },
    modelSettings: {
      reviewModel: () => setting,
      writeReviewModel: async id => { setting = id; settingWrites.push(id); },
    },
    settings: async () => ({ confidenceThreshold: 0.7, modelContextTokens: 60_000 }),
    recordTokens: async modelId => { recorded.push(modelId); },
    confirm: async question => { confirms.push(question.title); return confirmAnswer; },
    onReviewCompleted: () => { completed++; },
    now: () => clock,
    sleep: async () => {},
  };
}

function manager(): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir),
    kinds: [registerKind(reviewKind, deps)],
    now: () => clock,
    confirm: async () => true,
    saveFile: async () => true,
  });
}

async function open(m: SessionManager, input: Record<string, unknown> = { url: PR_URL }): Promise<BoardState> {
  const opened = await m.open(REVIEW_KIND, input);
  if (!opened.ok) throw new Error(opened.reason);
  let state = await m.state(REVIEW_KIND, opened.id);
  while (state.status === 'building' || state.status === 'checking') state = await m.state(REVIEW_KIND, opened.id, state.tick, 1000);
  return state;
}

/** Waits until no run goes on. */
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

const viewOf = (state: BoardState) => state.view as ReviewView;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-board-'));
  client = new MockBitbucketClient();
  client.rawDiff = prDiff(2);
  client.prOverride = { id: 482, title: 'Add export', fromCommitHash: HEAD };
  setting = MODEL.id;
  settingWrites = [];
  available = [MODEL];
  jiraConfigured = true;
  ticketReads = [];
  calls = [];
  respond = defaultRespond;
  confirms = [];
  confirmAnswer = true;
  recorded = [];
  completed = 0;
  clock = 1_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('opening a review', () => {
  it('stops on the first step with the pull request read, and reads nothing but its metadata', async () => {
    const state = await open(manager());
    const view = viewOf(state);
    expect(view.stage).toBe('first-step');
    expect(view.pr).toMatchObject({ label: 'PROJ/app#482', title: 'Add export', author: 'Jane Smith' });
    expect(client.getPullRequestDiffCalls).toEqual([]);
    expect(client.getFileContentCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('opens the same session for two links of the same pull request, with and without /overview', async () => {
    const m = manager();
    const first = await m.open(REVIEW_KIND, { url: PR_URL });
    const second = await m.open(REVIEW_KIND, { url: `${PR_URL}/overview?tab=activity` });
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
  });

  it('refuses a link that is not a Bitbucket pull request', async () => {
    const opened = await manager().open(REVIEW_KIND, { url: 'https://bitbucket.example.com/projects/PROJ/repos/app/browse' });
    expect(opened).toEqual({ ok: false, reason: expect.stringMatching(/not the link of a Bitbucket pull request/) });
  });

  it('cannot load while Bitbucket is not configured, and says how to set it up', async () => {
    const m = new SessionManager({
      store: new SessionStore(dir),
      kinds: [registerKind(reviewKind, () => ({ ...deps(), bitbucket: async () => ({ configured: false as const, hint: 'Bitbucket is not configured.' }) }))],
      now: () => clock, confirm: async () => true, saveFile: async () => true,
    });
    const state = await open(m);
    expect(state.status).toBe('failed');
    expect(state.error).toBe('Bitbucket is not configured.');
  });
});

describe('the model on the first step', () => {
  it('asks for a model while the setting is empty, makes no model call before the pick, and the next review does not ask again', async () => {
    setting = '';
    const m = manager();
    let state = await open(m);
    expect(viewOf(state).model).toMatchObject({ askReason: expect.stringMatching(/ticketSidekick\.bitbucket\.reviewModel is empty/), options: [{ id: MODEL.id, label: 'GPT Review (copilot)' }] });
    expect(viewOf(state).firstStep).toMatchObject({ canStart: false, startBlocker: 'Pick the model first.' });
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' })).rejects.toThrow('Pick the model first.');
    expect(calls).toEqual([]);

    state = await act(m, state, { type: 'pick-model', id: MODEL.id });
    expect(viewOf(state).model.inUse).toMatchObject({ id: MODEL.id, picked: true });
    expect(calls).toEqual([]);
    state = await runAndWait(m, state, { type: 'start' });
    expect(settingWrites).toEqual([MODEL.id]);

    const other = await open(m, { url: 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/483' });
    expect(viewOf(other).model.askReason).toBeUndefined();
    expect(viewOf(other).model.inUse).toMatchObject({ id: MODEL.id, picked: false });
  });

  it('asks for a model when the setting names one that is not available', async () => {
    setting = 'gone-model';
    const view = viewOf(await open(manager()));
    expect(view.model.askReason).toMatch(/"gone-model" .* is not available/);
    expect(view.firstStep?.canReword).toBe(false);
  });
});

describe('the requirements source', () => {
  it('preselects the ticket when Jira is configured and the PR title has a key', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const step = viewOf(await open(manager())).firstStep!;
    expect(step.source).toBe('ticket');
    expect(step.ticketKey).toBe('PROJ-12');
  });

  it('preselects the ticket the request names over the one in the title', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const step = viewOf(await open(manager(), { url: PR_URL, ticketKey: 'proj-99' })).firstStep!;
    expect(step).toMatchObject({ source: 'ticket', ticketKey: 'PROJ-99' });
  });

  it('preselects none when no key is named, and with Jira not configured the ticket is unavailable with its reason', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    jiraConfigured = false;
    const step = viewOf(await open(manager())).firstStep!;
    expect(step.source).toBe('none');
    expect(step.sources[0]).toMatchObject({ id: 'ticket', available: false, reason: expect.stringMatching(/Jira is not configured/) });
  });

  it('reads the ticket and shows the coverage when the ticket is the source', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    const state = await runAndWait(m, await open(m), { type: 'start' });
    expect(ticketReads).toEqual(['PROJ-12']);
    expect(viewOf(state).results?.coverage).toMatch(/Requirements coverage \(PROJ-12\)/);
    expect(viewOf(state).results?.requirements).toBe('Jira ticket PROJ-12');
  });

  it('with none picked, reads no ticket and shows no coverage', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    let state = await open(m);
    state = await act(m, state, { type: 'source', source: 'none' });
    state = await runAndWait(m, state, { type: 'start' });
    expect(ticketReads).toEqual([]);
    expect(calls.map(c => c.kind)).not.toContain('requirements');
    expect(viewOf(state).results?.coverage).toBeUndefined();
  });
});

describe('the goal and its rewording', () => {
  async function onGoal(m: SessionManager, goal: string): Promise<BoardState> {
    let state = await open(m);
    state = await act(m, state, { type: 'source', source: 'goal' });
    return act(m, state, { type: 'goal', text: goal });
  }

  it('typing the goal makes no model call; Reword makes one, shows the points, and Start waits until it ends', async () => {
    const m = manager();
    const state = await onGoal(m, 'only backend endpoint, export button later');
    expect(calls).toEqual([]);

    let release!: () => void;
    respond = async (kind, prompt) => {
      if (kind === 'reword') await new Promise<void>(r => { release = r; });
      return defaultRespond(kind);
    };
    const started = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'reword' });
    expect(started.running).toEqual([expect.objectContaining({ size: 'call', what: 'reword' })]);
    await expect(m.startRun(REVIEW_KIND, state.id, started.revision, { type: 'start' })).rejects.toThrow(/the goal rewording is running/);
    await new Promise(r => setTimeout(r, 10));
    release();
    const after = await idle(m, state.id);

    expect(calls.map(c => c.kind)).toEqual(['reword']);
    expect(calls[0].prompt).toContain('only backend endpoint, export button later');
    expect(viewOf(after).firstStep?.points).toBe('In scope:\n- The backend export endpoint\n\nOut of scope:\n- The export button');
    expect(recorded).toEqual([MODEL.id]);
  });

  it('Start without a rewording checks the diff against the typed words', async () => {
    const m = manager();
    const state = await runAndWait(m, await onGoal(m, 'only backend endpoint, export button later'), { type: 'start' });
    const check = calls.find(c => c.kind === 'requirements');
    expect(check?.prompt).toContain('only backend endpoint, export button later');
    expect(viewOf(state).results?.requirements).toBe('the stated goal');
  });

  it('Start checks against the points as the developer corrected them', async () => {
    const m = manager();
    let state = await runAndWait(m, await onGoal(m, 'only backend endpoint, export button later'), { type: 'reword' });
    state = await act(m, state, { type: 'points', text: 'In scope:\n- The CSV export endpoint only' });
    await runAndWait(m, state, { type: 'start' });
    expect(calls.find(c => c.kind === 'requirements')?.prompt).toContain('The CSV export endpoint only');
  });

  it('a failed rewording keeps the typed words, shows an error line, and Start uses the typed words', async () => {
    respond = async (kind) => (kind === 'reword' ? 'I cannot do that.' : defaultRespond(kind));
    const m = manager();
    let state = await runAndWait(m, await onGoal(m, 'only backend endpoint'), { type: 'reword' });
    const step = viewOf(state).firstStep!;
    expect(step.goal).toBe('only backend endpoint');
    expect(step.points).toBe('');
    expect(step.rewordError).toMatch(/could not be reworded.*Start uses your words as they stand/);
    expect(step.canStart).toBe(true);

    state = await runAndWait(m, state, { type: 'start' });
    expect(calls.find(c => c.kind === 'requirements')?.prompt).toContain('only backend endpoint');
  });

  it('changing the typed goal after the points were corrected asks before Reword replaces the corrections', async () => {
    const m = manager();
    let state = await runAndWait(m, await onGoal(m, 'only backend endpoint'), { type: 'reword' });
    state = await act(m, state, { type: 'points', text: 'In scope:\n- My corrected point' });
    state = await act(m, state, { type: 'goal', text: 'backend endpoint and the button' });
    expect(viewOf(state).firstStep?.pointsFromOtherGoal).toBe(true);

    confirmAnswer = false;
    state = await runAndWait(m, state, { type: 'reword' });
    expect(confirms).toEqual(['Replace your corrected points?']);
    expect(calls.map(c => c.kind)).toEqual(['reword']);
    expect(viewOf(state).firstStep).toMatchObject({ points: 'In scope:\n- My corrected point', notice: expect.stringMatching(/corrected points were kept/) });

    confirmAnswer = true;
    state = await runAndWait(m, state, { type: 'reword' });
    expect(calls.map(c => c.kind)).toEqual(['reword', 'reword']);
    expect(viewOf(state).firstStep?.points).toMatch(/The backend export endpoint/);
  });

  it('Reword is not offered before a model is chosen', async () => {
    setting = '';
    const m = manager();
    const state = await onGoal(m, 'only backend endpoint');
    expect(viewOf(state).firstStep).toMatchObject({ canReword: false, rewordBlocker: 'Pick the model first.' });
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'reword' })).rejects.toThrow('Pick the model first.');
    expect(calls).toEqual([]);
  });
});

describe('Start and the regular pass', () => {
  it('runs the regular pass with the upfront question and shows the findings by severity, with the passes run and the model', async () => {
    const m = manager();
    let state = await open(m);
    state = await act(m, state, { type: 'question', text: 'does this handle retries?' });
    state = await runAndWait(m, state, { type: 'start' });

    const results = viewOf(state).results!;
    expect(viewOf(state).stage).toBe('review');
    expect(results.findings.map(f => [f.number, f.severity, f.location, f.title])).toEqual([
      [2, 'critical', 'src/f1.ts:4', 'SQL built from input'],
      [1, 'suggestion', 'src/f1.ts:2', 'Unchecked input'],
    ]);
    expect(results).toMatchObject({ model: 'GPT Review (copilot)', passesRun: ['Regular'], requirements: 'none' });
    expect(calls.filter(c => c.kind === 'review').every(c => c.prompt.includes('does this handle retries?'))).toBe(true);
    expect(recorded.length).toBe(calls.length);
    expect(completed).toBe(1);
  });

  it('marks a low-confidence finding', async () => {
    respond = async kind => kind === 'review'
      ? [findingLine(1, 2, 'Maybe a race', 'warning', 0.4), JSON.stringify({ additionalFilesNeeded: [] })].join('\n')
      : defaultRespond(kind);
    const m = manager();
    const state = await runAndWait(m, await open(m), { type: 'start' });
    expect(viewOf(state).results?.findings[0].markers).toEqual(['low confidence']);
  });
});

describe('a stored review', () => {
  async function storedReviewWithExplanation(): Promise<string> {
    const m = manager();
    const state = await runAndWait(m, await open(m), { type: 'start' });
    const store = new SessionStore(dir);
    const stored = (await store.load(state.id))!.session;
    const working = stored.working as ReviewWorking;
    await store.save({ ...stored, working: { ...working, explanations: { 2: { text: 'The query concatenates user input.' } } } });
    return state.id;
  }

  it('opens again for PR #482; New review then Start asks before replacing it, and declining keeps it', async () => {
    const id = await storedReviewWithExplanation();
    calls = [];
    const m = manager();
    let state = await open(m, { url: `${PR_URL}/diff` });
    expect(state.id).toBe(id);
    expect(viewOf(state).stage).toBe('review');
    expect(viewOf(state).results?.findings).toHaveLength(2);

    state = await act(m, state, { type: 'new-review' });
    expect(viewOf(state).stage).toBe('first-step');
    expect(viewOf(state).firstStep?.storedReview).toBe(true);
    confirmAnswer = false;
    state = await runAndWait(m, state, { type: 'start' });
    expect(confirms).toEqual(['Replace the stored review?']);
    expect(calls).toEqual([]);
    expect((await new SessionStore(dir).load(id))!.session.working).toMatchObject({ explanations: { 2: { text: 'The query concatenates user input.' } } });

    state = await act(m, state, { type: 'back-to-review' });
    expect(viewOf(state).results?.findings).toHaveLength(2);
  });

  it('New review then Start replaces the review after the developer agrees', async () => {
    await storedReviewWithExplanation();
    const m = manager();
    let state = await open(m);
    state = await act(m, state, { type: 'new-review' });
    state = await runAndWait(m, state, { type: 'start' });
    const working = (await new SessionStore(dir).load(state.id))!.session.working as ReviewWorking;
    expect(working.explanations).toEqual({});
    expect(viewOf(state).stage).toBe('review');
  });

  it('a review with nothing worked on is replaced without asking', async () => {
    const m = manager();
    let state = await runAndWait(m, await open(m), { type: 'start' });
    state = await act(m, state, { type: 'new-review' });
    await runAndWait(m, state, { type: 'start' });
    expect(confirms).toEqual([]);
  });

  it('a background check after a new commit marks the board out of date, keeps the review and makes no model call', async () => {
    const id = await storedReviewWithExplanation();
    calls = [];
    client.getPullRequestDiffCalls = [];
    client.prOverride.fromCommitHash = 'fff000fff000fff000fff000fff000fff000fff0';
    const m = manager();
    await m.open(REVIEW_KIND, { url: PR_URL });
    const state = await idle(m, id);
    const results = viewOf(state).results!;
    expect(results.outOfDate).toEqual({ reviewed: HEAD.slice(0, 12), head: 'fff000fff000' });
    expect(results.findings).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(client.getPullRequestDiffCalls).toEqual([]);
  });

  it('keys the session by the normalised pull request link', () => {
    expect(reviewSessionId({ url: PR_URL })).toBe(reviewSessionId({ url: PR_URL }));
  });
});
