import { ModelRequestCancelledError, type BoardModelHandle } from '../../boards/boardModels';
import { PrReviewService, type ReviewBackground } from '../../services/PrReviewService';
import type { DiagLogger } from '../../utils/diagTypes';
import { isTransientLmError, PartialLmResponseError, refusalOf, UnparseableReplyError, withEasierRetry, withLmRetry, type SplitBatch } from '../../utils/lmRetry';
import { sanitizeDetails } from '../../utils/logRedaction';
import { createTokenMeter, type TokenMeter } from '../tokenMeter';
import {
  createAttemptTracker,
  estimateChunkTokens,
  formatCallLine,
  formatRecoveryDecision,
  MAX_CONTEXT_FILES_PER_BATCH,
  parseReviewReply,
  selectFilesWithinBudget,
  type FileDiff,
  type ReviewPass,
} from '../reviewSessionState';
import { describeErrorForLog, errorCodeOf, errorNameOf, handleAttemptFailure, type CallDiagHooks } from '../reviewDiagnostics';
import type { EngineDeps, EngineSettings, PassOutcome, ReviewStep, TokenTotals } from './types';

// The pieces every pass shares: the metered model call, stop handling, the token budget and the
// context-file reads at the reviewed commit. vscode-free.

/** A stop the developer asked for: ends the pass at once, with no retry and no split. */
export function isStop(err: unknown, signal: AbortSignal): boolean {
  return err instanceof ModelRequestCancelledError || signal.aborted;
}

/** Throws the stop when the signal has aborted, so no further call is made. */
export function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelRequestCancelledError();
}

/** Rethrows a stop hidden in a retry helper's failed part (a one-item batch is returned, not thrown). */
export function rethrowStop(errors: unknown[], signal: AbortSignal): void {
  for (const err of errors) if (err !== undefined && isStop(err, signal)) throw new ModelRequestCancelledError({ cause: err });
}

export interface PassContext {
  meter: TokenMeter<BoardModelHandle>;
  signal: AbortSignal;
  /** Writes one diagnostic line, and keeps it for the structured run record when that is on. */
  log: DiagLogger;
  sleep?: (ms: number) => Promise<void>;
  /** Names the pull request on every diagnostic line, e.g. `pr=PROJ/app#42`. */
  runTag: string;
  /** The stage the pass has reached, named by the line logged when it aborts. */
  stage: string;
  /** Every line logged so far, while the structured run record is on. */
  recorded?: string[];
  /** The pass's configuration line, for the structured run record. */
  configLine?: string;
}

