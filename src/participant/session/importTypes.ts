// Report-import session types (template selection, await-issue-type, review, stale) and ticketed-row/stale helpers.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { VeracodeFlaw, VeracodeReviewRow } from '../../utils/veracodeReport';
import type { WaltzComponent, WaltzReviewRow } from '../../utils/waltzReport';
import type { EmailImportItem, EmailReviewRow } from '../../utils/emlParser';
import type { RowChange } from '../../utils/reportImport';
import { findPath, type WorkflowGraph } from '../../services/WorkflowService';
import { TransitionBatchTicket } from './sessionTypes';

// ---------------------------------------------------------------------------------------------
// Shared Veracode/Waltz import session types + review-table renderer + toggle-reply parser.
//
// Both importers (Veracode flaws, Waltz OSS components) drive the same session flow: pick a
// template/issue-type → dedup-search already-ticketed items → show a review table the user can
// toggle rows on/off in → create tickets for the included rows. Only the parser, per-row
// label/summary/description building, and config live in each importer's own file
// (veracodeReport.ts/veracodeHandler.ts vs waltzReport.ts/waltzHandler.ts) — everything about the
// session shape and the review screen itself is generic and lives here (R1/R10).
// ---------------------------------------------------------------------------------------------

// Bumped whenever the session shape changes in a way that would make an in-flight (already
// persisted) session render incorrectly if fed straight to the current code. A session written by
// a build that predates this field entirely reads as `undefined`, which isSessionExpired() also
// treats as expired — see AE7.
// U4: bumped 2 -> 3 for the pageable-review-session shape change (ReviewSession<TRow> gained
// `allRows`/`page`, dropped `totalNewMatched`) — an in-flight pre-upgrade ReviewSession would
// otherwise render with `allRows`/`page` both `undefined`, not a graceful "please re-run" message.
// U6: bumped 3 -> 4 for the stale-ticket review section (ReviewSession<TRow> gained `staleTickets`)
// — same rationale, an in-flight pre-upgrade session must not render a stale section from
// `undefined`.
// U3: bumped 4 -> 5 for the "update existing tickets" bulk action (ReviewRowBase gained the
// optional `updatedExisting` per-row indicator) — same rationale as U6's bump.
// Stale-ticket target pick: bumped 6 -> 7 — StaleTicketGroup no longer carries a build-time
// target/resolution (it carries the matching rules and a workflow-graph snapshot instead), and the
// stale-resolution ask became the stepped StaleCloseSession. Same rationale as the earlier bumps.
// Import ticket updates parity (KTD8): bumped 7 -> 8 — already-ticketed rows now carry a per-row
// `action`/`allowedActions`/`change`/`target`/`result` instead of the re-create toggle and the
// `updatedExisting`/`hasUnsyncedFindings`/`recreatedKey` flags.
// Finding folding (KTD12): bumped 8 -> 9 — report-import rows can carry `memberIds` (a merged row) and
// Waltz rows hold `sourceGroup` (a component array) instead of `sourceComponent`.
// Accepted-CVE list (KTD5): bumped 9 -> 10 — ReviewSession gained `acceptedHidden`, the counts of what
// the list hid from the New screen.
export const CURRENT_SESSION_SCHEMA_VERSION = 10;

