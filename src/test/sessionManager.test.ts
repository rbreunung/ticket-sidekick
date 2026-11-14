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
interface Deps { tickets: Record<string, string>; reads: { count: number }; failRead?: boolean; modes?: string[] }

function makeKind(formatVersion = 1): BoardKind<Recipe, Derived, Working, Action, { tickets: Record<string, string>; selected: string[] }, Deps> {
  return {
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
    plan: (session, action) => {
      if (action.type !== 'close') return { ok: false, reason: 'Unknown action.' };
      const keys = session.working.selected;
      if (keys.length === 0) return { ok: false, reason: 'Nothing is selected.' };
      return { ok: true, plan: { title: `Close ${keys.length} ticket(s)`, lines: keys.map(k => ({ target: k, change: 'Closed' })), risky: true, payload: keys } };
    },
    apply: async (session, plan, deps) => {
      const tickets = { ...session.derived.data.tickets };
      const results = (plan.payload as string[]).map(key => {
        // The target is read again; one that moved since the board read it is refused.
        if (deps.tickets[key] !== tickets[key]) return { target: key, outcome: 'refused' as const, reason: 'Changed in Jira.' };
        deps.tickets[key] = 'Closed';
        tickets[key] = 'Closed';
        return { target: key, outcome: 'done' as const };
      });
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

function manager(formatVersion = 1): SessionManager {
  return new SessionManager({
    store: new SessionStore(dir),
    kinds: [registerKind(makeKind(formatVersion), () => source)],
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
