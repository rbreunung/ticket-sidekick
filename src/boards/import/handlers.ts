import type { Applied, ApplyProgress, ExportedFile, Planned, Reduced } from '../../sessions/boardKind';
import type { Session, WritePlan } from '../../sessions/sessionTypes';
import type { ImportData, ImportDeps, ImportTab } from './read';
import type { ImportRecipe } from './recipe';
import type { ImportWorking } from './kind';

// The import board's actions live in one module per area (New, Already ticketed, Stale, Accepted,
// ticket merge, search and export). The kind passes every action, write plan, export and view to
// these handlers, so each area keeps its rules in its own file. vscode-free.

export type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

/** A write plan built by a handler: its payload names the handler that applies it. */
export interface HandlerPayload {
  handler: string;
}

export interface ImportHandler {
  /** Unique name, also the `handler` field of the payloads this handler's plans carry. */
  name: string;
  /** A non-writing action; undefined when the action is not this handler's. */
  reduce?(session: ImportSession, action: { type: string } & Record<string, unknown>): Reduced<ImportWorking> | undefined;
  /** What a writing action of this handler reads before its plan (for example the target ticket of an add); undefined when it reads nothing. */
  prepare?(session: ImportSession, action: { type: string } & Record<string, unknown>, deps: ImportDeps): Promise<unknown> | undefined;
  /** A writing action's plan, given what this handler's `prepare` read; undefined when the action is not this handler's. */
  plan?(session: ImportSession, action: { type: string } & Record<string, unknown>, prepared?: unknown): Planned | undefined;
  /** Carries out a plan this handler built. */
  apply?(session: ImportSession, plan: WritePlan, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>): Promise<Applied<ImportData, ImportWorking>>;
  /** A file saved from the board. */
  exportFile?(session: ImportSession, format: string, deps: ImportDeps): Promise<ExportedFile> | undefined;
  /** Why no other handler's plan may be built now (for example while a ticket merge runs); undefined when nothing blocks. */
  blocksPlans?(session: ImportSession): string | undefined;
  /** Whether this handler holds unfinished choices on a tab, so a changed tab is marked instead of refreshed. */
  unfinished?(session: ImportSession, tab: ImportTab): boolean;
  /** Whether this handler still has work on a tab, for the tab's work mark and the finished state. */
  hasWork?(session: ImportSession, tab: ImportTab): boolean;
  /** Fields this handler adds to the view, under `view.ext[name]`. */
  view?(session: ImportSession, tab: ImportTab): unknown;
}

/** The plan payload's handler name, or undefined for a plan no handler built. */
export function handlerOf(plan: WritePlan): string | undefined {
  const payload = plan.payload as Partial<HandlerPayload> | null | undefined;
  return payload && typeof payload.handler === 'string' ? payload.handler : undefined;
}
