import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerBoardRequest, asBoardRequest, type BoardHost } from '../boards/boardMessages';
import { ModelRequestCancelledError, type BoardModelHandle } from '../boards/boardModels';
import type { ReviewBoardDeps } from '../boards/review/deps';
import { reviewKind, type FindingView, type ReviewSession, type ReviewView, type ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND } from '../boards/review/recipe';
import { registerKind } from '../sessions/boardKind';
import { SessionManager, type BoardState } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { InlineAnchor } from '../bitbucket/IBitbucketClient';
import type { TokenFigures } from '../utils/tokenUsage';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// What the developer does with the findings on the review board: Explain one, select findings,
// which drafts a comment under each, edit or Rewrite a draft (with Undo), Post the selected drafts
// after the native confirmation, and Copy them for Teams or as Markdown. A pull request with one
// file per batch, a scripted model that answers by what the prompt asks, and a fake Bitbucket.
// Every scenario goes through the session manager (and Copy through the tab's message channel), as
// a board tab does.

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

/** The title the regular pass gives the finding in file `n`; file 4's has Markdown characters in it. */
function titleOf(file: number): string {
  return file === 4 ? 'Use *any* [type] here' : `Unchecked input in f${file}`;
}

function regularReply(file: number): string {
  return [
    JSON.stringify({
      file: `src/f${file}.ts`, line: 2, anchorCode: codeLine(file, 2), severity: 'warning', confidence: 0.9, title: titleOf(file),
      description: `The value from f${file} is used unchecked`, recommendation: `Validate the input of f${file}`,
    }),
    JSON.stringify({ additionalFilesNeeded: [], recommendedPersonas: [] }),
  ].join('\n');
}

type CallKind = 'explain' | 'rewrite' | 'critic' | 'review';

function kindOf(prompt: string): CallKind {
  if (prompt.startsWith('You are verifying the findings')) return 'critic';
  if (prompt.startsWith('A developer is asking a follow-up question')) return 'explain';
  if (prompt.startsWith('You are a code review assistant')) return 'rewrite';
  return 'review';
}

function fileOf(prompt: string): number {
  const m = /### File: src\/f(\d+)\.ts/.exec(prompt) ?? /File: src\/f(\d+)\.ts/.exec(prompt);
  return m ? Number(m[1]) : 0;
}

interface Call { kind: CallKind; file: number; prompt: string }

let dir: string;
let client: MockBitbucketClient;
let calls: Call[];
let respond: (call: Call) => string | Promise<string>;
let confirmAnswer: boolean;
let confirmed: Array<{ title: string; lines: Array<{ target: string; change: string }> }>;
let recorded: Array<{ modelId: string; figures: TokenFigures }>;
let explainCount: number;
/** The Bitbucket setup hint the board gets, when set; Bitbucket counts as configured otherwise. */
let bitbucketHint: string | undefined;

const defaultRespond = (call: Call): string => {
  if (call.kind === 'explain') return `Answer ${++explainCount} about f${call.file}`;
  if (call.kind === 'rewrite') return 'A shorter comment.';
  if (call.kind === 'critic') return JSON.stringify({ keep: [] });
  return regularReply(call.file);
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
      // A call stopped while it waited for its answer ends as the host ends it: cancelled.
      if (signal.aborted) throw new ModelRequestCancelledError();
      return { text: (async function* () { yield text; })() };
    },
  };
}

function deps(): ReviewBoardDeps {
  return {
    bitbucket: async () => (bitbucketHint ? { configured: false, hint: bitbucketHint } : { configured: true, client }),
    jira: async () => undefined,
    models: { list: async () => [MODEL], handle: async id => (id === MODEL.id ? handle(id) : undefined) },
    modelSettings: { reviewModel: () => MODEL.id, writeReviewModel: async () => {} },
    settings: async () => ({ confidenceThreshold: 0.7, modelContextTokens: 2000, contextBudgetRatio: 1 }),
    recordTokens: async (modelId, figures) => { recorded.push({ modelId, figures }); },
    confirm: async () => true,
    now: () => 1_000,
    sleep: async () => {},
  };
}

