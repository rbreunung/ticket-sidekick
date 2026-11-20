import { describeErrorForLog } from '../reviewDiagnostics';
import { formatFindingsFunnel, formatStructuredRunRecord, type FindingsFunnelCounts } from '../reviewSessionState';
import type { TokenMeter } from '../tokenMeter';
import type { BoardModelHandle } from '../../boards/boardModels';
import type { PassContext } from './plumbing';
import type { EngineSettings, ReviewStep } from './types';

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
  tokenBudget: number;
}): void {
  const { step, model, meter, settings, tokenBudget } = params;
  const resolvedContextTokens = settings.modelContextTokens ?? (model.maxInputTokens || 60000);
  const ratio = settings.contextBudgetRatio ?? 0.7;
  const contextLines = settings.contextLines ?? 'default';
  const configLine =
    `${ctx.runTag} model=${model.vendor ?? 'unknown'}/${model.family ?? 'unknown'} tokenBudget=${tokenBudget} ` +
    `(resolved=${resolvedContextTokens} ratio=${ratio}) passes=${step} critic=${step === 'critic'} contextLines=${contextLines}`;
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
