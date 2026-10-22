// The security overview as CSV text. Pure and vscode-free. Veracode tickets give one row per finding (so file and
// line can be filtered and sorted), Waltz tickets one row per ticket with its components joined in one cell.
// Cells come from Jira and from a scanner report, so any cell a spreadsheet could read as a formula is prefixed.
import type { Overview, OverviewRow, OverviewTable } from './securityOverview';
import { severityLabel } from './veracodeReport';

export const CSV_BOM = '﻿';

const COMMON_COLUMNS = ['Source', 'Ticket', 'Status', 'Summary', 'Rating', 'Due Date', 'Fix Version', 'Release Date', 'Other Fix Versions', 'Flag'];
const VERACODE_COLUMNS = ['Issue ID', 'Severity', 'CWE ID', 'CWE name', 'Module', 'Path', 'File', 'Line', 'Function'];
const WALTZ_COLUMNS = ['Members', 'Remediation action', 'Policy date', 'Planned date', 'Plan deadline', 'Plan status'];

const FLAG_TEXT = { overdue: 'overdue', 'due-before-release': 'due before release' } as const;
const MATCH_TEXT = { tracked: 'tracked', stale: 'stale', 'in-report-no-ticket': 'in report, no ticket' } as const;
const SOURCE_TEXT = { veracode: 'Veracode', waltz: 'Waltz' } as const;

/**
 * One CSV cell. A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with an apostrophe so a
 * spreadsheet shows it as text; a cell holding the delimiter, a quote or a line break is quoted.
 */
export function csvCell(value: string | number | null | undefined, delimiter: string): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text;
}

function distinct(values: Array<string | null>): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ''))].join('; ');
}

function earliest(values: Array<string | null>): string {
  const valid = values.filter((v): v is string => v !== null);
  return valid.length === 0 ? '' : valid.reduce((a, b) => (b < a ? b : a));
}

function commonCells(row: OverviewRow, table: OverviewTable, hasReport: boolean): Array<string | null> {
  return [
    SOURCE_TEXT[row.source], row.ticketKey, row.status, row.summary, row.rating, row.dueDate,
    row.fixVersion, table.releaseDate, row.otherFixVersions.join('; '), row.flag ? FLAG_TEXT[row.flag] : '',
    ...(hasReport ? [row.reportMatch ? MATCH_TEXT[row.reportMatch] : ''] : []),
  ];
}

/**
 * The whole overview as CSV: a header row and the rows of every table in order. `Report match` is a column only for an
 * import export. The text starts with a byte-order mark so a spreadsheet reads it as UTF-8.
 */
export function renderOverviewCsv(overview: Overview, delimiter = ','): string {
  const header = [...COMMON_COLUMNS, ...(overview.hasReport ? ['Report match'] : []), 'Detail source', ...VERACODE_COLUMNS, ...WALTZ_COLUMNS];
  const lines: string[] = [header.map(h => csvCell(h, delimiter)).join(delimiter)];
  const emptyVeracode = VERACODE_COLUMNS.map(() => '');
  const emptyWaltz = WALTZ_COLUMNS.map(() => '');

  for (const table of overview.tables) {
    for (const row of table.rows) {
      const lead = [...commonCells(row, table, overview.hasReport), row.detailSource];
      const emit = (cells: Array<string | number | null>): void => {
        lines.push([...lead, ...cells].map(c => csvCell(c, delimiter)).join(delimiter));
      };
      if (row.source === 'veracode') {
        if (row.findings.length === 0) emit([...emptyVeracode, ...emptyWaltz]);
        for (const f of row.findings) {
          emit([
            f.issueId, f.severity === null ? '' : severityLabel(f.severity), f.cweId, f.cweName, f.module, f.path, f.file, f.line, f.functionName,
            ...emptyWaltz,
          ]);
        }
      } else {
        const c = row.components;
        emit([
          ...emptyVeracode,
          c.map(m => m.nameVersion ?? '').filter(n => n !== '').join('; '),
          distinct(c.map(m => m.remediationAction)),
          earliest(c.map(m => m.policyDate)),
          earliest(c.map(m => m.plannedDate)),
          earliest(c.map(m => m.planDeadline)),
          distinct(c.map(m => m.planStatus)),
        ]);
      }
    }
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