function manager(): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir),
    kinds: [registerKind(reviewKind, deps)],
    now: () => 1_000,
    confirm: async plan => { confirmed.push(plan); return confirmAnswer; },
    saveFile: async () => true,
  });
}

async function idle(m: SessionManager, id: string): Promise<BoardState> {
  let state = await m.state(REVIEW_KIND, id);
  while (state.running || state.status === 'checking' || state.status === 'building') state = await m.state(REVIEW_KIND, id, state.tick, 1000);
  return state;
}

async function act(m: SessionManager, state: BoardState, action: Record<string, unknown>): Promise<BoardState> {
  return m.action(REVIEW_KIND, state.id, state.revision, action);
}

async function runAndWait(m: SessionManager, state: BoardState, request: Record<string, unknown>): Promise<BoardState> {
  await m.startRun(REVIEW_KIND, state.id, state.revision, request);
  return idle(m, state.id);
}

/** A review of `files` files, one finding per file, numbered #1 to #n by file, started with an upfront question. */
async function reviewed(m: SessionManager, files: number): Promise<BoardState> {
  client.rawDiff = prDiff(files);
  const opened = await m.open(REVIEW_KIND, { url: PR_URL });
  if (!opened.ok) throw new Error(opened.reason);
  let state = await idle(m, opened.id);
  state = await act(m, state, { type: 'question', text: 'Is the export safe for large reports?' });
  state = await runAndWait(m, state, { type: 'start' });
  calls = [];
  recorded = [];
  return state;
}

const resultsOf = (state: BoardState) => (state.view as ReviewView).results!;

/** The session as stored, for a scenario that hands it to the board kind itself. */
async function storedSession(id: string): Promise<ReviewSession> {
  return (await new SessionStore(dir).load(id))!.session as ReviewSession;
}

/** The same session after Run again or New review replaced its review: another reviewed commit and no explanations or drafts. */
function replacedReview(working: ReviewWorking): ReviewWorking {
  const review = working.review!;
  return { ...working, explanations: {}, drafts: {}, selected: [], review: { ...review, snapshot: { ...review.snapshot, reviewedCommit: 'fff000fff000fff000fff000fff000fff000fff0' } } };
}
const finding = (state: BoardState, n: number): FindingView => resultsOf(state).findings.find(f => f.number === n)!;
const draftOf = (state: BoardState, n: number) => finding(state, n).draft!;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-findings-'));
  client = new MockBitbucketClient();
  client.prOverride = { id: 482, title: 'Add export', description: 'Exports the report as CSV.', fromCommitHash: HEAD };
  calls = [];
  recorded = [];
  respond = defaultRespond;
  confirmAnswer = true;
  confirmed = [];
  explainCount = 0;
  bitbucketHint = undefined;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Explain', () => {
  it('explaining #3 makes one model call with its code, the pull request and the upfront question, and shows the answer; explaining again replaces it', async () => {
    const m = manager();
    let state = await reviewed(m, 3);
    state = await runAndWait(m, state, { type: 'explain', number: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('explain');
    expect(calls[0].prompt).toContain(codeLine(3, 2));
    expect(calls[0].prompt).not.toContain(codeLine(1, 2));
    expect(calls[0].prompt).toContain('Is the export safe for large reports?');
    expect(calls[0].prompt).toContain('PR: Add export');
    expect(calls[0].prompt).toContain('Exports the report as CSV.');
    expect(finding(state, 3).explanation).toBe('Answer 1 about f3');
    expect(finding(state, 2).explanation).toBeUndefined();

    state = await runAndWait(m, state, { type: 'explain', number: 3 });
    expect(finding(state, 3).explanation).toBe('Answer 2 about f3');
  });

  it('a failed explanation shows an error line under the finding and keeps the earlier answer', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await runAndWait(m, state, { type: 'explain', number: 1 });
    respond = () => { throw new Error('rate limited'); };
    state = await runAndWait(m, state, { type: 'explain', number: 1 });
    expect(finding(state, 1).explanation).toBe('Answer 1 about f1');
    expect(finding(state, 1).explainError).toBe('Explain failed: rate limited');
    respond = defaultRespond;
    state = await runAndWait(m, state, { type: 'explain', number: 1 });
    expect(finding(state, 1).explainError).toBeUndefined();
  });

  it('an answer that arrives after the review was replaced leaves the new review untouched, but its tokens are still counted', async () => {
    const m = manager();
    const state = await reviewed(m, 2);
    const session = await storedSession(state.id);
    for (const request of [{ type: 'explain' as const, number: 1 }, { type: 'rewrite' as const, number: 1, instruction: 'Shorter' }]) {
      const asked = request.type === 'rewrite'
        ? { ...session, working: { ...session.working, selected: [1], drafts: { 1: { text: 'Old comment.' } } } }
        : session;
      const finished = await reviewKind.run!(asked, request, deps(), async () => {}, new AbortController().signal);
      const replaced = replacedReview(session.working);
      const after = finished.update!(replaced);
      expect(after.explanations, request.type).toEqual({});
      expect(after.drafts, request.type).toEqual({});
      expect(after.review, request.type).toEqual(replaced.review);
      expect(after.callTokens?.calls, request.type).toBe((replaced.callTokens?.calls ?? 0) + 1);
    }
    expect(recorded.map(r => r.modelId)).toEqual([MODEL.id, MODEL.id]);
  });

  it('Stop during an explanation shows no failure line and no answer', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    respond = async call => { await gate; return defaultRespond(call); };
    state = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'explain', number: 1 });
    await m.stopRun(REVIEW_KIND, state.id, 'explain:1');
    release();
    state = await idle(m, state.id);
    expect(finding(state, 1).explainError).toBeUndefined();
    expect(finding(state, 1).explanation).toBeUndefined();
    expect(state.notice).toBeUndefined();
  });

  it('is refused for a finding that is not in the review', async () => {
    const m = manager();
    const state = await reviewed(m, 1);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'explain', number: 9 })).rejects.toThrow('no longer in the review');
  });
});

