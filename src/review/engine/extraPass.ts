import { PERSONAS, type Persona, type PersonaId } from '../../services/PrReviewService';
import type { Refusal } from '../../utils/lmRetry';
import { reviewBatch } from './batchReview';
import { logFindingsFunnel, runPass, writeRunRecord } from './diagnostics';
import { addFindings, markStepRun, type NewFinding } from './findingStore';
import {
  budgetStoredContext,
  emptyOutcome,
  backgroundOf,
  extraInstructionsOf,
  isStop,
  keepInRunCache,
  readContextAtCommit,
  serviceFor,
  throwIfStopped,
  type PassContext,
} from './plumbing';
import type { EngineDeps, EngineSettings, PassOutcome, StagedReview } from './types';

// A persona pass added to a review: it runs over the stored batches, sees the context files the
// earlier passes read (read again at the reviewed commit), may ask for more files as Pass 2 does,
// and its findings join the numbered list. The pass itself never writes the numbered list: it hands
// each finished batch to a fold, so several passes running at once share one writer. Its prompts
// never carry earlier findings. vscode-free.

/** One finished batch of a persona pass: the findings it gave and the context paths it read. */
export interface PersonaBatch {
  /** Index of the batch in the stored review. */
  batch: number;
  findings: NewFinding[];
  contextPaths: string[];
}

/** What the fold did with a batch: the numbers it gave, the numbers merged into, and how many new ones lack a verified line. */
export interface FoldResult {
  added: number[];
  merged: number[];
  unverified: number;
}

export interface PersonaPassHooks {
  /** The batch indices to review, in order; every batch when absent. */
  batches?: number[];
  /**
   * Folds a finished batch into the numbered list, synchronously. Undefined means the result was
   * dropped (the run was stopped while the batch was out), and the pass ends stopped.
   */
  fold: (batch: PersonaBatch) => FoldResult | undefined;
}

export interface PersonaPassResult {
  /** `added` and `merged` are what the fold reported; the step is never marked as run here. */
  outcome: PassOutcome;
  /** Files the batches reviewed; none over every batch run means the pass failed. */
  reviewedFiles: number;
  /** The model refused a batch: the pass ended there, and `remaining` (the refused batch first) was not reviewed. */
  refused?: { batch: number; refusal: Refusal; remaining: number[] };
}

function personaOf(personaId: PersonaId): Persona {
  const persona = PERSONAS.find((p) => p.id === personaId);
  if (!persona) throw new Error(`Unknown review pass: ${personaId}`);
  return persona;
}

/** Runs a persona pass whose batches are folded by the caller. */
export async function runPersonaPass(
  review: StagedReview, personaId: PersonaId, settings: EngineSettings, deps: EngineDeps, hooks: PersonaPassHooks,
): Promise<PersonaPassResult> {
  const persona = personaOf(personaId);
  return runPass(deps, settings, review.snapshot.target, personaId, (ctx, tokenBudget) => personaPass(review, persona, settings, deps, hooks, ctx, tokenBudget));
}

/**
 * Runs one persona pass on its own and folds its findings into the review: the step is marked as
 * run when it went over every batch.
 */
export async function runExtraPass(
  review: StagedReview, personaId: PersonaId, settings: EngineSettings, deps: EngineDeps,
): Promise<{ review: StagedReview; outcome: PassOutcome }> {
  personaOf(personaId);
  let current = review;
  const result = await runPersonaPass(review, personaId, settings, deps, {
    fold: (b) => {
      const folded = addFindings(current.store, b.findings);
      const batches = current.snapshot.batches.map((batch, i) => (i === b.batch
        ? { ...batch, contextPaths: [...batch.contextPaths, ...b.contextPaths.filter((p) => !batch.contextPaths.includes(p))] }
        : batch));
      current = { ...current, snapshot: { ...current.snapshot, batches }, store: folded.store };
      deps.onProgress?.({ step: personaId, batchesDone: b.batch + 1, batchesTotal: review.snapshot.batches.length, review: current });
      return { added: folded.added, merged: folded.merged, unverified: folded.store.findings.filter((f) => folded.added.includes(f.id) && f.locationUnverified).length };
    },
  });
  if (result.outcome.status === 'commit-unreadable') return { review, outcome: result.outcome };
  if (result.outcome.status === 'finished') current = { ...current, store: markStepRun(current.store, personaId) };
  return { review: current, outcome: result.outcome };
}

