// Pure, vscode-free calendar-date reading shared by the Veracode and Waltz importers: dates travel as
// `YYYY-MM-DD` strings so no time zone can shift a day.

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