describe('selection and drafts', () => {
  it('selecting a finding drafts its comment once, from the finding and its explanation', async () => {
    const m = manager();
    let state = await reviewed(m, 3);
    state = await runAndWait(m, state, { type: 'explain', number: 3 });
    state = await act(m, state, { type: 'select', numbers: [3], selected: true });
    const draft = draftOf(state, 3);
    expect(finding(state, 3).selected).toBe(true);
    expect(draft.text).toContain('Unchecked input in f3');
    expect(draft.text).toContain('Validate the input of f3');
    expect(draft.text).toContain('Answer 1 about f3');
    expect(draft.outdated).toBe(false);
    expect(finding(state, 1).draft).toBeUndefined();
    expect(resultsOf(state).selectedCount).toBe(1);

    // Unselecting and selecting again keeps the draft as it is: it is made once.
    state = await act(m, state, { type: 'draft', number: 3, text: 'My own words.' });
    state = await act(m, state, { type: 'select', numbers: [3], selected: false });
    state = await act(m, state, { type: 'select', numbers: [3], selected: true });
    expect(draftOf(state, 3).text).toBe('My own words.');
  });

  it('select all selects every finding and drafts each', async () => {
    const m = manager();
    let state = await reviewed(m, 3);
    state = await act(m, state, { type: 'select', numbers: [1, 2, 3], selected: true });
    expect(resultsOf(state).findings.every(f => f.selected && f.draft)).toBe(true);
    expect(resultsOf(state).post.count).toBe(3);
    expect(resultsOf(state).copy).toEqual({ scope: 'selected', count: 3 });
    state = await act(m, state, { type: 'select', numbers: [1, 2, 3], selected: false });
    expect(resultsOf(state).copy).toEqual({ scope: 'all', count: 3 });
    expect(resultsOf(state).post.blocker).toBe('Select the findings to post.');
  });

  it('a new explanation marks the existing draft outdated without changing it, and Regenerate rebuilds it', async () => {
    const m = manager();
    let state = await reviewed(m, 3);
    state = await runAndWait(m, state, { type: 'explain', number: 3 });
    state = await act(m, state, { type: 'select', numbers: [3], selected: true });
    const before = draftOf(state, 3).text;
    state = await runAndWait(m, state, { type: 'explain', number: 3 });
    expect(draftOf(state, 3).outdated).toBe(true);
    expect(draftOf(state, 3).text).toBe(before);

    state = await act(m, state, { type: 'regenerate', number: 3 });
    expect(draftOf(state, 3).outdated).toBe(false);
    expect(draftOf(state, 3).text).toContain('Answer 2 about f3');
    expect(draftOf(state, 3).text).not.toContain('Answer 1 about f3');
  });

  it('a selected finding the critic removes drops out of the selection', async () => {
    let state = await reviewed(manager(), 2);
    // Selected without a draft, as a session from before drafts were made on selecting would be.
    const store = new SessionStore(dir);
    const stored = (await store.load(state.id))!.session;
    await store.save({ ...stored, working: { ...(stored.working as ReviewWorking), selected: [1, 2], drafts: { 2: { text: 'Keep me.' } } } });
    const m = manager();
    state = await idle(m, (await m.open(REVIEW_KIND, { url: PR_URL }) as { id: string }).id);
    expect(resultsOf(state).selectedCount).toBe(2);
    state = await act(m, state, { type: 'pick-pass', step: 'critic', picked: true });
    state = await runAndWait(m, state, { type: 'passes' });
    expect(resultsOf(state).findings.map(f => f.number)).toEqual([2]);
    expect(resultsOf(state).selectedCount).toBe(1);
    expect(finding(state, 2).selected).toBe(true);
  });

  it('a draft box stays editable while an explanation runs', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    respond = async call => { await gate; return defaultRespond(call); };
    state = await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'explain', number: 2 });
    expect(state.running?.map(r => r.what)).toEqual(['explain:2']);
    state = await act(m, state, { type: 'draft', number: 1, text: 'Edited during the explanation.' });
    state = await act(m, state, { type: 'select', numbers: [2], selected: true });
    release();
    state = await idle(m, state.id);
    expect(draftOf(state, 1).text).toBe('Edited during the explanation.');
    expect(finding(state, 2).explanation).toBe('Answer 1 about f2');
  });
});

