// Pure, vscode-free date logic for the Waltz import's remediation dates (see docs/report-import.md).
// Dates travel as `YYYY-MM-DD` strings from the parser to Jira so no time zone can shift a day.

export interface RemediationDates {
  /** Expected Remediation column: the date the policy requires the component to be fixed by. */
  policyDate: string | null;
  /** Remediation Target Date column: the team's own planned date, only present on `Remediate` rows. */
  plannedDate: string | null;
  /** Attested Rem Plan Due By column: the deadline for filing a remediation plan. */
  planDeadline: string | null;
}

export interface WaltzRemediation extends RemediationDates {
  /** The report's own plan-status reason (for example Overdue or Unplanned), as written; null when blank. */
  planStatus: string | null;
  /** The report's "Extracted On" date, which the plan status is labelled with; null when the report has none. */
  reportDate: string | null;
}

export type DateKind = 'policy' | 'planned' | 'deadline';

export interface DateChange {
  date: DateKind;
  from: string | null;
  to: string | null;
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Reads a cell value as a calendar date: a `Date` through its UTC parts, or a string whose first
 * ten characters are a real `YYYY-MM-DD` date (so a time part is dropped). Anything else is no date.
 */
export function toCalendarDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const match = CALENDAR_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  // Build the date in UTC and compare the parts back, which rejects 2026-02-30 and 2026-13-01.
  const built = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const roundTrips = built.getUTCFullYear() === Number(year)
    && built.getUTCMonth() === Number(month) - 1
    && built.getUTCDate() === Number(day);
  return roundTrips ? `${year}-${month}-${day}` : null;
}

export function hasAnyDate(dates: RemediationDates | null | undefined): boolean {
  return !!dates && (dates.policyDate !== null || dates.plannedDate !== null || dates.planDeadline !== null);
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
    ['deadline', recorded.planDeadline, reported.planDeadline],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([date, from, to]) => ({ date, from, to }));
}
