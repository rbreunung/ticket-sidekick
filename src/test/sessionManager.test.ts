import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerKind, type BoardKind } from '../sessions/boardKind';
import { sessionIdFor } from '../sessions/sessionId';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { Session } from '../sessions/sessionTypes';

// A small board over a fake ticket source: the developer selects tickets and closes them.

interface Recipe { project: string }
interface Derived { tickets: Record<string, string> }
interface Working { selected: string[] }
type Action = { type: 'select'; key: string } | { type: 'close' };
interface Deps {
  tickets: Record<string, string>;
  reads: { count: number };
  failRead?: boolean;
  modes?: string[];
  /** Apply stops with an error after this many targets, as if the window closed mid-write. */
  stopAfter?: number;
  /** Called after each saved progress report, while the Apply still runs. */
  onProgressSaved?: () => Promise<void>;
  /** Apply reports its first two targets without waiting for the first save. */
  reportWithoutWaiting?: boolean;
  /** Projects a stored recipe no longer resolves to. */
  gone?: string[];
  /** What the kind's `prepare` reads before a close's preview: a ticket's owner, or an error. */
  owner?: string | Error;
  prepares?: number;
}

function makeKind(formatVersion = 1, options: { revalidate?: boolean; prepare?: boolean } = {}): BoardKind<Recipe, Derived, Working, Action, { tickets: Record<string, string>; selected: string[] }, Deps> {
  return {
    ...(options.revalidate ? {
      revalidate: async (recipe: unknown, deps: Deps) => {
        const project = (recipe as { project?: unknown })?.project;
        return typeof project === 'string' && !(deps.gone ?? []).includes(project)
          ? { ok: true as const, recipe: { project } }
          : { ok: false as const, reason: 'The project is gone.' };
      },
    } : {}),
    ...(options.prepare ? {
      prepare: async (_session: unknown, action: Action, deps: Deps) => {
        if (action.type !== 'close') return undefined;
        deps.prepares = (deps.prepares ?? 0) + 1;
        if (deps.owner instanceof Error) throw deps.owner;
        return deps.owner;
      },
    } : {}),
    kind: 'demo',
    formatVersion,
    title: r => `Demo: ${r.project}`,
    validate: async input => {
      const project = (input as { project?: unknown })?.project;
      return typeof project === 'string' && project ? { ok: true, recipe: { project } } : { ok: false, reason: 'No project.' };
    },
    sourceKey: r => r.project.toUpperCase(),
    sourceLabel: r => r.project,
    initialWorking: () => ({ selected: [] }),
    read: async (_r, deps) => {
      deps.reads.count++;
      if (deps.failRead) throw new Error('Jira answered 503');
      return { readAt: deps.reads.count, fingerprints: {}, data: { tickets: { ...deps.tickets } } };
    },
    reconcile: (session, fresh, mode) => {
      source.modes?.push(mode ?? 'none');
      const gone = session.working.selected.filter(key => fresh.data.tickets[key] !== session.derived.data.tickets[key]);
      return {
        derived: fresh,
        working: { selected: session.working.selected.filter(key => !gone.includes(key)) },
        conflicts: gone.map(key => ({
          id: key, target: key, message: 'Changed in Jira since it was selected.',
          stored: session.derived.data.tickets[key], fresh: fresh.data.tickets[key] ?? 'gone',
        })),
      };
    },
    reduce: (session, action) => {
      if (action.type !== 'select') return { ok: false, reason: 'Unknown action.' };
      if (!(action.key in session.derived.data.tickets)) return { ok: false, reason: `${action.key} is not on the board.` };
      return { ok: true, working: { selected: [...session.working.selected, action.key] } };
    },
    plan: (session, action, prepared) => {
      if (action.type !== 'close') return { ok: false, reason: 'Unknown action.' };
      const keys = session.working.selected;
      if (keys.length === 0) return { ok: false, reason: 'Nothing is selected.' };
      return { ok: true, plan: { title: `Close ${keys.length} ticket(s)${prepared ? ` owned by ${String(prepared)}` : ''}`, lines: keys.map(k => ({ target: k, change: 'Closed' })), risky: true, payload: keys } };
    },
    apply: async (session, plan, deps, progress) => {
      const tickets = { ...session.derived.data.tickets };
      const keys = plan.payload as string[];
      const results = [];
      const unsaved: Promise<void>[] = [];
      for (const key of keys) {
        if (deps.stopAfter !== undefined && results.length === deps.stopAfter) throw new Error('The window closed.');
        // The target is read again; one that moved since the board read it is refused.
        if (deps.tickets[key] !== tickets[key]) {
          results.push({ target: key, outcome: 'refused' as const, reason: 'Changed in Jira.' });
        } else {
          deps.tickets[key] = 'Closed';
          tickets[key] = 'Closed';
          results.push({ target: key, outcome: 'done' as const });
        }
        // The finished targets leave the selection, so a new plan covers only the rest.
        const report = progress?.({ working: { selected: keys.slice(results.length) }, done: results.length, total: keys.length });
        if (deps.reportWithoutWaiting && results.length === 1 && report) {
          unsaved.push(report);
          continue;
        }
        await Promise.all([...unsaved.splice(0), report]);
        await deps.onProgressSaved?.();
      }
      return { results, derived: { ...session.derived, data: { tickets } }, working: { selected: [] } };
    },
    view: session => ({ tickets: session.derived.data.tickets, selected: session.working.selected }),
  };
}

