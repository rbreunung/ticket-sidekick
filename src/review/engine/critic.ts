import { withEasierRetry } from '../../utils/lmRetry';
import { parseCriticAdditionalFiles, parseCriticKeep, type ReviewFinding } from '../reviewSessionState';
import { applyCriticVerdicts, markStepRun, uncheckedFindings } from './findingStore';
import {
  budgetStoredContext,
  callOnce,
  callWithRetry,
  describeError,
  emptyOutcome,
  extraInstructionsOf,
  fetchAndBudgetContextFiles,
  isStop,
  passContext,
  readContextAtCommit,
  rethrowStop,
  serviceFor,
  splitInHalf,
  throwIfStopped,
  tokenBudgetOf,
} from './plumbing';
import type { EngineDeps, EngineSettings, PassOutcome, StagedReview, StoredFinding } from './types';

// The critic: checks the findings it has not checked yet against the diff of the batch each came
// from, with that batch's context files read at the reviewed commit. A finding it cannot confirm is
// removed, unless the developer explained it or drafted a comment for it; then it stays, labelled as
// probably a false alarm. Numbers never change. vscode-free.

const FINAL_ROUND_NOTE =
  'This is the final verification round — no further files will be provided. ' +
  'Decide "keep" using only the files you now have.';

function withoutNumber(f: StoredFinding): Omit<ReviewFinding, 'id'> {
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
  const ctx = passContext(deps);
  const { snapshot } = review;
  const { target, reviewedCommit } = snapshot;
  const pr = { ...snapshot.pr, fromCommitHash: reviewedCommit };
  const byBatch = new Map<number, StoredFinding[]>();
  for (const f of uncheckedFindings(review.store)) byBatch.set(f.batch, [...(byBatch.get(f.batch) ?? []), f]);
  const order = [...byBatch.keys()].sort((a, b) => a - b);
  const outcome = emptyOutcome('critic', order.length);

  const read = await readContextAtCommit(
    deps.client, target.project, target.repo, reviewedCommit, [...new Set(order.flatMap((i) => snapshot.batches[i]?.contextPaths ?? []))],
  );
  if (!read.ok) {
    ctx.log('warn', 'The reviewed commit can no longer be read — critic not run', { path: read.path, error: read.error });
    return { review, outcome: { ...outcome, status: 'commit-unreadable', unreadablePath: read.path } };
  }

  const service = serviceFor(deps);
  const tokenBudget = tokenBudgetOf(settings, deps.model);
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
    const diffsFor = (items: StoredFinding[]) => {
      const referenced = new Set(items.map((f) => f.file));
      return (batch?.files ?? []).filter((d) => referenced.has(d.path));
    };
    const verdicts: Array<{ id: number; keep: boolean }> = [];
    let failed = false;
    try {
      throwIfStopped(deps.signal);
      const parts = await withEasierRetry(
        candidates,
        async (items) => {
          const diffs = diffsFor(items);
          const context = budgetStoredContext(batch?.contextPaths ?? [], cache, tokenBudget, diffs);
          return callOnce(ctx, service.buildCriticPrompt(pr, diffs, items.map(withoutNumber), extra, context.size > 0 ? context : undefined));
        },
        splitInHalf,
        {
          ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
          onAttemptFailed: (attempt, err) => {
            if (!isStop(err, deps.signal)) ctx.log('warn', `Model call failed — ${label} (attempt ${attempt})`, { error: err instanceof Error ? err.message : String(err) });
          },
        },
      );
      rethrowStop(parts.map((p) => p.error), deps.signal);

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
                ctx, service.buildCriticPrompt(pr, diffs, part.items.map(withoutNumber), extra ? `${FINAL_ROUND_NOTE}\n${extra}` : FINAL_ROUND_NOTE, contents),
                `${label} round 2`,
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
    deps.onProgress?.({ step: 'critic', batchesDone: n + 1, batchesTotal: order.length });
  }

  if (!stopped) store = markStepRun(store, 'critic');
  ctx.log('info', `Critic ${stopped ? 'stopped' : 'finished'}`, {
    batchesDone: outcome.batchesDone, batchesTotal: order.length, removed: outcome.removed.length, labelled: outcome.labelled.length,
  });
  return { review: { ...review, store }, outcome: { ...outcome, status: stopped ? 'stopped' : 'finished', tokens: ctx.meter.totals() } };
}
