import { TICKET_ID_PATTERN, isLikelyJiraKey } from '../../utils/branchParser';
import type { Reduced } from '../../sessions/boardKind';
import type { RequirementsSourceResult } from '../../services/TicketService';
import { safeErrorText } from '../../review/ticketRead';
import { formatRequirementsSourceText } from '../../utils/requirementsSource';
import type { ReviewPrefill } from './recipe';

// The review board's first step: the model every call uses and one background for the reviewer, a
// Jira ticket, the developer's own text or none. A chosen ticket is read into an editable box before
// Start; what the developer leaves in the box is what the review is given. Every review stops here
// and starts only on Start, which makes the first model call. vscode-free and pure.

export type BackgroundChoice = 'ticket' | 'text' | 'none';

/** Where the ticket box stands: not read yet, being read, filled from the ticket, or the read failed. */
export type TicketReadState = 'idle' | 'reading' | 'read' | 'failed';

export const MAX_OWN_TEXT_CHARS = 4000;
/** Room for the capped ticket text (summary, description, comments) and some of the developer's own lines. */
export const MAX_TICKET_TEXT_CHARS = 20000;
const KEY_PATTERN = new RegExp(`^${TICKET_ID_PATTERN.source}$`);

export interface TicketBox {
  state: TicketReadState;
  /** The key the box was last read for, or is being read for. */
  key?: string;
  /** The box as the developer sees and edits it. */
  text: string;
  /** What the last read put in the box; the box is edited when its text differs. */
  readText?: string;
  /** Why the last read failed. */
  reason?: string;
}

export interface FirstStep {
  /** The model picked on this board; it is saved to the review model setting when a run starts. */
  modelId?: string;
  /** The background the developer picked; until then the preselection holds. */
  choice?: BackgroundChoice;
  /** The ticket key as the developer typed it; until then the request's key or the PR title's. */
  ticketKey?: string;
  ticket: TicketBox;
  /** The developer's own text. */
  ownText: string;
  /** Why the last Start or ticket read did not go ahead. */
  notice?: string;
}

/** The background a review was started with. */
export type Background = { kind: 'ticket'; key: string; text: string } | { kind: 'text'; text: string };

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
  | { type: 'background'; choice: BackgroundChoice }
  | { type: 'ticket-key'; key: string }
  | { type: 'ticket-text'; text: string }
  | { type: 'own-text'; text: string };

export const FIRST_STEP_ACTIONS: ReadonlySet<string> = new Set(['pick-model', 'background', 'ticket-key', 'ticket-text', 'own-text']);

export const JIRA_NOT_CONFIGURED_REASON = 'Jira is not configured, so no ticket can be read. Set ticketSidekick.jira.baseUrl and the Jira token to use a ticket as the background.';

/**
 * The first step a new board opens with: a request with text preselects the text (its key, if any,
 * stays in the ticket field); otherwise the preselection is worked out from the key and Jira.
 */
export function emptyFirstStep(prefill?: ReviewPrefill): FirstStep {
  const ownText = prefill?.background ?? '';
  return { ...(ownText ? { choice: 'text' as const } : {}), ticket: { state: 'idle', text: '' }, ownText };
}

/** The key the ticket background reads: the typed one, else the found one. */
export function ticketKeyOf(step: FirstStep, ctx: FirstStepContext): string {
  return step.ticketKey ?? ctx.foundKey ?? '';
}

/** The background in effect: the developer's pick, else the ticket when Jira is configured and a key was found, else none. */
export function choiceOf(step: FirstStep, ctx: FirstStepContext): BackgroundChoice {
  if (step.choice) return step.choice === 'ticket' && !ctx.jiraConfigured ? 'none' : step.choice;
  return ctx.jiraConfigured && ctx.foundKey ? 'ticket' : 'none';
}

/** The box was changed by the developer since it was last filled from the ticket. */
export function ticketEdited(ticket: TicketBox): boolean {
  return ticket.text.trim() !== '' && ticket.text !== (ticket.readText ?? '');
}

/** The ticket should be read now: it is the background, there is a key, and the box was not read for it. */
export function ticketReadNeeded(step: FirstStep, ctx: FirstStepContext): boolean {
  return choiceOf(step, ctx) === 'ticket' && ticketKeyOf(step, ctx) !== '' && step.ticket.state === 'idle';
}

/** What keeps a ticket read from starting, when something does. */
export function readBlocker(step: FirstStep, ctx: FirstStepContext): string | undefined {
  if (!ctx.jiraConfigured) return JIRA_NOT_CONFIGURED_REASON;
  if (choiceOf(step, ctx) !== 'ticket') return 'Pick Jira ticket as the background first.';
  if (!ticketKeyOf(step, ctx)) return 'Type the ticket key.';
  return undefined;
}

/** What keeps Start from running, when something does. */
export function startBlocker(step: FirstStep, ctx: FirstStepContext): string | undefined {
  if (!ctx.modelId) return 'Pick the model first.';
  if (choiceOf(step, ctx) === 'ticket' && step.ticket.state === 'reading') return 'Wait for the ticket to be read.';
  return undefined;
}

