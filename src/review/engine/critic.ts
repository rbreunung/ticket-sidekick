import { parseCriticAdditionalFiles, parseCriticKeep, type ReviewFinding } from '../reviewSessionState';
import { logFindingsFunnel, runPass, writeRunRecord } from './diagnostics';
import { applyCriticVerdicts, markStepRun, uncheckedFindings } from './findingStore';
import {
  budgetStoredContext,
  callBatchWithSplit,
  callWithRetry,
  describeError,
  emptyOutcome,
  extraInstructionsOf,
  fetchAndBudgetContextFiles,
  isStop,
  keepInRunCache,
  readContextAtCommit,
  serviceFor,
  throwIfStopped,
  type PassContext,
} from './plumbing';
import type { EngineDeps, EngineSettings, PassOutcome, StagedReview, StoredFinding } from './types';

// The critic: checks the findings it has not checked yet against the diff of the batch each came
// from, with that batch's context files read at the reviewed commit. A finding it cannot confirm is
// removed, unless the developer explained it or drafted a comment for it; then it stays, labelled as
// probably a false alarm. Numbers never change. vscode-free.

const FINAL_ROUND_NOTE =
  'This is the final verification round — no further files will be provided. ' +
  'Decide "keep" using only the files you now have.';

/** A finding as the critic is shown it: no number, batch or false-alarm label. */
function forCritic(f: StoredFinding): Omit<ReviewFinding, 'id'> {
  const { id: _id, batch: _batch, probablyFalseAlarm: _label, ...rest } = f;
  return rest;
}

/**
 * Runs the critic. `workedOn` holds the numbers of the findings the developer explained or drafted a
 * comment for.
 */
export async function runCritic(
  review: StagedReview, workedOn: readonly number[], settings: EngineSettings, deps: EngineDeps,
): Promise<{ review: StagedReview; outcome: PassOutcome }> {
  return runPass(deps, settings, review.snapshot.target, 'critic', (ctx, tokenBudget) => critic(review, workedOn, settings, deps, ctx, tokenBudget));
}