async function personaPass(
  review: StagedReview, persona: Persona, settings: EngineSettings, deps: EngineDeps, hooks: PersonaPassHooks, ctx: PassContext, tokenBudget: number,
): Promise<PersonaPassResult> {
  const personaId = persona.id;
  const { snapshot } = review;
  const { batches, target, reviewedCommit } = snapshot;
  const pr = { ...snapshot.pr, fromCommitHash: reviewedCommit };
  const outcome = emptyOutcome(personaId, batches.length);
  const order = hooks.batches ?? batches.map((_, i) => i);

  // Every stored context file is read at the reviewed commit before the first model call.
  const read = await readContextAtCommit(
    deps.client, target.project, target.repo, reviewedCommit, [...new Set(batches.flatMap((b) => b.contextPaths))], deps.runCache,
  );
  if (!read.ok) {
    ctx.log('warn', `The reviewed commit can no longer be read — ${persona.id} pass not run`, { path: read.path, error: read.error });
    writeRunRecord(ctx, '(no findings: the reviewed commit can no longer be read)');
    return { outcome: { ...outcome, status: 'commit-unreadable', unreadablePath: read.path }, reviewedFiles: 0 };
  }

  const service = serviceFor(deps);
  const extra = extraInstructionsOf(settings);
  const background = backgroundOf(settings);
  const cache = new Map(read.files);
  let stopped = false;
  let refused: PersonaPassResult['refused'];
  let reviewedFiles = 0;
  let given = 0;
  let unverified = 0;
  let firstFailure: string | undefined;
  const tally = { raw: 0, droppedOutsidePr: 0, retracted: 0 };

  deps.onProgress?.({ step: personaId, batchesDone: 0, batchesTotal: batches.length });
  for (let n = 0; n < order.length; n++) {
    const i = order[n];
    const batch = batches[i];
    ctx.stage = `batch ${i + 1}/${batches.length} ${persona.id}`;
    try {
      throwIfStopped(deps.signal);
      const result = await reviewBatch({
        ctx, service, pr, target, commit: reviewedCommit, files: batch.files, label: `${persona.id} batch ${i + 1}/${batches.length}`,
        pass: persona.id, batch: i + 1, totalBatches: batches.length, source: persona.id, cache, tokenBudget,
        initialContext: budgetStoredContext(batch.contextPaths, cache, tokenBudget, batch.files),
        keepAgainstGoal: background !== undefined,
        buildPrompt: (items, contents, options) => service.buildPersonaPrompt(persona, pr, items, contents, extra, { ...options, ...(background ? { background } : {}) }),
      });
      if (result.refusal) {
        // A refused batch is not kept: it is reviewed whole again, or the run stops.
        refused = { batch: i, refusal: result.refusal, remaining: order.slice(n) };
        ctx.log('warn', `${persona.displayName} pass paused — the model refused batch ${i + 1}/${batches.length} (${result.refusal.kind})`, {
          ...(result.refusal.retryAfterMs !== undefined ? { retryAfterMs: result.refusal.retryAfterMs } : {}),
        });
        break;
      }
      const folded = hooks.fold({
        batch: i, findings: result.findings.map((f) => ({ ...f, batch: i })), contextPaths: result.contextPaths.filter((p) => !batch.contextPaths.includes(p)),
      });
      if (!folded) { stopped = true; break; }
      outcome.added.push(...folded.added);
      for (const m of folded.merged) if (!outcome.merged.includes(m)) outcome.merged.push(m);
      given += result.findings.length;
      unverified += folded.unverified;
      tally.raw += result.rawCount;
      tally.droppedOutsidePr += result.droppedOutsidePr;
      tally.retracted += result.retracted;
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
    outcome.batchesDone++;
  }

  keepInRunCache(deps.runCache, reviewedCommit, cache);
  outcome.droppedOutsidePr = tally.droppedOutsidePr;
  // No batch could be reviewed: the pass failed, as the regular pass does then. It is not marked as
  // run, so it can be picked again.
  if (!stopped && !refused && order.length > 0 && reviewedFiles === 0) {
    ctx.log('error', `${persona.displayName} pass failed — no file could be reviewed`, { batchesTotal: batches.length, firstFailure });
    writeRunRecord(ctx, '(no findings: no file could be reviewed)');
    return {
      outcome: { ...outcome, status: 'failed', tokens: ctx.meter.totals(), ...(firstFailure ? { error: firstFailure } : {}) },
      reviewedFiles,
    };
  }
  const ended = stopped || refused ? 'stopped' : 'finished';
  ctx.log('info', `${persona.displayName} pass ${refused ? 'paused' : ended}`, {
    batchesDone: outcome.batchesDone, batchesTotal: batches.length, added: outcome.added.length, merged: outcome.merged.length,
  });
  // The pass's own findings: `final` counts those it added as new numbers; the rest merged into numbered ones.
  const funnel = logFindingsFunnel(ctx, {
    raw: tally.raw, dedupedCrossBatch: given - outcome.added.length, droppedOutsidePr: tally.droppedOutsidePr,
    retractedByPass2: tally.retracted, final: outcome.added.length, unverified,
  });
  writeRunRecord(ctx, funnel);
  return {
    outcome: { ...outcome, status: ended, tokens: ctx.meter.totals() },
    reviewedFiles,
    ...(refused ? { refused } : {}),
  };
}
