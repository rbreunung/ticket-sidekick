// Jira's `updated` time of a ticket, compared as a moment. Jira writes it with a UTC offset, with or
// without a colon (`+0100` or `+01:00`), and two reads of the same ticket (a search and a single
// ticket) do not have to spell it the same way. Pure: no `vscode` import.

const UPDATED_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** The time as milliseconds since the epoch, or undefined when the text is not an update time. */
export function updatedInstant(text: string): number | undefined {
  const match = UPDATED_TIME.exec(text);
  if (!match) return undefined;
  const [, date, time, fraction = '', zone] = match;
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  let offset = zone;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2).padEnd(2, '0')}`;
  }
  const instant = Date.parse(`${date}T${time}.${millis}${offset}`);
  return Number.isNaN(instant) ? undefined : instant;
}

/**
 * Whether two update times are the same moment. Text that is not an update time matches only
 * identical text, so an odd value is never treated more loosely than a plain comparison would.
 */
export function sameUpdatedTime(a: string, b: string): boolean {
  if (a === b) return true;
  const first = updatedInstant(a);
  const second = updatedInstant(b);
  return first !== undefined && second !== undefined && first === second;
}
