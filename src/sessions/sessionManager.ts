import { randomBytes } from 'crypto';
import type { DiagLogger } from '../utils/diagTypes';
import { capitalised } from '../utils/textCase';
import type { ApplyProgressReport, CheckMode, ExportedFile, RegisteredKind, RunFinished, RunProgressReport, WorkingUpdate } from './boardKind';
import { sessionIdFor } from './sessionId';
import type { SessionStore } from './sessionStore';
import { SessionError, type ApplyLineResult, type Conflict, type DerivedPart, type PlanLine, type RunningState, type Session, type SessionSummary, type WritePlan } from './sessionTypes';

// Owns every session of this window: opens or restores it, runs its actions one after another,
// checks it against the sources, and guards its writes. A write needs a plan id that only a
// preview issues, and a risky plan needs the native confirmation as well, so a request that
// carries only the canvas key cannot change several tickets, close one or post to Bitbucket.
// A model run (a review pass, one explanation) is started from a board request and does its work
// outside the queue; each step it reports and its end are merged into the working state as it is
// then, inside the queue, so nothing changed meanwhile is overwritten. Stop skips the queue.

export type BoardStatus = 'building' | 'ready' | 'checking' | 'failed';

/** What a page gets for its session. */
export interface BoardState {
  id: string;
  kind: string;
  title: string;
  status: BoardStatus;
  /** Raised on every change of this state, also a status change; the page waits on it. */
  tick: number;
  /** The session revision an action must be based on. */
  revision: number;
  /** When the data shown was read from its sources. */
  asOf?: number;
  /** Shown from the cache, as opposed to built now. */
  restored: boolean;
  /** False when the session is too large to store and will not survive a restart. */
  stored: boolean;
  conflicts: Conflict[];
  notice?: string;
  error?: string;
  /** What kind of failure `error` is, when the board kind names it (e.g. `report-not-found`), so the page can offer the way out. */
  errorCode?: string;
  /** The last check against the sources failed on a board that writes: nothing is applied until one passes. */
  writesBlocked: boolean;
  /** Set while an Apply runs: how many of its targets are finished. The page disables its controls meanwhile. */
  applying?: { done: number; total: number };
  /** The model runs going on this board. A pass locks every other control; a call only its own. */
  running?: RunningState[];
  /** What the board keeps outside its sessions (its kind's `preferences`); absent for a board that keeps none. */
  preferences?: Record<string, boolean>;
  view?: unknown;
}

export interface PlanPreview {
  planId: string;
  title: string;
  lines: PlanLine[];
  risky: boolean;
}

export type OpenResult = { ok: true; id: string; title: string } | { ok: false; reason: string };

export interface SessionManagerDeps {
  store: SessionStore;
  kinds: RegisteredKind[];
  now(): number;
  /** The native confirmation for a risky plan; resolves false when the developer declines. */
  confirm(plan: { title: string; lines: PlanLine[] }): Promise<boolean>;
  /** Writes a file where the developer chooses in the save dialog; false when the dialog was cancelled. */
  saveFile(file: ExportedFile): Promise<boolean>;
  onDiag?: DiagLogger;
  /** How long a previewed plan can be applied. */
  planTtlMs?: number;
}

const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const DROP_CONFLICT = 'conflict/drop';
const REBUILT_NOTICE = 'This board was rebuilt after an update: the stored session came from another version of Ticket Sidekick, and its earlier choices were not kept.';

interface Entry {
  id: string;
  reg: RegisteredKind;
  recipe: unknown;
  session?: Session;
  status: BoardStatus;
  tick: number;
  restored: boolean;
  stored: boolean;
  notice?: string;
  error?: string;
  errorCode?: string;
  applying?: { done: number; total: number };
  /** The kind's preferences as last read; loaded with the first state and after each change. */
  preferences?: Record<string, boolean>;
  /** The runs going on, by name. */
  runs: Map<string, ActiveRun>;
  queue: Promise<unknown>;
  waiters: Set<() => void>;
}

interface ActiveRun {
  state: RunningState;
  controller: AbortController;
}

interface PendingPlan {
  sessionId: string;
  revision: number;
  plan: WritePlan;
  expires: number;
}

