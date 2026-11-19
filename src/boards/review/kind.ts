import {
  rewordGoal, runRegularPass, type PassOutcome, type RequirementsChoice, type RequirementsOutcome, type ReviewStep, type StagedReview, type StoredFinding,
} from '../../review/engine';
import { renderCoverageText } from '../../review/requirementsCoverage';
import type { BoardKind, Reduced, RunBegun, RunFinished, RunProgress } from '../../sessions/boardKind';
import type { DerivedPart, Session } from '../../sessions/sessionTypes';
import { findJiraKeyInText } from '../../utils/branchParser';
import { modelLabel, reviewModelState, REVIEW_MODEL_SETTING, type BoardModelInfo } from '../boardModels';
import type { ReviewBoardDeps } from './deps';
import {
  FIRST_STEP_ACTIONS, JIRA_NOT_CONFIGURED_REASON, emptyFirstStep, reduceFirstStep, requirementsChoiceOf, rewordApplied, rewordBlocker,
  rewordReplacesCorrections, sourceOf, startBlocker, ticketKeyOf, type FirstStep, type FirstStepAction, type FirstStepContext, type SourceId,
} from './firstStep';
import { REVIEW_KIND, reviewRecipeOf, type ReviewRecipe } from './recipe';

// The pull request review board. Its recipe is the pull request's address, so asking again for the
// same pull request opens the stored review. Reading the source fetches only the pull request's
// title, author and head commit (plus whether Jira is configured and which models there are); a
// later check marks the board out of date when the head commit moved, and never touches the review.
// Everything the review holds lives in the working state, because only the developer's actions and
// the model runs produce it. Every review stops on the first step and starts on Start. vscode-free.

export interface ReviewModels {
  /** The review model setting as it was read. */
  setting: string;
  state: 'none' | 'unavailable' | 'ready';
  options: Array<{ id: string; label: string }>;
  /** Why the models could not be listed. */
  problem?: string;
}

export interface ReviewDerived {
  pr: { title: string; author: string; headCommit: string };
  jiraConfigured: boolean;
  models: ReviewModels;
}

/** One pass as it ended, with the model it ran on. */
export interface PassRecord extends PassOutcome {
  modelId: string;
}

/** What the regular pass was started with. */
export interface StartedWith {
  modelId: string;
  requirements: RequirementsChoice;
  question: string;
  confidenceThreshold: number;
}

/** A finding's explanation, by finding number. */
export interface Explanation {
  text: string;
}

/** A finding's draft comment, by finding number. */
export interface Draft {
  text: string;
}

export interface ReviewWorking {
  /** The first step, or the review's results. New review goes back to the first step and keeps the stored review until Start replaces it. */
  stage: 'first-step' | 'review';
  firstStep: FirstStep;
  review?: StagedReview;
  startedWith?: StartedWith;
  /** The passes run over the current review, in order. */
  passes: PassRecord[];
  /** How the requirements check of the last regular pass ended. */
  requirements?: RequirementsOutcome;
  explanations: Record<string, Explanation>;
  drafts: Record<string, Draft>;
}

export type ReviewAction = FirstStepAction | { type: 'new-review' } | { type: 'back-to-review' };

export type ReviewRunRequest = { type: 'reword' } | { type: 'start' };

export interface FindingView {
  number: number;
  severity: StoredFinding['severity'];
  location: string;
  title: string;
  /** Low confidence, location unverified, probably a false alarm. */
  markers: string[];
}

export interface FirstStepView {
  sources: Array<{ id: SourceId; label: string; available: boolean; reason?: string }>;
  source: SourceId;
  ticketKey: string;
  goal: string;
  points: string;
  /** The points were reworded from an earlier wording of the goal. */
  pointsFromOtherGoal: boolean;
  rewordError?: string;
  question: string;
  notice?: string;
  canReword: boolean;
  rewordBlocker?: string;
  canStart: boolean;
  startBlocker?: string;
  /** A review is stored: Start replaces it, Back to the review shows it again. */
  storedReview: boolean;
}