export interface ImportTemplateSelectionSession<TItem> {
  reportFileName: string;
  projectKey: string;
  items: TItem[]; // already filtered by the importer's own config (severity/rating, status/action, etc.)
  // U6: the *raw, unfiltered* parsed items (before the importer's own minSeverity/status-style
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

// U2: items are folded groups (R9) — one or more flaws sharing a source file + line — not
// individual flaws; VeracodeFlaw[] is one group, so `items` here is really VeracodeFlaw[][].
export type VeracodeTemplateSelectionSession = ImportTemplateSelectionSession<VeracodeFlaw[]>;

export type WaltzTemplateSelectionSession = ImportTemplateSelectionSession<WaltzComponent[]>;

export type EmailTemplateSelectionSession = ImportTemplateSelectionSession<EmailImportItem>;

// ---------------------------------------------------------------------------------------------
// Shared issue-type chat-ask (R6/KTD4) — every flow that resolves an issue type before creating a
// ticket (create; Veracode/Waltz/email report/batch import) detours through this one session type
// instead of each having its own `showInputBox`. `resume` carries the *identity* of what the user
// already picked before the detour (a project/summary, a picked template name, the rest of the
// originating session), not a pre-resolved object — each family's own continuation function
// (`continueAfterIssueType`, report import's `continueAfterImportIssueType`, reused unmodified for
// email) re-derives whatever it needs (e.g. re-looking up a template by name) once the type is
// known, exactly as it does today. See docs/jira-flows.md for the session-type table.
// ---------------------------------------------------------------------------------------------

export type AwaitIssueTypeResume =
  | {
      kind: 'create';
      projectKey: string;
      summary: string | null;
      description: string | null;
      extraFields?: Record<string, unknown>;
      pickedTemplateName: string | null;
    }
  | {
      // R1/KTD1: batch email import is a third ReportImportDescriptor kind ('email'), reusing this
      // same resume path instead of the retired standalone 'email' AwaitIssueTypeResume kind — it
      // resumes into an EmailTemplateSelectionSession exactly as 'veracode'/'waltz' already do.
      kind: 'reportImport';
      descriptorKind: 'veracode' | 'waltz' | 'email';
      pickedTemplateName: string | null;
      session: VeracodeTemplateSelectionSession | WaltzTemplateSelectionSession | EmailTemplateSelectionSession;
    };

export interface AwaitIssueTypeSession {
  resume: AwaitIssueTypeResume;
  schemaVersion: number;
}

export interface ReviewRowBase {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  existingTicketKey: string | null;
  // Whether a New row will be created when the user creates the page's tickets. Already-ticketed
  // rows ignore it — they carry a per-row `action` instead (U4).
  included: boolean;
  // U3/KTD1/KTD2: set by buildReviewRows only on an already-ticketed row of an importer with change
  // tracking (Veracode, Waltz) — never on email rows or new rows.
  /** Every ticket carrying one of the row's dedup keys. */
  ticketKeys?: string[];
  /** The ticket `update` writes to: the newest open one, or the newest overall when all are resolved. */
  target?: { key: string; status: string | null; resolved: boolean };
  /** What changed since the tickets were made; null = no change. */
  change?: RowChange | null;
  /** The actions this row offers (R6). */
  allowedActions?: TicketedAction[];
  /** The row's current action — the R7 default until the user changes it. */
  action?: TicketedAction;
  /** U4/R16: what the last `apply` (or shortcut) did to this row; a `done` row is finished for good. */
  result?: TicketedRowResult;
  /**
   * Finding folding (KTD3): on a New row the user merged, the ids of every original row folded into
   * it, in page order (its own `id` is the first). `allRows` keeps the originals, so unmerging
   * restores them and creating the merged row removes all of them.
   */
  memberIds?: string[];
}

/** Finding folding: how `add … to <KEY>` writes to the target ticket. */
export type AddMode = 'comment' | 'rewrite';

/** U3/R6: the per-row actions on the Already-ticketed screen. */
export type TicketedAction = 'update' | 'follow-up' | 'rewrite' | 're-create' | 'leave';

/**
 * U4/R16: one already-ticketed row's outcome after an action ran. `update` notes: `baseline` — only
 * the record labels were written; `up-to-date` — the ticket already carried everything, nothing was
 * written; `comment-failed` — labels were written but the comment could not be posted.
 */
export type TicketedRowResult =
  | { status: 'done'; action: 'update'; note?: 'baseline' | 'up-to-date' | 'comment-failed' }
  | { status: 'done'; action: 'follow-up'; key: string; linkMissing?: boolean }
  | { status: 'done'; action: 'rewrite'; note?: 'comment-failed' }
  | { status: 'done'; action: 're-create'; key: string }
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
 * Finding folding (KTD11): targets whose unfinished Already-ticketed rows are only partly on
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

/** Which screen of a report-import review is showing (overview-hub KTD1). */
export type ImportReviewView = 'overview' | 'new' | 'ticketed' | 'stale';

/** The three result groups an import can produce; also the per-group screen names. */
export type ImportResultGroup = 'new' | 'ticketed' | 'stale';

/** Per-group action outcomes accumulated over one import session (R2, R3). */
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
}

export function emptyImportOutcomes(): ImportOutcomes {
  return {
    created: 0, createFailed: 0, recreated: 0, recreateFailed: 0, updated: 0, updateFailed: 0,
    followedUp: 0, followUpFailed: 0, closed: 0, closeFailed: 0, added: 0, addFailed: 0, rewritten: 0, rewriteFailed: 0,
  };
}

