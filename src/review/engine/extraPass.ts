import { PERSONAS, type PersonaId } from '../../services/PrReviewService';
import { reviewBatch } from './batchReview';
import { addFindings, markStepRun, type NewFinding } from './findingStore';
import {
  budgetStoredContext,
  emptyOutcome,
  extraInstructionsOf,
  isStop,
  passContext,
  readContextAtCommit,
  serviceFor,
  throwIfStopped,
  tokenBudgetOf,
} from './plumbing';
import type { EngineDeps, EngineSettings, PassOutcome, StagedReview } from './types';

// A persona pass added to a review: it runs over the stored batches, sees the context files the
// earlier passes read (read again at the reviewed commit), may ask for more files as Pass 2 does,
// and its findings join the numbered list. vscode-free.

export async function runExtraPass(
  review: StagedReview, personaId: PersonaId, settings: EngineSettings, deps: EngineDeps,
): Promise<{ review: StagedReview; outcome: PassOutcome }> {
  const persona = PERSONAS.find((p) => p.id === personaId);
  if (!persona) throw new Error(`Unknown review pass: ${personaId}`);
  const ctx = passContext(deps);
  const { snapshot } = review;
  const { batches, target, reviewedCommit } = snapshot;
  const pr = { ...snapshot.pr, fromCommitHash: reviewedCommit };
  const outcome = emptyOutcome(personaId, batches.length);

  // Every stored context file is read at the reviewed commit before the first model call.
  const read = await readContextAtCommit(deps.client, target.project, target.repo, reviewedCommit, [...new Set(batches.flatMap((b) => b.contextPaths))]);
  if (!read.ok) {
    ctx.log('warn', `The reviewed commit can no longer be read — ${persona.id} pass not run`, { path: read.path, error: read.error });
    return { review, outcome: { ...outcome, status: 'commit-unreadable', unreadablePath: read.path } };
  }

  const service = serviceFor(deps);
  const tokenBudget = tokenBudgetOf(settings, deps.model);
  const extra = extraInstructionsOf(settings);
  const cache = new Map(read.files);
  const contextPaths = batches.map((b) => [...b.contextPaths]);
  const findings: NewFinding[] = [];
  let stopped = false;

  deps.onProgress?.({ step: personaId, batchesDone: 0, batchesTotal: batches.length });
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      throwIfStopped(deps.signal);
      const result = await reviewBatch({
        ctx, service, pr, target, commit: reviewedCommit, files: batch.files, label: `${persona.id} batch ${i + 1}/${batches.length}`,
        source: persona.id, cache, tokenBudget,
        initialContext: budgetStoredContext(batch.contextPaths, cache, tokenBudget, batch.files),
        buildPrompt: (items, contents, options) => service.buildPersonaPrompt(persona, pr, items, contents, extra, options),
      });
      for (const path of result.contextPaths) if (!contextPaths[i].includes(path)) contextPaths[i].push(path);
      findings.push(...result.findings.map((f) => ({ ...f, batch: i })));
      if (result.failures.length > 0) {
        outcome.failedBatches++;
        outcome.notes.push(...result.failures);
      }
    } catch (err) {
      if (!isStop(err, deps.signal)) throw err;
      stopped = true;
      break;
    }
    outcome.batchesDone = i + 1;
    deps.onProgress?.({ step: personaId, batchesDone: i + 1, batchesTotal: batches.length });
  }

  const added = addFindings(review.store, findings);
  const next: StagedReview = {
    ...review,
    snapshot: { ...snapshot, batches: batches.map((b, i) => ({ ...b, contextPaths: contextPaths[i] })) },
    store: stopped ? added.store : markStepRun(added.store, personaId),
  };
  ctx.log('info', `${persona.displayName} pass ${stopped ? 'stopped' : 'finished'}`, {
    batchesDone: outcome.batchesDone, batchesTotal: batches.length, added: added.added.length, merged: added.merged.length,
  });
  return {
    review: next,
    outcome: { ...outcome, status: stopped ? 'stopped' : 'finished', added: added.added, merged: added.merged, tokens: ctx.meter.totals() },
  };
}
