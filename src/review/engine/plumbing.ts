import { ModelRequestCancelledError, type BoardModelHandle } from '../../boards/boardModels';
import { PrReviewService } from '../../services/PrReviewService';
import type { DiagLogger } from '../../utils/diagTypes';
import { PartialLmResponseError, UnparseableReplyError, withLmRetry } from '../../utils/lmRetry';
import { createTokenMeter, type TokenMeter } from '../tokenMeter';
import {
  estimateChunkTokens,
  MAX_CONTEXT_FILES_PER_BATCH,
  parseReviewReply,
  selectFilesWithinBudget,
  type FileDiff,
} from '../reviewSessionState';
import { describeErrorForLog, errorCodeOf } from '../reviewDiagnostics';
import type { EngineDeps, EngineSettings, PassOutcome, ReviewStep } from './types';

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
  log: DiagLogger;
  sleep?: (ms: number) => Promise<void>;
}

export function passContext(deps: Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag' | 'sleep'>): PassContext {
  const log: DiagLogger = (level, message, details) => deps.onDiag?.(level, message, details);
  const meter = createTokenMeter(deps.model, deps.recordTokens, log);
  return { meter, signal: deps.signal, log, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
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

/** One model call with today's three identical tries; `validate` throws on a reply that is no use. */
export async function callWithRetry(ctx: PassContext, prompt: string, label: string, validate?: (raw: string) => void): Promise<string> {
  return withLmRetry(async () => {
    const raw = await callOnce(ctx, prompt);
    validate?.(raw);
    return raw;
  }, {
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    onAttemptFailed: (attempt, err) => {
      if (isStop(err, ctx.signal)) return;
      ctx.log('warn', `Model call failed — ${label} (attempt ${attempt})`, {
        error: err instanceof Error ? err.message : String(err), code: errorCodeOf(err), ...describeErrorForLog(err),
      });
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

/** Token budget per call: the setting, else the model's own context size, else 60000, times the ratio. */
export function tokenBudgetOf(settings: EngineSettings, model: Pick<BoardModelHandle, 'maxInputTokens'>): number {
  const contextTokens = settings.modelContextTokens ?? (model.maxInputTokens || 60000);
  return Math.floor(contextTokens * (settings.contextBudgetRatio ?? 0.7));
}

/** The text every review prompt gets as additional instructions. */
export function extraInstructionsOf(settings: EngineSettings): string {
  return [settings.reviewInstructions, settings.focus].filter((s) => s && s.trim()).join('\n\n');
}

export function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  return err instanceof PartialLmResponseError ? `${base} (the reply broke off)` : base;
}

/**
 * Fetches the requested files not yet in `cache` at `commit`, then picks as many of the requested
 * files as fit the budget left after `budgetAgainst`. The same rule Pass 2 and the critic use today.
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

/**
 * Reads every path at the reviewed commit before a later pass calls the model. Any failed read means
 * the commit can no longer be read (a force-push removed it, or access was lost), and the pass must
 * not run; it never falls back to a newer head.
 */
export async function readContextAtCommit(
  client: Pick<EngineDeps['client'], 'getFileContent'>, project: string, repo: string, commit: string, paths: string[],
): Promise<{ ok: true; files: Map<string, string> } | { ok: false; path: string; error: string }> {
  const files = new Map<string, string>();
  for (const path of paths) {
    try {
      files.set(path, await client.getFileContent(project, repo, path, commit));
    } catch (err) {
      return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, files };
}

export function emptyOutcome(step: ReviewStep, batchesTotal: number): PassOutcome {
  return {
    step, status: 'finished', batchesDone: 0, batchesTotal, failedBatches: 0, notes: [],
    added: [], merged: [], removed: [], labelled: [], tokens: { input: 0, output: 0, calls: 0, estimated: false },
  };
}

export function serviceFor(deps: Pick<EngineDeps, 'client' | 'onDiag'>): PrReviewService {
  return new PrReviewService(deps.client, deps.onDiag);
}