export function passContext(
  deps: Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag' | 'sleep'>,
  options: { runTag?: string; detailedDiagnostics?: boolean } = {},
): PassContext {
  const log: DiagLogger = (level, message, details) => {
    deps.onDiag?.(level, message, details);
    // The record carries only what the channel line would show: the details go through the same redaction.
    ctx.recorded?.push(details ? `${message} ${JSON.stringify(sanitizeDetails(details))}` : message);
  };
  const ctx: PassContext = {
    meter: createTokenMeter(deps.model, deps.recordTokens, log), signal: deps.signal, log, runTag: options.runTag ?? '', stage: 'setup',
    ...(options.detailedDiagnostics ? { recorded: [] } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
  };
  return ctx;
}

/** What one call is, for its diagnostic line. */
export interface CallSite {
  pass: ReviewPass;
  batch: number;
  totalBatches: number;
  itemCount: number;
}

/** One model call with no retry. A reply cut off by a broken stream keeps its text in a `PartialLmResponseError`. */
export async function callOnce(ctx: PassContext, prompt: string): Promise<string> {
  throwIfStopped(ctx.signal);
  const response = await ctx.meter.model.sendRequest([{ role: 'user', content: prompt }], { signal: ctx.signal });
  let text = '';
  try {
    for await (const chunk of response.text) text += chunk;
  } catch (err) {
    if (isStop(err, ctx.signal)) throw err;
    if (text.trim()) throw new PartialLmResponseError(text.trim(), err);
    throw err;
  }
  return text.trim();
}

/**
 * One model call with three identical tries; `validate` throws on a reply that is no use.
 * With a `site`, each attempt gets its call line and each failure its retry or give-up line; `hooks`
 * hands the attempt and its duration to a caller that logs its own call line.
 */
export async function callWithRetry(
  ctx: PassContext, prompt: string, label: string, validate?: (raw: string) => void,
  diag: { site?: CallSite; hooks?: CallDiagHooks } = {},
): Promise<string> {
  const { site, hooks } = diag;
  let attempt = 0;
  let startedAt = 0;
  const line = (status: 'ok' | 'truncated' | 'error', durationMs: number, extra: { responseChars?: number; errorCode?: string } = {}) => formatCallLine({
    runTag: ctx.runTag, pass: site!.pass, batch: site!.batch, totalBatches: site!.totalBatches, attempt,
    itemCount: site!.itemCount, promptChars: prompt.length, durationMs, status, ...extra,
  });
  return withLmRetry(async () => {
    attempt++;
    startedAt = Date.now();
    const raw = await callOnce(ctx, prompt);
    validate?.(raw);
    const durationMs = Date.now() - startedAt;
    if (hooks?.attemptOut) { hooks.attemptOut.attempt = attempt; hooks.attemptOut.durationMs = durationMs; }
    if (site) ctx.log('info', line(parseReviewReply(raw).truncated ? 'truncated' : 'ok', durationMs, { responseChars: raw.length }));
    return raw;
  }, {
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    onAttemptFailed: (failed, err) => {
      if (isStop(err, ctx.signal)) return;
      const durationMs = Date.now() - startedAt;
      ctx.log('warn', `Model call failed — ${label} (attempt ${failed})`, {
        error: err instanceof Error ? err.message : String(err), code: errorCodeOf(err), ...describeErrorForLog(err),
      });
      hooks?.onAttemptError?.(attempt, durationMs, errorCodeOf(err));
      if (!site) return;
      const errorCode = errorCodeOf(err);
      ctx.log('error', line('error', durationMs, errorCode ? { errorCode } : {}));
      const where = { pass: site.pass, batch: site.batch, totalBatches: site.totalBatches };
      if (!isTransientLmError(err)) ctx.log('warn', formatRecoveryDecision(ctx.runTag, { kind: 'give-up', ...where, errorName: errorNameOf(err) }));
      else if (attempt < 3) ctx.log('info', formatRecoveryDecision(ctx.runTag, { kind: 'retry', ...where, attempt: attempt + 1 }));
    },
  });
}

/** A reply with nothing review-shaped is retried and split like a provider error; a cut-off reply is not. */
export function assertReadableReply(raw: string): void {
  const reply = parseReviewReply(raw);
  if (!reply.hasJson && !reply.truncated) throw new UnparseableReplyError(raw);
}

export function splitInHalf<T>(items: T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

/**
 * One batch's first call over `items`: tried twice, then split in half with one try per half. Each
 * attempt gets its call line and each failure its failure, call and recovery lines. A stop throws;
 * a part that failed after its tries is returned with its error. A refusal (rate-limited, blocked,
 * quota used up) is never retried or split: it comes back as one failed part over every item, so the
 * caller can read its class with `refusalOf`.
 */
export async function callBatchWithSplit<T>(ctx: PassContext, params: {
  items: T[];
  pass: ReviewPass;
  batch: number;
  totalBatches: number;
  label: string;
  buildPrompt: (items: T[]) => string;
  /** Throws on a reply that is no use, so it is retried and split like a provider error. */
  validate?: (raw: string) => void;
  statusOf: (raw: string) => 'ok' | 'truncated';
  /** Extra details on the failure line, before the error. */
  failureDetails?: (items: T[]) => Record<string, unknown>;
}): Promise<Array<SplitBatch<T, string>>> {
  const { items, pass, batch, totalBatches, label } = params;
  const tracker = createAttemptTracker<T>();
  let promptChars = 0;
  let parts: Array<SplitBatch<T, string>>;
  try {
    parts = await withEasierRetry(
      items,
      async (subset) => {
        const attempt = tracker.start(subset);
        const prompt = params.buildPrompt(subset);
        promptChars = prompt.length;
        const raw = await callOnce(ctx, prompt);
        params.validate?.(raw);
        ctx.log('info', formatCallLine({
          runTag: ctx.runTag, pass, batch, totalBatches, attempt, itemCount: subset.length, promptChars: prompt.length,
          responseChars: raw.length, durationMs: tracker.elapsedMs(), status: params.statusOf(raw),
        }));
        return raw;
      },
      splitInHalf,
      {
        ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
        onAttemptFailed: (attempt, err, subset) => {
          if (isStop(err, ctx.signal)) return;
          handleAttemptFailure({
            runTag: ctx.runTag, pass, batch, totalBatches, libraryAttempt: attempt, err, items: subset, originalItems: items,
            tracker, promptChars, split: splitInHalf,
            logFailure: (a, e) => ctx.log('warn', `Model call failed — ${label} (attempt ${a})`, {
              ...params.failureDetails?.(subset), error: e instanceof Error ? e.message : String(e),
            }),
            logReview: ctx.log,
          });
        },
      },
    );
  } catch (err) {
    if (isStop(err, ctx.signal) || !refusalOf(err)) throw err;
    parts = [{ items, error: err }];
  }
  rethrowStop(parts.map((part) => part.error), ctx.signal);
  return parts;
}

/** The context size used when neither the setting nor the model gives one. */
export const DEFAULT_CONTEXT_TOKENS = 60000;
/** The share of the context a call may fill when the setting gives none. */
export const DEFAULT_CONTEXT_BUDGET_RATIO = 0.7;

export interface TokenBudget {
  /** The setting, else the model's own context size, else the default. */
  contextTokens: number;
  ratio: number;
  /** Tokens per call: the context size times the ratio. */
  tokens: number;
}

/** Token budget per call: the setting, else the model's own context size, else 60000, times the ratio. */
export function tokenBudgetOf(settings: EngineSettings, model: Pick<BoardModelHandle, 'maxInputTokens'>): TokenBudget {
  const contextTokens = settings.modelContextTokens ?? (model.maxInputTokens || DEFAULT_CONTEXT_TOKENS);
  const ratio = settings.contextBudgetRatio ?? DEFAULT_CONTEXT_BUDGET_RATIO;
  return { contextTokens, ratio, tokens: Math.floor(contextTokens * ratio) };
}

/** The text every review prompt gets as additional instructions: the review instructions and an own-text background. */
export function extraInstructionsOf(settings: EngineSettings): string {
  const ownText = settings.background?.kind === 'text' ? settings.background.text : undefined;
  return [settings.reviewInstructions, ownText].filter((s) => s && s.trim()).join('\n\n');
}

/** The background a review prompt is built with; an empty one counts as none. */
export function backgroundOf(settings: EngineSettings): ReviewBackground | undefined {
  return settings.background?.text.trim() ? settings.background : undefined;
}

export function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  return err instanceof PartialLmResponseError ? `${base} (the reply broke off)` : base;
}

/**
 * Fetches the requested files not yet in `cache` at `commit`, then picks as many of the requested
 * files as fit the budget left after `budgetAgainst`. Pass 2 and the critic use the same rule.
 */
export async function fetchAndBudgetContextFiles(params: {
  requested: string[];
  cache: Map<string, string>;
  service: PrReviewService;
  project: string;
  repo: string;
  commit: string;
  tokenBudget: number;
  budgetAgainst: FileDiff[];
}): Promise<Map<string, string>> {
  const { requested, cache, service, project, repo, commit, tokenBudget, budgetAgainst } = params;
  const toFetch = requested.filter((p) => !cache.has(p)).slice(0, MAX_CONTEXT_FILES_PER_BATCH);
  if (toFetch.length > 0) {
    const fetched = await service.gatherFileContents(project, repo, commit, toFetch);
    for (const [p, c] of fetched) cache.set(p, c);
  }
  const entries = requested.filter((p) => cache.has(p)).map((p) => ({ path: p, content: cache.get(p)! }));
  return selectFilesWithinBudget(entries, Math.max(0, tokenBudget - estimateChunkTokens(budgetAgainst))).selected;
}

/** The stored context files as fit a call over `files`. */
export function budgetStoredContext(paths: string[], cache: Map<string, string>, tokenBudget: number, files: FileDiff[]): Map<string, string> {
  const entries = paths.filter((p) => cache.has(p)).map((p) => ({ path: p, content: cache.get(p)! }));
  return selectFilesWithinBudget(entries, Math.max(0, tokenBudget - estimateChunkTokens(files))).selected;
}

/** The key of a file read at a commit, in a run's shared cache. */
function contextCacheKey(commit: string, path: string): string {
  return `${commit}\n${path}`;
}

/** Keeps the files a pass read at `commit` in the run's shared cache, for the next pass of the run. */
export function keepInRunCache(runCache: Map<string, string> | undefined, commit: string, files: Map<string, string>): void {
  if (!runCache) return;
  for (const [path, content] of files) runCache.set(contextCacheKey(commit, path), content);
}

/**
 * Reads every path at the reviewed commit before a later pass calls the model. Any failed read means
 * the commit can no longer be read (a force-push removed it, or access was lost), and the pass must
 * not run; it never falls back to a newer head. The paths are read at once; the first failure in
 * path order is reported. A file an earlier pass of the same run read at this commit is taken from
 * `runCache`.
 */
export async function readContextAtCommit(
  client: Pick<EngineDeps['client'], 'getFileContent'>, project: string, repo: string, commit: string, paths: string[],
  runCache?: Map<string, string>,
): Promise<{ ok: true; files: Map<string, string> } | { ok: false; path: string; error: string }> {
  const reads = await Promise.all(paths.map(async (path): Promise<{ path: string; content: string } | { path: string; error: string }> => {
    const cached = runCache?.get(contextCacheKey(commit, path));
    if (cached !== undefined) return { path, content: cached };
    try {
      return { path, content: await client.getFileContent(project, repo, path, commit) };
    } catch (err) {
      return { path, error: err instanceof Error ? err.message : String(err) };
    }
  }));
  const files = new Map<string, string>();
  for (const read of reads) {
    if ('error' in read) return { ok: false, path: read.path, error: read.error };
    files.set(read.path, read.content);
  }
  keepInRunCache(runCache, commit, files);
  return { ok: true, files };
}

export function emptyOutcome(step: ReviewStep, batchesTotal: number): PassOutcome {
  return {
    step, status: 'finished', batchesDone: 0, batchesTotal, failedBatches: 0, notes: [],
    added: [], merged: [], droppedOutsidePr: 0, removed: [], labelled: [], tokens: { input: 0, output: 0, calls: 0, estimated: false },
  };
}

export function serviceFor(deps: Pick<EngineDeps, 'client' | 'onDiag'>): PrReviewService {
  return new PrReviewService(deps.client, deps.onDiag);
}

/** A single call that failed, was stopped, or gave a reply the caller could not read. */
export type CallFailure = { ok: false; stopped: boolean; error: string; tokens: TokenTotals };

/**
 * One metered model call with no retry, settled into a result: `read` turns the reply into the
 * caller's fields, or names why it cannot be used. A stop or a failed call fails it too.
 */
export async function settleOneCall<T extends object>(
  deps: Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag'>,
  prompt: string,
  failedLine: string,
  read: (raw: string, log: DiagLogger) => T | { unusable: string },
): Promise<(T & { ok: true; tokens: TokenTotals }) | CallFailure> {
  const ctx = passContext(deps);
  try {
    const raw = await callOnce(ctx, prompt);
    const value = read(raw, ctx.log);
    if ('unusable' in value) return { ok: false, stopped: false, error: value.unusable, tokens: ctx.meter.totals() };
    return { ok: true, ...value, tokens: ctx.meter.totals() };
  } catch (err) {
    const stopped = isStop(err, deps.signal);
    if (!stopped) ctx.log('warn', failedLine, { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, stopped, error: stopped ? 'Stopped.' : describeError(err), tokens: ctx.meter.totals() };
  }
}
