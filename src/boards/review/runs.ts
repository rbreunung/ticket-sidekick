import {
  runCritic, runExtraPass, runRegularPass, uncheckedFindings,
  type EngineDeps, type EngineProgress, type PassOutcome, type ReviewStep, type StagedReview,
} from '../../review/engine';
import { PERSONAS, type PersonaId } from '../../services/PrReviewService';
import type { RunFinished, RunProgress } from '../../sessions/boardKind';
import { REVIEW_MODEL_SETTING, type BoardModelHandle } from '../boardModels';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewBoardDeps } from './deps';
import type { Background } from './firstStep';
import type { ActivePass, PassRecord, ReviewSession, ReviewWorking, StartedWith } from './kind';

// The review board's model runs after the first step: the regular pass (Start and Run again) and the
// extra passes the developer picked (persona passes first, the critic last, in one run). Each step's
// result is saved as it finishes, so a restart keeps the steps done; a pass a restart cut off is
// marked interrupted. vscode-free.

/** The extra passes in the order a run does them: the four persona passes, then the critic. */
export const EXTRA_STEPS: ReviewStep[] = [...PERSONAS.map(p => p.id), 'critic'];

export const STEP_LABELS: Record<ReviewStep, string> = {
  regular: 'Regular', security: 'Security', performance: 'Performance', reliability: 'Reliability', maintainability: 'Maintainability', critic: 'Critic',
};

/** "the security pass", "the critic". */
export function stepName(step: ReviewStep): string {
  return step === 'critic' ? 'the critic' : `the ${STEP_LABELS[step].toLowerCase()} pass`;
}

export function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function hasWork(working: ReviewWorking): boolean {
  return Object.keys(working.explanations).length > 0 || Object.keys(working.drafts).length > 0;
}

/** Numbers of the findings the developer worked on: explained, or with a draft comment. */
export function workedOn(working: ReviewWorking): number[] {
  return [...new Set([...Object.keys(working.explanations), ...Object.keys(working.drafts)].map(Number))].filter(Number.isInteger);
}

/** The model the runs use: the one picked on the board, else the setting's when it is available. */
export function modelIdOf(session: ReviewSession): string | undefined {
  const { models } = session.derived.data;
  return session.working.firstStep.modelId ?? (models.state === 'ready' ? models.setting : undefined);
}

/** Whether a critic run now has findings to check. */
export function criticHasWork(review: StagedReview): boolean {
  return uncheckedFindings(review.store).length > 0;
}

/** Whether an extra step can be picked now, or why not. */
export function stepBlocker(review: StagedReview, step: ReviewStep): string | undefined {
  if (step === 'critic') return criticHasWork(review) ? undefined : review.store.stepsRun.includes('critic') ? 'Every finding has been checked.' : 'There is no finding to check.';
  return review.store.stepsRun.includes(step) ? 'Run already.' : undefined;
}

/** The steps picked now: the developer's picks, else the suggestion; only steps that can run. */
export function pickedSteps(working: ReviewWorking): ReviewStep[] {
  const review = working.review;
  if (!review) return [];
  const picks = working.picked ?? (review.suggestion.kind === 'suggested' ? review.suggestion.personas : []);
  return EXTRA_STEPS.filter(step => picks.includes(step) && !stepBlocker(review, step));
}

/**
 * The text the review calls take as the developer's focus: the own-text background. A ticket's text
 * is kept with the review but not given to the calls yet.
 */
export function focusOf(startedWith: Pick<StartedWith, 'background'>): string {
  return startedWith.background?.kind === 'text' ? startedWith.background.text : '';
}

/** A run that did nothing: the notice says why, on the first step or on the results. */
export function withNotice(notice: string, firstStep: boolean): RunFinished<ReviewWorking> {
  return { update: w => (firstStep ? { ...w, firstStep: { ...w.firstStep, notice } } : { ...w, notice }) };
}

