import { describe, it, expect } from 'vitest';
import {
  ticketListKind, type TicketListData, type TicketListDeps, type TicketListRecipe, type TicketListWorking, type TicketRow, type TicketListAction,
} from '../boards/ticketList/kind';
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
}

function fake(rows: TicketRow[] = [row(1), row(2), row(3, 'Done')]): Fake {
  const jira = new Map(rows.map(r => [r.key, { ...r }]));
  const deps: Fake = {
    jira, moved: [], fields: [],
    jiraConfigured: async () => true,
    baseUrl: async () => 'https://jira.example.com',
    resolveFilter: async name => (name === 'mine' ? { id: '42', name: 'My open tickets', jql: 'assignee = currentUser()' } : `No saved filters found matching "${name}".`),
    extraColumns: async () => ({ search: [{ id: 'customfield_1', name: 'Team' }], cleanup: [{ id: 'fixVersions', name: 'Fix versions' }] }),
    search: async (_jql, _limit, fieldIds) => ({
      rows: [...jira.values()].map(r => ({ ...r, extra: Object.fromEntries(fieldIds.map(id => [id, `${id} of ${r.key}`])) })),
      truncated: false,
    }),
    readTicket: async key => { const t = jira.get(key); return t ? { status: t.status, updated: t.updated } : undefined; },
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
    derived: await ticketListKind.read(validated.recipe, deps), working: ticketListKind.initialWorking(validated.recipe), conflicts: [],
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
    expect(applied.conflicts).toEqual([{ id: 'PROJ-2', target: 'PROJ-2', message: 'changed in Jira and was not written to.', stored: 'Open', fresh: 'In Progress' }]);
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
    expect(merged.conflicts).toEqual([]);
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
