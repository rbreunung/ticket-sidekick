# Bitbucket Deep-Review Resilience & Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@bitbucket review deep <url>` (and the rest of the Bitbucket LLM
pipeline) resilient to transient VS Code Language Model API failures — instead
of one failed call discarding an entire review — and add a shared diagnostic
channel so a genuinely persistent failure can be told apart from bad luck.

**Architecture:** A new pure, unit-tested retry module (`src/utils/lmRetry.ts`)
gives every LLM call **exactly three tries**: the original request, one
identical retry, and — only for the two calls that dominate `deep` mode's
extra load (the main review call and the critic/verification call) — a third
try that's genuinely *easier* for the model: the batch of files/findings is
split in half once and each half gets one final attempt, rather than
resending the identical, full-size request a third time. This bounds every
chunk to at most 4 real LLM calls total (2 identical + 2 halves), never an
open-ended retry storm. A new shared Output Channel module
(`src/utils/diagLog.ts`) logs every one of those attempts as it happens, plus
the model identity in use, so a genuinely persistent failure is diagnosable
instead of opaque. `BitbucketParticipant.ts`'s per-chunk review loop is
restructured so a chunk/finding that still fails after its three tries is
skipped (with a note) rather than aborting the whole review.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.LanguageModelChat`,
`vscode.OutputChannel`), Vitest.

## Global Constraints

- `npm test` must be green before every commit; run `npm run compile` first to
  catch TypeScript errors (`CLAUDE.md` → "Running tests").
- `src/participant/BitbucketParticipant.ts` imports `vscode` and cannot be
  loaded by Vitest — keep all new pure logic in `src/utils/lmRetry.ts` (no
  `vscode` import there) so it stays unit-testable; the wiring inside
  `BitbucketParticipant.ts` is verified by `npm run compile` plus manual
  exercise in the Extension Development Host, per the project's existing
  convention for vscode-glue code.
- Mirror the existing `src/utils/fetchWithRetry.ts` / `src/test/fetchWithRetry.test.ts`
  pattern for the new retry module: injectable `sleep`, exponential backoff,
  small focused functions.
- **Every LLM call gets exactly 3 tries, never more.** For calls that can't be
  split (a single already-small prompt, or a batch already down to one item),
  that's 3 identical attempts. For a splittable batch of more than one item,
  it's 2 identical attempts + 1 split-in-half final attempt (2 calls) — never
  recursive re-splitting.
- `docs/review-process.md` states "**Keep this document in sync whenever the
  review pipeline changes**" — update it, `CLAUDE.md`, and `README.md` as part
  of this plan, not as an afterthought.
- Do not change `PrReviewService.buildPrompt` / `buildCriticPrompt` signatures
  — both already accept `additionalInstructions`; nothing here needs new
  parameters there.

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/utils/lmRetry.ts` | `isTransientLmError`, `PartialLmResponseError`, `withLmRetry` (plain 3-try retry), `withEasierRetry` (3-try retry with a split-and-simplify final attempt for batches) — pure, no `vscode` import |
| Create | `src/test/lmRetry.test.ts` | Unit tests for all of the above |
| Create | `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` Output Channel singleton + `logDiag()`, usable by both `@jira` and `@bitbucket` |
| Modify | `src/participant/BitbucketParticipant.ts` | Adds `callLLMOnce`/`callLLMOnceWithProgress` (single-attempt primitives) alongside retry-wrapped `callLLM`/`callLLMWithProgress`; per-chunk loop restructured to use `withEasierRetry` for the main review call and the critic call; every failed attempt logged; friendlier top-level/follow-up/comment-refinement error messages |
| Modify | `docs/review-process.md` | New "Resilience & debugging" section; "Modes" note on deep mode's extra call volume |
| Modify | `CLAUDE.md` | New `## Diagnostics` section; `src/utils/diagLog.ts` and `src/utils/lmRetry.ts` rows in the key-files table |
| Modify | `README.md` | New `## Troubleshooting` section (after `@bitbucket`, before `## Releasing`) |

---

## Task 1: Plain 3-try retry — `isTransientLmError`, `PartialLmResponseError`, `withLmRetry`

**Files:**
- Create: `src/utils/lmRetry.ts`
- Test: `src/test/lmRetry.test.ts`

**Interfaces:**
- Produces: `isTransientLmError(err: unknown): boolean`; `class PartialLmResponseError extends Error { readonly partialText: string; override readonly cause: unknown }`; `interface LmRetryOptions { retries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void>; onAttemptFailed?: (attempt: number, err: unknown) => void }`; `withLmRetry<T>(fn: () => Promise<T>, opts?: LmRetryOptions): Promise<T>`.

- [x] **Step 1: Write the failing tests**