/** The model handle a run uses, after saving a model picked on the board to the setting. */
export async function modelFor(session: ReviewSession, deps: ReviewBoardDeps): Promise<{ handle: BoardModelHandle } | { problem: string }> {
  const id = modelIdOf(session);
  if (!id) return { problem: 'Pick the model first.' };
  const handle = await deps.models.handle(id);
  if (!handle) return { problem: `The model "${id}" is not available. Pick another one.` };
  if (session.working.firstStep.modelId === id && deps.modelSettings.reviewModel().trim() !== id) {
    try {
      await deps.modelSettings.writeReviewModel(id);
      deps.onDiag?.('info', 'Review model setting saved', { setting: REVIEW_MODEL_SETTING, modelId: id });
    } catch (err) {
      deps.onDiag?.('warn', 'Could not save the review model setting', { setting: REVIEW_MODEL_SETTING, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { handle };
}

/** The engine's dependencies for one run, with progress turned into the board's progress reports. */
async function engineDeps(
  deps: ReviewBoardDeps, model: BoardModelHandle, client: EngineDeps['client'], signal: AbortSignal, onProgress?: (p: EngineProgress) => void,
): Promise<EngineDeps> {
  const onDiag = deps.reviewDiag ?? deps.onDiag;
  return {
    model,
    recordTokens: (id, figures) => deps.recordTokens(id, figures),
    client,
    signal,
    ...(onProgress ? { onProgress } : {}),
    ...(onDiag ? { onDiag } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
}

/**
 * What an extra pass or the critic changed in the stored review after its last finished batch: the
 * findings, and the batches' context paths when the pass added any. The stored review keeps the rest.
 */
function partialChanges(stored: StagedReview, partial: StagedReview): NonNullable<ActivePass['partialChanges']> {
  const contextPaths = partial.snapshot.batches.map(b => b.contextPaths);
  const same = contextPaths.length === stored.snapshot.batches.length
    && contextPaths.every((paths, i) => paths.length === stored.snapshot.batches[i].contextPaths.length
      && paths.every((path, j) => path === stored.snapshot.batches[i].contextPaths[j]));
  return { store: partial.store, ...(same ? {} : { contextPaths: contextPaths.map(paths => [...paths]) }) };
}

/** The stored review with a running extra pass's changes merged in. */
function withPartialChanges(review: StagedReview, changes: NonNullable<ActivePass['partialChanges']>): StagedReview {
  const { contextPaths } = changes;
  if (!contextPaths) return { ...review, store: changes.store };
  return {
    ...review,
    snapshot: { ...review.snapshot, batches: review.snapshot.batches.map((b, i) => ({ ...b, contextPaths: [...(contextPaths[i] ?? b.contextPaths)] })) },
    store: changes.store,
  };
}

/**
 * Reports engine progress in order: each report waits for the one before it. The regular pass saves
 * the review as it stands; an extra pass or the critic saves only what it changed in the stored review.
 */
function progressReporter(progress: RunProgress<ReviewWorking>) {
  let reported = Promise.resolve();
  return {
    report(p: EngineProgress) {
      reported = reported.then(() => progress({
        update: w => {
          if (!w.active) return w;
          const active: ActivePass = { ...w.active, step: p.step, done: p.batchesDone, total: p.batchesTotal };
          if (p.review) {
            if (active.what === 'passes' && w.review) active.partialChanges = partialChanges(w.review, p.review);
            else active.partial = p.review;
          }
          return { ...w, active };
        },
        done: p.batchesDone,
        total: p.batchesTotal,
      })).catch(() => undefined);
    },
    settled: () => reported,
  };
}

function nextRun(working: ReviewWorking): number {
  return (working.passes[working.passes.length - 1]?.run ?? 0) + 1;
}

export interface RegularRunChoices {
  background?: Background;
  /** Why there is no background though a ticket was chosen. */
  backgroundReason?: string;
  /** Asked before the review is replaced when it has explanations or drafts. */
  confirm: { title: string; detail: string; button: string; declined: string };
  /** Run from the first step (Start) or from the results (Run again). */
  fromFirstStep: boolean;
}

/** The regular pass, for Start and for Run again: a new review replaces the stored one. */
export async function regularRun(
  session: ReviewSession, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal, choices: RegularRunChoices,
): Promise<RunFinished<ReviewWorking>> {
  const { working, recipe } = session;
  if (working.review && hasWork(working)) {
    const { declined, ...question } = choices.confirm;
    if (!(await deps.confirm(question))) return withNotice(declined, choices.fromFirstStep);
  }
  const model = await modelFor(session, deps);
  if (!('handle' in model)) return withNotice(model.problem, choices.fromFirstStep);
  const bitbucket = await deps.bitbucket();
  if (!bitbucket.configured) return withNotice(bitbucket.hint, choices.fromFirstStep);
  const { confidenceThreshold, ...settings } = await deps.settings();
  const begun: Omit<StartedWith, 'confidenceThreshold'> = {
    modelId: model.handle.id,
    ...(choices.background ? { background: choices.background } : {}),
    ...(choices.backgroundReason ? { backgroundReason: choices.backgroundReason } : {}),
  };
  const focus = focusOf(begun);
  const active: ActivePass = {
    what: 'regular', steps: ['regular'], step: 'regular', done: 0, total: 0, modelId: model.handle.id, run: 1, startedWith: begun,
  };
  // From here a restart finds the pass cut off, and the review it replaces is gone.
  await progress({ update: w => ({ ...w, active }), done: 0, total: 0 });
  const reporter = progressReporter(progress);
  const result = await runRegularPass({
    target: { project: recipe.project, repo: recipe.repo, prId: recipe.prId },
    settings: { ...settings, ...(focus ? { focus } : {}) },
  }, await engineDeps(deps, model.handle, bitbucket.client, signal, reporter.report));
  await reporter.settled();
  if (result.outcome.status === 'finished') await deps.onReviewCompleted?.();
  const record: PassRecord = { ...result.outcome, modelId: model.handle.id, run: 1 };
  const startedWith: StartedWith = { ...begun, confidenceThreshold };
  return {
    update: w => {
      const next: ReviewWorking = {
        ...w, stage: 'review', firstStep: { ...w.firstStep }, startedWith, passes: [record], explanations: {}, drafts: {},
      };
      delete next.firstStep.notice;
      delete next.active;
      delete next.notice;
      withoutResultsState(next);
      if (result.review) next.review = result.review;
      else delete next.review;
      return next;
    },
  };
}

/** The picked extra passes, persona passes first and the critic last, each saved as it finishes. */
export async function extraPassesRun(
  session: ReviewSession, steps: ReviewStep[], deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working } = session;
  if (!working.review) return withNotice('There is no review to add a pass to.', false);
  let review: StagedReview = working.review;
  const model = await modelFor(session, deps);
  if (!('handle' in model)) return withNotice(model.problem, false);
  const bitbucket = await deps.bitbucket();
  if (!bitbucket.configured) return withNotice(bitbucket.hint, false);
  const { confidenceThreshold: _threshold, ...settings } = await deps.settings();
  const focus = working.startedWith ? focusOf(working.startedWith) : '';
  const engineSettings = { ...settings, ...(focus ? { focus } : {}) };
  const run = nextRun(working);
  const modelId = model.handle.id;
  await progress({ update: w => ({ ...w, active: { what: 'passes', steps, step: steps[0], done: 0, total: 0, modelId, run } }), done: 0, total: 0 });
  const reporter = progressReporter(progress);
  // One cache for the run, so the steps after the first do not read the same context files again.
  const engine: EngineDeps = { ...await engineDeps(deps, model.handle, bitbucket.client, signal, reporter.report), runCache: new Map() };
  const worked = workedOn(working);

  for (const step of steps) {
    if (signal.aborted) break;
    const result: { review: StagedReview; outcome: PassOutcome } = step === 'critic'
      ? await runCritic(review, worked, engineSettings, engine)
      : await runExtraPass(review, step as PersonaId, engineSettings, engine);
    await reporter.settled();
    review = result.review;
    const record: PassRecord = { ...result.outcome, modelId, run };
    const done = review;
    await progress({
      update: w => {
        const next: ReviewWorking = { ...w, review: done, passes: [...w.passes, record] };
        if (next.active) {
          next.active = { ...next.active };
          delete next.active.partial;
          delete next.active.partialChanges;
        }
        return next;
      },
      done: result.outcome.batchesDone,
      total: result.outcome.batchesTotal,
    });
    if (result.outcome.status !== 'finished') break;
  }
  const final = review;
  return {
    update: w => {
      const next: ReviewWorking = { ...w, review: final };
      const left = steps.filter(step => !final.store.stepsRun.includes(step) && !(step === 'critic' && !criticHasWork(final)));
      if (left.length > 0) next.picked = left;
      else delete next.picked;
      delete next.active;
      delete next.notice;
      return next;
    },
  };
}

/**
 * What the passes did not review and the findings they dropped, as plain lines: files cut short,
 * not fetched, excluded or with no text change, the parts of batches that failed, the findings that
 * named a file outside the pull request and the findings the critic removed.
 */
export function reviewNotes(passes: ReadonlyArray<Pick<PassRecord, 'step' | 'notes' | 'droppedOutsidePr' | 'removed'>>): string[] {
  const lines = passes.flatMap(p => p.notes);
  const outside = passes.reduce((n, p) => n + (p.droppedOutsidePr ?? 0), 0);
  if (outside > 0) {
    lines.push(outside === 1
      ? '1 finding was dropped because it named a file outside this pull request.'
      : `${outside} findings were dropped because they named files outside this pull request.`);
  }
  const removed = passes.flatMap(p => (p.step === 'critic' ? p.removed : []));
  if (removed.length > 0) {
    lines.push(`${removed.length === 1 ? '1 finding was' : `${removed.length} findings were`} removed by the critic as unverifiable: ${removed.map(n => `#${n}`).join(', ')}.`);
  }
  return lines;
}

function emptyRecord(step: ReviewStep, active: ActivePass, run: number): PassRecord {
  const outcome: PassOutcome = {
    step, status: 'stopped', batchesDone: active.done, batchesTotal: active.total, failedBatches: 0, notes: [],
    added: [], merged: [], removed: [], labelled: [], tokens: { input: 0, output: 0, calls: 0, estimated: false },
  };
  return { ...outcome, status: 'interrupted', modelId: active.modelId, run };
}

/** Clears what belongs to the results of the review being replaced: the picks, the selection, the failed calls and their tokens. */
function withoutResultsState(working: ReviewWorking): void {
  delete working.picked;
  delete working.selected;
  delete working.failures;
  delete working.callTokens;
}

/** The working state of a board whose pass a restart cut off: the steps saved so far stay. */
export function interruptedWorking(working: ReviewWorking): ReviewWorking {
  const { active } = working;
  if (!active) return working;
  const next: ReviewWorking = { ...working };
  delete next.active;
  if (active.what === 'regular') {
    // The findings of the batches that finished stay, as after a stop; the review it replaced is gone.
    const startedWith: StartedWith = { ...active.startedWith!, confidenceThreshold: working.startedWith?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD };
    const result: ReviewWorking = {
      ...next, stage: 'review', startedWith, passes: [emptyRecord(active.step, active, active.run)], explanations: {}, drafts: {},
    };
    if (active.partial) result.review = active.partial;
    else delete result.review;
    withoutResultsState(result);
    return result;
  }
  const step = active.step;
  // The running step's finished batches join the review; the steps finished before it were saved already.
  if (active.partialChanges && next.review) next.review = withPartialChanges(next.review, active.partialChanges);
  else if (active.partial) next.review = active.partial;
  const review = next.review;
  const left = active.steps.filter(s => !review?.store.stepsRun.includes(s));
  if (left.length > 0) next.picked = left;
  return { ...next, passes: [...working.passes, emptyRecord(step, active, active.run)] };
}
