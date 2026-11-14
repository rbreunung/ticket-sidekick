import { describe, it, expect } from 'vitest';
import { ticketListKind, type TicketListData, type TicketListDeps, type TicketListRecipe, type TicketListWorking, type TicketRow, type TicketListAction } from '../boards/ticketList/kind';
import { buildCleanupQuery, buildSubtaskQueries, parseFixVersionOverride } from '../boards/ticketList/cleanupSource';
import type { CleanupRule } from '../templates/TemplateService';
import type { WorkflowGraph } from '../services/WorkflowService';
import type { Session } from '../sessions/sessionTypes';

// A cleanup on the ticket list board: the developer names a rule from .jira-templates.json, sees
// the rule's tickets with their open subtasks, and moves the selected ones a page at a time.

const RULE: CleanupRule = { name: 'Close released bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', fixVersionFilter: 'released' };

function ticket(key: string, status = 'Open', extra: Partial<TicketRow> = {}): TicketRow {
  return { key, summary: `Ticket ${key}`, status, issueType: 'Bug', assignee: 'Ada', priority: 'High', updated: 't1', ...extra };
}

/** Open, In Progress and Done, and Blocked with no way out. */
const GRAPH: WorkflowGraph = {
  Open: [{ id: '1', name: 'Start', to: 'In Progress' }, { id: '2', name: 'Close', to: 'Done' }],
  'In Progress': [{ id: '3', name: 'Finish', to: 'Done' }],
  Blocked: [],
};

interface Fake extends TicketListDeps {
  jira: Map<string, TicketRow>;
  moved: string[];
  queries: string[];
  discovered: string[];
}

function fake(options: { rules?: CleanupRule[]; tickets?: TicketRow[]; graph?: WorkflowGraph | undefined; failMove?: string } = {}): Fake {
  const tickets = options.tickets ?? [ticket('PROJ-1'), ticket('PROJ-2', 'In Progress')];
  const jira = new Map(tickets.map(t => [t.key, { ...t }]));
  const deps: Fake = {
    jira, moved: [], queries: [], discovered: [],
    jiraConfigured: async () => true,
    baseUrl: async () => undefined,
    resolveFilter: async () => 'no filters here',
    extraColumns: async () => ({ search: [], cleanup: [] }),
    search: async jql => {
      deps.queries.push(jql);
      const subtasks = jql.startsWith('parent in');
      const rows = [...jira.values()].filter(t => (subtasks ? t.parent !== undefined && jql.includes(`"${t.parent}"`) : t.parent === undefined));
      return { rows: rows.map(r => ({ ...r })), truncated: false };
    },
    readTicket: async key => { const t = jira.get(key); return t ? { status: t.status, updated: t.updated } : undefined; },
    move: async (key, status, resolution) => {
      if (key === options.failMove) throw new Error('Jira refused the transition');
      const t = jira.get(key)!; t.status = status; t.updated = 't2';
      deps.moved.push(`${key}→${status}${resolution ? ` (${resolution})` : ''}`);
      return 'moved';
    },
    setField: async () => 'set',
    cleanupRules: async () => options.rules ?? [RULE],
    workflowGraph: async (project, issueType) => { deps.discovered.push(`${project}/${issueType}`); return 'graph' in options ? options.graph : GRAPH; },
    resolutions: async () => ['Fixed', "Won't Fix"],
    now: () => 1000,
  };
  return deps;
}

type ListSession = Session<TicketListRecipe, TicketListData, TicketListWorking>;

