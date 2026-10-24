// The security overview: Veracode and Waltz tickets grouped by Jira Fix Version, with the flags, counts and Jira
// links the chat tables and the CSV are rendered from. Pure and vscode-free; both entry points (the standalone
// command and the `export` reply in an import) assemble an {@link OverviewInput} and share everything else.
import type { OverviewTicket, ProjectVersionInfo } from '../services/TicketService';
import { neutralizeMarkdownLinks } from '../participant/session/primitives';
import { readVeracodeFindings, type TicketFinding } from './veracodeFindingsTable';
import { readWaltzComponents, type TicketComponent } from './waltzComponentsTable';
import { severityLabel, type VeracodeFlaw } from './veracodeReport';
import { vulnRatingRank, type WaltzComponent } from './waltzReport';

export type OverviewSource = 'veracode' | 'waltz';
export type OverviewFlag = 'overdue' | 'due-before-release' | null;
export type ReportMatch = 'tracked' | 'stale' | 'in-report-no-ticket';
/** Where a row's detail came from, best first. `report` is the loaded report (an import export only). */
export type OverviewDetailSource = 'report' | 'table' | 'legacy' | 'title-labels';

/** An item the report holds that has no ticket yet (a New row of an import). */
export interface ReportOnlyItem {
  source: OverviewSource;
  summary: string;
  findings?: TicketFinding[];
  components?: TicketComponent[];
  dueDate: string | null;
}

export interface OverviewInput {
  tickets: OverviewTicket[];
  /** Descriptions by ticket key; a missing or null entry reads as unknown and drops that ticket to the title-and-labels layer. */
  descriptions: Record<string, string | null | undefined>;
  versions: ProjectVersionInfo[];
  /** `YYYY-MM-DD`. */
  today: string;
  baseUrl?: string;
  /** Needed for the label-based Jira links. */
  projectKey?: string;
  /** Present for an import export: the report's view of each ticket, the report-only items, and detail read from the report itself. */
  report?: {
    matchByKey: Record<string, 'tracked' | 'stale'>;
    reportOnly: ReportOnlyItem[];
    detailByKey?: Record<string, { findings?: TicketFinding[]; components?: TicketComponent[] }>;
  };
}

export interface OverviewRow {
  source: OverviewSource;
  ticketKey: string | null;
  status: string | null;
  summary: string;
  /** Veracode: the most severe finding's label; Waltz: the highest rating. Empty when unknown. */
  rating: string;
  dueDate: string | null;
  fixVersion: string | null;
  otherFixVersions: string[];
  flag: OverviewFlag;
  reportMatch: ReportMatch | null;
  detailSource: OverviewDetailSource;
  /** The ticket text and its labels disagree about which findings or components it holds. */
  edited: boolean;
  findings: TicketFinding[];
  components: TicketComponent[];
}

export interface OverviewCounts {
  /** Tickets in the table. */
  tickets: number;
  /** Rows in the table: tickets plus report-only items. */
  items: number;
  overdue: number;
  dueBeforeRelease: number;
  noDueDate: number;
}

export interface OverviewJira {
  jql: string;
  /** The ticket keys the query lists, or `labels` when it is label-based. */
  kind: 'keys' | 'labels';
  /** A key-list query had too many keys and the label-based query is shown instead. */
  fellBack: boolean;
  url: string | null;
}

export interface OverviewTable {
  /** The Fix Version name; null for the Not assigned table. */
  fixVersion: string | null;
  releaseDate: string | null;
  rows: OverviewRow[];
  counts: OverviewCounts;
  /** Items in the table with no ticket yet, which no Jira list can show. */
  noTicket: number;
  jira: OverviewJira | null;
}

export interface Overview {
  tables: OverviewTable[];
  ticketCount: number;
  bySource: Record<OverviewSource, number>;
  hasReport: boolean;
  /** Tickets whose description could not be read, so their detail is limited to the title and labels. */
  unreadCount: number;
}

/** The file formats the overview can be saved as. */
export type OverviewFormat = 'csv' | 'xlsx';

