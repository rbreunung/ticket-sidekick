import type { Applied, ApplyProgress, Planned, Reduced } from '../../sessions/boardKind';
import type { ApplyLineResult, PlanLine, WritePlan } from '../../sessions/sessionTypes';
import type { TicketService } from '../../services/TicketService';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import {
  pickMergeResolution, pickMergeTarget, prepareMergePrompt, resumeMerge, startMergeRun, stopMerge,
  type MergeContext, type MergeProgress, type MergePrompt,
} from '../../imports/merge';
import { buildStaleTargetOptions } from '../../imports/staleClose';
import {
  staleTargetState, type MergeRun, type MergeStep, type MergeStepKind, type ReviewSession, type StaleTargetOption,
} from '../../imports/types';
import type { HandlerPayload, ImportHandler, ImportSession } from './handlers';
import { importKind, type ImportWorking } from './kind';
import { readImport, type ImportData, type ImportDeps, type ImportRow } from './read';

// The import board's handler for the ticket merge and its tab. vscode-free.
//
// The developer selects Already-ticketed rows (or types ticket keys) and names the ticket to keep;
// the preview shows what the chat's confirmation shows, read from Jira first. The run lives in
// `working.ext.merge`, so it survives a restart: the opening Apply runs the steps until one fails
// or the closes need their answers; Retry and Ignore each continue from a failed step; the target
// status and resolution of every issue type are picked first, then one Apply closes all sources.
// The run's writes go through the same engine as the chat (`src/imports/merge.ts`). While the run
// is unfinished every other tab's Apply is refused. Once it ends the tabs take a fresh reading by
// the kind's rule, and Acknowledge closes the merge tab.

const NAME = 'merge';
const NO_RESOLUTION = 'none';
const ROW_ID = /^A\d+$/i;
const BLOCKED = 'A ticket merge is not finished. Finish or stop the merge first.';
const NOT_WAITING_CLOSE = 'The merge is not waiting for its close.';

export type MergeState = 'running' | 'failed' | 'awaiting-close' | 'finished';

/** The target status and resolution picked for one issue type, by option id. */
interface CloseAnswer {
  target?: string;
  resolution?: string;
}

/** What this handler keeps in `working.ext.merge`: the run as the engine left it, the close answers, and whether it ended. */
interface MergeExt {
  run: MergeRun;
  mode: 'rewrite' | 'close';
  answers: Record<string, CloseAnswer>;
  finished?: boolean;
}

type MergePayload = HandlerPayload & (
  | { op: 'start'; survivor: string; sources: string[] }
  | { op: 'retry' | 'ignore' | 'stop' | 'close' }
);

export interface MergeStepView {
  kind: MergeStepKind;
  label: string;
  key: string;
  status: MergeStep['status'];
  note?: string;
  error?: string;
}

export interface MergeCloseGroupView {
  issueType: string;
  tickets: string[];
  targetOptions: Array<{ id: string; label: string }>;
  target: string | null;
  needsResolution: boolean;
  resolutionOptions: Array<{ id: string; label: string }>;
  resolution: string | null;
  /** Why these tickets cannot be closed from the board. */
  note?: string;
}

export interface MergeTabView {
  state: MergeState;
  mode: 'rewrite' | 'close';
  survivor: string;
  sources: string[];
  steps: MergeStepView[];
  /** What the developer can do now. */
  actions: Array<'retry' | 'ignore' | 'stop' | 'close' | 'acknowledge'>;
  /** The step that failed, while the run waits for Retry, Ignore or Stop. */
  failed?: MergeStepView;
  /** While the closes wait: each issue type with its options and answers. */
  question?: {
    groups: MergeCloseGroupView[];
    /** The project's Duplicate resolution, set without asking. */
    resolution?: string;
    /** Issue types that still need a target status or a resolution. */
    unanswered: string[];
  };
  /** Once the run ended: the steps still missing and the closes without their resolution. */
  report?: { missing: MergeStepView[]; closedWithout: MergeStepView[]; workflowHint: boolean };
}

