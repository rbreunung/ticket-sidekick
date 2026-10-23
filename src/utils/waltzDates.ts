import { toCalendarDate } from './calendarDate';
import { sanitizeCellText } from './reportImport';
import { normalizeTitle, splitHeaderRow, splitDataRow } from './wikiTableRead';

// Pure, vscode-free date logic for the Waltz import's remediation dates (see docs/report-import.md).
// Dates travel as `YYYY-MM-DD` strings from the parser to Jira so no time zone can shift a day.

export interface RemediationDates {
  /** Expected Remediation column: the date the policy requires the component to be fixed by. */
  policyDate: string | null;
  /** Remediation Target Date column: the team's own planned date, only present on `Remediate` rows. */
  plannedDate: string | null;
  /** Attested Rem Plan Due By column: the date the remediation plan was attested. */
  attestationDate: string | null;
}

export interface WaltzRemediation extends RemediationDates {
  /** The report's own plan-status reason (for example Overdue or Unplanned), as written; null when blank. */
  planStatus: string | null;
  /** The report's "Extracted On" date, which the plan status is labelled with; null when the report has none. */
  reportDate: string | null;
}

export type DateKind = 'policy' | 'planned' | 'attestation' | 'due';

export interface DateChange {
  date: DateKind;
  from: string | null;
  to: string | null;
}

export function hasAnyDate(dates: RemediationDates | null | undefined): boolean {
  return !!dates && (dates.policyDate !== null || dates.plannedDate !== null || dates.attestationDate !== null);
}

/** The Jira Due Date for one component: the planned date, else the policy date. */
export function effectiveDueDate(dates: RemediationDates | null | undefined): string | null {
  return dates?.plannedDate ?? dates?.policyDate ?? null;
}

/** The Due Date for a folded or merged ticket: the earliest of its members' dates, null when none has one. */
export function earliestDueDate(members: ReadonlyArray<RemediationDates | null | undefined>): string | null {
  let earliest: string | null = null;
  for (const member of members) {
    const due = effectiveDueDate(member);
    // `YYYY-MM-DD` strings order correctly as plain strings.
    if (due !== null && (earliest === null || due < earliest)) earliest = due;
  }
  return earliest;
}

/**
 * The dates that differ between what a ticket recorded and what the report says now. An absent value
 * on one side against a date on the other is a difference. The plan status is deliberately not
 * compared: it moves with the clock, so comparing it would flag unchanged rows.
 */
export function diffRemediationDates(recorded: RemediationDates, reported: RemediationDates): DateChange[] {
  const pairs: Array<[DateKind, string | null, string | null]> = [
    ['policy', recorded.policyDate, reported.policyDate],
    ['planned', recorded.plannedDate, reported.plannedDate],
    ['attestation', recorded.attestationDate, reported.attestationDate],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([date, from, to]) => ({ date, from, to }));
}

// --- The date columns of a ticket description's components table -------------------------------------
// The column titles are shared by the builder (waltzReport.ts) and the reader below, and a
// round-trip test builds a description and reads it back, so a wording change cannot break the reader silently.

export const ABSENT_CELL = 'n/a';
export const COLUMN_POLICY = 'Policy date';
export const COLUMN_PLANNED = 'Planned date';
export const COLUMN_ATTESTATION = 'Attestation date';
export const COLUMN_STATUS = 'Plan status';
export const COLUMN_COMPONENT = 'Component';
export const COLUMN_RATING = 'Max rating';
export const COLUMN_ACTION = 'Remediation action';
export const COLUMN_CVES = 'CVEs';
export const COLUMN_ARTIFACTS = 'Artifacts';
/** The components table's leading columns; the four date columns follow (see {@link dateColumnTitles}). */
export const COMPONENT_COLUMNS = [COLUMN_COMPONENT, COLUMN_RATING, COLUMN_ACTION, COLUMN_CVES, COLUMN_ARTIFACTS] as const;

/** The four date columns' titles; the plan-status title carries the report's extraction date when it has one. */
export function dateColumnTitles(reportDate: string | null): string[] {
  return [COLUMN_POLICY, COLUMN_PLANNED, COLUMN_ATTESTATION, reportDate ? `${COLUMN_STATUS} (as of ${reportDate})` : COLUMN_STATUS];
}

const EXACT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date cell read back from a description: an exact `YYYY-MM-DD` date, anything else is no date. */
export function cellDate(cell: string | undefined): string | null {
  const text = (cell ?? '').trim();
  return EXACT_DATE.test(text) ? toCalendarDate(text) : null;
}

/**
 * The dates a ticket's description records for one component, read back from its "Remediation dates"
 * section or, on a folded ticket, from the overview-table row of that component. Lenient by design:
 * cells are trimmed, column titles match case-insensitively, a cell that is not an exact `YYYY-MM-DD`
 * date reads as no date, and a missing section, an unreadable table or a missing row gives null
 * ("no recorded dates"), never an error. The text comes from Jira, so only validated dates leave here.
 */
export function parseRecordedDates(wiki: string | null | undefined, componentName: string): RemediationDates | null {
  if (!wiki) return null;
  const lines = wiki.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = splitHeaderRow(lines[i]);
    if (!header) continue;
    const titles = header.map(normalizeTitle);
    const policy = titles.indexOf(COLUMN_POLICY.toLowerCase());
    if (policy < 0) continue;
    const planned = titles.indexOf(COLUMN_PLANNED.toLowerCase());
    const attestation = titles.indexOf(COLUMN_ATTESTATION.toLowerCase());
    const component = titles.indexOf(COLUMN_COMPONENT.toLowerCase());

    const rows: string[][] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const row = splitDataRow(lines[j]);
      if (!row) break;
      rows.push(row);
    }
    const wanted = sanitizeCellText(componentName).trim();
    const row = component < 0 ? rows[0] : rows.find(r => (r[component] ?? '').trim() === wanted);
    if (!row) return null;
    return { policyDate: cellDate(row[policy]), plannedDate: cellDate(row[planned]), attestationDate: cellDate(row[attestation]) };
  }
  return null;
}