/**
 * The background Start gives the review: the ticket box as it is left, the own text, or none. A
 * ticket that could not be read, or an empty box, runs with no background, and the reason says why.
 */
export function resolveBackground(step: FirstStep, ctx: FirstStepContext): { background?: Background; reason?: string } {
  const choice = choiceOf(step, ctx);
  if (choice === 'text') {
    const text = step.ownText.trim();
    return text ? { background: { kind: 'text', text } } : {};
  }
  if (choice !== 'ticket') return {};
  const key = ticketKeyOf(step, ctx);
  const { ticket } = step;
  if (ticket.state === 'failed') return { reason: ticket.reason ?? `The ticket ${key} could not be read.` };
  if (ticket.state !== 'read') return { reason: key ? `The ticket ${key} was not read.` : 'No ticket key was given.' };
  const text = ticket.text.trim();
  if (!text) return { reason: 'The ticket box was empty.' };
  return { background: { kind: 'ticket', key: ticket.key ?? key, text } };
}

/** Why a ticket read failed, in words; a server's message is flattened and cut. */
export function readFailureText(key: string, result: Extract<RequirementsSourceResult, { ok: false }>): string {
  switch (result.reason) {
    case 'not-found': return `The ticket ${key} was not found in Jira, or you have no access to it.`;
    case 'auth': return `Jira refused to read ${key}: check the Jira token and your access to the ticket.`;
    default: return `The ticket ${key} could not be read: ${safeErrorText(result.message, 200)}.`;
  }
}

/** The ticket box after a read of `key`; a result for a key no longer in the field is dropped. */
export function applyTicketRead(step: FirstStep, key: string, result: RequirementsSourceResult): FirstStep {
  if (step.ticket.key !== key) return step;
  if (!result.ok) return { ...step, ticket: { state: 'failed', key, text: '', readText: '', reason: readFailureText(key, result) } };
  const text = formatRequirementsSourceText(result.source);
  return { ...step, ticket: { state: 'read', key, text, readText: text } };
}

function textOf(value: unknown, max: number, what: string): string | { reason: string } {
  if (typeof value !== 'string') return { reason: `Invalid ${what}.` };
  if (value.length > max) return { reason: `The ${what} is too long: at most ${max} characters.` };
  return value;
}

/** A first-step action applied to the step; none of them calls a model or reads the ticket. */
export function reduceFirstStep(step: FirstStep, action: FirstStepAction, ctx: FirstStepContext): Reduced<FirstStep> {
  const next = { ...step };
  delete next.notice;
  switch (action.type) {
    case 'pick-model':
      if (typeof action.id !== 'string' || !ctx.modelIds.includes(action.id)) return { ok: false, reason: 'That model is not available.' };
      return { ok: true, working: { ...next, modelId: action.id } };
    case 'background': {
      const { choice } = action;
      if (choice !== 'ticket' && choice !== 'text' && choice !== 'none') return { ok: false, reason: 'Invalid background.' };
      if (choice === 'ticket' && !ctx.jiraConfigured) return { ok: false, reason: JIRA_NOT_CONFIGURED_REASON };
      // Picking the ticket again after a failed read reads it again.
      const ticket = choice === 'ticket' && next.ticket.state === 'failed' ? { ...next.ticket, state: 'idle' as const } : next.ticket;
      return { ok: true, working: { ...next, choice, ticket } };
    }
    case 'ticket-key': {
      if (typeof action.key !== 'string') return { ok: false, reason: 'Invalid ticket key.' };
      const key = action.key.trim().toUpperCase();
      if (key && (!KEY_PATTERN.test(key) || !isLikelyJiraKey(key))) return { ok: false, reason: `"${action.key.trim().slice(0, 40)}" is not a Jira key such as PROJ-123.` };
      if (key === ticketKeyOf(step, ctx)) return { ok: true, working: { ...next, ticketKey: key } };
      // A new key: the box waits for its read, and a read of the old key that is still going is dropped.
      const ticket: TicketBox = { ...next.ticket, state: 'idle' };
      delete ticket.reason;
      if (key) ticket.key = key;
      else delete ticket.key;
      return { ok: true, working: { ...next, ticketKey: key, ticket } };
    }
    case 'ticket-text': {
      if (step.ticket.state === 'reading') return { ok: false, reason: 'Wait for the ticket to be read.' };
      const text = textOf(action.text, MAX_TICKET_TEXT_CHARS, 'ticket text');
      if (typeof text !== 'string') return { ok: false, reason: text.reason };
      return { ok: true, working: { ...next, ticket: { ...next.ticket, text } } };
    }
    case 'own-text': {
      const text = textOf(action.text, MAX_OWN_TEXT_CHARS, 'text');
      if (typeof text !== 'string') return { ok: false, reason: text.reason };
      return { ok: true, working: { ...next, ownText: text } };
    }
    default:
      return { ok: false, reason: 'Unknown action.' };
  }
}

/** The first step of a board whose ticket read a restart cut off: the box waits for a new read. */
export function withoutTicketRead(step: FirstStep): FirstStep {
  return step.ticket.state === 'reading' ? { ...step, ticket: { ...step.ticket, state: 'idle' } } : step;
}