const FORMAT_WORDS = new Map<string, OverviewFormat>([['csv', 'csv'], ['xlsx', 'xlsx'], ['excel', 'xlsx']]);

/** What a `@jira /overview` prompt asks for: the project (an upper-case key, or a lone lower-case word) and the file format to save, if any (`csv`, or `xlsx` / `excel`; the first one named wins). */
export function parseOverviewPrompt(prompt: string): { projectKey: string | null; format: OverviewFormat | null } {
  const tokens = prompt.split(/[\s,;]+/).filter(Boolean);
  const format = tokens.map(t => FORMAT_WORDS.get(t.toLowerCase())).find((f): f is OverviewFormat => f !== undefined) ?? null;
  const rest = tokens.filter(t => !FORMAT_WORDS.has(t.toLowerCase()));
  const upper = rest.find(t => /^[A-Z][A-Z0-9_]+$/.test(t));
  if (upper) return { projectKey: upper, format };
  const lone = rest.length === 1 && /^[A-Za-z][A-Za-z0-9_]+$/.test(rest[0]) ? rest[0].toUpperCase() : null;
  return { projectKey: lone, format };
}

/** Today's date in local time as `YYYY-MM-DD`, which is how Due Dates and release dates compare. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A key-list query above this many keys is replaced by the label-based query. */
export const JQL_KEY_CAP = 100;

const FLAG_ORDER: Record<string, number> = { overdue: 0, 'due-before-release': 1 };

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function earliestDate(dates: Array<string | null | undefined>): string | null {
  const valid = dates.filter((d): d is string => typeof d === 'string' && d !== '');
  return valid.length === 0 ? null : valid.reduce((a, b) => (b < a ? b : a));
}

/** The record a flaw of the loaded report corresponds to (exact: it comes straight from the parsed report). */
export function findingFromFlaw(flaw: VeracodeFlaw): TicketFinding {
  return {
    issueId: flaw.issueId,
    severity: flaw.severity,
    cweId: flaw.cweId,
    cweName: flaw.cweName,
    module: flaw.module,
    path: flaw.sourceFilePath,
    file: flaw.sourceFile,
    line: flaw.line,
    functionName: flaw.functionPrototype,
    approximate: false,
    detailSource: 'table',
  };
}

/** The record a component of the loaded report corresponds to. */
export function componentFromWaltz(component: WaltzComponent): TicketComponent {
  const r = component.remediation;
  return {
    nameVersion: component.nameVersion,
    rating: component.maxVulnRating,
    remediationAction: component.remediationAction,
    cveCount: component.vulnerabilities.length,
    artifactCount: component.instancePaths.length,
    policyDate: r?.policyDate ?? null,
    plannedDate: r?.plannedDate ?? null,
    attestationDate: r?.attestationDate ?? null,
    planStatus: r?.planStatus ?? null,
    approximate: false,
    detailSource: 'table',
  };
}

function veracodeRating(findings: TicketFinding[]): string {
  const severities = findings.map(f => f.severity).filter((s): s is number => s !== null);
  return severities.length === 0 ? '' : severityLabel(Math.max(...severities));
}

function waltzRating(components: TicketComponent[]): string {
  const ratings = components.map(c => c.rating).filter((r): r is string => r !== null);
  return ratings.length === 0 ? '' : ratings.reduce((a, b) => (vulnRatingRank(b) > vulnRatingRank(a) ? b : a));
}

interface Placement { fixVersion: string | null; releaseDate: string | null; others: string[] }

/** The release a ticket is listed under: its earliest Fix Version by release date (undated last, then by name). */
function placeTicket(fixVersions: string[], releaseByName: Map<string, string | null>): Placement {
  if (fixVersions.length === 0) return { fixVersion: null, releaseDate: null, others: [] };
  const ordered = [...fixVersions].sort((a, b) => {
    const da = releaseByName.get(a) ?? null;
    const db = releaseByName.get(b) ?? null;
    if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
    return a.localeCompare(b);
  });
  return { fixVersion: ordered[0], releaseDate: releaseByName.get(ordered[0]) ?? null, others: ordered.slice(1) };
}