async function open(deps: Fake, input: unknown = { cleanupRule: 'Close released bugs' }): Promise<ListSession> {
  const validated = await ticketListKind.validate(input, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: 'c'.repeat(24), kind: 'ticket-list', formatVersion: 2, revision: 1, createdAt: 0, lastUsedAt: 0, recipe: validated.recipe,
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

describe('the query a cleanup rule runs', () => {
  it('anchors project, issue type, status and resolution, and adds the rule\'s fix version', () => {
    expect(buildCleanupQuery(RULE).jql).toBe('project = "PROJ" AND issuetype = "Bug" AND status != "Done" AND resolution is EMPTY AND fixVersion in releasedVersions()');
  });

  it('lets a requested fix version win over the rule\'s, in every form @jira knew', () => {
    expect(buildCleanupQuery(RULE, '3.2').jql).toContain('fixVersion = "3.2"');
    expect(buildCleanupQuery(RULE, 'unreleased').jql).toContain('fixVersion in unreleasedVersions()');
    expect(buildCleanupQuery(RULE, 'Release*').jql).toContain('fixVersion ~ "Release*"');
    expect(buildCleanupQuery(RULE, '"released"').jql).toContain('fixVersion = "released"');
    expect(buildCleanupQuery(RULE, '3.2').jql).not.toContain('releasedVersions()');
    expect(parseFixVersionOverride('  ')).toBeUndefined();
  });

  it('uses the rule\'s pattern and extra JQL, and leaves out extra JQL with ORDER BY', () => {
    const withExtra = buildCleanupQuery({ ...RULE, fixVersionFilter: undefined, fixVersionPattern: 'Release*', jql: 'labels = old' });
    expect(withExtra.jql).toBe('project = "PROJ" AND issuetype = "Bug" AND status != "Done" AND resolution is EMPTY AND fixVersion ~ "Release*" AND (labels = old)');
    const ordered = buildCleanupQuery({ ...RULE, jql: 'labels = old ORDER BY key' });
    expect(ordered.jql).not.toContain('ORDER BY');
    expect(ordered.warnings[0]).toContain('ORDER BY');
  });

  it('asks for open subtasks a hundred parents at a time', () => {
    const keys = Array.from({ length: 150 }, (_, i) => `PROJ-${i + 1}`);
    const queries = buildSubtaskQueries(keys, 'Closed');
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^parent in \("PROJ-1", .*"PROJ-100"\) AND status != "Closed" AND resolution is EMPTY$/);
  });
});

describe('opening a cleanup', () => {
  it('loads the rule\'s tickets, every one selected, moving to the rule\'s target', async () => {
    const deps = fake();
    const s = await open(deps);
    const view = ticketListKind.view(s);
    expect(view.title).toBe('Cleanup: Close released bugs');
    expect(view.jql).toContain('fixVersion in releasedVersions()');
    expect(view.rows.map(r => `${r.key} → ${r.target} ${r.selected}`)).toEqual(['PROJ-1 → Done true', 'PROJ-2 → Done true']);
    expect(view.pageOnly).toBe(true);
    expect(view.cleanup).toMatchObject({ rule: 'Close released bugs', targetState: 'Done', scope: 'released versions' });
    expect(ticketListKind.sourceKey(s.recipe)).toBe('rule:close released bugs|');
  });

  it('is a separate board per requested fix version, and finds the rule in any case', async () => {
    const s = await open(fake(), { cleanupRule: 'close RELEASED bugs', fixVersion: '3.2' });
    expect(ticketListKind.title(s.recipe)).toBe('Cleanup: Close released bugs in 3.2');
    expect(ticketListKind.sourceKey(s.recipe)).toBe('rule:close released bugs|3.2');
  });

  it('names the rules there are when the rule is unknown', async () => {
    const result = await ticketListKind.validate({ cleanupRule: 'Nope' }, fake());
    expect(result).toEqual({ ok: false, reason: 'no cleanup rule named "Nope" in .jira-templates.json. The rules there are: "Close released bugs".' });
    expect(await ticketListKind.validate({ cleanupRule: 'Nope' }, fake({ rules: [] }))).toMatchObject({ ok: false, reason: expect.stringContaining('has no cleanupRules') });
    expect(await ticketListKind.validate({ cleanupRule: 'Close released bugs', jql: 'x' }, fake())).toMatchObject({ ok: false });
  });

  it('shows open subtasks beneath their parent, with the rule\'s subtask target and resolution', async () => {
    const rule: CleanupRule = { ...RULE, closeSubtasks: true, subtaskTargetState: 'Closed', subtaskResolution: 'Done', resolution: 'Fixed' };
    const deps = fake({ rules: [rule], tickets: [ticket('PROJ-10'), ticket('PROJ-11', 'Open', { parent: 'PROJ-10', issueType: 'Sub-task' }), ticket('PROJ-12', 'Open', { parent: 'PROJ-10', issueType: 'Sub-task' })] });
    const graph: WorkflowGraph = { ...GRAPH, Open: [...GRAPH.Open, { id: '9', name: 'Shut', to: 'Closed' }] };
    deps.workflowGraph = async (p, t) => { deps.discovered.push(`${p}/${t}`); return graph; };
    const view = ticketListKind.view(await open(deps));
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].subtasks?.map(sub => `${sub.key} → ${sub.target} (${sub.resolution})`)).toEqual(['PROJ-11 → Closed (Done)', 'PROJ-12 → Closed (Done)']);
    expect(deps.queries[1]).toBe('parent in ("PROJ-10") AND status != "Closed" AND resolution is EMPTY');
    expect([...deps.discovered].sort()).toEqual(['PROJ/Bug', 'PROJ/Sub-task']);
  });

  it('cannot select a ticket with no path to the target, or whose subtask has none', async () => {
    const rule: CleanupRule = { ...RULE, closeSubtasks: true };
    const deps = fake({ rules: [rule], tickets: [ticket('PROJ-20', 'Blocked'), ticket('PROJ-30'), ticket('PROJ-31', 'Blocked', { parent: 'PROJ-30' }), ticket('PROJ-40')] });
    const s = await open(deps);
    const view = ticketListKind.view(s);
    expect(view.rows.map(r => `${r.key} ${r.selected} ${r.blocked ?? ''}`)).toEqual([
      'PROJ-20 false no path from Blocked to Done',
      'PROJ-30 false subtask PROJ-31 cannot be moved: no path from Blocked to Done',
      'PROJ-40 true ',
    ]);
    expect(view.selectedCount).toBe(1);
    expect(ticketListKind.reduce(s, { type: 'select', key: 'PROJ-20', on: true })).toMatchObject({ ok: false, reason: 'PROJ-20 cannot be moved: no path from Blocked to Done.' });
  });

  it('marks every ticket unmovable when the workflow cannot be read', async () => {
    const view = ticketListKind.view(await open(fake({ graph: undefined })));
    expect(view.rows.every(r => r.blocked?.includes('workflow could not be read'))).toBe(true);
    expect(view.selectedCount).toBe(0);
  });
});

