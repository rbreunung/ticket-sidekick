import {
  rewordGoal, type PassOutcome, type PassStatus, type RequirementsChoice, type RequirementsOutcome, type ReviewStep, type StagedReview, type StoredFinding,
  type TokenTotals,
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
import {
  EXTRA_STEPS, STEP_LABELS, extraPassesRun, interruptedWorking, joinNames, modelFor, modelIdOf, pickedSteps, recheckRun, regularRun,
  reviewNotes, stepBlocker, stepName,
} from './runs';
import {
  FINDING_ACTIONS, applyPost, beginFindingRun, draftOutdated, findingRun, isFindingRun, planPost, postableNumbers, reduceFindings, selectedNumbers,
  type FindingAction, type FindingRunRequest, type PostAction,
} from './findings';

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

/** One pass as it ended, with the model it ran on and the run it was part of. */
export interface PassRecord extends Omit<PassOutcome, 'status'> {
  /** `interrupted`: a restart cut the pass off. */
  status: PassStatus | 'interrupted';
  modelId: string;
  /** Which run of this review it was part of; the board's banners are about the last run. */
  run: number;
}

/** The pass run going on, saved so a restart finds it cut off. */
export interface ActivePass {
  /** The regular pass (Start, Run again) or the picked extra passes. */
  what: 'regular' | 'passes';
  steps: ReviewStep[];
  /** The step running now and how far it is. */
  step: ReviewStep | 'requirements';
  done: number;
  total: number;
  modelId: string;
  run: number;
  /** For the regular pass: what it was started with, so Run again works after a restart. */
  startedWith?: Omit<StartedWith, 'confidenceThreshold'>;
  /**
   * The review as it stands after the running step's last finished batch, the step not marked as
   * run. It is not shown while the pass runs; a restart that cuts the pass off keeps it.
   */
  partial?: StagedReview;
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
  /** Raised by each new explanation of the finding, so a draft made from an earlier one shows as outdated. */
  revision?: number;
}

/** A finding's draft comment, by finding number. */
export interface Draft {
  text: string;
  /** The explanation revision the draft was made from; 0 or absent: made without one. */
  basedOn?: number;
  /** The text before the last Rewrite, for Undo until the next edit or post. */
  previous?: string;
  posted?: { commentId: number };
  /** Why the last post of this draft failed. */
  postError?: string;
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
  /** The extra passes picked; undefined means the suggestion. */
  picked?: ReviewStep[];
  active?: ActivePass;
  /** Why the last run on the results did nothing, e.g. Run again declined. */
  notice?: string;
  /** Tokens of the requirements re-checks since the regular pass. */
  recheckTokens?: TokenTotals;
  /** The findings selected for posting and copying, by number. */
  selected?: number[];
  /** The last failed Explain or Rewrite of a finding, by finding number; the earlier text stays. */
  failures?: Record<string, { explain?: string; rewrite?: string }>;
  /** Tokens of the explanations and rewrites since the regular pass. */
  callTokens?: TokenTotals;
}

export type ReviewAction =
  | FirstStepAction
  | { type: 'new-review' }
  | { type: 'back-to-review' }
  | { type: 'pick-pass'; step: ReviewStep; picked: boolean }
  | { type: 'keep-as-is' }
  | FindingAction
  | PostAction;

export type ReviewRunRequest = { type: 'reword' } | { type: 'start' } | { type: 'passes' } | { type: 'again' } | { type: 'recheck' } | FindingRunRequest;

export interface DraftView {
  text: string;
  /** The finding's explanation changed since the draft was made: Regenerate rebuilds it. */
  outdated: boolean;
  /** The last Rewrite can be undone. */
  canUndo: boolean;
  /** Posted, e.g. "Posted as comment 300."; the draft can no longer be changed. */
  posted?: string;
  postError?: string;
  rewriteError?: string;
}

export interface FindingView {
  number: number;
  severity: StoredFinding['severity'];
  location: string;
  title: string;
  description: string;
  recommendation: string;
  /** The line with its related lines ("L19 (also L12, L15)"), the provenance, the confidence and the source. */
  facts: string[];
  /** Low confidence, location unverified, probably a false alarm. */
  markers: string[];
  selected: boolean;
  explanation?: string;
  explainError?: string;
  draft?: DraftView;
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
  /** The key the pull request title names, offered when the ticket key in use could not be found. */
  titleKey?: string;
  canStart: boolean;
  startBlocker?: string;
  /** A review is stored: Start replaces it, Back to the review shows it again. */
  storedReview: boolean;
}

/** The requirements source after a review: changed or edited here, then Re-check runs only the requirements check. */
export interface RequirementsFormView {
  sources: FirstStepView['sources'];
  source: SourceId;
  ticketKey: string;
  goal: string;
  points: string;
  pointsFromOtherGoal: boolean;
  rewordError?: string;
  canReword: boolean;
  rewordBlocker?: string;
  /** The key the pull request title names, offered when the ticket key in use could not be found. */
  titleKey?: string;
  /** Why Re-check cannot run now. */
  recheckBlocker?: string;
}

export interface PassChoiceView {
  step: ReviewStep;
  label: string;
  suggested: boolean;
  /** It ran over every batch of this review. */
  run: boolean;
  picked: boolean;
  available: boolean;
  reason?: string;
}

export interface PassPickerView {
  /** What the regular pass suggested, in words. */
  suggestion: string;
  choices: PassChoiceView[];
  canRun: boolean;
  runBlocker?: string;
}

export interface ReviewResultsView {
  model: string;
  requirements: string;
  passesRun: string[];
  /** The head commit moved since the review read the pull request. */
  outOfDate?: { reviewed: string; head: string };
  /** How the passes of the last run ended, for each that did not go over every batch cleanly. */
  statuses: string[];
  /** What the passes did not review and the findings they dropped. */
  notes: string[];
  notice?: string;
  /** There is a review to show; false after a regular pass that found nothing it could read. */
  hasReview: boolean;
  picker?: PassPickerView;
  /** Why the requirements check gave no coverage, in the coverage position. */
  requirementsLine?: string;
  /** The requirements source to re-check with; there when there is a review. */
  requirementsForm?: RequirementsFormView;
  canRecheck: boolean;
  coverage?: string;
  /** Token usage per pass. */
  tokens: Array<{ pass: string; text: string }>;
  canRunAgain: boolean;
  findings: FindingView[];
  /** How many findings are selected for Post and Copy. */
  selectedCount: number;
  /** How many selected drafts Post would post, and why it cannot now. */
  post: { count: number; blocker?: string };
  /** What Copy acts on: the selection, or every finding when nothing is selected. */
  copy: { scope: 'selected' | 'all'; count: number };
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
  /** The pass running now, e.g. "Security pass: 2 of 5 batches". */
  progress?: string;
}

const SEVERITY_ORDER: Record<StoredFinding['severity'], number> = { critical: 0, warning: 1, suggestion: 2 };


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

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusLine(pass: PassRecord): string | undefined {
  const name = capitalised(stepName(pass.step));
  const extra = pass.step !== 'regular';
  const kept = pass.step === 'critic' ? 'its verdicts on them are kept' : 'their findings are kept';
  const offered = extra ? ' It is not marked as run, so you can pick it again.' : '';
  switch (pass.status) {
    case 'stopped':
      return `${name} was stopped: ${pass.batchesDone} of ${pass.batchesTotal} batches finished, and ${kept}.${offered}`;
    case 'interrupted':
      return `${name} was cut off by a restart: ${pass.batchesDone} of ${pass.batchesTotal} batches finished, and ${kept}.${offered}`;
    case 'failed':
      return `${name} failed${pass.error ? `: ${pass.error}` : '.'}${pass.step === 'regular' ? ' No batch gave a readable reply, so there are no findings. Run again tries once more.' : ''}`;
    case 'nothing-to-review':
      return 'The pull request has nothing to review after the exclude patterns.';
    case 'commit-unreadable':
      return `${name} did not run: ${pass.unreadablePath ?? 'a file'} can no longer be read at the reviewed commit (a force-push may have removed it). It is not marked as run, and no finding changed. Run again reviews the pull request at its newest commit.`;
    default:
      return pass.failedBatches > 0
        ? `${pass.failedBatches} of ${pass.batchesTotal} batches of ${stepName(pass.step)} had a part that failed; the findings of the others are shown.`
        : undefined;
  }
}

function requirementsLine(outcome: RequirementsOutcome | undefined, titleKey: string | undefined): string | undefined {
  switch (outcome?.status) {
    case 'ticket-unreadable':
      return `The requirements check did not run: the ticket ${outcome.key} could not be read (${outcome.message}). The findings stand.`
        + (titleKey ? ` The pull request title names ${titleKey} instead.` : '');
    case 'failed':
      return 'The requirements check failed: the model call failed or its reply could not be read. The findings stand.';
    case 'stopped':
      return 'The requirements check was stopped. The findings stand.';
    default:
      return undefined;
  }
}

function draftView(working: ReviewWorking, number: number): DraftView | undefined {
  const draft = working.drafts[String(number)];
  if (!draft) return undefined;
  const rewriteError = working.failures?.[String(number)]?.rewrite;
  return {
    text: draft.text,
    outdated: draftOutdated(working, number),
    canUndo: draft.previous !== undefined,
    ...(draft.posted ? { posted: `Posted as comment ${draft.posted.commentId}.` } : {}),
    ...(draft.postError && !draft.posted ? { postError: `Not posted: ${draft.postError}` } : {}),
    ...(rewriteError ? { rewriteError } : {}),
  };
}

const PROVENANCE_TEXT: Record<NonNullable<StoredFinding['provenance']>, string> = { new: 'new code', existing: 'existing code', removed: 'removed code' };
const SOURCE_ORDER = [...EXTRA_STEPS.filter(step => step !== 'critic'), 'general'];

/** The line with its related lines, the provenance, the confidence and the passes that found it. */
function findingFacts(f: StoredFinding): string[] {
  const facts: string[] = [];
  if (f.line && !f.locationUnverified) facts.push(`L${f.line}${f.relatedLines?.length ? ` (also ${f.relatedLines.map(l => `L${l}`).join(', ')})` : ''}`);
  if (f.provenance) facts.push(PROVENANCE_TEXT[f.provenance]);
  if (typeof f.confidence === 'number') facts.push(`confidence ${f.confidence}`);
  const sources = SOURCE_ORDER.filter(tag => (f.sources ?? ['general']).includes(tag as never));
  if (sources.length > 0) facts.push(`source: ${sources.join(', ')}`);
  return facts;
}

function findingView(f: StoredFinding, threshold: number, working: ReviewWorking, selected: number[]): FindingView {
  const markers: string[] = [];
  if (f.locationUnverified) markers.push('location unverified');
  else if (f.confidence !== undefined && f.confidence < threshold) markers.push('low confidence');
  if (f.probablyFalseAlarm) markers.push('probably a false alarm');
  return {
    number: f.id,
    severity: f.severity,
    location: f.locationUnverified ? f.file : f.line ? `${f.file}:${f.line}` : f.file,
    title: f.title,
    description: f.description ?? '',
    recommendation: f.recommendation ?? '',
    facts: findingFacts(f),
    markers,
    selected: selected.includes(f.id),
    ...(working.explanations[String(f.id)] ? { explanation: working.explanations[String(f.id)].text } : {}),
    ...(working.failures?.[String(f.id)]?.explain ? { explainError: working.failures[String(f.id)].explain } : {}),
    ...(selected.includes(f.id) || working.drafts[String(f.id)] ? { draft: draftView(working, f.id) } : {}),
  };
}

function tokenText(t: TokenTotals): string {
  return `${t.input.toLocaleString('en-US')} input and ${t.output.toLocaleString('en-US')} output tokens in ${t.calls} call(s)${t.estimated ? ' (estimated)' : ''}`;
}

function suggestionText(review: StagedReview): string {
  const s = review.suggestion;
  if (s.kind === 'suggested') return `Suggested: ${joinNames(s.personas.map(stepName))}.`;
  if (s.kind === 'none-suggested') return 'No extra pass is suggested. You can still pick any of them.';
  return 'No batch gave a usable recommendation, so nothing is suggested. You can still pick any pass.';
}

function pickerView(working: ReviewWorking, review: StagedReview): PassPickerView {
  const picked = pickedSteps(working);
  const suggested = review.suggestion.kind === 'suggested' ? review.suggestion.personas : [];
  const choices = EXTRA_STEPS.map((step): PassChoiceView => {
    const reason = stepBlocker(review, step);
    return {
      step, label: capitalised(stepName(step)), suggested: (suggested as ReviewStep[]).includes(step), run: review.store.stepsRun.includes(step),
      picked: picked.includes(step), available: !reason, ...(reason ? { reason } : {}),
    };
  });
  return { suggestion: suggestionText(review), choices, canRun: picked.length > 0, ...(picked.length === 0 ? { runBlocker: 'Pick at least one pass.' } : {}) };
}

function resultsView(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, label: (id: string) => string): ReviewResultsView {
  const { working, derived } = session;
  const { review, startedWith } = working;
  const lastRun = working.passes[working.passes.length - 1]?.run;
  const threshold = startedWith?.confidenceThreshold ?? 0.7;
  const statuses = working.passes.filter(p => p.run === lastRun).map(statusLine).filter((line): line is string => line !== undefined);
  const line = review ? requirementsLine(working.requirements, titleKeyOffer(session, false)) : undefined;
  const recheck = recheckBlocker(session);
  const tokens = working.passes.filter(p => p.tokens.calls > 0).map(p => ({ pass: p.step === 'critic' ? 'Critic' : `${STEP_LABELS[p.step]} pass`, text: tokenText(p.tokens) }));
  if (working.recheckTokens && working.recheckTokens.calls > 0) tokens.push({ pass: 'Requirements re-check', text: tokenText(working.recheckTokens) });
  if (working.callTokens && working.callTokens.calls > 0) tokens.push({ pass: 'Explain and Rewrite', text: tokenText(working.callTokens) });
  const selected = selectedNumbers(working);
  const postCount = postableNumbers(working).length;
  const findingCount = review?.store.findings.length ?? 0;
  return {
    model: startedWith ? label(startedWith.modelId) : '',
    requirements: requirementsLabel(review?.requirements ?? startedWith?.requirements ?? { kind: 'none' }),
    passesRun: (review?.store.stepsRun ?? []).map(step => STEP_LABELS[step]),
    ...(review && review.snapshot.reviewedCommit !== derived.data.pr.headCommit
      ? { outOfDate: { reviewed: shortCommit(review.snapshot.reviewedCommit), head: shortCommit(derived.data.pr.headCommit) } } : {}),
    statuses,
    notes: reviewNotes(working.passes),
    ...(working.notice ? { notice: working.notice } : {}),
    hasReview: review !== undefined,
    ...(review ? { picker: pickerView(working, review) } : {}),
    ...(line ? { requirementsLine: line } : {}),
    ...(review ? { requirementsForm: { ...sourceFields(session), ...(recheck ? { recheckBlocker: recheck } : {}) } } : {}),
    canRecheck: recheck === undefined,
    ...(review?.coverage ? { coverage: renderCoverageText(review.coverage) } : {}),
    tokens,
    canRunAgain: startedWith !== undefined,
    findings: (review?.store.findings ?? [])
      .slice()
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id - b.id)
      .map(f => findingView(f, threshold, working, selected)),
    selectedCount: selected.length,
    post: {
      count: postCount,
      ...(selected.length === 0 ? { blocker: 'Select the findings to post.' } : postCount === 0 ? { blocker: 'The selected comments are posted already.' } : {}),
    },
    copy: selected.length > 0 ? { scope: 'selected', count: selected.length } : { scope: 'all', count: findingCount },
  };
}