function flagFor(dueDate: string | null, releaseDate: string | null, today: string): OverviewFlag {
  if (dueDate === null) return null;
  if (dueDate < today) return 'overdue';
  if (releaseDate !== null && dueDate < releaseDate) return 'due-before-release';
  return null;
}

/**
 * The release a ticket without a Fix Version is compared with: the latest release date among the project's unreleased
 * versions. Released versions are in the past and hold closed tickets, so they never move it. Null when there is none.
 */
function lastUnreleasedRelease(versions: ProjectVersionInfo[]): string | null {
  const dates = versions.filter(v => v.released !== true && v.releaseDate !== null).map(v => v.releaseDate as string);
  return dates.length === 0 ? null : dates.reduce((a, b) => (b > a ? b : a));
}

function countsOf(rows: OverviewRow[]): OverviewCounts {
  return {
    tickets: rows.filter(r => r.ticketKey !== null).length,
    items: rows.length,
    overdue: rows.filter(r => r.flag === 'overdue').length,
    dueBeforeRelease: rows.filter(r => r.flag === 'due-before-release').length,
    noDueDate: rows.filter(r => r.dueDate === null).length,
  };
}

function compareRows(a: OverviewRow, b: OverviewRow): number {
  const fa = a.flag === null ? 2 : FLAG_ORDER[a.flag];
  const fb = b.flag === null ? 2 : FLAG_ORDER[b.flag];
  if (fa !== fb) return fa - fb;
  if (a.dueDate !== b.dueDate) return a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1;
  return (a.ticketKey ?? '~').localeCompare(b.ticketKey ?? '~', undefined, { numeric: true });
}

/** The Jira list for one table: a key list for an import export, the label-based query for the standalone export. */
function jiraFor(table: { fixVersion: string | null; rows: OverviewRow[] }, input: OverviewInput): OverviewJira | null {
  const keys = table.rows.map(r => r.ticketKey).filter((k): k is string => k !== null);
  if (keys.length === 0) return null;
  const labelQuery = input.projectKey
    ? `project = ${input.projectKey} AND resolution is EMPTY AND (labels = "veracode" OR labels = "oss-dependency") AND ${table.fixVersion === null ? 'fixVersion is EMPTY' : `fixVersion = ${quoteJql(table.fixVersion)}`}`
    : null;
  const wantKeys = input.report !== undefined;
  let jql: string;
  let kind: 'keys' | 'labels';
  let fellBack = false;
  if (wantKeys && (keys.length <= JQL_KEY_CAP || labelQuery === null)) {
    jql = `key in (${keys.join(', ')})`;
    kind = 'keys';
  } else if (labelQuery !== null) {
    jql = labelQuery;
    kind = 'labels';
    fellBack = wantKeys;
  } else {
    return null;
  }
  return { jql, kind, fellBack, url: input.baseUrl ? `${input.baseUrl}/issues/?jql=${encodeURIComponent(jql)}` : null };
}

function rowFromTicket(ticket: OverviewTicket, input: OverviewInput, placement: Placement, unplannedRelease: string | null): OverviewRow {
  const description = input.descriptions[ticket.key] ?? null;
  const reported = input.report?.detailByKey?.[ticket.key];
  const base = {
    source: ticket.source,
    ticketKey: ticket.key,
    status: ticket.status,
    summary: ticket.summary,
    dueDate: ticket.dueDate,
    fixVersion: placement.fixVersion,
    otherFixVersions: placement.others,
    flag: flagFor(ticket.dueDate, placement.fixVersion === null ? unplannedRelease : placement.releaseDate, input.today),
    reportMatch: input.report ? (input.report.matchByKey[ticket.key] ?? 'tracked') : null,
  };
  if (ticket.source === 'veracode') {
    const read = readVeracodeFindings(description, { summary: ticket.summary, labels: ticket.labels });
    const findings = reported?.findings ?? read.findings;
    return { ...base, rating: veracodeRating(findings), findings, components: [], detailSource: reported?.findings ? 'report' : read.detailSource, edited: reported?.findings ? false : read.edited };
  }
  const read = readWaltzComponents(description, { summary: ticket.summary, labels: ticket.labels });
  const components = reported?.components ?? read.components;
  return { ...base, rating: waltzRating(components), findings: [], components, detailSource: reported?.components ? 'report' : read.detailSource, edited: reported?.components ? false : read.edited };
}

