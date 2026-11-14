import type { BoardKind, CheckMode } from '../../sessions/boardKind';
import type { Conflict, Session } from '../../sessions/sessionTypes';
import type { WorkflowGraph } from '../../services/WorkflowService';
import type { CleanupRule } from '../../templates/TemplateService';
import { SUBTASK_KEYS_PER_QUERY, buildCleanupQuery, buildSubtaskQueries, cleanupTargets, describeFixVersion, isClosedLike, pathProblem } from './cleanupSource';

// The ticket list board: the tickets of a JQL query or a saved filter, with a selection and one
// change (a move to a status, or a field value) that is applied to the selected tickets after a
// preview. The agent may open it with a proposed change; it never gets the rows. The rows are
// shown a page at a time, and a board whose tickets changed in Jira says so and offers only
// Refresh, so nothing is applied to tickets the developer has not seen as they are now.
//
// A cleanup is the same board loaded from a rule in `.jira-templates.json`: the rule's tickets
// with their open subtasks beneath them, each moving to the rule's target status. Only parents are
// selected, their subtasks move first, and a cleanup applies the page in view.

export const TICKET_LIST_KIND = 'ticket-list';

export interface TicketRow {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  assignee: string;
  priority: string;
  /** Jira's `updated` time, used to notice that a ticket changed since the board read it. */
  updated: string;
  /** The configured extra fields as plain text, by field id. */
  extra?: Record<string, string>;
  /** A subtask's parent key, as Jira gives it. */
  parent?: string;
  /** On a cleanup: the status this ticket moves to, and the resolution the rule gives it. */
  target?: string;
  resolution?: string;
  /** On a cleanup: why this ticket cannot be moved, so it cannot be selected. */
  blocked?: string;
  /** On a cleanup: the parent's open subtasks, moved before it. */
  subtasks?: TicketRow[];
}

/** An extra column from the settings: the field id and the name shown as its header. */
export interface ExtraColumn {
  id: string;
  name: string;
}

/** Which extra columns a board shows: the search columns, or the cleanup columns for a board that closes or moves tickets. */
export type ColumnSet = 'search' | 'cleanup';

export type ListSource =
  | { type: 'jql'; jql: string }
  | { type: 'filter'; id: string; name: string; jql: string }
  /** A cleanup rule by name, with the fix version a request gave in place of the rule's. */
  | { type: 'rule'; name: string; fixVersion?: string };

/** How a field change treats a list field's current values: replace them, or add or remove single ones. */
export type FieldOperation = 'set' | 'add' | 'remove';

export type ListChange =
  | { type: 'transition'; status: string; resolution?: string }
  | { type: 'field'; field: string; value: string; operation?: FieldOperation };

export interface TicketListRecipe {
  source: ListSource;
  /** A change the agent proposed when it opened the board. */
  proposed?: ListChange;
}

export interface TicketListData {
  rows: TicketRow[];
  /** The extra columns of `ticketSidekick.jira.searchFields` and `ticketSidekick.jira.cleanupFields`. */
  columns?: Record<ColumnSet, ExtraColumn[]>;
  /** More tickets match than were read. */
  truncated: boolean;
  baseUrl?: string;
  /** The query that was run, when the source does not carry it (a cleanup rule). */
  jql?: string;
  cleanup?: CleanupInfo;
}

/** What a cleanup board shows about its rule. */
export interface CleanupInfo {
  rule: string;
  targetState: string;
  subtaskTargetState?: string;
  /** The rule names no resolution for a status that closes tickets: one is chosen on the board. */
  needsResolution: boolean;
  resolutions: string[];
  scope?: string;
  warnings: string[];
}

/** Which rows are selected: all but some, or only some, so "all selected" holds before the rows are known. */
export type Selection = { mode: 'all'; except: string[] } | { mode: 'only'; keys: string[] };

export type SortColumn = 'key' | 'summary' | 'status' | 'issueType' | 'assignee' | 'priority';

export interface RowResult {
  outcome: 'done' | 'failed' | 'refused';
  reason?: string;
}

/** What a background check found that the board does not show yet. */
export interface OutOfDate {
  changed: string[];
  gone: string[];
  added: number;
}

