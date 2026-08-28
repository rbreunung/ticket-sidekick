/**
 * Diagnostics orchestration glue for the Bitbucket review pipeline's LLM call
 * sites (`BitbucketParticipant.ts`). Split out so that file's per-call/
 * per-attempt bookkeeping doesn't keep growing inline with every new
 * diagnostic (see the maintainability review of the diagnostics-timeline
 * plan). No `vscode` import — pure and Vitest-loadable, like
 * `reviewSessionState.ts`; `BitbucketParticipant.ts` supplies the actual
 * logging (`logLmFailure`, `logReview`) as injected callbacks, the same
 * pattern `TicketService`/`PrReviewService` already use for `onDiag`.
 */
import { isTransientLmError } from '../../utils/lmRetry';
import { createAttemptTracker, formatCallLine, formatRecoveryDecision, type ReviewPass } from '../reviewSessionState';

/**
 * Written into by `callLLM` on completion, so a review-pipeline call site can
 * log its own R1/R2 per-call line (with the real per-attempt duration) after
 * inspecting the response for truncation — something `callLLM` itself can't
 * know, since NDJSON parsing is the caller's concern.
 */
export interface CallAttemptOut {
  attempt: number;
  durationMs: number;
}

/** Called once per failed attempt (in addition to the existing `logLmFailure`), so a
 * review-pipeline call site can also emit R1/R2's per-call line shape for the failure. */
export type OnCallAttemptError = (attempt: number, durationMs: number, errorCode?: string) => void;

/** Optional diagnostics hooks for `callLLM`/`callLLMWithProgress` — used only by the
 * review-pipeline call sites (continuation, pass2) that need R1/R2's per-call line;
 * every other caller omits this and gets the unchanged plain-string behavior. */
export interface CallDiagHooks {
  attemptOut?: CallAttemptOut;
  onAttemptError?: OnCallAttemptError;
}

export function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

export { createAttemptTracker };

type LogReviewFn = (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;

/**
 * Shared `onAttemptFailed` handling for pass1 and critic — the two
 * `withEasierRetry` call sites in `BitbucketParticipant.ts` — previously two
 * near-identical ~25-line blocks. Logs the failure (via the caller-supplied
 * `logFailure`, e.g. `logLmFailure`) plus R1/R2's per-call error line, then
 * logs R5's recovery-decision line.
 *
 * The recovery-decision branch is gated on `items === originalItems` — a
 * post-split half is a distinct array reference and `withEasierRetry`'s
 * `tryOnceEasier` never retries it, so without this check a split half's
 * one-and-only (terminal) failure would falsely log "retry in flight" using
 * the tracker's per-subset attempt count of 1.
 */
export function handleAttemptFailure<T>(params: {
  runTag: string;
  pass: ReviewPass;
  batch: number;
  totalBatches: number;
  /** The attempt number withEasierRetry's own onAttemptFailed callback supplies —
   * passed straight to `logFailure` unchanged, matching the pre-existing failure-log
   * behavior (1/2 for the two full-batch tries, always 3 for a post-split half). The
   * R1/R2 diagnostic line below intentionally uses `tracker.attempt` instead — see
   * the module doc comment on why those two numbers legitimately differ. */
  libraryAttempt: number;
  err: unknown;
  items: T[];
  originalItems: T[];
  tracker: ReturnType<typeof createAttemptTracker<T>>;
  promptChars: number;
  split: (items: T[]) => [T[], T[]];
  logFailure: (attempt: number, err: unknown) => void;
  logReview: LogReviewFn;
}): void {
  const { runTag, pass, batch, totalBatches, libraryAttempt, err, items, originalItems, tracker, promptChars, split, logFailure, logReview } = params;

  logFailure(libraryAttempt, err);
  logReview('error', formatCallLine({
    runTag, pass, batch, totalBatches, attempt: tracker.attempt,
    itemCount: items.length, promptChars, durationMs: tracker.elapsedMs(),
    status: 'error', errorCode: errorCodeOf(err),
  }));

  if (!isTransientLmError(err) || items !== originalItems) return;

  if (originalItems.length <= 1) {
    // Single-item chunk can't split further — it gets the plain 3-identical-
    // tries budget (withLmRetry's default retries: 2), not the split path.
    if (tracker.attempt < 3) {
      logReview('info', formatRecoveryDecision(runTag, {
        kind: 'retry', pass, batch, totalBatches, attempt: tracker.attempt + 1,
      }));
    }
    return;
  }

  if (tracker.attempt === 1) {
    logReview('info', formatRecoveryDecision(runTag, {
      kind: 'retry', pass, batch, totalBatches, attempt: tracker.attempt + 1,
    }));
  } else if (tracker.attempt === 2) {
    const [left, right] = split(items);
    logReview('info', formatRecoveryDecision(runTag, {
      kind: 'split', pass, batch, totalBatches, leftCount: left.length, rightCount: right.length,
    }));
  }
}