export interface ReviewResultsView {
  model: string;
  requirements: string;
  passesRun: string[];
  /** The head commit moved since the review read the pull request. */
  outOfDate?: { reviewed: string; head: string };
  /** How the last pass ended, when it did not go over every batch. */
  status?: string;
  requirementsLine?: string;
  coverage?: string;
  tokens?: string;
  findings: FindingView[];
}

export interface ReviewView {
  pr: { label: string; url: string; title: string; author: string };
  stage: ReviewWorking['stage'];
  model: {
    inUse?: { id: string; label: string; picked: boolean };
    options: Array<{ id: string; label: string }>;
    askReason?: string;
    problem?: string;
  };
  firstStep?: FirstStepView;
  results?: ReviewResultsView;
}

const STEP_LABELS: Record<ReviewStep, string> = {
  regular: 'Regular', security: 'Security', performance: 'Performance', reliability: 'Reliability', maintainability: 'Maintainability', critic: 'Critic',
};
const SEVERITY_ORDER: Record<StoredFinding['severity'], number> = { critical: 0, warning: 1, suggestion: 2 };

function hasWork(working: ReviewWorking): boolean {
  return Object.keys(working.explanations).length > 0 || Object.keys(working.drafts).length > 0;
}

/** The model the runs use: the one picked on the board, else the setting's when it is available. */
function modelIdOf(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): string | undefined {
  const { models } = session.derived.data;
  return session.working.firstStep.modelId ?? (models.state === 'ready' ? models.setting : undefined);
}

function contextOf(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): FirstStepContext {
  const { data } = session.derived;
  const foundKey = session.recipe.prefill?.ticketKey ?? findJiraKeyInText(data.pr.title);
  const modelId = modelIdOf(session);
  return {
    jiraConfigured: data.jiraConfigured,
    ...(foundKey ? { foundKey } : {}),
    ...(modelId ? { modelId } : {}),
    modelIds: data.models.options.map(m => m.id),
  };
}

function shortCommit(hash: string): string {
  return hash.slice(0, 12);
}

function requirementsLabel(choice: RequirementsChoice): string {
  if (choice.kind === 'ticket') return `Jira ticket ${choice.key}`;
  if (choice.kind === 'goal') return 'the stated goal';
  return 'none';
}

function statusLine(pass: PassRecord): string | undefined {
  const name = `The ${STEP_LABELS[pass.step].toLowerCase()} pass`;
  switch (pass.status) {
    case 'stopped':
      return `${name} was stopped: ${pass.batchesDone} of ${pass.batchesTotal} batches finished, and their findings are kept.`;
    case 'failed':
      return `${name} failed${pass.error ? `: ${pass.error}` : '.'}`;
    case 'nothing-to-review':
      return 'The pull request has nothing to review after the exclude patterns.';
    case 'commit-unreadable':
      return `${name} did not run: ${pass.unreadablePath ?? 'a file'} can no longer be read at the reviewed commit.`;
    default:
      return pass.failedBatches > 0 ? `${pass.failedBatches} of ${pass.batchesTotal} batches failed; the findings of the others are shown.` : undefined;
  }
}

function requirementsLine(outcome: RequirementsOutcome | undefined): string | undefined {
  switch (outcome?.status) {
    case 'ticket-unreadable':
      return `The requirements check did not run: the ticket ${outcome.key} could not be read (${outcome.message}).`;
    case 'failed':
      return 'The requirements check failed.';
    case 'stopped':
      return 'The requirements check was stopped.';
    default:
      return undefined;
  }
}

function findingView(f: StoredFinding, threshold: number): FindingView {
  const markers: string[] = [];
  if (f.locationUnverified) markers.push('location unverified');
  else if (f.confidence !== undefined && f.confidence < threshold) markers.push('low confidence');
  if (f.probablyFalseAlarm) markers.push('probably a false alarm');
  return {
    number: f.id,
    severity: f.severity,
    location: f.locationUnverified ? f.file : f.line ? `${f.file}:${f.line}` : f.file,
    title: f.title,
    markers,
  };
}

