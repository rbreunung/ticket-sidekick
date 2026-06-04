export interface RetryOptions {
  /** Number of retries after the first attempt. Default 3. */
  retries?: number;
  /** Base backoff in ms; doubled each attempt unless Retry-After overrides. Default 300. */
  baseDelayMs?: number;
  /** HTTP statuses that trigger a retry. Default [429, 503]. */
  retryStatuses?: number[];
  /** Injectable sleep (tests pass a no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * `fetch` wrapper that retries transient failures (429/503) with exponential backoff,
 * honoring a numeric `Retry-After` header when present.
 *
 * Only idempotent methods (GET/HEAD/PUT/DELETE/OPTIONS) are retried — POST/PATCH are sent
 * once so a transient error can never cause a duplicate side effect (e.g. a double comment
 * or a repeated transition). On exhaustion the last response is returned so the caller's
 * existing status-based error handling stays intact.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const retryStatuses = opts.retryStatuses ?? [429, 503];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const method = (init?.method ?? 'GET').toUpperCase();
  const idempotent = IDEMPOTENT.has(method);

  let response = await fetch(url, init);
  for (let attempt = 0; idempotent && retryStatuses.includes(response.status) && attempt < retries; attempt++) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * 2 ** attempt;
    await sleep(delay);
    response = await fetch(url, init);
  }
  return response;
}
