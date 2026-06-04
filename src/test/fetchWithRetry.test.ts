import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../utils/fetchWithRetry';

const noopSleep = async () => {};

function resp(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('fetchWithRetry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns immediately on a 200 (no retry)', async () => {
    const f = vi.fn().mockResolvedValue(resp(200));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', undefined, { sleep: noopSleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(resp(429))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', undefined, { sleep: noopSleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', undefined, { sleep: noopSleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404', async () => {
    const f = vi.fn().mockResolvedValue(resp(404));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', undefined, { sleep: noopSleep });
    expect(r.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and returns the last response', async () => {
    const f = vi.fn().mockResolvedValue(resp(429));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', undefined, { retries: 2, sleep: noopSleep });
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does NOT retry a non-idempotent POST even on 429 (avoid double side effects)', async () => {
    const f = vi.fn().mockResolvedValue(resp(429));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', { method: 'POST' }, { sleep: noopSleep });
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent PUT on 503', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(resp(503))
      .mockResolvedValueOnce(resp(204));
    vi.stubGlobal('fetch', f);
    const r = await fetchWithRetry('http://x', { method: 'PUT' }, { sleep: noopSleep });
    expect(r.status).toBe(204);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('honors a numeric Retry-After header for the backoff delay', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(resp(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(resp(200));
    vi.stubGlobal('fetch', f);
    const sleep = vi.fn(async () => {});
    await fetchWithRetry('http://x', undefined, { sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});
