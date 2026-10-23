// The findings table every Veracode ticket description carries, and the reader that turns a ticket's
// text back into per-finding records. Pure and vscode-free. The column titles are shared by the builder
// (veracodeReport.ts) and the reader below, and a round-trip test builds a description and reads it
// back, so a wording change cannot break the reader silently (same pattern as waltzDates.ts).
//
// The table holds display-sanitized text: the import's sanitizers change unusual characters in file
// names, paths and modules, so those fields are returned as written and marked approximate. Issue id,
// CWE id, severity and line are validated numeric when the report is parsed, so they are exact.
import { readWikiTables, normalizeTitle } from './wikiTableRead';

export const FINDINGS_COLUMNS = ['Issue ID', 'Severity', 'CWE', 'CWE name', 'Module', 'Path', 'File', 'Line', 'Function'] as const;
/** The columns of the slimmer table a very large fold falls back to when even the full table exceeds the size budget. */
export const SLIM_FINDINGS_COLUMNS = ['Issue ID', 'Severity', 'CWE', 'File', 'Line'] as const;
export const ABSENT_CELL = 'n/a';

/** Where a finding's detail was read from, best first. `report` is added by the import export. */
export type FindingDetailSource = 'table' | 'legacy' | 'title-labels';

export interface TicketFinding {
  issueId: string;
  /** 0..5, null when the ticket text does not carry it. */
  severity: number | null;
  cweId: string | null;
  cweName: string | null;
  module: string | null;
  path: string | null;
  file: string | null;
  line: number | null;
  functionName: string | null;
  /** True when a text field (name, module, path, file, function) may differ from the report because of sanitizing or fusing. */
  approximate: boolean;
  detailSource: FindingDetailSource;
}

export interface ReadFindingsResult {
  findings: TicketFinding[];
  /** The best layer any finding was read from. */
  detailSource: FindingDetailSource;
  /** The text records finding ids that the ticket's `veracode-issue-<id>` labels do not (or the reverse): the ticket was edited. */
  edited: boolean;
}

export interface TicketTextContext {
  /** The ticket's summary, used only by the title-and-labels layer. */
  summary: string | null;
  labels: string[];
}

const ISSUE_LABEL = /^veracode-issue-(\d+)$/;
const CWE_LABEL = /^cwe-(\d+)$/;

function cellOrNull(cell: string | undefined): string | null {
  const text = (cell ?? '').trim();
  return text === '' || text === ABSENT_CELL ? null : text;
}