let dir: string;
let source: Deps;
let confirmations: string[];
let confirmAnswer: boolean;
let clock: number;

function manager(formatVersion = 1, options: { revalidate?: boolean; prepare?: boolean } = {}): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir),
    kinds: [registerKind(makeKind(formatVersion, options), () => source)],
    now: () => clock,
    confirm: async plan => { confirmations.push(plan.title); return confirmAnswer; },
    saveFile: async () => true,
  });
}

async function ready(m: SessionManager, id: string) {
  let state = await m.state('demo', id);
  while (state.status !== 'ready' && state.status !== 'failed') state = await m.state('demo', id, state.tick, 1000);
  return state;
}

async function openReady(m: SessionManager, project = 'PROJ') {
  const opened = await m.open('demo', { project });
  if (!opened.ok) throw new Error(opened.reason);
  return ready(m, opened.id);
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-sessions-'));
  source = { tickets: { 'PROJ-1': 'Open', 'PROJ-2': 'Open', 'PROJ-3': 'Done' }, reads: { count: 0 } };
  confirmations = [];
  confirmAnswer = true;
  clock = 1_000_000;
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('opening a board', () => {
  it('builds a session from the sources and shows it', async () => {
    const state = await openReady(manager());
    expect(state.title).toBe('Demo: PROJ');
    expect(state.restored).toBe(false);
    expect(state.stored).toBe(true);
    expect(state.view).toEqual({ tickets: source.tickets, selected: [] });
  });

  it('answers with the reason when the request is not valid, and creates nothing', async () => {
    const opened = await manager().open('demo', {});
    expect(opened).toEqual({ ok: false, reason: 'No project.' });
    expect(await new SessionStore(dir).list()).toEqual([]);
  });

  it('finds the same session for the same source', async () => {
    const m = manager();
    const first = await openReady(m, 'PROJ');
    const again = await m.open('demo', { project: 'proj' });
    expect(again.ok && again.id).toBe(first.id);
    expect(first.id).toBe(sessionIdFor('demo', 'PROJ'));
  });

  it('shows the failure when the sources cannot be read, and recovers on Refresh', async () => {
    source.failRead = true;
    const m = manager();
    const failed = await openReady(m);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Jira answered 503');
    source.failRead = false;
    const state = await m.refresh('demo', failed.id);
    expect(state.status).toBe('ready');
    expect(state.view).toBeDefined();
  });
});

describe('working on a board', () => {
  it('applies an action and raises the revision', async () => {
    const m = manager();
    const state = await openReady(m);
    const next = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    expect(next.revision).toBe(state.revision + 1);
    expect(next.view).toMatchObject({ selected: ['PROJ-1'] });
  });

  it('refuses an action the board kind refuses', async () => {
    const m = manager();
    const state = await openReady(m);
    await expect(m.action('demo', state.id, state.revision, { type: 'select', key: 'OTHER-9' })).rejects.toMatchObject({ status: 400, message: 'OTHER-9 is not on the board.' });
  });

  it('refuses an action based on an older revision', async () => {
    const m = manager();
    const state = await openReady(m);
    await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    await expect(m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-2' })).rejects.toMatchObject({ status: 409 });
  });

  it('wakes a waiting page when the session changes', async () => {
    const m = manager();
    const state = await openReady(m);
    const waiting = m.state('demo', state.id, state.tick, 5000);
    await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-2' });
    expect((await waiting).view).toMatchObject({ selected: ['PROJ-2'] });
  });
});

describe('restart', () => {
  it('shows the stored session at once, with its working state, and checks the sources in the background', async () => {
    const first = manager();
    const state = await openReady(first);
    await first.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    const readsBefore = source.reads.count;

    const restarted = manager();
    const shown = await restarted.state('demo', state.id);
    expect(shown.restored).toBe(true);
    expect(shown.view).toMatchObject({ selected: ['PROJ-1'] });
    await restarted.refresh('demo', state.id);
    expect(source.reads.count).toBeGreaterThan(readsBefore);
  });

  it('marks working state that no longer fits the fresh reading as a conflict', async () => {
    const first = manager();
    const state = await openReady(first);
    await first.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    source.tickets['PROJ-1'] = 'Closed';

    const restarted = manager();
    const checked = await restarted.refresh('demo', state.id);
    expect(checked.conflicts).toEqual([{ id: 'PROJ-1', target: 'PROJ-1', message: 'Changed in Jira since it was selected.', stored: 'Open', fresh: 'Closed' }]);
    expect(checked.view).toMatchObject({ selected: [] });

    const dropped = await restarted.action('demo', state.id, checked.revision, { type: 'conflict/drop', id: 'PROJ-1' });
    expect(dropped.conflicts).toEqual([]);
  });

  it('tells the board whether a check ran by itself or on Refresh', async () => {
    const first = manager();
    const state = await openReady(first);
    source.modes = [];

    const restarted = manager();
    await ready(restarted, state.id);
    expect(source.modes).toEqual(['background']);

    await restarted.refresh('demo', state.id);
    expect(source.modes).toEqual(['background', 'refresh']);
  });

  it('keeps the stored state on show when the check fails', async () => {
    const first = manager();
    const state = await openReady(first);
    source.failRead = true;
    const checked = await manager().refresh('demo', state.id);
    expect(checked.status).toBe('ready');
    expect(checked.error).toBe('Jira answered 503');
    expect(checked.view).toBeDefined();
  });

  it('discards a stored session of another format and says so', async () => {
    const state = await openReady(manager(1));
    const newer = manager(2);
    await expect(newer.state('demo', state.id)).rejects.toMatchObject({ status: 404 });

    await openReady(manager(1));
    const rebuilt = await openReady(manager(2));
    expect(rebuilt.restored).toBe(false);
    expect(rebuilt.notice).toMatch(/another version/);
  });

  it('rebuilds a stored session of another format from what it was opened with, and says so', async () => {
    const first = manager(1, { revalidate: true });
    const state = await openReady(first);
    await first.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });

    const updated = manager(2, { revalidate: true });
    const rebuilt = await ready(updated, state.id);
    expect(rebuilt.status).toBe('ready');
    expect(rebuilt.title).toBe('Demo: PROJ');
    expect(rebuilt.restored).toBe(false);
    expect(rebuilt.notice).toMatch(/rebuilt after an update/);
    // The earlier choices are not kept.
    expect(rebuilt.view).toMatchObject({ selected: [] });
    const stored = await new SessionStore(dir).load(state.id);
    expect(stored?.session.formatVersion).toBe(2);
  });

  it('gives "no longer exists" for a stored session of another format whose recipe no longer holds', async () => {
    const state = await openReady(manager(1, { revalidate: true }));
    source.gone = ['PROJ'];
    await expect(manager(2, { revalidate: true }).state('demo', state.id)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('no longer exists') });
    expect(await new SessionStore(dir).load(state.id)).toBeUndefined();
  });
});