describe('Rewrite', () => {
  it('a failed Rewrite leaves the hand-edited text unchanged and shows the error under the draft', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    state = await act(m, state, { type: 'draft', number: 1, text: 'Hand-edited comment.' });
    respond = () => { throw new Error('model unavailable'); };
    state = await runAndWait(m, state, { type: 'rewrite', number: 1, instruction: 'Make it shorter' });
    expect(draftOf(state, 1).text).toBe('Hand-edited comment.');
    expect(draftOf(state, 1).rewriteError).toBe('Rewrite failed: model unavailable');
    expect(draftOf(state, 1).canUndo).toBe(false);
  });

  it('a successful Rewrite uses the instruction and offers Undo, which restores the previous text until the next edit', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    state = await act(m, state, { type: 'draft', number: 1, text: 'Hand-edited comment.' });
    state = await runAndWait(m, state, { type: 'rewrite', number: 1, instruction: 'Make it shorter' });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Make it shorter');
    expect(calls[0].prompt).toContain('Hand-edited comment.');
    expect(draftOf(state, 1).text).toBe('A shorter comment.');
    expect(draftOf(state, 1).canUndo).toBe(true);
    state = await act(m, state, { type: 'undo-rewrite', number: 1 });
    expect(draftOf(state, 1).text).toBe('Hand-edited comment.');
    expect(draftOf(state, 1).canUndo).toBe(false);

    state = await runAndWait(m, state, { type: 'rewrite', number: 1, instruction: 'Make it shorter' });
    state = await act(m, state, { type: 'draft', number: 1, text: 'Edited after the rewrite.' });
    expect(draftOf(state, 1).canUndo).toBe(false);
    await expect(act(m, state, { type: 'undo-rewrite', number: 1 })).rejects.toThrow('There is no rewrite to undo.');
  });

  it('is refused without an instruction or without a draft', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'rewrite', number: 1, instruction: 'Shorter' })).rejects.toThrow('Select it for posting first');
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'rewrite', number: 1, instruction: '  ' })).rejects.toThrow('Type how the comment should change');
    expect(calls).toEqual([]);
  });

  it('is refused with an instruction longer than 2000 characters, and no model call is made', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    await expect(m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'rewrite', number: 1, instruction: 'x'.repeat(2001) }))
      .rejects.toThrow('The instruction is longer than 2000 characters.');
    expect(calls).toEqual([]);
    state = await runAndWait(m, state, { type: 'rewrite', number: 1, instruction: 'x'.repeat(2000) });
    expect(calls).toHaveLength(1);
  });
});