function rowFromReportOnly(item: ReportOnlyItem, today: string, unplannedRelease: string | null): OverviewRow {
  const findings = item.findings ?? [];
  const components = item.components ?? [];
  return {
    source: item.source,
    ticketKey: null,
    status: null,
    summary: item.summary,
    rating: item.source === 'veracode' ? veracodeRating(findings) : waltzRating(components),
    dueDate: item.dueDate,
    fixVersion: null,
    otherFixVersions: [],
    flag: flagFor(item.dueDate, unplannedRelease, today),
    reportMatch: 'in-report-no-ticket',
    detailSource: 'report',
    edited: false,
    findings,
    components,
  };
}

/**
 * Groups the tickets (and, for an import export, the report-only items) by Fix Version. A table exists for each
 * Fix Version that has a ticket, ordered by release date with undated versions last; the Not assigned table
 * comes last and holds tickets without a Fix Version plus every report-only item.
 */
export function buildOverview(input: OverviewInput): Overview {
  const releaseByName = new Map(input.versions.map(v => [v.name, v.releaseDate] as const));
  const unplannedRelease = lastUnreleasedRelease(input.versions);
  const byVersion = new Map<string, OverviewRow[]>();
  const unassigned: OverviewRow[] = [];
  const releaseOf = new Map<string, string | null>();

  for (const ticket of input.tickets) {
    const placement = placeTicket(ticket.fixVersions, releaseByName);
    const row = rowFromTicket(ticket, input, placement, unplannedRelease);
    if (placement.fixVersion === null) {
      unassigned.push(row);
    } else {
      const rows = byVersion.get(placement.fixVersion) ?? [];
      rows.push(row);
      byVersion.set(placement.fixVersion, rows);
      releaseOf.set(placement.fixVersion, placement.releaseDate);
    }
  }
  for (const item of input.report?.reportOnly ?? []) unassigned.push(rowFromReportOnly(item, input.today, unplannedRelease));

  const versionNames = [...byVersion.keys()].sort((a, b) => {
    const da = releaseOf.get(a) ?? null;
    const db = releaseOf.get(b) ?? null;
    if (da !== db) return da === null ? 1 : db === null ? -1 : da < db ? -1 : 1;
    return a.localeCompare(b);
  });

  const tables: OverviewTable[] = [];
  const addTable = (fixVersion: string | null, rows: OverviewRow[]): void => {
    const sorted = [...rows].sort(compareRows);
    tables.push({
      fixVersion,
      releaseDate: fixVersion === null ? null : releaseOf.get(fixVersion) ?? null,
      rows: sorted,
      counts: countsOf(sorted),
      noTicket: sorted.filter(r => r.ticketKey === null).length,
      jira: jiraFor({ fixVersion, rows: sorted }, input),
    });
  };
  for (const name of versionNames) addTable(name, byVersion.get(name)!);
  if (unassigned.length > 0) addTable(null, unassigned);

  return {
    tables,
    ticketCount: input.tickets.length,
    bySource: {
      veracode: input.tickets.filter(t => t.source === 'veracode').length,
      waltz: input.tickets.filter(t => t.source === 'waltz').length,
    },
    hasReport: input.report !== undefined,
    unreadCount: input.tickets.filter(t => input.descriptions[t.key] == null).length,
  };
}

// --- Chat text ------------------------------------------------------------------------------------------

const FLAG_TEXT: Record<Exclude<OverviewFlag, null>, string> = { overdue: '⚠ overdue', 'due-before-release': '⚠ due before release' };
const MATCH_TEXT: Record<ReportMatch, string> = { tracked: 'tracked', stale: 'stale', 'in-report-no-ticket': 'in report, no ticket' };

