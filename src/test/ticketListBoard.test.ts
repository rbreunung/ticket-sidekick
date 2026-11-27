import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  ticketListKind, type TicketListData, type TicketListDeps, type TicketListRecipe, type TicketListWorking, type TicketRow, type TicketListAction,
} from '../boards/ticketList/kind';
import { registerKind, type ApplyProgressReport } from '../sessions/boardKind';
import { sessionIdFor } from '../sessions/sessionId';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { Session } from '../sessions/sessionTypes';

// The ticket list board: a developer sees the tickets of a query, selects some, and moves them or
// sets a field after a preview. Jira stays the truth: a ticket that changed is not written to.

function row(n: number, status = 'Open', updated = 't1'): TicketRow {
  return { key: `PROJ-${n}`, summary: `Ticket ${n}`, status, issueType: 'Bug', assignee: 'Ada', priority: 'High', updated };
}

interface Fake extends TicketListDeps {
  jira: Map<string, TicketRow>;
  moved: string[];
  fields: string[];
  /** How many times a ticket was read one by one, before or after a write. */
  reads: number;
  /** What the board keeps outside its sessions: whether each ticket is read before it is written. */
  check: boolean;
}

function fake(rows: TicketRow[] = [row(1), row(2), row(3, 'Done')]): Fake {
  const jira = new Map(rows.map(r => [r.key, { ...r }]));
  const deps: Fake = {
    jira, moved: [], fields: [], reads: 0, check: true,
    checkBeforeWrite: async () => deps.check,
    setCheckBeforeWrite: async on => { deps.check = on; },
    jiraConfigured: async () => true,
    baseUrl: async () => 'https://jira.example.com',
    resolveFilter: async name => (name === 'mine' || name === '42' ? { id: '42', name: 'My open tickets', jql: 'assignee = currentUser()' } : `No saved filters found matching "${name}".`),
    extraColumns: async () => ({ search: [{ id: 'customfield_1', name: 'Team' }], cleanup: [{ id: 'fixVersions', name: 'Fix versions' }] }),
    search: async (_jql, _limit, fieldIds) => ({
      rows: [...jira.values()].map(r => ({ ...r, extra: Object.fromEntries(fieldIds.map(id => [id, `${id} of ${r.key}`])) })),
      truncated: false,
    }),
    readTicket: async key => { deps.reads++; const t = jira.get(key); return t ? { status: t.status, updated: t.updated } : undefined; },
    move: async (key, status) => {
      if (key === 'PROJ-2' && status === 'Blocked') throw new Error('no path to Blocked');
      const t = jira.get(key)!; t.status = status; t.updated = 't2'; deps.moved.push(`${key}→${status}`); return 'moved';
    },
    setField: async (key, field, value, operation) => {
      const sign = operation === 'add' ? '+=' : operation === 'remove' ? '-=' : '=';
      deps.fields.push(`${key}.${field}${sign}${value}`); jira.get(key)!.updated = 't2'; return 'set';
    },
    cleanupRules: async () => [],
    workflowGraph: async () => undefined,
    doneStatuses: async () => undefined,
    resolutions: async () => [],
    now: () => 1000,
  };
  return deps;
}

type ListSession = Session<TicketListRecipe, TicketListData, TicketListWorking>;

async function open(deps: Fake, input: unknown = { jql: 'project = PROJ' }): Promise<ListSession> {
  const validated = await ticketListKind.validate(input, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: 'a'.repeat(24), kind: 'ticket-list', formatVersion: 1, revision: 1, createdAt: 0, lastUsedAt: 0, recipe: validated.recipe,
    derived: await ticketListKind.read(validated.recipe, deps), working: ticketListKind.initialWorking(validated.recipe),
  };
}