Create `src/test/lmRetry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { isTransientLmError, withLmRetry, PartialLmResponseError } from '../utils/lmRetry';

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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `~/.volta/bin/npm test -- lmRetry` (or `npm test -- lmRetry` if `npm` is
already on PATH)
Expected: FAIL — `Cannot find module '../utils/lmRetry'`

- [x] **Step 3: Write the implementation**

Create `src/utils/lmRetry.ts`:

```typescript
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `~/.volta/bin/npm test -- lmRetry`
Expected: PASS (all `isTransientLmError` and `withLmRetry` tests)

- [x] **Step 5: Commit**

```bash
git add src/utils/lmRetry.ts src/test/lmRetry.test.ts
git commit -m "feat(bitbucket): add 3-try retry with backoff for LM API calls

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: The 3rd try, made easier — `withEasierRetry`

**Files:**
- Modify: `src/utils/lmRetry.ts`
- Test: `src/test/lmRetry.test.ts`

**Interfaces:**
- Consumes: `isTransientLmError`, `withLmRetry`, `LmRetryOptions` (Task 1).
- Produces: `interface SplitBatch<TItem, TResult> { items: TItem[]; result?: TResult; error?: unknown }`; `interface EasierRetryOptions<TItem> extends Omit<LmRetryOptions, 'onAttemptFailed'> { onAttemptFailed?: (attempt: number, err: unknown, items: TItem[]) => void }`; `withEasierRetry<TItem, TResult>(items: TItem[], call: (items: TItem[]) => Promise<TResult>, split: (items: TItem[]) => [TItem[], TItem[]], opts?: EasierRetryOptions<TItem>): Promise<Array<SplitBatch<TItem, TResult>>>`.

**Behavior, exactly 3 tries:**
1. Try 1: `call(items)` with the full, unmodified batch.
2. Try 2 (1 retry): `call(items)` again, identical, after backoff.
3. Try 3, only if `items.length > 1`: split `items` in half once via `split`,
   and try each half **one single time** (no further retry, no further
   splitting) — this is "a bit less challenge to the LLM" per batch. If
   `items.length <= 1` there's nothing left to shrink, so that item instead
   gets the full identical-retry budget (still 3 tries total, just all
   identical, via a bare `withLmRetry` call).
4. A non-transient error at any point rethrows immediately — splitting can't
   fix a permissions/quota/cancellation failure, so don't waste a try on it.

`call` must be a **single-attempt** function with no retry of its own — the
3-attempt budget lives entirely in `withEasierRetry`/`withLmRetry`. In
`BitbucketParticipant.ts` (Task 4/5) this means passing `callLLMOnce`, not
the retrying `callLLM`, as `call`.

- [x] **Step 1: Write the failing tests**

Update the import line at the top of `src/test/lmRetry.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { isTransientLmError, withLmRetry, withEasierRetry, PartialLmResponseError } from '../utils/lmRetry';
```

Append:

```typescript
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `~/.volta/bin/npm test -- lmRetry`
Expected: FAIL — `withEasierRetry is not exported`

- [x] **Step 3: Write the implementation**

Append to `src/utils/lmRetry.ts`:

```typescript
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `~/.volta/bin/npm test -- lmRetry`
Expected: PASS (all tests in the file)

- [x] **Step 5: Commit**

```bash
git add src/utils/lmRetry.ts src/test/lmRetry.test.ts
git commit -m "feat(bitbucket): add withEasierRetry — 3rd try splits the batch instead of repeating it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Shared diagnostics output channel

**Files:**
- Create: `src/utils/diagLog.ts`

**Interfaces:**
- Produces: `getOutputChannel(): vscode.OutputChannel`; `logDiag(scope: string, message: string, details?: Record<string, unknown>): void`.

This file imports `vscode` (Output Channel API) and has no unit test, matching
the project's existing convention for vscode-glue utilities — verified by
`npm run compile` and by exercising it manually in Task 4/5.

- [x] **Step 1: Write the implementation**

Create `src/utils/diagLog.ts`:

```typescript
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Lazy singleton — shared by every feature in the extension (both `@jira`
 * and `@bitbucket`), not just this one. Visible to the user via
 * `View → Output → "Ticket Sidekick"`.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Ticket Sidekick');
  }
  return channel;
}

/**
 * Append a timestamped diagnostic line. `scope` is a short dotted tag (e.g.
 * `bitbucket.review`, `jira.create`) so entries from different features
 * stay distinguishable in the one shared channel. Any feature in either
 * participant should log through this rather than inventing its own output
 * channel or relying on the chat transcript alone — see `CLAUDE.md` →
 * "Diagnostics".
 */
export function logDiag(scope: string, message: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const out = getOutputChannel();
  out.appendLine(`[${timestamp}] [${scope}] ${message}`);
  if (details) {
    out.appendLine(JSON.stringify(details));
  }
}
```