function progressText(working: ReviewWorking): string | undefined {
  const { active } = working;
  if (!active) return undefined;
  if (active.step === 'requirements') return 'Requirements check: running';
  const name = active.step === 'critic' ? 'Critic' : `${STEP_LABELS[active.step]} pass`;
  return active.total > 0 ? `${name}: ${active.done} of ${active.total} batches` : `${name}: starting`;
}

/**
 * The key the pull request title names, when the ticket the last check tried could not be found and
 * the title names another. With `current`, only while that ticket's key is still the one in use.
 */
function titleKeyOffer(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, current: boolean): string | undefined {
  const outcome = session.working.requirements;
  if (outcome?.status !== 'ticket-unreadable' || outcome.reason !== 'not-found') return undefined;
  const titleKey = findJiraKeyInText(session.derived.data.pr.title);
  if (!titleKey || titleKey === outcome.key) return undefined;
  if (current) {
    const ctx = contextOf(session);
    const step = session.working.firstStep;
    if (sourceOf(step, ctx) !== 'ticket' || ticketKeyOf(step, ctx) !== outcome.key) return undefined;
  }
  return titleKey;
}

/** The requirements source as the first step and the results show it. */
function sourceFields(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): RequirementsFormView {
  const step = session.working.firstStep;
  const ctx = contextOf(session);
  const reword = rewordBlocker(step, ctx);
  const titleKey = titleKeyOffer(session, true);
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
    canReword: !reword,
    ...(reword ? { rewordBlocker: reword } : {}),
    ...(titleKey ? { titleKey } : {}),
  };
}

