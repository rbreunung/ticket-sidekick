import type { GoalRewording, RequirementsChoice } from '../../review/engine';
import { TICKET_ID_PATTERN, isLikelyJiraKey } from '../../utils/branchParser';
import type { Reduced } from '../../sessions/boardKind';
import type { ReviewPrefill } from './recipe';

// The review board's first step: the model every call uses, the requirements source (a Jira ticket,
// a goal or none), the goal and its rewording, and an optional upfront question. Every review stops
// here and starts only on Start. Typing a goal makes no model call; only Reword does, and the
// developer corrects the reworded points before Start. vscode-free and pure.

export type SourceId = 'ticket' | 'goal' | 'none';

const MAX_GOAL_CHARS = 4000;
const MAX_POINTS_CHARS = 8000;
const MAX_QUESTION_CHARS = 2000;
const KEY_PATTERN = new RegExp(`^${TICKET_ID_PATTERN.source}$`);

export interface FirstStep {
  /** The model picked on this board; it is saved to the review model setting when a run starts. */
  modelId?: string;
  /** The source the developer picked; until then the preselection holds. */
  source?: SourceId;
  /** The ticket key as the developer typed it; until then the request's key or the PR title's. */
  ticketKey?: string;
  /** The goal as the developer typed it. */
  goal: string;
  /** The reworded goal as the developer corrected it. Start checks against it when it has text, else against the typed goal. */
  points: string;
  /** The typed goal the points were reworded from. */
  pointsFrom?: string;
  /** The developer changed the points after the rewording. */
  pointsEdited: boolean;
  /** Why the last rewording failed; the points and the typed goal stay as they were. */
  rewordError?: string;
  question: string;
  /** Why the last Start or Reword did not go ahead. */
  notice?: string;
}

/** What the first step's rules read besides the step itself. */
export interface FirstStepContext {
  jiraConfigured: boolean;
  /** The key the request named, else the one in the PR title. */
  foundKey?: string;
  /** The model the runs use: the one picked here, else the setting's when it is available. */
  modelId?: string;
  /** The models that can be picked. */
  modelIds: string[];
}

export type FirstStepAction =
  | { type: 'pick-model'; id: string }
  | { type: 'source'; source: SourceId }
  | { type: 'ticket-key'; key: string }
  | { type: 'goal'; text: string }
  | { type: 'points'; text: string }
  | { type: 'question'; text: string };

export const FIRST_STEP_ACTIONS: ReadonlySet<string> = new Set(['pick-model', 'source', 'ticket-key', 'goal', 'points', 'question']);

export const JIRA_NOT_CONFIGURED_REASON = 'Jira is not configured, so no ticket can be read. Set ticketSidekick.jira.baseUrl and the Jira token to check against a ticket.';

export function emptyFirstStep(prefill?: ReviewPrefill): FirstStep {
  return { goal: '', points: '', pointsEdited: false, question: prefill?.question ?? '' };
}

/** The key the ticket source reads: the typed one, else the found one. */
export function ticketKeyOf(step: FirstStep, ctx: FirstStepContext): string {
  return step.ticketKey ?? ctx.foundKey ?? '';
}

/** The source in effect: the developer's pick, else the ticket when Jira is configured and a key was found, else none. */
export function sourceOf(step: FirstStep, ctx: FirstStepContext): SourceId {
  if (step.source) return step.source;
  return ctx.jiraConfigured && ctx.foundKey ? 'ticket' : 'none';
}

/** The text a goal check compares the diff with: the corrected points when there are any, else the typed goal. */
export function goalTextOf(step: FirstStep): string {
  return step.points.trim() || step.goal.trim();
}

/** What keeps Start from running, when something does. */
export function startBlocker(step: FirstStep, ctx: FirstStepContext): string | undefined {
  if (!ctx.modelId) return 'Pick the model first.';
  const source = sourceOf(step, ctx);
  if (source === 'ticket') {
    if (!ctx.jiraConfigured) return JIRA_NOT_CONFIGURED_REASON;
    if (!ticketKeyOf(step, ctx)) return 'Type the ticket key.';
  }
  if (source === 'goal' && !goalTextOf(step)) return 'Type the goal.';
  return undefined;
}

