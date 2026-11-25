import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import type { ReviewBackground } from '../services/PrReviewService';
import { settleOneCall, type CallFailure } from './engine/plumbing';
import type { EngineDeps, TokenTotals } from './engine/types';
import {
  EXPLAIN_QUESTION, buildFindingThreadPrompt, buildThreadCommentPrompt, pickThreadTurns, type ReviewFinding, type ThreadTurn,
} from './reviewSessionState';

// The single model calls the review board makes for one finding: a question in its discussion
// (Explain's first question or a follow-up), with the finding, its code, the pull request's title
// and description, the background and the discussion so far; Regenerate, which writes the draft
// comment again from the finding and its discussion; and Rewrite, which revises a draft comment
// with the developer's instruction. Each is one metered call on the review model, so it counts
// toward the monthly token counters. vscode-free.

export { EXPLAIN_QUESTION };

export type CallDeps = Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag'>;

export type CallResult =
  | { ok: true; text: string; tokens: TokenTotals }
  | CallFailure;

/** What a call about a finding's discussion is given. */
export interface ThreadCallInput {
  pr: Pick<BitbucketPR, 'title' | 'description'>;
  finding: ReviewFinding;
  background?: ReviewBackground;
  /** The discussion so far, oldest first. */
  turns: ThreadTurn[];
  /** The characters of earlier questions and answers the call may carry. */
  maxThreadChars: number;
}

function contextOf(input: ThreadCallInput) {
  return {
    prTitle: input.pr.title,
    ...(input.pr.description ? { prDescription: input.pr.description } : {}),
    ...(input.background ? { background: input.background } : {}),
    finding: input.finding,
    turns: input.turns,
    maxThreadChars: input.maxThreadChars,
  };
}

/** Logs the turns a call leaves out to fit its length limit. */
function logLeftOut(input: ThreadCallInput, label: string, deps: CallDeps): void {
  const { left } = pickThreadTurns(input.turns, input.maxThreadChars);
  if (left > 0) deps.onDiag?.('info', `${label}: earlier turns left out to fit the length limit`, { turns: input.turns.length, left, maxChars: input.maxThreadChars });
}

/** The comment-refinement wording of the chat review's comment preview, for one draft. */
export function buildCommentRewritePrompt(comment: string, instruction: string): string {
  const task = `Revise the following Bitbucket PR comment based on this instruction: "${instruction}"\n\nOriginal comment:\n${comment}`;
  return (
    'You are a code review assistant. Your task is to write Bitbucket pull request comment text. Content may include prose, code snippets or patches.\n\n' +
    `Write the following:\n${task}\n\nProduce only the final text. No preamble, no explanation.`
  );
}

function oneCall(prompt: string, label: string, deps: CallDeps): Promise<CallResult> {
  return settleOneCall<{ text: string }>(deps, prompt, `${label} failed`, (text, log) => {
    if (!text) {
      log('warn', `${label} gave an empty reply`);
      return { unusable: 'The model gave an empty reply.' };
    }
    return { text };
  });
}

/** A question in the finding's discussion; without one, Explain's first question. */
export function askAboutFinding(input: ThreadCallInput & { question?: string }, deps: CallDeps): Promise<CallResult> {
  const label = `${input.question ? 'Follow-up on' : 'Explain'} #${input.finding.id}`;
  logLeftOut(input, label, deps);
  return oneCall(buildFindingThreadPrompt(contextOf(input), input.question ?? EXPLAIN_QUESTION), label, deps);
}

/** The draft comment written again from the finding and its discussion. */
export function regenerateComment(input: ThreadCallInput, deps: CallDeps): Promise<CallResult> {
  const label = `Regenerate of the comment of #${input.finding.id}`;
  logLeftOut(input, label, deps);
  return oneCall(buildThreadCommentPrompt(contextOf(input)), label, deps);
}

export function rewriteComment(comment: string, instruction: string, deps: CallDeps): Promise<CallResult> {
  return oneCall(buildCommentRewritePrompt(comment, instruction), 'Comment rewrite', deps);
}
