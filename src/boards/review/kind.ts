import {
  type FindingStore, type PassOutcome, type PassStatus, type ReviewStep, type StagedReview, type StoredFinding, type TokenTotals,
} from '../../review/engine';
import type { BoardKind, Reduced, RunBegun, RunFinished, RunProgress } from '../../sessions/boardKind';
import type { DerivedPart, Session } from '../../sessions/sessionTypes';
import { SHARE_SEVERITY_ORDER } from '../../review/reviewSessionState';
import { findJiraKeyInText } from '../../utils/branchParser';
import { capitalised } from '../../utils/textCase';
import { modelLabel, reviewModelState, REVIEW_MODEL_SETTING, type BoardModelInfo } from '../boardModels';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ReviewBoardDeps } from './deps';
import { readTicketGuarded } from '../../review/ticketRead';
import {
  FIRST_STEP_ACTIONS, JIRA_NOT_CONFIGURED_REASON, applyTicketRead, choiceOf, emptyFirstStep, readBlocker, reduceFirstStep, resolveBackground,
  startBlocker, ticketEdited, ticketKeyOf, ticketReadNeeded, withoutTicketRead,
  type Background, type BackgroundChoice, type FirstStep, type FirstStepAction, type FirstStepContext, type TicketReadState,
} from './firstStep';
import { REVIEW_KIND, reviewRecipeOf, type ReviewRecipe } from './recipe';
import {
  EXTRA_STEPS, STEP_LABELS, extraPassesRun, interruptedWorking, joinNames, modelIdOf, pickedSteps, regularRun,
  reviewNotes, stepBlocker, stepName,
} from './runs';
import {
  FINDING_ACTIONS, applyPost, beginFindingRun, draftOutdated, findingRun, isFindingRun, planPost, postableNumbers, reduceFindings, selectedNumbers, shortCommit,
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
  step: ReviewStep;
  done: number;
  total: number;
  modelId: string;
  run: number;
  /** For the regular pass: what it was started with, so Run again works after a restart. */
  startedWith?: Omit<StartedWith, 'confidenceThreshold'>;
  /**
   * The review as it stands after the running step's last finished batch, the step not marked as
   * run. It is not shown while the pass runs; a restart that cuts the pass off keeps it. Saved by
   * the regular pass, which has no stored review to build on.
   */
  partial?: StagedReview;
  /**
   * For an extra pass or the critic: what the running step changed in the stored review after its
   * last finished batch, the findings and the batches' context paths when the step added any. A
   * restart that cuts the pass off merges it onto the stored review.
   */
  partialChanges?: { store: FindingStore; contextPaths?: string[][] };
}

/** What the regular pass was started with. */
export interface StartedWith {
  modelId: string;
  /** The ticket box or the own text as Start found it; none when nothing usable was given. */
  background?: Background;
  /** Why the review has no background though a ticket was chosen: unreadable, not read, or an empty box. */
  backgroundReason?: string;
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
  explanations: Record<string, Explanation>;
  drafts: Record<string, Draft>;
  /** The extra passes picked; undefined means the suggestion. */
  picked?: ReviewStep[];
  active?: ActivePass;
  /** Why the last run on the results did nothing, e.g. Run again declined. */
  notice?: string;
  /** The findings selected for posting and copying, by number. */
  selected?: number[];
  /** The last failed Explain or Rewrite of a finding, by finding number; the earlier text stays. */
  failures?: Record<string, { explain?: string; rewrite?: string }>;
  /** Tokens of the explanations and rewrites since the regular pass. */
  callTokens?: TokenTotals;
}

/** A review board's session. */
export type ReviewSession = Session<ReviewRecipe, ReviewDerived, ReviewWorking>;

export type ReviewAction =
  | FirstStepAction
  | { type: 'new-review' }
  | { type: 'back-to-review' }
  | { type: 'pick-pass'; step: ReviewStep; picked: boolean }
  | { type: 'keep-as-is' }
  | FindingAction
  | PostAction;

export type ReviewRunRequest = { type: 'read-ticket' } | { type: 'start' } | { type: 'passes' } | { type: 'again' } | FindingRunRequest;

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
  /** Low confidence, location unverified, probably a false alarm, against goal. */
  markers: string[];
  selected: boolean;
  explanation?: string;
  explainError?: string;
  draft?: DraftView;
}

