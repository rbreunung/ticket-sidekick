import type { BoardKind } from '../../sessions/boardKind';
import type { Conflict, Session } from '../../sessions/sessionTypes';

// The ticket list board: the tickets of a JQL query or a saved filter, with a selection and one
// change (a move to a status, or a field value) that is applied to the selected tickets after a
// preview. The agent may open it with a proposed change; it never gets the rows.

export const TICKET_LIST_KIND = 'ticket-list';

/** A status that counts as closing a ticket, so the write needs the native confirmation even for one ticket. */
const CLOSED_LIKE = new Set(['done', 'resolved', 'closed', "won't fix", 'wont fix', 'rejected', 'cancelled', 'canceled']);

export interface TicketRow {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  assignee: string;
  priority: string;
  /** Jira's `updated` time, used to notice that a ticket changed since the board read it. */
  updated: string;
}

export type ListSource =
  | { type: 'jql'; jql: string }
  | { type: 'filter'; id: string; name: string; jql: string };

export type ListChange =
  | { type: 'transition'; status: string; resolution?: string }
  | { type: 'field'; field: string; value: string };

export interface TicketListRecipe {
  source: ListSource;
  /** A change the agent proposed when it opened the board. */
  proposed?: ListChange;
}

export interface TicketListData {
  rows: TicketRow[];
  /** More tickets match than were read. */
  truncated: boolean;
  baseUrl?: string;
}

/** Which rows are selected: all but some, or only some, so "all selected" holds before the rows are known. */
export type Selection = { mode: 'all'; except: string[] } | { mode: 'only'; keys: string[] };

export type SortColumn = 'key' | 'summary' | 'status' | 'issueType' | 'assignee' | 'priority';

export interface RowResult {
  outcome: 'done' | 'failed' | 'refused';
  reason?: string;
}

export interface TicketListWorking {
  selection: Selection;
  change: ListChange | null;
  /** The change came from the agent and the developer has not touched it yet. */
  proposed: boolean;
  sort: { column: SortColumn; descending: boolean } | null;
  /** What the last Apply did, by ticket key. */
  results: Record<string, RowResult>;
}

export type TicketListAction =
  | { type: 'select'; key: string; on: boolean }
  | { type: 'select-all' }
  | { type: 'select-none' }
  | { type: 'change'; change: ListChange | null }
  | { type: 'sort'; column: SortColumn }
  | { type: 'apply' };

export interface TicketListDeps {
  jiraConfigured(): Promise<boolean>;
  baseUrl(): Promise<string | undefined>;
  /** Resolves a saved filter by id or name; a string is the reason it could not. */
  resolveFilter(filter: string): Promise<{ id: string; name: string; jql: string } | string>;
  search(jql: string, limit: number): Promise<{ rows: TicketRow[]; truncated: boolean }>;
  /** The ticket as it is now, or undefined when it no longer exists. */
  readTicket(key: string): Promise<{ status: string; updated: string } | undefined>;
  /** Moves a ticket; resolves with a note on success, rejects with a short reason. */
  move(key: string, status: string, resolution?: string): Promise<string>;
  setField(key: string, field: string, value: string): Promise<string>;
  now(): number;
}

export interface TicketListView {
  title: string;
  jql: string;
  truncated: boolean;
  rows: Array<TicketRow & { url: string | null; selected: boolean; result: RowResult | null }>;
  selectedCount: number;
  change: ListChange | null;
  proposed: boolean;
  sort: TicketListWorking['sort'];
}

export const MAX_LIST_ROWS = 300;
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
    return field && fieldValue ? { type: 'field', field, value: fieldValue } : undefined;
  }
  return undefined;
}

export function isSelected(selection: Selection, key: string): boolean {
  return selection.mode === 'all' ? !selection.except.includes(key) : selection.keys.includes(key);
}

function selectedRows(session: ListSession): TicketRow[] {
  return session.derived.data.rows.filter(row => isSelected(session.working.selection, row.key));
}

