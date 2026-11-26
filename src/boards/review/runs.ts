import {
  addFindings, addTokenTotals, markStepRun, runCritic, runPersonaPass, runRegularPass, uncheckedFindings,
  type EngineDeps, type EngineProgress, type FoldResult, type PassOutcome, type PersonaBatch, type ReviewStep, type StagedReview, type TokenTotals,
} from '../../review/engine';
import { PERSONAS, type PersonaId } from '../../services/PrReviewService';
import type { RunFinished, RunProgress } from '../../sessions/boardKind';
import { REVIEW_MODEL_SETTING, type BoardModelHandle } from '../boardModels';
import type { TokenFigures } from '../../utils/tokenUsage';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewBoardDeps } from './deps';
import type { Background } from './firstStep';
import type { ActivePass, PassRecord, ReviewSession, ReviewWorking, StartedWith, StepProgress } from './kind';

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

/** The findings with a discussion of at least one turn, by number as stored. */
function discussed(working: ReviewWorking): string[] {
  return Object.keys(working.threads).filter(key => working.threads[key].length > 0);
}

export function hasWork(working: ReviewWorking): boolean {
  return discussed(working).length > 0 || Object.keys(working.drafts).length > 0;
}

/** Numbers of the findings the developer worked on: discussed (Explain or a follow-up), or with a draft comment. */
export function workedOn(working: ReviewWorking): number[] {
  return [...new Set([...discussed(working), ...Object.keys(working.drafts)].map(Number))].filter(Number.isInteger);
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
  tally?: TokenTally,
): Promise<EngineDeps> {
  const onDiag = deps.reviewDiag ?? deps.onDiag;
  return {
    model,
    recordTokens: (id, figures) => { tally?.add(figures); return deps.recordTokens(id, figures); },
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

/** The tokens of one run's calls as they are counted, for the band's "tokens so far". */
interface TokenTally {
  add(figures: TokenFigures): void;
  readonly totals: TokenTotals | undefined;
}

function tokenTally(): TokenTally {
  let totals: TokenTotals | undefined;
  return {
    add: figures => { totals = addTokenTotals(totals, { ...figures, calls: 1 }); },
    get totals() { return totals; },
  };
}

/** Reports the regular pass's progress in order: each report waits for the one before it, and saves the review as it stands. */
function progressReporter(progress: RunProgress<ReviewWorking>, tally: TokenTally) {
  let reported = Promise.resolve();
  return {
    report(p: EngineProgress) {
      const tokensSoFar = tally.totals;
      reported = reported.then(() => progress({
        update: w => {
          if (!w.active) return w;
          const active: ActivePass = { ...w.active, step: p.step, done: p.batchesDone, total: p.batchesTotal, ...(tokensSoFar ? { tokensSoFar } : {}) };
          if (p.review) active.partial = p.review;
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
  /** Asked before the review is replaced when it has discussions or drafts. */
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
  const active: ActivePass = {
    what: 'regular', steps: ['regular'], step: 'regular', done: 0, total: 0, modelId: model.handle.id, run: 1, startedWith: begun,
  };
  // From here a restart finds the pass cut off, and the review it replaces is gone.
  await progress({ update: w => ({ ...w, active }), done: 0, total: 0 });
  const tally = tokenTally();
  const reporter = progressReporter(progress, tally);
  const result = await runRegularPass({
    target: { project: recipe.project, repo: recipe.repo, prId: recipe.prId },
    settings: { ...settings, ...(begun.background ? { background: begun.background } : {}) },
  }, await engineDeps(deps, model.handle, bitbucket.client, signal, reporter.report, tally));
  await reporter.settled();
  if (result.outcome.status === 'finished') await deps.onReviewCompleted?.();
  const record: PassRecord = { ...result.outcome, modelId: model.handle.id, run: 1 };
  const startedWith: StartedWith = { ...begun, confidenceThreshold };
  return {
    update: w => {
      const next: ReviewWorking = {
        ...w, stage: 'review', firstStep: { ...w.firstStep }, startedWith, passes: [record], threads: {}, drafts: {},
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

/** Why the run stopped when the model refused: blocked, quota used up, or rate-limited a second time. */
export const QUOTA_MESSAGE =
  'The model refused further requests: the request limit or quota is used up, or the model is blocked for now. ' +
  'The run stopped, and the passes it did not finish are offered again. Try again later.';
export const ONE_AT_A_TIME_NOTE = 'The model limited the requests, so the passes now run one after another.';
/** Said after a run whose passes had to run one after another, and whose refused batches ran again. */
export const RAN_ONE_AT_A_TIME_NOTICE = 'The model limited the requests, so the passes ran one after another and the refused batches ran once more.';
/** How long the rerun round waits when the refusal gave no retry hint. */
export const RATE_LIMIT_WAIT_MS = 30_000;
/** Up to this many batches, every picked persona pass runs at once; above it, two at a time. */
export const ALL_AT_ONCE_MAX_BATCHES = 4;
const TWO_AT_ONCE = 2;

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Waits `ms`, or less when the run is stopped meanwhile. */
function waitUnlessStopped(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    void sleep(ms).then(done, done);
  });
}

/** Two outcomes of the same step in one run (before and after its refused batches ran again) as one. */
function combineOutcomes(a: PassOutcome | undefined, b: PassOutcome): PassOutcome {
  if (!a) return b;
  return {
    ...b,
    batchesDone: a.batchesDone + b.batchesDone,
    failedBatches: a.failedBatches + b.failedBatches,
    notes: [...a.notes, ...b.notes],
    added: [...a.added, ...b.added],
    merged: [...new Set([...a.merged, ...b.merged])],
    droppedOutsidePr: (a.droppedOutsidePr ?? 0) + (b.droppedOutsidePr ?? 0),
    removed: [...a.removed, ...b.removed],
    labelled: [...a.labelled, ...b.labelled],
    tokens: addTokenTotals(a.tokens, b.tokens),
    ...(a.error ?? b.error ? { error: a.error ?? b.error } : {}),
  };
}

/**
 * The picked extra passes in one run. The persona passes run at the same time (all of them when the
 * review has at most four batches, else two at once, the next starting as one ends), each over its
 * batches one after another; the critic runs after all of them. Every finished batch of every pass is
 * folded into the review at one place, `fold`, in one synchronous step, so the numbers stay unique
 * and gap-free and a duplicate across passes merges. Stop, and a refusal that stops the run, abort
 * one shared controller; a batch result arriving after that is dropped. A batch refused as
 * rate-limited pauses its pass: the passes not started then run one after another, and after the
 * others end, following a wait, the paused passes run once more from the refused batch; a refusal in
 * that round, or a blocked or quota refusal at any time, stops the run with the quota message.
 */
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
  const background = working.startedWith?.background;
  const engineSettings = { ...settings, ...(background ? { background } : {}) };
  const run = nextRun(working);
  const modelId = model.handle.id;
  const batchCount = review.snapshot.batches.length;
  const entries: StepProgress[] = steps.map(step => ({ step, done: 0, total: step === 'critic' ? 0 : batchCount, state: 'queued' }));
  const entryOf = (step: ReviewStep) => entries.find(e => e.step === step)!;
  await progress({
    update: w => ({ ...w, active: { what: 'passes', steps, step: steps[0], done: 0, total: 0, modelId, run, stepsProgress: entries.map(e => ({ ...e })) } }),
    done: 0, total: 0,
  });

  // One controller for the whole run: Stop, and a refusal that stops the run, end every pass at once.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const runSignal = controller.signal;
  // One cache for the run, so the steps after the first do not read the same context files again.
  const tally = tokenTally();
  const engine: EngineDeps = { ...await engineDeps(deps, model.handle, bitbucket.client, runSignal, undefined, tally), runCache: new Map() };
  const sleep = deps.sleep ?? realSleep;
  const worked = workedOn(working);

  let oneAtATime = false;
  let refusedStop = false;
  let rerunRound = false;
  let reranAny = false;
  let unexpected: unknown;
  const outcomes = new Map<ReviewStep, PassOutcome>();
  const reviewedFiles = new Map<ReviewStep, number>();
  const deferred: Array<{ step: PersonaId; remaining: number[]; retryAfterMs?: number }> = [];

  // Saves the run's state in order: each report waits for the one before it.
  let saved = Promise.resolve();
  const report = (ended: PassRecord[] = []) => {
    const current = review;
    const list = entries.map(e => ({ ...e }));
    const slow = oneAtATime;
    const head = list.find(e => e.state === 'running' || e.state === 'waiting') ?? list.find(e => e.state === 'queued') ?? list[list.length - 1];
    const done = list.reduce((n, e) => n + e.done, 0);
    const total = list.reduce((n, e) => n + e.total, 0);
    const tokensSoFar = tally.totals;
    saved = saved.then(() => progress({
      update: w => {
        if (!w.active) return w;
        const active: ActivePass = {
          ...w.active, step: head.step, done: head.done, total: head.total, stepsProgress: list, ...(slow ? { oneAtATime: true } : {}), ...(tokensSoFar ? { tokensSoFar } : {}),
        };
        delete active.partial;
        const next: ReviewWorking = { ...w, active };
        if (ended.length > 0) {
          next.review = current;
          next.passes = [...w.passes, ...ended];
          delete active.partialChanges;
        } else if (w.review) {
          active.partialChanges = partialChanges(w.review, current);
        }
        return next;
      },
      done, total,
    })).catch(() => undefined);
  };

  /** The one place that writes the review while the passes run. */
  const fold = (step: ReviewStep) => (b: PersonaBatch): FoldResult | undefined => {
    // A result arriving after Stop or after a refusal stopped the run changes nothing.
    if (runSignal.aborted) return undefined;
    const folded = addFindings(review.store, b.findings);
    const batches = b.contextPaths.length === 0 ? review.snapshot.batches : review.snapshot.batches.map((batch, i) => (i === b.batch
      ? { ...batch, contextPaths: [...batch.contextPaths, ...b.contextPaths.filter(p => !batch.contextPaths.includes(p))] } : batch));
    review = { ...review, snapshot: { ...review.snapshot, batches }, store: folded.store };
    entryOf(step).done++;
    report();
    return {
      added: folded.added, merged: folded.merged,
      unverified: folded.store.findings.filter(f => folded.added.includes(f.id) && f.locationUnverified).length,
    };
  };

  /** The record of a step that ended, with its status in the run's words. */
  const recordOf = (step: ReviewStep, status: PassRecord['status']): PassRecord => ({ ...outcomes.get(step)!, status, modelId, run });

  const endStep = (step: ReviewStep, outcome: PassOutcome) => {
    let status: PassRecord['status'] = outcome.status;
    // Stopped without the developer's Stop: a refusal stopped the run, or another pass failed unexpectedly.
    if (outcome.status === 'stopped' && !signal.aborted && refusedStop) status = 'refused';
    if (outcome.status === 'finished' || outcome.status === 'failed') {
      status = step === 'critic' || (reviewedFiles.get(step) ?? 0) > 0 ? 'finished' : 'failed';
    }
    if (status === 'finished' && step !== 'critic') review = { ...review, store: markStepRun(review.store, step) };
    entryOf(step).state = 'ended';
    report([recordOf(step, status)]);
  };

  const runPersona = async (step: PersonaId, batches?: number[]) => {
    entryOf(step).state = 'running';
    report();
    try {
      const result = await runPersonaPass(review, step, engineSettings, engine, { fold: fold(step), ...(batches ? { batches } : {}) });
      outcomes.set(step, combineOutcomes(outcomes.get(step), result.outcome));
      reviewedFiles.set(step, (reviewedFiles.get(step) ?? 0) + result.reviewedFiles);
      const refused = result.refused;
      if (refused && refused.refusal.kind === 'rate-limited' && !rerunRound && !runSignal.aborted) {
        oneAtATime = true;
        deferred.push({ step, remaining: refused.remaining, ...(refused.refusal.retryAfterMs !== undefined ? { retryAfterMs: refused.refusal.retryAfterMs } : {}) });
        entryOf(step).state = 'waiting';
        report();
        return;
      }
      if (refused && !runSignal.aborted) {
        // Copilot refuses every call for minutes after this: no further batch or pass starts.
        refusedStop = true;
        abort();
      }
      endStep(step, result.outcome);
    } catch (err) {
      unexpected ??= err;
      abort();
    }
  };

  // The persona passes, under the cap.
  const queue = steps.filter((s): s is PersonaId => s !== 'critic');
  const cap = () => (oneAtATime ? 1 : batchCount <= ALL_AT_ONCE_MAX_BATCHES ? queue.length + running.size : TWO_AT_ONCE);
  const running = new Set<Promise<void>>();
  const persona = [...queue];
  while (queue.length > 0 || running.size > 0) {
    while (queue.length > 0 && running.size < Math.max(1, cap()) && !runSignal.aborted) {
      const step = queue.shift()!;
      const pass: Promise<void> = runPersona(step).finally(() => running.delete(pass));
      running.add(pass);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }

  // The rerun round: each paused pass once more from its refused batch, one after another, after the wait.
  if (deferred.length > 0 && !runSignal.aborted) {
    const waitMs = Math.max(...deferred.map(d => d.retryAfterMs ?? RATE_LIMIT_WAIT_MS));
    engine.onDiag?.('info', 'Rate-limited batches run again after a wait', { waitMs, passes: deferred.map(d => d.step) });
    await waitUnlessStopped(sleep, waitMs, runSignal);
    rerunRound = true;
    for (const d of deferred) {
      if (runSignal.aborted) break;
      reranAny = true;
      await runPersona(d.step, d.remaining);
    }
  }
  // A pass still paused when the run ended: stopped by the developer, else refused.
  const leftPaused = deferred.filter(d => entryOf(d.step).state === 'waiting').map(d => recordOf(d.step, signal.aborted ? 'stopped' : 'refused'));
  if (leftPaused.length > 0) {
    for (const r of leftPaused) entryOf(r.step).state = 'ended';
    report(leftPaused);
  }

  // The critic, last, when no stop came and some picked persona pass finished (or none was picked).
  const personaFinished = persona.length === 0 || persona.some(step => outcomes.get(step)?.status === 'finished' && (reviewedFiles.get(step) ?? 0) > 0);
  if (steps.includes('critic') && !runSignal.aborted && personaFinished && unexpected === undefined) {
    entryOf('critic').state = 'running';
    report();
    const criticEngine: EngineDeps = {
      ...engine,
      onProgress: p => {
        if (runSignal.aborted) return;
        if (p.review) review = p.review;
        Object.assign(entryOf('critic'), { done: p.batchesDone, total: p.batchesTotal });
        report();
      },
    };
    try {
      const result = await runCritic(review, worked, engineSettings, criticEngine);
      review = result.review;
      if (result.outcome.status === 'stopped' && !signal.aborted) refusedStop = true;
      outcomes.set('critic', result.outcome);
      endStep('critic', result.outcome);
    } catch (err) {
      unexpected ??= err;
    }
  }
  signal.removeEventListener('abort', abort);
  await saved;
  if (unexpected !== undefined) throw unexpected;

  const final = review;
  const notice = refusedStop ? QUOTA_MESSAGE : reranAny ? RAN_ONE_AT_A_TIME_NOTICE : undefined;
  return {
    update: w => {
      const next: ReviewWorking = { ...w, review: final };
      const left = steps.filter(step => !final.store.stepsRun.includes(step) && !(step === 'critic' && !criticHasWork(final)));
      if (left.length > 0) next.picked = left;
      else delete next.picked;
      delete next.active;
      if (notice) next.notice = notice;
      else delete next.notice;
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
  delete working.bandFolded;
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
      ...next, stage: 'review', startedWith, passes: [emptyRecord(active.step, active, active.run)], threads: {}, drafts: {},
    };
    if (active.partial) result.review = active.partial;
    else delete result.review;
    withoutResultsState(result);
    return result;
  }
  // The running steps' finished batches join the review; the steps that ended before were saved already.
  if (active.partialChanges && next.review) next.review = withPartialChanges(next.review, active.partialChanges);
  else if (active.partial) next.review = active.partial;
  const review = next.review;
  const left = active.steps.filter(s => !review?.store.stepsRun.includes(s));
  if (left.length > 0) next.picked = left;
  // Every step that had started and not ended is recorded as cut off.
  const cut = active.stepsProgress
    ? active.stepsProgress.filter(e => e.state === 'running' || e.state === 'waiting')
      .map(e => emptyRecord(e.step, { ...active, done: e.done, total: e.total }, active.run))
    : [emptyRecord(active.step, active, active.run)];
  return { ...next, passes: [...working.passes, ...cut] };
}
