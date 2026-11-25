import type { IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import { addTokenTotals, type StoredFinding, type TokenTotals } from '../../review/engine';
import { tokenBudgetOf } from '../../review/engine/plumbing';
import { askAboutFinding, regenerateComment, rewriteComment, type CallResult, type ThreadCallInput } from '../../review/findingCalls';
import { formatShare, type ShareFormat, type SharedText } from '../../review/shareFormat';
import { PrReviewService } from '../../services/PrReviewService';
import type { Applied, ApplyProgress, Planned, Reduced, RunBegun, RunFinished } from '../../sessions/boardKind';
import type { ApplyLineResult, WritePlan } from '../../sessions/sessionTypes';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewBoardDeps } from './deps';
import type { Draft, ReviewDerived, ReviewSession, ReviewWorking, ThreadTurn } from './kind';
import { modelFor } from './runs';

// What the developer does with the findings of a review: discuss one in a thread under it (Explain
// asks the first question, each follow-up adds a question and its answer below; one model call
// each), select findings, which drafts one comment per finding once, edit a draft by hand, Rewrite
// it with an instruction or Regenerate it from the finding and its discussion (one model call each,
// with Undo), Post the selected drafts after a preview and the native confirmation, and Copy the
// selection, or every finding, as plain text or Markdown. The copied text is built here from the
// session, never taken from the page. vscode-free.

export type FindingAction =
  | { type: 'select'; numbers: number[]; selected: boolean }
  | { type: 'draft'; number: number; text: string }
  | { type: 'undo-rewrite'; number: number };

export const FINDING_ACTIONS: ReadonlySet<string> = new Set(['select', 'draft', 'undo-rewrite']);

export type FindingRunRequest =
  | { type: 'explain'; number: number }
  | { type: 'follow-up'; number: number; question: string }
  | { type: 'rewrite'; number: number; instruction: string }
  | { type: 'regenerate'; number: number };

export const FINDING_RUNS: ReadonlySet<string> = new Set(['explain', 'follow-up', 'rewrite', 'regenerate']);

/** The one writing action: post the selected drafts. */
export type PostAction = { type: 'post' };

interface PostPayload {
  items: Array<{ number: number; text: string }>;
}

const MAX_INSTRUCTION_CHARS = 2000;

/**
 * The share of the batch token budget a discussion call gives to the earlier questions and answers,
 * counted at four characters a token: a quarter of the budget, so the finding and its code still fit.
 */
export function threadCharBudget(batchTokens: number): number {
  const charsPerToken = 4;
  return Math.floor(batchTokens / 4) * charsPerToken;
}

/** `formatPrComment` reads nothing from Bitbucket, so the service is built without a client for it. */
const commentFormatter = new PrReviewService(undefined as unknown as IBitbucketClient);

function findingOf(working: ReviewWorking, number: unknown): StoredFinding | undefined {
  return typeof number === 'number' ? working.review?.store.findings.find(f => f.id === number) : undefined;
}

/** The selected findings that are still in the review: a finding the critic removed drops out. */
export function selectedNumbers(working: ReviewWorking): number[] {
  const present = new Set((working.review?.store.findings ?? []).map(f => f.id));
  return (working.selected ?? []).filter(n => present.has(n));
}

/** A draft comment from the finding and the first answer of its discussion, as it would be posted. */
export function draftText(finding: StoredFinding, explanation?: string): string {
  const comment = commentFormatter.formatPrComment(finding);
  return explanation?.trim() ? `${comment}\n\n${explanation.trim()}` : comment;
}

function threadOf(working: ReviewWorking, number: number): ThreadTurn[] {
  return working.threads[String(number)] ?? [];
}

/** The discussion grew since the draft was made from it. */
export function draftOutdated(working: ReviewWorking, number: number): boolean {
  const draft = working.drafts[String(number)];
  return Boolean(draft) && threadOf(working, number).length > (draft.threadTurns ?? 0);
}