/** What keeps Reword from running, when something does. */
export function rewordBlocker(step: FirstStep, ctx: FirstStepContext): string | undefined {
  if (!ctx.modelId) return 'Pick the model first.';
  if (!step.goal.trim()) return 'Type the goal first.';
  return undefined;
}

/** The requirements choice Start runs with. */
export function requirementsChoiceOf(step: FirstStep, ctx: FirstStepContext): RequirementsChoice {
  const source = sourceOf(step, ctx);
  if (source === 'ticket') return { kind: 'ticket', key: ticketKeyOf(step, ctx) };
  if (source === 'goal') return { kind: 'goal', text: goalTextOf(step) };
  return { kind: 'none' };
}

function textOf(value: unknown, max: number, what: string): string | { reason: string } {
  if (typeof value !== 'string') return { reason: `Invalid ${what}.` };
  if (value.length > max) return { reason: `The ${what} is too long: at most ${max} characters.` };
  return value;
}

/** A first-step action applied to the step; none of them calls a model. */
export function reduceFirstStep(step: FirstStep, action: FirstStepAction, ctx: FirstStepContext): Reduced<FirstStep> {
  const next = { ...step };
  delete next.notice;
  switch (action.type) {
    case 'pick-model':
      if (typeof action.id !== 'string' || !ctx.modelIds.includes(action.id)) return { ok: false, reason: 'That model is not available.' };
      return { ok: true, working: { ...next, modelId: action.id } };
    case 'source':
      if (action.source !== 'ticket' && action.source !== 'goal' && action.source !== 'none') return { ok: false, reason: 'Invalid requirements source.' };
      if (action.source === 'ticket' && !ctx.jiraConfigured) return { ok: false, reason: JIRA_NOT_CONFIGURED_REASON };
      return { ok: true, working: { ...next, source: action.source } };
    case 'ticket-key': {
      if (typeof action.key !== 'string') return { ok: false, reason: 'Invalid ticket key.' };
      const key = action.key.trim().toUpperCase();
      if (key && (!KEY_PATTERN.test(key) || !isLikelyJiraKey(key))) return { ok: false, reason: `"${action.key.trim().slice(0, 40)}" is not a Jira key such as PROJ-123.` };
      return { ok: true, working: { ...next, ticketKey: key } };
    }
    case 'goal': {
      const text = textOf(action.text, MAX_GOAL_CHARS, 'goal');
      if (typeof text !== 'string') return { ok: false, reason: text.reason };
      return { ok: true, working: { ...next, goal: text } };
    }
    case 'points': {
      const text = textOf(action.text, MAX_POINTS_CHARS, 'reworded goal');
      if (typeof text !== 'string') return { ok: false, reason: text.reason };
      if (text === step.points) return { ok: true, working: next };
      return { ok: true, working: { ...next, points: text, pointsEdited: true } };
    }
    case 'question': {
      const text = textOf(action.text, MAX_QUESTION_CHARS, 'question');
      if (typeof text !== 'string') return { ok: false, reason: text.reason };
      return { ok: true, working: { ...next, question: text } };
    }
    default:
      return { ok: false, reason: 'Unknown action.' };
  }
}

/** Whether a rewording would replace points the developer corrected, so it asks first. */
export function rewordReplacesCorrections(step: FirstStep): boolean {
  return step.pointsEdited && step.points.trim() !== '';
}

/** The step after a rewording of `goal`: its points, or the error with everything else kept. A stopped rewording changes nothing. */
export function rewordApplied(step: FirstStep, goal: string, result: GoalRewording): FirstStep {
  if (result.ok) {
    const next: FirstStep = { ...step, points: result.text, pointsFrom: goal, pointsEdited: false };
    delete next.rewordError;
    return next;
  }
  if (result.stopped) return step;
  const used = step.points.trim() ? 'the points below' : 'your words';
  return { ...step, rewordError: `The goal could not be reworded: ${result.error} Start uses ${used} as they stand.` };
}