describe('Post', () => {
  it('previews each selected draft as it is, and declining the native confirmation posts nothing and keeps the drafts', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'select', numbers: [1, 2], selected: true });
    state = await act(m, state, { type: 'draft', number: 2, text: 'Second comment, edited.' });
    const plan = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    expect(plan.risky).toBe(true);
    expect(plan.lines.map(l => l.target)).toEqual(['#1', '#2']);
    expect(plan.lines[1].change).toBe('Post inline at src/f2.ts:2: "Second comment, edited."');

    confirmAnswer = false;
    await expect(m.apply(REVIEW_KIND, state.id, plan.planId)).rejects.toThrow('the confirmation was declined');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].lines.map(l => l.target)).toEqual(['#1', '#2']);
    expect(client.addPrCommentCalls).toEqual([]);
    state = await idle(m, state.id);
    expect(draftOf(state, 2).text).toBe('Second comment, edited.');
    expect(draftOf(state, 2).posted).toBeUndefined();
  });

  it('cannot post without a plan id from a preview', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    await expect(m.apply(REVIEW_KIND, state.id, 'f'.repeat(48))).rejects.toThrow('no longer valid');
    expect(client.addPrCommentCalls).toEqual([]);
  });

  it('is refused with nothing selected', async () => {
    const m = manager();
    const state = await reviewed(m, 1);
    await expect(m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' })).rejects.toThrow('Select the findings to post first.');
  });

  it('posting #2 and #5 when #5 fails reports #2 posted and #5 failed, and offers only #5 again', async () => {
    const m = manager();
    let state = await reviewed(m, 5);
    const realAdd = client.addPrComment.bind(client);
    client.addPrComment = async (project: string, repo: string, prId: number, text: string, inline?: InlineAnchor) => {
      if (inline?.filePath === 'src/f5.ts') throw new Error('Bitbucket said 500');
      return realAdd(project, repo, prId, text, inline);
    };
    state = await act(m, state, { type: 'select', numbers: [2, 5], selected: true });
    const plan = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    const applied = await m.apply(REVIEW_KIND, state.id, plan.planId);
    expect(applied.results).toEqual([
      { target: '#2', outcome: 'done' },
      { target: '#5', outcome: 'failed', reason: 'Bitbucket said 500' },
    ]);
    state = applied.state;
    expect(draftOf(state, 2).posted).toBe('Posted as comment 100.');
    expect(draftOf(state, 5).postError).toBe('Not posted: Bitbucket said 500');
    expect(resultsOf(state).post.count).toBe(1);
    expect(client.addPrCommentCalls.map(c => c.inline?.filePath)).toEqual(['src/f2.ts']);

    client.addPrComment = realAdd;
    const retry = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    expect(retry.lines.map(l => l.target)).toEqual(['#5']);
    const second = await m.apply(REVIEW_KIND, state.id, retry.planId);
    expect(second.results).toEqual([{ target: '#5', outcome: 'done' }]);
    expect(client.addPrCommentCalls.map(c => c.inline?.filePath)).toEqual(['src/f2.ts', 'src/f5.ts']);
    expect(draftOf(second.state, 5).posted).toBeDefined();
    expect(resultsOf(second.state).post.blocker).toBe('The selected comments are posted already.');
    await expect(act(m, second.state, { type: 'draft', number: 2, text: 'too late' })).rejects.toThrow('posted already');
  });
});