/** What keeps Re-check from running with the source as it is set now, when something does. */
function recheckBlocker(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): string | undefined {
  const { review, firstStep } = session.working;
  if (!review) return 'There is no review to check.';
  const ctx = contextOf(session);
  const blocker = startBlocker(firstStep, ctx);
  if (blocker) return blocker;
  if (sourceOf(firstStep, ctx) === 'none' && review.requirements.kind === 'none' && !review.coverage) return 'Pick a ticket or a goal to check against.';
  return undefined;
}

function firstStepView(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>): FirstStepView {
  const step = session.working.firstStep;
  const ctx = contextOf(session);
  const start = startBlocker(step, ctx);
  return {
    ...sourceFields(session),
    question: step.question,
    ...(step.notice ? { notice: step.notice } : {}),
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

/** The first-step actions the results take too: the requirements source, the ticket key, the goal and its points. */
const SOURCE_ACTIONS: ReadonlySet<string> = new Set(['source', 'ticket-key', 'goal', 'points']);

const RUN_TYPES = new Set(['reword', 'start', 'passes', 'again', 'recheck']);

function isRunRequest(request: unknown): request is ReviewRunRequest {
  const type = (request as { type?: unknown } | null)?.type;
  return typeof type === 'string' && (RUN_TYPES.has(type) || isFindingRun(request));
}

async function rewordRun(
  session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const onResults = session.working.stage === 'review';
  const notice = (text: string): RunFinished<ReviewWorking> => ({
    update: w => (onResults ? { ...w, notice: text } : { ...w, firstStep: { ...w.firstStep, notice: text } }),
  });
  const step = session.working.firstStep;
  if (rewordReplacesCorrections(step)) {
    const replace = await deps.confirm({
      title: 'Replace your corrected points?',
      detail: 'Reword writes new points from the goal as it is typed now, and your corrections to the points are lost.',
      button: 'Reword',
    });
    if (!replace) return notice('Not reworded: your corrected points were kept.');
  }
  const model = await modelFor(session, deps);
  if (!('handle' in model)) return notice(model.problem);
  const goal = step.goal;
  const result = await rewordGoal(goal, { model: model.handle, recordTokens: (id, figures) => deps.recordTokens(id, figures), signal, ...(deps.onDiag ? { onDiag: deps.onDiag } : {}) });
  return { update: w => ({ ...w, firstStep: rewordApplied(w.firstStep, goal, result) }) };
}

function workCount(working: ReviewWorking): string {
  return `${Object.keys(working.explanations).length} explanation(s) and ${Object.keys(working.drafts).length} draft comment(s)`;
}

function startRun(
  session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working } = session;
  return regularRun(session, deps, progress, signal, {
    requirements: requirementsChoiceOf(working.firstStep, contextOf(session)),
    question: working.firstStep.question.trim(),
    confirm: {
      title: 'Replace the stored review?',
      detail: `The stored review has ${workCount(working)}. A new review replaces them.`,
      button: 'Replace',
      declined: 'Not started: the stored review was kept. Back to the review shows it.',
    },
    fromFirstStep: true,
  });
}

function runAgainRun(
  session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working } = session;
  const startedWith = working.startedWith!;
  return regularRun(session, deps, progress, signal, {
    requirements: startedWith.requirements,
    question: startedWith.question,
    confirm: {
      title: 'Run the whole review again?',
      detail: `The review has ${workCount(working)}. Running it again from the regular pass loses them.`,
      button: 'Run again',
      declined: 'Not run again: the review, its explanations and drafts were kept.',
    },
    fromFirstStep: false,
  });
}