describe('moving a session to another source', () => {
  it('moves the session with its working state to the id of the new source, and checks it there', async () => {
    const m = manager(1, { revalidate: true });
    let state = await openReady(m);
    state = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    const reads = source.reads.count;

    const moved = await m.relocate('demo', state.id, { project: 'OTHER' });

    expect(moved.id).toBe(sessionIdFor('demo', 'OTHER'));
    expect(moved.state).toMatchObject({ title: 'Demo: OTHER', view: { selected: ['PROJ-1'] } });
    expect(source.reads.count).toBe(reads + 1);
    await expect(m.state('demo', state.id)).rejects.toMatchObject({ status: 404 });
    expect(await new SessionStore(dir).load(state.id)).toBeUndefined();
    expect((await new SessionStore(dir).load(moved.id))?.session.recipe).toEqual({ project: 'OTHER' });
    // Asking for the new source finds the moved session.
    expect(await m.open('demo', { project: 'OTHER' })).toMatchObject({ ok: true, id: moved.id });
  });

  it('refuses a source another session already has, naming that session, and leaves both as they were', async () => {
    const m = manager(1, { revalidate: true });
    const first = await openReady(m, 'PROJ');
    const second = await openReady(m, 'OTHER');
    await expect(m.relocate('demo', first.id, { project: 'other' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Demo: OTHER') });
    expect((await m.state('demo', first.id)).title).toBe('Demo: PROJ');
    expect((await m.state('demo', second.id)).title).toBe('Demo: OTHER');
  });

  it('refuses a recipe the board does not accept, and a board that cannot change its source', async () => {
    const m = manager(1, { revalidate: true });
    const state = await openReady(m);
    await expect(m.relocate('demo', state.id, { project: 42 })).rejects.toMatchObject({ status: 400 });
    const plain = manager(1);
    await expect(plain.relocate('demo', state.id, { project: 'OTHER' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('writing from a board', () => {
  async function selected(m: SessionManager, keys: string[]) {
    let state = await openReady(m);
    for (const key of keys) state = await m.action('demo', state.id, state.revision, { type: 'select', key });
    return state;
  }

  it('writes only after a preview, and a risky plan only after the native confirmation', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1', 'PROJ-2']);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    expect(preview.lines).toEqual([{ target: 'PROJ-1', change: 'Closed' }, { target: 'PROJ-2', change: 'Closed' }]);
    expect(source.tickets['PROJ-1']).toBe('Open');

    const { results } = await m.apply('demo', state.id, preview.planId);
    expect(confirmations).toEqual(['Close 2 ticket(s)']);
    expect(results.map(r => r.outcome)).toEqual(['done', 'done']);
    expect(source.tickets).toMatchObject({ 'PROJ-1': 'Closed', 'PROJ-2': 'Closed' });
  });

  it('writes nothing when the confirmation is declined', async () => {
    confirmAnswer = false;
    const m = manager();
    const state = await selected(m, ['PROJ-1']);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409 });
    expect(source.tickets['PROJ-1']).toBe('Open');
  });

  it('refuses a plan id that was never issued, and one that was already used', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1']);
    await expect(m.apply('demo', state.id, 'made-up')).rejects.toMatchObject({ status: 409 });
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    await m.apply('demo', state.id, preview.planId);
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a plan previewed before the board changed', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1']);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-2' });
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409 });
    expect(source.tickets['PROJ-1']).toBe('Open');
  });

  it('refuses a plan after its time is up', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1']);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    clock += 11 * 60 * 1000;
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409 });
  });

  it('applies nothing while the last check failed, and again once a check passes', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1']);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    source.failRead = true;
    const failed = await m.refresh('demo', state.id);
    expect(failed.writesBlocked).toBe(true);
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('once a check passes') });
    await expect(m.preview('demo', state.id, failed.revision, { type: 'close' })).rejects.toMatchObject({ status: 409 });
    expect(source.tickets['PROJ-1']).toBe('Open');

    source.failRead = false;
    const passed = await m.refresh('demo', state.id);
    expect(passed.writesBlocked).toBe(false);
    const again = await m.preview('demo', state.id, passed.revision, { type: 'close' });
    await m.apply('demo', state.id, again.planId);
    expect(source.tickets['PROJ-1']).toBe('Closed');
  });

  it('refuses a target that changed in Jira since the board read it, and writes the others', async () => {
    const m = manager();
    const state = await selected(m, ['PROJ-1', 'PROJ-2']);
    source.tickets['PROJ-2'] = 'In Review';
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    const { results } = await m.apply('demo', state.id, preview.planId);
    expect(results).toEqual([{ target: 'PROJ-1', outcome: 'done' }, { target: 'PROJ-2', outcome: 'refused', reason: 'Changed in Jira.' }]);
    expect(source.tickets['PROJ-2']).toBe('In Review');
  });
});