async function critic(
  review: StagedReview, workedOn: readonly number[], settings: EngineSettings, deps: EngineDeps, ctx: PassContext, tokenBudget: number,
): Promise<{ review: StagedReview; outcome: PassOutcome }> {
  const { snapshot } = review;
  const { target, reviewedCommit } = snapshot;
  const pr = { ...snapshot.pr, fromCommitHash: reviewedCommit };
  const byBatch = new Map<number, StoredFinding[]>();
  for (const f of uncheckedFindings(review.store)) byBatch.set(f.batch, [...(byBatch.get(f.batch) ?? []), f]);
  const order = [...byBatch.keys()].sort((a, b) => a - b);
  const outcome = emptyOutcome('critic', order.length);

  const read = await readContextAtCommit(
    deps.client, target.project, target.repo, reviewedCommit, [...new Set(order.flatMap((i) => snapshot.batches[i]?.contextPaths ?? []))],
    deps.runCache,
  );
  if (!read.ok) {
    ctx.log('warn', 'The reviewed commit can no longer be read — critic not run', { path: read.path, error: read.error });
    writeRunRecord(ctx, '(no verdicts: the reviewed commit can no longer be read)');
    return { review, outcome: { ...outcome, status: 'commit-unreadable', unreadablePath: read.path } };
  }

  const service = serviceFor(deps);
  const extra = extraInstructionsOf(settings);
  const cache = new Map(read.files);
  const worked = new Set(workedOn);
  let store = review.store;
  let stopped = false;

  deps.onProgress?.({ step: 'critic', batchesDone: 0, batchesTotal: order.length });
  for (let n = 0; n < order.length; n++) {
    const batchIndex = order[n];
    const batch = snapshot.batches[batchIndex];
    const candidates = byBatch.get(batchIndex)!;
    const label = `critic batch ${batchIndex + 1}/${snapshot.batches.length}`;
    const where = { batch: batchIndex + 1, totalBatches: snapshot.batches.length };
    ctx.stage = `batch ${where.batch}/${where.totalBatches} critic`;
    const diffsFor = (items: StoredFinding[]) => {
      const referenced = new Set(items.map((f) => f.file));
      return (batch?.files ?? []).filter((d) => referenced.has(d.path));
    };
    const verdicts: Array<{ id: number; keep: boolean }> = [];
    let failed = false;
    try {
      throwIfStopped(deps.signal);
      const parts = await callBatchWithSplit(ctx, {
        items: candidates, pass: 'critic', ...where, label,
        buildPrompt: (items) => {
          const diffs = diffsFor(items);
          const context = budgetStoredContext(batch?.contextPaths ?? [], cache, tokenBudget, diffs);
          return service.buildCriticPrompt(pr, diffs, items.map(forCritic), extra, context.size > 0 ? context : undefined);
        },
        statusOf: () => 'ok',
      });

      for (const part of parts) {
        if (part.error !== undefined) {
          failed = true;
          outcome.notes.push(`${label}: ${part.items.length} finding(s) could not be checked and stay unchecked (${describeError(part.error)})`);
          continue;
        }
        let raw = part.result!;
        // One extra round with the files the critic asked for, next to the batch's own context files.
        const requested = parseCriticAdditionalFiles(raw);
        if (requested.length > 0) {
          try {
            const diffs = diffsFor(part.items);
            const contents = await fetchAndBudgetContextFiles({
              requested: [...new Set([...(batch?.contextPaths ?? []), ...requested])], cache, service,
              project: target.project, repo: target.repo, commit: reviewedCommit, tokenBudget, budgetAgainst: diffs,
            });
            if (contents.size > 0) {
              const round2 = await callWithRetry(
                ctx, service.buildCriticPrompt(pr, diffs, part.items.map(forCritic), extra ? `${FINAL_ROUND_NOTE}\n${extra}` : FINAL_ROUND_NOTE, contents),
                `${label} round 2`, undefined,
                { site: { pass: 'critic-r2', ...where, itemCount: part.items.length } },
              );
              // A garbled second verdict never replaces a readable first one.
              if (parseCriticKeep(round2, part.items.length) !== null) raw = round2;
            }
          } catch (err) {
            if (isStop(err, deps.signal)) throw err;
            ctx.log('warn', `Critic file round failed — keeping the first verdict — ${label}`, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        const keep = parseCriticKeep(raw, part.items.length);
        if (keep === null) {
          // An unreadable verdict neither removes nor confirms: the findings stay, unchecked.
          failed = true;
          outcome.notes.push(`${label}: the verdict was unreadable, so ${part.items.length} finding(s) stay unchecked`);
          continue;
        }
        part.items.forEach((f, idx) => verdicts.push({ id: f.id, keep: keep.has(idx + 1) }));
      }
    } catch (err) {
      if (!isStop(err, deps.signal)) throw err;
      stopped = true;
      break;
    }
    const applied = applyCriticVerdicts(store, verdicts, worked);
    store = applied.store;
    outcome.removed.push(...applied.removed);
    outcome.labelled.push(...applied.labelled);
    if (failed) outcome.failedBatches++;
    outcome.batchesDone = n + 1;
    deps.onProgress?.({ step: 'critic', batchesDone: n + 1, batchesTotal: order.length, review: { ...review, store } });
  }

  keepInRunCache(deps.runCache, reviewedCommit, cache);
  if (!stopped) store = markStepRun(store, 'critic');
  ctx.log('info', `Critic ${stopped ? 'stopped' : 'finished'}`, {
    batchesDone: outcome.batchesDone, batchesTotal: order.length, removed: outcome.removed.length, labelled: outcome.labelled.length,
  });
  // The findings the critic was given: those it removed, and the rest, still listed.
  const given = order.reduce((n, i) => n + byBatch.get(i)!.length, 0);
  const kept = new Set(store.findings.map((f) => f.id));
  const funnel = logFindingsFunnel(ctx, {
    raw: given, dedupedCrossBatch: 0, droppedOutsidePr: 0, retractedByPass2: 0, droppedByCritic: outcome.removed.length,
    final: given - outcome.removed.length,
    unverified: order.flatMap((i) => byBatch.get(i)!).filter((f) => kept.has(f.id) && f.locationUnverified).length,
  });
  writeRunRecord(ctx, funnel);
  return { review: { ...review, store }, outcome: { ...outcome, status: stopped ? 'stopped' : 'finished', tokens: ctx.meter.totals() } };
}