function describeChange(change: ListChange, row: TicketRow): string {
  return change.type === 'transition'
    ? `Status: ${row.status} → ${change.status}${change.resolution ? `, resolution ${change.resolution}` : ''}`
    : `Set ${change.field} to "${change.value}"`;
}

function sortValue(row: TicketRow, column: SortColumn): string {
  if (column === 'key') {
    const [project, number] = row.key.split('-');
    return `${project}-${(number ?? '').padStart(9, '0')}`;
  }
  return row[column].toLowerCase();
}

function sourceTitle(source: ListSource): string {
  return source.type === 'filter' ? `Tickets: filter "${source.name}"` : 'Tickets: JQL search';
}

export const ticketListKind: BoardKind<TicketListRecipe, TicketListData, TicketListWorking, TicketListAction, TicketListView, TicketListDeps> = {
  kind: TICKET_LIST_KIND,
  formatVersion: 1,
  title: recipe => sourceTitle(recipe.source),

  validate: async (input, deps) => {
    const v = (typeof input === 'object' && input !== null ? input : {}) as { jql?: unknown; filter?: unknown; change?: unknown };
    const jql = text(v.jql, 4000);
    const filter = text(v.filter, 200);
    if ((jql ? 1 : 0) + (filter ? 1 : 0) !== 1) return { ok: false, reason: 'pass either a JQL query as input.jql or a saved filter\'s id or name as input.filter.' };
    if (!(await deps.jiraConfigured())) return { ok: false, reason: 'Jira is not set up in that window\'s Ticket Sidekick settings.' };
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

  sourceKey: recipe => (recipe.source.type === 'filter' ? `filter:${recipe.source.id}` : `jql:${recipe.source.jql.replace(/\s+/g, ' ').toLowerCase()}`),
  sourceLabel: recipe => (recipe.source.type === 'filter' ? `Filter "${recipe.source.name}"` : `JQL: ${recipe.source.jql}`),

  // With a proposed change every matching row starts selected; without one, none.
  initialWorking: recipe => ({
    selection: recipe.proposed ? { mode: 'all', except: [] } : { mode: 'only', keys: [] },
    change: recipe.proposed ?? null,
    proposed: recipe.proposed !== undefined,
    sort: null,
    results: {},
  }),

  // Asked for again with a new proposed change: the change replaces the old one and all rows are selected.
  reopen: (session, recipe) => (recipe.proposed
    ? { ...session.working, selection: { mode: 'all', except: [] }, change: recipe.proposed, proposed: true, results: {} }
    : session.working),

  read: async (recipe, deps) => {
    const { rows, truncated } = await deps.search(recipe.source.jql, MAX_LIST_ROWS);
    return { readAt: deps.now(), fingerprints: {}, data: { rows, truncated, baseUrl: await deps.baseUrl() } };
  },

  // A selected ticket that changed in Jira, or left the list, is taken out of the selection and named.
  reconcile: (session, fresh) => {
    const before = new Map(session.derived.data.rows.map(row => [row.key, row]));
    const now = new Map(fresh.data.rows.map(row => [row.key, row]));
    const conflicts: Conflict[] = [];
    const deselect: string[] = [];
    for (const row of selectedRows(session)) {
      const current = now.get(row.key);
      if (!current) {
        conflicts.push({ id: row.key, target: row.key, message: 'is no longer in this list and was taken out of the selection.', stored: row.status });
        deselect.push(row.key);
      } else if (current.updated !== row.updated) {
        conflicts.push({ id: row.key, target: row.key, message: 'changed in Jira and was taken out of the selection.', stored: before.get(row.key)?.status, fresh: current.status });
        deselect.push(row.key);
      }
    }
    const selection: Selection = session.working.selection.mode === 'all'
      ? { mode: 'all', except: [...session.working.selection.except.filter(k => now.has(k)), ...deselect.filter(k => now.has(k))] }
      : { mode: 'only', keys: session.working.selection.keys.filter(k => !deselect.includes(k)) };
    return { derived: fresh, working: { ...session.working, selection, results: {} }, conflicts };
  },

  reduce: (session, action) => {
    const working = session.working;
    const known = new Set(session.derived.data.rows.map(r => r.key));
    switch (action?.type) {
      case 'select': {
        if (typeof action.key !== 'string' || !known.has(action.key)) return { ok: false, reason: 'That ticket is not on the board.' };
        const key = action.key;
        const on = action.on === true;
        const selection: Selection = working.selection.mode === 'all'
          ? { mode: 'all', except: on ? working.selection.except.filter(k => k !== key) : [...new Set([...working.selection.except, key])] }
          : { mode: 'only', keys: on ? [...new Set([...working.selection.keys, key])] : working.selection.keys.filter(k => k !== key) };
        return { ok: true, working: { ...working, selection } };
      }
      case 'select-all': return { ok: true, working: { ...working, selection: { mode: 'all', except: [] } } };
      case 'select-none': return { ok: true, working: { ...working, selection: { mode: 'only', keys: [] } } };
      case 'change': {
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
    const { change } = session.working;
    if (!change) return { ok: false, reason: 'Choose a change first: a status to move to, or a field and a value.' };
    const rows = selectedRows(session);
    if (rows.length === 0) return { ok: false, reason: 'Select at least one ticket.' };
    const closes = change.type === 'transition' && CLOSED_LIKE.has(change.status.toLowerCase());
    return {
      ok: true,
      plan: {
        title: change.type === 'transition' ? `Move ${rows.length} ticket(s) to ${change.status}` : `Set ${change.field} on ${rows.length} ticket(s)`,
        lines: rows.map(row => ({ target: row.key, change: describeChange(change, row) })),
        risky: rows.length > 1 || closes,
        payload: { change, targets: rows.map(row => ({ key: row.key, updated: row.updated, status: row.status })) },
      },
    };
  },

  apply: async (session, plan, deps) => {
    const { change, targets } = plan.payload as { change: ListChange; targets: Array<{ key: string; updated: string; status: string }> };
    const results: Record<string, RowResult> = {};
    const conflicts: Conflict[] = [];
    for (const target of targets) {
      try {
        // The truth is Jira: a ticket that moved since the board read it is not written to.
        const current = await deps.readTicket(target.key);
        if (!current) {
          results[target.key] = { outcome: 'refused', reason: 'no longer exists in Jira' };
          continue;
        }
        if (current.updated !== target.updated) {
          results[target.key] = { outcome: 'refused', reason: 'changed in Jira since the board read it' };
          conflicts.push({ id: target.key, target: target.key, message: 'changed in Jira and was not written to.', stored: target.status, fresh: current.status });
          continue;
        }
        if (change.type === 'transition') await deps.move(target.key, change.status, change.resolution);
        else await deps.setField(target.key, change.field, change.value);
        results[target.key] = { outcome: 'done' };
      } catch (err) {
        results[target.key] = { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
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
      results: targets.map(t => ({ target: t.key, ...results[t.key] })),
      derived,
      working: { ...session.working, selection: { mode: 'only', keys: [] }, proposed: false, results },
      conflicts,
    };
  },

  view: session => {
    const { data } = session.derived;
    const working = session.working;
    const baseUrl = data.baseUrl?.replace(/\/+$/, '');
    let rows = data.rows;
    if (working.sort) {
      const { column, descending } = working.sort;
      rows = [...rows].sort((a, b) => sortValue(a, column).localeCompare(sortValue(b, column)) * (descending ? -1 : 1));
    }
    const view = rows.map(row => ({
      ...row,
      url: baseUrl ? `${baseUrl}/browse/${encodeURIComponent(row.key)}` : null,
      selected: isSelected(working.selection, row.key),
      result: working.results[row.key] ?? null,
    }));
    return {
      title: sourceTitle(session.recipe.source), jql: session.recipe.source.jql, truncated: data.truncated, rows: view,
      selectedCount: view.filter(r => r.selected).length, change: working.change, proposed: working.proposed, sort: working.sort,
    };
  },
};
