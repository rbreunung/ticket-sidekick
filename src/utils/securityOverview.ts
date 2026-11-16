// The security overview: Veracode and Waltz tickets grouped by Jira Fix Version, with the flags, counts and Jira
// links the boards' tables and the CSV and Excel exports are rendered from. Pure and vscode-free; both entry points (the
// security report board and the import board's export) assemble an {@link OverviewInput} and share everything else.
import type { OverviewTicket, ProjectVersionInfo } from '../services/TicketService';
import { quoteJqlValue } from './searchConstraints';
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

/** Today's date in local time as `YYYY-MM-DD`, which is how Due Dates and release dates compare. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A key-list query above this many keys is replaced by the label-based query. */
export const JQL_KEY_CAP = 100;

const FLAG_ORDER: Record<string, number> = { overdue: 0, 'due-before-release': 1 };

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
    ? `project = ${input.projectKey} AND resolution is EMPTY AND (labels = "veracode" OR labels = "oss-dependency") AND ${table.fixVersion === null ? 'fixVersion is EMPTY' : `fixVersion = ${quoteJqlValue(table.fixVersion)}`}`
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
