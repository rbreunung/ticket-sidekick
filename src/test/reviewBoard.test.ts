import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

type CallKind = 'review' | 'other';

/** Every review call carries the pull request's diff; any other call is not part of the review. */
function kindOf(prompt: string): CallKind {
  return prompt.includes('### File: src/f') ? 'review' : 'other';
}

let dir: string;
let client: MockBitbucketClient;
let setting: string;
let settingWrites: string[];
let available: typeof MODEL[];
let jiraConfigured: boolean;
let ticketReads: string[];
/** What a ticket read answers, by key. */
let ticketResult: (key: string) => RequirementsSourceResult;
/** What a ticket read waits for before it answers, by key. */
let readGate: (key: string) => Promise<void>;
let calls: Array<{ kind: CallKind; prompt: string }>;
let respond: (kind: CallKind, prompt: string) => Promise<string>;
let confirms: string[];
let confirmAnswer: boolean;
let recorded: string[];
let completed: number;
let clock: number;

const defaultRespond = async (_kind: CallKind): Promise<string> => {
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
        await readGate(key);
        return ticketResult(key);
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

/** Waits until the board's state meets `test`. */
async function until(m: SessionManager, id: string, test: (state: BoardState) => boolean): Promise<BoardState> {
  let state = await m.state(REVIEW_KIND, id);
  while (!test(state)) state = await m.state(REVIEW_KIND, id, state.tick, 1000);
  return state;
}

async function storedWorking(id: string): Promise<ReviewWorking> {
  return (await new SessionStore(dir).load(id))!.session.working as ReviewWorking;
}

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
  ticketResult = key => ({
    ok: true,
    source: {
      key, summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false,
      comments: [], omittedComments: 0, commentsUnavailable: false,
    },
  });
  readGate = async () => {};
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
    expect(view.firstStep?.canStart).toBe(false);
  });
});