function beginResultsRun(session: Session<ReviewRecipe, ReviewDerived, ReviewWorking>, request: ReviewRunRequest): RunBegun<ReviewWorking> {
  const { working } = session;
  if (working.stage !== 'review') return { ok: false, reason: 'Back to the review first.' };
  if (request.type === 'again') {
    return working.startedWith
      ? { ok: true, size: 'pass', what: 'regular', label: 'the regular pass' }
      : { ok: false, reason: 'There is no review to run again.' };
  }
  const review = working.review;
  if (!review) return { ok: false, reason: 'There is no review. Run again reviews the pull request.' };
  if (request.type === 'reword') {
    const blocker = rewordBlocker(working.firstStep, contextOf(session));
    return blocker ? { ok: false, reason: blocker } : { ok: true, size: 'call', what: 'reword', label: 'the goal rewording', total: 1 };
  }
  if (request.type === 'recheck') {
    const blocker = recheckBlocker(session);
    return blocker ? { ok: false, reason: blocker } : { ok: true, size: 'call', what: 'recheck', label: 'the requirements re-check', total: 1 };
  }
  const steps = pickedSteps(working);
  if (steps.length === 0) return { ok: false, reason: 'Pick at least one pass.' };
  return { ok: true, size: 'pass', what: 'passes', label: joinNames(steps.map(stepName)) };
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
    if (type === 'pick-pass' || type === 'keep-as-is') {
      if (working.stage !== 'review' || !working.review) return { ok: false, reason: 'There is no review to add a pass to.' };
      if (type === 'keep-as-is') return { ok: true, working: { ...working, picked: [] } };
      const { step, picked } = action as { step?: unknown; picked?: unknown };
      if (!EXTRA_STEPS.includes(step as ReviewStep) || typeof picked !== 'boolean') return { ok: false, reason: 'Unknown pass.' };
      const reason = stepBlocker(working.review, step as ReviewStep);
      if (picked && reason) return { ok: false, reason };
      const current = pickedSteps(working);
      const next = picked ? [...current, step as ReviewStep] : current.filter(s => s !== step);
      return { ok: true, working: { ...working, picked: EXTRA_STEPS.filter(s => next.includes(s)) } };
    }
    if (typeof type === 'string' && FINDING_ACTIONS.has(type)) return reduceFindings(working, action as FindingAction);
    if (typeof type === 'string' && FIRST_STEP_ACTIONS.has(type)) {
      if (working.stage !== 'first-step' && !(SOURCE_ACTIONS.has(type) && working.review)) return { ok: false, reason: 'Press New review to change the first step.' };
      const reduced = reduceFirstStep(working.firstStep, action as FirstStepAction, contextOf(session));
      return reduced.ok ? { ok: true, working: { ...working, firstStep: reduced.working } } : reduced;
    }
    return { ok: false, reason: 'Unknown action.' };
  },

  beginRun(session, request): RunBegun<ReviewWorking> {
    if (!isRunRequest(request)) return { ok: false, reason: 'Unknown run.' };
    if (isFindingRun(request)) return beginFindingRun(session, request);
    if (request.type === 'passes' || request.type === 'again' || request.type === 'recheck' || (request.type === 'reword' && session.working.stage === 'review')) {
      return beginResultsRun(session, request);
    }
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
    if (isFindingRun(request)) return findingRun(session, request, deps, signal);
    switch (request.type) {
      case 'reword': return rewordRun(session, deps, signal);
      case 'start': return startRun(session, deps, progress, signal);
      case 'again': return runAgainRun(session, deps, progress, signal);
      case 'recheck': return recheckRun(session, requirementsChoiceOf(session.working.firstStep, contextOf(session)), deps, signal);
      case 'passes': return extraPassesRun(session, pickedSteps(session.working), deps, progress, signal);
    }
  },

  interrupted: interruptedWorking,

  // Post is the board's one write: the selected drafts as they are, after the native confirmation.
  plan(session, action) {
    if ((action as { type?: unknown } | null)?.type !== 'post') return { ok: false, reason: 'Unknown write.' };
    return planPost(session);
  },

  apply: (session, plan, deps, progress) => applyPost(session, plan, deps, progress),

  view(session): ReviewView {
    const { recipe, derived, working } = session;
    const options = derived.data.models.options;
    const label = (id: string) => options.find(m => m.id === id)?.label ?? id;
    return {
      pr: { label: `${recipe.project}/${recipe.repo}#${recipe.prId}`, url: recipe.url, title: derived.data.pr.title, author: derived.data.pr.author },
      stage: working.stage,
      model: modelView(session, label),
      ...(working.stage === 'first-step' ? { firstStep: firstStepView(session) } : { results: resultsView(session, label) }),
      ...(working.active ? { progress: progressText(working) } : {}),
    };
  },
};