export interface TicketBoxView {
  text: string;
  state: TicketReadState;
  /** Why the last read failed. */
  reason?: string;
  /** The developer changed the box since it was filled; a new read asks before replacing it. */
  edited: boolean;
  /** The ticket should be read now; the page starts the read. */
  readNeeded: boolean;
}

export interface FirstStepView {
  choices: Array<{ id: BackgroundChoice; label: string; available: boolean; reason?: string }>;
  choice: BackgroundChoice;
  ticketKey: string;
  ticket: TicketBoxView;
  ownText: string;
  notice?: string;
  canStart: boolean;
  startBlocker?: string;
  /** A review is stored: Start replaces it, Back to the review shows it again. */
  storedReview: boolean;
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


function contextOf(session: ReviewSession): FirstStepContext {
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
      if (!extra) return `${name} failed${pass.error ? `: ${pass.error}` : '.'} No batch gave a readable reply, so there are no findings. Run again tries once more.`;
      return `${name} failed${pass.error ? `: ${pass.error}${/[.!?]$/.test(pass.error) ? '' : '.'}` : '.'} No batch could be reviewed, so it added no findings.${offered}`;
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
  if (f.againstGoal) markers.push('against goal');
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

function resultsView(session: ReviewSession, label: (id: string) => string): ReviewResultsView {
  const { working, derived } = session;
  const { review, startedWith } = working;
  const lastRun = working.passes[working.passes.length - 1]?.run;
  const threshold = startedWith?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const statuses = working.passes.filter(p => p.run === lastRun).map(statusLine).filter((line): line is string => line !== undefined);
  const tokens = working.passes.filter(p => p.tokens.calls > 0).map(p => ({ pass: p.step === 'critic' ? 'Critic' : `${STEP_LABELS[p.step]} pass`, text: tokenText(p.tokens) }));
  if (working.callTokens && working.callTokens.calls > 0) tokens.push({ pass: 'Explain and Rewrite', text: tokenText(working.callTokens) });
  const selected = selectedNumbers(working);
  const postCount = postableNumbers(working).length;
  const findingCount = review?.store.findings.length ?? 0;
  return {
    model: startedWith ? label(startedWith.modelId) : '',
    passesRun: (review?.store.stepsRun ?? []).map(step => STEP_LABELS[step]),
    ...(review && review.snapshot.reviewedCommit !== derived.data.pr.headCommit
      ? { outOfDate: { reviewed: shortCommit(review.snapshot.reviewedCommit), head: shortCommit(derived.data.pr.headCommit) } } : {}),
    statuses,
    notes: reviewNotes(working.passes),
    ...(working.notice ? { notice: working.notice } : {}),
    hasReview: review !== undefined,
    ...(review ? { picker: pickerView(working, review) } : {}),
    tokens,
    canRunAgain: startedWith !== undefined,
    findings: (review?.store.findings ?? [])
      .slice()
      .sort((a, b) => SHARE_SEVERITY_ORDER.indexOf(a.severity) - SHARE_SEVERITY_ORDER.indexOf(b.severity) || a.id - b.id)
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
  const name = active.step === 'critic' ? 'Critic' : `${STEP_LABELS[active.step]} pass`;
  return active.total > 0 ? `${name}: ${active.done} of ${active.total} batches` : `${name}: starting`;
}

/** The background as the first step shows it. */
function backgroundFields(session: ReviewSession): Pick<FirstStepView, 'choices' | 'choice' | 'ticketKey' | 'ticket' | 'ownText'> {
  const step = session.working.firstStep;
  const ctx = contextOf(session);
  const { ticket } = step;
  return {
    choices: [
      { id: 'ticket', label: 'Jira ticket', available: ctx.jiraConfigured, ...(ctx.jiraConfigured ? {} : { reason: JIRA_NOT_CONFIGURED_REASON }) },
      { id: 'text', label: 'My own text', available: true },
      { id: 'none', label: 'None', available: true },
    ],
    choice: choiceOf(step, ctx),
    ticketKey: ticketKeyOf(step, ctx),
    ticket: {
      text: ticket.text, state: ticket.state, ...(ticket.reason ? { reason: ticket.reason } : {}),
      edited: ticketEdited(ticket), readNeeded: ticketReadNeeded(step, ctx),
    },
    ownText: step.ownText,
  };
}

function firstStepView(session: ReviewSession): FirstStepView {
  const step = session.working.firstStep;
  const ctx = contextOf(session);
  const start = startBlocker(step, ctx);
  return {
    ...backgroundFields(session),
    ...(step.notice ? { notice: step.notice } : {}),
    canStart: !start,
    ...(start ? { startBlocker: start } : {}),
    storedReview: session.working.review !== undefined || session.working.passes.length > 0,
  };
}

function modelView(session: ReviewSession, label: (id: string) => string): ReviewView['model'] {
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

const RUN_TYPES = new Set(['read-ticket', 'start', 'passes', 'again']);

function isRunRequest(request: unknown): request is ReviewRunRequest {
  const type = (request as { type?: unknown } | null)?.type;
  return typeof type === 'string' && (RUN_TYPES.has(type) || isFindingRun(request));
}

function workCount(working: ReviewWorking): string {
  return `${Object.keys(working.explanations).length} explanation(s) and ${Object.keys(working.drafts).length} draft comment(s)`;
}

/** The ticket read before Start: it fills the box, after asking when the developer edited it. */
function beginReadTicket(session: ReviewSession): RunBegun<ReviewWorking> {
  const { working } = session;
  if (working.stage !== 'first-step') return { ok: false, reason: 'Press New review to change the background.' };
  const ctx = contextOf(session);
  const blocker = readBlocker(working.firstStep, ctx);
  if (blocker) return { ok: false, reason: blocker };
  const key = ticketKeyOf(working.firstStep, ctx);
  const ticket = { ...working.firstStep.ticket, state: 'reading' as const, key };
  delete ticket.reason;
  return {
    ok: true, size: 'call', what: `read-ticket:${key}`, label: `the read of ${key}`, total: 1,
    working: { ...working, firstStep: { ...working.firstStep, ticket } },
  };
}

async function readTicketRun(session: ReviewSession, deps: ReviewBoardDeps): Promise<RunFinished<ReviewWorking>> {
  const { ticket } = session.working.firstStep;
  const key = ticket.key ?? '';
  /** The read was declined: the box keeps the developer's text, with the notice saying why. */
  const kept = (notice: string): RunFinished<ReviewWorking> => ({
    update: w => {
      if (w.firstStep.ticket.key !== key) return w;
      return { ...w, firstStep: { ...w.firstStep, ticket: { ...w.firstStep.ticket, state: 'read' }, notice } };
    },
  });
  if (ticketEdited(ticket)) {
    const replace = await deps.confirm({
      title: `Replace the text in the ticket box with ${key}?`,
      detail: 'You changed the text in the ticket box. Reading the ticket replaces it, and your changes are lost.',
      button: 'Replace',
    });
    // The developer's text stays the ticket background, so it is not read again by itself.
    if (!replace) return kept('Not read: your text in the ticket box was kept.');
  }
  const jira = await deps.jira();
  if (!jira) {
    return { update: w => (w.firstStep.ticket.key === key
      ? { ...w, firstStep: { ...w.firstStep, ticket: { state: 'failed', key, text: '', readText: '', reason: JIRA_NOT_CONFIGURED_REASON } } } : w) };
  }
  const result = await readTicketGuarded(() => jira.readRequirements(key));
  if (!result.ok) deps.onDiag?.('warn', 'Review board: the background ticket could not be read', { key, reason: result.reason });
  return { update: w => ({ ...w, firstStep: applyTicketRead(w.firstStep, key, result) }) };
}

function startRun(
  session: ReviewSession, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working } = session;
  const resolved = resolveBackground(working.firstStep, contextOf(session));
  return regularRun(session, deps, progress, signal, {
    ...(resolved.background ? { background: resolved.background } : {}),
    ...(resolved.reason ? { backgroundReason: resolved.reason } : {}),
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
  session: ReviewSession, deps: ReviewBoardDeps, progress: RunProgress<ReviewWorking>, signal: AbortSignal,
): Promise<RunFinished<ReviewWorking>> {
  const { working } = session;
  const startedWith = working.startedWith!;
  return regularRun(session, deps, progress, signal, {
    ...(startedWith.background ? { background: startedWith.background } : {}),
    ...(startedWith.backgroundReason ? { backgroundReason: startedWith.backgroundReason } : {}),
    confirm: {
      title: 'Run the whole review again?',
      detail: `The review has ${workCount(working)}. Running it again from the regular pass loses them.`,
      button: 'Run again',
      declined: 'Not run again: the review, its explanations and drafts were kept.',
    },
    fromFirstStep: false,
  });
}

function beginResultsRun(session: ReviewSession, request: ReviewRunRequest): RunBegun<ReviewWorking> {
  const { working } = session;
  if (working.stage !== 'review') return { ok: false, reason: 'Back to the review first.' };
  if (request.type === 'again') {
    return working.startedWith
      ? { ok: true, size: 'pass', what: 'regular', label: 'the regular pass' }
      : { ok: false, reason: 'There is no review to run again.' };
  }
  const review = working.review;
  if (!review) return { ok: false, reason: 'There is no review. Run again reviews the pull request.' };
  const steps = pickedSteps(working);
  if (steps.length === 0) return { ok: false, reason: 'Pick at least one pass.' };
  return { ok: true, size: 'pass', what: 'passes', label: joinNames(steps.map(stepName)) };
}

export const reviewKind: BoardKind<ReviewRecipe, ReviewDerived, ReviewWorking, ReviewAction, ReviewView, ReviewBoardDeps> = {
  kind: REVIEW_KIND,
  // 2: the requirements check and the goal rewording were removed, and the first step has one
  // background; a review stored before is rebuilt from its recipe and opens on the first step.
  formatVersion: 2,
  title: recipe => `Review: ${recipe.project}/${recipe.repo}#${recipe.prId}`,
  validate: async input => reviewRecipeOf(input),
  revalidate: async stored => reviewRecipeOf(stored),
  sourceKey: recipe => recipe.url,
  sourceLabel: recipe => recipe.url,
  initialWorking: recipe => ({ stage: 'first-step', firstStep: emptyFirstStep(recipe.prefill), passes: [], explanations: {}, drafts: {} }),

  // The board asked for again with a ticket key or background text: laid over the first step as a
  // new board would take them, the model picked kept. Text preselects the own text and the key stays
  // in the ticket field; a key alone preselects the ticket when Jira is configured. A review that is
  // shown stays as it is; New review goes back to the first step.
  reopen(session, recipe) {
    const { working } = session;
    const prefill = recipe.prefill;
    if (!prefill || working.stage !== 'first-step') return working;
    const before = working.firstStep;
    let step: FirstStep = { ...before };
    if (prefill.ticketKey && prefill.ticketKey !== ticketKeyOf(before, contextOf(session))) {
      const reduced = reduceFirstStep(step, { type: 'ticket-key', key: prefill.ticketKey }, contextOf(session));
      if (reduced.ok) step = reduced.working;
    }
    if (prefill.background) {
      step.ownText = prefill.background;
      step.choice = 'text';
    } else if (prefill.ticketKey && session.derived.data.jiraConfigured) {
      step.choice = 'ticket';
    }
    if (step.ownText === before.ownText && step.ticketKey === before.ticketKey && step.choice === before.choice) return working;
    delete step.notice;
    return { ...working, firstStep: step };
  },

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
      if (working.stage !== 'first-step') return { ok: false, reason: 'Press New review to change the first step.' };
      const reduced = reduceFirstStep(working.firstStep, action as FirstStepAction, contextOf(session));
      return reduced.ok ? { ok: true, working: { ...working, firstStep: reduced.working } } : reduced;
    }
    return { ok: false, reason: 'Unknown action.' };
  },

  beginRun(session, request): RunBegun<ReviewWorking> {
    if (!isRunRequest(request)) return { ok: false, reason: 'Unknown run.' };
    if (isFindingRun(request)) return beginFindingRun(session, request);
    if (request.type === 'passes' || request.type === 'again') return beginResultsRun(session, request);
    if (request.type === 'read-ticket') return beginReadTicket(session);
    if (session.working.stage !== 'first-step') return { ok: false, reason: 'Press New review to start another review.' };
    const blocker = startBlocker(session.working.firstStep, contextOf(session));
    return blocker ? { ok: false, reason: blocker } : { ok: true, size: 'pass', what: 'regular', label: 'the regular pass' };
  },

  async run(session, request, deps, progress, signal) {
    if (!isRunRequest(request)) throw new Error('Unknown run.');
    if (isFindingRun(request)) return findingRun(session, request, deps, signal);
    switch (request.type) {
      case 'read-ticket': return readTicketRun(session, deps);
      case 'start': return startRun(session, deps, progress, signal);
      case 'again': return runAgainRun(session, deps, progress, signal);
      case 'passes': return extraPassesRun(session, pickedSteps(session.working), deps, progress, signal);
    }
  },

  interrupted: working => interruptedWorking({ ...working, firstStep: withoutTicketRead(working.firstStep) }),

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