function resultsView(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, label: (id: string) => string): ReviewResultsView {
  const { working, derived } = session;
  const { review, startedWith } = working;
  const last = working.passes[working.passes.length - 1];
  const threshold = startedWith?.confidenceThreshold ?? 0.7;
  const tokens = working.passes.reduce((sum, p) => ({ input: sum.input + p.tokens.input, output: sum.output + p.tokens.output, calls: sum.calls + p.tokens.calls }), { input: 0, output: 0, calls: 0 });
  const status = last ? statusLine(last) : undefined;
  const line = requirementsLine(working.requirements);
  return {
    model: startedWith ? label(startedWith.modelId) : '',
    requirements: requirementsLabel(review?.requirements ?? startedWith?.requirements ?? { kind: 'none' }),
    passesRun: (review?.store.stepsRun ?? []).map(step => STEP_LABELS[step]),
    ...(review && review.snapshot.reviewedCommit !== derived.data.pr.headCommit
      ? { outOfDate: { reviewed: shortCommit(review.snapshot.reviewedCommit), head: shortCommit(derived.data.pr.headCommit) } } : {}),
    ...(status ? { status } : {}),
    ...(line ? { requirementsLine: line } : {}),
    ...(review?.coverage ? { coverage: renderCoverageText(review.coverage) } : {}),
    ...(tokens.calls > 0 ? { tokens: `${tokens.input.toLocaleString('en-US')} input and ${tokens.output.toLocaleString('en-US')} output tokens in ${tokens.calls} call(s)` } : {}),
    findings: (review?.store.findings ?? [])
      .slice()
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id - b.id)
      .map(f => findingView(f, threshold)),
  };
}

function firstStepView(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): FirstStepView {
  const step = session.working.firstStep;
  const ctx = contextOf(session);
  const reword = rewordBlocker(step, ctx);
  const start = startBlocker(step, ctx);
  return {
    sources: [
      { id: 'ticket', label: 'Jira ticket', available: ctx.jiraConfigured, ...(ctx.jiraConfigured ? {} : { reason: JIRA_NOT_CONFIGURED_REASON }) },
      { id: 'goal', label: 'A goal', available: true },
      { id: 'none', label: 'None', available: true },
    ],
    source: sourceOf(step, ctx),
    ticketKey: ticketKeyOf(step, ctx),
    goal: step.goal,
    points: step.points,
    pointsFromOtherGoal: step.points.trim() !== '' && step.pointsFrom !== undefined && step.pointsFrom !== step.goal,
    ...(step.rewordError ? { rewordError: step.rewordError } : {}),
    question: step.question,
    ...(step.notice ? { notice: step.notice } : {}),
    canReword: !reword,
    ...(reword ? { rewordBlocker: reword } : {}),
    canStart: !start,
    ...(start ? { startBlocker: start } : {}),
    storedReview: session.working.review !== undefined || session.working.passes.length > 0,
  };
}

function modelView(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, label: (id: string) => string): ReviewView['model'] {
  const { models } = session.derived.data;
  const picked = session.working.firstStep.modelId;
  const inUse = modelIdOf(session);
  const view: ReviewView['model'] = { options: models.options };
  if (inUse) view.inUse = { id: inUse, label: label(inUse), picked: picked !== undefined && picked !== models.setting };
  if (!inUse) {
    view.askReason = models.state === 'unavailable'
      ? `The model "${models.setting}" in ${REVIEW_MODEL_SETTING} is not available. Pick the model every review call uses; it is saved to the setting.`
      : `${REVIEW_MODEL_SETTING} is empty. Pick the model every review call uses; it is saved to the setting.`;
  }
  if (models.problem) view.problem = `The language models could not be listed: ${models.problem}`;
  else if (models.options.length === 0) view.problem = 'No language model is available in this VS Code. Sign in to GitHub Copilot to review a pull request.';
  return view;
}