describe('the background on the first step', () => {
  it('preselects the ticket when Jira is configured and the PR title has a key, and reads nothing until the read is asked for', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const step = viewOf(await open(manager())).firstStep!;
    expect(step).toMatchObject({ choice: 'ticket', ticketKey: 'PROJ-12', ticket: { state: 'idle', text: '', readNeeded: true } });
    expect(ticketReads).toEqual([]);
  });

  it('reading the ticket fills the box with its summary, description and newest comments', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    ticketResult = key => ({
      ok: true,
      source: {
        key, summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false,
        comments: [
          { author: 'Ann', created: '2026-11-20T10:00:00.000+0000', text: 'Also support semicolons.' },
          { author: 'Bob', created: '2026-11-18T10:00:00.000+0000', text: 'Keep the header row.' },
        ],
        omittedComments: 0, commentsUnavailable: false,
      },
    });
    const m = manager();
    const state = await runAndWait(m, await open(m), { type: 'read-ticket' });

    expect(ticketReads).toEqual(['PROJ-12']);
    const { ticket } = viewOf(state).firstStep!;
    expect(ticket).toMatchObject({ state: 'read', edited: false, readNeeded: false });
    expect(ticket.text).toBe([
      'Ticket PROJ-12: Add export', '', 'Description:', 'Export the report as CSV.', '', 'Comments (newest first):',
      '- Ann, 2026-11-20: Also support semicolons.', '- Bob, 2026-11-18: Keep the header row.',
    ].join('\n'));
    expect(calls).toEqual([]);
  });

  it('picking Jira ticket asks for a read of the key in the field', async () => {
    const m = manager();
    let state = await open(m);
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'none', ticket: { readNeeded: false } });
    state = await act(m, state, { type: 'background', choice: 'ticket' });
    state = await act(m, state, { type: 'ticket-key', key: 'proj-7' });
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'ticket', ticketKey: 'PROJ-7', ticket: { readNeeded: true } });
    state = await runAndWait(m, state, { type: 'read-ticket' });
    expect(ticketReads).toEqual(['PROJ-7']);
    expect(viewOf(state).firstStep!.ticket.text).toContain('Ticket PROJ-7: Add export');
  });

  it('preselects the ticket the request names over the one in the title', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const step = viewOf(await open(manager(), { url: PR_URL, ticketKey: 'proj-99' })).firstStep!;
    expect(step).toMatchObject({ choice: 'ticket', ticketKey: 'PROJ-99' });
  });

  it('a request with a ticket key and text opens with the own text preselected and the key kept in the ticket field, and nothing runs', async () => {
    const state = await open(manager(), { url: PR_URL, ticketKey: 'PROJ-123', background: 'watch thread safety' });
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'text', ownText: 'watch thread safety', ticketKey: 'PROJ-123', ticket: { readNeeded: false } });
    expect(viewOf(state).stage).toBe('first-step');
    expect(state.running ?? []).toEqual([]);
    expect(ticketReads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('asked for again with a ticket key and text while on the first step, shows them and keeps the model picked', async () => {
    client.prOverride.title = 'Add export';
    setting = '';
    const m = manager();
    let state = await open(m);
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'none', ownText: '' });
    state = await act(m, state, { type: 'pick-model', id: MODEL.id });
    state = await act(m, state, { type: 'own-text', text: 'An older text' });

    state = await open(m, { url: PR_URL, ticketKey: 'proj-99', background: 'Is the export safe?' });

    const view = viewOf(state);
    expect(view.firstStep).toMatchObject({ choice: 'text', ticketKey: 'PROJ-99', ownText: 'Is the export safe?' });
    expect(view.model.inUse).toMatchObject({ id: MODEL.id, picked: true });
    // Asked for again with nothing new, the first step stays as it is.
    const revision = state.revision;
    state = await open(m, { url: PR_URL });
    expect(state.revision).toBe(revision);
    expect(viewOf(state).firstStep).toMatchObject({ ticketKey: 'PROJ-99', ownText: 'Is the export safe?' });
  });

  it('asked for again with a ticket key and text once a review is shown, leaves the stored review as it is', async () => {
    const m = manager();
    let state = await runAndWait(m, await open(m, { url: PR_URL, background: 'First text' }), { type: 'start' });
    const before = viewOf(state).results!;
    const revision = state.revision;

    state = await open(m, { url: PR_URL, ticketKey: 'PROJ-99', background: 'Another text' });

    expect(state.revision).toBe(revision);
    expect(viewOf(state).stage).toBe('review');
    expect(viewOf(state).results).toEqual(before);
  });

  it('a read that Jira answers with 404 shows the reason in the box, and Start stays available', async () => {
    client.prOverride.title = 'PROJ-123 Add export';
    ticketResult = () => ({ ok: false, reason: 'not-found', message: 'Issue does not exist' });
    const m = manager();
    const state = await runAndWait(m, await open(m), { type: 'read-ticket' });
    const step = viewOf(state).firstStep!;
    expect(step.ticket).toMatchObject({ state: 'failed', text: '', reason: 'The ticket PROJ-123 was not found in Jira, or you have no access to it.', readNeeded: false });
    expect(step).toMatchObject({ canStart: true });
  });

  it('Start with a ticket that could not be read runs with no background, and says why', async () => {
    ticketResult = () => ({ ok: false, reason: 'not-found', message: 'Issue does not exist' });
    const m = manager();
    let state = await runAndWait(m, await open(m, { url: PR_URL, ticketKey: 'PROJ-123' }), { type: 'read-ticket' });
    state = await runAndWait(m, state, { type: 'start' });

    expect(viewOf(state).stage).toBe('review');
    const { startedWith } = await storedWorking(state.id);
    expect(startedWith?.background).toBeUndefined();
    expect(startedWith?.backgroundReason).toBe('The ticket PROJ-123 was not found in Jira, or you have no access to it.');
    expect(calls.filter(c => c.kind === 'review').some(c => c.prompt.includes('PROJ-123'))).toBe(false);
  });

  it('Start with the ticket read and trimmed keeps what was left in the box as the background', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    let state = await runAndWait(m, await open(m), { type: 'read-ticket' });
    state = await act(m, state, { type: 'ticket-text', text: 'Ticket PROJ-12: Add export\nOnly the CSV part.' });
    expect(viewOf(state).firstStep!.ticket.edited).toBe(true);
    state = await runAndWait(m, state, { type: 'start' });
    expect((await storedWorking(state.id)).startedWith?.background).toEqual({ kind: 'ticket', key: 'PROJ-12', text: 'Ticket PROJ-12: Add export\nOnly the CSV part.' });
    // The review calls get what was left in the box, inside the untrusted fence and not as instructions.
    const reviews = calls.filter(c => c.kind === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    for (const { prompt } of reviews) {
      const start = prompt.indexOf('«UNTRUSTED-CONTENT»\n');
      const inside = prompt.slice(start, prompt.indexOf('\n«END-UNTRUSTED-CONTENT»'));
      expect(start).toBeGreaterThan(-1);
      expect(inside).toContain('Background ticket PROJ-12');
      expect(inside).toContain('Only the CSV part.');
      expect(prompt.slice(0, start)).not.toContain('Only the CSV part.');
    }
  });

  it('Start with an emptied ticket box runs with no background, and says why', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    let state = await runAndWait(m, await open(m), { type: 'read-ticket' });
    state = await act(m, state, { type: 'ticket-text', text: '  ' });
    state = await runAndWait(m, state, { type: 'start' });
    const { startedWith } = await storedWorking(state.id);
    expect(startedWith?.background).toBeUndefined();
    expect(startedWith?.backgroundReason).toBe('The ticket box was empty.');
  });

  it('changing the key while a read runs drops the first read\'s result, and Start waits while a read runs', async () => {
    client.prOverride.title = 'PROJ-1 Add export';
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    readGate = key => (key === 'PROJ-1' ? held : Promise.resolve());
    const m = manager();
    let state = await open(m);
    state = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'read-ticket' });
    expect(viewOf(state).firstStep!.ticket.state).toBe('reading');
    expect(viewOf(state).firstStep).toMatchObject({ canStart: false, startBlocker: 'Wait for the ticket to be read.' });
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' })).rejects.toThrow(/Wait for the ticket to be read|is running/);

    state = await act(m, state, { type: 'ticket-key', key: 'PROJ-2' });
    expect(viewOf(state).firstStep!.ticket).toMatchObject({ state: 'idle', readNeeded: true });
    state = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'read-ticket' });
    await until(m, state.id, s => viewOf(s).firstStep!.ticket.state === 'read');
    release();
    state = await idle(m, state.id);

    expect(ticketReads).toEqual(['PROJ-1', 'PROJ-2']);
    expect(viewOf(state).firstStep!.ticket.text).toContain('Ticket PROJ-2: Add export');
    expect(viewOf(state).firstStep!.ticket.text).not.toContain('PROJ-1');
  });

  it('a second read over a box the developer edited asks before replacing it', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    const m = manager();
    let state = await runAndWait(m, await open(m), { type: 'read-ticket' });
    state = await act(m, state, { type: 'ticket-text', text: 'My trimmed ticket text' });

    confirmAnswer = false;
    state = await runAndWait(m, state, { type: 'read-ticket' });
    expect(confirms).toEqual(['Replace the text in the ticket box with PROJ-12?']);
    expect(ticketReads).toEqual(['PROJ-12']);
    expect(viewOf(state).firstStep).toMatchObject({ ticket: { state: 'read', text: 'My trimmed ticket text', readNeeded: false }, notice: 'Not read: your text in the ticket box was kept.' });

    confirmAnswer = true;
    state = await runAndWait(m, state, { type: 'read-ticket' });
    expect(ticketReads).toEqual(['PROJ-12', 'PROJ-12']);
    expect(viewOf(state).firstStep!.ticket).toMatchObject({ state: 'read', edited: false, text: expect.stringContaining('Ticket PROJ-12: Add export') });
  });

  it('with Jira not configured, the ticket choice shows the setup reason, and own text and none still work', async () => {
    client.prOverride.title = 'PROJ-12 Add export';
    jiraConfigured = false;
    const m = manager();
    let state = await open(m);
    const step = viewOf(state).firstStep!;
    expect(step.choice).toBe('none');
    expect(step.choices[0]).toMatchObject({ id: 'ticket', available: false, reason: expect.stringMatching(/Jira is not configured/) });
    expect(step.ticket.readNeeded).toBe(false);
    await expect(act(m, state, { type: 'background', choice: 'ticket' })).rejects.toThrow(/Jira is not configured/);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'read-ticket' })).rejects.toThrow(/Jira is not configured/);

    state = await act(m, state, { type: 'background', choice: 'text' });
    state = await act(m, state, { type: 'own-text', text: 'watch thread safety' });
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'text', canStart: true });
    state = await act(m, state, { type: 'background', choice: 'none' });
    expect(viewOf(state).firstStep).toMatchObject({ choice: 'none', canStart: true });
  });
});