/** Whether a check found what the session already shows: the same data, fingerprints and working state. */
function unchanged(session: Session<unknown, unknown, unknown>, merged: { derived: DerivedPart<unknown>; working: unknown }): boolean {
  // The same object is the same state; only a rebuilt one is compared as JSON.
  const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
  return same(merged.derived.data, session.derived.data)
    && JSON.stringify(merged.derived.fingerprints) === JSON.stringify(session.derived.fingerprints)
    && same(merged.working, session.working);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The failure's name when a board kind gives its error one (`boardErrorCode`). */
function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { boardErrorCode?: unknown } | null)?.boardErrorCode;
  return typeof code === 'string' ? code : undefined;
}

export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly plans = new Map<string, PendingPlan>();
  private readonly kinds = new Map<string, RegisteredKind>();

  constructor(private readonly deps: SessionManagerDeps) {
    for (const reg of deps.kinds) this.kinds.set(reg.kind.kind, reg);
  }

  private kind(name: string): RegisteredKind {
    const reg = this.kinds.get(name);
    if (!reg) throw new SessionError(404, 'Unknown board.');
    return reg;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    this.deps.onDiag?.(level, message, details);
  }

  private changed(entry: Entry): void {
    entry.tick++;
    const waiters = [...entry.waiters];
    entry.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Runs `work` after everything already queued for this session, so actions never interleave. */
  private enqueue<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(work, work);
    entry.queue = next.catch(() => undefined);
    return next;
  }

  private async persist(entry: Entry): Promise<void> {
    if (!entry.session) return;
    try {
      entry.stored = await this.deps.store.save(entry.session);
    } catch (err) {
      entry.stored = false;
      this.log('warn', 'Could not store a session', { kind: entry.session.kind, error: messageOf(err) });
    }
  }

  /** A new entry that builds its session from `recipe`. */
  private building(id: string, reg: RegisteredKind, recipe: unknown, notice?: string): Entry {
    const entry: Entry = {
      id, reg, recipe, status: 'building', tick: 1, restored: false, stored: false,
      runs: new Map(), queue: Promise.resolve(), waiters: new Set(), notice,
    };
    this.entries.set(id, entry);
    void this.enqueue(entry, () => this.build(entry));
    return entry;
  }

  /** A stored session of another format: rebuilt from its recipe when that still holds, else discarded. */
  private async rebuild(reg: RegisteredKind, id: string, recipe: unknown): Promise<Entry | undefined> {
    const { kind } = reg;
    let checked: { ok: true; recipe: unknown } | { ok: false; reason: string } = { ok: false, reason: 'the board cannot rebuild a stored session' };
    if (kind.revalidate) {
      try {
        checked = await kind.revalidate(recipe, await reg.deps());
      } catch (err) {
        checked = { ok: false, reason: messageOf(err) };
      }
    }
    if (!checked.ok) {
      await this.deps.store.delete(id);
      this.log('info', 'Discarded a stored session of another format', { kind: kind.kind, reason: checked.reason });
      return undefined;
    }
    // Another caller may have rebuilt it while this one checked the recipe.
    const raced = this.entries.get(id);
    if (raced) return raced;
    this.log('info', 'Rebuilt a stored session of another format', { kind: kind.kind });
    return this.building(id, reg, checked.recipe, REBUILT_NOTICE);
  }

  /** Finds the session in memory or in the cache; a cached one of another format is rebuilt or discarded. */
  private async find(reg: RegisteredKind, id: string): Promise<Entry | undefined> {
    const known = this.entries.get(id);
    if (known) return known.reg === reg ? known : undefined;
    const stored = await this.deps.store.load(id);
    if (!stored || stored.session.kind !== reg.kind.kind) return undefined;
    if (stored.session.formatVersion !== reg.kind.formatVersion) return this.rebuild(reg, id, stored.session.recipe);
    // Another caller may have loaded it while this one waited for the file.
    const raced = this.entries.get(id);
    if (raced) return raced;
    const entry: Entry = {
      id, reg, recipe: stored.session.recipe, session: this.withoutRun(reg, stored.session), status: 'ready', tick: 1,
      restored: true, stored: true, runs: new Map(), queue: Promise.resolve(), waiters: new Set(),
    };
    this.entries.set(id, entry);
    void this.enqueue(entry, () => this.check(entry));
    return entry;
  }

  /** A stored session read from the cache: a run it still records was cut off by a restart. */
  private withoutRun(reg: RegisteredKind, session: Session): Session {
    const { interrupted } = reg.kind;
    return interrupted ? { ...session, working: interrupted(session.working) } : session;
  }

  private async build(entry: Entry): Promise<void> {
    const { kind } = entry.reg;
    try {
      const derived = await kind.read(entry.recipe, await entry.reg.deps());
      const now = this.deps.now();
      entry.session = {
        id: entry.id, kind: kind.kind, formatVersion: kind.formatVersion, revision: 1,
        createdAt: now, lastUsedAt: now, recipe: entry.recipe, derived,
        working: kind.initialWorking(entry.recipe), conflicts: [],
      };
      // Stored before the board shows as ready, so "ready" always means "survives a restart".
      await this.persist(entry);
      entry.status = 'ready';
      entry.error = undefined;
      entry.errorCode = undefined;
    } catch (err) {
      entry.status = 'failed';
      entry.error = messageOf(err);
      entry.errorCode = errorCodeOf(err);
    }
    this.changed(entry);
  }

  /** Reads the sources again and lays the working state over the fresh reading. */
  private async check(entry: Entry, mode: CheckMode = 'background'): Promise<void> {
    const session = entry.session;
    if (!session) return this.build(entry);
    entry.status = 'checking';
    entry.error = undefined;
    entry.errorCode = undefined;
    this.changed(entry);
    try {
      const { kind } = entry.reg;
      const fresh = await kind.read(session.recipe, await entry.reg.deps());
      const merged = kind.reconcile(session, fresh, mode);
      if (merged.conflicts.length === 0 && unchanged(session, merged)) {
        // Nothing changed: only the read time moves, and the revision stays, so an open preview stays valid.
        entry.session = { ...session, derived: { ...session.derived, readAt: merged.derived.readAt }, lastUsedAt: this.deps.now() };
      } else {
        // A conflict stays until the developer resolves or drops it; a later check must not erase it.
        const fresher = new Set(merged.conflicts.map(c => c.id));
        entry.session = {
          ...session, derived: merged.derived, working: merged.working,
          conflicts: [...session.conflicts.filter(c => !fresher.has(c.id)), ...merged.conflicts],
          revision: session.revision + 1, lastUsedAt: this.deps.now(),
        };
      }
      await this.persist(entry);
    } catch (err) {
      // The stored state stays on show; the board says the check failed.
      entry.error = messageOf(err);
      entry.errorCode = errorCodeOf(err);
    }
    entry.status = 'ready';
    this.changed(entry);
  }

  /** Validates an open request and returns the session it belongs to, creating or restoring it. */
  async open(kindName: string, input: unknown): Promise<OpenResult> {
    const reg = this.kinds.get(kindName);
    if (!reg) return { ok: false, reason: 'Unknown board.' };
    const validated = await reg.kind.validate(input, await reg.deps());
    if (!validated.ok) return validated;
    const id = sessionIdFor(reg.kind.kind, reg.kind.sourceKey(validated.recipe));
    const title = reg.kind.title(validated.recipe);
    const formatBefore = this.entries.has(id) ? undefined : (await this.deps.store.load(id))?.session.formatVersion;
    const otherFormat = formatBefore !== undefined && formatBefore !== reg.kind.formatVersion;
    // A stored session of another format is rebuilt from this request, which is what the board is opened with now.
    if (otherFormat) await this.deps.store.delete(id);
    const existing = await this.find(reg, id);
    if (existing) {
      const { reopen } = reg.kind;
      if (reopen && existing.session) {
        // The same source asked for again: what the new request adds is laid over the session.
        await this.enqueue(existing, async () => {
          const session = existing.session;
          if (!session) return;
          const working = reopen(session, validated.recipe);
          if (working === session.working) return;
          existing.session = { ...session, working, revision: session.revision + 1, lastUsedAt: this.deps.now() };
          await this.persist(existing);
          this.changed(existing);
        });
      }
      return { ok: true, id, title };
    }
    if (otherFormat) this.log('info', 'Rebuilt a stored session of another format', { kind: reg.kind.kind });
    this.building(id, reg, validated.recipe, otherFormat ? REBUILT_NOTICE : undefined);
    return { ok: true, id, title };
  }

  private async entry(kindName: string, id: string): Promise<Entry> {
    const entry = await this.find(this.kind(kindName), id);
    if (!entry) throw new SessionError(404, 'This session no longer exists. Ask for the board again.');
    return entry;
  }

  private toState(entry: Entry): BoardState {
    const { kind } = entry.reg;
    const session = entry.session;
    return {
      id: entry.id, kind: kind.kind, title: kind.title(entry.recipe), status: entry.status, tick: entry.tick,
      revision: session?.revision ?? 0, asOf: session?.derived.readAt, restored: entry.restored, stored: entry.stored,
      conflicts: session?.conflicts ?? [], notice: entry.notice, error: entry.error,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
      writesBlocked: this.writesBlocked(entry),
      ...(entry.applying ? { applying: { ...entry.applying } } : {}),
      ...(entry.runs.size > 0 ? { running: [...entry.runs.values()].map(r => ({ ...r.state })) } : {}),
      ...(entry.preferences ? { preferences: { ...entry.preferences } } : {}),
      view: session ? kind.view(session) : undefined,
    };
  }

  /** Reads what the kind keeps outside its sessions the first time the board's state is asked for. */
  private async loadPreferences(entry: Entry): Promise<void> {
    const { kind } = entry.reg;
    if (!kind.preferences || entry.preferences) return;
    try {
      entry.preferences = await kind.preferences.read(await entry.reg.deps());
    } catch (err) {
      this.log('warn', 'Could not read what the board keeps outside its sessions', { kind: kind.kind, error: messageOf(err) });
    }
  }

  /**
   * Changes one thing the board keeps outside its sessions. It is not part of the session, so the
   * revision stays and no preview is needed; the kind refuses a name or value it does not take.
   */
  async preference(kindName: string, id: string, name: string, value: unknown): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    const { kind } = entry.reg;
    if (!kind.preferences) throw new SessionError(404, 'This board keeps no settings of its own.');
    const deps = await entry.reg.deps();
    const refused = await kind.preferences.write(name, value, deps);
    if (refused !== undefined) throw new SessionError(400, refused);
    entry.preferences = await kind.preferences.read(deps);
    this.changed(entry);
    return this.toState(entry);
  }

  /** The session's state; with `sinceTick`, waits until it changes or `waitMs` pass. */
  async state(kindName: string, id: string, sinceTick?: number, waitMs = 0): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    await this.loadPreferences(entry);
    if (sinceTick !== undefined && sinceTick === entry.tick && waitMs > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { entry.waiters.delete(wake); resolve(); }, waitMs);
        const wake = () => { clearTimeout(timer); resolve(); };
        entry.waiters.add(wake);
      });
    }
    return this.toState(entry);
  }

  /** A board that writes is not applied from data a failed check could not confirm. */
  private writesBlocked(entry: Entry): boolean {
    return Boolean(entry.session && entry.error && entry.reg.kind.apply);
  }

  private requireWritable(entry: Entry): void {
    if (this.writesBlocked(entry)) {
      throw new SessionError(409, `Nothing can be applied while the last check against the sources failed (${entry.error}). Refresh the board; Apply works again once a check passes.`);
    }
  }

  private requireCurrent(entry: Entry, revision: number): Session {
    const session = entry.session;
    if (!session || entry.status === 'building') throw new SessionError(409, 'The board is still loading.');
    this.requireNoPass(entry);
    if (session.revision !== revision) throw new SessionError(409, 'The board changed meanwhile. It was reloaded; try again.');
    return session;
  }

  private passRun(entry: Entry): ActiveRun | undefined {
    return [...entry.runs.values()].find(r => r.state.size === 'pass');
  }

  /** While a pass runs, nothing else changes the board. */
  private requireNoPass(entry: Entry): void {
    const pass = this.passRun(entry);
    if (pass) throw new SessionError(409, `Not now: ${pass.state.label} is running. Wait until it finishes, or stop it.`);
  }

  /** A non-writing action, based on the revision the page last saw. */
  async action(kindName: string, id: string, revision: number, action: unknown): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    return this.enqueue(entry, async () => {
      const session = this.requireCurrent(entry, revision);
      const drop = action as { type?: unknown; id?: unknown } | null;
      let next: Session;
      if (drop && drop.type === DROP_CONFLICT && typeof drop.id === 'string') {
        next = { ...session, conflicts: session.conflicts.filter(c => c.id !== drop.id) };
      } else {
        const reduced = entry.reg.kind.reduce(session, action);
        if (!reduced.ok) throw new SessionError(400, reduced.reason);
        next = { ...session, working: reduced.working };
      }
      entry.session = { ...next, revision: session.revision + 1, lastUsedAt: this.deps.now() };
      await this.persist(entry);
      this.changed(entry);
      return this.toState(entry);
    });
  }

  /** Checks the session against its sources now. */
  async refresh(kindName: string, id: string): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    await this.enqueue(entry, () => this.check(entry, 'refresh'));
    return this.toState(entry);
  }

  private sweepPlans(): void {
    const now = this.deps.now();
    for (const [planId, pending] of this.plans) if (pending.expires <= now) this.plans.delete(planId);
  }

  /** The write plan for an action, with the id Apply has to present. */
  async preview(kindName: string, id: string, revision: number, action: unknown): Promise<PlanPreview> {
    const entry = await this.entry(kindName, id);
    return this.enqueue(entry, async () => {
      const session = this.requireCurrent(entry, revision);
      const { kind } = entry.reg;
      if (!kind.plan || !kind.apply) throw new SessionError(400, 'This board does not write.');
      this.requireWritable(entry);
      const prepared = kind.prepare ? await kind.prepare(session, action, await entry.reg.deps()) : undefined;
      const planned = kind.plan(session, action, prepared);
      if (!planned.ok) throw new SessionError(400, planned.reason);
      this.sweepPlans();
      const planId = randomBytes(24).toString('hex');
      this.plans.set(planId, { sessionId: id, revision, plan: planned.plan, expires: this.deps.now() + (this.deps.planTtlMs ?? DEFAULT_PLAN_TTL_MS) });
      const { title, lines, risky } = planned.plan;
      return { planId, title, lines, risky };
    });
  }

  /** Carries out a previewed plan once: after the native confirmation when it is risky. */
  async apply(kindName: string, id: string, planId: string): Promise<{ results: ApplyLineResult[]; state: BoardState }> {
    const entry = await this.entry(kindName, id);
    return this.enqueue(entry, async () => {
      this.sweepPlans();
      const pending = this.plans.get(planId);
      // Single use: the id is gone before anything is written, whatever happens next.
      this.plans.delete(planId);
      if (!pending || pending.sessionId !== id) throw new SessionError(409, 'This preview is no longer valid. Preview again.');
      const session = this.requireCurrent(entry, pending.revision);
      const { kind } = entry.reg;
      if (!kind.apply) throw new SessionError(400, 'This board does not write.');
      this.requireWritable(entry);
      const { plan } = pending;
      if (plan.risky && !(await this.deps.confirm({ title: plan.title, lines: plan.lines }))) {
        throw new SessionError(409, 'Not applied: the confirmation was declined.');
      }
      // Each finished target is saved before the next write, without raising the revision: the
      // page shows the progress, and a board restored after an interruption knows what is done.
      entry.applying = { done: 0, total: plan.lines.length };
      this.changed(entry);
      let saved = Promise.resolve();
      let progressed = false;
      const progress = (report: ApplyProgressReport<unknown>): Promise<void> => {
        // Saved one after the other, even when a kind reports again before the last save finished.
        saved = saved.then(async () => {
          // A session discarded meanwhile is not written back.
          if (!entry.session || this.entries.get(entry.id) !== entry) return;
          progressed = true;
          entry.session = { ...entry.session, working: report.working, lastUsedAt: this.deps.now() };
          entry.applying = { done: report.done, total: report.total };
          await this.persist(entry);
          this.changed(entry);
        });
        return saved;
      };
      let applied;
      try {
        applied = await kind.apply(session, plan, await entry.reg.deps(), progress);
        await saved;
      } catch (err) {
        await saved.catch(() => undefined);
        entry.applying = undefined;
        // What was saved meanwhile is a change: a preview of the session before it is no longer valid.
        if (progressed && entry.session && this.entries.get(entry.id) === entry) {
          entry.session = { ...entry.session, revision: session.revision + 1 };
          await this.persist(entry);
        }
        this.changed(entry);
        throw err;
      }
      entry.applying = undefined;
      for (const result of applied.results) {
        this.log(result.outcome === 'done' ? 'info' : 'warn', `Board write ${result.outcome}: ${result.target}`, {
          kind: kind.kind, plan: plan.title, reason: result.reason,
        });
      }
      entry.session = {
        ...session, derived: applied.derived, working: applied.working,
        conflicts: [...session.conflicts, ...(applied.conflicts ?? [])],
        revision: session.revision + 1, lastUsedAt: this.deps.now(),
      };
      // A session discarded while the Apply ran stays discarded: the results still go back to the page.
      if (this.entries.get(entry.id) === entry) await this.persist(entry);
      this.changed(entry);
      return { results: applied.results, state: this.toState(entry) };
    });
  }

  /**
   * Gives a session another source of the same kind, e.g. its report file at a new place: the kind's
   * `revalidate` checks the new recipe, the session moves to the id of the new source (stored there,
   * the old file deleted) and is checked against the new source. Refused when another session
   * already has that id. The working state stays; previews of the old id are no longer valid.
   */
  async relocate(kindName: string, id: string, recipe: unknown): Promise<{ id: string; state: BoardState }> {
    const entry = await this.entry(kindName, id);
    const { kind } = entry.reg;
    const revalidate = kind.revalidate;
    if (!revalidate) throw new SessionError(400, 'This board cannot change its source.');
    const moved = await this.enqueue(entry, async (): Promise<Entry> => {
      const session = entry.session;
      if (!session || entry.status === 'building') throw new SessionError(409, 'The board is still loading.');
      if (this.entries.get(id) !== entry) throw new SessionError(404, 'This session no longer exists. Ask for the board again.');
      if (entry.runs.size > 0) throw new SessionError(409, 'The board cannot change its source while a model run goes on. Wait until it finishes, or stop it.');
      const checked = await revalidate(recipe, await entry.reg.deps());
      if (!checked.ok) throw new SessionError(400, checked.reason);
      const newId = sessionIdFor(kind.kind, kind.sourceKey(checked.recipe));
      const next: Session = { ...session, id: newId, recipe: checked.recipe, revision: session.revision + 1, lastUsedAt: this.deps.now() };
      for (const [planId, pending] of this.plans) if (pending.sessionId === id) this.plans.delete(planId);
      if (newId === id) {
        entry.recipe = checked.recipe;
        entry.session = next;
        await this.persist(entry);
        this.changed(entry);
        return entry;
      }
      const other = this.entries.get(newId)?.session ?? (await this.deps.store.load(newId))?.session;
      if (other) {
        throw new SessionError(409, `Another board already uses that source: "${kind.title(other.recipe)}" (${kind.sourceLabel(other.recipe)}). Open or discard that one first.`);
      }
      const target: Entry = {
        id: newId, reg: entry.reg, recipe: checked.recipe, session: next, status: 'ready', tick: entry.tick + 1,
        restored: entry.restored, stored: false, notice: entry.notice, error: entry.error, errorCode: entry.errorCode,
        runs: new Map(), queue: Promise.resolve(), waiters: new Set(),
      };
      this.entries.set(newId, target);
      await this.persist(target);
      this.entries.delete(id);
      await this.deps.store.delete(id);
      this.log('info', 'Moved a session to another source', { kind: kind.kind });
      // A page still waiting on the old id wakes and finds it gone.
      this.changed(entry);
      return target;
    });
    await this.enqueue(moved, () => this.check(moved));
    return { id: moved.id, state: this.toState(moved) };
  }

  /** Saves a file built from the session through the window's save dialog. */
  async exportFile(kindName: string, id: string, format: string): Promise<'saved' | 'cancelled'> {
    const entry = await this.entry(kindName, id);
    const { kind } = entry.reg;
    const session = entry.session;
    if (!kind.exportFile) throw new SessionError(400, 'This board does not save files.');
    if (!session) throw new SessionError(409, 'The board is still loading.');
    const file = await kind.exportFile(session, format, await entry.reg.deps());
    const saved = await this.deps.saveFile(file);
    this.log('info', saved ? 'Board file saved' : 'Board file save cancelled', { kind: kind.kind, file: file.fileName });
    return saved ? 'saved' : 'cancelled';
  }

  /** Removes a session from memory and from the cache: Finish, Discard and Delete all end here. */
  async discard(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    for (const run of entry?.runs.values() ?? []) run.controller.abort();
    for (const [planId, pending] of this.plans) if (pending.sessionId === id) this.plans.delete(planId);
    await this.deps.store.delete(id);
    if (entry) this.changed(entry);
  }

  async discardAll(): Promise<number> {
    const ids = new Set<string>([...this.entries.keys(), ...(await this.deps.store.list()).map(s => s.session.id)]);
    for (const id of ids) await this.discard(id);
    return ids.size;
  }

  /** Deletes the stored sessions not used for `retentionDays`; a session open in memory is kept. */
  async expire(retentionDays: number): Promise<number> {
    const cutoff = this.deps.now() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const { session } of await this.deps.store.list()) {
      const live = this.entries.get(session.id)?.session;
      if ((live?.lastUsedAt ?? session.lastUsedAt) >= cutoff) continue;
      await this.discard(session.id);
      removed++;
    }
    return removed;
  }

  /** The stored sessions for the sessions board, most recently used first. */
  async list(): Promise<SessionSummary[]> {
    const rows: SessionSummary[] = [];
    for (const { session, bytes } of await this.deps.store.list()) {
      const reg = this.kinds.get(session.kind);
      if (!reg || session.formatVersion !== reg.kind.formatVersion) continue;
      rows.push({
        id: session.id, kind: session.kind, title: reg.kind.title(session.recipe), source: reg.kind.sourceLabel(session.recipe),
        createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, readAt: session.derived.readAt, bytes,
      });
    }
    return rows.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /**
   * Starts the model run a page request asks for. The kind names and records it inside the queue,
   * the work then runs outside it, and this answers as soon as the run has started; the page follows
   * it through `state`. A pass is refused while any run goes on, a call while a pass or a call of the
   * same name does.
   */
  async startRun(kindName: string, id: string, revision: number, request: unknown): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    const { kind } = entry.reg;
    const { beginRun, run } = kind;
    if (!beginRun || !run) throw new SessionError(400, 'This board runs no model.');
    return this.enqueue(entry, async () => {
      const session = this.requireCurrent(entry, revision);
      const begun = beginRun(session, request);
      if (!begun.ok) throw new SessionError(400, begun.reason);
      if (begun.size === 'pass' && entry.runs.size > 0) {
        const other = [...entry.runs.values()][0];
        throw new SessionError(409, `Not now: ${other.state.label} is running. Start ${begun.label} once it has finished.`);
      }
      if (entry.runs.has(begun.what)) throw new SessionError(409, `Not now: ${begun.label} is already running.`);
      const active: ActiveRun = {
        state: { size: begun.size, what: begun.what, label: begun.label, done: 0, total: begun.total ?? 0 },
        controller: new AbortController(),
      };
      entry.runs.set(begun.what, active);
      const started: Session = begun.working === undefined
        ? session
        : { ...session, working: begun.working, revision: session.revision + 1, lastUsedAt: this.deps.now() };
      entry.session = started;
      if (begun.working !== undefined) await this.persist(entry);
      this.log('info', 'Board run started', { kind: kind.kind, run: begun.what });
      this.changed(entry);
      void this.carryOut(entry, active, started, request);
      return this.toState(entry);
    });
  }

  /** The run's work, outside the queue; its steps and its end are merged inside it. */
  private async carryOut(entry: Entry, active: ActiveRun, session: Session, request: unknown): Promise<void> {
    const { kind } = entry.reg;
    const live = () => Boolean(entry.session) && this.entries.get(entry.id) === entry;
    const progress = (report: RunProgressReport<unknown>): Promise<void> => this.enqueue(entry, async () => {
      // A board closed meanwhile is not written back.
      if (!live()) return;
      if (report.update) entry.session = { ...entry.session!, working: report.update(entry.session!.working), lastUsedAt: this.deps.now() };
      active.state = { ...active.state, done: report.done, total: report.total };
      await this.persist(entry);
      this.changed(entry);
    });
    let finished: RunFinished<unknown> | undefined;
    let failure: unknown;
    try {
      finished = await kind.run!(session, request, await entry.reg.deps(), progress, active.controller.signal);
    } catch (err) {
      failure = err;
    }
    await this.enqueue(entry, async () => {
      entry.runs.delete(active.state.what);
      if (!live()) {
        this.changed(entry);
        return;
      }
      const current = entry.session!;
      let update: WorkingUpdate<unknown> | undefined = finished?.update;
      let working = current.working;
      if (update) {
        try {
          working = update(current.working);
        } catch (err) {
          failure = err;
          update = undefined;
        }
      }
      if (!update) {
        // A run that threw is treated as one a restart cut off: its finished steps stay.
        working = kind.interrupted ? kind.interrupted(current.working) : current.working;
        entry.notice = `${capitalised(active.state.label)} stopped with an error: ${messageOf(failure)}`;
        this.log('error', 'Board run failed', { kind: kind.kind, run: active.state.what, error: messageOf(failure) });
      } else {
        this.log('info', active.controller.signal.aborted ? 'Board run stopped' : 'Board run finished', { kind: kind.kind, run: active.state.what });
      }
      entry.session = { ...current, working, revision: current.revision + 1, lastUsedAt: this.deps.now() };
      await this.persist(entry);
      this.changed(entry);
    });
  }

  /**
   * The developer's Stop: aborts the run at once, outside the queue, so it is not held up by
   * anything queued before it. Without `what` it stops the pass. The run then saves how it ended.
   */
  async stopRun(kindName: string, id: string, what?: string): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
    const active = what === undefined ? this.passRun(entry) : entry.runs.get(what);
    if (!active) throw new SessionError(409, 'Nothing is running on this board.');
    active.controller.abort();
    this.log('info', 'Board run stop asked for', { kind: entry.reg.kind.kind, run: active.state.what });
    return this.toState(entry);
  }

  /**
   * The session as it is now, from memory or from the cache, without opening it: no entry is made,
   * nothing is read from the sources and no check starts. A stored run that a restart cut off shows
   * as interrupted. Undefined when there is no such session of this format.
   */
  async peek(kindName: string, id: string): Promise<Session | undefined> {
    const reg = this.kind(kindName);
    const known = this.entries.get(id);
    if (known) return known.reg === reg ? known.session : undefined;
    const stored = await this.deps.store.load(id);
    if (!stored || stored.session.kind !== reg.kind.kind || stored.session.formatVersion !== reg.kind.formatVersion) return undefined;
    return this.withoutRun(reg, stored.session);
  }

  /**
   * Whether the cache holds this session in another format than the kind's: one an update left
   * behind, which `peek` does not return and opening the board rebuilds from its recipe.
   */
  async storedInOtherFormat(kindName: string, id: string): Promise<boolean> {
    const reg = this.kind(kindName);
    if (this.entries.has(id)) return false;
    const stored = await this.deps.store.load(id);
    return stored !== undefined && stored.session.kind === reg.kind.kind && stored.session.formatVersion !== reg.kind.formatVersion;
  }

  /** The session itself, for a tool that reads from it (review findings). */
  async read(kindName: string, id: string): Promise<Session | undefined> {
    return (await this.find(this.kind(kindName), id))?.session;
  }
}
