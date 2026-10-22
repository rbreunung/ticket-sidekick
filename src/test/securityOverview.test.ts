import { describe, it, expect } from 'vitest';
import { buildOverview, renderOverviewMarkdown, findingFromFlaw, componentFromWaltz, JQL_KEY_CAP, type OverviewInput } from '../utils/securityOverview';
import { descriptionsOf, makeComponent, makeFlaw, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';

const TODAY = '2026-10-22';
const VERSIONS = [
  { name: '2026.11', releaseDate: '2026-11-15' },
  { name: '2027.01', releaseDate: '2027-01-20' },
  { name: 'Backlog', releaseDate: null },
];

function input(tickets: ReturnType<typeof veracodeTicket>[], over: Partial<OverviewInput> = {}): OverviewInput {
  return {
    tickets: tickets.map(t => t.ticket), descriptions: descriptionsOf(tickets), versions: VERSIONS, today: TODAY,
    baseUrl: 'https://jira.example.com', projectKey: 'SEC', ...over,
  };
}

const flawGroup = (n: number) => Array.from({ length: n }, (_, i) => makeFlaw(String(1021 + i), { line: 10 + i }));

describe('buildOverview flags', () => {
  it('flags a Due Date earlier than the release date as due before release, and a later one not at all', () => {
    const early = veracodeTicket('SEC-1', [makeFlaw('1')], { dueDate: '2026-11-01', fixVersions: ['2026.11'] });
    const late = veracodeTicket('SEC-2', [makeFlaw('2', { line: 1 })], { dueDate: '2026-12-01', fixVersions: ['2026.11'] });

    const [table] = buildOverview(input([early, late])).tables;

    expect(table.rows.find(r => r.ticketKey === 'SEC-1')!.flag).toBe('due-before-release');
    expect(table.rows.find(r => r.ticketKey === 'SEC-2')!.flag).toBeNull();
    expect(table.counts).toMatchObject({ tickets: 2, dueBeforeRelease: 1, overdue: 0 });
  });

  it('flags a passed Due Date as overdue only, even when it is also before the release', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { dueDate: '2026-10-10', fixVersions: ['2027.01'] });

    const [table] = buildOverview(input([t])).tables;

    expect(table.rows[0].flag).toBe('overdue');
    expect(table.counts).toMatchObject({ overdue: 1, dueBeforeRelease: 0 });
  });

  it('lists a Fix Version without a release date and never flags it as due before release', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { dueDate: '2026-11-01', fixVersions: ['Backlog'] });
    const unknown = veracodeTicket('SEC-2', [makeFlaw('2', { line: 3 })], { dueDate: '2026-11-01', fixVersions: ['Not in the list'] });

    const overview = buildOverview(input([t, unknown]));

    expect(overview.tables.map(x => x.fixVersion)).toEqual(['Backlog', 'Not in the list']);
    expect(overview.tables.every(x => x.rows[0].flag === null)).toBe(true);
  });

  it('counts tickets without a Due Date', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    expect(buildOverview(input([t])).tables[0].counts.noDueDate).toBe(1);
  });
});

