// Guided single-ticket and multi-ticket transition flows ("Transition it" / "Transition these…" chips).
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { JiraTransition } from '../../jira/IJiraClient';
import { formatKeyLink } from '../../services/TicketService';
import { type CachedTransition, type WorkflowGraph } from '../../services/WorkflowService';
import { isCancellation, pickByNumberOrName } from './primitives';

// ---------------------------------------------------------------------------------------------
// R2/F1: guided single-ticket transition flow ("Transition it" chip). Unlike bulk transition
// (TransitionBatchSession/findPath — untouched by this unit), this flow can ask for a target
// status, a required resolution (read from that *specific* transition's own `fields.resolution`
// per U1 — never the global getResolutions() list), and — when no direct transition exists — a
// choice among the discovered multi-hop paths (findAllPaths, KTD2) before ever writing anything.
// One workspaceState key, one session object, `step` says which choice point is currently live —
// mirrors CreationSession's single-object-through-multiple-turns shape rather than the
// one-key-per-step split used by ResolutionSelectionSession/FilterSelectionSession, since every
// step here shares the same accumulating context (ticket, current status, project/issue type).
// ---------------------------------------------------------------------------------------------

export interface GuidedTransitionSession {
  ticketKey: string;
  currentStatus: string;
  projectKey: string;
  issueType: string;
  // The ticket's own currently-available transitions (from a single getTransitions call, carrying
  // `fields.resolution` per U1) — reused both to check whether a picked target has a direct
  // transition and to build the initial status-pick list below.
  directTransitions: JiraTransition[];
  // Every status offered at the status-pick step: direct transition targets plus (when a cached
  // workflow graph exists) every other status reachable in that graph (AE1's 2-hop target must be
  // pickable, not just directly-adjacent ones) — see buildGuidedTransitionStatusOptions().
  statusOptions: string[];
  step: 'pick-status' | 'pick-resolution' | 'pick-path' | 'confirm';
  targetStatus?: string;
  // Populated only when no direct transition to targetStatus exists — the enumerated, shortest-
  // first, capped candidate routes (KTD2) shown at the pick-path step.
  pathOptions?: CachedTransition[][];
  // The finalized route to apply on confirm: a single direct hop, or the multi-hop path the user
  // picked from pathOptions.
  chosenPath?: CachedTransition[];
  // This transition's own valid resolution names (direct transition's `fields.resolution
  // .allowedValues`, or the path's final hop's live equivalent — see resolveFinalHopResolution in
  // JiraParticipant.ts) — populated only when a resolution is actually required.
  resolutionOptions?: string[];
  resolution?: string;
}

/**
 * R2/AE1: builds the guided transition flow's status-pick option list — every direct transition
 * target (in their own order) plus, when a cached workflow graph exists for this project/issue
 * type, every other status appearing anywhere in that graph (as a "from" key or a "to" target),
 * sorted alphabetically and appended after the direct ones. This is what lets a target reachable
 * only via 2+ hops (AE1) be offered as a pick at all — the direct-transitions list alone can never
 * include it. `currentStatus` is always excluded (moving to where the ticket already is isn't a
 * choice this flow offers — that's the existing "already there" short-circuit, kept unchanged).
 */
export function buildGuidedTransitionStatusOptions(
  directTransitions: Array<{ to: { name: string } }>,
  graph: WorkflowGraph | undefined,
  currentStatus: string,
): string[] {
  const seen = new Set<string>([currentStatus]);
  const options: string[] = [];
  for (const t of directTransitions) {
    if (!seen.has(t.to.name)) {
      seen.add(t.to.name);
      options.push(t.to.name);
    }
  }
  if (graph) {
    const graphStatuses = new Set<string>();
    for (const [from, edges] of Object.entries(graph)) {
      graphStatuses.add(from);
      for (const e of edges) graphStatuses.add(e.to);
    }
    for (const s of [...graphStatuses].sort((a, b) => a.localeCompare(b))) {
      if (!seen.has(s)) {
        seen.add(s);
        options.push(s);
      }
    }
  }
  return options;
}

/** KTD6: an unmatched reply at the status-pick step is reported as 'invalid' so the caller re-shows
 * this step's options with a "didn't understand that" message rather than erroring or dropping the
 * turn — same convention as parseFilterSelection/parseResolutionSelection. */
export function parseGuidedTransitionStatusPick(reply: string, statusOptions: string[]): string | 'cancel' | 'invalid' {
  // Offered statuses win over cancel words, so a status named "Cancelled" stays pickable — see
  // docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md.
  const picked = pickByNumberOrName(reply, statusOptions, (s) => s);
  if (picked) return picked;
  return isCancellation(reply) ? 'cancel' : 'invalid';
}

/** Finds the ticket's own direct (single-hop) transition to `targetStatus`, if one exists —
 * case-insensitive on the target name, matching resolveAndApplyTransition's own direct-transition
 * lookup. */
export function findGuidedDirectTransition(transitions: JiraTransition[], targetStatus: string): JiraTransition | undefined {
  return transitions.find((t) => t.to.name.toLowerCase() === targetStatus.toLowerCase());
}

/** KTD6: unmatched path-pick reply → 'invalid' (re-show with "didn't understand"), matching the
 * same convention used at every other guided-transition choice point. */
export function parseGuidedTransitionPathPick(reply: string, pathCount: number): number | 'cancel' | 'invalid' {
  if (isCancellation(reply)) return 'cancel';
  const options = Array.from({ length: pathCount }, (_, i) => i + 1);
  return pickByNumberOrName(reply, options, String) ?? 'invalid';
}

