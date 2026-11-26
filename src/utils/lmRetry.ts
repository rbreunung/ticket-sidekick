/**
 * Retry helpers for VS Code Language Model API calls (`model.sendRequest`).
 * Mirrors the resilience pattern already used for HTTP calls in
 * `fetchWithRetry.ts`, but classifies failures by shape instead of HTTP
 * status, since `vscode.LanguageModelError` carries a `.code` string rather
 * than a numeric status.
 *
 * Every call gets exactly 3 tries, never more — see `withLmRetry` (plain,
 * for calls with nothing to shrink) and `withEasierRetry` (for a batch of
 * items, where the 3rd try is a split-in-half attempt instead of a 3rd
 * identical one).
 */

export interface LmRetryOptions {
  /** Number of retries after the first attempt. Default 2 (3 tries total). */
  retries?: number;
  /** Base backoff in ms; doubled each attempt. Default 500. */
  baseDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per failed attempt, before deciding whether to retry — the
   * hook for diagnostic logging (see diagLog.ts). Fires even on the final,
   * non-retried attempt. */
  onAttemptFailed?: (attempt: number, err: unknown) => void;
}

/**
 * Thrown by `callLLMOnce` (BitbucketParticipant.ts) instead of a bare stream
 * error when the response stream produced some text before failing — so a
 * clarifying question or partial explanation the model had already started
 * isn't silently lost when the stream breaks mid-reply.
 */
export class PartialLmResponseError extends Error {
  readonly partialText: string;
  override readonly cause: unknown;

  constructor(partialText: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PartialLmResponseError';
    this.partialText = partialText;
    this.cause = cause;
  }
}

/**
 * Thrown from inside a retried review call when the model's reply contains nothing review-shaped
 * (empty, or prose with no usable JSON). Parsing runs inside the retry wrapper, so this is retried
 * and split like a provider error instead of aborting the whole review (KTD3).
 */
export class UnparseableReplyError extends Error {
  readonly code = 'Unparseable';
  readonly rawReply: string;

  constructor(rawReply: string) {
    super(rawReply.trim() ? 'model reply contained no usable JSON' : 'model returned an empty reply');
    this.name = 'UnparseableReplyError';
    this.rawReply = rawReply;
  }
}

const NON_RETRYABLE_CODES = new Set(['NoPermissions', 'Blocked', 'NotFound']);

/**
 * True for failures worth retrying: a `PartialLmResponseError` (a broken
 * stream, possibly recoverable on a fresh attempt); a message containing
 * "no choices" (the known empty-completion shape from the VS Code LM API,
 * see `docs/bitbucket-follow-up-improvements.md`); or a
 * `vscode.LanguageModelError`-shaped error (has a string `.code`) whose code
 * is the generic `"Unknown"` bucket (opaque provider-side failure). Errors
 * coded `NoPermissions` / `Blocked` / `NotFound` are consent/quota/model-missing
 * conditions a retry cannot fix, and are never retried.
 */