- [x] **Step 2: Verify it compiles**

Run: `~/.volta/bin/npm run compile`
Expected: no TypeScript errors

- [x] **Step 3: Commit**

```bash
git add src/utils/diagLog.ts
git commit -m "feat: add shared Ticket Sidekick output channel for diagnostics

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Single-attempt LLM primitives + logging, wired into the existing simple call sites

**Files:**
- Modify: `src/participant/BitbucketParticipant.ts:51-82` (current `callLLM` / `callLLMWithProgress`)
- Modify: `src/participant/BitbucketParticipant.ts:370,386,406` (the three existing follow-up call sites)

**Interfaces:**
- Consumes: `withLmRetry`, `PartialLmResponseError` (Task 1); `logDiag` (Task 3).
- Produces:
  - `callLLMOnce(prompt, model, token, onChunk?): Promise<string>` — **single
    attempt**, no retry. Captures partial text into `PartialLmResponseError`
    if the stream breaks mid-reply. This is the primitive Task 5 passes into
    `withEasierRetry`.
  - `callLLM(prompt, model, token, contextLabel, onChunk?): Promise<string>`
    — `callLLMOnce` wrapped in `withLmRetry` (3 identical tries), logging
    every failed attempt. Used by call sites with nothing splittable (a
    single small prompt).
  - `callLLMOnceWithProgress(prompt, model, token, statusMessage): Promise<string>`
    — `callLLMOnce` with a VS Code progress indicator, no retry.
  - `callLLMWithProgress(prompt, model, token, statusMessage, contextLabel): Promise<string>`
    — `callLLM` with a VS Code progress indicator (retains the existing
    signature's behavior, with an added required `contextLabel`).

No unit test — this file imports `vscode`. Verification is `npm run compile`
plus a manual review-and-follow-up run in the Extension Development Host at
the end of Task 5/6.

- [x] **Step 1: Add the imports**

In `src/participant/BitbucketParticipant.ts`, add near the top (after the
existing `reviewSessionState` import block):

```typescript
import { withLmRetry, PartialLmResponseError } from '../utils/lmRetry';
import { logDiag } from '../utils/diagLog';
```

- [x] **Step 2: Replace `callLLM` and `callLLMWithProgress`**

Replace `BitbucketParticipant.ts:51-82` with:

```typescript
function logLmFailure(
  contextLabel: string,
  attempt: number,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const code = (err as { code?: unknown })?.code;
  const cause = (err as { cause?: unknown })?.cause;
  const partialText = err instanceof PartialLmResponseError ? err.partialText : undefined;
  logDiag('bitbucket.review', `LLM call failed — ${contextLabel} (attempt ${attempt})`, {
    ...extra,
    error: err instanceof Error ? err.message : String(err),
    code: typeof code === 'string' ? code : undefined,
    cause: cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined,
    partialTextChars: partialText?.length,
    partialTextPreview: partialText?.slice(0, 300),
  });
}

/** Single attempt, no retry — the primitive every retry wrapper builds on. */
async function callLLMOnce(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk?: (totalChars: number) => void,
): Promise<string> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let text = '';
  try {
    for await (const chunk of response.text) {
      text += chunk;
      onChunk?.(text.length);
    }
  } catch (err) {
    // The stream broke mid-reply. If it had already sent something —
    // possibly a clarifying question, or a partial explanation — keep it
    // instead of throwing the raw stream error and losing it.
    if (text.trim()) throw new PartialLmResponseError(text.trim(), err);
    throw err;
  }
  return text.trim();
}

async function callLLMOnceWithProgress(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  statusMessage: string,
): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Ticket Sidekick' },
    (progress) => callLLMOnce(prompt, model, token, (chars) => {
      progress.report({ message: `${statusMessage} · ${chars.toLocaleString()} chars…` });
    }),
  );
}

/** 3 identical tries (see lmRetry.ts) — for a single, non-splittable prompt. */
async function callLLM(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  contextLabel: string,
  onChunk?: (totalChars: number) => void,
): Promise<string> {
  return withLmRetry(
    () => callLLMOnce(prompt, model, token, onChunk),
    {
      onAttemptFailed: (attempt, err) => logLmFailure(contextLabel, attempt, err, {
        promptChars: prompt.length,
        estimatedTokens: Math.ceil(prompt.length / 4),
      }),
    },
  );
}

