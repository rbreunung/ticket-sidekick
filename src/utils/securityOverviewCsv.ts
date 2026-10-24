// The security overview as CSV text. Pure and vscode-free. The rows and their column order come from
// securityOverviewColumns.ts: Veracode tickets give one row per finding, Waltz tickets one row per ticket.
// Cells come from Jira and from a scanner report, so any cell a spreadsheet could read as a formula is prefixed.
import type { Overview } from './securityOverview';
import { buildOverviewSheet } from './securityOverviewColumns';

export const CSV_BOM = '\uFEFF';

const DELIMITERS: Record<string, string> = { comma: ',', semicolon: ';', tab: '\t' };

/** The `ticketSidekick.jira.overviewCsvDelimiter` setting as a character; anything unknown reads as a comma. */
export function resolveCsvDelimiter(setting: unknown): string {
  return typeof setting === 'string' ? DELIMITERS[setting] ?? ',' : ',';
}

/**
 * One CSV cell. A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe so a
 * spreadsheet shows it as text; a cell holding the delimiter, a quote or a line break is quoted.
 */
export function csvCell(value: string | number | null | undefined, delimiter: string): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The whole overview as CSV: a header row and the rows of every table in order, in the column order of
 * {@link buildOverviewSheet}. `Report match` is a column only for an import export. The text starts with a byte-order
 * mark so a spreadsheet reads it as UTF-8.
 */
export function renderOverviewCsv(overview: Overview, delimiter = ','): string {
  const { columns, records } = buildOverviewSheet(overview);
  const lines = [
    columns.map(c => csvCell(c.title, delimiter)).join(delimiter),
    ...records.map(r => r.cells.map(c => csvCell(c, delimiter)).join(delimiter)),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
