import { aggregateRecommendedPersonas, buildAdaptiveChunks } from '../reviewSessionState';
import type { RequirementsCoverage } from '../requirementsCoverage';
import { reviewBatch } from './batchReview';
import { addFindings, emptyStore, markStepRun, type NewFinding } from './findingStore';
import { emptyOutcome, extraInstructionsOf, isStop, passContext, serviceFor, throwIfStopped, tokenBudgetOf } from './plumbing';
import { checkRequirements } from './requirementsCheck';
import { readReviewDiff, snapshotFiles } from './snapshot';
import type {
  EngineDeps,
  EngineSettings,
  PassOutcome,
  PassSuggestion,
  RequirementsChoice,
  RequirementsOutcome,
  ReviewBatch,
  ReviewTarget,
  StagedReview,
} from './types';

// The regular pass every review starts with: pass 1 on every batch (asking which persona passes are
// worth running), the call with the whole files a batch asked for, then the requirements check when
// a source is chosen. It builds the snapshot later passes work on. vscode-free.

export interface RegularPassResult {
  /** Undefined when nothing could be reviewed: no file to review, or no batch got a readable reply. */
  review?: StagedReview;
  outcome: PassOutcome;
  requirements: RequirementsOutcome;
}

/** The suggestion from the finished batches' recommendations: undefined for a batch with no readable one. */
export function suggestionOf(perBatch: Array<string[] | undefined>): PassSuggestion {
  const { selected, hasUsableSignal } = aggregateRecommendedPersonas(perBatch);
  if (!hasUsableSignal) return { kind: 'no-usable-recommendation' };
  return selected.length > 0 ? { kind: 'suggested', personas: selected } : { kind: 'none-suggested' };
}

export async function runRegularPass(
  input: { target: ReviewTarget; requirements: RequirementsChoice; settings: EngineSettings },
  deps: EngineDeps,
): Promise<RegularPassResult> {
  const { target, settings } = input;
  const ctx = passContext(deps);
  const service = serviceFor(deps);
  const tokenBudget = tokenBudgetOf(settings, deps.model);
  const extra = extraInstructionsOf(settings);
  const notRun: RequirementsOutcome = { status: 'not-run' };

  let diff;
  try {
    diff = await readReviewDiff({
      client: deps.client, target, contextLines: settings.contextLines, excludePatterns: settings.excludePatterns, signal: deps.signal, log: ctx.log,
    });
  } catch (err) {
    return { outcome: { ...emptyOutcome('regular', 0), status: 'failed', error: err instanceof Error ? err.message : String(err) }, requirements: notRun };
  }
  const { pr, files } = diff;
  if (files.length === 0) {
    return { outcome: { ...emptyOutcome('regular', 0), status: 'nothing-to-review', notes: diff.notes }, requirements: notRun };
  }

  const chunks = buildAdaptiveChunks(files, tokenBudget);
  const outcome = { ...emptyOutcome('regular', chunks.length), notes: [...diff.notes] };
  const batches: ReviewBatch[] = chunks.map((chunk) => ({ files: chunk, contextPaths: [] }));
  const cache = new Map<string, string>();
  const findings: NewFinding[] = [];
  const recommendations: Array<string[] | undefined> = [];
  /** The review a stop now would hand over: the finished batches' findings, the step not marked as run. */
  const partial = (): StagedReview => ({
    snapshot: { target, pr, reviewedCommit: pr.fromCommitHash, batches: batches.map((b) => ({ ...b })) },
    store: addFindings(emptyStore(), findings).store,
    suggestion: suggestionOf(recommendations),
    requirements: input.requirements,
  });
  let reviewedFiles = 0;
  let firstFailure: string | undefined;
  let stopped = false;

  ctx.log('info', `Review started — pr=${target.project}/${target.repo}#${target.prId}`, {
    batches: chunks.length, files: files.length, budgetTokens: tokenBudget, modelId: deps.model.id,
  });
  deps.onProgress?.({ step: 'regular', batchesDone: 0, batchesTotal: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    try {
      throwIfStopped(deps.signal);
      const result = await reviewBatch({
        ctx, service, pr, target, commit: pr.fromCommitHash, files: chunks[i], label: `regular batch ${i + 1}/${chunks.length}`,
        source: 'general', cache, tokenBudget,
        buildPrompt: (items, contents, options) => service.buildPrompt(pr, items, contents, extra, !options?.priorFindings, options),
      });
      batches[i].contextPaths = result.contextPaths;
      findings.push(...result.findings.map((f) => ({ ...f, batch: i })));
      recommendations.push(result.recommendedPersonas);
      reviewedFiles += result.reviewedFiles;
      if (result.failures.length > 0) {
        outcome.failedBatches++;
        outcome.notes.push(...result.failures);
        firstFailure ??= result.failures[0];
      }
    } catch (err) {
      if (!isStop(err, deps.signal)) throw err;
      stopped = true;
      break;
    }
    outcome.batchesDone = i + 1;
    if (deps.onProgress) {
      deps.onProgress({ step: 'regular', batchesDone: i + 1, batchesTotal: chunks.length, ...(reviewedFiles > 0 ? { review: partial() } : {}) });
    }
  }

  if (reviewedFiles === 0) {
    return {
      outcome: { ...outcome, status: stopped ? 'stopped' : 'failed', tokens: ctx.meter.totals(), ...(firstFailure ? { error: firstFailure } : {}) },
      requirements: notRun,
    };
  }

  const added = addFindings(emptyStore(), findings);
  const snapshot = { target, pr, reviewedCommit: pr.fromCommitHash, batches };
  let requirements: RequirementsOutcome = notRun;
  let coverage: RequirementsCoverage | undefined;
  if (!stopped) {
    const checked = await checkRequirements({
      ctx, deps, service, pr, target, files: snapshotFiles(snapshot), choice: input.requirements, tokenBudget, cache,
    });
    requirements = checked.outcome;
    coverage = checked.coverage;
  }
  const review: StagedReview = {
    snapshot,
    store: stopped ? added.store : markStepRun(added.store, 'regular'),
    suggestion: suggestionOf(recommendations),
    requirements: input.requirements,
    ...(coverage ? { coverage } : {}),
  };
  ctx.log('info', `Regular pass ${stopped ? 'stopped' : 'finished'} — ${review.store.findings.length} finding(s)`, {
    batchesDone: outcome.batchesDone, batchesTotal: chunks.length, failedBatches: outcome.failedBatches,
  });
  return {
    review,
    outcome: { ...outcome, status: stopped ? 'stopped' : 'finished', added: added.added, tokens: ctx.meter.totals() },
    requirements,
  };
}
