import { describe, it, expect, vi } from 'vitest';
import {
  createAttemptTracker, errorCodeOf, handleAttemptFailure, describeErrorForLog,
  formatBatchFailureNotice, formatReviewFailedMessage, PARTIAL_REVIEW_WARNING,
} from '../participant/bitbucket/reviewDiagnostics';
import { sanitizeDetails } from '../utils/logRedaction';

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

  it('logs no retry or split for a non-transient error, only the not-retried decision naming its class', () => {
    const p = baseParams({ err: Object.assign(new Error('nope'), { code: 'NoPermissions' }) });
    p.tracker.start(p.items);
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledTimes(2);
    expect(p.logReview).toHaveBeenCalledWith('error', expect.any(String));
    expect(p.logReview).toHaveBeenCalledWith('warn', expect.stringContaining('not retrying'));
  });

  it('explains why a plain TypeError ended after one attempt', () => {
    const p = baseParams({ err: new TypeError('proxy invariant') });
    p.tracker.start(p.items);
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledWith('warn', expect.stringContaining('TypeError'));
    expect(p.logReview).not.toHaveBeenCalledWith('info', expect.stringContaining('retry'));
  });

  it('logs the not-retried decision for a split half too, since a non-transient error ends it there', () => {
    const half = ['a'];
    const p = baseParams({ err: new TypeError('x'), items: half });
    p.tracker.start(half);
    handleAttemptFailure(p);
    expect(p.logReview).toHaveBeenCalledWith('warn', expect.stringContaining('not retrying'));
  });
});

describe('describeErrorForLog', () => {
  it('names a plain TypeError and keeps at most three stack frames without directories', () => {
    const err = new TypeError('boom');
    err.stack = [
      'TypeError: boom',
      '    at createTokenMeter (/home/me/.vscode/extensions/x/out/tokenMeter.js:130:5)',
      '    at async callLLMOnce (/home/me/.vscode/extensions/x/out/BitbucketParticipant.js:128:20)',
      '    at /home/me/.vscode/extensions/x/out/lmRetry.js:104:18',
      '    at never.js:1:1',
    ].join('\n');
    const info = describeErrorForLog(err);
    expect(info.errorName).toBe('TypeError');
    expect(info.stackHead).toEqual([
      'createTokenMeter (tokenMeter.js:130:5)',
      'async callLLMOnce (BitbucketParticipant.js:128:20)',
      'lmRetry.js:104:18',
    ]);
    expect(JSON.stringify(info)).not.toContain('/home/me');
  });

  it('keeps the provider code and skips the stack for a LanguageModelError-shaped error', () => {
    const err = Object.assign(new Error('hiccup'), { name: 'LanguageModelError', code: 'Unknown' });
    expect(describeErrorForLog(err)).toEqual({ errorName: 'LanguageModelError', code: 'Unknown' });
  });

  it('copes with a thrown string', () => {
    expect(describeErrorForLog('just text')).toEqual({ errorName: 'string' });
  });

  it('produces keys that survive log redaction', () => {
    const details = { ...describeErrorForLog(new TypeError('x')), metering: 'on', frozen: true };
    expect(JSON.stringify(sanitizeDetails(details))).not.toContain('REDACTED');
  });
});

describe('failure wording', () => {
  const transient = Object.assign(new Error('hiccup'), { code: 'Unknown' });

  it('says "after retrying" only for an error class the retry layer retries', () => {
    expect(formatBatchFailureNotice({ label: 'Batch 1', filePaths: 'a.ts', cause: 'hiccup', err: transient })).toContain('after retrying');
    expect(formatBatchFailureNotice({ label: 'Batch 1', filePaths: 'a.ts', cause: 'proxy invariant', err: new TypeError('x') })).not.toContain('after retrying');
  });

  it('names the label, the files and the cause in the batch notice', () => {
    const text = formatBatchFailureNotice({ label: 'Security pass — batch 2', filePaths: 'a.ts, b.ts', cause: 'boom', err: new TypeError('x') });
    expect(text).toContain('Security pass — batch 2');
    expect(text).toContain('a.ts, b.ts');
    expect(text).toContain('boom');
  });

  it('keeps the partial-results warning free of retry claims', () => {
    expect(PARTIAL_REVIEW_WARNING).toContain('partial results');
    expect(PARTIAL_REVIEW_WARNING).not.toContain('after retrying');
  });

  it('states that nothing was reviewed, with the count, the cause and the output channel, and never "No issues found"', () => {
    const text = formatReviewFailedMessage({ fileCount: 1, cause: 'proxy invariant' });
    expect(text).toContain('Review failed');
    expect(text).toContain('1 file');
    expect(text).toContain('proxy invariant');
    expect(text).toContain('Ticket Sidekick');
    expect(text).not.toContain('No issues found');
  });
});