function act(session: ListSession, action: TicketListAction): ListSession {
  const reduced = ticketListKind.reduce(session, action);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

async function apply(session: ListSession, deps: Fake) {
  const planned = ticketListKind.plan!(session, { type: 'apply' });
  if (!planned.ok) throw new Error(planned.reason);
  const applied = await ticketListKind.apply!(session, planned.plan, deps);
  return { plan: planned.plan, applied, session: { ...session, derived: applied.derived, working: applied.working } as ListSession };
}

describe('asking for a ticket list', () => {
  it('opens for a JQL query with nothing selected and no change', async () => {
    const view = ticketListKind.view(await open(fake()));
    expect(view.rows.map(r => r.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(view.rows[0].url).toBe('https://jira.example.com/browse/PROJ-1');
    expect(view).toMatchObject({ selectedCount: 0, change: null, proposed: false, jql: 'project = PROJ' });
  });

  it('offers to view the whole query in Jira', async () => {
    const view = ticketListKind.view(await open(fake(), { jql: 'project = PROJ AND status = "In Progress"' }));
    expect(view.jiraUrl).toBe('https://jira.example.com/issues/?jql=project%20%3D%20PROJ%20AND%20status%20%3D%20%22In%20Progress%22');
    const filtered = ticketListKind.view(await open(fake(), { filter: 'mine' }));
    expect(filtered.jiraUrl).toBe('https://jira.example.com/issues/?filter=42');
  });

  it('offers no Jira link when the Jira base URL is unknown', async () => {
    const view = ticketListKind.view(await open({ ...fake(), baseUrl: async () => undefined }));
    expect(view.jiraUrl).toBeNull();
  });

  it('opens for a saved filter by name and is titled after it', async () => {
    const session = await open(fake(), { filter: 'mine' });
    expect(ticketListKind.title(session.recipe)).toBe('Tickets: filter "My open tickets"');
    expect(ticketListKind.sourceKey(session.recipe)).toBe('filter:42');
  });

  it('opens with a proposed change filled in and every row selected', async () => {
    const view = ticketListKind.view(await open(fake(), { jql: 'project = PROJ', change: { type: 'transition', status: 'Closed' } }));
    expect(view).toMatchObject({ selectedCount: 3, proposed: true, change: { type: 'transition', status: 'Closed' } });
  });

  it('says why it cannot open', async () => {
    const deps = fake();
    expect(await ticketListKind.validate({}, deps)).toMatchObject({ ok: false });
    expect(await ticketListKind.validate({ jql: 'a', filter: 'b' }, deps)).toMatchObject({ ok: false });
    expect(await ticketListKind.validate({ filter: 'nope' }, deps)).toEqual({ ok: false, reason: 'No saved filters found matching "nope".' });
    expect(await ticketListKind.validate({ jql: 'a', change: { type: 'delete' } }, deps)).toMatchObject({ ok: false });
    expect(await ticketListKind.validate({ jql: 'a' }, { ...deps, jiraConfigured: async () => false })).toMatchObject({ ok: false, reason: expect.stringContaining('Jira is not set up') });
  });

  it('treats the same query in other spacing or case as the same list', async () => {
    const a = await open(fake(), { jql: 'project = PROJ  AND status = Open' });
    const b = await open(fake(), { jql: 'PROJECT = proj and STATUS = open' });
    expect(ticketListKind.sourceKey(a.recipe)).toBe(ticketListKind.sourceKey(b.recipe));
  });
});

describe('selecting and choosing a change', () => {
  it('selects and deselects rows, all and none', async () => {
    let s = await open(fake());
    s = act(s, { type: 'select', key: 'PROJ-2', on: true });
    expect(ticketListKind.view(s).rows.filter(r => r.selected).map(r => r.key)).toEqual(['PROJ-2']);
    s = act(s, { type: 'select-all' });
    s = act(s, { type: 'select', key: 'PROJ-1', on: false });
    expect(ticketListKind.view(s).rows.filter(r => r.selected).map(r => r.key)).toEqual(['PROJ-2', 'PROJ-3']);
    expect(ticketListKind.view(act(s, { type: 'select-none' })).selectedCount).toBe(0);
  });

  it('refuses a ticket that is not on the board, and a change it does not know', async () => {
    const s = await open(fake());
    expect(ticketListKind.reduce(s, { type: 'select', key: 'OTHER-1', on: true }).ok).toBe(false);
    expect(ticketListKind.reduce(s, { type: 'change', change: { type: 'field', field: 'labels', value: '' } }).ok).toBe(false);
  });

  it('stops calling a change proposed once the developer sets it', async () => {
    let s = await open(fake(), { jql: 'project = PROJ', change: { type: 'transition', status: 'Closed' } });
    s = act(s, { type: 'change', change: { type: 'transition', status: 'In Review' } });
    expect(ticketListKind.view(s)).toMatchObject({ proposed: false, change: { type: 'transition', status: 'In Review' } });
  });

  it('sorts ticket keys by number, not as text', async () => {
    const deps = fake([row(10), row(9), row(100)]);
    const s = act(await open(deps), { type: 'sort', column: 'key' });
    expect(ticketListKind.view(s).rows.map(r => r.key)).toEqual(['PROJ-9', 'PROJ-10', 'PROJ-100']);
  });
});

describe('previewing a change', () => {
  it('lists exactly what is written to each selected ticket', async () => {
    let s = await open(fake());
    s = act(act(s, { type: 'select', key: 'PROJ-1', on: true }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const planned = ticketListKind.plan!(s, { type: 'apply' });
    expect(planned).toMatchObject({ ok: true, plan: { title: 'Move 1 ticket(s) to In Review', lines: [{ target: 'PROJ-1', change: 'Status: Open → In Review' }], risky: false } });
  });

  it('needs the VS Code confirmation for more than one ticket, and for closing even one', async () => {
    let s = await open(fake());
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    expect(ticketListKind.plan!(s, { type: 'apply' })).toMatchObject({ ok: true, plan: { risky: true } });

    let one = await open(fake());
    one = act(act(one, { type: 'select', key: 'PROJ-1', on: true }), { type: 'change', change: { type: 'transition', status: 'Closed', resolution: 'Fixed' } });
    const planned = ticketListKind.plan!(one, { type: 'apply' });
    expect(planned).toMatchObject({ ok: true, plan: { risky: true, lines: [{ target: 'PROJ-1', change: 'Status: Open → Closed, resolution Fixed' }] } });
  });

  it('refuses without a change or without a selection', async () => {
    const s = await open(fake());
    expect(ticketListKind.plan!(act(s, { type: 'select-all' }), { type: 'apply' })).toMatchObject({ ok: false, reason: expect.stringContaining('Choose a change') });
    expect(ticketListKind.plan!(act(s, { type: 'change', change: { type: 'transition', status: 'Done' } }), { type: 'apply' })).toMatchObject({ ok: false, reason: 'Select at least one ticket.' });
  });
});

describe('applying a change', () => {
  it('moves the selected tickets, shows the result per ticket and the statuses Jira holds now', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(act(s, { type: 'select', key: 'PROJ-1', on: true }), { type: 'select', key: 'PROJ-2', on: true }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const { applied, session } = await apply(s, deps);
    expect(deps.moved).toEqual(['PROJ-1→In Review', 'PROJ-2→In Review']);
    expect(applied.results).toEqual([{ target: 'PROJ-1', outcome: 'done' }, { target: 'PROJ-2', outcome: 'done' }]);
    const view = ticketListKind.view(session);
    expect(view.rows.map(r => r.status)).toEqual(['In Review', 'In Review', 'Done']);
    expect(view.rows[0].result).toEqual({ outcome: 'done' });
    expect(view.selectedCount).toBe(0);
  });

  it('does not write to a ticket that changed in Jira since the board read it, and names it', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    Object.assign(deps.jira.get('PROJ-2')!, { status: 'In Progress', updated: 't9' });
    const { applied } = await apply(s, deps);
    expect(deps.fields).toEqual(['PROJ-1.labels=cleanup', 'PROJ-3.labels=cleanup']);
    expect(applied.results[1]).toEqual({ target: 'PROJ-2', outcome: 'refused', reason: 'changed in Jira since the board read it' });
    // The list was read again after the writes, so the view is current and the refused ticket can be selected once more.
    expect(applied.working.outOfDate).toBeNull();
    const again = { ...s, derived: applied.derived, working: applied.working } as ListSession;
    expect(ticketListKind.view(again).rows.find(r => r.key === 'PROJ-2')).toMatchObject({ status: 'In Progress', updated: 't9' });
    expect(ticketListKind.reduce(again, { type: 'select', key: 'PROJ-2', on: true })).toMatchObject({ ok: true });
  });

  it('marks the list out of date when a ticket changed and the list could not be read again afterwards', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    Object.assign(deps.jira.get('PROJ-2')!, { status: 'In Progress', updated: 't9' });
    deps.search = async () => { throw new Error('Jira answered 503'); };
    const { applied } = await apply(s, deps);
    expect(applied.working.outOfDate).toEqual({ changed: ['PROJ-2'], gone: [], added: 0 });
    const stale = { ...s, derived: applied.derived, working: applied.working } as ListSession;
    expect(ticketListKind.plan!(stale, { type: 'apply' })).toMatchObject({ ok: false, reason: expect.stringContaining('Refresh') });
  });

  it('does not mark the list out of date for a ticket Jira refused for another reason', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select', key: 'PROJ-2', on: true }), { type: 'change', change: { type: 'transition', status: 'Blocked' } });
    deps.search = async () => { throw new Error('Jira answered 503'); };
    const { applied } = await apply(s, deps);
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-2', outcome: 'failed' })]);
    expect(applied.working.outOfDate).toBeNull();
  });

  it('writes a ticket whose update time Jira now spells another way but is the same moment', async () => {
    const deps = fake([row(1, 'Open', '2026-05-01T10:00:00.000+0100')]);
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    deps.jira.get('PROJ-1')!.updated = '2026-05-01T10:00:00.000+01:00';
    const { applied } = await apply(s, deps);
    expect(deps.fields).toEqual(['PROJ-1.labels=cleanup']);
    expect(applied.results).toEqual([{ target: 'PROJ-1', outcome: 'done' }]);
  });

  it('logs the ticket and both update times when it refuses a ticket that changed', async () => {
    const deps = fake();
    const logs: Array<{ level: string; message: string; details?: unknown }> = [];
    deps.onDiag = (level, message, details) => { logs.push({ level, message, details }); };
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    Object.assign(deps.jira.get('PROJ-2')!, { updated: 't9' });
    await apply(s, deps);
    expect(logs.filter(l => l.level === 'warn').map(l => l.details)).toEqual([{ key: 'PROJ-2', stored: 't1', current: 't9' }]);
  });

  it('reads each ticket before and after writing it while the board checks before writing', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    await apply(s, deps);
    expect(deps.reads).toBe(6);
  });

  it('writes without reading any ticket first or after when the board does not check, even one that changed', async () => {
    const deps = fake();
    deps.check = false;
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup' } });
    Object.assign(deps.jira.get('PROJ-2')!, { updated: 't9' });
    const { applied } = await apply(s, deps);
    expect(deps.reads).toBe(0);
    expect(deps.fields).toEqual(['PROJ-1.labels=cleanup', 'PROJ-2.labels=cleanup', 'PROJ-3.labels=cleanup']);
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'done', 'done']);
  });

  it('reports a ticket Jira refused and goes on with the others', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'Blocked' } });
    const { applied } = await apply(s, deps);
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'failed', 'done']);
    expect(applied.results[1].reason).toBe('no path to Blocked');
  });

  it('refuses a ticket that no longer exists', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select', key: 'PROJ-1', on: true }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    deps.jira.delete('PROJ-1');
    const { applied } = await apply(s, deps);
    expect(applied.results).toEqual([{ target: 'PROJ-1', outcome: 'refused', reason: 'no longer exists in Jira' }]);
  });
});

