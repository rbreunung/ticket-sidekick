import { describe, it, expect, vi } from 'vitest';
import { isTransientLmError, withLmRetry, withEasierRetry, PartialLmResponseError } from '../utils/lmRetry';

const noopSleep = async () => {};

function lmError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code) (err as unknown as { code: string }).code = code;
  return err;
}

describe('isTransientLmError', () => {
  it('is true for a "no choices" message', () => {
    expect(isTransientLmError(new Error('Response contained no choices.'))).toBe(true);
  });

  it('is true for a PartialLmResponseError', () => {
    expect(isTransientLmError(new PartialLmResponseError('partial', new Error('boom')))).toBe(true);
  });

  it('is true for an "Unknown"-coded LanguageModelError', () => {
    expect(isTransientLmError(lmError('opaque provider failure', 'Unknown'))).toBe(true);
  });

  it('is false for NoPermissions/Blocked/NotFound-coded errors', () => {
    expect(isTransientLmError(lmError('no permission', 'NoPermissions'))).toBe(false);
    expect(isTransientLmError(lmError('blocked', 'Blocked'))).toBe(false);
    expect(isTransientLmError(lmError('not found', 'NotFound'))).toBe(false);
  });

  it('is false for an unrelated error', () => {
    expect(isTransientLmError(new Error('network unreachable'))).toBe(false);
  });
});

describe('withLmRetry', () => {
  it('returns immediately on success (no retry)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const r = await withLmRetry(fn, { sleep: noopSleep });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockResolvedValueOnce('ok');
    const r = await withLmRetry(fn, { sleep: noopSleep });
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient error', async () => {
    const fn = vi.fn().mockRejectedValue(lmError('no permission', 'NoPermissions'));
    await expect(withLmRetry(fn, { sleep: noopSleep })).rejects.toThrow('no permission');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 total tries (default: 2 retries) and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(lmError('Response contained no choices.'));
    await expect(withLmRetry(fn, { sleep: noopSleep })).rejects.toThrow('no choices');
    expect(fn).toHaveBeenCalledTimes(3); // try 1 + 2 retries, the plain-call default
  });

  it('preserves partialText on the rethrown error after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new PartialLmResponseError('half an answer', new Error('stream broke')));
    await expect(withLmRetry(fn, { retries: 1, sleep: noopSleep })).rejects.toMatchObject({ partialText: 'half an answer' });
  });

  it('calls onAttemptFailed for every failed attempt, including the first', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockResolvedValueOnce('ok');
    const onAttemptFailed = vi.fn();
    await withLmRetry(fn, { sleep: noopSleep, onAttemptFailed });
    expect(onAttemptFailed).toHaveBeenCalledTimes(1);
    expect(onAttemptFailed).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('uses exponential backoff between retries', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn(async () => {});
    await withLmRetry(fn, { sleep, baseDelayMs: 100 });
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });
});

describe('withEasierRetry', () => {
  const halve = (items: number[]): [number[], number[]] => {
    const mid = Math.ceil(items.length / 2);
    return [items.slice(0, mid), items.slice(mid)];
  };

  it('returns a single successful batch on the first try', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    const result = await withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep });
    expect(result).toEqual([{ items: [1, 2, 3, 4], result: 'ok' }]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the identical retry (try 2) without splitting', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockResolvedValueOnce('ok');
    const result = await withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep });
    expect(result).toEqual([{ items: [1, 2, 3, 4], result: 'ok' }]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('falls back to a single easier (split) try after the identical retry also fails', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.')) // try 1
      .mockRejectedValueOnce(lmError('Response contained no choices.')) // try 2 (retry)
      .mockResolvedValueOnce('left-ok') // try 3, left half
      .mockResolvedValueOnce('right-ok'); // try 3, right half
    const result = await withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep });
    expect(result).toEqual([
      { items: [1, 2], result: 'left-ok' },
      { items: [3, 4], result: 'right-ok' },
    ]);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('never makes more than 4 calls total, even if the split halves also fail', async () => {
    const call = vi.fn().mockRejectedValue(lmError('Response contained no choices.'));
    const result = await withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep });
    expect(call).toHaveBeenCalledTimes(4); // try 1, try 2, split-left (1 try), split-right (1 try)
    expect(result.every((b) => b.error !== undefined)).toBe(true);
    expect(result.map((b) => b.items)).toEqual([[1, 2], [3, 4]]);
  });

  it('gives a single item the full identical-retry budget instead of splitting', async () => {
    const call = vi.fn().mockRejectedValue(lmError('Response contained no choices.'));
    const result = await withEasierRetry([1], call, halve, { sleep: noopSleep });
    expect(call).toHaveBeenCalledTimes(3); // default withLmRetry: 3 identical tries
    expect(result).toEqual([{ items: [1], error: expect.any(Error) }]);
  });

  it('does not split on a non-transient error — rethrows immediately', async () => {
    const call = vi.fn().mockRejectedValue(lmError('no permission', 'NoPermissions'));
    await expect(withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep })).rejects.toThrow('no permission');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves partialText on a failed split half', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockRejectedValueOnce(lmError('Response contained no choices.'))
      .mockRejectedValueOnce(new PartialLmResponseError('cut off here', new Error('stream broke')))
      .mockResolvedValueOnce('right-ok');
    const result = await withEasierRetry([1, 2, 3, 4], call, halve, { sleep: noopSleep });
    const failed = result.find((b) => b.error !== undefined);
    expect((failed!.error as PartialLmResponseError).partialText).toBe('cut off here');
  });

  it('reports attempt 3 with the specific half that failed, for every failed attempt', async () => {
    const call = vi.fn().mockRejectedValue(lmError('Response contained no choices.'));
    const onAttemptFailed = vi.fn();
    await withEasierRetry([1, 2], call, halve, { sleep: noopSleep, onAttemptFailed });
    expect(onAttemptFailed.mock.calls.map(([attempt, , items]) => [attempt, items])).toEqual([
      [1, [1, 2]],
      [2, [1, 2]],
      [3, [1]],
      [3, [2]],
    ]);
  });
});
