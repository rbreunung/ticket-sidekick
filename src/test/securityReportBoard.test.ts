import { describe, it, expect } from 'vitest';
import { securityReportKind, type SecurityReportData, type SecurityReportDeps, type SecurityReportRecipe, type SecurityReportWorking } from '../boards/securityReport/kind';
import type { Session } from '../sessions/sessionTypes';
import type { OverviewTicket, TicketService } from '../services/TicketService';

// The security report board: what a developer sees for a project, how filters and sort change it,
// and what Save writes.

const TICKETS: OverviewTicket[] = [
  { key: 'PROJ-1', summary: 'SQL injection in login', status: 'Open', labels: ['veracode'], dueDate: '2026-01-10', fixVersions: ['1.0'], source: 'veracode' },
  { key: 'PROJ-2', summary: 'log4j 2.14', status: 'In Progress', labels: ['oss'], dueDate: '2026-11-20', fixVersions: ['1.0'], source: 'waltz' },
  { key: 'PROJ-3', summary: 'XSS in search', status: 'Open', labels: ['veracode'], dueDate: null, fixVersions: [], source: 'veracode' },
];

function deps(overrides: Partial<SecurityReportDeps> = {}, service: Partial<TicketService> = {}): SecurityReportDeps {
  const ticketService = {
    listOverviewTickets: async () => ({ tickets: TICKETS, truncated: false }),
    getProjectVersions: async () => [{ name: '1.0', releaseDate: '2026-12-01', released: false }],
    readDescriptions: async (keys: string[]) => ({ texts: Object.fromEntries(keys.map(k => [k, ''])), failed: [] }),
    ...service,
  } as unknown as TicketService;
  return {
    jira: async () => ({ ticketService, baseUrl: 'https://jira.example.com/' }),
    defaultProject: () => '',
    csvDelimiter: () => ',',
    today: () => '2026-11-12',
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

async function session(working?: Partial<SecurityReportWorking>, d = deps()): Promise<Session<SecurityReportRecipe, SecurityReportData, SecurityReportWorking>> {
  const recipe = { project: 'PROJ' };
  return {
    id: 'a'.repeat(24), kind: 'security-report', formatVersion: 1, revision: 1, createdAt: 0, lastUsedAt: 0, recipe,
    derived: await securityReportKind.read(recipe, d),
    working: { ...securityReportKind.initialWorking(recipe), ...working },
    conflicts: [],
  };
}

describe('asking for a security report', () => {
  it('uses the project named, upper-cased', async () => {
    expect(await securityReportKind.validate({ project: 'proj' }, deps())).toEqual({ ok: true, recipe: { project: 'PROJ' } });
  });

  it('uses the default project when none is named', async () => {
    expect(await securityReportKind.validate({}, deps({ defaultProject: () => 'DEF' }))).toEqual({ ok: true, recipe: { project: 'DEF' } });
  });

  it('refuses a named text that is not a project key, and never swaps in the default project', async () => {
    const result = await securityReportKind.validate({ project: 'not a key!' }, deps({ defaultProject: () => 'DEF' }));
    expect(result.ok).toBe(false);
  });

  it('asks for a project when none is named and no default is set', async () => {
    const result = await securityReportKind.validate({}, deps());
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain('defaultProject');
  });

  it('says so when Jira is not set up', async () => {
    const result = await securityReportKind.validate({ project: 'PROJ' }, deps({ jira: async () => undefined }));
    expect(!result.ok && result.reason).toContain('Jira is not set up');
  });
});

describe('the report shown', () => {
  it('lists the tickets by Fix Version with links, counts and flags', async () => {
    const view = securityReportKind.view(await session());
    expect(view.totalTickets).toBe(3);
    expect(view.bySource).toEqual({ veracode: 2, waltz: 1 });
    expect(view.tables.map(t => t.fixVersion)).toEqual(['1.0', null]);
    const first = view.tables[0].rows.find(r => r.ticketKey === 'PROJ-1')!;
    expect(first).toMatchObject({ ticketUrl: 'https://jira.example.com/browse/PROJ-1', flag: 'overdue', dueDate: '2026-01-10' });
    expect(view.tables[0].rows.find(r => r.ticketKey === 'PROJ-2')!.flag).toBe('due-before-release');
    expect(view.releases).toEqual(['1.0', '']);
  });

  it('says when Jira could not be read, with the status and a short reason only', async () => {
    const failing = deps({}, { listOverviewTickets: async () => { throw Object.assign(new Error('<html>proxy page with internals</html>'), { status: 503 }); } });
    await expect(securityReportKind.read({ project: 'PROJ' }, failing)).rejects.toThrow(/^Jira answered HTTP 503/);
  });

  it('warns when the release dates could not be read and when the list was cut', async () => {
    const d = deps({}, {
      listOverviewTickets: async () => ({ tickets: TICKETS, truncated: true }),
      getProjectVersions: async () => { throw new Error('403'); },
    });
    const view = securityReportKind.view(await session(undefined, d));
    expect(view.warnings).toHaveLength(2);
    expect(view.tables[0].rows.every(r => r.flag !== 'due-before-release')).toBe(true);
  });
});

describe('filters and sort', () => {
  it('filters by tool, flag and release, and counts what is shown', async () => {
    const s = await session();
    const tool = securityReportKind.reduce(s, { type: 'filter', tool: 'waltz' });
    expect(tool.ok && securityReportKind.view({ ...s, working: tool.working })).toMatchObject({ shownTickets: 1, totalTickets: 3 });

    const flag = securityReportKind.reduce(s, { type: 'filter', flag: 'none' });
    const flagged = securityReportKind.view({ ...s, working: (flag as { working: SecurityReportWorking }).working });
    expect(flagged.tables.flatMap(t => t.rows).map(r => r.ticketKey)).toEqual(['PROJ-3']);

    const release = securityReportKind.reduce(s, { type: 'filter', release: '' });
    const unassigned = securityReportKind.view({ ...s, working: (release as { working: SecurityReportWorking }).working });
    expect(unassigned.tables.map(t => t.fixVersion)).toEqual([null]);
  });

  it('sorts a column up, then down, then not at all', async () => {
    let s = await session();
    const click = () => {
      const next = securityReportKind.reduce(s, { type: 'sort', column: 'ticket' });
      if (!next.ok) throw new Error(next.reason);
      s = { ...s, working: next.working };
      return securityReportKind.view(s);
    };
    expect(click().tables[0].rows.map(r => r.ticketKey)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(click().tables[0].rows.map(r => r.ticketKey)).toEqual(['PROJ-2', 'PROJ-1']);
    expect(click().sort).toBeNull();
  });

  it('clears filters and sort together', async () => {
    const s = await session({ tool: 'waltz', flag: 'overdue', sort: { column: 'due', descending: true } });
    const cleared = securityReportKind.reduce(s, { type: 'clear' });
    expect(cleared).toEqual({ ok: true, working: { release: null, flag: null, tool: null, sort: null } });
  });

  it('refuses values it does not know', async () => {
    const s = await session();
    expect(securityReportKind.reduce(s, { type: 'filter', tool: 'other' as never }).ok).toBe(false);
    expect(securityReportKind.reduce(s, { type: 'sort', column: 'nope' as never }).ok).toBe(false);
    expect(securityReportKind.reduce(s, { type: 'drop table' } as never).ok).toBe(false);
  });
});

describe('a restored report checked against Jira', () => {
  it('keeps filters and sort, and clears only a release filter whose release is gone', async () => {
    const stored = await session({ release: '1.0', tool: 'veracode', sort: { column: 'due', descending: false } });
    const moved = deps({}, { listOverviewTickets: async () => ({ tickets: TICKETS.map(t => ({ ...t, fixVersions: t.fixVersions.length ? ['2.0'] : [] })), truncated: false }) });
    const fresh = await securityReportKind.read(stored.recipe, moved);
    const merged = securityReportKind.reconcile(stored, fresh);
    expect(merged.working).toEqual({ release: null, flag: null, tool: 'veracode', sort: { column: 'due', descending: false } });
    expect(merged.conflicts).toEqual([]);
  });
});

describe('saving the report', () => {
  it('writes the full report as CSV whatever the filters, named after project and day', async () => {
    const s = await session({ tool: 'waltz' });
    const file = await securityReportKind.exportFile!(s, 'csv', deps());
    expect(file.fileName).toBe('security-overview-PROJ-2026-11-12.csv');
    const text = new TextDecoder().decode(file.bytes);
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3']) expect(text).toContain(key);
  });

  it('uses the configured separator and writes Excel as a workbook', async () => {
    const s = await session();
    const csv = await securityReportKind.exportFile!(s, 'csv', deps({ csvDelimiter: () => ';' }));
    expect(new TextDecoder().decode(csv.bytes).split('\n')[0]).toContain(';');
    const xlsx = await securityReportKind.exportFile!(s, 'xlsx', deps());
    expect(xlsx.extension).toBe('xlsx');
    expect(xlsx.bytes.byteLength).toBeGreaterThan(1000);
  });
});