/** KTD5: one path's clickable-option label, e.g. "In Progress → In Review → Done (2 hops)" —
 * `currentStatus` is prepended since a CachedTransition path only stores each hop's *destination*
 * (`to`), not where it started. */
export function formatTransitionPathOption(currentStatus: string, path: CachedTransition[]): string {
  const hops = path.length;
  const statuses = [currentStatus, ...path.map((p) => p.to)];
  return `${statuses.join(' → ')} (${hops} hop${hops === 1 ? '' : 's'})`;
}

/** KTD6: unmatched resolution-pick reply → 'invalid'. Unlike parseResolutionSelection (bulk
 * transition's global resolution ask, where "none"/"skip" opts out), this ask is only ever shown
 * when the transition's own metadata says a resolution is *required* — so there is no "skip"
 * option here; an unrecognized reply (including "none") is simply unmatched. */
export function parseGuidedTransitionResolutionPick(reply: string, options: string[]): string | 'cancel' | 'invalid' {
  // Offered resolutions win over cancel words, as in parseGuidedTransitionStatusPick.
  const picked = pickByNumberOrName(reply, options, (s) => s);
  if (picked) return picked;
  return isCancellation(reply) ? 'cancel' : 'invalid';
}

/** R2 step 4's confirm-step summary: resolved status, resolution (if any), and path (only when
 * more than one hop — a direct transition's "path" is just the target itself and isn't worth
 * repeating). */
export function buildGuidedTransitionConfirmSummary(
  ticketKey: string,
  targetStatus: string,
  resolution: string | undefined,
  path: CachedTransition[],
  currentStatus: string,
): string {
  const lines = [`Move **${ticketKey}** from **${currentStatus}** to **${targetStatus}**?`];
  if (path.length > 1) {
    lines.push(`Path: ${formatTransitionPathOption(currentStatus, path)}`);
  }
  if (resolution) {
    lines.push(`Resolution: **${resolution}**`);
  }
  return lines.join('\n\n');
}

/** Shared wording for a multi-hop transition that landed partway before a later hop failed —
 * used by both the guided single-ticket flow's confirm step and `resolveAndApplyTransition`'s
 * own `partialFailure` case, which previously each hand-wrote the identical message. */
export function formatPartialTransitionFailure(
  ticketKey: string,
  landedStatus: string,
  completedHops: number,
  totalHops: number,
  targetStatus: string,
  errorMessage: string,
): string {
  return `⚠️ **${ticketKey}** moved partway to **${landedStatus}** (${completedHops} of ${totalHops} hops) ` +
    `but the next step to **${targetStatus}** failed: ${errorMessage} The ticket is now in **${landedStatus}**, ` +
    `not its original status — check its current state before retrying.`;
}

// ---------------------------------------------------------------------------------------------
// U6/R9: "Transition these…" chip — a multi-ticket guided transition offered on a search/filter
// result where every ticket shares the same project AND issue type. Unlike GuidedTransitionSession
// above (one ticket, its own current status, its own transition metadata), this flow's status
// options are the INTERSECTION of every qualifying ticket's own direct transition targets — every
// choice offered is guaranteed to apply to the whole result, per the plan's deliberate
// intersection-over-union decision. Once a status is picked, this flow hands off entirely to the
// *existing* resolution-selection / transition-review sessions (the same ones bulkTransition's own
// known-target-status path already uses via buildAndStreamTransitionBatch in JiraParticipant.ts)
// rather than re-implementing its own resolution-pick and confirm steps — that shared helper's
// review screen already lists every affected ticket + its current status (R9's confirm-step
// requirement) and already tolerates tickets at different current statuses. There is likewise no
// 'pick-path' step: every status in `statusOptions` is by construction a direct transition target
// for every ticket, so there is never a multi-hop route to choose among.
// ---------------------------------------------------------------------------------------------

export interface MultiTicketTransitionSession {
  tickets: { key: string; currentStatus: string }[];
  issueType: string;
  step: 'pick-status';
  statusOptions: string[];
}

/**
 * U6/R9: the multi-ticket transition chip's status intersection — every status name that is a
 * *direct* transition target for every ticket in the result. `perTicketTransitionNames[i]` is one
 * ticket's own list of direct-transition target names (`transitions.map(t => t.to.name)`, fetched
 * live by the caller). Order follows the first ticket's own transition order (arbitrary but
 * stable); each ticket's own list is de-duplicated by name first so a ticket with two transitions
 * to the same status name can't inflate the result. An empty input, or any ticket with an empty
 * transition list, yields an empty result — there is nothing in common to offer.
 */
export function computeCommonTransitionStatuses(perTicketTransitionNames: string[][]): string[] {
  if (perTicketTransitionNames.length === 0) return [];
  const [first, ...rest] = perTicketTransitionNames;
  const restSets = rest.map((names) => new Set(names));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of first) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (restSets.every((s) => s.has(name))) result.push(name);
  }
  return result;
}

/** R9's confirm-step guarantee, applied here too: every affected ticket key + its current status,
 * listed explicitly before the target status is even asked about — since the status list on offer
 * came from an intersection the user hasn't seen ticket-by-ticket yet. */
export function buildMultiTicketTransitionStatusPickIntro(tickets: { key: string; currentStatus: string }[], baseUrl?: string): string {
  return tickets.map((t) => `${formatKeyLink(t.key, baseUrl)} (${t.currentStatus})`).join(', ');
}