async function callLLMWithProgress(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  statusMessage: string,
  contextLabel: string,
): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Ticket Sidekick' },
    (progress) => callLLM(prompt, model, token, contextLabel, (chars) => {
      progress.report({ message: `${statusMessage} · ${chars.toLocaleString()} chars…` });
    }),
  );
}
```

- [x] **Step 3: Update the three follow-up call sites**

These three calls don't change otherwise — only the added trailing
`contextLabel` argument.

At `BitbucketParticipant.ts:370` (finding-match follow-up), change:

```typescript
const matchRaw = await callLLMWithProgress(matchPrompt, request.model, token, 'Matching finding');
```

to:

```typescript
const matchRaw = await callLLMWithProgress(matchPrompt, request.model, token, 'Matching finding', 'follow-up match');
```

At `BitbucketParticipant.ts:386` (general PR-level question), change:

```typescript
const prAnswer = await callLLMWithProgress(prContextPrompt, request.model, token, 'Answering question');
```

to:

```typescript
const prAnswer = await callLLMWithProgress(prContextPrompt, request.model, token, 'Answering question', 'follow-up pr-answer');
```

At `BitbucketParticipant.ts:406` (finding explanation), change:

```typescript
const answer = await callLLMWithProgress(followUpPrompt, request.model, token, 'Explaining finding');
```

to:

```typescript
const answer = await callLLMWithProgress(followUpPrompt, request.model, token, 'Explaining finding', 'follow-up explain');
```

- [x] **Step 4: Verify it compiles**

Run: `~/.volta/bin/npm run compile`
Expected: TypeScript errors only at the four Pass-1/continuation/Pass-2/critic
call sites inside the review loop (`BitbucketParticipant.ts:541,557,588,603`),
which are missing the new `contextLabel` argument — that's expected, Task 5
rewrites that whole loop.

- [x] **Step 5: Commit**

Commit together with Task 5 (the loop rewrite) since the review loop won't
compile on its own until then — see Task 5's commit step.

---

## Task 5: Fail-soft review loop using `withEasierRetry`

**Files:**
- Modify: `src/participant/BitbucketParticipant.ts:530-628` (the per-chunk `for` loop) and `:630-636` (formatting/output, immediately after the loop)

**Interfaces:**
- Consumes: `withEasierRetry`, `SplitBatch` (Task 2); `callLLMOnce`, `callLLMOnceWithProgress`, `callLLMWithProgress`, `logLmFailure` (Task 4); existing `service.buildPrompt`, `service.buildCriticPrompt`, `parseReviewResponse`, `resolveFindingAnchors`, `parseCriticKeep`, `estimateChunkTokens`, `selectFilesWithinBudget`, `MAX_CONTEXT_FILES_PER_BATCH` (all already imported/defined in this file).
- Produces: the loop now also logs the model identity once per review, and
  sets a local `anyBatchFailed` flag consumed right after the loop.

No unit test — this is the core vscode-glue handler body. Verification is
`npm run compile` plus a manual review run.

- [x] **Step 1: Log the model identity once per review**

Immediately after the existing line
`const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);`
(`BitbucketParticipant.ts:486`), add:

```typescript
logDiag('bitbucket.review', 'model in use', {
  vendor: request.model.vendor,
  family: request.model.family,
  id: request.model.id,
  version: request.model.version,
  maxInputTokens: request.model.maxInputTokens,
});
```

- [x] **Step 2: Add the split helpers and a failure-description helper**

Immediately before the `for (let i = 0; i < chunks.length; i++) {` loop
(`BitbucketParticipant.ts:530`), add:

```typescript
const halveFiles = (items: FileDiff[]): [FileDiff[], FileDiff[]] => {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
};

const halveFindings = (
  items: Array<Omit<ReviewFinding, 'id'>>,
): [Array<Omit<ReviewFinding, 'id'>>, Array<Omit<ReviewFinding, 'id'>>] => {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
};

function describeFailure(err: unknown): string {
  const partial = err instanceof PartialLmResponseError ? err.partialText : undefined;
  const base = err instanceof Error ? err.message : String(err);
  return partial
    ? `${base} — model's partial reply: "${partial.slice(0, 300)}${partial.length > 300 ? '…' : ''}"`
    : base;
}
```

`FileDiff` must be in this file's existing import from `./reviewSessionState`
— confirm it's already imported (it is, as a type used elsewhere in the file
via `parseDiff`'s return type); if the `type FileDiff` name isn't already in
the import list, add it there.

- [x] **Step 3: Replace the per-chunk loop**

Replace `BitbucketParticipant.ts:530-628` (from `for (let i = 0; i < chunks.length; i++) {` through the closing `}` of that loop) with:

```typescript
let anyBatchFailed = false;

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const from = fileOffset + 1;
  const to = fileOffset + chunk.length;
  fileOffset += chunk.length;
  const batchLabel = chunks.length > 1 ? ` · batch ${i + 1}/${chunks.length}` : '';
  stream.markdown(`_Analysing files ${from}–${to} of ${fileDiffs.length}${batchLabel}…_\n\n`);

  const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
  const pass1Label = `pass1 batch ${i + 1}/${chunks.length}`;

  const pass1Batches = await withEasierRetry(
    chunk,
    async (files) => {
      const prompt = service.buildPrompt(pr, files, undefined, extraInstructions);
      totalInputChars += prompt.length;
      const raw = await callLLMOnceWithProgress(prompt, request.model, token, batchStatus);
      totalOutputChars += raw.length;
      return raw;
    },
    halveFiles,
    {
      onAttemptFailed: (attempt, err, files) => logLmFailure(pass1Label, attempt, err, {
        files: files.map((f) => f.path),
      }),
    },
  );

  let chunkFindings: Array<Omit<ReviewFinding, 'id'>> = [];

  for (const batch of pass1Batches) {
    if (batch.error !== undefined) {
      anyBatchFailed = true;
      const filePaths = batch.items.map((f) => f.path).join(', ');
      stream.markdown(`_⚠ Batch ${i + 1} — could not review ${filePaths} after retrying: ${describeFailure(batch.error)}_\n\n`);
      continue;
    }

    const { findings, additionalFilesNeeded, truncated } = await parseReviewResponse(batch.result!);
    let batchFindings = resolveFindingAnchors(findings, batch.items);

    if (truncated) {
      stream.markdown(`_⚠ LLM response truncated (batch ${i + 1}) — recovering partial findings._\n\n`);
      const coveredPaths = new Set(findings.map((f) => f.file));
      const uncoveredFiles = batch.items.filter((d) => !coveredPaths.has(d.path));
      if (uncoveredFiles.length > 0) {
        stream.markdown(`_Continuing review for ${uncoveredFiles.length} uncovered file${uncoveredFiles.length !== 1 ? 's' : ''}…_\n\n`);
        try {
          const continuationNote = 'Continuation pass — the previous response was truncated. Review ONLY the files provided below.';
          const contInstructions = continuationNote + (extraInstructions ? '\n' + extraInstructions : '');
          const contPrompt = service.buildPrompt(pr, uncoveredFiles, undefined, contInstructions);
          totalInputChars += contPrompt.length;
          const contRaw = await callLLMWithProgress(contPrompt, request.model, token, `${batchStatus} continuation`, `continuation batch ${i + 1}/${chunks.length}`);
          totalOutputChars += contRaw.length;
          const cont = await parseReviewResponse(contRaw);
          batchFindings = resolveFindingAnchors([...findings, ...cont.findings], batch.items);
        } catch (err) {
          anyBatchFailed = true;
          stream.markdown(`_⚠ Continuation pass failed (batch ${i + 1}) — keeping findings from the truncated response. ${describeFailure(err)}_\n\n`);
        }
      }
    }

    if (reviewMode !== 'quick' && !truncated && additionalFilesNeeded.length > 0) {
      try {
        const toFetch = additionalFilesNeeded
          .filter((p) => !fetchedFileCache.has(p))
          .slice(0, MAX_CONTEXT_FILES_PER_BATCH);
        if (toFetch.length > 0) {
          const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
          stream.markdown(`_Fetching ${toFetch.length} context file${toFetch.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
          const fetched = await service.gatherFileContents(parsed.project, parsed.repo, pr.fromCommitHash, toFetch);
          for (const [p, c] of fetched) fetchedFileCache.set(p, c);
        }
        const requestedEntries = additionalFilesNeeded
          .filter((p) => fetchedFileCache.has(p))
          .map((p) => ({ path: p, content: fetchedFileCache.get(p)! }));
        const contentBudget = Math.max(0, tokenBudget - estimateChunkTokens(batch.items));
        const extraContents = selectFilesWithinBudget(requestedEntries, contentBudget);
        if (extraContents.size > 0) {
          const pass2Prompt = service.buildPrompt(pr, batch.items, extraContents, extraInstructions);
          totalInputChars += pass2Prompt.length;
          const pass2Raw = await callLLMWithProgress(pass2Prompt, request.model, token, `${batchStatus} pass 2`, `pass2 batch ${i + 1}/${chunks.length}`);
          totalOutputChars += pass2Raw.length;
          const pass2 = await parseReviewResponse(pass2Raw);
          if (pass2.truncated) {
            stream.markdown(`_⚠ LLM response truncated (batch ${i + 1} pass 2) — review may be incomplete._\n\n`);
          }
          batchFindings = resolveFindingAnchors(pass2.findings, batch.items);
        }
      } catch (err) {
        anyBatchFailed = true;
        stream.markdown(`_⚠ Pass 2 (whole-file context) failed (batch ${i + 1}) — keeping findings from the diff-only pass. ${describeFailure(err)}_\n\n`);
      }
    }

    chunkFindings = chunkFindings.concat(batchFindings);
  }

  if (criticEnabled && chunkFindings.length > 0) {
    const criticLabel = `critic batch ${i + 1}/${chunks.length}`;
    const criticBatches = await withEasierRetry(
      chunkFindings,
      async (findingsSubset) => {
        const referencedPaths = new Set(findingsSubset.map((f) => f.file));
        const relevantDiffs = chunk.filter((d) => referencedPaths.has(d.path));
        const prompt = service.buildCriticPrompt(pr, relevantDiffs, findingsSubset, extraInstructions);
        totalInputChars += prompt.length;
        const raw = await callLLMOnceWithProgress(prompt, request.model, token, `${batchStatus} verifying`);
        totalOutputChars += raw.length;
        return raw;
      },
      halveFindings,
      {
        onAttemptFailed: (attempt, err, findingsSubset) => logLmFailure(criticLabel, attempt, err, {
          findingTitles: findingsSubset.map((f) => f.title),
        }),
      },
    );

    const verified: Array<Omit<ReviewFinding, 'id'>> = [];
    let droppedByCritic = 0;
    for (const batch of criticBatches) {
      if (batch.error !== undefined) {
        anyBatchFailed = true;
        stream.markdown(
          `_⚠ Critic verification for batch ${i + 1} didn't complete for ${batch.items.length} finding${batch.items.length !== 1 ? 's' : ''} — keeping ${batch.items.length !== 1 ? 'them' : 'it'} unverified. ${describeFailure(batch.error)}_\n\n`,
        );
        verified.push(...batch.items); // fail-soft: keep unverified rather than drop
        continue;
      }
      const keep = parseCriticKeep(batch.result!, batch.items.length);
      batch.items.forEach((f, idx) => {
        if (keep.has(idx + 1)) verified.push(f);
        else droppedByCritic++;
      });
    }
    if (droppedByCritic > 0) {
      stream.markdown(`_Critic dropped ${droppedByCritic} unverified finding${droppedByCritic !== 1 ? 's' : ''} (batch ${i + 1})._\n\n`);
    }
    chunkFindings = verified;
  }

  allFindings = allFindings.concat(chunkFindings);

  if (chunks.length > 1 && i < chunks.length - 1) {
    const crit = chunkFindings.filter((f) => f.severity === 'critical').length;
    const warn = chunkFindings.filter((f) => f.severity === 'warning').length;
    const sugg = chunkFindings.filter((f) => f.severity === 'suggestion').length;
    const tally = [
      crit ? `${crit} 🔴` : '',
      warn ? `${warn} 🟡` : '',
      sugg ? `${sugg} 🔵` : '',
    ].filter(Boolean).join(' · ') || 'no issues';
    stream.markdown(`_Batch ${i + 1}/${chunks.length} done · ${tally}_\n\n`);
  }
}
```

Note: `fetchedFileCache`, `allFindings`, `fileOffset`, `totalInputChars`,
`totalOutputChars` are declared just above the loop (`BitbucketParticipant.ts:523-528`)
and are unchanged — only `anyBatchFailed` is newly declared, at the top of
this replaced block.

- [x] **Step 4: Surface the partial-results summary before the report**

Immediately before `stream.markdown(output);` (right after the existing
`const output = service.formatReview(...)` line, `BitbucketParticipant.ts:633-634`),
add:

```typescript
if (anyBatchFailed) {
  stream.markdown(`_⚠ Some batches had failures after retrying — showing partial results. See the "Ticket Sidekick" output channel for details._\n\n`);
}
```

so it reads:

```typescript
const output = service.formatReview(numbered, pr, fileDiffs.length, config.confidenceThreshold);
if (anyBatchFailed) {
  stream.markdown(`_⚠ Some batches had failures after retrying — showing partial results. See the "Ticket Sidekick" output channel for details._\n\n`);
}
stream.markdown(output);
```

- [x] **Step 5: Run compile and the full test suite**

Run: `~/.volta/bin/npm run compile`
Expected: no TypeScript errors

Run: `~/.volta/bin/npm test`
Expected: PASS — full existing suite plus `lmRetry.test.ts`, unaffected by
these changes since none of the touched code is unit-tested directly

- [x] **Step 6: Commit (together with Task 4)**

```bash
git add src/participant/BitbucketParticipant.ts
git commit -m "feat(bitbucket): fail-soft review loop with a genuinely easier 3rd try

A single transient VS Code Language Model API failure (e.g. \"Response
contained no choices\") no longer aborts an entire review. The main review
call and the deep-mode critic call now get 3 tries: the original request,
one identical retry, and — only if the batch has more than one item — a
final try that splits it in half instead of resending the same full-size
prompt a third time. A chunk/finding that still fails after its 3 tries is
skipped and reported, not fatal to the whole review — partial results are
still shown and saved. Every attempt is bounded: at most 4 real LLM calls
per chunk/critic-batch, never an open-ended retry storm.

Every failed attempt (including recoverable ones) is logged to the new
shared \"Ticket Sidekick\" output channel with the model identity, call
site, exact items in that attempt, and the raw error, so a persistent
per-model incompatibility can be told apart from one-off provider noise.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Friendlier top-level, follow-up, and comment-refinement error messages

**Files:**
- Modify: `src/participant/BitbucketParticipant.ts:303-307` (comment-refinement catch)
- Modify: `src/participant/BitbucketParticipant.ts:412-417` (follow-up catch)
- Modify: `src/participant/BitbucketParticipant.ts:654-656` (outer review catch)

**Interfaces:**
- Consumes: `isTransientLmError` (Task 1).

No unit test — vscode-glue error message strings. Verification is
`npm run compile` plus manual review of the rendered chat markdown.

- [x] **Step 1: Add a shared friendly-message helper**

Near `describeFailure` (added in Task 5, Step 2), add:

```typescript
function friendlyLmFailureMessage(prefix: string, err: unknown): string {
  if (isTransientLmError(err) && !(err instanceof PartialLmResponseError)) {
    return `${prefix} the model returned an empty response after retrying — this is usually a transient provider hiccup, more likely in \`deep\` mode since it makes more model calls per review. Try again, or drop \`deep\` for a lighter run. _(see the "Ticket Sidekick" output channel for details)_`;
  }
  return `${prefix} ${describeFailure(err)}`;
}
```

This needs `isTransientLmError` imported (add it to the Task 4 Step 1 import
line: `import { withLmRetry, isTransientLmError, PartialLmResponseError } from '../utils/lmRetry';`).

- [x] **Step 2: Update the outer review catch**

Replace `BitbucketParticipant.ts:654-656`:

```typescript
    } catch (err) {
      stream.markdown(`**Review failed:** ${err instanceof Error ? err.message : String(err)}`);
    }
