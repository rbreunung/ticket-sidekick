import type { BitbucketPR } from '../../bitbucket/IBitbucketClient';
import type { PrReviewService } from '../../services/PrReviewService';
import type { RequirementsSource, RequirementsTicket } from '../../utils/requirementsSource';
import type { RequirementsCoverage } from '../requirementsCoverage';
import { runRequirementsPass } from '../requirementsPass';
import { readTicketGuarded } from '../ticketRead';
import { buildRunTag, type FileDiff } from '../reviewSessionState';
import { logAborted, logPassOpening, writeRunRecord } from './diagnostics';
import { callWithRetry, fetchAndBudgetContextFiles, isStop, passContext, serviceFor, tokenBudgetOf, type PassContext } from './plumbing';
import { snapshotFiles } from './snapshot';
import type { EngineDeps, EngineSettings, RequirementsChoice, RequirementsOutcome, StagedReview, TokenTotals } from './types';

// The requirements check: the diff compared with a Jira ticket or the developer's goal, through the
// existing requirements pass. The regular pass runs it at its end; a re-check runs it alone on the
// stored diff and replaces only the coverage. vscode-free.

/** The label a goal-only check carries where a ticket key would stand. */
export const GOAL_LABEL = 'Stated goal';

/** A goal with no ticket: the ticket part of the prompt says there is none, the goal is the requirement. */
function goalOnlySource(): RequirementsSource {
  return {
    key: GOAL_LABEL,
    summary: 'No ticket. Check the diff against the stated goal only.',
    descriptionText: '',
    truncatedDescription: false,
    comments: [],
    omittedComments: 0,
    commentsUnavailable: false,
  };
}

export interface RequirementsCheckParams {
  ctx: PassContext;
  deps: EngineDeps;
  service: PrReviewService;
  pr: BitbucketPR;
  target: { project: string; repo: string };
  files: FileDiff[];
  choice: RequirementsChoice;
  tokenBudget: number;
  /** Files read earlier in this run, so none is read twice. */
  cache: Map<string, string>;
}

/** Runs the check; a stop ends it as stopped, any other failure as a failed check. */
export async function checkRequirements(p: RequirementsCheckParams): Promise<{ outcome: RequirementsOutcome; coverage?: RequirementsCoverage }> {
  const { ctx, deps, choice } = p;
  if (choice.kind === 'none') return { outcome: { status: 'not-run' } };
  deps.onProgress?.({ step: 'requirements', batchesDone: 0, batchesTotal: 1 });

  let ticket: RequirementsTicket;
  let userGoal: string | undefined;
  if (choice.kind === 'ticket') {
    if (!deps.readTicket) return { outcome: { status: 'ticket-unreadable', key: choice.key, reason: 'error', message: 'Jira is not available' } };
    const read = await readTicketGuarded(() => deps.readTicket!(choice.key));
    if (!read.ok) {
      ctx.log('warn', 'Ticket read failed — no requirements check', { key: choice.key, reason: read.reason });
      return { outcome: { status: 'ticket-unreadable', key: choice.key, reason: read.reason, message: read.message } };
    }
    ticket = { ticketKey: choice.key, source: read.source };
  } else {
    ticket = { ticketKey: GOAL_LABEL, source: goalOnlySource() };
    userGoal = choice.text;
  }

  const notes: string[] = [];
  try {
    const coverage = await runRequirementsPass({
      pr: p.pr, ticket, fileDiffs: p.files, service: p.service,
      runTag: ctx.runTag, tokenBudget: p.tokenBudget, ...(userGoal ? { userGoal } : {}),
      logReview: (level, message, details) => ctx.log(level, message, details),
      stream: { markdown: (text) => { notes.push(text); } },
    }, {
      callModel: (prompt, round, hooks, validate) => callWithRetry(ctx, prompt, `requirements round ${round}`, validate, { hooks }),
      fetchContextFiles: (requested, shown) => fetchAndBudgetContextFiles({
        requested, cache: p.cache, service: p.service, project: p.target.project, repo: p.target.repo,
        commit: p.pr.fromCommitHash, tokenBudget: p.tokenBudget, budgetAgainst: shown,
      }),
      isCancelled: () => ctx.signal.aborted,
    });
    deps.onProgress?.({ step: 'requirements', batchesDone: 1, batchesTotal: 1 });
    return coverage ? { outcome: { status: 'checked' }, coverage } : { outcome: { status: 'failed' } };
  } catch (err) {
    if (isStop(err, ctx.signal)) return { outcome: { status: 'stopped' } };
    throw err;
  }
}

/**
 * Runs the requirements check again on the stored diff, for a new choice or an edited goal. Only the
 * coverage changes; the findings are untouched. A failed or stopped check keeps the old coverage; the
 * choice "none" removes it without a call.
 */
export async function recheckRequirements(
  review: StagedReview, choice: RequirementsChoice, settings: EngineSettings, deps: EngineDeps,
): Promise<{ review: StagedReview; outcome: RequirementsOutcome; tokens: TokenTotals }> {
  const { snapshot } = review;
  const { target } = snapshot;
  const ctx = passContext(deps, { runTag: buildRunTag(target.project, target.repo, target.prId), detailedDiagnostics: settings.detailedDiagnostics });
  if (choice.kind === 'none') {
    const { coverage: _dropped, ...rest } = review;
    return { review: { ...rest, requirements: choice }, outcome: { status: 'not-run' }, tokens: ctx.meter.totals() };
  }
  const tokenBudget = tokenBudgetOf(settings, deps.model);
  logPassOpening(ctx, { step: 'requirements', model: deps.model, meter: ctx.meter, settings, tokenBudget });
  ctx.stage = 'requirements check';
  let result: Awaited<ReturnType<typeof checkRequirements>>;
  try {
    result = await checkRequirements({
      ctx, deps, service: serviceFor(deps), pr: { ...snapshot.pr, fromCommitHash: snapshot.reviewedCommit },
      target, files: snapshotFiles(snapshot), choice, tokenBudget, cache: new Map(),
    });
  } catch (err) {
    if (!isStop(err, deps.signal)) logAborted(ctx, err);
    throw err;
  }
  writeRunRecord(ctx, `(requirements check only: ${result.outcome.status})`);
  const next: StagedReview = result.coverage ? { ...review, requirements: choice, coverage: result.coverage } : review;
  return { review: next, outcome: result.outcome, tokens: ctx.meter.totals() };
}