describe('Post on a review that is out of date, unconfigured or changed', () => {
  it('a review of an older commit says so in the plan, and so in the native confirmation; what is posted stays the same', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    const current = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    expect(current.lines.map(l => l.target)).toEqual(['#1']);

    client.prOverride.fromCommitHash = 'fff000fff000fff000fff000fff000fff000fff0';
    state = await idle(m, (await m.refresh(REVIEW_KIND, state.id)).id);
    expect(resultsOf(state).outOfDate).toBeDefined();
    const plan = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    expect(plan.lines[0]).toEqual({
      target: 'Out of date',
      change: `This review read commit ${HEAD.slice(0, 12)}; the pull request is now at fff000fff000. Inline comments are anchored to the lines that were reviewed, which may have moved since.`,
    });
    expect(plan.lines.slice(1)).toEqual(current.lines);
    await m.apply(REVIEW_KIND, state.id, plan.planId);
    expect(confirmed[0].lines[0].target).toBe('Out of date');
    expect(client.addPrCommentCalls).toHaveLength(1);
    expect(client.addPrCommentCalls[0].inline).toMatchObject({ filePath: 'src/f1.ts', line: 2 });
  });

  it('with Bitbucket no longer configured, marks each draft failed with the setup hint and posts nothing', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'select', numbers: [1, 2], selected: true });
    const plan = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    bitbucketHint = 'Bitbucket is not configured. Set the token first.';
    const applied = await m.apply(REVIEW_KIND, state.id, plan.planId);
    expect(applied.results).toEqual([
      { target: '#1', outcome: 'failed', reason: 'Bitbucket is not configured. Set the token first.' },
      { target: '#2', outcome: 'failed', reason: 'Bitbucket is not configured. Set the token first.' },
    ]);
    expect(draftOf(applied.state, 1).postError).toBe('Not posted: Bitbucket is not configured. Set the token first.');
    expect(resultsOf(applied.state).post.count).toBe(2);
    expect(client.addPrCommentCalls).toEqual([]);
  });

  it('refuses a previewed finding that is no longer in the review and posts the others', async () => {
    const m = manager();
    let state = await reviewed(m, 2);
    state = await act(m, state, { type: 'select', numbers: [1, 2], selected: true });
    const session = await storedSession(state.id);
    const planned = reviewKind.plan!(session, { type: 'post' });
    if (!planned.ok) throw new Error(planned.reason);
    // The critic removed #1 after the preview.
    const review = session.working.review!;
    const changed: ReviewSession = {
      ...session,
      working: { ...session.working, review: { ...review, store: { ...review.store, findings: review.store.findings.filter(f => f.id !== 1) } } },
    };
    const applied = await reviewKind.apply!(changed, planned.plan, deps());
    expect(applied.results).toEqual([
      { target: '#1', outcome: 'refused', reason: 'no longer in the review' },
      { target: '#2', outcome: 'done' },
    ]);
    expect(client.addPrCommentCalls.map(c => c.inline?.filePath)).toEqual(['src/f2.ts']);
  });
});