/** A discussion as one text: the first answer, then each follow-up question and its answer. */
export function discussionText(turns: ThreadTurn[]): string {
  return turns.map((t, i) => (i === 0 ? t.answer.trim() : `Question: ${(t.question ?? '').trim()}\n\n${t.answer.trim()}`)).join('\n\n');
}

/** The draft made without a model call: the finding and the first answer of its discussion. */
function newDraft(working: ReviewWorking, finding: StoredFinding): Draft {
  const first = threadOf(working, finding.id)[0];
  return { text: draftText(finding, first?.answer), threadTurns: first ? 1 : 0 };
}

function withFailure(working: ReviewWorking, number: number, what: 'thread' | 'rewrite', error: string | undefined): ReviewWorking {
  const failures = { ...working.failures };
  const entry = { ...failures[String(number)] };
  if (error) entry[what] = error;
  else delete entry[what];
  if (Object.keys(entry).length > 0) failures[String(number)] = entry;
  else delete failures[String(number)];
  const next: ReviewWorking = { ...working, failures };
  if (Object.keys(failures).length === 0) delete next.failures;
  return next;
}

function withDraft(working: ReviewWorking, number: number, draft: Draft): ReviewWorking {
  return { ...working, drafts: { ...working.drafts, [String(number)]: draft } };
}

export function reduceFindings(working: ReviewWorking, action: FindingAction): Reduced<ReviewWorking> {
  if (working.stage !== 'review' || !working.review) return { ok: false, reason: 'There is no review.' };
  if (action.type === 'select') {
    const { numbers, selected } = action as { numbers?: unknown; selected?: unknown };
    if (!Array.isArray(numbers) || typeof selected !== 'boolean') return { ok: false, reason: 'Unknown selection.' };
    const findings = numbers.map(n => findingOf(working, n));
    if (findings.some(f => !f)) return { ok: false, reason: 'That finding is no longer in the review.' };
    const picked = (findings as StoredFinding[]).map(f => f.id);
    const current = selectedNumbers(working);
    if (!selected) return { ok: true, working: { ...working, selected: current.filter(n => !picked.includes(n)) } };
    let next: ReviewWorking = { ...working, selected: [...current, ...picked.filter(n => !current.includes(n))] };
    // A draft is made once, the first time its finding is selected for posting.
    for (const f of findings as StoredFinding[]) if (!next.drafts[String(f.id)]) next = withDraft(next, f.id, newDraft(next, f));
    return { ok: true, working: next };
  }
  const finding = findingOf(working, (action as { number?: unknown }).number);
  if (!finding) return { ok: false, reason: 'That finding is no longer in the review.' };
  const draft = working.drafts[String(finding.id)];
  if (!draft) return { ok: false, reason: `#${finding.id} has no draft comment. Select it for posting first.` };
  if (draft.posted) return { ok: false, reason: `The comment of #${finding.id} is posted already.` };
  switch (action.type) {
    case 'draft': {
      const { text } = action as { text?: unknown };
      if (typeof text !== 'string') return { ok: false, reason: 'Invalid draft.' };
      if (text === draft.text) return { ok: true, working };
      // A hand edit ends Undo of the last Rewrite or Regenerate.
      const { previous: _previous, previousThreadTurns: _turns, ...rest } = draft;
      return { ok: true, working: withDraft(working, finding.id, { ...rest, text }) };
    }
    case 'undo-rewrite': {
      if (draft.previous === undefined) return { ok: false, reason: 'There is no rewrite to undo.' };
      const { previous, previousThreadTurns, ...rest } = draft;
      const restored: Draft = { ...rest, text: previous };
      if (previousThreadTurns !== undefined) restored.threadTurns = previousThreadTurns;
      return { ok: true, working: withDraft(working, finding.id, restored) };
    }
    default:
      return { ok: false, reason: 'Unknown action.' };
  }
}