const STEP_LABEL: Record<MergeStepKind, string> = {
  'survivor-rewrite': 'rewrite the kept ticket',
  'survivor-comment': 'comment on the kept ticket',
  link: 'link the tickets',
  'source-rewrite': 'mark the ticket as merged',
  'source-comment': 'comment on the closed ticket',
  close: 'close',
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extOf(working: ImportWorking): MergeExt | undefined {
  const ext = working.ext[NAME] as MergeExt | undefined;
  return ext && typeof ext === 'object' && ext.run ? ext : undefined;
}

function withExt(working: ImportWorking, ext: MergeExt | undefined): ImportWorking {
  const rest = { ...working.ext };
  if (ext) rest[NAME] = ext;
  else delete rest[NAME];
  return { ...working, ext: rest };
}

function stateOf(ext: MergeExt): MergeState {
  if (ext.finished) return 'finished';
  if (ext.run.awaiting === 'decision') return 'failed';
  if (ext.run.awaiting === 'target' || ext.run.awaiting === 'resolution') return 'awaiting-close';
  return 'running';
}

const unfinishedRun = (session: ImportSession) => {
  const ext = extOf(session.working);
  return ext !== undefined && !ext.finished;
};

type AnyDescriptor = ReportImportDescriptor<unknown, ImportRow>;

function descriptorOf(session: ImportSession, deps: ImportDeps): AnyDescriptor {
  return deps.descriptors()[session.recipe.kind] as unknown as AnyDescriptor;
}

/** The engine's review session over the board's reading, with the stored run on it. */
function engineSession(session: ImportSession, run?: MergeRun): ReviewSession<ImportRow> {
  const review = clone(session.derived.data.review);
  return run ? { ...review, mergeRun: clone(run) } : review;
}

const optionId = (o: StaleTargetOption) => (o.kind === 'rule' ? `rule:${o.ruleName}` : `status:${o.status}`);
const optionLabel = (o: StaleTargetOption) => (o.kind === 'rule' ? `${o.ruleName} → ${o.targetState}` : o.status);
const resolutionId = (name: string) => `resolution:${name}`;

const stepOf = (run: MergeRun, kind: MergeStepKind, key: string) => run.steps.find(s => s.kind === kind && s.key === key);

function stepView(step: MergeStep): MergeStepView {
  return {
    kind: step.kind, label: STEP_LABEL[step.kind], key: step.key, status: step.status,
    ...(step.note ? { note: step.note } : {}), ...(step.error ? { error: step.error } : {}),
  };
}

interface CloseGroupState {
  view: MergeCloseGroupView;
  options: StaleTargetOption[];
}

/** The issue types whose closes are still pending, each with the statuses it can reach and the answers given so far. */
function closeGroups(ext: MergeExt): CloseGroupState[] {
  const { run } = ext;
  const needsResolution = !run.duplicateResolution && (run.resolutionOptions?.length ?? 0) > 0;
  const resolutionOptions = needsResolution
    ? [...(run.resolutionOptions ?? []).map(name => ({ id: resolutionId(name), label: name })), { id: NO_RESOLUTION, label: 'No resolution' }]
    : [];
  return (run.closeGroups ?? []).flatMap(group => {
    const pending = group.tickets.filter(t => stepOf(run, 'close', t.key)?.status === 'pending');
    if (pending.length === 0) return [];
    const options = buildStaleTargetOptions(group.rules, group.graph, pending.map(t => t.currentStatus));
    const answer = ext.answers[group.issueType] ?? {};
    const target = options.some(o => optionId(o) === answer.target) ? answer.target! : null;
    const resolution = needsResolution && resolutionOptions.some(o => o.id === answer.resolution) ? answer.resolution! : null;
    return [{
      options,
      view: {
        issueType: group.issueType, tickets: pending.map(t => t.key),
        targetOptions: options.map(o => ({ id: optionId(o), label: optionLabel(o) })), target,
        needsResolution, resolutionOptions, resolution,
        ...(options.length === 0 ? { note: `No status of the discovered ${group.issueType} workflow can be reached, so these tickets stay open.` } : {}),
      },
    }];
  });
}

/** Why the closes cannot be applied yet, or undefined when every issue type has its answers. */
function missingAnswer(groups: CloseGroupState[]): string | undefined {
  for (const { view } of groups) {
    if (view.targetOptions.length === 0) continue;
    if (!view.target) return `Pick the target status for ${view.issueType} first.`;
    if (view.needsResolution && !view.resolution) return `Pick the resolution for ${view.issueType} first.`;
  }
  return undefined;
}

function buildView(ext: MergeExt): MergeTabView {
  const { run } = ext;
  const state = stateOf(ext);
  const steps = run.steps.map(stepView);
  const view: MergeTabView = {
    state, mode: ext.mode, survivor: run.survivor, sources: [...run.sources], steps,
    // A run still 'running' was cut off mid-Apply (VS Code closed): Retry carries on from its first pending step.
    actions: state === 'failed' ? ['retry', 'ignore', 'stop'] : state === 'awaiting-close' ? ['close', 'stop'] : state === 'finished' ? ['acknowledge'] : ['retry', 'stop'],
  };
  if (state === 'failed') {
    const failed = run.steps.find(s => s.status === 'failed');
    if (failed) view.failed = stepView(failed);
  }
  if (state === 'awaiting-close') {
    const groups = closeGroups(ext);
    view.question = {
      groups: groups.map(g => g.view),
      ...(run.duplicateResolution ? { resolution: run.duplicateResolution } : {}),
      unanswered: groups.filter(g => g.view.targetOptions.length > 0 && (!g.view.target || (g.view.needsResolution && !g.view.resolution))).map(g => g.view.issueType),
    };
  }
  if (state === 'finished') {
    view.report = {
      missing: run.steps.filter(s => s.status === 'skipped' || s.status === 'failed').map(stepView),
      closedWithout: run.steps.filter(s => s.kind === 'close' && s.note?.startsWith('closed without')).map(stepView),
      workflowHint: (run.closeSkipped ?? []).some(s => /workflow/i.test(s.reason)),
    };
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// Starting a merge: the selection, the preview built from the engine's read, the opening plan.

interface StartRefs {
  sources: string[];
  keep: string;
}

function startRefsOf(action: Record<string, unknown>): StartRefs | { error: string } {
  const ids = action.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id.trim())) {
    return { error: 'Select the Already-ticketed rows to merge.' };
  }
  const keep = typeof action.keep === 'string' ? action.keep.trim() : '';
  if (!keep) return { error: 'Pick the ticket to keep from the selected rows, or type its ticket key.' };
  const refs = (ids as string[]).map(id => id.trim());
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (ROW_ID.test(keep) && !refs.some(id => same(id, keep))) {
    return { error: 'Pick the ticket to keep from the selected rows, or type its ticket key.' };
  }
  return { sources: refs.filter(id => !same(id, keep)), keep };
}

/** Why no merge can start now, or undefined. */
function startBlocked(session: ImportSession): string | undefined {
  const ext = extOf(session.working);
  if (ext && !ext.finished) return 'A ticket merge is not finished. Finish or stop it first.';
  if (ext?.finished) return 'Acknowledge the finished merge first.';
  if (session.working.outOfDate.includes('ticketed')) return 'The Already ticketed tab is out of date. Refresh it first.';
  return undefined;
}

const ticketText = (t: { summary: string; status: string | null }) => `${t.summary}${t.status ? ` (${t.status})` : ''}`;

/** The merge key a warning is about (the one it starts with), else the kept ticket. */
function warningTarget(warning: string, keys: string[], survivor: string): string {
  return keys.find(k => warning.startsWith(`${k} `)) ?? survivor;
}

function startLines(prompt: Exclude<MergePrompt, { kind: 'refused' | 'read-failed' }>): { lines: PlanLine[]; sources: string[] } {
  const survivor = prompt.survivor.key;
  const lines: PlanLine[] = [{ target: survivor, change: `Kept: ${ticketText(prompt.survivor)}` }];
  if (prompt.kind === 'rewrite') {
    const keys = [survivor, ...prompt.sources.map(s => s.key)];
    for (const s of prompt.sources) lines.push({ target: s.key, change: `Cancelled as a duplicate: ${ticketText(s)}` });
    for (const w of prompt.warnings) lines.push({ target: warningTarget(w, keys, survivor), change: `Warning: ${w}` });
    if (prompt.droppedKeys.length > 0) {
      lines.push({ target: survivor, change: `The rewrite drops these findings the tickets record, because the report does not cover them: ${prompt.droppedKeys.join(', ')}` });
    }
    lines.push({ target: survivor, change: 'Rewrite the title, description and combined labels from the report rows of all these tickets, and comment on what it took over' });
    for (const s of prompt.sources) {
      lines.push({ target: s.key, change: `Link as a duplicate of ${survivor}, mark the title and description as merged (the old text stays), then close it` });
    }
    return { lines, sources: prompt.sources.map(s => s.key) };
  }

  const noun = (n: number) => `${prompt.itemNoun}${n === 1 ? '' : 's'}`;
  const keys = [survivor, ...prompt.sources.map(s => s.ticket.key)];
  const rebuilt = prompt.newItems.length > 0 || prompt.sources.some(s => s.movable.length > 0);
  for (const s of prompt.sources) lines.push({ target: s.ticket.key, change: `Close: ${ticketText(s.ticket)}` });
  for (const w of prompt.warnings) lines.push({ target: warningTarget(w, keys, survivor), change: `Warning: ${w}` });
  for (const s of prompt.sources) {
    const key = s.ticket.key;
    if (s.movable.length > 0) {
      lines.push({ target: survivor, change: `Takes over from ${key}: ${s.movable.join(', ')}. ${survivor} is rebuilt from the report (title, description and labels; text added by hand is replaced)` });
    } else if (rebuilt) {
      lines.push({ target: key, change: `Has no ${noun(2)} ${survivor} lacks` });
    } else {
      lines.push({ target: survivor, change: `Stays as it is: ${key} has no ${noun(2)} ${survivor} lacks` });
    }
    if (s.unlisted.length > 0) {
      lines.push({ target: key, change: `Not moved, no longer in the report (named in the comment on ${key}): ${s.unlisted.join(', ')}` });
    }
    if (s.elsewhere.length > 0) {
      lines.push({ target: key, change: `Not moved, still in the report but outside ${survivor}'s rows (named in the comment on ${key}): ${s.elsewhere.join(', ')}` });
    }
  }
  if (prompt.newItems.length > 0) {
    lines.push({ target: survivor, change: `In the report but on no ticket yet, so the rebuild adds them: ${prompt.newItems.join(', ')}` });
  }
  if (prompt.survivorLost.length > 0) {
    lines.push({ target: survivor, change: `The rebuild stops showing these, which ${survivor} records but the report no longer lists: ${prompt.survivorLost.join(', ')}` });
  }
  if (prompt.survivorElsewhere.length > 0) {
    lines.push({ target: survivor, change: `The rebuild stops showing these, which the report still lists outside ${survivor}'s rows: ${prompt.survivorElsewhere.join(', ')}` });
  }
  for (const s of prompt.sources) lines.push({ target: s.ticket.key, change: `Link to ${survivor}, comment on the merge, then close it` });
  return { lines, sources: prompt.sources.map(s => s.ticket.key) };
}

function prepareMerge(session: ImportSession, action: { type: string } & Record<string, unknown>, deps: ImportDeps): Promise<MergePrompt> | undefined {
  if (action.type !== 'merge-start' || startBlocked(session)) return undefined;
  const refs = startRefsOf(action);
  if ('error' in refs) return undefined;
  return (async () => {
    const { ticketService } = await deps.writeAccess();
    return prepareMergePrompt(engineSession(session), refs.sources, refs.keep, ticketService, descriptorOf(session, deps), deps.onDiag);
  })();
}

function planStart(session: ImportSession, action: Record<string, unknown>, prepared: unknown): Planned {
  const blocked = startBlocked(session);
  if (blocked) return { ok: false, reason: blocked };
  const refs = startRefsOf(action);
  if ('error' in refs) return { ok: false, reason: refs.error };
  const prompt = prepared as MergePrompt | undefined;
  if (!prompt) return { ok: false, reason: 'The tickets to merge could not be read. Try again.' };
  if (prompt.kind === 'refused') return { ok: false, reason: prompt.reason };
  if (prompt.kind === 'read-failed') return { ok: false, reason: `Could not read all the tickets, so nothing was written: ${prompt.error}` };
  const { lines, sources } = startLines(prompt);
  const survivor = prompt.survivor.key;
  const payload: MergePayload = { handler: NAME, op: 'start', survivor, sources };
  // A merge writes the kept ticket and every source and closes the sources.
  const plan: WritePlan<MergePayload> = {
    title: `Merge ${sources.length} ${sources.length === 1 ? 'ticket' : 'tickets'} into ${survivor}`,
    lines, risky: true, payload,
  };
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------------------------
// The continuations: Retry, Ignore, Stop and the closing step.

function planContinue(session: ImportSession, op: 'retry' | 'ignore' | 'stop' | 'close'): Planned {
  const ext = extOf(session.working);
  if (!ext || ext.finished) return { ok: false, reason: 'No ticket merge is running.' };
  const { run } = ext;
  const state = stateOf(ext);
  const payload: MergePayload = { handler: NAME, op };

  if (op === 'retry' || op === 'ignore') {
    const interrupted = op === 'retry' && state === 'running';
    if (state !== 'failed' && !interrupted) return { ok: false, reason: 'No step of the merge has failed.' };
    const failed = run.steps.filter(s => s.status === 'failed');
    const lines: PlanLine[] = failed.map(s => ({
      target: s.key,
      change: op === 'retry' ? `Run again: ${STEP_LABEL[s.kind]}` : `Skip: ${STEP_LABEL[s.kind]}, and carry on with the rest`,
    }));
    if (interrupted) lines.push({ target: run.survivor, change: 'Carry on with the merge where it was cut off' });
    for (const s of run.steps.filter(x => x.status === 'pending' && x.kind !== 'close')) lines.push({ target: s.key, change: `Then: ${STEP_LABEL[s.kind]}` });
    if (run.steps.some(s => s.status === 'pending' && s.kind === 'close') || failed.some(s => s.kind === 'close')) {
      lines.push({ target: run.survivor, change: 'Then the merge asks where to move the tickets it closes' });
    }
    const title = interrupted ? 'Carry on with the merge' : op === 'retry' ? 'Retry the failed merge step' : 'Skip the failed merge step';
    return { ok: true, plan: { title, lines, risky: false, payload } };
  }

  if (op === 'stop') {
    if (state === 'finished') return { ok: false, reason: 'The merge is not waiting.' };
    const lines: PlanLine[] = [{ target: run.survivor, change: 'Stop the merge here. The steps already done stay as they are' }];
    for (const s of run.steps.filter(x => x.status === 'pending' || x.status === 'failed')) lines.push({ target: s.key, change: `Not done: ${STEP_LABEL[s.kind]}` });
    return { ok: true, plan: { title: 'Stop the merge', lines, risky: false, payload } };
  }

  if (state !== 'awaiting-close') return { ok: false, reason: NOT_WAITING_CLOSE };
  const groups = closeGroups(ext);
  const missing = missingAnswer(groups);
  if (missing) return { ok: false, reason: missing };
  const lines: PlanLine[] = [];
  for (const { view, options } of groups) {
    if (options.length === 0) {
      for (const key of view.tickets) lines.push({ target: key, change: `Stays open: ${view.note}` });
      continue;
    }
    const state = staleTargetState(options.find(o => optionId(o) === view.target)!);
    const resolution = run.duplicateResolution
      ?? (view.resolution && view.resolution !== NO_RESOLUTION ? view.resolution.slice(resolutionId('').length) : undefined);
    for (const key of view.tickets) {
      lines.push({ target: key, change: `Close as ${state}${resolution ? ` with resolution ${resolution}` : ' without a resolution'}` });
    }
  }
  const count = lines.filter(l => l.change.startsWith('Close')).length;
  return { ok: true, plan: { title: `Close ${count} merged ${count === 1 ? 'ticket' : 'tickets'}`, lines, risky: true, payload } };
}

// ---------------------------------------------------------------------------------------------
// Applying: the engine runs the steps; each finished step is saved before the next one writes.

/** Keeps `working` in step with the run: records the tickets each finished step wrote and reports the progress. */
class RunTracker {
  private seen: string[];

  constructor(
    public working: ImportWorking,
    private ext: MergeExt,
    private readonly before: MergeRun,
    private readonly deps: ImportDeps,
    private readonly progress?: ApplyProgress<ImportWorking>,
  ) {
    this.seen = before.steps.map(s => s.status);
  }

  /** Whether a ticket's write settles its Already-ticketed rows, as the chat marks them at the end of a run. */
  private settles(run: MergeRun, key: string): boolean {
    if (key === run.survivor) return stepOf(run, 'survivor-rewrite', key)?.status === 'done';
    return stepOf(run, this.ext.mode === 'close' ? 'close' : 'source-rewrite', key)?.status === 'done';
  }

  async sync(run: MergeRun | undefined, patch: Partial<MergeExt> = {}): Promise<void> {
    if (!run) return;
    // A run just started: its steps were all pending before this Apply.
    if (this.seen.length === 0) this.seen = run.steps.map(() => 'pending');
    const now = run.steps.map(s => s.status);
    const changed = now.length !== this.seen.length || now.some((s, i) => s !== this.seen[i]);
    if (!changed && Object.keys(patch).length === 0 && JSON.stringify(run) === JSON.stringify(this.ext.run)) return;
    const written = new Set<string>();
    run.steps.forEach((step, i) => {
      if (step.status !== 'done' || this.seen[i] === 'done' || step.note?.startsWith('already')) return;
      written.add(step.key);
      if (step.kind === 'link') written.add(run.survivor);
    });
    let tickets = this.working.writes.tickets;
    if (written.size > 0) {
      let times: Record<string, string> = {};
      try {
        times = await this.deps.updatedTimes([...written]);
      } catch (err) {
        this.deps.onDiag?.('warn', 'Import board: the update time after a merge step could not be read', { keys: [...written], error: messageOf(err) });
      }
      tickets = { ...tickets };
      for (const key of written) {
        tickets[key] = { ...(times[key] !== undefined ? { updated: times[key] } : {}), ...(this.settles(run, key) ? {} : { commentOnly: true }) };
      }
    }
    this.seen = now;
    this.ext = { ...this.ext, ...patch, run: clone(run) };
    this.working = withExt({ ...this.working, writes: { ...this.working.writes, tickets } }, this.ext);
    if (changed) {
      const done = run.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
      await this.progress?.({ working: this.working, done, total: run.steps.length });
    }
  }

  /** One result line per step this Apply moved on. */
  results(run: MergeRun): ApplyLineResult[] {
    return run.steps.flatMap((step, i): ApplyLineResult[] => {
      const was = this.before.steps[i]?.status;
      if (step.status === was || step.status === 'pending') return [];
      const reason = `${STEP_LABEL[step.kind]}${step.note ? ` (${step.note})` : ''}${step.error ? `: ${step.error}` : ''}`;
      return [{ target: step.key, outcome: step.status === 'done' ? 'done' : step.status === 'failed' ? 'failed' : 'refused', reason }];
    });
  }
}

/** The ticket service the engine writes through, saving the run's finished steps before each next call. */
function checkpointed(ticketService: TicketService, checkpoint: () => Promise<void>): TicketService {
  return new Proxy(ticketService, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await checkpoint();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function applyMerge(
  session: ImportSession, plan: WritePlan, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>,
): Promise<Applied<ImportData, ImportWorking>> {
  const payload = plan.payload as MergePayload;
  const unchanged = (outcome: 'refused' | 'failed', reason: string): Applied<ImportData, ImportWorking> => ({
    results: [{ target: plan.lines[0]?.target ?? 'merge', outcome, reason }], derived: session.derived, working: session.working,
  });
  const stored = extOf(session.working);
  if (payload.op === 'start' ? stored !== undefined : !stored || stored.finished) {
    return unchanged('refused', payload.op === 'start' ? 'Another ticket merge is on this board.' : 'No ticket merge is running.');
  }

  const descriptor = descriptorOf(session, deps);
  const { ticketService } = await deps.writeAccess();
  const ctx: MergeContext = { workspaceRoot: deps.workspaceRoot() ?? '', baseUrl: await deps.baseUrl(), onDiag: deps.onDiag };
  const engine = engineSession(session, stored?.run);
  const ext: MergeExt = stored ?? {
    run: { survivor: (payload as { survivor: string }).survivor, sources: (payload as { sources: string[] }).sources, steps: [] },
    mode: descriptor.ticketMerge?.mode === 'close' ? 'close' : 'rewrite',
    answers: {},
  };
  const tracker = new RunTracker(session.working, ext, clone(ext.run), deps, progress);
  const service = checkpointed(ticketService, () => tracker.sync(engine.mergeRun));

  let result: MergeProgress;
  const extra: ApplyLineResult[] = [];
  switch (payload.op) {
    case 'start': {
      const started = await startMergeRun(engine, payload.sources, payload.survivor, service, descriptor, ctx);
      if (started.kind === 'refused') return unchanged('refused', started.reason);
      if (started.kind === 'read-failed') return unchanged('failed', `Could not read all the tickets, so nothing was written: ${started.error}`);
      result = started.progress;
      break;
    }
    case 'retry':
    case 'ignore':
      if (stateOf(ext) !== 'failed' && !(payload.op === 'retry' && stateOf(ext) === 'running')) return unchanged('refused', 'No step of the merge has failed.');
      result = await resumeMerge(engine, payload.op, service, descriptor, ctx);
      break;
    case 'stop':
      result = stopMerge(engine, descriptor, deps.onDiag);
      break;
    case 'close': {
      if (stateOf(ext) !== 'awaiting-close') return unchanged('refused', NOT_WAITING_CLOSE);
      const missing = missingAnswer(closeGroups(ext));
      if (missing) return unchanged('refused', missing);
      result = { turn: 'waiting' };
      // The engine asks one issue type at a time; it gets the stored answers in its order.
      for (let asked = 0; asked < 2 * (ext.run.closeGroups?.length ?? 0) + 2; asked++) {
        const run = engine.mergeRun;
        if (!run) break;
        const answer = ext.answers[run.closeIssueType ?? ''] ?? {};
        if (run.awaiting === 'target') {
          const option = (run.closeTargetOptions ?? []).find(o => optionId(o) === answer.target);
          if (!option) {
            extra.push({ target: run.closeIssueType ?? run.survivor, outcome: 'refused', reason: 'the picked target status is no longer offered; pick it again' });
            break;
          }
          result = await pickMergeTarget(engine, option, service, descriptor, ctx);
        } else if (run.awaiting === 'resolution') {
          const name = answer.resolution === NO_RESOLUTION ? null
            : (run.resolutionOptions ?? []).find(r => resolutionId(r) === answer.resolution);
          if (name === undefined) {
            extra.push({ target: run.closeIssueType ?? run.survivor, outcome: 'refused', reason: 'the picked resolution is no longer offered; pick it again' });
            break;
          }
          result = await pickMergeResolution(engine, name, service, descriptor, ctx);
        } else {
          break;
        }
        if (result.turn === 'finished') break;
      }
      break;
    }
  }

  const finalRun = result.turn === 'finished' ? result.report.run : engine.mergeRun;
  await tracker.sync(finalRun, result.turn === 'finished' ? { finished: true } : {});
  const results = [...(finalRun ? tracker.results(finalRun) : []), ...extra];
  if (result.turn === 'waiting') return { results, derived: session.derived, working: tracker.working };

  // The run ended: every tab follows the kind's rule against a fresh reading.
  const ended: ImportSession = { ...session, working: tracker.working };
  try {
    const fresh = await readImport(session.recipe, deps);
    const merged = importKind.reconcile(ended, fresh, 'background');
    return { results, derived: merged.derived, working: merged.working };
  } catch (err) {
    deps.onDiag?.('warn', 'Import board: the import could not be read again after the ticket merge', { error: messageOf(err) });
    return { results, derived: session.derived, working: tracker.working };
  }
}

// ---------------------------------------------------------------------------------------------
// The close answers and Acknowledge.

function reduceMerge(session: ImportSession, action: { type: string } & Record<string, unknown>): Reduced<ImportWorking> | undefined {
  if (!['merge-close-target', 'merge-close-resolution', 'merge-acknowledge'].includes(action.type)) return undefined;
  const ext = extOf(session.working);
  if (action.type === 'merge-acknowledge') {
    if (!ext || !ext.finished) return { ok: false, reason: 'The merge is not finished yet.' };
    return { ok: true, working: withExt(session.working, undefined) };
  }
  if (!ext || stateOf(ext) !== 'awaiting-close') return { ok: false, reason: NOT_WAITING_CLOSE };
  const group = closeGroups(ext).find(g => g.view.issueType === action.issueType);
  if (!group) return { ok: false, reason: 'No ticket of that issue type is waiting to be closed.' };
  const issueType = group.view.issueType;
  const answer = { ...(ext.answers[issueType] ?? {}) };
  if (action.type === 'merge-close-target') {
    if (!group.view.targetOptions.some(o => o.id === action.option)) return { ok: false, reason: 'Pick one of the offered statuses.' };
    answer.target = action.option as string;
  } else {
    if (!group.view.needsResolution) return { ok: false, reason: 'This merge sets the resolution itself.' };
    if (!group.view.resolutionOptions.some(o => o.id === action.resolution)) return { ok: false, reason: 'Pick one of the offered resolutions.' };
    answer.resolution = action.resolution as string;
  }
  return { ok: true, working: withExt(session.working, { ...ext, answers: { ...ext.answers, [issueType]: answer } }) };
}

const PLAN_OPS: Record<string, 'retry' | 'ignore' | 'stop' | 'close'> = {
  'merge-retry': 'retry', 'merge-ignore': 'ignore', 'merge-stop': 'stop', 'merge-close': 'close',
};

export const mergeTabHandler: ImportHandler = {
  name: NAME,
  reduce: reduceMerge,
  prepare: prepareMerge,
  plan: (session, action, prepared) => {
    if (action.type === 'merge-start') return planStart(session, action, prepared);
    const op = PLAN_OPS[action.type];
    return op ? planContinue(session, op) : undefined;
  },
  apply: applyMerge,
  blocksPlans: session => (unfinishedRun(session) ? BLOCKED : undefined),
  // While the run is unfinished, a changed Already ticketed tab keeps the reading the merge started from.
  unfinished: (session, tab) => tab === 'ticketed' && unfinishedRun(session),
  // The merge is work until its report is acknowledged.
  hasWork: (session, tab) => tab === 'ticketed' && extOf(session.working) !== undefined,
  view: session => {
    const ext = extOf(session.working);
    return ext ? buildView(ext) : undefined;
  },
};
