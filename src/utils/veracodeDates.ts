// Pure, vscode-free date logic for the Veracode import's SLA due dates (see docs/report-import.md).
// Dates travel as `YYYY-MM-DD` strings so no time zone can shift a day; callers pass the fallback start in,
// so this module needs no clock.

/** Severity names in the order of the report's numeric severity (0..5): the index is the severity number. */
export const SLA_SEVERITY_NAMES = ['Informational', 'Very Low', 'Low', 'Medium', 'High', 'Very High'] as const;

/** Days by severity number. A severity with no due date is absent. */
export type SlaDays = Partial<Record<number, number>>;

export interface ResolvedSla {
  days: SlaDays;
  /** Keys of the setting that name no severity; they change nothing. */
  unknownKeys: string[];
  /** Known severities whose value is not a whole number of zero or more; they get no due date. */
  invalidKeys: string[];
}

/** The part of a flaw the due date depends on, so this module does not import the report model. */
export interface DatedFlaw {
  severity: number;
  firstFoundDate?: string | null;
}

/**
 * Reads the `ticketSidekick.veracode.slaDays` setting. Names match ignoring case and surrounding spaces; 0
 * means no due date. A known severity with an invalid value gets no due date (it does not fall back to a
 * default) and is listed, as is an unknown key. An undefined, null or non-object value is no policy at all.
 */
export function resolveSlaDays(raw: unknown): ResolvedSla {
  const result: ResolvedSla = { days: {}, unknownKeys: [], invalidKeys: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const severity = SLA_SEVERITY_NAMES.findIndex(name => name.toLowerCase() === key.trim().toLowerCase());
    if (severity < 0) {
      result.unknownKeys.push(key);
    } else if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      result.invalidKeys.push(SLA_SEVERITY_NAMES[severity]);
    } else if (value > 0) {
      result.days[severity] = value;
    }
  }
  return result;
}

/** Adds calendar days to a `YYYY-MM-DD` date in UTC. */
export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * One flaw's due date: its first-found date (else `fallbackStart`) plus the days for its severity. Null when
 * the severity has no days or there is no start date at all.
 */
export function flawDueDate(flaw: DatedFlaw, days: SlaDays, fallbackStart: string | null): string | null {
  const count = days[flaw.severity];
  if (count === undefined) return null;
  const start = flaw.firstFoundDate ?? fallbackStart;
  return start ? addCalendarDays(start, count) : null;
}

/** The earlier of two dates; a missing one is ignored. */
export function earlierOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

/** A group's due date: the earliest due date of its flaws, each with its own severity; null when none has one. */
export function groupDueDate(group: DatedFlaw[], days: SlaDays, fallbackStart: string | null): string | null {
  return group.reduce<string | null>((earliest, flaw) => earlierOf(earliest, flawDueDate(flaw, days, fallbackStart)), null);
}