export interface TicketListWorking {
  selection: Selection;
  /** The page in view, counted from 0. */
  page: number;
  /** Chosen when the board opens: a proposed move shows the cleanup columns. */
  columns: ColumnSet;
  /** Set when a background check found tickets that differ from the rows on show. */
  outOfDate: OutOfDate | null;
  change: ListChange | null;
  /** The change came from the agent and the developer has not touched it yet. */
  proposed: boolean;
  sort: { column: SortColumn; descending: boolean } | null;
  /** What the last Apply did, by ticket key. */
  results: Record<string, RowResult>;
  /** On a cleanup whose rule names no resolution: the one chosen on the board, '' for none. */
  resolution: string | null;
}

export type TicketListAction =
  | { type: 'select'; key: string; on: boolean }
  | { type: 'select-all' }
  | { type: 'select-none' }
  | { type: 'change'; change: ListChange | null }
  | { type: 'sort'; column: SortColumn }
  | { type: 'page'; page: number }
  | { type: 'resolution'; resolution: string | null }
  | { type: 'apply' };

export interface TicketListDeps {
  jiraConfigured(): Promise<boolean>;
  baseUrl(): Promise<string | undefined>;
  /** Resolves a saved filter by id or name; a string is the reason it could not. */
  resolveFilter(filter: string): Promise<{ id: string; name: string; jql: string } | string>;
  /** The extra columns the settings ask for, with their field names. */
  extraColumns(): Promise<Record<ColumnSet, ExtraColumn[]>>;
  search(jql: string, limit: number, extraFieldIds: string[]): Promise<{ rows: TicketRow[]; truncated: boolean }>;
  /** The ticket as it is now, or undefined when it no longer exists. */
  readTicket(key: string): Promise<{ status: string; updated: string } | undefined>;
  /** Moves a ticket; resolves with a note on success, rejects with a short reason. */
  move(key: string, status: string, resolution?: string): Promise<string>;
  setField(key: string, field: string, value: string, operation: FieldOperation): Promise<string>;
  /** The cleanup rules of `.jira-templates.json` in the workspace. */
  cleanupRules(): Promise<CleanupRule[]>;
  /** The workflow of a project's issue type, discovered once when the cache has none. */
  workflowGraph(projectKey: string, issueType: string): Promise<WorkflowGraph | undefined>;
  /** The resolution names Jira offers. */
  resolutions(): Promise<string[]>;
  now(): number;
}

export type ViewRow = TicketRow & { url: string | null; selected: boolean; result: RowResult | null; subtasks?: ViewRow[] };

export interface TicketListView {
  title: string;
  jql: string;
  truncated: boolean;
  /** The rows of the page in view. */
  rows: ViewRow[];
  /** A cleanup board's rule, target and resolution choice. */
  cleanup: (CleanupInfo & { resolution: string | null }) | null;
  /** Apply on this board writes only the selected tickets of the page in view. */
  pageOnly: boolean;
  /** The extra columns shown after the fixed ones. */
  columns: ExtraColumn[];
  totalRows: number;
  page: number;
  pageCount: number;
  selectedCount: number;
  outOfDate: OutOfDate | null;
  change: ListChange | null;
  proposed: boolean;
  sort: TicketListWorking['sort'];
}

export const MAX_LIST_ROWS = 300;
export const PAGE_SIZE = 50;
/** Open subtasks read per query of a hundred parents. */
export const MAX_SUBTASK_ROWS = MAX_LIST_ROWS * 5;
const FIELD_OPERATIONS: readonly FieldOperation[] = ['set', 'add', 'remove'];
const OUT_OF_DATE = 'The list is out of date: press Refresh to see the tickets as they are now.';
const SORT_COLUMNS: readonly SortColumn[] = ['key', 'summary', 'status', 'issueType', 'assignee', 'priority'];

type ListSession = Session<TicketListRecipe, TicketListData, TicketListWorking>;

