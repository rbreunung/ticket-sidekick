import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SLA_SEVERITY_NAMES, resolveSlaDays, addCalendarDays, flawDueDate, groupDueDate, earlierOf,
} from '../utils/veracodeDates';
import { SEVERITY_LABELS } from '../utils/veracodeReport';

// The shipped default of `ticketSidekick.veracode.slaDays` (package.json): Very High 14, High 28, the rest 0.
const SHIPPED = { 'Very High': 14, High: 28, Medium: 0, Low: 0, 'Very Low': 0, Informational: 0 };

const flaw = (severity: number, firstFoundDate: string | null = null) => ({ severity, firstFoundDate });

describe('SLA_SEVERITY_NAMES', () => {
  it('lists the severity names in the same order the report parser uses, indexed by severity number', () => {
    expect([...SLA_SEVERITY_NAMES]).toEqual(SEVERITY_LABELS);
  });
});

describe('resolveSlaDays', () => {
  it('reads the shipped default as 14 days for Very High, 28 for High and no date for the rest', () => {
    const { days, unknownKeys, invalidKeys } = resolveSlaDays(SHIPPED);
    expect(days).toEqual({ 5: 14, 4: 28 });
    expect(unknownKeys).toEqual([]);
    expect(invalidKeys).toEqual([]);
  });

  it('matches severity names ignoring case and surrounding spaces', () => {
    const { days, unknownKeys } = resolveSlaDays({ 'very high': 10, ' High ': 20 });
    expect(days).toEqual({ 5: 10, 4: 20 });
    expect(unknownKeys).toEqual([]);
  });

  it('lists a misspelled key as unknown and changes nothing else', () => {
    const { days, unknownKeys } = resolveSlaDays({ 'Very Hgh': 5, High: 28 });
    expect(unknownKeys).toEqual(['Very Hgh']);
    expect(days).toEqual({ 4: 28 });
  });

  it.each([-1, 2.5, '30', null, true])('gives a known severity with %j no due date, lists it, and does not fall back to a default', (value) => {
    const { days, invalidKeys } = resolveSlaDays({ High: value });
    expect(days).toEqual({});
    expect(invalidKeys).toEqual(['High']);
  });

  it('treats 0 as no date without calling it invalid', () => {
    const { days, invalidKeys } = resolveSlaDays({ High: 0 });
    expect(days).toEqual({});
    expect(invalidKeys).toEqual([]);
  });

  it.each([undefined, null, 'High', 42, ['High']])('gives no date for any severity when the setting is %j', (raw) => {
    expect(resolveSlaDays(raw)).toEqual({ days: {}, unknownKeys: [], invalidKeys: [] });
  });
});

describe('addCalendarDays', () => {
  it('adds days within a month', () => {
    expect(addCalendarDays('2026-10-01', 28)).toBe('2026-10-29');
  });

  it('carries over a month end and a year end', () => {
    expect(addCalendarDays('2026-10-23', 60)).toBe('2026-12-22');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('knows leap days', () => {
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('flawDueDate', () => {
  it('is the first-found date plus the days for the severity', () => {
    const { days } = resolveSlaDays({ 'Very High': 30 });
    expect(flawDueDate(flaw(5, '2026-09-01'), days, '2026-10-23')).toBe('2026-10-01');
  });

  it('is already in the past when the flaw is old, and is not clamped', () => {
    const { days } = resolveSlaDays(SHIPPED);
    expect(flawDueDate(flaw(5, '2026-01-01'), days, '2026-10-23')).toBe('2026-01-15');
  });

  it('under the shipped table gives a High flaw first found on 2026-10-01 the due date 2026-10-29', () => {
    const { days } = resolveSlaDays(SHIPPED);
    expect(flawDueDate(flaw(4, '2026-10-01'), days, '2026-10-23')).toBe('2026-10-29');
  });

  it('counts a flaw with no first-found date from the fallback start', () => {
    const { days } = resolveSlaDays({ High: 60 });
    expect(flawDueDate(flaw(4), days, '2026-10-23')).toBe('2026-12-22');
  });

  it('has no due date for a severity at 0 or missing, and none when there is no start at all', () => {
    const { days } = resolveSlaDays({ High: 60, Low: 0 });
    expect(flawDueDate(flaw(2, '2026-09-01'), days, '2026-10-23')).toBeNull();
    expect(flawDueDate(flaw(3, '2026-09-01'), days, '2026-10-23')).toBeNull();
    expect(flawDueDate(flaw(4), days, null)).toBeNull();
  });
});

describe('groupDueDate', () => {
  it('is the earliest due date over the group, each flaw counted with its own severity', () => {
    const { days } = resolveSlaDays({ 'Very High': 14, High: 60, Low: 0 });
    // due 2026-12-01 (High, 2026-10-02 + 60), 2026-11-15 (Very High, 2026-11-01 + 14), none (Low).
    const group = [flaw(4, '2026-10-02'), flaw(5, '2026-11-01'), flaw(2, '2026-09-01')];
    expect(groupDueDate(group, days, '2026-10-23')).toBe('2026-11-15');
  });

  it('is null when no flaw has a due date', () => {
    const { days } = resolveSlaDays({ Low: 0 });
    expect(groupDueDate([flaw(2, '2026-09-01')], days, '2026-10-23')).toBeNull();
    expect(groupDueDate([], days, '2026-10-23')).toBeNull();
  });
});

describe('earlierOf', () => {
  it('returns the earlier of two dates and ignores a missing one', () => {
    expect(earlierOf('2026-12-01', '2026-11-01')).toBe('2026-11-01');
    expect(earlierOf('2026-11-01', '2026-12-01')).toBe('2026-11-01');
    expect(earlierOf(null, '2026-11-01')).toBe('2026-11-01');
    expect(earlierOf('2026-11-01', null)).toBe('2026-11-01');
    expect(earlierOf(null, null)).toBeNull();
  });
});

describe('the ticketSidekick.veracode.slaDays setting in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
  const setting = (pkg.contributes.configuration as Array<{ properties?: Record<string, any> }>)
    .flatMap(group => Object.entries(group.properties ?? {}))
    .find(([key]) => key === 'ticketSidekick.veracode.slaDays')![1];

  it('ships Very High 14, High 28 and 0 for the other severities, with no ignored entries', () => {
    expect(setting.default).toEqual(SHIPPED);
    expect(resolveSlaDays(setting.default)).toEqual({ days: { 5: 14, 4: 28 }, unknownKeys: [], invalidKeys: [] });
  });

  it('declares exactly the six severity names as whole-number properties and allows nothing else', () => {
    expect(Object.keys(setting.properties).sort()).toEqual([...SLA_SEVERITY_NAMES].sort());
    for (const property of Object.values<any>(setting.properties)) {
      expect(property).toMatchObject({ type: 'integer', minimum: 0 });
    }
    expect(setting.additionalProperties).toBe(false);
  });
});