describe('token counters', () => {
  it('Explain and Rewrite each count toward the monthly per-model counters, and Post makes no model call', async () => {
    const m = manager();
    let state = await reviewed(m, 1);
    state = await runAndWait(m, state, { type: 'explain', number: 1 });
    expect(recorded.map(r => r.modelId)).toEqual([MODEL.id]);
    state = await act(m, state, { type: 'select', numbers: [1], selected: true });
    state = await runAndWait(m, state, { type: 'rewrite', number: 1, instruction: 'Shorter' });
    expect(recorded.map(r => r.modelId)).toEqual([MODEL.id, MODEL.id]);
    expect(recorded.every(r => r.figures.input > 0 && r.figures.output > 0)).toBe(true);
    expect(resultsOf(state).tokens.find(t => t.pass === 'Explain and Rewrite')?.text).toMatch(/in 2 call\(s\)/);

    const plan = await m.preview(REVIEW_KIND, state.id, state.revision, { type: 'post' });
    await m.apply(REVIEW_KIND, state.id, plan.planId);
    expect(recorded).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe('Copy through the tab', () => {
  let copied: string[];
  let clipboardFails: boolean;
  const host: BoardHost = {
    openStored: async () => ({ ok: true }),
    copyText: async text => {
      if (clipboardFails) throw new Error('clipboard unavailable');
      copied.push(text);
    },
  };
  let nextId = 1;
  async function ask(id: string, op: string, body: Record<string, unknown>) {
    const request = asBoardRequest({ id: nextId++, op, body })!;
    return answerBoardRequest(shared, { kind: REVIEW_KIND, id }, request, host, () => undefined);
  }
  /** One manager for the whole scenario, shared with `ask`. */
  let shared: SessionManager;

  beforeEach(() => {
    copied = [];
    clipboardFails = false;
    shared = manager();
  });

  it('Copy for Teams of #3 gives plain text with its explanation and no Markdown characters', async () => {
    respond = call => (call.kind === 'explain' ? '**Why:** the value from `f3` is never checked.\n\n- Check it before use.' : defaultRespond(call));
    let state = await reviewed(shared, 3);
    state = await runAndWait(shared, state, { type: 'explain', number: 3 });
    const reply = await ask(state.id, 'copy', { format: 'teams', numbers: [3] });
    expect(reply).toMatchObject({ ok: true, data: { outcome: 'copied', count: 1 } });
    const text = copied[0];
    expect(text).toContain('PR #482 — Add export');
    expect(text).toContain('Unchecked input in f3');
    expect(text).toContain('Why: the value from f3 is never checked.');
    expect(text).toContain('- Check it before use.');
    expect(text).not.toContain('Unchecked input in f1');
    expect(text).not.toMatch(/\*\*|`|\[|\]\(/);
  });

  it('Copy as Markdown escapes a finding title that contains * and [', async () => {
    const state = await reviewed(shared, 4);
    const reply = await ask(state.id, 'copy', { format: 'markdown', numbers: [4] });
    expect(reply).toMatchObject({ ok: true, data: { outcome: 'copied', count: 1 } });
    expect(copied[0]).toContain('Use \\*any\\* \\[type\\] here');
    expect(copied[0]).not.toContain('Use *any* [type]');
  });

  it('ignores text the page sends along: the copied text comes from the session', async () => {
    const state = await reviewed(shared, 2);
    const reply = await ask(state.id, 'copy', { format: 'teams', numbers: [1], text: 'Injected text [click](https://evil.example)' });
    expect(reply.ok).toBe(true);
    expect(copied[0]).not.toContain('Injected');
    expect(copied[0]).toContain('Unchecked input in f1');
  });

  it('with nothing selected, copies every finding', async () => {
    const state = await reviewed(shared, 3);
    const reply = await ask(state.id, 'copy', { format: 'markdown', numbers: [] });
    expect(reply).toMatchObject({ ok: true, data: { outcome: 'copied', count: 3 } });
    for (const n of [1, 2, 3]) expect(copied[0]).toContain(`Unchecked input in f${n}`);
  });

  it('Copy for Teams and as Markdown carry no requirements coverage, even when the stored review holds one', async () => {
    const state = await reviewed(shared, 2);
    const stored = await storedSession(state.id);
    const coverage = {
      ticketKey: 'PROJ-12', reading: 'Exports the report.', requirements: [{ text: 'Export as CSV', source: 'description', status: 'met', evidence: 'csv.ts' }],
      outOfScope: [], noClearRequirements: false, unseenFileCount: 0,
    };
    await new SessionStore(dir).save({ ...stored, working: { ...stored.working, review: { ...stored.working.review!, coverage } as never } });
    shared = manager();

    for (const format of ['teams', 'markdown']) {
      const reply = await ask(state.id, 'copy', { format, numbers: [] });
      expect(reply).toMatchObject({ ok: true, data: { outcome: 'copied', count: 2 } });
    }
    expect(copied).toHaveLength(2);
    for (const text of copied) {
      expect(text).toContain('Unchecked input in f1');
      expect(text).not.toMatch(/Requirements coverage|PROJ-12|Export as CSV/);
    }
  });

  it('says when the clipboard could not be written, and refuses an unknown format', async () => {
    const state = await reviewed(shared, 1);
    clipboardFails = true;
    expect(await ask(state.id, 'copy', { format: 'teams', numbers: [] })).toMatchObject({ ok: true, data: { outcome: 'failed', reason: 'clipboard unavailable' } });
    expect(await ask(state.id, 'copy', { format: 'html', numbers: [] })).toMatchObject({ ok: false, status: 400 });
  });
});