/** One table cell of untrusted text: no markup that could become a link, a break or another cell. */
function chatCell(value: string): string {
  return neutralizeMarkdownLinks(value).replace(/\r?\n|\r/g, ' ').replace(/\|/g, '/').trim();
}

function ticketCell(row: OverviewRow, baseUrl?: string): string {
  if (row.ticketKey === null) return 'none';
  const key = baseUrl ? `[${row.ticketKey}](${baseUrl}/browse/${row.ticketKey})` : row.ticketKey;
  return row.status ? `${key} (${chatCell(row.status)})` : key;
}

function releaseTitle(table: OverviewTable): string {
  if (table.fixVersion === null) return 'Not assigned to a release';
  return table.releaseDate ? `${chatCell(table.fixVersion)} (releases ${table.releaseDate})` : `${chatCell(table.fixVersion)} (no release date)`;
}

function renderTable(table: OverviewTable, overview: Overview, baseUrl?: string): string[] {
  const withSource = !overview.hasReport;
  const headers = [...(withSource ? ['Source'] : []), 'Item', 'Rating', 'Ticket', 'Due', 'Flag', ...(overview.hasReport ? ['Report match'] : [])];
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of table.rows) {
    const item = chatCell(row.summary) + (row.otherFixVersions.length > 0 ? ` _(also in ${row.otherFixVersions.map(chatCell).join(', ')})_` : '');
    const cells = [
      ...(withSource ? [row.source === 'veracode' ? 'Veracode' : 'Waltz'] : []),
      item,
      chatCell(row.rating) || '–',
      ticketCell(row, baseUrl),
      row.dueDate ?? '–',
      row.flag ? FLAG_TEXT[row.flag] : '–',
      ...(overview.hasReport ? [row.reportMatch ? MATCH_TEXT[row.reportMatch] + (row.edited ? ', edited' : '') : '–'] : []),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

/** The overview as chat markdown: a summary table by release, then one table per release. All report and Jira text is neutralized. */
export function renderOverviewMarkdown(overview: Overview, baseUrl?: string): string {
  if (overview.tables.length === 0) {
    return overview.hasReport
      ? '_Nothing to list: the report has no items to export._'
      : '_No unresolved Veracode or Waltz tickets found in this project._';
  }
  const lines: string[] = [];
  const bySource = `Veracode ${overview.bySource.veracode}, Waltz ${overview.bySource.waltz}`;
  lines.push(`**Security overview — ${overview.ticketCount} unresolved ticket${overview.ticketCount === 1 ? '' : 's'}${overview.hasReport ? '' : ` (${bySource})`}**`, '');
  lines.push('| Fix Version | Assigned | Overdue | Due before release | No Due Date |', '| --- | --- | --- | --- | --- |');
  for (const t of overview.tables) {
    const assigned = t.fixVersion === null ? `${t.counts.items} item${t.counts.items === 1 ? '' : 's'}` : String(t.counts.tickets);
    lines.push(`| ${releaseTitle(t)} | ${assigned} | ${t.counts.overdue} | ${t.counts.dueBeforeRelease} | ${t.counts.noDueDate} |`);
  }
  lines.push('');
  for (const table of overview.tables) {
    lines.push(`**${releaseTitle(table)}**${table.jira?.url ? ` · [${table.counts.tickets} ticket${table.counts.tickets === 1 ? '' : 's'} in Jira](${table.jira.url})` : ''}`);
    if (table.jira?.fellBack) lines.push('_Too many tickets for a key list, so this link searches by label and Fix Version instead._');
    if (table.noTicket > 0) lines.push(`_${table.noTicket} item${table.noTicket === 1 ? ' has' : 's have'} no ticket yet, so no Jira list can show ${table.noTicket === 1 ? 'it' : 'them'}._`);
    lines.push('', ...renderTable(table, overview, baseUrl), '');
  }
  if (overview.unreadCount > 0) {
    lines.push(`_${overview.unreadCount} ticket${overview.unreadCount === 1 ? '' : 's'} could not be read in full, so ${overview.unreadCount === 1 ? 'its' : 'their'} detail is limited to the title and labels._`);
  }
  return lines.join('\n');
}