export function isTransientLmError(err: unknown): boolean {
  if (err instanceof PartialLmResponseError) return true;
  if (err instanceof UnparseableReplyError) return true;
  if (!(err instanceof Error)) return false;
  if (err.message.toLowerCase().includes('no choices')) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (NON_RETRYABLE_CODES.has(code)) return false;
    return code === 'Unknown';
  }
  return false;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` on a transient LM error with exponential backoff, up to
 * `opts.retries` extra attempts (default 2, i.e. 3 tries total). Rethrows
 * immediately on a non-transient error, or once the budget is exhausted —
 * the rethrown error is whatever `fn`'s last attempt threw, so a
 * `PartialLmResponseError`'s `partialText` survives.
 */
export async function withLmRetry<T>(
  fn: () => Promise<T>,
  opts: LmRetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      opts.onAttemptFailed?.(attempt + 1, err);
      if (attempt >= retries || !isTransientLmError(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

export interface SplitBatch<TItem, TResult> {
  items: TItem[];
  result?: TResult;
  error?: unknown;
}

export interface EasierRetryOptions<TItem> {
  /** Only applies to the items.length<=1 fallback path. Default 2. */
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called for every failed attempt, with the exact items that attempt
   * covered — attempts 1–2 report the full batch, attempt 3 (if reached)
   * reports whichever half it was. */
  onAttemptFailed?: (attempt: number, err: unknown, items: TItem[]) => void;
}

/**
 * Exactly 3 tries for a batch of items sent to the LLM together: the
 * original request, one identical retry, and — only if the batch can still
 * be split — a third try that's genuinely easier for the model: split once
 * and give each half a single additional attempt (no further retry or
 * splitting), rather than resending the same full-size request a third
 * time. A batch already down to one item can't be made any smaller, so it
 * just gets the full identical-retry budget instead. A non-transient error
 * (permissions, quota, cancellation) is rethrown immediately — splitting
 * can't fix those.
 */
export async function withEasierRetry<TItem, TResult>(
  items: TItem[],
  call: (items: TItem[]) => Promise<TResult>,
  split: (items: TItem[]) => [TItem[], TItem[]],
  opts: EasierRetryOptions<TItem> = {},
): Promise<Array<SplitBatch<TItem, TResult>>> {
  const forwardedOpts = (targetItems: TItem[]): LmRetryOptions => ({
    retries: opts.retries,
    baseDelayMs: opts.baseDelayMs,
    sleep: opts.sleep,
    onAttemptFailed: opts.onAttemptFailed
      ? (attempt, err) => opts.onAttemptFailed!(attempt, err, targetItems)
      : undefined,
  });

  if (items.length <= 1) {
    try {
      const result = await withLmRetry(() => call(items), forwardedOpts(items));
      return [{ items, result }];
    } catch (err) {
      return [{ items, error: err }];
    }
  }

  try {
    const result = await withLmRetry(() => call(items), { ...forwardedOpts(items), retries: 1 });
    return [{ items, result }];
  } catch (err) {
    if (!isTransientLmError(err)) throw err;
    const [left, right] = split(items);
    const leftBatch = await tryOnceEasier(left, call, opts.onAttemptFailed);
    const rightBatch = await tryOnceEasier(right, call, opts.onAttemptFailed);
    return [leftBatch, rightBatch];
  }
}

async function tryOnceEasier<TItem, TResult>(
  items: TItem[],
  call: (items: TItem[]) => Promise<TResult>,
  onAttemptFailed: ((attempt: number, err: unknown, items: TItem[]) => void) | undefined,
): Promise<SplitBatch<TItem, TResult>> {
  try {
    const result = await call(items);
    return { items, result };
  } catch (err) {
    onAttemptFailed?.(3, err, items);
    return { items, error: err };
  }
}

/**
 * The three refusals Copilot sends instead of an answer. Rate-limited passes after a wait; blocked
 * and quota used up refuse every call for minutes, so nothing more should be sent.
 */
export type RefusalKind = 'rate-limited' | 'blocked' | 'quota';

export interface Refusal {
  kind: RefusalKind;
  /** How long the refusal asked to wait before trying again, when it said. */
  retryAfterMs?: number;
}

const RATE_LIMITED_NAME = 'ChatRateLimited';
const QUOTA_NAME = 'ChatQuotaExceeded';

/**
 * Classifies a refusal: by the `LanguageModelError` code first (`Blocked`), then by the error name
 * (`ChatRateLimited`, `ChatQuotaExceeded`), then by the message. Undefined for any other failure.
 */
export function refusalOf(err: unknown): Refusal | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  const marks = [typeof code === 'string' ? code : undefined, err.name];
  if (marks[0] === 'Blocked') return { kind: 'blocked' };
  if (marks.includes(QUOTA_NAME)) return { kind: 'quota' };
  const hint = retryHintOf(err.message);
  const rateLimited = (): Refusal => ({ kind: 'rate-limited', ...(hint !== undefined ? { retryAfterMs: hint } : {}) });
  if (marks.includes(RATE_LIMITED_NAME)) return rateLimited();
  if (/\bquota\b/i.test(err.message)) return { kind: 'quota' };
  if (/rate[- ]?limit|too many requests|\b429\b/i.test(err.message)) return rateLimited();
  return undefined;
}

const UNIT_MS: Array<[RegExp, number]> = [[/^m(?:s|illiseconds?)$/i, 1], [/^s(?:ecs?|econds?)?$/i, 1000], [/^m(?:ins?|inutes?)?$/i, 60_000]];

/** The wait a refusal message asks for, e.g. "Please wait 45 seconds" or "retry after 2 minutes". */
function retryHintOf(message: string): number | undefined {
  const m = /(?:retry|wait|try again)\D{0,30}?(\d+(?:\.\d+)?)\s*([a-z]+)/i.exec(message);
  if (!m) return undefined;
  const unit = UNIT_MS.find(([pattern]) => pattern.test(m[2]));
  return unit ? Math.round(Number(m[1]) * unit[1]) : undefined;
}