describe('a check that finds nothing new', () => {
  it('keeps the revision, so a preview made before it can still be applied', async () => {
    confirmAnswer = true;
    const m = manager();
    let state = await openReady(m);
    state = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    const refreshed = await m.refresh('demo', state.id);
    expect(refreshed.revision).toBe(state.revision);
    const { results } = await m.apply('demo', state.id, preview.planId);
    expect(results).toEqual([{ target: 'PROJ-1', outcome: 'done' }]);
  });

  it('raises the revision when the check found a change, so the older preview is refused', async () => {
    const m = manager();
    let state = await openReady(m);
    state = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    source.tickets = { ...source.tickets, 'PROJ-9': 'Open' };
    expect((await m.refresh('demo', state.id)).revision).toBe(state.revision + 1);
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toMatchObject({ status: 409 });
  });
});

describe('a read before the preview', () => {
  it('reads what the preview must show before the plan is built, and the plan shows it', async () => {
    source.owner = 'Alice';
    const m = manager(1, { prepare: true });
    let state = await openReady(m);
    state = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    expect(preview.title).toBe('Close 1 ticket(s) owned by Alice');
    expect(source.prepares).toBe(1);
  });

  it('refuses the preview when that read fails, and builds no plan', async () => {
    source.owner = new Error('Jira answered 404');
    const m = manager(1, { prepare: true });
    let state = await openReady(m);
    state = await m.action('demo', state.id, state.revision, { type: 'select', key: 'PROJ-1' });
    await expect(m.preview('demo', state.id, state.revision, { type: 'close' })).rejects.toThrow('Jira answered 404');
    // The board stays usable: once the read works, the preview does too.
    source.owner = 'Bob';
    expect((await m.preview('demo', state.id, state.revision, { type: 'close' })).title).toBe('Close 1 ticket(s) owned by Bob');
  });
});

