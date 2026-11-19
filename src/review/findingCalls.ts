import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import { callOnce, describeError, isStop, passContext } from './engine/plumbing';
import type { EngineDeps, TokenTotals } from './engine/types';
import { buildFindingFollowUpPrompt, type ReviewFinding } from './reviewSessionState';

// The two single model calls the review board makes for one finding: Explain, which answers with
// the finding, its code, the pull request's title and description and the review's upfront
// question, and Rewrite, which revises a draft comment with the developer's instruction. Each is
// one metered call on the review model, so it counts toward the monthly token counters. vscode-free.

export type CallDeps = Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag'>;

export type CallResult =
  | { ok: true; text: string; tokens: TokenTotals }
  | { ok: false; stopped: boolean; error: string; tokens: TokenTotals };

/** What Explain asks about a finding. */
export const EXPLAIN_QUESTION =
  'Explain this finding: what the problem is, why it matters in this pull request, and how to fix it. Answer in plain text without Markdown.';

export function buildExplainPrompt(pr: Pick<BitbucketPR, 'title' | 'description'>, finding: ReviewFinding, upfrontQuestion: string): string {
  return buildFindingFollowUpPrompt(
    { prTitle: pr.title, prDescription: pr.description, ...(upfrontQuestion.trim() ? { upfrontQuestion } : {}) },
    finding,
    EXPLAIN_QUESTION,
  );
}

/** The comment-refinement wording of the chat review's comment preview, for one draft. */
export function buildCommentRewritePrompt(comment: string, instruction: string): string {
  const task = `Revise the following Bitbucket PR comment based on this instruction: "${instruction}"\n\nOriginal comment:\n${comment}`;
  return (
    'You are a code review assistant. Your task is to write Bitbucket pull request comment text. Content may include prose, code snippets or patches.\n\n' +
    `Write the following:\n${task}\n\nProduce only the final text. No preamble, no explanation.`
  );
}

async function oneCall(prompt: string, label: string, deps: CallDeps): Promise<CallResult> {
  const ctx = passContext(deps);
  try {
    const text = await callOnce(ctx, prompt);
    if (!text) {
      ctx.log('warn', `${label} gave an empty reply`);
      return { ok: false, stopped: false, error: 'The model gave an empty reply.', tokens: ctx.meter.totals() };
    }
    return { ok: true, text, tokens: ctx.meter.totals() };
  } catch (err) {
    const stopped = isStop(err, deps.signal);
    if (!stopped) ctx.log('warn', `${label} failed`, { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, stopped, error: stopped ? 'Stopped.' : describeError(err), tokens: ctx.meter.totals() };
  }
}

export function explainFinding(
  input: { pr: Pick<BitbucketPR, 'title' | 'description'>; finding: ReviewFinding; upfrontQuestion: string },
  deps: CallDeps,
): Promise<CallResult> {
  return oneCall(buildExplainPrompt(input.pr, input.finding, input.upfrontQuestion), `Explain #${input.finding.id}`, deps);
}

export function rewriteComment(comment: string, instruction: string, deps: CallDeps): Promise<CallResult> {
  return oneCall(buildCommentRewritePrompt(comment, instruction), 'Comment rewrite', deps);
}