export function isFindingRun(request: unknown): request is FindingRunRequest {
  const type = (request as { type?: unknown } | null)?.type;
  return typeof type === 'string' && FINDING_RUNS.has(type);
}

export function beginFindingRun(session: ReviewSession, request: FindingRunRequest): RunBegun<ReviewWorking> {
  const { working } = session;
  if (working.stage !== 'review' || !working.review) return { ok: false, reason: 'There is no review.' };
  const finding = findingOf(working, request.number);
  if (!finding) return { ok: false, reason: 'That finding is no longer in the review.' };
  const n = finding.id;
  if (request.type === 'explain') {
    if (threadOf(working, n).length > 0) return { ok: false, reason: `#${n} is explained already. Ask a follow-up below the answer.` };
    return { ok: true, size: 'call', what: `explain:${n}`, label: `the explanation of #${n}`, total: 1 };
  }
  if (request.type === 'follow-up') {
    if (threadOf(working, n).length === 0) return { ok: false, reason: `Explain #${n} first; a follow-up is asked below the answer.` };
    const question = typeof request.question === 'string' ? request.question.trim() : '';
    if (!question) return { ok: false, reason: 'Type the follow-up question first.' };
    if (question.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: `The question is longer than ${MAX_INSTRUCTION_CHARS} characters.` };
    return { ok: true, size: 'call', what: `follow-up:${n}`, label: `the follow-up on #${n}`, total: 1 };
  }
  const draft = working.drafts[String(finding.id)];
  if (!draft) return { ok: false, reason: `#${finding.id} has no draft comment. Select it for posting first.` };
  if (draft.posted) return { ok: false, reason: `The comment of #${finding.id} is posted already.` };
  if (request.type === 'regenerate') return { ok: true, size: 'call', what: `regenerate:${n}`, label: `the regenerated comment of #${n}`, total: 1 };
  const instruction = typeof request.instruction === 'string' ? request.instruction.trim() : '';
  if (!instruction) return { ok: false, reason: 'Type how the comment should change first.' };
  if (instruction.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: `The instruction is longer than ${MAX_INSTRUCTION_CHARS} characters.` };
  return { ok: true, size: 'call', what: `rewrite:${finding.id}`, label: `the rewrite of the comment of #${finding.id}`, total: 1 };
}

/** A call that made no model call leaves the token count as it was. */
function withTokens(working: ReviewWorking, tokens: TokenTotals): ReviewWorking {
  const callTokens = tokens.calls === 0 ? working.callTokens : addTokenTotals(working.callTokens, tokens);
  return callTokens ? { ...working, callTokens } : working;
}

/** The same review as the one a run started on: a review replaced meanwhile is not changed. */
export function sameReview(a: ReviewWorking, b: ReviewWorking): boolean {
  return Boolean(a.review && b.review) && a.review!.snapshot.reviewedCommit === b.review!.snapshot.reviewedCommit
    && a.review!.snapshot.pr.id === b.review!.snapshot.pr.id;
}

/** The pure rebuild of a draft from the finding, for a finding with no discussion: no model call; Undo and the last error go. */
function rebuiltDraft(started: ReviewWorking, number: number): RunFinished<ReviewWorking> {
  return {
    update: w => {
      const finding = findingOf(w, number);
      const draft = w.drafts[String(number)];
      if (!sameReview(w, started) || !finding || !draft || draft.posted) return w;
      const { previous: _previous, previousThreadTurns: _turns, ...rest } = draft;
      return withFailure(withDraft(w, number, { ...rest, ...newDraft(w, finding) }), number, 'rewrite', undefined);
    },
  };
}

const FAILED_LINE: Record<FindingRunRequest['type'], string> = {
  explain: 'Explain failed', 'follow-up': 'Follow-up failed', rewrite: 'Rewrite failed', regenerate: 'Regenerate failed',
};

