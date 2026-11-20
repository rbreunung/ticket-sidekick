import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardState } from '../sessions/sessionManager';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The client every board page shares, during a model run: a page with an Explain control for one
// finding, a Select control and the review pass. While the pass runs, every control but Stop is
// locked; while one explanation runs, only its own Explain control is.

const SESSION = 'runs-0123456789abcdef';

let page: FakePage;
let state: BoardState;
let waiting: Array<() => void> = [];
let closed = false;

function base(): BoardState {
  return {
    id: SESSION, kind: 'runs', title: 'Review', status: 'ready', tick: 1, revision: 1, asOf: 1_000,
    restored: false, stored: true, conflicts: [], writesBlocked: false, view: {},
  };
}

/** Shows a new state to the page, as the extension does when a run reports a step. */
async function push(next: Partial<BoardState>): Promise<void> {
  state = { ...state, ...next, tick: state.tick + 1 };
  const wake = waiting;
  waiting = [];
  wake.forEach(w => w());
  await settle();
}

async function loadPage(answer: (op: string, body: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  closed = false;
  waiting = [];
  page = installFakePage({ kind: 'runs', session: SESSION, title: 'Review' }, async (op, body) => {
    if (closed) return new Promise(() => undefined);
    if (op === 'state') {
      if (typeof body.tick === 'number' && body.tick === state.tick) {
        await new Promise<void>(resolve => waiting.push(resolve));
        if (closed) return new Promise(() => undefined);
      }
      return state;
    }
    return answer(op, body);
  });
  vi.resetModules();
  const { startBoard, h } = await import('../../board-pages/shared/board.js' as string);
  startBoard({
    root: page.root,
    render: (_view: unknown, board: { running(what: string): unknown; run(r: unknown): void; act(a: unknown): void }, locked: boolean) => h('div', {},
      h('vscode-button', { id: 'explain-1', disabled: locked || Boolean(board.running('explain:1')), onClick: () => board.run({ type: 'explain', n: 1 }) }, 'Explain'),
      h('vscode-button', { id: 'select', disabled: locked, onClick: () => board.act({ type: 'select' }) }, 'Select'),
      h('vscode-button', { id: 'pass', disabled: locked, onClick: () => board.run({ type: 'pass' }) }, 'Run the pass')),
  });
  await settle();
}

afterEach(() => {
  closed = true;
  removeFakePage();
});

const byId = (id: string) => page.document.getElementById(id) as FakeElement | null;
const disabled = (id: string) => Boolean(byId(id)?.disabled);

describe('a board page during a model run', () => {
  it('starts the pass, shows each step, locks every control but Stop, and stops it', async () => {
    state = base();
    const pass = { size: 'pass' as const, what: 'pass', label: 'the regular pass', done: 0, total: 3 };
    await loadPage(async op => {
      if (op === 'run') { state = { ...state, tick: state.tick + 1, revision: 2, running: [pass] }; return state; }
      if (op === 'stop') return state;
      throw { status: 404, message: 'Unknown request.' };
    });
    byId('pass')!.dispatch('click');
    await settle();
    expect(page.posted.filter(m => m.op === 'run').map(m => m.body)).toEqual([{ revision: 1, request: { type: 'pass' } }]);
    await push({ running: [{ ...pass, done: 1 }] });
    expect(page.root.textContent).toContain('Running the regular pass: 1 of 3 done');
    expect(byId('run-progress')?.value).toBe(1);
    for (const id of ['explain-1', 'select', 'pass', 'refresh', 'discard']) expect(disabled(id), id).toBe(true);
    expect(disabled('stop-run')).toBe(false);

    byId('stop-run')!.dispatch('click');
    await settle();
    expect(page.posted.filter(m => m.op === 'stop').map(m => m.body)).toEqual([{}]);
    await push({ running: undefined, revision: 3 });
    expect(byId('stop-run')).toBeNull();
    for (const id of ['explain-1', 'select', 'pass', 'refresh']) expect(disabled(id), id).toBe(false);
  });

  it('locks only the busy control during a single call, and other actions go on', async () => {
    state = { ...base(), running: [{ size: 'call', what: 'explain:1', label: 'the explanation of #1', done: 0, total: 0 }] };
    await loadPage(async op => {
      if (op === 'action') return state;
      throw { status: 404, message: 'Unknown request.' };
    });
    expect(disabled('explain-1')).toBe(true);
    expect(disabled('select')).toBe(false);
    expect(byId('stop-run')).toBeNull();
    byId('select')!.dispatch('click');
    await settle();
    expect(page.posted.filter(m => m.op === 'action')).toHaveLength(1);
  });

  it('shows why a run was refused', async () => {
    state = base();
    await loadPage(async () => { throw { status: 409, message: 'Not now: the regular pass is running.' }; });
    byId('explain-1')!.dispatch('click');
    await settle();
    expect(page.root.textContent).toContain('Not now: the regular pass is running.');
  });
});
