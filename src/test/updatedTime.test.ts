import { describe, it, expect } from 'vitest';
import { sameUpdatedTime, updatedInstant } from '../utils/updatedTime';

// Jira writes a ticket's `updated` time with a UTC offset, with or without a colon, and the search
// and the single-ticket read do not have to spell it the same way. The board asks whether two
// readings are the same moment, not whether the text is equal.

describe('comparing the update time of a ticket', () => {
  it('treats the two spellings of one offset as the same moment', () => {
    expect(sameUpdatedTime('2026-05-01T10:00:00.000+0100', '2026-05-01T10:00:00.000+01:00')).toBe(true);
  });

  it('treats the same moment in another offset as the same moment', () => {
    expect(sameUpdatedTime('2026-05-01T10:00:00.000+0200', '2026-05-01T08:00:00.000Z')).toBe(true);
  });

  it('keeps a different wall time in another offset apart', () => {
    expect(sameUpdatedTime('2026-05-01T10:00:00.000+0100', '2026-05-01T10:00:00.000+0200')).toBe(false);
  });

  it('tells moments a millisecond apart from each other', () => {
    expect(sameUpdatedTime('2026-05-01T10:00:00.000+0100', '2026-05-01T10:00:00.001+0100')).toBe(false);
  });

  it('reads a time without fractional seconds', () => {
    expect(sameUpdatedTime('2026-05-01T10:00:00+0100', '2026-05-01T10:00:00.000+01:00')).toBe(true);
  });

  it('reads an offset given in hours only', () => {
    expect(updatedInstant('2026-05-01T10:00:00.000+01')).toBe(Date.UTC(2026, 4, 1, 9, 0, 0, 0));
  });

  it('gives the moment in milliseconds since the epoch', () => {
    expect(updatedInstant('2026-05-01T10:00:00.250+0200')).toBe(Date.UTC(2026, 4, 1, 8, 0, 0, 250));
  });

  it('does not read text that is not a time, and keeps the exact text as the only match for it', () => {
    expect(updatedInstant('t1')).toBeUndefined();
    expect(updatedInstant('2026-13-45T10:00:00.000+0100')).toBeUndefined();
    expect(sameUpdatedTime('t1', 't1')).toBe(true);
    expect(sameUpdatedTime('t1', 't2')).toBe(false);
    expect(sameUpdatedTime('t1', '2026-05-01T10:00:00.000+0100')).toBe(false);
  });

  it('matches an empty time only with an empty time', () => {
    expect(sameUpdatedTime('', '')).toBe(true);
    expect(sameUpdatedTime('', '2026-05-01T10:00:00.000+0100')).toBe(false);
  });
});
