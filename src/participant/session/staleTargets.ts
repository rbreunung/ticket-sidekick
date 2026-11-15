// Stale-ticket close: target options and ticket toggles.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { ReviewSessionStale } from './importTypes';
import { TICKET_KEY_TOKEN } from './primitives';

export { applyStaleTicketToggle, buildStaleTargetOptions } from '../../imports/staleClose';

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
export function parseStaleTicketToggle(reply: string, stale: ReviewSessionStale): { matched: string[]; remainder: string } | null {
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