describe('choosing tickets on a cleanup', () => {
  const withSubtasks = () => fake({ rules: [{ ...RULE, closeSubtasks: true, resolution: 'Fixed' }], tickets: [ticket('PROJ-10'), ticket('PROJ-11', 'Open', { parent: 'PROJ-10' }), ticket('PROJ-12', 'Open', { parent: 'PROJ-10' })] });

  it('selects parents only; a subtask follows its parent', async () => {
    const s = await open(withSubtasks());
    expect(ticketListKind.reduce(s, { type: 'select', key: 'PROJ-11', on: false })).toMatchObject({ ok: false, reason: 'Subtasks follow their parent: select PROJ-10 instead.' });
    expect(ticketListKind.reduce(s, { type: 'select', key: 'PROJ-10', on: false })).toMatchObject({ ok: true });
  });

  it('keeps the rule\'s target: the change cannot be edited', async () => {
    const s = await open(withSubtasks());
    expect(ticketListKind.reduce(s, { type: 'change', change: { type: 'transition', status: 'Open' } })).toMatchObject({ ok: false });
  });

  it('asks for a resolution when the rule closes tickets and names none', async () => {
    const deps = fake();
    let s = await open(deps);
    expect(ticketListKind.view(s).cleanup).toMatchObject({ needsResolution: true, resolutions: ['Fixed', "Won't Fix"], resolution: null });
    expect(ticketListKind.plan!(s, { type: 'apply' })).toMatchObject({ ok: false, reason: expect.stringContaining('Choose a resolution') });
    expect(ticketListKind.reduce(s, { type: 'resolution', resolution: 'Duplicate' })).toMatchObject({ ok: false });
    s = act(s, { type: 'resolution', resolution: 'Fixed' });
    const { plan } = await apply(s, deps);
    expect(plan.lines).toEqual([{ target: 'PROJ-1', change: 'Status: Open → Done, resolution Fixed' }, { target: 'PROJ-2', change: 'Status: In Progress → Done, resolution Fixed' }]);
    expect(deps.moved).toEqual(['PROJ-1→Done (Fixed)', 'PROJ-2→Done (Fixed)']);
  });

  it('can move without a resolution when none is chosen on purpose', async () => {
    const deps = fake();
    const s = act(await open(deps), { type: 'resolution', resolution: '' });
    await apply(s, deps);
    expect(deps.moved).toEqual(['PROJ-1→Done', 'PROJ-2→Done']);
  });
});

