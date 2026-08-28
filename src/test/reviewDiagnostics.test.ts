import { describe, it, expect, vi } from 'vitest';
import { createAttemptTracker, errorCodeOf, handleAttemptFailure } from '../participant/bitbucket/reviewDiagnostics';

describe('errorCodeOf', () => {
  it('returns the string code from a vscode.LanguageModelError-shaped error', () => {
    expect(errorCodeOf({ code: 'Unknown' })).toBe('Unknown');
  });

  it('returns undefined when there is no code, or code is not a string', () => {
    expect(errorCodeOf(new Error('plain'))).toBeUndefined();
    expect(errorCodeOf({ code: 42 })).toBeUndefined();
  });
});

describe('handleAttemptFailure', () => {
  const baseParams = (overrides: Partial<Parameters<typeof handleAttemptFailure<string>>[0]> = {}) => {
    const items = ['a', 'b']; // same reference used for both items and originalItems below —
    return {                 // the still-unsplit batch, by construction (see identity gate)
      runTag: 'pr=PROJ/repo#1',
      pass: 'pass1' as const,
      batch: 1,
      totalBatches: 1,
      libraryAttempt: 1,
      err: Object.assign(new Error('boom'), { code: 'Unknown' }),
      items,
      originalItems: items,
      tracker: createAttemptTracker<string>(),
      promptChars: 100,
      split: (arr: string[]): [string[], string[]] => [arr.slice(0, 1), arr.slice(1)],
      logFailure: vi.fn(),
      logReview: vi.fn(),
      ...overrides,
    };
  };

  it('logs the failure and the per-call error line for every failed attempt', () => {
    const p = baseParams();
    p.tracker.start(p.items);
    handleAttemptFailure(p);
    expect(p.logFailure).toHaveBeenCalledWith(1, p.err);
    expect(p.logReview).toHaveBeenCalledWith('error', expect.stringContaining('error'));
  });

  it('logs a retry-in-flight decision after the first attempt on the still-unsplit batch fails', () => {
    const p = baseParams();
    p.tracker.start(p.items); // attempt 1
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledWith('info', expect.stringContaining('retry'));
  });

  it('logs a split decision after the second attempt on the still-unsplit batch fails', () => {
    const p = baseParams();
    p.tracker.start(p.items); // attempt 1
    p.tracker.start(p.items); // attempt 2
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledWith('info', expect.stringContaining('splitting'));
  });

  it('does NOT log a retry decision for a split half\'s terminal (non-retried) failure', () => {
    const p = baseParams();
    const half = ['a']; // a distinct array reference from originalItems, as halveFiles/halveFindings would produce
    p.items = half;
    p.tracker.start(half); // attempt 1 for this subset (its only attempt)
    handleAttemptFailure(p);
    // Only the error call-line should have been logged, never a recovery decision.
    expect(p.logReview).toHaveBeenCalledTimes(1);
    expect(p.logReview).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('logs a retry decision (not a missing one) for a single-item chunk\'s 2nd identical-retry attempt', () => {
    const p = baseParams();
    p.items = ['solo'];
    p.originalItems = p.items;
    p.tracker.start(p.items); // attempt 1
    p.tracker.start(p.items); // attempt 2
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledWith('info', expect.stringContaining('retry'));
  });

  it('logs no recovery decision for a single-item chunk\'s 3rd (final) attempt', () => {
    const p = baseParams();
    p.items = ['solo'];
    p.originalItems = p.items;
    p.tracker.start(p.items); // attempt 1
    p.tracker.start(p.items); // attempt 2
    p.tracker.start(p.items); // attempt 3
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledTimes(1);
    expect(p.logReview).toHaveBeenCalledWith('error', expect.any(String));
  });

  it('logs no recovery decision for a non-transient error, even on the unsplit batch\'s first attempt', () => {
    const p = baseParams({ err: Object.assign(new Error('nope'), { code: 'NoPermissions' }) });
    p.tracker.start(p.items);
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledTimes(1);
    expect(p.logReview).toHaveBeenCalledWith('error', expect.any(String));
  });
});