describe('an Apply in progress', () => {
  const seven = () => Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`PROJ-${i + 1}`, 'Open']));

  async function selectedAll(m: SessionManager) {
    let state = await openReady(m);
    for (const key of Object.keys(source.tickets)) state = await m.action('demo', state.id, state.revision, { type: 'select', key });
    return state;
  }

  it('keeps the targets written before an interruption, and a new plan covers only the rest', async () => {
    source.tickets = seven();
    const m = manager();
    const state = await selectedAll(m);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    source.stopAfter = 4;
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toThrow('The window closed.');
    source.stopAfter = undefined;

    const stored = await new SessionStore(dir).load(state.id);
    expect(stored?.session.working).toEqual({ selected: ['PROJ-5', 'PROJ-6', 'PROJ-7'] });

    const restarted = manager();
    const restored = await ready(restarted, state.id);
    expect(restored.restored).toBe(true);
    const again = await restarted.preview('demo', state.id, restored.revision, { type: 'close' });
    expect(again.lines.map(l => l.target)).toEqual(['PROJ-5', 'PROJ-6', 'PROJ-7']);
  });

  it('reports applying with done and total while it runs, without raising the revision until the end', async () => {
    source.tickets = { 'PROJ-1': 'Open', 'PROJ-2': 'Open', 'PROJ-3': 'Open' };
    const m = manager();
    const state = await selectedAll(m);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    const seen: { revision: number; applying: unknown; selected: unknown }[] = [];
    source.onProgressSaved = async () => {
      const now = await m.state('demo', state.id);
      seen.push({ revision: now.revision, applying: now.applying, selected: (now.view as { selected: string[] }).selected });
    };
    const { state: after } = await m.apply('demo', state.id, preview.planId);
    expect(seen).toEqual([
      { revision: state.revision, applying: { done: 1, total: 3 }, selected: ['PROJ-2', 'PROJ-3'] },
      { revision: state.revision, applying: { done: 2, total: 3 }, selected: ['PROJ-3'] },
      { revision: state.revision, applying: { done: 3, total: 3 }, selected: [] },
    ]);
    expect(after.revision).toBe(state.revision + 1);
    expect(after.applying).toBeUndefined();
  });

  it('raises the revision once when an Apply stops after saving some targets, so an older preview is refused', async () => {
    const m = manager();
    const state = await selectedAll(m);
    const first = await m.preview('demo', state.id, state.revision, { type: 'close' });
    const second = await m.preview('demo', state.id, state.revision, { type: 'close' });
    source.stopAfter = 1;
    await expect(m.apply('demo', state.id, first.planId)).rejects.toThrow('The window closed.');
    const now = await m.state('demo', state.id);
    expect(now.revision).toBe(state.revision + 1);
    expect(now.applying).toBeUndefined();
    await expect(m.apply('demo', state.id, second.planId)).rejects.toMatchObject({ status: 409 });
  });

  it('does not store again a session discarded while its Apply ran', async () => {
    source.tickets = { 'PROJ-1': 'Open', 'PROJ-2': 'Open' };
    const m = manager();
    const state = await selectedAll(m);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    let discarded = false;
    source.onProgressSaved = async () => {
      if (discarded) return;
      discarded = true;
      await m.discard(state.id);
    };
    await m.apply('demo', state.id, preview.planId);
    expect(await new SessionStore(dir).load(state.id)).toBeUndefined();
  });

  it('does not store again a session discarded before its Apply failed', async () => {
    source.tickets = { 'PROJ-1': 'Open', 'PROJ-2': 'Open', 'PROJ-3': 'Open' };
    const m = manager();
    const state = await selectedAll(m);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    let discarded = false;
    source.onProgressSaved = async () => {
      if (discarded) return;
      discarded = true;
      await m.discard(state.id);
    };
    source.stopAfter = 2;
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toThrow('The window closed.');
    expect(await new SessionStore(dir).load(state.id)).toBeUndefined();
  });

  it('saves two progress reports in a row one after the other, and the session stays stored', async () => {
    const m = manager();
    const state = await selectedAll(m);
    const preview = await m.preview('demo', state.id, state.revision, { type: 'close' });
    source.reportWithoutWaiting = true;
    source.stopAfter = 2;
    await expect(m.apply('demo', state.id, preview.planId)).rejects.toThrow('The window closed.');
    expect((await m.state('demo', state.id)).stored).toBe(true);
    const stored = await new SessionStore(dir).load(state.id);
    expect(stored?.session.working).toEqual({ selected: ['PROJ-3'] });
  });
});