async function readModels(deps: ReviewBoardDeps): Promise<ReviewModels> {
  const setting = deps.modelSettings.reviewModel().trim();
  let listed: BoardModelInfo[];
  try {
    listed = await deps.models.list();
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    deps.onDiag?.('warn', 'Could not list the language models for the review board', { error: problem });
    return { setting, state: setting ? 'unavailable' : 'none', options: [], problem };
  }
  const state = await reviewModelState({ list: async () => listed }, deps.modelSettings);
  return { setting, state: state.state, options: listed.map(m => ({ id: m.id, label: modelLabel(m) })) };
}

function isRunRequest(request: unknown): request is ReviewRunRequest {
  const type = (request as { type?: unknown } | null)?.type;
  return type === 'reword' || type === 'start';
}

function withNotice(notice: string): RunFinished<ReviewWorking> {
  return { update: w => ({ ...w, firstStep: { ...w.firstStep, notice } }) };
}

/** The model handle a run uses, after saving a model picked on the board to the setting. */
async function modelFor(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps) {
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

async function rewordRun(
  session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const step = session.working.firstStep;
  if (rewordReplacesCorrections(step)) {
    const replace = await deps.confirm({
      title: 'Replace your corrected points?',
      detail: 'Reword writes new points from the goal as it is typed now, and your corrections to the points are lost.',
      button: 'Reword',
    });
    if (!replace) return withNotice('Not reworded: your corrected points were kept.');
  }
  const model = await modelFor(session, deps);
  if (!model.handle) return withNotice(model.problem);
  const goal = step.goal;
  const result = await rewordGoal(goal, { model: model.handle, recordTokens: (id, figures) => deps.recordTokens(id, figures), signal, ...(deps.onDiag ? { onDiag: deps.onDiag } : {}) });
  return { update: w => ({ ...w, firstStep: rewordApplied(w.firstStep, goal, result) }) };
}

async function startRun(
  session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working, recipe } = session;
  if (working.review && hasWork(working)) {
    const replace = await deps.confirm({
      title: 'Replace the stored review?',
      detail: `The stored review has ${Object.keys(working.explanations).length} explanation(s) and ${Object.keys(working.drafts).length} draft comment(s). A new review replaces them.`,
      button: 'Replace',
    });
    if (!replace) return withNotice('Not started: the stored review was kept. Back to the review shows it.');
  }
  const model = await modelFor(session, deps);
  if (!model.handle) return withNotice(model.problem);
  const bitbucket = await deps.bitbucket();
  if (!bitbucket.configured) return withNotice(bitbucket.hint);
  const jira = await deps.jira();
  const { confidenceThreshold, ...settings } = await deps.settings();
  const question = working.firstStep.question.trim();
  const requirements = requirementsChoiceOf(working.firstStep, contextOf(session));
  let reported = Promise.resolve();
  const result = await runRegularPass({
    target: { project: recipe.project, repo: recipe.repo, prId: recipe.prId },
    requirements,
    settings: { ...settings, ...(question ? { focus: question } : {}) },
  }, {
    model: model.handle,
    recordTokens: (id, figures) => deps.recordTokens(id, figures),
    client: bitbucket.client,
    ...(jira ? { readTicket: key => jira.readRequirements(key) } : {}),
    signal,
    onProgress: p => {
      if (p.step !== 'regular') return;
      reported = reported.then(() => progress({ done: p.batchesDone, total: p.batchesTotal })).catch(() => undefined);
    },
    ...(deps.onDiag ? { onDiag: deps.onDiag } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  await reported;
  if (result.outcome.status === 'finished') await deps.onReviewCompleted?.();
  const record: PassRecord = { ...result.outcome, modelId: model.handle.id };
  const startedWith: StartedWith = { modelId: model.handle.id, requirements, question, confidenceThreshold };
  return {
    update: w => {
      const next: ReviewWorking = {
        ...w, stage: 'review', firstStep: { ...w.firstStep }, startedWith, passes: [record], requirements: result.requirements, explanations: {}, drafts: {},
      };
      delete next.firstStep.notice;
      if (result.review) next.review = result.review;
      else delete next.review;
      return next;
    },
  };
}

export const reviewKind: BoardKind<ReviewRecipe, ReviewDerived, ReviewWorking, ReviewAction, ReviewView, ReviewBoardDeps> = {
  kind: REVIEW_KIND,
  formatVersion: 1,
  title: recipe => `Review: ${recipe.project}/${recipe.repo}#${recipe.prId}`,
  validate: async input => reviewRecipeOf(input),
  revalidate: async stored => reviewRecipeOf(stored),
  sourceKey: recipe => recipe.url,
  sourceLabel: recipe => recipe.url,
  initialWorking: recipe => ({ stage: 'first-step', firstStep: emptyFirstStep(recipe.prefill), passes: [], explanations: {}, drafts: {} }),

  async read(recipe, deps): Promise<DerivedPart<ReviewDerived>> {
    const bitbucket = await deps.bitbucket();
    if (!bitbucket.configured) throw new Error(bitbucket.hint);
    const pr = await bitbucket.client.getPullRequest(recipe.project, recipe.repo, recipe.prId);
    const jiraConfigured = (await deps.jira()) !== undefined;
    const models = await readModels(deps);
    return {
      readAt: deps.now(),
      fingerprints: { head: pr.fromCommitHash },
      data: { pr: { title: pr.title, author: pr.author.displayName, headCommit: pr.fromCommitHash }, jiraConfigured, models },
    };
  },

  // The fresh reading is shown at once; the review is never touched. Whether it is out of date is
  // worked out from the reviewed commit and the head commit read now.
  reconcile: (session, fresh) => ({ derived: fresh, working: session.working, conflicts: [] }),

  reduce(session, action): Reduced<ReviewWorking> {
    const { working } = session;
    const type = (action as { type?: unknown } | null)?.type;
    if (type === 'new-review') {
      if (working.stage === 'first-step') return { ok: false, reason: 'The board is on the first step already.' };
      return { ok: true, working: { ...working, stage: 'first-step' } };
    }
    if (type === 'back-to-review') {
      if (working.stage === 'review') return { ok: false, reason: 'The review is shown already.' };
      if (!working.review && working.passes.length === 0) return { ok: false, reason: 'There is no stored review.' };
      return { ok: true, working: { ...working, stage: 'review' } };
    }
    if (typeof type === 'string' && FIRST_STEP_ACTIONS.has(type)) {
      if (working.stage !== 'first-step') return { ok: false, reason: 'Press New review to change the first step.' };
      const reduced = reduceFirstStep(working.firstStep, action as FirstStepAction, contextOf(session));
      return reduced.ok ? { ok: true, working: { ...working, firstStep: reduced.working } } : reduced;
    }
    return { ok: false, reason: 'Unknown action.' };
  },

  beginRun(session, request): RunBegun<ReviewWorking> {
    if (!isRunRequest(request)) return { ok: false, reason: 'Unknown run.' };
    if (session.working.stage !== 'first-step') return { ok: false, reason: 'Press New review to start another review.' };
    const ctx = contextOf(session);
    if (request.type === 'reword') {
      const blocker = rewordBlocker(session.working.firstStep, ctx);
      return blocker ? { ok: false, reason: blocker } : { ok: true, size: 'call', what: 'reword', label: 'the goal rewording', total: 1 };
    }
    const blocker = startBlocker(session.working.firstStep, ctx);
    return blocker ? { ok: false, reason: blocker } : { ok: true, size: 'pass', what: 'regular', label: 'the regular pass' };
  },

  async run(session, request, deps, progress, signal) {
    if (!isRunRequest(request)) throw new Error('Unknown run.');
    return request.type === 'reword' ? rewordRun(session, deps, signal) : startRun(session, deps, progress, signal);
  },

  view(session): ReviewView {
    const { recipe, derived, working } = session;
    const options = derived.data.models.options;
    const label = (id: string) => options.find(m => m.id === id)?.label ?? id;
    return {
      pr: { label: `${recipe.project}/${recipe.repo}#${recipe.prId}`, url: recipe.url, title: derived.data.pr.title, author: derived.data.pr.author },
      stage: working.stage,
      model: modelView(session, label),
      ...(working.stage === 'first-step' ? { firstStep: firstStepView(session) } : { results: resultsView(session, label) }),
    };
  },
};