```

with:

```typescript
    } catch (err) {
      stream.markdown(friendlyLmFailureMessage('**Review failed:**', err));
    }
```

- [x] **Step 3: Update the follow-up catch**

Replace `BitbucketParticipant.ts:412-417`:

```typescript
        } catch (err) {
          stream.markdown(
            `**Follow-up failed:** ${err instanceof Error ? err.message : String(err)}\n\n<!-- bitbucket:review-session -->`,
          );
          return;
        }
```

with:

```typescript
        } catch (err) {
          stream.markdown(
            `${friendlyLmFailureMessage('**Follow-up failed:**', err)}\n\n<!-- bitbucket:review-session -->`,
          );
          return;
        }
```

- [x] **Step 4: Update the comment-refinement catch**

Replace `BitbucketParticipant.ts:303-307`:

```typescript
        } catch (err) {
          stream.markdown(
            `**Refinement failed:** ${err instanceof Error ? err.message : String(err)}\n\n<!-- bitbucket:comment-preview -->`,
          );
        }
```

with:

```typescript
        } catch (err) {
          stream.markdown(
            `${friendlyLmFailureMessage('**Refinement failed:**', err)}\n\n<!-- bitbucket:comment-preview -->`,
          );
        }
```

- [x] **Step 5: Run compile and the full test suite**

Run: `~/.volta/bin/npm run compile && ~/.volta/bin/npm test`
Expected: both PASS

- [x] **Step 6: Commit**

```bash
git add src/participant/BitbucketParticipant.ts
git commit -m "fix(bitbucket): friendlier message for transient LM failures

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/review-process.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [x] **Step 1: Update `docs/review-process.md`**