describe('buildOverview grouping', () => {
  it('orders release tables by release date, undated last, and puts Not assigned at the end', () => {
    const tickets = [
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['Backlog'] }),
      veracodeTicket('SEC-2', [makeFlaw('2', { line: 2 })], { fixVersions: ['2027.01'] }),
      veracodeTicket('SEC-3', [makeFlaw('3', { line: 3 })]),
      veracodeTicket('SEC-4', [makeFlaw('4', { line: 4 })], { fixVersions: ['2026.11'] }),
    ];

    const overview = buildOverview(input(tickets));

    expect(overview.tables.map(t => t.fixVersion)).toEqual(['2026.11', '2027.01', 'Backlog', null]);
  });

  it('lists a ticket with two Fix Versions once, under the earlier release, and names the other', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2027.01', '2026.11'] });

    const overview = buildOverview(input([t]));

    expect(overview.tables).toHaveLength(1);
    expect(overview.tables[0].fixVersion).toBe('2026.11');
    expect(overview.tables[0].rows[0].otherFixVersions).toEqual(['2027.01']);
  });

  it('sorts a table by flag, then Due Date, then key', () => {
    const tickets = [
      veracodeTicket('SEC-10', [makeFlaw('10', { line: 1 })], { fixVersions: ['2026.11'], dueDate: '2026-12-01' }),
      veracodeTicket('SEC-2', [makeFlaw('2', { line: 2 })], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
      veracodeTicket('SEC-3', [makeFlaw('3', { line: 3 })], { fixVersions: ['2026.11'], dueDate: '2026-10-10' }),
      veracodeTicket('SEC-4', [makeFlaw('4', { line: 4 })], { fixVersions: ['2026.11'] }),
    ];

    expect(buildOverview(input(tickets)).tables[0].rows.map(r => r.ticketKey)).toEqual(['SEC-3', 'SEC-2', 'SEC-10', 'SEC-4']);
  });

  it('counts tickets by source and reads a ticket whose description is unknown from its title and labels', () => {
    const v = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    const w = waltzTicket('SEC-2', [makeComponent('netty-codec:4.1.100')], { fixVersions: ['2026.11'] });

    const overview = buildOverview({ ...input([v, w]), descriptions: { 'SEC-1': null } });

    expect(overview.bySource).toEqual({ veracode: 1, waltz: 1 });
    expect(overview.unreadCount).toBe(2);
    expect(overview.tables[0].rows.every(r => r.detailSource === 'title-labels')).toBe(true);
  });

  it('shows the most severe finding as the rating of a folded Veracode ticket and the highest rating of a merged Waltz one', () => {
    const v = veracodeTicket('SEC-1', [makeFlaw('1', { severity: 3 }), makeFlaw('2', { severity: 5, line: 2 })]);
    const w = waltzTicket('SEC-2', [makeComponent('a:1', { maxVulnRating: 'Medium' }), makeComponent('b:2', { maxVulnRating: 'Critical' })]);

    const rows = buildOverview(input([v, w])).tables[0].rows;

    expect(rows.find(r => r.ticketKey === 'SEC-1')!.rating).toBe('Very High');
    expect(rows.find(r => r.ticketKey === 'SEC-2')!.rating).toBe('Critical');
  });
});

describe('Jira links', () => {
  it('links the standalone tables by label and Fix Version, and Not assigned by an empty Fix Version, with resolution is EMPTY', () => {
    const tickets = [
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] }),
      veracodeTicket('SEC-2', [makeFlaw('2', { line: 2 })]),
    ];

    const [release, none] = buildOverview(input(tickets)).tables;

    expect(release.jira).toMatchObject({ kind: 'labels' });
    expect(release.jira!.jql).toBe('project = SEC AND resolution is EMPTY AND (labels = "veracode" OR labels = "oss-dependency") AND fixVersion = "2026.11"');
    expect(none.jira!.jql).toContain('fixVersion is EMPTY');
    expect(release.jira!.url).toBe(`https://jira.example.com/issues/?jql=${encodeURIComponent(release.jira!.jql)}`);
  });

  it('escapes a quote in a Fix Version name', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['The "big" one'] });
    expect(buildOverview(input([t])).tables[0].jira!.jql).toContain('fixVersion = "The \\"big\\" one"');
  });

  it('links an import export by an explicit key list that includes every ticket of the table', () => {
    const tickets = [
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] }),
      veracodeTicket('SEC-2', [makeFlaw('2', { line: 2 })], { fixVersions: ['2026.11'] }),
    ];

    const [table] = buildOverview(input(tickets, { report: { matchByKey: {}, reportOnly: [] } })).tables;

    expect(table.jira).toMatchObject({ kind: 'keys', jql: 'key in (SEC-1, SEC-2)', fellBack: false });
  });

  it('falls back to the label query when a key list would be too long', () => {
    const tickets = Array.from({ length: JQL_KEY_CAP + 1 }, (_, i) => veracodeTicket(`SEC-${i + 1}`, [makeFlaw(String(i + 1), { line: i + 1 })], { fixVersions: ['2026.11'] }));

    const [table] = buildOverview(input(tickets, { report: { matchByKey: {}, reportOnly: [] } })).tables;

    expect(table.jira).toMatchObject({ kind: 'labels', fellBack: true });
    expect(table.jira!.jql).toContain('resolution is EMPTY');
  });

  it('has no Jira link for a table with no ticket, or without a base URL', () => {
    const reportOnly = [{ source: 'veracode' as const, summary: 'ExportService.java - Path Traversal', findings: [findingFromFlaw(makeFlaw('9'))], dueDate: null }];
    const [none] = buildOverview(input([], { report: { matchByKey: {}, reportOnly } })).tables;
    expect(none.jira).toBeNull();

    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    expect(buildOverview(input([t], { baseUrl: undefined })).tables[0].jira!.url).toBeNull();
  });
});

