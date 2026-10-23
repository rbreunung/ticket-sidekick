import { describe, it, expect } from 'vitest';
import { toCalendarDate } from '../utils/calendarDate';
import {
  effectiveDueDate, earliestDueDate, diffRemediationDates, hasAnyDate,
  type RemediationDates,
} from '../utils/waltzDates';

const dates = (policyDate: string | null, plannedDate: string | null = null, planDeadline: string | null = null): RemediationDates =>
  ({ policyDate, plannedDate, planDeadline });

describe('toCalendarDate', () => {
  it('keeps a plain calendar date', () => {
    expect(toCalendarDate('2026-12-15')).toBe('2026-12-15');
  });

  it('drops the time from a date-time string', () => {
    expect(toCalendarDate('2026-10-22 14:30')).toBe('2026-10-22');
  });

  it('reads a Date through its UTC parts so no time zone can shift the day', () => {
    expect(toCalendarDate(new Date(Date.UTC(2026, 11, 15, 23, 59)))).toBe('2026-12-15');
  });

  it('reads an ISO timestamp string by its first ten characters', () => {
    expect(toCalendarDate('2026-12-15T00:00:00.000Z')).toBe('2026-12-15');
  });

  it.each(['15.12.2026', '2026-02-30', '2026-13-01', '', '   ', 'Overdue'])('reads %j as no date', (value) => {
    expect(toCalendarDate(value)).toBeNull();
  });

  it('reads null, undefined and an invalid Date as no date', () => {
    expect(toCalendarDate(null)).toBeNull();
    expect(toCalendarDate(undefined)).toBeNull();
    expect(toCalendarDate(new Date('nope'))).toBeNull();
  });
});

describe('effectiveDueDate', () => {
  it('prefers the planned date over the policy date', () => {
    expect(effectiveDueDate(dates('2026-11-30', '2026-12-15'))).toBe('2026-12-15');
  });

  it('falls back to the policy date when there is no planned date', () => {
    expect(effectiveDueDate(dates('2026-11-30'))).toBe('2026-11-30');
  });

  it('does not use the plan deadline as a due date', () => {
    expect(effectiveDueDate(dates(null, null, '2026-09-20'))).toBeNull();
  });

  it('is null without dates', () => {
    expect(effectiveDueDate(dates(null))).toBeNull();
    expect(effectiveDueDate(undefined)).toBeNull();
  });
});

describe('earliestDueDate', () => {
  it('takes the earliest date over members, skipping undated ones', () => {
    expect(earliestDueDate([dates(null, '2026-12-15'), dates('2026-11-30'), dates(null)])).toBe('2026-11-30');
  });

  it('is null when no member has a date', () => {
    expect(earliestDueDate([dates(null), undefined])).toBeNull();
    expect(earliestDueDate([])).toBeNull();
  });
});

describe('diffRemediationDates', () => {
  it('lists only the dates that differ', () => {
    const diff = diffRemediationDates(dates('2026-11-30', '2026-12-15'), dates('2026-11-30', '2027-01-31'));
    expect(diff).toEqual([{ date: 'planned', from: '2026-12-15', to: '2027-01-31' }]);
  });

  it('counts an absent date against a present one as a difference, in both directions', () => {
    expect(diffRemediationDates(dates(null), dates('2026-11-30'))).toEqual([{ date: 'policy', from: null, to: '2026-11-30' }]);
    expect(diffRemediationDates(dates('2026-11-30'), dates(null))).toEqual([{ date: 'policy', from: '2026-11-30', to: null }]);
  });

  it('is empty for equal dates', () => {
    expect(diffRemediationDates(dates('2026-11-30', null, '2026-09-20'), dates('2026-11-30', null, '2026-09-20'))).toEqual([]);
  });

  it('orders the entries policy, planned, deadline', () => {
    const diff = diffRemediationDates(dates(null), dates('2026-01-01', '2026-02-02', '2026-03-03'));
    expect(diff.map(d => d.date)).toEqual(['policy', 'planned', 'deadline']);
  });
});

describe('hasAnyDate', () => {
  it('is true when any of the three dates is set', () => {
    expect(hasAnyDate(dates(null, null, '2026-09-20'))).toBe(true);
    expect(hasAnyDate(dates(null))).toBe(false);
    expect(hasAnyDate(null)).toBe(false);
  });
});