function text(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** A change in its accepted shape, or undefined. */
export function asChange(value: unknown): ListChange | undefined {
  const v = value as { type?: unknown; status?: unknown; resolution?: unknown; field?: unknown; value?: unknown } | null;
  if (typeof v !== 'object' || v === null) return undefined;
  if (v.type === 'transition') {
    const status = text(v.status, 100);
    if (!status) return undefined;
    const resolution = text(v.resolution, 100);
    return resolution ? { type: 'transition', status, resolution } : { type: 'transition', status };
  }
  if (v.type === 'field') {
    const field = text(v.field, 100);
    // An empty value clears nothing by accident: clearing a field is not offered here.
    const fieldValue = text(v.value, 2000);
    if (!field || !fieldValue) return undefined;
    const operation = (v as { operation?: unknown }).operation;
    if (operation === undefined || operation === 'set') return { type: 'field', field, value: fieldValue };
    return FIELD_OPERATIONS.includes(operation as FieldOperation) ? { type: 'field', field, value: fieldValue, operation: operation as FieldOperation } : undefined;
  }
  return undefined;
}

export function isSelected(selection: Selection, key: string): boolean {
  return selection.mode === 'all' ? !selection.except.includes(key) : selection.keys.includes(key);
}

/** A cleanup board: loaded from a rule, or opened with a proposed move. */
function isCleanup(session: ListSession): boolean {
  return session.recipe.source.type === 'rule' || session.working.columns === 'cleanup';
}

function selectable(row: TicketRow): boolean {
  return row.blocked === undefined;
}

/** The rows in the order the board shows them. */
function orderedRows(session: ListSession): TicketRow[] {
  const { sort } = session.working;
  const rows = session.derived.data.rows;
  if (!sort) return rows;
  return [...rows].sort((a, b) => sortValue(a, sort.column).localeCompare(sortValue(b, sort.column)) * (sort.descending ? -1 : 1));
}

function pageRows(session: ListSession): TicketRow[] {
  const rows = orderedRows(session);
  const page = clampPage(session.working.page, rows.length);
  return rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

/** The tickets an Apply writes: every selected one, or on a cleanup only those of the page in view. */
function selectedRows(session: ListSession): TicketRow[] {
  const rows = isCleanup(session) ? pageRows(session) : session.derived.data.rows;
  return rows.filter(row => selectable(row) && isSelected(session.working.selection, row.key));
}

/** Every ticket on the board, subtasks included, for noticing what changed in Jira. */
function allTickets(rows: TicketRow[]): TicketRow[] {
  return rows.flatMap(row => [row, ...(row.subtasks ?? [])]);
}

function describeChange(change: ListChange, row: TicketRow): string {
  if (change.type === 'transition') return `Status: ${row.status} → ${change.status}${change.resolution ? `, resolution ${change.resolution}` : ''}`;
  if (change.operation === 'add') return `Add "${change.value}" to ${change.field}`;
  if (change.operation === 'remove') return `Remove "${change.value}" from ${change.field}`;
  return `Set ${change.field} to "${change.value}"`;
}

function pageCount(rows: number): number {
  return Math.max(1, Math.ceil(rows / PAGE_SIZE));
}

function clampPage(page: number, rows: number): number {
  return Math.min(Math.max(0, Math.floor(page)), pageCount(rows) - 1);
}

/** What differs between the rows on show and a fresh reading. */
function differences(shownRows: TicketRow[], freshRows: TicketRow[]): OutOfDate | null {
  const shown = allTickets(shownRows);
  const fresh = allTickets(freshRows);
  const now = new Map(fresh.map(row => [row.key, row]));
  const before = new Set(shown.map(row => row.key));
  const changed = shown.filter(row => now.has(row.key) && now.get(row.key)!.updated !== row.updated).map(row => row.key);
  const gone = shown.filter(row => !now.has(row.key)).map(row => row.key);
  const added = fresh.filter(row => !before.has(row.key)).length;
  return changed.length + gone.length + added > 0 ? { changed, gone, added } : null;
}

function sortValue(row: TicketRow, column: SortColumn): string {
  if (column === 'key') {
    const [project, number] = row.key.split('-');
    return `${project}-${(number ?? '').padStart(9, '0')}`;
  }
  return row[column].toLowerCase();
}

function columnSetFor(change: ListChange | undefined): ColumnSet {
  return change?.type === 'transition' ? 'cleanup' : 'search';
}

function fieldVerb(operation: FieldOperation | undefined): string {
  return operation === 'add' ? 'Add to' : operation === 'remove' ? 'Remove from' : 'Set';
}

function sourceTitle(source: ListSource): string {
  if (source.type === 'rule') return `Cleanup: ${source.name}${source.fixVersion ? ` in ${source.fixVersion}` : ''}`;
  return source.type === 'filter' ? `Tickets: filter "${source.name}"` : 'Tickets: JQL search';
}

function findRule(rules: CleanupRule[], name: string): CleanupRule | undefined {
  const wanted = name.trim().toLowerCase();
  return rules.find(rule => rule.name.trim().toLowerCase() === wanted);
}

/** Reads a cleanup rule's tickets, their open subtasks and whether a path takes each to its target. */
async function readCleanup(source: Extract<ListSource, { type: 'rule' }>, deps: TicketListDeps, fieldIds: string[]) {
  const rule = findRule(await deps.cleanupRules(), source.name);
  if (!rule) throw new Error(`The cleanup rule "${source.name}" is no longer in .jira-templates.json.`);
  const query = buildCleanupQuery(rule, source.fixVersion);
  const targets = cleanupTargets(rule);
  const { rows: parents, truncated } = await deps.search(query.jql, MAX_LIST_ROWS, fieldIds);

  const subtasksOf = new Map<string, TicketRow[]>();
  // Parents whose open subtasks could not all be read: closing one could leave a subtask nobody saw open.
  const unreadSubtasks = new Set<string>();
  if (rule.closeSubtasks && parents.length > 0) {
    const keys = parents.map(p => p.key);
    for (let i = 0; i < keys.length; i += SUBTASK_KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + SUBTASK_KEYS_PER_QUERY);
      const [jql] = buildSubtaskQueries(chunk, targets.subtaskTargetState);
      const { rows, truncated: more } = await deps.search(jql, MAX_SUBTASK_ROWS, fieldIds);
      if (more) chunk.forEach(key => unreadSubtasks.add(key));
      for (const sub of rows) if (sub.parent) subtasksOf.set(sub.parent, [...(subtasksOf.get(sub.parent) ?? []), sub]);
    }
  }

  // One workflow per issue type, discovered at most once in this reading.
  const graphs = new Map<string, Promise<WorkflowGraph | undefined>>();
  const graphOf = (issueType: string) => {
    if (!graphs.has(issueType)) graphs.set(issueType, deps.workflowGraph(rule.project, issueType).catch(() => undefined));
    return graphs.get(issueType)!;
  };

  const rows: TicketRow[] = [];
  for (const parent of parents) {
    const subtasks: TicketRow[] = [];
    for (const sub of subtasksOf.get(parent.key) ?? []) {
      const blocked = pathProblem(await graphOf(sub.issueType), sub.status, targets.subtaskTargetState);
      subtasks.push({ ...sub, target: targets.subtaskTargetState, ...(targets.subtaskResolution ? { resolution: targets.subtaskResolution } : {}), ...(blocked ? { blocked } : {}) });
    }
    const own = pathProblem(await graphOf(parent.issueType), parent.status, targets.targetState);
    const stuck = subtasks.find(sub => sub.blocked);
    const blocked = own
      ?? (unreadSubtasks.has(parent.key) ? 'more open subtasks than the board can read; narrow the rule\'s query' : undefined)
      ?? (stuck ? `subtask ${stuck.key} cannot be moved: ${stuck.blocked}` : undefined);
    rows.push({
      ...parent, target: targets.targetState, ...(targets.resolution ? { resolution: targets.resolution } : {}),
      ...(blocked ? { blocked } : {}), ...(rule.closeSubtasks ? { subtasks } : {}),
    });
  }

  const needsResolution = (isClosedLike(targets.targetState) && !targets.resolution)
    || (rule.closeSubtasks === true && isClosedLike(targets.subtaskTargetState) && !targets.subtaskResolution);
  const cleanup: CleanupInfo = {
    rule: rule.name, targetState: targets.targetState,
    ...(rule.closeSubtasks ? { subtaskTargetState: targets.subtaskTargetState } : {}),
    needsResolution, resolutions: needsResolution ? await deps.resolutions() : [],
    ...(describeFixVersion(query.fixVersion) ? { scope: describeFixVersion(query.fixVersion) } : {}),
    warnings: query.warnings,
  };
  return { rows, truncated, jql: query.jql, cleanup };
}

interface MoveTarget {
  key: string;
  updated: string;
  status: string;
  target: string;
  resolution?: string;
}

interface PlannedTarget {
  key: string;
  updated: string;
  status: string;
  /** On a cleanup: where this ticket moves, and the subtasks that move first. */
  move?: MoveTarget;
  subtasks?: MoveTarget[];
}

export const ticketListKind: BoardKind<TicketListRecipe, TicketListData, TicketListWorking, TicketListAction, TicketListView, TicketListDeps> = {
  kind: TICKET_LIST_KIND,
  formatVersion: 2,
  title: recipe => sourceTitle(recipe.source),

  validate: async (input, deps) => {
    const v = (typeof input === 'object' && input !== null ? input : {}) as { jql?: unknown; filter?: unknown; change?: unknown; cleanupRule?: unknown; fixVersion?: unknown };
    const jql = text(v.jql, 4000);
    const filter = text(v.filter, 200);
    const ruleName = text(v.cleanupRule, 200);
    if ((jql ? 1 : 0) + (filter ? 1 : 0) + (ruleName ? 1 : 0) !== 1) {
      return { ok: false, reason: 'pass one of a JQL query as input.jql, a saved filter\'s id or name as input.filter, or a cleanup rule\'s name as input.cleanupRule.' };
    }
    if (!(await deps.jiraConfigured())) return { ok: false, reason: 'Jira is not set up in that window\'s Ticket Sidekick settings.' };
    if (ruleName) {
      const rules = await deps.cleanupRules();
      const rule = findRule(rules, ruleName);
      if (!rule) {
        const known = rules.map(r => `"${r.name}"`).join(', ');
        return { ok: false, reason: `no cleanup rule named "${ruleName}" in .jira-templates.json. ${known ? `The rules there are: ${known}.` : 'The file has no cleanupRules.'}` };
      }
      const fixVersion = text(v.fixVersion, 200);
      return { ok: true, recipe: { source: { type: 'rule', name: rule.name, ...(fixVersion ? { fixVersion } : {}) } } };
    }
    let proposed: ListChange | undefined;
    if (v.change !== undefined && v.change !== null) {
      proposed = asChange(v.change);
      if (!proposed) return { ok: false, reason: 'the proposed change is not one the board knows: a status to move to, or a field and a value.' };
    }
    if (jql) return { ok: true, recipe: { source: { type: 'jql', jql }, ...(proposed ? { proposed } : {}) } };
    const resolved = await deps.resolveFilter(filter!);
    if (typeof resolved === 'string') return { ok: false, reason: resolved };
    return { ok: true, recipe: { source: { type: 'filter', ...resolved }, ...(proposed ? { proposed } : {}) } };
  },

  sourceKey: recipe => {
    const { source } = recipe;
    if (source.type === 'rule') return `rule:${source.name.toLowerCase()}|${(source.fixVersion ?? '').toLowerCase()}`;
    return source.type === 'filter' ? `filter:${source.id}` : `jql:${source.jql.replace(/\s+/g, ' ').toLowerCase()}`;
  },
  sourceLabel: recipe => {
    const { source } = recipe;
    if (source.type === 'rule') return `Cleanup rule "${source.name}"${source.fixVersion ? ` in ${source.fixVersion}` : ''}`;
    return source.type === 'filter' ? `Filter "${source.name}"` : `JQL: ${source.jql}`;
  },

  // With a proposed change every matching row starts selected; without one, none.
  // A cleanup starts with every ticket selected, like a proposed change.
  initialWorking: recipe => ({
    selection: recipe.proposed || recipe.source.type === 'rule' ? { mode: 'all', except: [] } : { mode: 'only', keys: [] },
    page: 0,
    outOfDate: null,
    resolution: null,
    columns: recipe.source.type === 'rule' ? 'cleanup' : columnSetFor(recipe.proposed),
    change: recipe.proposed ?? null,
    proposed: recipe.proposed !== undefined,
    sort: null,
    results: {},
  }),

  // Asked for again with a new proposed change: the change replaces the old one and all rows are selected.
  reopen: (session, recipe) => (recipe.proposed && recipe.source.type !== 'rule'
    ? { ...session.working, selection: { mode: 'all', except: [] }, change: recipe.proposed, proposed: true, results: {}, columns: columnSetFor(recipe.proposed) }
    : session.working),

  read: async (recipe, deps) => {
    const columns = await deps.extraColumns();
    const fieldIds = [...new Set([...columns.search, ...columns.cleanup].map(c => c.id))];
    const baseUrl = await deps.baseUrl();
    if (recipe.source.type === 'rule') {
      const cleanup = await readCleanup(recipe.source, deps, fieldIds);
      return { readAt: deps.now(), fingerprints: {}, data: { ...cleanup, columns, baseUrl } };
    }
    const { rows, truncated } = await deps.search(recipe.source.jql, MAX_LIST_ROWS, fieldIds);
    return { readAt: deps.now(), fingerprints: {}, data: { rows, truncated, columns, baseUrl } };
  },

  // By itself the check only says that the list is out of date and keeps the rows on show; on
  // Refresh the fresh rows replace them, and the selection keeps every ticket still in the list.
  reconcile: (session, fresh, mode: CheckMode) => {
    const found = differences(session.derived.data.rows, fresh.data.rows);
    if (mode === 'background') {
      return found
        ? { derived: session.derived, working: { ...session.working, outOfDate: found }, conflicts: [] }
        : { derived: fresh, working: { ...session.working, outOfDate: null }, conflicts: [] };
    }
    const now = new Set(fresh.data.rows.map(row => row.key));
    const selection: Selection = session.working.selection.mode === 'all'
      ? { mode: 'all', except: session.working.selection.except.filter(k => now.has(k)) }
      : { mode: 'only', keys: session.working.selection.keys.filter(k => now.has(k)) };
    return {
      derived: fresh,
      working: { ...session.working, selection, outOfDate: null, results: {}, page: clampPage(session.working.page, fresh.data.rows.length) },
      conflicts: [],
    };
  },

  reduce: (session, action) => {
    const working = session.working;
    const byKey = new Map(session.derived.data.rows.map(r => [r.key, r]));
    const parentOf = new Map(session.derived.data.rows.flatMap(r => (r.subtasks ?? []).map(sub => [sub.key, r.key] as const)));
    if (action?.type === 'page') {
      if (typeof action.page !== 'number' || !Number.isFinite(action.page)) return { ok: false, reason: 'Unknown page.' };
      return { ok: true, working: { ...working, page: clampPage(action.page, session.derived.data.rows.length) } };
    }
    if (working.outOfDate) return { ok: false, reason: OUT_OF_DATE };
    switch (action?.type) {
      case 'select': {
        if (typeof action.key === 'string' && parentOf.has(action.key)) return { ok: false, reason: `Subtasks follow their parent: select ${parentOf.get(action.key)} instead.` };
        const target = typeof action.key === 'string' ? byKey.get(action.key) : undefined;
        if (!target) return { ok: false, reason: 'That ticket is not on the board.' };
        if (action.on === true && target.blocked) return { ok: false, reason: `${target.key} cannot be moved: ${target.blocked}.` };
        const key = action.key;
        const on = action.on === true;
        const selection: Selection = working.selection.mode === 'all'
          ? { mode: 'all', except: on ? working.selection.except.filter(k => k !== key) : [...new Set([...working.selection.except, key])] }
          : { mode: 'only', keys: on ? [...new Set([...working.selection.keys, key])] : working.selection.keys.filter(k => k !== key) };
        return { ok: true, working: { ...working, selection } };
      }
      case 'select-all': return { ok: true, working: { ...working, selection: { mode: 'all', except: [] } } };
      case 'select-none': return { ok: true, working: { ...working, selection: { mode: 'only', keys: [] } } };
      case 'resolution': {
        const info = session.derived.data.cleanup;
        if (!info?.needsResolution) return { ok: false, reason: 'This board does not ask for a resolution.' };
        if (action.resolution === null) return { ok: true, working: { ...working, resolution: null } };
        if (action.resolution !== '' && !info.resolutions.includes(action.resolution)) return { ok: false, reason: 'Choose one of the resolutions Jira offers, or none.' };
        return { ok: true, working: { ...working, resolution: action.resolution } };
      }
      case 'change': {
        if (session.recipe.source.type === 'rule') return { ok: false, reason: 'A cleanup moves tickets to its rule\'s target status; that cannot be changed here.' };
        if (action.change === null) return { ok: true, working: { ...working, change: null, proposed: false } };
        const change = asChange(action.change);
        if (!change) return { ok: false, reason: 'Give a status to move to, or a field and a value.' };
        return { ok: true, working: { ...working, change, proposed: false } };
      }
      case 'sort': {
        if (!SORT_COLUMNS.includes(action.column)) return { ok: false, reason: 'Unknown column.' };
        const current = working.sort?.column === action.column ? working.sort : null;
        const sort = !current ? { column: action.column, descending: false } : current.descending ? null : { column: action.column, descending: true };
        return { ok: true, working: { ...working, sort } };
      }
      default: return { ok: false, reason: 'Unknown action.' };
    }
  },

  plan: (session, action) => {
    if (action?.type !== 'apply') return { ok: false, reason: 'Unknown action.' };
    if (session.working.outOfDate) return { ok: false, reason: OUT_OF_DATE };
    if (session.recipe.source.type === 'rule') return planCleanup(session);
    const { change } = session.working;
    if (!change) return { ok: false, reason: 'Choose a change first: a status to move to, or a field and a value.' };
    const rows = selectedRows(session);
    if (rows.length === 0) return { ok: false, reason: isCleanup(session) ? 'Select at least one ticket on this page.' : 'Select at least one ticket.' };
    const closes = change.type === 'transition' && isClosedLike(change.status);
    return {
      ok: true,
      plan: {
        title: change.type === 'transition' ? `Move ${rows.length} ticket(s) to ${change.status}` : `${fieldVerb(change.operation)} ${change.field} on ${rows.length} ticket(s)`,
        lines: rows.map(row => ({ target: row.key, change: describeChange(change, row) })),
        risky: rows.length > 1 || closes,
        payload: { change, targets: rows.map((row): PlannedTarget => ({ key: row.key, updated: row.updated, status: row.status })) },
      },
    };
  },

  apply: async (session, plan, deps) => {
    const { change, targets } = plan.payload as { change: ListChange | null; targets: PlannedTarget[] };
    const results: Record<string, RowResult> = {};
    const conflicts: Conflict[] = [];
    /** Reads the ticket again and writes it only when it is as the board read it; says whether it was written. */
    const writeOne = async (target: { key: string; updated: string; status: string }, write: () => Promise<unknown>): Promise<boolean> => {
      try {
        // The truth is Jira: a ticket that moved since the board read it is not written to.
        const current = await deps.readTicket(target.key);
        if (!current) {
          results[target.key] = { outcome: 'refused', reason: 'no longer exists in Jira' };
          return false;
        }
        if (current.updated !== target.updated) {
          results[target.key] = { outcome: 'refused', reason: 'changed in Jira since the board read it' };
          conflicts.push({ id: target.key, target: target.key, message: 'changed in Jira and was not written to.', stored: target.status, fresh: current.status });
          return false;
        }
        await write();
        results[target.key] = { outcome: 'done' };
        return true;
      } catch (err) {
        results[target.key] = { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
        return false;
      }
    };
    for (const target of targets) {
      if (target.move) {
        // Subtasks first; a parent whose subtask was not moved stays as it is.
        let failed: string | undefined;
        for (const sub of target.subtasks ?? []) {
          if (!(await writeOne(sub, () => deps.move(sub.key, sub.target, sub.resolution)))) failed ??= sub.key;
        }
        const move = target.move;
        if (failed) results[target.key] = { outcome: 'refused', reason: `not moved, because subtask ${failed} was not moved` };
        else await writeOne(target, () => deps.move(move.key, move.target, move.resolution));
      } else if (change?.type === 'transition') {
        await writeOne(target, () => deps.move(target.key, change.status, change.resolution));
      } else if (change) {
        await writeOne(target, () => deps.setField(target.key, change.field, change.value, change.operation ?? 'set'));
      }
    }
    // Show what Jira holds now; when that read fails the rows stay as they were, with the results.
    let derived = session.derived;
    try {
      derived = await ticketListKind.read(session.recipe, deps);
    } catch {
      // The results below still say what was written.
    }
    return {
      results: targets.flatMap(t => [...(t.subtasks ?? []), t]).map(t => ({ target: t.key, ...results[t.key] })),
      derived,
      // A cleanup's query no longer lists the tickets it moved, so the next ones move up onto the page in
      // view: the selection stays (rows that left are simply gone) and the developer applies again there.
      working: {
        ...session.working,
        selection: session.recipe.source.type === 'rule' ? session.working.selection : { mode: 'only', keys: [] },
        proposed: false, results,
      },
      conflicts,
    };
  },

  view: session => {
    const { data } = session.derived;
    const working = session.working;
    const baseUrl = data.baseUrl?.replace(/\/+$/, '');
    const rows = orderedRows(session);
    const page = clampPage(working.page, rows.length);
    const toView = (row: TicketRow, selected: boolean): ViewRow => {
      const { subtasks, ...rest } = row;
      return {
        ...rest,
        url: baseUrl ? `${baseUrl}/browse/${encodeURIComponent(row.key)}` : null,
        selected,
        result: working.results[row.key] ?? null,
        ...(subtasks ? { subtasks: subtasks.map(sub => toView(sub, false)) } : {}),
      };
    };
    const view = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map(row => toView(row, selectable(row) && isSelected(working.selection, row.key)));
    const source = session.recipe.source;
    return {
      title: sourceTitle(source), jql: data.jql ?? (source.type === 'rule' ? '' : source.jql), truncated: data.truncated, rows: view,
      columns: data.columns?.[working.columns] ?? [],
      cleanup: data.cleanup ? { ...data.cleanup, resolution: working.resolution } : null,
      pageOnly: isCleanup(session),
      totalRows: rows.length, page, pageCount: pageCount(rows.length), outOfDate: working.outOfDate,
      selectedCount: data.rows.filter(r => selectable(r) && isSelected(working.selection, r.key)).length,
      change: working.change, proposed: working.proposed, sort: working.sort,
    };
  },
};

/** The plan of a cleanup: the selected parents of the page in view, each after its subtasks. */
function planCleanup(session: ListSession): ReturnType<NonNullable<typeof ticketListKind.plan>> {
  const info = session.derived.data.cleanup;
  if (!info) return { ok: false, reason: 'The cleanup rule could not be read.' };
  if (info.needsResolution && session.working.resolution === null) {
    return { ok: false, reason: `Choose a resolution for tickets moving to ${info.targetState} first, or none.` };
  }
  const chosen = session.working.resolution || undefined;
  const rows = selectedRows(session);
  if (rows.length === 0) return { ok: false, reason: 'Select at least one ticket on this page.' };
  const moveOf = (row: TicketRow): MoveTarget => {
    const resolution = row.resolution ?? chosen;
    return { key: row.key, updated: row.updated, status: row.status, target: row.target ?? info.targetState, ...(resolution ? { resolution } : {}) };
  };
  const describe = (move: MoveTarget, prefix = '') => ({
    target: move.key,
    change: `${prefix}Status: ${move.status} → ${move.target}${move.resolution ? `, resolution ${move.resolution}` : ''}`,
  });
  const targets: PlannedTarget[] = rows.map(row => ({
    key: row.key, updated: row.updated, status: row.status, move: moveOf(row), subtasks: (row.subtasks ?? []).map(moveOf),
  }));
  const subtaskCount = targets.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0);
  return {
    ok: true,
    plan: {
      title: `Move ${rows.length} ticket(s) to ${info.targetState}${subtaskCount ? `, with ${subtaskCount} subtask(s) first` : ''}`,
      lines: targets.flatMap(t => [...(t.subtasks ?? []).map(sub => describe(sub, `Subtask of ${t.key}: `)), describe(t.move!)]),
      risky: rows.length + subtaskCount > 1 || isClosedLike(info.targetState),
      payload: { change: null, targets },
    },
  };
}