describe('import export (report side)', () => {
  it('puts a report item with no ticket in the Not assigned table with its Report match, and counts it as having no ticket', () => {
    const tracked = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    const reportOnly = [
      { source: 'waltz' as const, summary: '[OSS] guava:31.0 — Medium', components: [componentFromWaltz(makeComponent('guava:31.0', { maxVulnRating: 'Medium' }))], dueDate: '2026-11-30' },
    ];

    const overview = buildOverview(input([tracked], { report: { matchByKey: { 'SEC-1': 'tracked' }, reportOnly } }));

    const none = overview.tables.at(-1)!;
    expect(none.fixVersion).toBeNull();
    expect(none.rows[0]).toMatchObject({ ticketKey: null, reportMatch: 'in-report-no-ticket', detailSource: 'report', rating: 'Medium' });
    expect(none.noTicket).toBe(1);
    expect(renderOverviewMarkdown(overview)).toContain('1 item has no ticket yet');
  });

  it('marks a stale ticket and reads detail the report holds as report, not from the ticket text', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    const detail = { 'SEC-1': { findings: [findingFromFlaw(makeFlaw('1', { sourceFile: 'a|b.java' }))] } };

    const [table] = buildOverview(input([t], { report: { matchByKey: { 'SEC-1': 'stale' }, reportOnly: [], detailByKey: detail } })).tables;

    expect(table.rows[0]).toMatchObject({ reportMatch: 'stale', detailSource: 'report' });
    expect(table.rows[0].findings[0].file).toBe('a|b.java');
    expect(table.rows[0].findings[0].approximate).toBe(false);
  });
});

describe('renderOverviewMarkdown', () => {
  it('shows the summary table, one table per release and a link with the ticket count', () => {
    const tickets = [
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
      waltzTicket('SEC-2', [makeComponent('netty-codec:4.1.100')], { fixVersions: ['2026.11'], dueDate: '2026-10-10' }),
    ];

    const text = renderOverviewMarkdown(buildOverview(input(tickets)), 'https://jira.example.com');

    expect(text).toContain('| Fix Version | Assigned | Overdue | Due before release | No Due Date |');
    expect(text).toContain('| 2026.11 (releases 2026-11-15) | 2 | 1 | 1 | 0 |');
    expect(text).toContain('[2 tickets in Jira](https://jira.example.com/issues/?jql=');
    expect(text).toContain('⚠ overdue');
    expect(text).toContain('⚠ due before release');
    expect(text).toContain('[SEC-1](https://jira.example.com/browse/SEC-1) (Open)');
    expect(text).toContain('| Source | Item | Rating | Ticket | Due | Flag |');
  });

  it('shows a folded Veracode ticket as one row', () => {
    const t = veracodeTicket('SEC-1', flawGroup(7), { fixVersions: ['2026.11'] });
    const rows = renderOverviewMarkdown(buildOverview(input([t]))).split('\n').filter(l => l.includes('SEC-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('7 findings');
  });

  it('neutralizes link syntax, pipes and line breaks in Jira text', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { summary: 'Evil [click](http://evil.example) | x\nnext', status: 'Op|en' });

    const text = renderOverviewMarkdown(buildOverview(input([t])));

    expect(text).not.toContain('[click](');
    expect(text).toContain('Evil ［click］(http://evil.example) / x next');
    expect(text).toContain('(Op/en)');
  });

  it('says there is nothing to list for an empty project, and for an empty report', () => {
    expect(renderOverviewMarkdown(buildOverview(input([])))).toContain('No unresolved Veracode or Waltz tickets');
    expect(renderOverviewMarkdown(buildOverview(input([], { report: { matchByKey: {}, reportOnly: [] } })))).toContain('report has no items');
  });

  it('adds the Report match column for an import export and drops the Source column', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    const text = renderOverviewMarkdown(buildOverview(input([t], { report: { matchByKey: { 'SEC-1': 'stale' }, reportOnly: [] } })));
    expect(text).toContain('| Item | Rating | Ticket | Due | Flag | Report match |');
    expect(text).toContain('| stale |');
  });

  it('notes tickets that could not be read in full', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] });
    expect(renderOverviewMarkdown(buildOverview({ ...input([t]), descriptions: {} }))).toContain('could not be read in full');
  });
});
