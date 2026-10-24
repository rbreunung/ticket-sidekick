import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildOverview } from '../utils/securityOverview';
import { renderOverviewXlsx, XLSX_FILLS } from '../utils/securityOverviewXlsx';
import { descriptionsOf, makeComponent, makeFlaw, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';

const VERSIONS = [{ name: '2026.11', releaseDate: '2026-11-15', released: false }];

type TestTicket = ReturnType<typeof veracodeTicket>;

async function sheetOf(tickets: TestTicket[]): Promise<ExcelJS.Worksheet> {
  const overview = buildOverview({ tickets: tickets.map(t => t.ticket), descriptions: descriptionsOf(tickets), versions: VERSIONS, today: '2026-10-22' });
  const bytes = await renderOverviewXlsx(overview);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  return workbook.getWorksheet('Security overview')!;
}

const columnOf = (sheet: ExcelJS.Worksheet, title: string): number => {
  const header = sheet.getRow(1).values as unknown[];
  return header.indexOf(title);
};

describe('renderOverviewXlsx', () => {
  it('writes one sheet with the header of the shared column order and a row per record', async () => {
    const sheet = await sheetOf([veracodeTicket('SEC-1', [makeFlaw('1', { line: 5 }), makeFlaw('2', { line: 6 })], { fixVersions: ['2026.11'] })]);

    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header.slice(0, 8)).toEqual(['Source', 'Ticket', 'Status', 'Summary', 'Rating', 'Fix Version', 'Release Date', 'Due Date']);
    expect(header.at(-1)).toBe('Members');
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(2).getCell(columnOf(sheet, 'Ticket')).value).toBe('SEC-1');
  });

  it('stores dates as date values shown as YYYY-MM-DD and Line as a number', async () => {
    const component = makeComponent('a:1', { remediation: { policyDate: '2026-11-30', plannedDate: '2026-11-02', attestationDate: null, planStatus: null, reportDate: null } });
    const sheet = await sheetOf([waltzTicket('SEC-2', [component], { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);
    const planned = sheet.getRow(2).getCell(columnOf(sheet, 'Planned date'));

    expect(planned.value).toBeInstanceOf(Date);
    expect((planned.value as Date).toISOString().slice(0, 10)).toBe('2026-11-02');
    expect(planned.numFmt).toBe('yyyy-mm-dd');
    expect((sheet.getRow(2).getCell(columnOf(sheet, 'Planned date')).value as Date).getTime())
      .toBeGreaterThan((sheet.getRow(2).getCell(columnOf(sheet, 'Due Date')).value as Date).getTime());
    expect(sheet.getRow(2).getCell(columnOf(sheet, 'Attestation date')).value).toBeNull();

    const vera = await sheetOf([veracodeTicket('SEC-1', [makeFlaw('1', { line: 12 })], { fixVersions: ['2026.11'] })]);
    expect(vera.getRow(2).getCell(columnOf(vera, 'Line')).value).toBe(12);
  });

  it('freezes and bolds the header and puts an autofilter over the whole table', async () => {
    const sheet = await sheetOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);

    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.getRow(1).getCell(1).font?.bold).toBe(true);
    const lastColumn = (sheet.getRow(1).values as unknown[]).length - 1;
    expect(sheet.autoFilter).toBe(`A1:${sheet.getColumn(lastColumn).letter}${sheet.rowCount}`);
  });

  it('fills an overdue row orange and a due-before-release row yellow across the row, and leaves other rows unfilled', async () => {
    const sheet = await sheetOf([
      veracodeTicket('SEC-1', [makeFlaw('1', { line: 1 })], { fixVersions: ['2026.11'], dueDate: '2026-10-01' }),
      veracodeTicket('SEC-2', [makeFlaw('2', { line: 2 })], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
      veracodeTicket('SEC-3', [makeFlaw('3', { line: 3 })], { fixVersions: ['2026.11'], dueDate: '2027-01-01' }),
    ]);
    const fillOf = (rowNumber: number, col: number) => (sheet.getRow(rowNumber).getCell(col).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    const last = (sheet.getRow(1).values as unknown[]).length - 1;
    const byTicket = (key: string) => { for (let r = 2; r <= sheet.rowCount; r++) if (sheet.getRow(r).getCell(columnOf(sheet, 'Ticket')).value === key) return r; throw new Error(key); };

    for (const col of [1, last]) {
      expect(fillOf(byTicket('SEC-1'), col)).toBe(XLSX_FILLS.overdue);
      expect(fillOf(byTicket('SEC-2'), col)).toBe(XLSX_FILLS['due-before-release']);
      expect(fillOf(byTicket('SEC-3'), col)).toBeUndefined();
    }
    expect(XLSX_FILLS.overdue).not.toBe(XLSX_FILLS['due-before-release']);
    expect(sheet.getRow(byTicket('SEC-1')).getCell(columnOf(sheet, 'Flag')).value).toBe('overdue');
  });

  it('stores a value that looks like a formula as plain text, with no apostrophe added', async () => {
    const formula = '=HYPERLINK("http://x","y")';
    const sheet = await sheetOf([veracodeTicket('SEC-1', [makeFlaw('1', { sourceFile: formula })], { fixVersions: ['2026.11'], summary: formula })]);

    const summary = sheet.getRow(2).getCell(columnOf(sheet, 'Summary'));
    expect(summary.value).toBe(formula);
    expect(summary.type).toBe(ExcelJS.ValueType.String);
    expect(summary.formula).toBeUndefined();
    expect(sheet.getRow(2).getCell(columnOf(sheet, 'File')).value).toBe(formula);
  });

  it('drops characters Excel cannot store and shortens a text over the cell limit', async () => {
    const huge = Array.from({ length: 40 }, (_, i) => `component-${i}-${'x'.repeat(1000)}:1.0`);
    const sheet = await sheetOf([
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], summary: 'bad\u0000char\u0008 here' }),
      waltzTicket('SEC-2', huge.map(n => makeComponent(n)), { fixVersions: ['2026.11'] }),
    ]);

    expect(sheet.getRow(2).getCell(columnOf(sheet, 'Summary')).value).toBe('badchar here');
    const members = String(sheet.getRow(3).getCell(columnOf(sheet, 'Members')).value);
    expect(members.length).toBeLessThanOrEqual(32000);
    expect(members.endsWith('…')).toBe(true);
  });

  it('writes a header-only workbook for an overview with nothing in it', async () => {
    const overview = buildOverview({ tickets: [], descriptions: {}, versions: [], today: '2026-10-22' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await renderOverviewXlsx(overview)) as never);

    expect(workbook.getWorksheet('Security overview')!.rowCount).toBe(1);
  });

  it('sizes columns from their content and stops at a cap', async () => {
    const sheet = await sheetOf([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], summary: 'S'.repeat(500) })]);

    const width = (title: string) => sheet.getColumn(columnOf(sheet, title)).width ?? 0;
    expect(width('Summary')).toBeGreaterThan(width('Source'));
    expect(width('Summary')).toBeLessThanOrEqual(80);
    expect(width('Source')).toBeGreaterThanOrEqual(8);
  });
});
