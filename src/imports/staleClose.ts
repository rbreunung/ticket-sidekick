// The Stale group of a report import: the close-time target options, the ticket toggle, the issue types and targets a
// close can pick, and the transition run itself. vscode-free; logging goes through the injected `onDiag`.
import { findReachableStatuses, type WorkflowGraph } from '../services/WorkflowService';
import type { TicketService } from '../services/TicketService';
import { transitionTickets } from './cleanup';
import type { ReportImportDescriptor } from './descriptor';
import {
  emptyImportOutcomes, planStaleTransitions,
  type ImportHooks, type ReviewRowBase, type ReviewSession, type ReviewSessionStale, type StaleRuleOption, type StaleTargetOption,
} from './types';

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

/** Announced before the transitions of a stale close run: how many tickets move, and where. */
export interface StaleCloseStart {
  issueType: string;
  targetState: string;
  count: number;
}

/** What a stale close run did; `session` carries the closed keys, the deselected skipped tickets and the outcome counts. */
export interface StaleCloseResult<TRow extends ReviewRowBase> {
  session: ReviewSession<TRow>;
  transitioned: string[];
  failed: number;
  skipped: Array<{ key: string; reason: string }>;
  failures: Array<{ key: string; reason: string }>;
}

/**
 * Transitions the chosen issue type's selected, not-yet-transitioned stale tickets to `targetState`
 * through the shared `transitionTickets()`, with paths computed from the group's
 * stored workflow graph. A ticket already there or with no path is skipped with a note and
 * deselected; transitioned tickets are marked so they are never transitioned again. Null when the
 * review has no such group.
 */
export async function runStaleClose<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  issueType: string,
  targetState: string,
  resolution: string | undefined,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  hooks: ImportHooks<StaleCloseStart> = {},
): Promise<StaleCloseResult<TRow> | null> {
  const stale = session.staleTickets;
  const group = stale?.groups.find(g => g.issueType === issueType);
  if (!stale || !group) return null;
  const closed = stale.closedKeys ?? [];
  const { runnable, skipped } = planStaleTransitions(group, targetState, closed);
  hooks.onEvent?.({ issueType, targetState, count: runnable.length });

  const result = runnable.length > 0
    ? await transitionTickets(runnable, ticketService, resolution, hooks.onDiag)
    : { failures: [] as Array<{ key: string; reason: string }> };
  const failedKeys = new Set(result.failures.map(f => f.key));
  const newlyClosed = runnable.filter(t => !failedKeys.has(t.key)).map(t => t.key);
  const failedTickets = runnable.length - newlyClosed.length;
  hooks.onDiag?.(result.failures.length > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} stale-ticket close — ${newlyClosed.length} transitioned to ${targetState}, ${failedTickets} failed, ${skipped.length} skipped`,
    { issueType, targetState, transitioned: newlyClosed.length, failed: failedTickets, skipped: skipped.length },
  );

  const skippedKeys = new Set(skipped.map(s => s.key));
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    session: {
      ...session,
      staleTickets: {
        ...stale,
        groups: stale.groups.map(g => (g !== group ? g : {
          ...g,
          tickets: g.tickets.map(t => (skippedKeys.has(t.key) ? { ...t, included: false } : t)),
        })),
        closedKeys: [...closed, ...newlyClosed],
      },
      outcomes: { ...outcomes, closed: outcomes.closed + newlyClosed.length, closeFailed: outcomes.closeFailed + failedTickets },
    },
    transitioned: newlyClosed,
    failed: failedTickets,
    skipped,
    failures: result.failures,
  };
}