export async function findingRun(
  session: ReviewSession, request: FindingRunRequest, deps: ReviewBoardDeps, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const started = session.working;
  const finding = findingOf(started, request.number)!;
  const number = finding.id;
  const what = request.type;
  const thread = threadOf(started, number);
  if (what === 'regenerate' && thread.length === 0) return rebuiltDraft(started, number);
  const slot = what === 'explain' || what === 'follow-up' ? 'thread' : 'rewrite';
  const failed = (error: string): RunFinished<ReviewWorking> => ({ update: w => withFailure(w, number, slot, error) });
  const model = await modelFor(session, deps);
  if (!('handle' in model)) return failed(model.problem);
  const callDeps = { model: model.handle, recordTokens: deps.recordTokens, signal, ...(deps.onDiag ? { onDiag: deps.onDiag } : {}) };
  const background = started.startedWith?.background;
  const threadInput = async (): Promise<ThreadCallInput> => ({
    pr: started.review!.snapshot.pr,
    finding,
    ...(background?.text.trim() ? { background } : {}),
    turns: thread,
    maxThreadChars: threadCharBudget(tokenBudgetOf(await deps.settings(), model.handle).tokens),
  });
  let result: CallResult;
  const question = what === 'follow-up' ? (request as { question: string }).question.trim() : undefined;
  if (what === 'explain' || what === 'follow-up') result = await askAboutFinding({ ...(await threadInput()), ...(question ? { question } : {}) }, callDeps);
  else if (what === 'regenerate') result = await regenerateComment(await threadInput(), callDeps);
  else result = await rewriteComment(started.drafts[String(number)].text, (request as { instruction: string }).instruction.trim(), callDeps);
  return {
    update: w => {
      const counted = withTokens(w, result.tokens);
      if (!sameReview(w, started) || !findingOf(w, number)) return counted;
      if (!result.ok) return result.stopped ? counted : withFailure(counted, number, slot, `${FAILED_LINE[what]}: ${result.error}`);
      const cleared = withFailure(counted, number, slot, undefined);
      if (slot === 'thread') {
        const turn: ThreadTurn = { ...(question ? { question } : {}), answer: result.text };
        return { ...cleared, threads: { ...cleared.threads, [String(number)]: [...threadOf(cleared, number), turn] } };
      }
      const draft = cleared.drafts[String(number)];
      if (!draft || draft.posted) return cleared;
      if (what === 'regenerate') {
        return withDraft(cleared, number, { ...draft, text: result.text, previous: draft.text, previousThreadTurns: draft.threadTurns ?? 0, threadTurns: thread.length });
      }
      const { previousThreadTurns: _turns, ...rest } = draft;
      return withDraft(cleared, number, { ...rest, text: result.text, previous: draft.text });
    },
  };
}

