// The security overview as a table of typed cells: the columns and their order, and the records (one per Veracode
// finding, one per Waltz ticket). The CSV and Excel renderers both read this, so their column order cannot drift.
// Pure and vscode-free.
import type { Overview, OverviewFlag, OverviewRow, OverviewTable } from './securityOverview';
import { severityLabel } from './veracodeReport';

export type ColumnKind = 'text' | 'number' | 'date';
/** A cell value. A `date` column holds `YYYY-MM-DD` text, a `number` column a number; null is an empty cell. */
export type Cell = string | number | null;

export interface OverviewColumn {
  title: string;
  kind: ColumnKind;
}

export interface OverviewRecord {
  /** The row's flag, which the Excel renderer turns into a fill. */
  flag: OverviewFlag;
  cells: Cell[];
}

export interface OverviewSheet {
  columns: OverviewColumn[];
  records: OverviewRecord[];
}

const text = (title: string): OverviewColumn => ({ title, kind: 'text' });
const date = (title: string): OverviewColumn => ({ title, kind: 'date' });

const LEAD_COLUMNS = [
  text('Source'), text('Ticket'), text('Status'), text('Summary'), text('Rating'),
  text('Fix Version'), date('Release Date'), date('Due Date'), date('Policy date'), date('Planned date'), date('Attestation date'),
  text('Other Fix Versions'), text('Flag'),
];
const REPORT_COLUMNS = [text('Report match')];
const DETAIL_COLUMNS = [text('Detail source')];
const VERACODE_COLUMNS = [
  text('Issue ID'), text('Severity'), text('CWE ID'), text('CWE name'), text('Module'), text('Path'), text('File'),
  { title: 'Line', kind: 'number' } as OverviewColumn, text('Function'),
];
const WALTZ_COLUMNS = [text('Remediation action'), text('Plan status'), text('Members')];

const FLAG_TEXT = { overdue: 'overdue', 'due-before-release': 'due before release' } as const;
const MATCH_TEXT = { tracked: 'tracked', stale: 'stale', 'in-report-no-ticket': 'in report, no ticket' } as const;
const SOURCE_TEXT = { veracode: 'Veracode', waltz: 'Waltz' } as const;

function distinct(values: Array<string | null>): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ''))].join('; ');
}

function earliest(values: Array<string | null>): string {
  const valid = values.filter((v): v is string => v !== null);
  return valid.length === 0 ? '' : valid.reduce((a, b) => (b < a ? b : a));
}

function leadCells(row: OverviewRow, table: OverviewTable, hasReport: boolean): Record<string, Cell> {
  const cells: Record<string, Cell> = {
    Source: SOURCE_TEXT[row.source],
    Ticket: row.ticketKey,
    Status: row.status,
    Summary: row.summary,
    Rating: row.rating,
    'Fix Version': row.fixVersion,
    'Release Date': table.releaseDate,
    'Due Date': row.dueDate,
    'Other Fix Versions': row.otherFixVersions.join('; '),
    Flag: row.flag ? FLAG_TEXT[row.flag] : '',
    'Detail source': row.detailSource,
  };
  if (hasReport) cells['Report match'] = row.reportMatch ? MATCH_TEXT[row.reportMatch] : '';
  return cells;
}

/**
 * The whole overview as one table: the columns and the records of every table in order. `Report match` is a column only
 * for an import export. A Veracode ticket gives a record per finding (one without findings gives a single record with
 * empty finding columns); a Waltz ticket gives one record with its components joined and the earliest of their dates.
 */
export function buildOverviewSheet(overview: Overview): OverviewSheet {
  const columns = [
    ...LEAD_COLUMNS, ...(overview.hasReport ? REPORT_COLUMNS : []), ...DETAIL_COLUMNS, ...VERACODE_COLUMNS, ...WALTZ_COLUMNS,
  ];
  const records: OverviewRecord[] = [];
  const push = (flag: OverviewFlag, cells: Record<string, Cell>): void => {
    records.push({ flag, cells: columns.map(c => cells[c.title] ?? null) });
  };

  for (const table of overview.tables) {
    for (const row of table.rows) {
      const lead = leadCells(row, table, overview.hasReport);
      if (row.source === 'veracode') {
        if (row.findings.length === 0) push(row.flag, lead);
        for (const f of row.findings) {
          push(row.flag, {
            ...lead,
            'Issue ID': f.issueId,
            Severity: f.severity === null ? '' : severityLabel(f.severity),
            'CWE ID': f.cweId,
            'CWE name': f.cweName,
            Module: f.module,
            Path: f.path,
            File: f.file,
            Line: f.line,
            Function: f.functionName,
          });
        }
      } else {
        const c = row.components;
        push(row.flag, {
          ...lead,
          'Policy date': earliest(c.map(m => m.policyDate)),
          'Planned date': earliest(c.map(m => m.plannedDate)),
          'Attestation date': earliest(c.map(m => m.attestationDate)),
          'Remediation action': distinct(c.map(m => m.remediationAction)),
          'Plan status': distinct(c.map(m => m.planStatus)),
          Members: c.map(m => m.nameVersion ?? '').filter(n => n !== '').join('; '),
        });
      }
    }
  }
  return { columns, records };
}