describe('a list checked against Jira', () => {
  it('says by itself that it is out of date, keeps the rows on show and allows only paging', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'Closed' } });
    Object.assign(deps.jira.get('PROJ-1')!, { status: 'Done', updated: 't9' });
    deps.jira.delete('PROJ-3');
    const merged = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'background');
    const checked = { ...s, derived: merged.derived, working: merged.working };
    const view = ticketListKind.view(checked);
    expect(view.outOfDate).toEqual({ changed: ['PROJ-1'], gone: ['PROJ-3'], added: 0 });
    expect(view.rows.map(r => `${r.key} ${r.status}`)).toEqual(['PROJ-1 Open', 'PROJ-2 Open', 'PROJ-3 Done']);
    expect(ticketListKind.reduce(checked, { type: 'select', key: 'PROJ-1', on: false })).toMatchObject({ ok: false, reason: expect.stringContaining('Refresh') });
    expect(ticketListKind.plan!(checked, { type: 'apply' })).toMatchObject({ ok: false, reason: expect.stringContaining('Refresh') });
    expect(ticketListKind.reduce(checked, { type: 'page', page: 0 })).toMatchObject({ ok: true });
  });

  it('takes the fresh rows on Refresh, keeps the selection of tickets still listed and drops the rest', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select', key: 'PROJ-1', on: true }), { type: 'select', key: 'PROJ-3', on: true });
    Object.assign(deps.jira.get('PROJ-1')!, { status: 'Done', updated: 't9' });
    deps.jira.delete('PROJ-3');
    const background = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'background');
    const stale = { ...s, derived: background.derived, working: background.working };
    const refreshed = ticketListKind.reconcile(stale, await ticketListKind.read(s.recipe, deps), 'refresh');
    const view = ticketListKind.view({ ...s, derived: refreshed.derived, working: refreshed.working });
    expect(view.outOfDate).toBeNull();
    expect(view.rows.map(r => `${r.key} ${r.status} ${r.selected}`)).toEqual(['PROJ-1 Done true', 'PROJ-2 Open false']);
    expect(view.selectedCount).toBe(1);
  });

  it('is out of date when a ticket newly matches the query, and applies nothing until Refresh', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'Closed' } });
    deps.jira.set('PROJ-9', { ...deps.jira.get('PROJ-2')!, key: 'PROJ-9', summary: 'Ticket PROJ-9' });
    const merged = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'background');
    const checked = { ...s, derived: merged.derived, working: merged.working };
    const view = ticketListKind.view(checked);
    expect(view.outOfDate).toEqual({ changed: [], gone: [], added: 1 });
    expect(view.rows.map(r => r.key)).not.toContain('PROJ-9');
    expect(ticketListKind.plan!(checked, { type: 'apply' })).toMatchObject({ ok: false, reason: expect.stringContaining('Refresh') });
  });

  it('stays up to date when nothing changed', async () => {
    const deps = fake();
    const s = await open(deps);
    const merged = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'background');
    expect(merged.working.outOfDate).toBeNull();
  });
});