function inlineAnchor(finding: StoredFinding): boolean {
  return finding.line !== undefined && finding.lineType !== undefined;
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function where(finding: StoredFinding): string {
  return inlineAnchor(finding) ? `inline at ${finding.file}:${finding.line}` : `to the pull request's activity (${finding.file}, no verified line)`;
}

/** The selected drafts not posted yet: what Post posts. */
export function postableNumbers(working: ReviewWorking): number[] {
  return selectedNumbers(working).filter(n => working.drafts[String(n)] && !working.drafts[String(n)].posted);
}

/** A commit as the board shows it. */
export function shortCommit(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Said first in the Post plan, and so in the native confirmation, when the pull request moved on
 * since the review: each inline comment carries only its file and line, which Bitbucket places on
 * the current diff.
 */
function outOfDateLine(session: ReviewSession): { target: string; change: string } | undefined {
  const reviewed = session.working.review!.snapshot.reviewedCommit;
  const head = session.derived.data.pr.headCommit;
  if (reviewed === head) return undefined;
  return {
    target: 'Out of date',
    change: `This review read commit ${shortCommit(reviewed)}; the pull request is now at ${shortCommit(head)}. Inline comments are anchored to the lines that were reviewed, which may have moved since.`,
  };
}

/** Post previews the drafts as they are and never rebuilds them. */
export function planPost(session: ReviewSession): Planned {
  const { working, recipe } = session;
  if (working.stage !== 'review' || !working.review) return { ok: false, reason: 'There is no review.' };
  if (selectedNumbers(working).length === 0) return { ok: false, reason: 'Select the findings to post first.' };
  const numbers = postableNumbers(working);
  if (numbers.length === 0) return { ok: false, reason: 'The selected comments are posted already.' };
  const items = numbers.map(n => ({ number: n, text: working.drafts[String(n)].text }));
  const plan: WritePlan<PostPayload> = {
    title: `Post ${items.length} comment(s) on ${recipe.project}/${recipe.repo}#${recipe.prId}`,
    lines: [
      ...[outOfDateLine(session)].filter(line => line !== undefined),
      ...items.map(({ number, text }) => ({ target: `#${number}`, change: `Post ${where(findingOf(working, number)!)}: "${oneLine(text)}"` })),
    ],
    risky: true,
    payload: { items },
  };
  return { ok: true, plan };
}

/** Posts each previewed draft and saves its result before the next, so only the failed ones are offered again. */
export async function applyPost(
  session: ReviewSession, plan: WritePlan, deps: ReviewBoardDeps, progress?: ApplyProgress<ReviewWorking>,
): Promise<Applied<ReviewDerived, ReviewWorking>> {
  const { items } = plan.payload as PostPayload;
  const { recipe } = session;
  let working = session.working;
  const results: ApplyLineResult[] = [];
  const bitbucket = await deps.bitbucket();
  const service = bitbucket.configured ? new PrReviewService(bitbucket.client, deps.onDiag) : undefined;
  for (const [i, { number, text }] of items.entries()) {
    const target = `#${number}`;
    const finding = findingOf(working, number);
    const draft = working.drafts[String(number)];
    if (!finding || !draft) {
      results.push({ target, outcome: 'refused', reason: 'no longer in the review' });
      continue;
    }
    let error: string | undefined;
    if (!service) error = (bitbucket as { hint: string }).hint;
    else {
      const [posted] = await service.postCommentItems(recipe.project, recipe.repo, recipe.prId, [{ finding, text }]);
      error = posted.result ? undefined : posted.error ?? 'The comment was not posted.';
      if (posted.result) {
        const { previous: _previous, postError: _postError, ...rest } = draft;
        working = withDraft(working, number, { ...rest, posted: { commentId: posted.result.commentId } });
      }
    }
    if (error) working = withDraft(working, number, { ...draft, postError: error });
    results.push(error ? { target, outcome: 'failed', reason: error } : { target, outcome: 'done' });
    await progress?.({ working, done: i + 1, total: items.length });
  }
  return { results, derived: session.derived, working };
}

/**
 * The text Copy puts on the clipboard, built from the session: the findings the page names, or
 * every finding when it names none.
 */
export function reviewCopyText(session: ReviewSession, format: ShareFormat, numbers: number[]): SharedText | { ok: false; reason: string } {
  const { working, recipe } = session;
  const review = working.review;
  if (!review) return { ok: false, reason: 'There is no review to copy.' };
  const findings = review.store.findings;
  const targets = numbers.filter(n => findings.some(f => f.id === n));
  if (numbers.length > 0 && targets.length === 0) return { ok: false, reason: 'Those findings are no longer in the review.' };
  const explanations: Record<number, string> = {};
  for (const [key, turns] of Object.entries(working.threads)) if (turns.length > 0) explanations[Number(key)] = discussionText(turns);
  return formatShare(format, {
    pr: review.snapshot.pr,
    url: recipe.url,
    findings,
    ...(targets.length > 0 ? { targets } : {}),
    explanations,
    confidenceThreshold: working.startedWith?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  });
}