export interface ReviewSession<TRow> {
  projectKey: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>; // resolved template fields (labels merged in per-row already)
  // U4/R6: every candidate row the report matched, in source order, unpaged — both "already
  // ticketed" and "new" rows live here (built eagerly from lightweight per-item fields; an
  // importer whose full ticket description is expensive to build, e.g. Veracode's folded-group
  // description, defers that part to creation time instead of pre-building it into this array —
  // see veracodeHandler.ts's descriptor). The paging source of truth: buildReviewPage() re-derives
  // `rows` from this on every page change, which is what makes a "new" row's toggle page-local
  // (R7) — see applyReviewSessionToggle()'s own doc comment.
  allRows: TRow[];
  // The currently DISPLAYED page: every "already ticketed" row (always shown in full, R8 — never
  // paged) plus the current page's slice of "new" rows (BATCH_LIMIT per page, defaulted to
  // included). createNewRows reads this page's included new rows directly
  // and is otherwise untouched by paging (R7's "confirming from whichever page is currently
  // visible creates that page's included rows").
  rows: TRow[];
  // 0-based index into the "new" rows only — see buildReviewPage().
  page: number;
  // U6: open tickets whose finding(s) have disappeared from this report/reverse search — a third
  // review section, transitioned on confirm via cleanupHandler.ts's shared transition logic
  // (`transitionTickets`). Absent for importers with no stale-check concept (email, which has no
  // dedup/marker-label concept either — see ReportImportDescriptor's optional `stale` field).
  staleTickets?: ReviewSessionStale;
  // Overview-hub KTD1/KTD7: the screen currently shown, the result groups that had rows when the
  // session was built (fixed for the session's life — R1's listing basis), whether exactly one
  // group had rows (then there is no overview, R4), and the accumulated action outcomes (R2).
  // Optional only so a caller-built session (tests, older call sites) can be normalized by
  // ensureImportViewState(); every session the handler persists carries all four.
  view?: ImportReviewView;
  groups?: ImportResultGroup[];
  singleGroup?: boolean;
  outcomes?: ImportOutcomes;
  // Accepted-CVE list (KTD5): what the accepted list kept off the New screen — CVEs hidden because
  // they are accepted, and components hidden because their recomputed rating fell below the floor.
  // Stored, not recomputed per render; absent when nothing was hidden or the importer has no list.
  acceptedHidden?: AcceptedHidden;
  schemaVersion: number;
}

export interface AcceptedHidden {
  cves: number;
  belowFloor: number;
}

export type VeracodeReviewSession = ReviewSession<VeracodeReviewRow>;

export type WaltzReviewSession = ReviewSession<WaltzReviewRow>;

export type EmailReviewSession = ReviewSession<EmailReviewRow>;

// ---------------------------------------------------------------------------------------------
// U6: stale-ticket review section — open tickets whose finding(s) are gone from the current
// report/reverse search (`reportImport.ts`'s `findStaleTickets`), grouped by issue type so each
// group can share one resolution ask before the merged review screen renders (KTD10-15's "chain
// the ask once per group, not once per ticket" rule). `cleanupHandler.ts`'s `buildStaleTicketGroups`
// builds these; `reportImportHandler.ts` chains the ask and renders the result via
// `buildStaleGroupScreen` below.
// ---------------------------------------------------------------------------------------------

/** One issue-type group of stale tickets. The target is not fixed here: it is picked when the
 * user closes the group's selected tickets (stale-ticket target pick plan, R1/R2/KTD1), from the
 * group's matching cleanup rules and the snapshot of its project/issue type's workflow graph, which
 * is also what the transition paths are computed from at close time (KTD2). Every ticket defaults
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

export interface ReviewSessionStale {
  groups: StaleTicketGroup[];
  ineligible: IneligibleStaleTicket[];
  // Tickets a "close tickets" run already transitioned — shown as done, no longer toggleable, and
  // never transitioned again. (Named for the original closing-only flow; the target may now be a
  // non-final status.)
  closedKeys?: string[];
  // The Jira instance's resolution names, fetched once when the stale section is built (KTD1) so
  // the close-time resolution question needs no Jira call. Empty when none exist or the fetch
  // failed — the close then never asks.
  resolutionOptions: string[];
}

/**
 * The stepped "close tickets" flow on the Stale screen (stale-ticket target pick plan, KTD4):
 * `pick-issue-type` (only when the selection spans several issue types, R12), then `pick-target`
 * (R1/R2), then `pick-resolution` (only when R4/KTD5 call for one). Stored under the existing
 * `jira.session.staleResolution` key with the `stale-resolution-selection` metadata kind, so the
 * participant's routing is unchanged. `reviewSession` is the review session parked while the
 * questions are open; `back` at any step returns to its Stale screen with nothing transitioned.
 */
