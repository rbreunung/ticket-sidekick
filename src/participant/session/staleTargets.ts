// Stale-ticket close: target/issue-type options and picks, ticket toggles.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { findReachableStatuses, type WorkflowGraph } from '../../services/WorkflowService';
import { ReviewSessionStale, StaleRuleOption, StaleTargetOption } from './importTypes';
import { TICKET_KEY_TOKEN, isBackOrCancellation, pickByNumberOrName } from './primitives';

/**
 * R2/KTD3: the close-time target pick — matching cleanup rules first (in `.jira-templates.json`
 * order), then every status reachable in the stored workflow graph from the current status of at
 * least one selected ticket, alphabetically. A status a rule also targets is still listed: picking
 * the plain status transitions without the rule's resolution. Empty when no rule matches and no
 * selected ticket can reach anything.
 */
export function buildStaleTargetOptions(
  rules: StaleRuleOption[],
  graph: WorkflowGraph,
  currentStatuses: string[],
): StaleTargetOption[] {
  const statuses = new Set<string>();
  for (const from of new Set(currentStatuses)) {
    for (const s of findReachableStatuses(graph, from)) statuses.add(s);
  }
  return [
    ...rules.map((r): StaleTargetOption => ({ kind: 'rule', ruleName: r.name, targetState: r.targetState, resolution: r.resolution })),
    ...[...statuses].sort((a, b) => a.localeCompare(b)).map((status): StaleTargetOption => ({ kind: 'status', status })),
  ];
}

export function formatStaleTargetOption(option: StaleTargetOption): string {
  return option.kind === 'rule' ? `${option.ruleName} → ${option.targetState}` : option.status;
}

/** Target-pick reply: a number, a plain status name, a rule name or its full label; `back` or a
 * cancellation word goes back to the Stale screen (R5). Offered options are matched first, so a
 * workflow status literally named like a cancel word ("Cancelled", "Stop") stays pickable — see
 * docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md. */
export function parseStaleTargetPick(reply: string, options: StaleTargetOption[]): StaleTargetOption | 'back' | 'invalid' {
  const picked = pickByNumberOrName(reply, options, formatStaleTargetOption)
    ?? options.find(o => o.kind === 'rule' && o.ruleName.toLowerCase() === reply.trim().toLowerCase());
  if (picked) return picked;
  return isBackOrCancellation(reply) ? 'back' : 'invalid';
}

/** R12: which issue type to close now, when the selection spans several. Offered issue types are
 * matched before `back`/cancellation words, as in parseStaleTargetPick. */
export function parseStaleIssueTypePick(reply: string, issueTypes: string[]): string | 'back' | 'invalid' {
  const picked = pickByNumberOrName(reply, issueTypes, (t) => t);
  if (picked) return picked;
  return isBackOrCancellation(reply) ? 'back' : 'invalid';
}

/** Result of {@link parseStaleTicketToggle}: the matched stale-ticket keys plus whatever tokens in
 * the reply weren't stale-ticket keys, rejoined as a string — code-review fix: a reply mixing a
 * stale-ticket-key token with New/Already-ticketed row-id tokens (e.g. `PROJ-123 3 7`) used to have
 * the row-id tokens silently discarded once any stale-key token matched, so an excluded row stayed
 * included and got created. The caller now re-parses `remainder` with `parseReviewInput` instead of
 * returning immediately. */
export interface StaleTicketToggleResult {
  matched: string[];
  remainder: string;
}

/**
 * Recognizes a reply as one or more ticket-key toggles for the Stale section — checked in
 * `handleImportReviewReply` AFTER page-nav (U4) and BEFORE the New/Already-ticketed sections' own
 * row-id toggle parsing (`parseReviewInput`), so a ticket key never collides with either
 * vocabulary. Only matches ELIGIBLE stale tickets (present in `stale.groups`) — an ineligible one
 * (R4: no matching cleanup rule, never offered a toggle) is never toggle-matched even if named,
 * falling through as an unrecognized reply like any other. Returns the matched tickets' own keys
 * (real casing, not the reply's) so `applyStaleTicketToggle` can flip them directly, plus every
 * other token in the reply (untouched, in original order) as `remainder` so a mixed reply's
 * non-stale-key tokens (row-id toggles, `post it`, `cancel`, ...) are never silently dropped;
 * `null` when no token in the reply names an eligible stale ticket at all — the caller then falls
 * through to `parseReviewInput` with the whole original reply.
 */
export function parseStaleTicketToggle(reply: string, stale: ReviewSessionStale): StaleTicketToggleResult | null {
  const tokens = reply.trim().split(/[\s,]+/).filter(Boolean);
  const knownKeys = new Map<string, string>(); // UPPERCASE -> real key
  const closed = new Set((stale.closedKeys ?? []).map(k => k.toUpperCase()));
  for (const g of stale.groups) {
    for (const t of g.tickets) if (!closed.has(t.key.toUpperCase())) knownKeys.set(t.key.toUpperCase(), t.key);
  }
  const matched: string[] = [];
  const remainderTokens: string[] = [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (TICKET_KEY_TOKEN.test(upper) && knownKeys.has(upper)) {
      matched.push(knownKeys.get(upper)!);
    } else {
      remainderTokens.push(token);
    }
  }
  return matched.length > 0 ? { matched, remainder: remainderTokens.join(' ') } : null;
}

/** Flips `included` for every stale ticket (across every group) whose key is in `keys` — pure so
 * it's independently testable, mirroring `applyTicketToggle`'s per-key flip for the cleanup batch. */
export function applyStaleTicketToggle(stale: ReviewSessionStale, keys: string[]): ReviewSessionStale {
  const toggleSet = new Set(keys.map(k => k.toUpperCase()));
  return {
    ...stale,
    groups: stale.groups.map(g => ({
      ...g,
      tickets: g.tickets.map(t => (toggleSet.has(t.key.toUpperCase()) ? { ...t, included: !t.included } : t)),
    })),
  };
}
