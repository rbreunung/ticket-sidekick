import { describe, it, expect } from 'vitest';
import { buildOverview, findingFromFlaw } from '../utils/securityOverview';
import { buildOverviewSheet } from '../utils/securityOverviewColumns';
import { descriptionsOf, makeComponent, makeFlaw, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';

const VERSIONS = [{ name: '2026.11', releaseDate: '2026-11-15', released: false }];
const TODAY = '2026-10-22';

function sheetOf(tickets: ReturnType<typeof veracodeTicket>[], report?: Parameters<typeof buildOverview>[0]['report']) {
  return buildOverviewSheet(buildOverview({ tickets: tickets.map(t => t.ticket), descriptions: descriptionsOf(tickets), versions: VERSIONS, today: TODAY, report }));
}

const titles = (s: ReturnType<typeof sheetOf>) => s.columns.map(c => c.title);

describe('buildOverviewSheet column order', () => {
  it('puts the release date after the Fix Version, the dates around the Due Date and Members last', () => {
    const sheet = sheetOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);

    expect(titles(sheet)).toEqual([
      'Source', 'Ticket', 'Status', 'Summary', 'Rating', 'Fix Version', 'Release Date', 'Due Date', 'Policy date', 'Planned date', 'Attestation date',
      'Other Fix Versions', 'Flag', 'Detail source',
      'Issue ID', 'Severity', 'CWE ID', 'CWE name', 'Module', 'Path', 'File', 'Line', 'Function',
      'Remediation action', 'Plan status', 'Members',
    ]);
  });

  it('adds Report match before Detail source for an import export', () => {
    const sheet = sheetOf([], { matchByKey: {}, reportOnly: [{ source: 'veracode', summary: 'New', dueDate: null, findings: [findingFromFlaw(makeFlaw('9'))] }] });

    const names = titles(sheet);
    expect(names.slice(names.indexOf('Flag'), names.indexOf('Issue ID'))).toEqual(['Flag', 'Report match', 'Detail source']);
    expect(names.at(-1)).toBe('Members');
  });

  it('marks the date columns as dates and Line as a number', () => {
    const kinds = Object.fromEntries(sheetOf([veracodeTicket('SEC-1', [makeFlaw('1')])]).columns.map(c => [c.title, c.kind]));

    for (const d of ['Release Date', 'Due Date', 'Policy date', 'Planned date', 'Attestation date']) expect(kinds[d]).toBe('date');
    expect(kinds.Line).toBe('number');
    expect(kinds.Summary).toBe('text');
  });
});

describe('buildOverviewSheet records', () => {
  const cell = (s: ReturnType<typeof sheetOf>, i: number, title: string) => s.records[i].cells[titles(s).indexOf(title)];

  it('gives a Veracode ticket one record per finding, each repeating the ticket cells and carrying the flag', () => {
    const group = [1, 2, 3].map(n => makeFlaw(String(1020 + n), { line: 10 + n }));
    const sheet = sheetOf([veracodeTicket('SEC-1', group, { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);

    expect(sheet.records).toHaveLength(3);
    expect(sheet.records.map(r => r.flag)).toEqual(['due-before-release', 'due-before-release', 'due-before-release']);
    expect(cell(sheet, 2, 'Ticket')).toBe('SEC-1');
    expect(cell(sheet, 2, 'Release Date')).toBe('2026-11-15');
    expect(cell(sheet, 2, 'Due Date')).toBe('2026-11-01');
    expect(cell(sheet, 2, 'Issue ID')).toBe('1023');
    expect(cell(sheet, 2, 'Line')).toBe(13);
  });

  it('gives a Waltz ticket one record with its members joined, the earliest dates and an empty Veracode block', () => {
    const a = makeComponent('a:1', { remediation: { policyDate: '2026-12-01', plannedDate: '2026-12-15', attestationDate: null, planStatus: 'Overdue', reportDate: null } });
    const b = makeComponent('b:2', { remediation: { policyDate: '2026-11-01', plannedDate: null, attestationDate: '2026-09-20', planStatus: null, reportDate: null } });
    const sheet = sheetOf([waltzTicket('SEC-2', [a, b], { dueDate: '2026-10-01' })]);

    expect(sheet.records).toHaveLength(1);
    expect(sheet.records[0].flag).toBe('overdue');
    expect(cell(sheet, 0, 'Members')).toBe('a:1; b:2');
    expect(cell(sheet, 0, 'Policy date')).toBe('2026-11-01');
    expect(cell(sheet, 0, 'Planned date')).toBe('2026-12-15');
    expect(cell(sheet, 0, 'Attestation date')).toBe('2026-09-20');
    expect(cell(sheet, 0, 'Plan status')).toBe('Overdue');
    expect(cell(sheet, 0, 'Issue ID')).toBeNull();
    expect(sheet.records[0].cells).toHaveLength(sheet.columns.length);
  });

  it('gives a Veracode ticket whose findings could not be read a single record with the finding cells empty', () => {
    const t = veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], summary: 'Renamed ticket', labels: ['veracode'] });
    const sheet = buildOverviewSheet(buildOverview({ tickets: [t.ticket], descriptions: {}, versions: VERSIONS, today: TODAY }));

    expect(sheet.records).toHaveLength(1);
    expect(sheet.records[0].cells[sheet.columns.findIndex(c => c.title === 'Issue ID')]).toBeNull();
  });

  it('writes an unflagged row with no flag', () => {
    const sheet = sheetOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2027-01-01' })]);
    expect(sheet.records[0].flag).toBeNull();
    expect(cell(sheet, 0, 'Flag')).toBe('');
  });
});
