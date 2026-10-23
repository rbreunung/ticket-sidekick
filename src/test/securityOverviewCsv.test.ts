import { describe, it, expect } from 'vitest';
import { buildOverview, componentFromWaltz, findingFromFlaw } from '../utils/securityOverview';
import { csvCell, renderOverviewCsv, resolveCsvDelimiter, CSV_BOM } from '../utils/securityOverviewCsv';
import { descriptionsOf, makeComponent, makeFlaw, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';

const VERSIONS = [{ name: '2026.11', releaseDate: '2026-11-15' }];

function csvOf(tickets: ReturnType<typeof veracodeTicket>[], delimiter = ',', report?: Parameters<typeof buildOverview>[0]['report']) {
  const overview = buildOverview({ tickets: tickets.map(t => t.ticket), descriptions: descriptionsOf(tickets), versions: VERSIONS, today: '2026-10-22', report });
  const text = renderOverviewCsv(overview, delimiter);
  return text.slice(CSV_BOM.length).trimEnd().split('\r\n');
}

describe('csvCell', () => {
  it('quotes a cell holding the delimiter, a quote or a line break and doubles its quotes', () => {
    expect(csvCell('a,b', ',')).toBe('"a,b"');
    expect(csvCell('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines', ',')).toBe('"two\nlines"');
    expect(csvCell('a;b', ';')).toBe('"a;b"');
    expect(csvCell('a;b', ',')).toBe('a;b');
  });

  it('prefixes a cell a spreadsheet could read as a formula', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx']) expect(csvCell(bad, ',')).toBe(`'${bad}`);
  });

  it('writes null and undefined as empty and keeps a number as it is', () => {
    expect(csvCell(null, ',')).toBe('');
    expect(csvCell(undefined, ',')).toBe('');
    expect(csvCell(88, ',')).toBe('88');
  });
});

describe('renderOverviewCsv', () => {
  it('writes a folded Veracode ticket as one row per finding with the ticket columns repeated', () => {
    const group = Array.from({ length: 7 }, (_, i) => makeFlaw(String(1021 + i), { line: 10 + i }));
    const lines = csvOf([veracodeTicket('SEC-1', group, { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);

    expect(lines).toHaveLength(8);
    const header = lines[0].split(',');
    expect(header).toEqual(expect.arrayContaining(['Ticket', 'Issue ID', 'CWE ID', 'CWE name', 'Module', 'Path', 'File', 'Line', 'Function', 'Detail source']));
    const rows = lines.slice(1);
    expect(rows.every(r => r.includes('SEC-1') && r.includes('due before release') && r.includes('2026-11-15'))).toBe(true);
    expect(rows[2]).toContain('1023');
    expect(rows[2]).toContain('OrderRepository.java');
    expect(rows[2].split(',')).toContain('12');
    expect(rows[0]).toContain(',table,');
  });

  it('writes a merged Waltz ticket as one row with its members joined by semicolons', () => {
    const names = ['netty-codec', 'netty-handler', 'netty-buffer', 'netty-common', 'netty-transport', 'netty-resolver', 'netty-codec-http'].map(n => `${n}:4.1.100`);
    const lines = csvOf([waltzTicket('SEC-2', names.map(n => makeComponent(n)), { fixVersions: ['2026.11'] })]);

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(names.join('; '));
    expect(lines[1]).toContain('Remediate');
    expect(lines[1]).toContain('2026-11-30');
  });

  it('takes the earliest of the members for each Waltz date', () => {
    const a = makeComponent('a:1', { remediation: { policyDate: '2026-12-01', plannedDate: '2026-12-15', planDeadline: null, planStatus: 'Overdue', reportDate: null } });
    const b = makeComponent('b:2', { remediation: { policyDate: '2026-11-01', plannedDate: null, planDeadline: '2026-09-20', planStatus: null, reportDate: null } });
    const cells = csvOf([waltzTicket('SEC-2', [a, b])])[1].split(',');
    const header = csvOf([waltzTicket('SEC-2', [a, b])])[0].split(',');

    expect(cells[header.indexOf('Policy date')]).toBe('2026-11-01');
    expect(cells[header.indexOf('Planned date')]).toBe('2026-12-15');
    expect(cells[header.indexOf('Plan deadline')]).toBe('2026-09-20');
    expect(cells[header.indexOf('Plan status')]).toBe('Overdue');
  });

  it('neutralizes a file name that starts with an equals sign and quotes one that holds a comma', () => {
    const lines = csvOf([
      veracodeTicket('SEC-1', [makeFlaw('1', { sourceFile: '=HYPERLINK("http://evil")' })], { fixVersions: ['2026.11'] }),
      veracodeTicket('SEC-2', [makeFlaw('2', { sourceFile: 'a,b.java' })], { fixVersions: ['2026.11'] }),
    ]);

    expect(lines.join('\n')).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines.join('\n')).toContain('"a,b.java"');
  });

  it('uses the chosen delimiter', () => {
    const lines = csvOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })], ';');
    expect(lines[0].split(';')).toContain('Ticket');
    expect(lines[0]).not.toContain(',');
  });

  it('adds the Report match column and report detail for an import export', () => {
    const reportOnly = [{ source: 'veracode' as const, summary: 'ExportService.java - Path Traversal', findings: [findingFromFlaw(makeFlaw('9', { sourceFile: 'ExportService.java' }))], dueDate: null }];
    const lines = csvOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })], ',', { matchByKey: { 'SEC-1': 'stale' }, reportOnly });

    expect(lines[0].split(',')).toContain('Report match');
    expect(lines.join('\n')).toContain('in report, no ticket');
    expect(lines.join('\n')).toContain('stale');
    expect(lines.at(-1)).toContain(',report,');
    expect(lines.at(-1)).toContain('ExportService.java');
  });

  it('writes a header-only file for an overview with nothing in it, starting with a byte-order mark', () => {
    const overview = buildOverview({ tickets: [], descriptions: {}, versions: [], today: '2026-10-22' });
    const text = renderOverviewCsv(overview);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text.slice(CSV_BOM.length).trimEnd().split('\r\n')).toHaveLength(1);
  });

  it('writes a Veracode ticket whose description could not be read as one row with the finding columns empty', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], summary: 'Renamed ticket', labels: ['veracode'] });
    const overview = buildOverview({ tickets: [t.ticket], descriptions: {}, versions: VERSIONS, today: '2026-10-22' });
    const lines = renderOverviewCsv(overview).slice(CSV_BOM.length).trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('title-labels');
  });

  it('keeps a Waltz component record from the report exact', () => {
    const c = componentFromWaltz(makeComponent('guava:31.0'));
    expect(c).toMatchObject({ nameVersion: 'guava:31.0', approximate: false, policyDate: '2026-11-30' });
  });
});

describe('resolveCsvDelimiter', () => {
  it('maps the setting values to their characters and reads anything else as a comma', () => {
    expect(resolveCsvDelimiter('comma')).toBe(',');
    expect(resolveCsvDelimiter('semicolon')).toBe(';');
    expect(resolveCsvDelimiter('tab')).toBe('\t');
    expect(resolveCsvDelimiter('pipe')).toBe(',');
    expect(resolveCsvDelimiter(undefined)).toBe(',');
  });
});
