import { describe, it, expect, vi, afterEach } from 'vitest';
import { RecentCallGuard, fingerprint } from '../tools/recentCallGuard';

describe('fingerprint', () => {
  it('does not collide across a part boundary the way a plain join would', () => {
    expect(fingerprint('a', 'bc')).not.toBe(fingerprint('ab', 'c'));
  });

  it('produces the same fingerprint for the same inputs', () => {
    expect(fingerprint('PROJ-123', 'looks good')).toBe(fingerprint('PROJ-123', 'looks good'));
  });
});

describe('RecentCallGuard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a fingerprint on first use', () => {
    const guard = new RecentCallGuard();
    expect(guard.claim('key-1')).toBe(true);
  });

  it('rejects a second claim of the same fingerprint within the window', () => {
    const guard = new RecentCallGuard();
    guard.claim('key-1');
    expect(guard.claim('key-1')).toBe(false);
  });

  it('allows two different fingerprints independently', () => {
    const guard = new RecentCallGuard();
    expect(guard.claim('key-1')).toBe(true);
    expect(guard.claim('key-2')).toBe(true);
  });

  it('allows a re-claim after release (a failed write is not a duplicate)', () => {
    const guard = new RecentCallGuard();
    guard.claim('key-1');
    guard.release('key-1');
    expect(guard.claim('key-1')).toBe(true);
  });

  it('allows a re-claim once the window has passed', () => {
    vi.useFakeTimers();
    const guard = new RecentCallGuard(1000);
    guard.claim('key-1');
    vi.advanceTimersByTime(1001);
    expect(guard.claim('key-1')).toBe(true);
  });

  it('still rejects a re-claim just before the window elapses', () => {
    vi.useFakeTimers();
    const guard = new RecentCallGuard(1000);
    guard.claim('key-1');
    vi.advanceTimersByTime(999);
    expect(guard.claim('key-1')).toBe(false);
  });
});
