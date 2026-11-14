import { randomBytes } from 'crypto';
import type { DiagLogger } from '../utils/diagTypes';
import type { CheckMode, ExportedFile, RegisteredKind } from './boardKind';
import { sessionIdFor } from './sessionId';
import type { SessionStore } from './sessionStore';
import { SessionError, type ApplyLineResult, type Conflict, type PlanLine, type Session, type SessionSummary, type WritePlan } from './sessionTypes';

// Owns every session of this window: opens or restores it, runs its actions one after another,
// checks it against the sources, and guards its writes. A write needs a plan id that only a
// preview issues, and a risky plan needs the native confirmation as well, so a request that
// carries only the canvas key cannot change several tickets, close one or post to Bitbucket.

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
  /** The last check against the sources failed on a board that writes: nothing is applied until one passes. */
  writesBlocked: boolean;
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
  queue: Promise<unknown>;
  waiters: Set<() => void>;
}

interface PendingPlan {
  sessionId: string;
  revision: number;
  plan: WritePlan;
  expires: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  /** Finds the session in memory or in the cache; a cached one of another format is discarded. */
  private async find(reg: RegisteredKind, id: string): Promise<Entry | undefined> {
    const known = this.entries.get(id);
    if (known) return known.reg === reg ? known : undefined;
    const stored = await this.deps.store.load(id);
    if (!stored || stored.session.kind !== reg.kind.kind) return undefined;
    if (stored.session.formatVersion !== reg.kind.formatVersion) {
      await this.deps.store.delete(id);
      this.log('info', 'Discarded a stored session of another format', { kind: reg.kind.kind });
      return undefined;
    }
    // Another caller may have loaded it while this one waited for the file.
    const raced = this.entries.get(id);
    if (raced) return raced;
    const entry: Entry = {
      id, reg, recipe: stored.session.recipe, session: stored.session, status: 'ready', tick: 1,
      restored: true, stored: true, queue: Promise.resolve(), waiters: new Set(),
    };
    this.entries.set(id, entry);
    void this.enqueue(entry, () => this.check(entry));
    return entry;
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
    } catch (err) {
      entry.status = 'failed';
      entry.error = messageOf(err);
    }
    this.changed(entry);
  }

  /** Reads the sources again and lays the working state over the fresh reading. */
  private async check(entry: Entry, mode: CheckMode = 'background'): Promise<void> {
    const session = entry.session;
    if (!session) return this.build(entry);
    entry.status = 'checking';
    entry.error = undefined;
    this.changed(entry);
    try {
      const { kind } = entry.reg;
      const fresh = await kind.read(session.recipe, await entry.reg.deps());
      const merged = kind.reconcile(session, fresh, mode);
      // A conflict stays until the developer resolves or drops it; a later check must not erase it.
      const fresher = new Set(merged.conflicts.map(c => c.id));
      entry.session = {
        ...session, derived: merged.derived, working: merged.working,
        conflicts: [...session.conflicts.filter(c => !fresher.has(c.id)), ...merged.conflicts],
        revision: session.revision + 1, lastUsedAt: this.deps.now(),
      };
      await this.persist(entry);
    } catch (err) {
      // The stored state stays on show; the board says the check failed.
      entry.error = messageOf(err);
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
    const formatBefore = (await this.deps.store.load(id))?.session.formatVersion;
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
    const entry: Entry = {
      id, reg, recipe: validated.recipe, status: 'building', tick: 1, restored: false, stored: false,
      queue: Promise.resolve(), waiters: new Set(),
      notice: formatBefore !== undefined && formatBefore !== reg.kind.formatVersion
        ? 'The stored session came from another version of Ticket Sidekick and was discarded.'
        : undefined,
    };
    this.entries.set(id, entry);
    void this.enqueue(entry, () => this.build(entry));
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
      writesBlocked: this.writesBlocked(entry),
      view: session ? kind.view(session) : undefined,
    };
  }

  /** The session's state; with `sinceTick`, waits until it changes or `waitMs` pass. */
  async state(kindName: string, id: string, sinceTick?: number, waitMs = 0): Promise<BoardState> {
    const entry = await this.entry(kindName, id);
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
    if (session.revision !== revision) throw new SessionError(409, 'The board changed meanwhile. It was reloaded; try again.');
    return session;
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
      const planned = kind.plan(session, action);
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
      const applied = await kind.apply(session, plan, await entry.reg.deps());
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
      await this.persist(entry);
      this.changed(entry);
      return { results: applied.results, state: this.toState(entry) };
    });
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

  /** The session itself, for a tool that reads from it (review findings). */
  async read(kindName: string, id: string): Promise<Session | undefined> {
    return (await this.find(this.kind(kindName), id))?.session;
  }
}
