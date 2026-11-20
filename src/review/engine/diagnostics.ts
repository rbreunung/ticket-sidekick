import { describeErrorForLog } from '../reviewDiagnostics';
import { buildRunTag, formatFindingsFunnel, formatStructuredRunRecord, type FindingsFunnelCounts } from '../reviewSessionState';
import type { TokenMeter } from '../tokenMeter';
import type { BoardModelHandle } from '../../boards/boardModels';
import { isStop, passContext, tokenBudgetOf, type PassContext, type TokenBudget } from './plumbing';
import type { EngineDeps, EngineSettings, ReviewStep, ReviewTarget } from './types';

// The opening, closing and abort lines of a pass's diagnostic timeline in the output channel, and
// the structured run record written when detailed diagnostics are on. The per-call, retry, split and
// truncation lines are logged where the calls are made. vscode-free.

/**
 * Logs the configuration a pass runs with (the model, the token budget and how it was worked out,
 * the pass, whether it is the critic, the context lines) and the model in use, with whether the
 * token meter is attached and whether the host froze the model.
 */
export function logPassOpening(ctx: PassContext, params: {
  step: ReviewStep | 'requirements';
  model: BoardModelHandle;
  meter: TokenMeter<BoardModelHandle>;
  settings: EngineSettings;
  budget: TokenBudget;
}): void {
  const { step, model, meter, settings, budget } = params;
  const contextLines = settings.contextLines ?? 'default';
  const configLine =
    `${ctx.runTag} model=${model.vendor ?? 'unknown'}/${model.family ?? 'unknown'} tokenBudget=${budget.tokens} ` +
    `(resolved=${budget.contextTokens} ratio=${budget.ratio}) passes=${step} critic=${step === 'critic'} contextLines=${contextLines}`;
  ctx.configLine = configLine;
  ctx.log('info', configLine);
  ctx.log('info', 'model in use', {
    vendor: model.vendor, family: model.family, id: model.id, version: model.version, maxInputTokens: model.maxInputTokens,
    metering: meter.metered ? 'on' : 'off', frozen: model.frozen ?? false,
  });
}

/** Logs where the pass's findings went; returns the text for the run record. */
export function logFindingsFunnel(ctx: PassContext, counts: FindingsFunnelCounts): string {
  const funnel = formatFindingsFunnel(counts);
  ctx.log('info', funnel);
  return funnel;
}

/**
 * Writes the structured run record, one short line at a time (the channel cuts a long message), when
 * detailed diagnostics are on; does nothing otherwise.
 */
export function writeRunRecord(ctx: PassContext, funnel: string): void {
  if (!ctx.recorded) return;
  const configLine = ctx.configLine ?? '';
  const record = formatStructuredRunRecord({
    runTag: ctx.runTag, configLine, lines: ctx.recorded.filter((line) => line !== configLine), funnel,
  });
  ctx.recorded = undefined;
  for (const line of record.split('\n')) ctx.log('info', line);
}

/** The line logged when a pass ends with an error it did not expect, naming the last stage reached. */
export function logAborted(ctx: PassContext, err: unknown): void {
  ctx.log('error', `Review aborted — [${ctx.runTag}] last stage: ${ctx.stage}`, {
    runTag: ctx.runTag, lastStage: ctx.stage, error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err),
  });
}

type PassDeps = Pick<EngineDeps, 'model' | 'recordTokens' | 'signal' | 'onDiag' | 'sleep'>;

/** Starts a pass over `target`: its context, its token budget, and its opening lines. */
export function openPass(
  deps: PassDeps, settings: EngineSettings, target: ReviewTarget, step: ReviewStep | 'requirements',
): { ctx: PassContext; tokenBudget: number } {
  const ctx = passContext(deps, { runTag: buildRunTag(target.project, target.repo, target.prId), detailedDiagnostics: settings.detailedDiagnostics });
  const budget = tokenBudgetOf(settings, deps.model);
  logPassOpening(ctx, { step, model: deps.model, meter: ctx.meter, settings, budget });
  return { ctx, tokenBudget: budget.tokens };
}

/** Runs a pass after its opening lines; an error that is not a stop gets the abort line before it is rethrown. */
export async function runPass<T>(
  deps: PassDeps, settings: EngineSettings, target: ReviewTarget, step: ReviewStep,
  body: (ctx: PassContext, tokenBudget: number) => Promise<T>,
): Promise<T> {
  const { ctx, tokenBudget } = openPass(deps, settings, target, step);
  try {
    return await body(ctx, tokenBudget);
  } catch (err) {
    if (!isStop(err, deps.signal)) logAborted(ctx, err);
    throw err;
  }
}