describe('extra columns from the settings', () => {
  it('shows the search columns for a query, with each ticket\'s value', async () => {
    const view = ticketListKind.view(await open(fake()));
    expect(view.columns).toEqual([{ id: 'customfield_1', name: 'Team' }]);
    expect(view.rows[0].extra?.customfield_1).toBe('customfield_1 of PROJ-1');
  });

  it('shows the cleanup columns when the board opens with a proposed move, and keeps them when the change is edited', async () => {
    let s = await open(fake(), { jql: 'project = PROJ', change: { type: 'transition', status: 'Closed' } });
    expect(ticketListKind.view(s).columns).toEqual([{ id: 'fixVersions', name: 'Fix versions' }]);
    s = act(s, { type: 'change', change: { type: 'field', field: 'labels', value: 'x' } });
    expect(ticketListKind.view(s).columns).toEqual([{ id: 'fixVersions', name: 'Fix versions' }]);
  });

  it('switches to the cleanup columns when the same list is asked for again with a proposed move', async () => {
    const deps = fake();
    const s = await open(deps);
    const again = await ticketListKind.validate({ jql: 'project = PROJ', change: { type: 'transition', status: 'Done' } }, deps);
    const working = ticketListKind.reopen!(s, (again as { recipe: TicketListRecipe }).recipe);
    expect(ticketListKind.view({ ...s, working }).columns).toEqual([{ id: 'fixVersions', name: 'Fix versions' }]);
  });
});

