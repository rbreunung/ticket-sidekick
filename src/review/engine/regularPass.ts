import { aggregateRecommendedPersonas, buildAdaptiveChunks } from '../reviewSessionState';
import { logAborted, logFindingsFunnel, runPass, writeRunRecord } from './diagnostics';
import { reviewBatch } from './batchReview';
import { addFindings, emptyStore, markStepRun, type NewFinding } from './findingStore';
import { backgroundOf, emptyOutcome, extraInstructionsOf, isStop, serviceFor, throwIfStopped, type PassContext } from './plumbing';
import { readReviewDiff } from './snapshot';
import type {
  EngineDeps,
  EngineSettings,
  PassOutcome,
  PassSuggestion,
  ReviewBatch,
  ReviewTarget,
  StagedReview,
} from './types';

// The regular pass every review starts with: pass 1 on every batch (asking which persona passes are
// worth running) and the call with the whole files a batch asked for. It builds the snapshot later
// passes work on. vscode-free.

export interface RegularPassResult {
  /** Undefined when nothing could be reviewed: no file to review, or no batch got a readable reply. */
  review?: StagedReview;
  outcome: PassOutcome;
}

/** The suggestion from the finished batches' recommendations: undefined for a batch with no readable one. */
export function suggestionOf(perBatch: Array<string[] | undefined>): PassSuggestion {
  const { selected, hasUsableSignal } = aggregateRecommendedPersonas(perBatch);
  if (!hasUsableSignal) return { kind: 'no-usable-recommendation' };
  return selected.length > 0 ? { kind: 'suggested', personas: selected } : { kind: 'none-suggested' };
}

export async function runRegularPass(
  input: { target: ReviewTarget; settings: EngineSettings },
  deps: EngineDeps,
): Promise<RegularPassResult> {
  return runPass(deps, input.settings, input.target, 'regular', (ctx, tokenBudget) => regularPass(input, deps, ctx, tokenBudget));
}

async function regularPass(
  input: { target: ReviewTarget; settings: EngineSettings },
  deps: EngineDeps,
  ctx: PassContext,
  tokenBudget: number,
): Promise<RegularPassResult> {
  const { target, settings } = input;
  const service = serviceFor(deps);
  const extra = extraInstructionsOf(settings);
  const background = backgroundOf(settings);

  let diff;
  ctx.stage = 'fetching PR';
  try {
    diff = await readReviewDiff({
      client: deps.client, target, contextLines: settings.contextLines, excludePatterns: settings.excludePatterns, signal: deps.signal, log: ctx.log,
    });
  } catch (err) {
    logAborted(ctx, err);
    writeRunRecord(ctx, '(no findings: the pull request could not be read)');
    return { outcome: { ...emptyOutcome('regular', 0), status: 'failed', error: err instanceof Error ? err.message : String(err) } };
  }
  const { pr, files } = diff;
  if (files.length === 0) {
    ctx.log('info', `Nothing to review after the filters — ${ctx.runTag}`, { notes: diff.notes });
    writeRunRecord(ctx, '(no findings: nothing to review)');
    return { outcome: { ...emptyOutcome('regular', 0), status: 'nothing-to-review', notes: diff.notes } };
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
  });
  let reviewedFiles = 0;
  let failedFiles = 0;
  let firstFailure: string | undefined;
  let stopped = false;
  const tally = { raw: 0, droppedOutsidePr: 0, retracted: 0 };

  ctx.log('info', `Review started — pr=${target.project}/${target.repo}#${target.prId}`, {
    batches: chunks.length, files: files.length, budgetTokens: tokenBudget, modelId: deps.model.id,
  });
  deps.onProgress?.({ step: 'regular', batchesDone: 0, batchesTotal: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    ctx.stage = `batch ${i + 1}/${chunks.length} pass1`;
    try {
      throwIfStopped(deps.signal);
      const result = await reviewBatch({
        ctx, service, pr, target, commit: pr.fromCommitHash, files: chunks[i], label: `regular batch ${i + 1}/${chunks.length}`,
        pass: 'pass1', batch: i + 1, totalBatches: chunks.length, source: 'general', cache, tokenBudget,
        keepAgainstGoal: background !== undefined,
        buildPrompt: (items, contents, options) => service.buildPrompt(pr, items, contents, extra, !options?.priorFindings, { ...options, ...(background ? { background } : {}) }),
      });
      batches[i].contextPaths = result.contextPaths;
      findings.push(...result.findings.map((f) => ({ ...f, batch: i })));
      recommendations.push(result.recommendedPersonas);
      reviewedFiles += result.reviewedFiles;
      failedFiles += result.failedFiles;
      tally.raw += result.rawCount;
      tally.droppedOutsidePr += result.droppedOutsidePr;
      tally.retracted += result.retracted;
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

  outcome.droppedOutsidePr = tally.droppedOutsidePr;
  if (reviewedFiles === 0) {
    if (!stopped) {
      ctx.log('error', `Review failed — no file could be reviewed — ${ctx.runTag}`, {
        runTag: ctx.runTag, fileCount: files.length, batchCount: chunks.length, reviewedFileCount: reviewedFiles, failedFileCount: failedFiles, firstFailure,
      });
    }
    writeRunRecord(ctx, stopped ? '(no findings: stopped before a batch finished)' : '(no findings: no file could be reviewed)');
    return {
      outcome: { ...outcome, status: stopped ? 'stopped' : 'failed', tokens: ctx.meter.totals(), ...(firstFailure ? { error: firstFailure } : {}) },
    };
  }

  const added = addFindings(emptyStore(), findings);
  const snapshot = { target, pr, reviewedCommit: pr.fromCommitHash, batches };
  const review: StagedReview = {
    snapshot,
    store: stopped ? added.store : markStepRun(added.store, 'regular'),
    suggestion: suggestionOf(recommendations),
  };
  ctx.log('info', `Regular pass ${stopped ? 'stopped' : 'finished'} — ${review.store.findings.length} finding(s)`, {
    batchesDone: outcome.batchesDone, batchesTotal: chunks.length, failedBatches: outcome.failedBatches,
    reviewedFileCount: reviewedFiles, failedFileCount: failedFiles,
  });
  const funnel = logFindingsFunnel(ctx, {
    raw: tally.raw, dedupedCrossBatch: findings.length - added.added.length, droppedOutsidePr: tally.droppedOutsidePr,
    retractedByPass2: tally.retracted, final: review.store.findings.length,
    unverified: review.store.findings.filter((f) => f.locationUnverified).length,
  });
  writeRunRecord(ctx, funnel);
  return {
    review,
    outcome: { ...outcome, status: stopped ? 'stopped' : 'finished', added: added.added, tokens: ctx.meter.totals() },
  };
}
