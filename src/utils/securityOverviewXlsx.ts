// The security overview as an Excel workbook. Pure and vscode-free. One sheet with the rows of the CSV (the shared column
// model in securityOverviewColumns.ts): dates are real date cells, Line is a number, everything else is text. Text is
// stored as a string cell, which a spreadsheet never evaluates, so no formula guard is needed (unlike the CSV).
import ExcelJS from 'exceljs';
import type { Overview } from './securityOverview';
import { buildOverviewSheet, type Cell, type ColumnKind } from './securityOverviewColumns';

export const XLSX_SHEET_NAME = 'Security overview';

/** Row fills (ARGB) for the two flags. */
export const XLSX_FILLS = { overdue: 'FFF4B183', 'due-before-release': 'FFFFF2AB' } as const;

/** Excel stores at most 32,767 characters in a cell. */
const MAX_CELL_CHARS = 32000;
const MIN_COLUMN_WIDTH = 8;
const MAX_COLUMN_WIDTH = 80;
const DATE_FORMAT = 'yyyy-mm-dd';
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Characters XML 1.0 (and so a workbook) cannot hold: most control characters, lone surrogates, U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cleanText(value: string): string {
  const text = value.replace(ILLEGAL_XML, '');
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text;
}

/** `YYYY-MM-DD` as a UTC-midnight date, so the displayed day never shifts with the time zone; null for anything else. */
function toDate(value: string): Date | null {
  const m = DATE_PATTERN.exec(value);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function toValue(cell: Cell, kind: ColumnKind): ExcelJS.CellValue {
  if (cell === null || cell === '') return null;
  if (typeof cell === 'number') return cell;
  if (kind === 'date') return toDate(cell) ?? cleanText(cell);
  return cleanText(cell);
}

function displayLength(value: ExcelJS.CellValue): number {
  if (value === null) return 0;
  if (value instanceof Date) return DATE_FORMAT.length;
  return String(value).length;
}

/** The overview as the bytes of an `.xlsx` file. */
export async function renderOverviewXlsx(overview: Overview): Promise<Uint8Array> {
  const { columns, records } = buildOverviewSheet(overview);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(XLSX_SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });

  const widths = columns.map(c => c.title.length);
  const header = sheet.addRow(columns.map(c => c.title));
  header.font = { bold: true };

  for (const record of records) {
    const values = record.cells.map((cell, i) => toValue(cell, columns[i].kind));
    values.forEach((v, i) => { widths[i] = Math.max(widths[i], displayLength(v)); });
    const row = sheet.addRow(values);
    columns.forEach((c, i) => { if (c.kind === 'date') row.getCell(i + 1).numFmt = DATE_FORMAT; });
    if (record.flag) {
      const fill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XLSX_FILLS[record.flag] } };
      columns.forEach((_, i) => { row.getCell(i + 1).fill = fill; });
    }
  }

  columns.forEach((_, i) => {
    sheet.getColumn(i + 1).width = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widths[i] + 2));
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: columns.length } };

  // exceljs's index.d.ts re-declares `Buffer` in a way that conflicts with @types/node (see waltzReport.ts); it is a Node Buffer.
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
}