function intOrNull(cell: string | undefined): number | null {
  const text = (cell ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function severityOf(cell: string | undefined): number | null {
  const match = /\((\d)\)\s*$/.exec((cell ?? '').trim());
  return match ? Number(match[1]) : null;
}

function cweIdOf(cell: string | undefined): string | null {
  const match = /CWE-(\d+)/i.exec(cell ?? '');
  return match ? match[1] : null;
}

function labelIds(labels: string[]): string[] {
  return labels.map(l => ISSUE_LABEL.exec(l)?.[1]).filter((id): id is string => id !== undefined);
}

function columnIndex(titles: string[], name: string): number {
  return titles.indexOf(normalizeTitle(name));
}

function fromCurrentTable(titles: string[], rows: string[][]): TicketFinding[] {
  const at = Object.fromEntries(FINDINGS_COLUMNS.map(c => [c, columnIndex(titles, c)])) as Record<(typeof FINDINGS_COLUMNS)[number], number>;
  return rows
    .filter(r => /^\d+$/.test((r[at['Issue ID']] ?? '').trim()))
    .map(r => ({
      issueId: r[at['Issue ID']].trim(),
      severity: severityOf(r[at.Severity]),
      cweId: cweIdOf(r[at.CWE]),
      cweName: cellOrNull(r[at['CWE name']]),
      module: cellOrNull(r[at.Module]),
      path: cellOrNull(r[at.Path]),
      file: cellOrNull(r[at.File]),
      line: intOrNull(r[at.Line]),
      functionName: cellOrNull(r[at.Function]),
      approximate: true,
      detailSource: 'table' as const,
    }));
}

/** Splits a fused `path/file.ext` into its parts at the last separator. */
function splitPathAndFile(fused: string): { path: string | null; file: string } {
  const cut = Math.max(fused.lastIndexOf('/'), fused.lastIndexOf('\\'));
  return cut < 0 ? { path: null, file: fused } : { path: fused.slice(0, cut + 1), file: fused.slice(cut + 1) };
}

/** Splits a `location:line` text at its last colon when the tail is a line number. */
function splitLocationAndLine(text: string): { location: string; line: number | null } {
  const match = /^(.*):(\d+)$/.exec(text.trim());
  return match ? { location: match[1], line: Number(match[2]) } : { location: text.trim(), line: null };
}

/** The folded overview table older tickets carry: Issue ID, Severity, CWE, Location (path, file and line fused), Function. */
function fromLegacyTable(titles: string[], rows: string[][]): TicketFinding[] {
  const id = columnIndex(titles, 'Issue ID');
  const severity = columnIndex(titles, 'Severity');
  const cwe = columnIndex(titles, 'CWE');
  const location = columnIndex(titles, 'Location');
  const fn = columnIndex(titles, 'Function');
  return rows
    .filter(r => /^\d+$/.test((r[id] ?? '').trim()))
    .map(r => {
      const { location: where, line } = splitLocationAndLine(cellOrNull(r[location]) ?? '');
      const split = where ? splitPathAndFile(where) : null;
      return {
        issueId: r[id].trim(),
        severity: severityOf(r[severity]),
        cweId: cweIdOf(r[cwe]),
        cweName: null,
        module: null,
        path: split?.path ?? null,
        file: split?.file ?? null,
        line,
        functionName: cellOrNull(r[fn]),
        approximate: true,
        detailSource: 'legacy' as const,
      };
    });
}

/** The one-finding layout older tickets carry: a Location block (Module / File / Function) under an `Issue <id>` heading. */
function fromLegacyBlock(wiki: string, labels: string[]): TicketFinding[] {
  const lines = wiki.split(/\r?\n/).map(l => l.trim());
  const valueOf = (key: string): string | null => {
    const line = lines.find(l => l.startsWith(`${key}:`));
    return line ? cellOrNull(line.slice(key.length + 1)) : null;
  };
  const module = valueOf('Module');
  const fileText = valueOf('File');
  if (module === null && fileText === null) return [];
  const heading = lines.map(l => /^h\d\.\s*Issue\s+(\d+)/i.exec(l)?.[1]).find((v): v is string => v !== undefined);
  const issueId = heading ?? labelIds(labels)[0];
  if (issueId === undefined) return [];
  const { location, line } = splitLocationAndLine(fileText ?? '');
  const split = location ? splitPathAndFile(location) : null;
  const severityLine = lines.findIndex(l => /^h\d\.\s*Severity/i.test(l));
  const cweLine = lines.find(l => /\[CWE-\d+\|/.test(l));
  return [{
    issueId,
    severity: severityLine >= 0 ? severityOf(lines[severityLine + 1]) : null,
    cweId: cweLine ? cweIdOf(cweLine) : null,
    cweName: cweLine ? cellOrNull(cweLine.replace(/^.*?\]\s*(?:—|-)?\s*/, '')) : null,
    module,
    path: split?.path ?? null,
    file: split?.file ?? null,
    line,
    functionName: valueOf('Function'),
    approximate: true,
    detailSource: 'legacy',
  }];
}

/** The last layer: ids and CWE ids from the labels, the file (and, for one finding, the line) from the title. */
function fromTitleAndLabels(context: TicketTextContext): TicketFinding[] {
  const ids = labelIds(context.labels);
  const cwes = context.labels.map(l => CWE_LABEL.exec(l)?.[1]).filter((id): id is string => id !== undefined);
  const summary = context.summary ?? '';
  const single = /^\d+ - (.+?)(?::(\d+))? - /.exec(summary);
  const folded = single ? null : /^(.+?)(?: \+\d+ files?)? - /.exec(summary);
  const file = single ? single[1] : folded ? folded[1] : null;
  const line = single?.[2] ? Number(single[2]) : null;
  return ids.map(issueId => ({
    issueId,
    severity: null,
    cweId: cwes.length === 1 ? cwes[0] : null,
    cweName: null,
    module: null,
    path: null,
    file,
    line: ids.length === 1 ? line : null,
    functionName: null,
    approximate: true,
    detailSource: 'title-labels' as const,
  }));
}

const SOURCE_RANK: Record<FindingDetailSource, number> = { table: 0, legacy: 1, 'title-labels': 2 };

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
}

/**
 * The per-finding records a Veracode ticket's description (Jira wiki text) holds, read in layers:
 * the findings table, the older folded overview table or one-finding Location block, then the
 * ticket's labels and title. Lenient by design: column titles match case-insensitively and in any
 * order, and nothing here throws. The text comes from Jira, so only digits are trusted as numbers.
 */
export function readVeracodeFindings(wiki: string | null | undefined, context: TicketTextContext): ReadFindingsResult {
  const text = wiki ?? '';
  const ids = labelIds(context.labels);
  let findings: TicketFinding[] = [];

  for (const table of readWikiTables(text)) {
    if (columnIndex(table.titles, 'Issue ID') < 0) continue;
    // The full table, or the slim one a very large fold falls back to (no Path, Module, CWE name or Function column).
    if (columnIndex(table.titles, 'File') >= 0) {
      findings = fromCurrentTable(table.titles, table.rows);
    } else if (columnIndex(table.titles, 'Location') >= 0) {
      findings = fromLegacyTable(table.titles, table.rows);
    }
    if (findings.length > 0) break;
  }
  if (findings.length === 0) findings = fromLegacyBlock(text, context.labels);
  if (findings.length === 0) findings = fromTitleAndLabels(context);

  const best = findings.reduce<FindingDetailSource>((acc, f) => (SOURCE_RANK[f.detailSource] < SOURCE_RANK[acc] ? f.detailSource : acc), 'title-labels');
  const readIds = findings.map(f => f.issueId);
  const edited = findings.length > 0 && findings[0].detailSource !== 'title-labels' && ids.length > 0 && !sameIds(readIds, ids);
  return { findings, detailSource: findings.length === 0 ? 'title-labels' : best, edited };
}