describe('Start and the regular pass', () => {
  it('runs the regular pass with the own text and shows the findings by severity, with the passes run and the model', async () => {
    const m = manager();
    let state = await open(m);
    state = await act(m, state, { type: 'background', choice: 'text' });
    state = await act(m, state, { type: 'own-text', text: 'does this handle retries?' });
    state = await runAndWait(m, state, { type: 'start' });

    const results = viewOf(state).results!;
    expect(viewOf(state).stage).toBe('review');
    expect(results.findings.map(f => [f.number, f.severity, f.location, f.title])).toEqual([
      [2, 'critical', 'src/f1.ts:4', 'SQL built from input'],
      [1, 'suggestion', 'src/f1.ts:2', 'Unchecked input'],
    ]);
    expect(results).toMatchObject({ model: 'GPT Review (copilot)', passesRun: ['Regular'] });
    expect(calls.filter(c => c.kind === 'review').every(c => c.prompt.includes('does this handle retries?'))).toBe(true);
    expect((await storedWorking(state.id)).startedWith?.background).toEqual({ kind: 'text', text: 'does this handle retries?' });
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

  it('marks a finding the reviewer says goes against the background', async () => {
    respond = async kind => kind === 'review'
      ? [JSON.stringify({ ...JSON.parse(findingLine(1, 2, 'Expiry set to 0', 'warning')), againstGoal: true }), JSON.stringify({ additionalFilesNeeded: [] })].join('\n')
      : defaultRespond(kind);
    const m = manager();
    let state = await open(m);
    state = await act(m, state, { type: 'background', choice: 'text' });
    state = await act(m, state, { type: 'own-text', text: 'sessions must expire after the configured TTL' });
    state = await runAndWait(m, state, { type: 'start' });
    expect(viewOf(state).results?.findings[0].markers).toEqual(['against goal']);
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

  it('a review stored by the earlier format, with its requirements coverage, reopens on the first step with the rebuilt notice and runs nothing', async () => {
    const first = manager();
    const done = await runAndWait(first, await open(first), { type: 'start' });
    const file = path.join(dir, `${done.id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.formatVersion = 1;
    stored.working.review.requirements = { kind: 'ticket', key: 'PROJ-12' };
    stored.working.review.coverage = { ticketKey: 'PROJ-12', reading: 'old', requirements: [], outOfScope: [], noClearRequirements: true, unseenFileCount: 0 };
    fs.writeFileSync(file, JSON.stringify(stored));
    calls = [];
    client.getPullRequestDiffCalls = [];

    const state = await open(manager());

    expect(state.id).toBe(done.id);
    expect(state.notice).toMatch(/rebuilt after an update/);
    expect(state.running ?? []).toEqual([]);
    const view = viewOf(state);
    expect(view.stage).toBe('first-step');
    expect(view.pr.label).toBe('PROJ/app#482');
    expect(view.firstStep?.storedReview).toBe(false);
    expect(calls).toEqual([]);
    expect(client.getPullRequestDiffCalls).toEqual([]);
  });

  it('keys the session by the normalised pull request link', () => {
    expect(reviewSessionId({ url: PR_URL })).toBe(reviewSessionId({ url: PR_URL }));
  });
});