describe('the cache', () => {
  it('lists stored sessions, most recently used first', async () => {
    const m = manager();
    await openReady(m, 'AAA');
    clock += 1000;
    await openReady(m, 'BBB');
    const rows = await m.list();
    expect(rows.map(r => r.source)).toEqual(['BBB', 'AAA']);
    expect(rows[0]).toMatchObject({ kind: 'demo', title: 'Demo: BBB' });
    expect(rows[0].bytes).toBeGreaterThan(0);
  });

  it('deletes sessions not used for the retention time and keeps the others', async () => {
    const m = manager();
    const old = await openReady(m, 'OLD');
    clock += 15 * 24 * 60 * 60 * 1000;
    await openReady(m, 'NEW');
    expect(await m.expire(14)).toBe(1);
    expect((await m.list()).map(r => r.source)).toEqual(['NEW']);
    await expect(m.state('demo', old.id)).rejects.toMatchObject({ status: 404 });
  });

  it('discards one session, or all of them', async () => {
    const m = manager();
    const a = await openReady(m, 'AAA');
    await openReady(m, 'BBB');
    await m.discard(a.id);
    expect((await m.list()).map(r => r.source)).toEqual(['BBB']);
    expect(await m.discardAll()).toBe(1);
    expect(await m.list()).toEqual([]);
  });

  it('keeps a session in memory only when it is too large to store, and says so', async () => {
    const m = new SessionManager({
      store: new SessionStore(dir, 50),
      kinds: [registerKind(makeKind(), () => source)],
      now: () => clock,
      confirm: async () => true,
      saveFile: async () => true,
    });
    const opened = await m.open('demo', { project: 'PROJ' });
    const state = await ready(m, (opened as { id: string }).id);
    expect(state.stored).toBe(false);
    expect(state.view).toBeDefined();
    expect(await m.list()).toEqual([]);
  });

  it('drops a stored file that is not a session', async () => {
    const id = sessionIdFor('demo', 'PROJ');
    await fs.promises.writeFile(path.join(dir, `${id}.json`), '{"half":');
    const store = new SessionStore(dir);
    expect(await store.load(id)).toBeUndefined();
    expect(await fs.promises.readdir(dir)).toEqual([]);
  });

  it('writes a session file only its owner can read', async () => {
    const state = await openReady(manager());
    const stat = await fs.promises.stat(path.join(dir, `${state.id}.json`));
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    const session = JSON.parse(await fs.promises.readFile(path.join(dir, `${state.id}.json`), 'utf8')) as Session;
    expect(session.kind).toBe('demo');
  });
});