export interface StaleCloseSession {
  descriptorKind: 'veracode' | 'waltz'; // email has no stale-check concept — never reaches this flow
  step: 'pick-issue-type' | 'pick-target' | 'pick-resolution';
  issueTypeOptions: string[];
  issueType?: string;
  targetOptions?: StaleTargetOption[];
  target?: StaleTargetOption;
  reviewSession: VeracodeReviewSession | WaltzReviewSession;
  schemaVersion: number;
}

// A target state in this set counts as closing, so a resolution is asked before transitioning to
// it (when nothing else supplies one). Shared by `@jira cleanup` (cleanupHandler.ts) and the
// stale-ticket close below.
export const CLOSED_LIKE_STATES = new Set(['done', 'resolved', 'closed', "won't fix"]);

/** A group's tickets that are selected and not yet transitioned by an earlier close run. */
export function selectedOpenStaleTickets(group: StaleTicketGroup, closedKeys: string[] = []): TransitionBatchTicket[] {
  const done = new Set(closedKeys);
  return group.tickets.filter(t => t.included && !done.has(t.key));
}

/** R12: the issue types that have at least one selected, not-yet-transitioned stale ticket, in
 * group order. */
export function selectedStaleIssueTypes(stale: ReviewSessionStale): string[] {
  return stale.groups.filter(g => selectedOpenStaleTickets(g, stale.closedKeys).length > 0).map(g => g.issueType);
}

export function staleTargetState(option: StaleTargetOption): string {
  return option.kind === 'rule' ? option.targetState : option.status;
}

/** R3/R4/KTD5: a rule with a resolution never asks; a rule without one, or a plain status, asks
 * only when its target is closed-like — and never when the instance has no resolutions at all. */
export function staleTargetNeedsResolution(option: StaleTargetOption, resolutionOptions: string[]): boolean {
  if (resolutionOptions.length === 0) return false;
  if (option.kind === 'rule' && option.resolution !== undefined) return false;
  return CLOSED_LIKE_STATES.has(staleTargetState(option).toLowerCase());
}

/**
 * KTD2/R11: turns one group's selected, not-yet-transitioned tickets into runnable transitions
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
 * against incomplete data) is what AE7 requires. "No session at all" is a different, already-handled
 * case and is deliberately NOT reported as expired by this guard.
 */
export function isSessionExpired(session: { schemaVersion?: number } | null | undefined): boolean {
  if (!session) return false;
  return typeof session.schemaVersion !== 'number' || session.schemaVersion < CURRENT_SESSION_SCHEMA_VERSION;
}

export const SESSION_EXPIRED_MESSAGE =
  '_This import session was started before a Ticket Sidekick update and can no longer be continued — please re-run the import._';

// U6: full-ticket-key vocabulary (e.g. `PROJ-123`) for the Stale section's own toggle replies —
// deliberately disjoint from the New/Already-ticketed sections' `"1".."N"`/`"A1".."Am"` row-id
// tokens (a ticket key always contains a hyphen; a row id never does) and from U4's `next`/`prev`/
// `page <n>` page-nav tokens (none of those match this pattern either). Reuses `TICKET_KEY_TOKEN`
// (branchParser.ts's `TICKET_ID_PATTERN`, anchored) rather than a third independently-typed copy
// of the Jira ticket-key shape.

/** A cleanup rule matching a stale group's project + issue type, as offered in the close-time
 * target pick (stale-ticket target pick plan, R2/R3). */
export interface StaleRuleOption {
  name: string;
  targetState: string;
  resolution?: string;
}

/** One entry of the close-time target pick: a matching cleanup rule (its target and resolution
 * apply, R3) or a plain workflow status (R4). */
export type StaleTargetOption =
  | { kind: 'rule'; ruleName: string; targetState: string; resolution?: string }
  | { kind: 'status'; status: string };