describe('sorting the extra columns and Assignee', () => {
  const owned = (n: number, assignee: string, team: string): TicketRow => ({ ...row(n), assignee, extra: { customfield_1: team } });
  const withTeams = (rows: TicketRow[]): Fake => {
    const deps = fake(rows);
    deps.search = async () => ({ rows: [...deps.jira.values()].map(r => ({ ...r })), truncated: false });
    return deps;
  };
  const keysAfter = async (deps: Fake, column: string, clicks: number): Promise<string[]> => {
    let s = await open(deps);
    for (let i = 0; i < clicks; i++) s = act(s, { type: 'sort', column: column as never });
    return ticketListKind.view(s).rows.map(r => r.key);
  };
  const ROWS = [owned(1, 'Team 10', 'Team 10'), owned(2, 'Team 2', 'Team 2'), owned(3, '', '')];

  it('sorts an extra column in natural order with the empty value last, either way round', async () => {
    expect(await keysAfter(withTeams(ROWS), 'extra:customfield_1', 1)).toEqual(['PROJ-2', 'PROJ-1', 'PROJ-3']);
    expect(await keysAfter(withTeams(ROWS), 'extra:customfield_1', 2)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(await keysAfter(withTeams(ROWS), 'extra:customfield_1', 3)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('puts an unassigned ticket last when sorting by assignee, either way round', async () => {
    expect(await keysAfter(withTeams(ROWS), 'assignee', 1)).toEqual(['PROJ-2', 'PROJ-1', 'PROJ-3']);
    expect(await keysAfter(withTeams(ROWS), 'assignee', 2)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });

  it('sorts the whole list before it is paged, and starts again on the first page', async () => {
    const many = Array.from({ length: 60 }, (_, i) => owned(i + 1, 'Ada', `Team ${60 - i}`));
    let s = await open(withTeams(many));
    s = act(s, { type: 'page', page: 1 });
    expect(ticketListKind.view(s)).toMatchObject({ page: 1 });
    s = act(s, { type: 'sort', column: 'extra:customfield_1' as never });
    const view = ticketListKind.view(s);
    expect(view.page).toBe(0);
    expect(view.rows[0].key).toBe('PROJ-60');
    expect(view.rows[1].key).toBe('PROJ-59');
  });

  it('refuses a column the board does not show', async () => {
    const s = await open(withTeams(ROWS));
    expect(ticketListKind.reduce(s, { type: 'sort', column: 'extra:nope' as never }).ok).toBe(false);
    expect(ticketListKind.reduce(s, { type: 'sort', column: 'extra:fixVersions' as never }).ok).toBe(false);
  });

  it('drops a sort on an extra column when the board switches to the other column set', async () => {
    const deps = withTeams(ROWS);
    const sorted = act(await open(deps), { type: 'sort', column: 'extra:customfield_1' as never });
    const again = await ticketListKind.validate({ jql: 'project = PROJ', change: { type: 'transition', status: 'Done' } }, deps);
    const working = ticketListKind.reopen!(sorted, (again as { recipe: TicketListRecipe }).recipe);
    const view = ticketListKind.view({ ...sorted, working });
    expect(view.sort).toBeNull();
    expect(view.rows.map(r => r.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
  });
});

describe('paging', () => {
  const many = () => fake(Array.from({ length: 120 }, (_, i) => row(i + 1)));

  it('shows 50 tickets a page and the last page with the rest', async () => {
    const s = await open(many());
    expect(ticketListKind.view(s)).toMatchObject({ totalRows: 120, page: 0, pageCount: 3 });
    expect(ticketListKind.view(s).rows.map(r => r.key).slice(0, 2)).toEqual(['PROJ-1', 'PROJ-2']);
    const last = act(s, { type: 'page', page: 2 });
    expect(ticketListKind.view(last).rows.map(r => r.key)).toEqual(Array.from({ length: 20 }, (_, i) => `PROJ-${101 + i}`));
    expect(ticketListKind.view(act(s, { type: 'page', page: 9 })).page).toBe(2);
  });

  it('keeps the selection across pages and plans every selected ticket, named in the confirmation', async () => {
    let s = await open(many());
    s = act(act(s, { type: 'select-all' }), { type: 'select', key: 'PROJ-60', on: false });
    s = act(act(s, { type: 'page', page: 2 }), { type: 'change', change: { type: 'transition', status: 'Done' } });
    expect(ticketListKind.view(s).selectedCount).toBe(119);
    const planned = ticketListKind.plan!(s, { type: 'apply' });
    expect(planned).toMatchObject({ ok: true, plan: { title: 'Move 119 ticket(s) to Done', risky: true } });
    expect((planned as { plan: { lines: unknown[] } }).plan.lines).toHaveLength(119);
  });
});

describe('changing single values of a list field', () => {
  it('adds or removes a value and keeps the others', async () => {
    const deps = fake();
    let s = act(await open(deps), { type: 'select', key: 'PROJ-1', on: true });
    s = act(s, { type: 'change', change: { type: 'field', field: 'labels', value: 'cleanup', operation: 'add' } });
    const added = await apply(s, deps);
    expect(added.plan).toMatchObject({ title: 'Add to labels on 1 ticket(s)', lines: [{ target: 'PROJ-1', change: 'Add "cleanup" to labels' }] });
    let t = act(act(added.session, { type: 'select', key: 'PROJ-2', on: true }), { type: 'change', change: { type: 'field', field: 'labels', value: 'old', operation: 'remove' } });
    t = (await apply(t, deps)).session;
    expect(deps.fields).toEqual(['PROJ-1.labels+=cleanup', 'PROJ-2.labels-=old']);
  });

  it('refuses an operation it does not know, and an empty value', async () => {
    const s = await open(fake());
    expect(ticketListKind.reduce(s, { type: 'change', change: { type: 'field', field: 'labels', value: 'x', operation: 'toggle' } as never })).toMatchObject({ ok: false });
    expect(ticketListKind.reduce(s, { type: 'change', change: { type: 'field', field: 'labels', value: ' ', operation: 'add' } })).toMatchObject({ ok: false });
  });
});

describe('asking for the same list again', () => {
  it('lays a newly proposed change over the session and selects every row', async () => {
    const deps = fake();
    const s = act(await open(deps), { type: 'select', key: 'PROJ-1', on: true });
    const again = await ticketListKind.validate({ jql: 'project = PROJ', change: { type: 'field', field: 'labels', value: 'x' } }, deps);
    const working = ticketListKind.reopen!(s, (again as { recipe: TicketListRecipe }).recipe);
    expect(working).toMatchObject({ proposed: true, change: { type: 'field', field: 'labels', value: 'x' }, selection: { mode: 'all', except: [] } });
  });

  it('changes nothing when no change is proposed', async () => {
    const deps = fake();
    const s = act(await open(deps), { type: 'select', key: 'PROJ-1', on: true });
    const again = await ticketListKind.validate({ jql: 'project = PROJ' }, deps);
    expect(ticketListKind.reopen!(s, (again as { recipe: TicketListRecipe }).recipe)).toBe(s.working);
  });
});

describe('an Apply interrupted and the board restored', () => {
  /** Runs the plan until `stopAfter` tickets are finished, as if the window closed then; returns the last saved working state. */
  async function interruptedApply(session: ListSession, deps: Fake, stopAfter: number): Promise<{ working: TicketListWorking; reports: ApplyProgressReport<TicketListWorking>[] }> {
    const planned = ticketListKind.plan!(session, { type: 'apply' });
    if (!planned.ok) throw new Error(planned.reason);
    const reports: ApplyProgressReport<TicketListWorking>[] = [];
    await expect(ticketListKind.apply!(session, planned.plan, deps, async report => {
      reports.push(report);
      if (reports.length === stopAfter) throw new Error('The window closed.');
    })).rejects.toThrow('The window closed.');
    return { working: reports[reports.length - 1].working, reports };
  }

  const five = () => fake([row(1), row(2), row(3), row(4), row(5)]);

  it('shows the tickets moved before the interruption as done, is not out of date, and a new plan lists only the rest', async () => {
    const deps = five();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const { working, reports } = await interruptedApply(s, deps, 2);
    expect(reports.map(r => [r.done, r.total])).toEqual([[1, 5], [2, 5]]);
    expect(deps.moved).toEqual(['PROJ-1→In Review', 'PROJ-2→In Review']);

    // Restored: the rows as the board read them before the Apply, with the saved working state.
    const restored: ListSession = { ...s, working };
    const checked = ticketListKind.reconcile(restored, await ticketListKind.read(s.recipe, deps), 'background');
    expect(checked.working.outOfDate).toBeNull();
    const shown = { ...restored, derived: checked.derived, working: checked.working };
    const view = ticketListKind.view(shown);
    expect(view.rows.map(r => `${r.key} ${r.status} ${r.result?.outcome ?? '-'}`)).toEqual([
      'PROJ-1 In Review done', 'PROJ-2 In Review done', 'PROJ-3 Open -', 'PROJ-4 Open -', 'PROJ-5 Open -',
    ]);
    const planned = ticketListKind.plan!(shown, { type: 'apply' });
    expect(planned.ok && planned.plan.lines.map(l => l.target)).toEqual(['PROJ-3', 'PROJ-4', 'PROJ-5']);
  });

  it('does not call a ticket it moved changed when the search spells its new update time another way', async () => {
    const deps = five();
    const move = deps.move;
    deps.move = async (key, status, resolution) => {
      const note = await move(key, status, resolution);
      deps.jira.get(key)!.updated = '2026-05-01T11:00:00.000+0100';
      return note;
    };
    deps.search = async () => ({
      rows: [...deps.jira.values()].map(r => ({ ...r, updated: r.updated.replace(/([+-]\d\d)(\d\d)$/, '$1:$2') })),
      truncated: false,
    });
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const { working } = await interruptedApply(s, deps, 2);
    const checked = ticketListKind.reconcile({ ...s, working }, await ticketListKind.read(s.recipe, deps), 'background');
    expect(checked.working.outOfDate).toBeNull();
  });

  it('is out of date when a ticket it moved was changed again in Jira by someone else', async () => {
    const deps = five();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const { working } = await interruptedApply(s, deps, 2);
    Object.assign(deps.jira.get('PROJ-1')!, { status: 'Done', updated: 't7' });
    const checked = ticketListKind.reconcile({ ...s, working }, await ticketListKind.read(s.recipe, deps), 'background');
    expect(checked.working.outOfDate).toEqual({ changed: ['PROJ-1'], gone: [], added: 0 });
  });

  it('does not count a ticket it moved out of the query as gone', async () => {
    const deps = five();
    deps.search = async () => ({ rows: [...deps.jira.values()].filter(r => r.status === 'Open').map(r => ({ ...r })), truncated: false });
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    const { working } = await interruptedApply(s, deps, 2);
    const checked = ticketListKind.reconcile({ ...s, working }, await ticketListKind.read(s.recipe, deps), 'background');
    expect(checked.working.outOfDate).toBeNull();
    expect(ticketListKind.view({ ...s, derived: checked.derived, working: checked.working }).rows.map(r => r.key)).toEqual(['PROJ-3', 'PROJ-4', 'PROJ-5']);
  });

  it('keeps the recorded results of the tickets still listed through a Refresh', async () => {
    const deps = fake();
    let s = await open(deps);
    s = act(act(s, { type: 'select-all' }), { type: 'change', change: { type: 'transition', status: 'In Review' } });
    s = (await apply(s, deps)).session;
    deps.jira.delete('PROJ-3');
    const refreshed = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'refresh');
    const view = ticketListKind.view({ ...s, derived: refreshed.derived, working: refreshed.working });
    expect(view.rows.map(r => `${r.key} ${r.result?.outcome ?? '-'}`)).toEqual(['PROJ-1 done', 'PROJ-2 done']);
    expect(Object.keys(refreshed.working.results)).toEqual(['PROJ-1', 'PROJ-2']);
  });
});

describe('a stored ticket list of an older format', () => {
  it('is rebuilt from its query instead of failing', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-ticket-list-'));
    try {
      const deps = fake();
      const store = new SessionStore(dir);
      const session = await open(deps);
      const id = sessionIdFor('ticket-list', ticketListKind.sourceKey(session.recipe));
      await store.save({ ...session, id, formatVersion: ticketListKind.formatVersion - 1, working: { selected: ['PROJ-1'] } as never });
      const manager = new SessionManager({
        store, kinds: [registerKind(ticketListKind, () => deps)], now: () => 1000, confirm: async () => true, saveFile: async () => true,
      });
      let state = await manager.state('ticket-list', id);
      while (state.status !== 'ready' && state.status !== 'failed') state = await manager.state('ticket-list', id, state.tick, 1000);
      expect(state.status).toBe('ready');
      expect(state.notice).toMatch(/rebuilt after an update/);
      expect((state.view as { rows: { key: string }[]; selectedCount: number }).rows.map(r => r.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
      expect((state.view as { selectedCount: number }).selectedCount).toBe(0);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('checks that its filter or cleanup rule still resolves', async () => {
    const deps = fake();
    expect(await ticketListKind.revalidate!({ source: { type: 'filter', id: '42', name: 'Old name', jql: 'x' } }, deps))
      .toEqual({ ok: true, recipe: { source: { type: 'filter', id: '42', name: 'My open tickets', jql: 'assignee = currentUser()' } } });
    expect(await ticketListKind.revalidate!({ source: { type: 'filter', id: '7', name: 'Gone', jql: 'x' } }, deps)).toMatchObject({ ok: false });
    expect(await ticketListKind.revalidate!({ source: { type: 'rule', name: 'Old rule' } }, deps)).toMatchObject({ ok: false });
    expect(await ticketListKind.revalidate!({ query: 'project = PROJ' }, deps)).toMatchObject({ ok: false });
  });
});

describe('a saved filter whose query changes in Jira', () => {
  /**
   * A Jira with one saved filter, id 42, whose query and name the test changes. A search lists the
   * tickets a `key in (…)` query names; `filter = 42` stands for the filter's query as Jira holds it
   * now, and fails once the filter is deleted. The sort clause decides the order.
   */
  function filterJira() {
    const filter = { id: '42', name: 'My open tickets', jql: 'key in (PROJ-1, PROJ-2)', deleted: false };
    const all = [row(1), row(2), row(3), row(4)];
    const searched: string[] = [];
    const deps: Fake = {
      ...fake(all),
      resolveFilter: async name => (filter.deleted || (name !== '42' && name !== 'mine')
        ? `no saved filter matches "${name}".` : { id: filter.id, name: filter.name, jql: filter.jql }),
      search: async jql => {
        searched.push(jql);
        if (/^filter = 42\b/.test(jql) && filter.deleted) throw new Error("Jira answered 400: The value '42' does not exist for the field 'filter'.");
        const query = jql.replace(/^filter = 42\b/, filter.jql);
        const keys = /key in \(([^)]*)\)/.exec(query)?.[1].split(',').map(k => k.trim()) ?? [];
        const rows = all.filter(r => keys.includes(r.key));
        return { rows: /ORDER BY key DESC/.test(jql) ? rows.reverse() : rows, truncated: false };
      },
    };
    return { deps, filter, searched };
  }

  it('lists the filter\'s current tickets after Refresh', async () => {
    const { deps, filter } = filterJira();
    const s = await open(deps, { filter: 'mine' });
    filter.jql = 'key in (PROJ-3, PROJ-4)';
    filter.name = 'My tickets';

    const background = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'background');
    expect(background.working.outOfDate).toMatchObject({ gone: ['PROJ-1', 'PROJ-2'], added: 2, queryChanged: true });

    const refreshed = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, deps), 'refresh');
    const view = ticketListKind.view({ ...s, derived: refreshed.derived, working: refreshed.working });
    expect(view.rows.map(r => r.key)).toEqual(['PROJ-3', 'PROJ-4']);
    expect(view).toMatchObject({ jql: 'key in (PROJ-3, PROJ-4)', title: 'Tickets: filter "My tickets"', outOfDate: null, queryUnread: false });
    expect(view.jiraUrl).toBe('https://jira.example.com/issues/?filter=42');
  });

  it('asks Jira for the filter itself, in the order its query sorts by', async () => {
    const { deps, filter, searched } = filterJira();
    filter.jql = 'key in (PROJ-1, PROJ-2) ORDER BY key DESC';
    const view = ticketListKind.view(await open(deps, { filter: 'mine' }));
    expect(searched).toEqual(['filter = 42 ORDER BY key DESC']);
    expect(view.rows.map(r => r.key)).toEqual(['PROJ-2', 'PROJ-1']);
  });

  it('still lists the filter\'s current tickets when its query cannot be read, and says the query shown is the old one', async () => {
    const { deps, filter } = filterJira();
    const s = await open(deps, { filter: 'mine' });
    filter.jql = 'key in (PROJ-4)';
    const flaky: Fake = { ...deps, resolveFilter: async () => 'the saved filter could not be read: Jira did not answer in time' };
    const refreshed = ticketListKind.reconcile(s, await ticketListKind.read(s.recipe, flaky), 'refresh');
    const view = ticketListKind.view({ ...s, derived: refreshed.derived, working: refreshed.working });
    expect(view.rows.map(r => r.key)).toEqual(['PROJ-4']);
    expect(view).toMatchObject({ jql: 'key in (PROJ-1, PROJ-2)', queryUnread: true });
  });

  it('says the list is out of date when the filter is asked for again with a new query', async () => {
    const { deps, filter } = filterJira();
    const s = await open(deps, { filter: 'mine' });
    filter.jql = 'key in (PROJ-1, PROJ-2, PROJ-3)';
    const again = await ticketListKind.validate({ filter: 'mine' }, deps);
    const working = ticketListKind.reopen!(s, (again as { recipe: TicketListRecipe }).recipe);
    expect(working.outOfDate).toEqual({ changed: [], gone: [], added: 0, queryChanged: true });
    expect(ticketListKind.reduce({ ...s, working }, { type: 'select-all' })).toMatchObject({ ok: false });

    const refreshed = ticketListKind.reconcile({ ...s, working }, await ticketListKind.read(s.recipe, deps), 'refresh');
    expect(refreshed.derived.data.rows.map(r => r.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(refreshed.working.outOfDate).toBeNull();
  });

  it('keeps the board as it is when the filter is asked for again unchanged', async () => {
    const { deps } = filterJira();
    const s = await open(deps, { filter: 'mine' });
    const again = await ticketListKind.validate({ filter: 'mine' }, deps);
    expect(ticketListKind.reopen!(s, (again as { recipe: TicketListRecipe }).recipe)).toBe(s.working);
  });

  it('fails the reading, instead of using the old query, when the filter was deleted', async () => {
    const { deps, filter, searched } = filterJira();
    const s = await open(deps, { filter: 'mine' });
    filter.deleted = true;
    await expect(ticketListKind.read(s.recipe, deps)).rejects.toThrow("The value '42' does not exist");
    expect(searched).toEqual(['filter = 42', 'filter = 42']);
  });
});

describe('a board on one of Jira\'s built-in filters', () => {
  it('opens filter -1 on its JQL, titled after it, with View in Jira on the filter', async () => {
    const searched: string[] = [];
    const base = fake();
    const deps: Fake = {
      ...base,
      resolveFilter: async name => (name === '-1' ? { id: '-1', name: 'My open issues', jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC', system: true } : 'unknown'),
      search: async (jql, limit, ids) => { searched.push(jql); return base.search(jql, limit, ids); },
    };
    const view = ticketListKind.view(await open(deps, { filter: '-1' }));
    expect(searched).toEqual(['assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC']);
    expect(view).toMatchObject({ title: 'Tickets: filter "My open issues"', jiraUrl: 'https://jira.example.com/issues/?filter=-1', queryUnread: false });
  });
});

describe('the check before writing as a setting of the board', () => {
  it('is on until the developer turns it off, and says so', async () => {
    const deps = fake();
    expect(await ticketListKind.preferences!.read(deps)).toEqual({ checkBeforeWrite: true });
    expect(await ticketListKind.preferences!.write('checkBeforeWrite', false, deps)).toBeUndefined();
    expect(deps.check).toBe(false);
    expect(await ticketListKind.preferences!.read(deps)).toEqual({ checkBeforeWrite: false });
  });

  it('takes nothing else: no other name, and only on or off', async () => {
    const deps = fake();
    expect(await ticketListKind.preferences!.write('somethingElse', true, deps)).toEqual(expect.any(String));
    expect(await ticketListKind.preferences!.write('checkBeforeWrite', 'no', deps)).toEqual(expect.any(String));
    expect(deps.check).toBe(true);
  });
});