describe('applying a cleanup', () => {
  it('moves the subtasks before their parent, with the native confirmation', async () => {
    const deps = fake({ rules: [{ ...RULE, closeSubtasks: true, resolution: 'Fixed' }], tickets: [ticket('PROJ-10'), ticket('PROJ-11', 'Open', { parent: 'PROJ-10' })] });
    const { plan, applied } = await apply(await open(deps), deps);
    expect(plan).toMatchObject({ title: 'Move 1 ticket(s) to Done, with 1 subtask(s) first', risky: true });
    expect(plan.lines.map(l => l.target)).toEqual(['PROJ-11', 'PROJ-10']);
    expect(deps.moved).toEqual(['PROJ-11→Done (Fixed)', 'PROJ-10→Done (Fixed)']);
    expect(applied.results.map(r => `${r.target} ${r.outcome}`)).toEqual(['PROJ-11 done', 'PROJ-10 done']);
  });

  it('leaves a parent as it is when one of its subtasks fails, and names the subtask', async () => {
    const deps = fake({
      rules: [{ ...RULE, closeSubtasks: true, resolution: 'Fixed' }],
      tickets: [ticket('PROJ-10'), ticket('PROJ-11', 'Open', { parent: 'PROJ-10' }), ticket('PROJ-12', 'Open', { parent: 'PROJ-10' })],
      failMove: 'PROJ-12',
    });
    const { applied } = await apply(await open(deps), deps);
    expect(deps.moved).toEqual(['PROJ-11→Done (Fixed)']);
    expect(applied.results).toEqual([
      { target: 'PROJ-11', outcome: 'done' },
      { target: 'PROJ-12', outcome: 'failed', reason: 'Jira refused the transition' },
      { target: 'PROJ-10', outcome: 'refused', reason: 'not moved, because subtask PROJ-12 was not moved' },
    ]);
  });

  it('applies only the selected tickets of the page in view', async () => {
    const tickets = Array.from({ length: 120 }, (_, i) => ticket(`PROJ-${i + 1}`));
    const deps = fake({ rules: [{ ...RULE, resolution: 'Fixed' }], tickets });
    let s = await open(deps);
    s = act(s, { type: 'page', page: 1 });
    const { plan } = await apply(s, deps);
    expect(plan.lines).toHaveLength(50);
    expect(deps.moved[0]).toBe('PROJ-51→Done (Fixed)');
    expect(deps.moved.at(-1)).toBe('PROJ-100→Done (Fixed)');
  });

  it('applies per page on a list opened with a proposed move too', async () => {
    const tickets = Array.from({ length: 60 }, (_, i) => ticket(`PROJ-${i + 1}`));
    const deps = fake({ tickets });
    const s = await open(deps, { jql: 'project = PROJ AND fixVersion = "3.2"', change: { type: 'transition', status: 'Closed' } });
    expect(ticketListKind.view(s).pageOnly).toBe(true);
    const { plan } = await apply(s, deps);
    expect(plan.lines).toHaveLength(50);
  });
});
