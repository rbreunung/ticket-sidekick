// Report-import review types (template selection, review rows and session, merge run, stale tickets) and the
// ticketed-row and stale helpers. vscode-free.

import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import { isFinalStatus } from '../utils/finalStatus';
import type { WaltzComponent, WaltzReviewRow } from '../utils/waltzReport';
import type { EmailImportItem, EmailReviewRow } from '../utils/emlParser';
import type { RowChange, TicketInfo } from '../utils/reportImport';
import { findPath, type WorkflowGraph } from '../services/WorkflowService';
import type { DiagLogger } from '../utils/diagTypes';

export interface TransitionSubtask {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  resolution?: string;
  extra?: Record<string, unknown>;
  // Mirrors ReviewRowBase's `included` convention — whether this subtask transitions if
  // the batch runs. Defaults to true at construction; toggled per-row by
  // buildReviewTable()'s Include? column and parseSkipInput()'s cascading toggle.
  included: boolean;
}

export interface TransitionBatchTicket {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  subtasks: TransitionSubtask[];
  extra?: Record<string, unknown>;
  // See TransitionSubtask.included above — same convention, same default/toggle path.
  included: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shared Veracode/Waltz import session types + review-table renderer + toggle-reply parser.
//
// Both importers (Veracode flaws, Waltz OSS components) drive the same session flow: pick a
// template/issue-type → dedup-search already-ticketed items → show a review table the user can
// toggle rows on/off in → create tickets for the included rows. Only the parser, per-row
// label/summary/description building, and config live in each importer's own file
// (veracodeReport.ts/src/imports/veracode.ts vs waltzReport.ts/src/imports/waltz.ts) — everything about the
// session shape and the review screen itself is generic and lives here.
// ---------------------------------------------------------------------------------------------

// Bumped whenever the session shape changes in a way that would make an in-flight (already
// persisted) session render incorrectly if fed straight to the current code. A session written by
// a build that predates this field entirely reads as `undefined`, which isSessionExpired() also
// treats as expired.
export const CURRENT_SESSION_SCHEMA_VERSION = 13;

export interface ImportTemplateSelectionSession<TItem> {
  reportFileName: string;
  /** Waltz ticket merge: where the report was read from, so the review can rebuild itself from it. Absent for email. */
  reportFilePath?: string;
  projectKey: string;
  items: TItem[]; // already filtered by the importer's own config (severity/rating, status/action, etc.)
  // The *raw, unfiltered* parsed items (before the importer's own minSeverity/status-style
  // filter) — needed to build the "is this finding still active" predicate the stale-ticket check
  // requires (reportImportHandler.ts's `continueAfterImportIssueType`). `unknown[]` rather than a
  // second generic parameter: Veracode's raw items (individual pre-fold flaws) are a different
  // shape than `TItem` (folded groups), so the importer's own descriptor.stale.buildActivePredicate
  // casts this back to its real type — see ReportImportDescriptor's own doc comment. Absent/empty
  // for importers with no stale-check concept (email).
  rawItems?: unknown[];
  availableTemplates: Array<{ name: string; issueType: string }>;
  availableIssueTypes: string[];
  schemaVersion: number;
}

// Items are folded groups — one or more flaws sharing a source file + line — not
// individual flaws; VeracodeFlaw[] is one group, so `items` here is really VeracodeFlaw[][].
export type VeracodeTemplateSelectionSession = ImportTemplateSelectionSession<VeracodeFlaw[]>;

export type WaltzTemplateSelectionSession = ImportTemplateSelectionSession<WaltzComponent[]>;

export type EmailTemplateSelectionSession = ImportTemplateSelectionSession<EmailImportItem>;


export interface ReviewRowBase {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  existingTicketKey: string | null;
  // Whether a New row will be created when the user creates the page's tickets. Already-ticketed
  // rows ignore it — they carry a per-row `action` instead.
  included: boolean;
  // Set by buildReviewRows only on an already-ticketed row of an importer with change
  // tracking (Veracode, Waltz) — never on email rows or new rows.
  /** Every ticket carrying one of the row's dedup keys. */
  ticketKeys?: string[];
  /** The tickets other than the target that carry one of the row's dedup keys and have no resolution (closed ones are left out); absent on a row saved before this field existed. */
  openTicketKeys?: string[];
  /** The ticket `update` writes to: the newest open one, or the newest overall when all are resolved. */
  target?: { key: string; status: string | null; resolved: boolean };
  /** What changed since the tickets were made; null = no change. */
  change?: RowChange | null;
  /** The actions this row offers. */
  allowedActions?: TicketedAction[];
  /** The row's current action — the default until the user changes it. */
  action?: TicketedAction;
  /** The action the row was built with, so a choice the user made can be told from the default. */
  defaultAction?: TicketedAction;
  /** What the last `apply` (or shortcut) did to this row; a `done` row is finished for good. */
  result?: TicketedRowResult;
  /**
   * Finding folding: on a New row the user merged, the ids of every original row folded into
   * it, in page order (its own `id` is the first). `allRows` keeps the originals, so unmerging
   * restores them and creating the merged row removes all of them.
   */
  memberIds?: string[];
}

/** Finding folding: how `add … to <KEY>` writes to the target ticket. */
export type AddMode = 'comment' | 'rewrite';

/** The per-row actions on the Already-ticketed screen. */
export type TicketedAction = 'update' | 'follow-up' | 'rewrite' | 're-create' | 'leave';

/** An importer's own words for row actions, by action id (Waltz shows `follow-up` as `new ticket`). */
export type ActionLabels = Partial<Record<TicketedAction, string>>;

/** The word the user sees (and types) for a row action. */
export function actionLabelOf(action: TicketedAction, labels?: ActionLabels): string {
  return labels?.[action] ?? action;
}

/**
 * One already-ticketed row's outcome after an action ran. `update` notes: `baseline` — only
 * the record labels were written; `up-to-date` — the ticket already carried everything, nothing was
 * written; `comment-failed` — labels were written but the comment could not be posted.
 */
export type TicketedRowResult =
  | { status: 'done'; action: 'update'; note?: 'baseline' | 'up-to-date' | 'comment-failed' }
  | { status: 'done'; action: 'follow-up'; key: string; linkMissing?: boolean }
  | { status: 'done'; action: 'rewrite'; note?: 'comment-failed' }
  | { status: 'done'; action: 're-create'; key: string }
  // Ticket merge: the row's ticket was merged into `into` and closed.
  | { status: 'done'; action: 'merge'; into: string }
  | { status: 'failed'; action: TicketedAction; error: string };

const DEFAULT_TICKETED_ACTIONS: readonly TicketedAction[] = ['re-create', 'leave'];

/** A row's offered actions and current action — rows built without change tracking offer re-create / leave. */
export function ticketedRowActions(row: ReviewRowBase): { allowedActions: TicketedAction[]; action: TicketedAction } {
  return { allowedActions: [...(row.allowedActions ?? DEFAULT_TICKETED_ACTIONS)], action: row.action ?? 'leave' };
}

/** The ticket a ticketed row's action targets: its chosen target, else its existing ticket. */
export function ticketedTargetKey(row: ReviewRowBase): string {
  return row.target?.key ?? row.existingTicketKey!;
}

/**
 * Finding folding: targets whose unfinished Already-ticketed rows are only partly on
 * `rewrite`. A rewrite rebuilds a ticket from every row that points to it, so the rows' individual
 * choices would be overridden — it is accepted for all of them or none. Finished rows are outside
 * the set. Pure.
 */
export function findPartialRewrites(rows: ReviewRowBase[]): Array<{ key: string; rewriteIds: string[]; otherIds: string[] }> {
  const byTarget = new Map<string, { rewriteIds: string[]; otherIds: string[] }>();
  for (const row of rows) {
    if (row.existingTicketKey === null || isTicketedRowFinished(row)) continue;
    const key = ticketedTargetKey(row);
    const entry = byTarget.get(key) ?? { rewriteIds: [], otherIds: [] };
    (ticketedRowActions(row).action === 'rewrite' ? entry.rewriteIds : entry.otherIds).push(row.id);
    byTarget.set(key, entry);
  }
  return [...byTarget.entries()]
    .filter(([, e]) => e.rewriteIds.length > 0 && e.otherIds.length > 0)
    .map(([key, e]) => ({ key, ...e }));
}

/** A row whose action already ran successfully — excluded from every later apply, `all` and shortcut. */
export function isTicketedRowFinished(row: ReviewRowBase): boolean {
  return row.result?.status === 'done';
}

/** Which screen of a report-import review is showing. */
export type ImportReviewView = 'overview' | 'new' | 'ticketed' | 'stale';

/** The three result groups an import can produce; also the per-group screen names. */
export type ImportResultGroup = 'new' | 'ticketed' | 'stale';

/** Per-group action outcomes accumulated over one import session. */
export interface ImportOutcomes {
  created: number;
  createFailed: number;
  recreated: number;
  recreateFailed: number;
  updated: number;
  updateFailed: number;
  followedUp: number;
  followUpFailed: number;
  closed: number;
  closeFailed: number;
  // Finding folding: New rows added to an existing ticket (`add … to <KEY>`), and rows whose add failed.
  added: number;
  addFailed: number;
  // Finding folding: tickets rebuilt by `rewrite` on the Already-ticketed screen, and ones that failed.
  rewritten: number;
  rewriteFailed: number;
  // Ticket merge: source tickets closed by a merge, and ones whose merge ended with a failed step.
  merged: number;
  mergeFailed: number;
}

export function emptyImportOutcomes(): ImportOutcomes {
  return {
    created: 0, createFailed: 0, recreated: 0, recreateFailed: 0, updated: 0, updateFailed: 0,
    followedUp: 0, followUpFailed: 0, closed: 0, closeFailed: 0, added: 0, addFailed: 0, rewritten: 0, rewriteFailed: 0, merged: 0, mergeFailed: 0,
  };
}

export interface ReviewSession<TRow> {
  projectKey: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>; // resolved template fields (labels merged in per-row already)
  // Every candidate row the report matched, in source order, unpaged — both "already
  // ticketed" and "new" rows live here (built eagerly from lightweight per-item fields; an
  // importer whose full ticket description is expensive to build, e.g. Veracode's folded-group
  // description, defers that part to creation time instead of pre-building it into this array —
  // see src/imports/veracode.ts's descriptor). The paging source of truth: buildReviewPage() re-derives
  // `rows` from this on every page change, which is what makes a "new" row's toggle page-local
  // — see applyReviewSessionToggle()'s own doc comment.
  allRows: TRow[];
  // Remediation dates: the target tickets' descriptions read for the date comparison, by ticket key (null = read but
  // empty), so a rebuild after `accept component` or `reload report` does not read them all again.
  ticketDescriptions?: Record<string, string | null>;
  // Ticket search: summary and build-time status of every ticket the dedup search matched, by key, for the `search` reply.
  // Absent on a session saved before the field existed (and for email).
  ticketInfo?: TicketInfo;
  // Remediation dates: the dedup keys of every component in the unfiltered report, so a rewrite takes a label
  // off a ticket only for a component that really left the report, not one filtered or accepted away.
  reportKeys?: string[];
  // The currently DISPLAYED page: every "already ticketed" row (always shown in full — never
  // paged) plus the current page's slice of "new" rows (BATCH_LIMIT per page, defaulted to
  // included). createNewRows reads this page's included new rows directly, so confirming
  // creates the included rows of whichever page is visible.
  rows: TRow[];
  // 0-based index into the "new" rows only — see buildReviewPage().
  page: number;
  // Open tickets whose finding(s) have disappeared from this report/reverse search — a third
  // review section, transitioned on confirm via the shared transition logic
  // (`transitionTickets` in cleanup.ts). Absent for importers with no stale-check concept (email, which has no
  // dedup/marker-label concept either — see ReportImportDescriptor's optional `stale` field).
  staleTickets?: ReviewSessionStale;
  // Accepted components: open tickets the stale search left alone, kept so an accept can flag them.
  staleCandidates?: StaleCandidate[];
  // Which page (0-based) of the Stale screen is showing, 20 tickets per page; absent means the first.
  stalePage?: number;
  // Which page (0-based) of the Already-ticketed screen is showing, 20 rows per page; absent means the first.
  ticketedPage?: number;
  // The screen currently shown, the result groups that had rows when the session was built (fixed
  // for the session's life), whether exactly one group had rows (then there is no overview), and
  // the accumulated action outcomes.
  // Optional only so a caller-built session (tests, older call sites) can be normalized by
  // ensureImportViewState(); every session the handler persists carries all four.
  view?: ImportReviewView;
  groups?: ImportResultGroup[];
  singleGroup?: boolean;
  outcomes?: ImportOutcomes;
  // Accepted-CVE list: what the accepted list kept off the New screen — CVEs hidden because
  // they are accepted, and components hidden because their recomputed rating fell below the floor.
  // Stored, not recomputed per render; absent when nothing was hidden or the importer has no list.
  acceptedHidden?: AcceptedHidden;
  // Waltz ticket merge: the report file the review was built from, kept so a refresh or reload can rebuild it.
  reportFilePath?: string;
  // Waltz ticket merge: a merge that is waiting for the user (retry or ignore, a target status, a resolution).
  mergeRun?: MergeRun;
  // Waltz ticket merge: the screens no longer match Jira or the ignore list, and the overview offers a reload.
  outOfDate?: boolean;
  schemaVersion: number;
}

export type MergeStepKind = 'survivor-rewrite' | 'survivor-comment' | 'link' | 'source-rewrite' | 'source-comment' | 'close';

/** One step of a merge. `key` is the ticket the step writes to. A `done` step is never run again; `skipped` was ignored after a failure. */
export interface MergeStep {
  kind: MergeStepKind;
  key: string;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  error?: string;
  /** A short result worth showing in the final report, e.g. that a close left no Duplicate resolution or fell back to Relates. */
  note?: string;
  /** Close mode: the link type this `link` step uses, chosen from whether items moved from its source. */
  linkType?: string;
  /** Close mode: the link type this `link` step wanted before any fallback to the other type. */
  wantedLinkType?: string;
}

/** Close mode: what a source ticket carries that the kept ticket lacks — items the rewrite can move, and items the report no longer lists. */
export interface SourceMove {
  key: string;
  movable: string[];
  /** Items the report no longer lists. */
  unlisted: string[];
  /** Items the report still lists but outside the rows the kept ticket is rebuilt from (filtered by settings, or grouped under another ticket). */
  elsewhere: string[];
}

/**
 * A merge in progress on the review session. Present from the confirmation until the final report; the
 * replies it waits for (`retry`/`ignore`, a target status, a resolution) are read before the screen's own vocabulary.
 */
export interface MergeRun {
  survivor: string;
  sources: string[];
  steps: MergeStep[];
  /** What the run waits for: the user's choice after a failed step, the target status of the close, or its resolution. */
  awaiting?: 'decision' | 'target' | 'resolution';
  /** The close ask: the sources grouped by issue type, the group being asked, the target picked, and the resolutions on offer. */
  closeGroups?: StaleTicketGroup[];
  closeIssueType?: string;
  closeTarget?: StaleTargetOption;
  closeTargetOptions?: StaleTargetOption[];
  resolutionOptions?: string[];
  /** The project's Duplicate resolution (its exact name) when it offers one; the close then sets it without asking. */
  duplicateResolution?: string;
  /** The link type the link steps use: `Duplicate`, or `Relates` when the project has no Duplicate link type. */
  linkType?: string;
  /** Findings the rewritten survivor no longer covers, kept from the rewrite step for its comment. */
  droppedKeys?: string[];
  /** Close mode: per source, the items that move to the kept ticket and the ones the report no longer lists (fixed when the run starts). */
  sourceMoves?: SourceMove[];
  /** Sources the close skipped (no workflow graph, no path) with the reason, for the final report. */
  closeSkipped?: Array<{ key: string; reason: string }>;
}

export interface AcceptedHidden {
  cves: number;
  belowFloor: number;
  /** Components dropped because their exact name + version is accepted as a whole; absent when none. */
  components?: number;
}

/** The counts as stored on the session: undefined when nothing was hidden, `components` only when above zero. */
export function toAcceptedHidden(counts: { cves: number; belowFloor: number; components: number }): AcceptedHidden | undefined {
  if (counts.cves === 0 && counts.belowFloor === 0 && counts.components === 0) return undefined;
  return counts.components > 0 ? { ...counts } : { cves: counts.cves, belowFloor: counts.belowFloor };
}

export type VeracodeReviewSession = ReviewSession<VeracodeReviewRow>;

export type WaltzReviewSession = ReviewSession<WaltzReviewRow>;

export type EmailReviewSession = ReviewSession<EmailReviewRow>;

// ---------------------------------------------------------------------------------------------
// Stale-ticket review section — open tickets whose finding(s) are gone from the current
// report/reverse search (`reportImport.ts`'s `findStaleTickets`), grouped by issue type so each
// group shares one resolution ask rather than one per ticket. `buildStaleTicketGroups` in
// cleanup.ts builds these.
// ---------------------------------------------------------------------------------------------

/** One issue-type group of stale tickets. The target is not fixed here: it is picked when the
 * user closes the group's selected tickets, from the
 * group's matching cleanup rules and the snapshot of its project/issue type's workflow graph, which
 * is also what the transition paths are computed from at close time. Every ticket defaults
 * `included: false` and carries an empty `transitionPath` until then. */
export interface StaleTicketGroup {
  issueType: string;
  rules: StaleRuleOption[];
  graph: WorkflowGraph;
  tickets: TransitionBatchTicket[];
}

/** A stale ticket that can't be offered for a transition at all — its issue type is unknown, or no
 * workflow has been discovered for its project/issue type — shown with a note but never toggleable. */
export interface IneligibleStaleTicket {
  key: string;
  summary: string;
  currentStatus: string;
  note: string;
}

/**
 * An open, marker-labeled ticket the stale search did not flag: kept with
 * what the search captured and the dedup ids still active for it, so accepting components mid-review can
 * move it to Stale without a second search or the raw report.
 */
export interface StaleCandidate {
  key: string;
  summary: string;
  currentStatus: string;
  issueType: string;
  activeIds: string[];
}

export interface ReviewSessionStale {
  groups: StaleTicketGroup[];
  ineligible: IneligibleStaleTicket[];
  // Tickets a "close tickets" run already transitioned — shown as done, no longer toggleable, and
  // never transitioned again. (Named for the original closing-only flow; the target may now be a
  // non-final status.)
  closedKeys?: string[];
  // The Jira instance's resolution names, fetched once when the stale section is built so
  // the close-time resolution question needs no Jira call. Empty when none exist or the fetch
  // failed — the close then never asks.
  resolutionOptions: string[];
}

/** A group's tickets that are selected and not yet transitioned by an earlier close run. */
export function selectedOpenStaleTickets(group: StaleTicketGroup, closedKeys: string[] = []): TransitionBatchTicket[] {
  const done = new Set(closedKeys);
  return group.tickets.filter(t => t.included && !done.has(t.key));
}

/** The issue types that have at least one selected, not-yet-transitioned stale ticket, in
 * group order. */
export function selectedStaleIssueTypes(stale: ReviewSessionStale): string[] {
  return stale.groups.filter(g => selectedOpenStaleTickets(g, stale.closedKeys).length > 0).map(g => g.issueType);
}

export function staleTargetState(option: StaleTargetOption): string {
  return option.kind === 'rule' ? option.targetState : option.status;
}

/** A rule with a resolution never asks; a rule without one, or a plain status, asks
 * only when its target is closed-like — and never when the instance has no resolutions at all. */
export function staleTargetNeedsResolution(option: StaleTargetOption, resolutionOptions: string[]): boolean {
  if (resolutionOptions.length === 0) return false;
  if (option.kind === 'rule' && option.resolution !== undefined) return false;
  return isFinalStatus(staleTargetState(option));
}

/**
 * Turns one group's selected, not-yet-transitioned tickets into runnable transitions
 * toward `targetState`, using paths from the group's stored workflow graph. A ticket already in
 * the target status, or with no path to it, is skipped with a reason instead.
 */
export function planStaleTransitions(
  group: StaleTicketGroup,
  targetState: string,
  closedKeys: string[] = [],
): { runnable: TransitionBatchTicket[]; skipped: Array<{ key: string; reason: string }> } {
  const runnable: TransitionBatchTicket[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  for (const t of selectedOpenStaleTickets(group, closedKeys)) {
    if (t.currentStatus.toLowerCase() === targetState.toLowerCase()) {
      skipped.push({ key: t.key, reason: `already in ${targetState}` });
      continue;
    }
    const path = findPath(group.graph, t.currentStatus, targetState);
    if (!path || path.length === 0) {
      skipped.push({ key: t.key, reason: `no path found from ${t.currentStatus} to ${targetState} in the discovered workflow` });
      continue;
    }
    runnable.push({ ...t, transitionPath: path });
  }
  return { runnable, skipped };
}

/**
 * A stored session written before `schemaVersion` existed (reads back as `undefined`) — or by an
 * older build than this one understands — may be missing fields the current renderer/handler
 * expects. Treating it as expired here (rather than rendering `undefined` cells or running a batch
 * against incomplete data) keeps such a session from rendering. "No session at all" is a different, already-handled
 * case and is deliberately NOT reported as expired by this guard.
 */
export function isSessionExpired(session: { schemaVersion?: number } | null | undefined): boolean {
  if (!session) return false;
  return typeof session.schemaVersion !== 'number' || session.schemaVersion < CURRENT_SESSION_SCHEMA_VERSION;
}


/** A cleanup rule matching a stale group's project + issue type, as offered in the close-time
 * target pick. */
export interface StaleRuleOption {
  name: string;
  targetState: string;
  resolution?: string;
}

/** One entry of the close-time target pick: a matching cleanup rule (its target and resolution
 * apply) or a plain workflow status. */
export type StaleTargetOption =
  | { kind: 'rule'; ruleName: string; targetState: string; resolution?: string }
  | { kind: 'status'; status: string };

/**
 * What an engine call reports back while it runs: log lines through `onDiag`, and progress through `onEvent`, so the chat
 * can stream each step as it happens and the import board can follow the same writes.
 */
export interface ImportHooks<E = never> {
  onDiag?: DiagLogger;
  onEvent?: (event: E) => void;
}