Add a new section after "## Filtering: only one hard drop" (before "##
Provenance"):

```markdown
## Resilience & debugging

Every LLM call in the pipeline gets exactly 3 tries: the original request,
one identical retry (short exponential backoff), and — for the two calls
that dominate `deep` mode's extra load, the main review call and the critic
call — a 3rd try that's genuinely easier for the model instead of a 3rd
identical one: the batch of files (or findings) is split in half once and
each half gets one final attempt. This bounds every chunk to at most 4 real
LLM calls, never an open-ended retry storm. A file or finding that still
fails standalone after its tries is skipped and reported — it does not
abort the rest of the review. `dedupeFindings` → `formatReview` →
`ReviewSession` always run on whatever was collected, even after partial
failures, so follow-ups keep working.

Every failed attempt — including ones that succeed on retry — is logged to
the shared `"Ticket Sidekick"` output channel (`View → Output`), along with
the model identity in use (vendor/family/id/version) once per review. This
is what makes it possible to tell a one-off provider hiccup apart from a
specific model that consistently fails on a specific prompt shape.
```

Update the "Modes" section's introductory sentence — find:

```markdown
Context widening applies in **all** modes — only the expensive whole-file Pass 2
and the critic pass are mode-gated.
```

and add a sentence after it:

```markdown
`deep` mode's critic pass adds one LLM call per chunk on top of the main
review call — roughly doubling the number of sequential calls made per
review, and proportionally increasing exposure to a transient provider
failure (see "Resilience & debugging" above).
```

- [x] **Step 2: Update `CLAUDE.md`**

Add two rows to the "Key files" table (near `src/utils/apiError.ts` /
`src/utils/fetchWithRetry.ts` if listed):

```markdown
| `src/utils/lmRetry.ts` | 3-try retry for VS Code Language Model API calls: `withLmRetry` (identical-retry, for a single non-splittable prompt) and `withEasierRetry` (the 3rd try splits a batch in half instead of repeating it). `isTransientLmError` classifies which failures are worth retrying. `PartialLmResponseError` preserves any text a broken response stream had already sent |
| `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` VS Code Output Channel singleton (`getOutputChannel()`) and `logDiag(scope, message, details?)` — the place for diagnostic detail beyond the chat transcript. Used by the Bitbucket review pipeline today; new features in either participant should log through it too |
```

Add a new section after "## Credentials" and before "## Branch ticket
detection":

```markdown
## Diagnostics

A shared VS Code Output Channel named `"Ticket Sidekick"` (`View → Output`,
via `getOutputChannel()`/`logDiag()` in `src/utils/diagLog.ts`) is the place
for anything a user or a future debugging session needs beyond the chat
transcript — model identity, retry attempts, raw API errors. It's used today
by the Bitbucket review pipeline's LLM retry logic (`src/utils/lmRetry.ts`,
wired into `BitbucketParticipant.ts`). **New features in either participant
should log through `logDiag()` too**, rather than inventing separate
console/output-channel logging.
```

Update the PR review flow section — in the numbered pipeline list, after the
existing step describing the critic pass (currently step 11, "Critic pass
(deep mode only)..."), add a new sentence to that same step:

```markdown
Every LLM call in this pipeline gets 3 tries (`src/utils/lmRetry.ts`); the
main review call and the critic call use their 3rd try to split into two
smaller sub-batches rather than repeating the same request, and a
sub-batch that still fails is skipped and reported rather than aborting
the whole review — see `docs/review-process.md` → "Resilience & debugging".
```

- [x] **Step 3: Update `README.md`**

Add a new top-level section after the `@bitbucket — Bitbucket PR Reviews`
section's last subsection ("Reducing token usage on large PRs", ending
around line 966) and before `## Releasing`:

```markdown
## Troubleshooting

Both `@jira` and `@bitbucket` log diagnostic detail beyond what's shown in
chat to a shared VS Code output channel: **View → Output → "Ticket
Sidekick"**.

For `@bitbucket` reviews specifically, this includes: the model in use
(vendor/family/id/version) for the review, every LLM call that failed
(including ones that succeeded on a retry), the call site and which files
or findings were in that attempt, and the raw error. If a review or
follow-up ever shows a failure message, check this channel first — it
usually explains whether it was a one-off provider hiccup (worth just
retrying) or something more persistent.
```

- [x] **Step 4: Commit**

```bash
git add docs/review-process.md CLAUDE.md README.md
git commit -m "docs(bitbucket): document 3-try retry pipeline and diagnostics channel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** 3-try plain retry (Task 1), 3rd-try-splits-instead-of-repeats
  (Task 2), shared output channel (Task 3), single-attempt primitives + logging
  wired into the simple call sites (Task 4), fail-soft per-chunk loop using
  `withEasierRetry` on the main review and critic calls (Task 5), friendlier
  top-level/follow-up/refinement messages (Task 6), docs for both users and
  future contributors (Task 7) — covers the corrected, bounded design agreed
  after the plan-mode review (3 tries total, sequential one-shot halves, full
  per-attempt logging).
- **Type consistency:** `SplitBatch<TItem, TResult>` (Task 2) is used
  identically in Task 5 for both `TItem = FileDiff` (Pass 1) and
  `TItem = Omit<ReviewFinding, 'id'>` (critic pass) — no signature drift.
  `EasierRetryOptions<TItem>.onAttemptFailed`'s 3rd parameter (`items`) is
  consumed identically at both `withEasierRetry` call sites in Task 5.
  `callLLMWithProgress`'s new required `contextLabel` parameter (Task 4) is
  threaded through every call site that still uses it (continuation, Pass 2,
  the three follow-up sites) — Pass 1 and critic now use
  `callLLMOnceWithProgress` instead (no `contextLabel`, since `withEasierRetry`
  handles logging via `onAttemptFailed`).
- **No placeholders:** every step above contains complete, real code — no
  "add appropriate error handling" or "similar to Task N" placeholders.
