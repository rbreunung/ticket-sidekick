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
    restored: false, stored: true, writesBlocked: false, view: {},
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
    render: (_view: unknown, board: { running(what: string): unknown; run(r: unknown): void; act(a: unknown): void; setPreference(name: string, value: boolean): void }, locked: boolean) => h('div', {},
      h('vscode-button', { id: 'explain-1', disabled: locked || Boolean(board.running('explain:1')), onClick: () => board.run({ type: 'explain', n: 1 }) }, 'Explain'),
      h('vscode-button', { id: 'select', disabled: locked, onClick: () => board.act({ type: 'select' }) }, 'Select'),
      h('vscode-button', { id: 'quiet', disabled: locked, onClick: () => board.setPreference('loud', false) }, 'Quiet'),
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

  it('sends a setting the board keeps for itself on its own, without the session revision, and shows the answer', async () => {
    state = { ...base(), preferences: { loud: true } };
    await loadPage(async (op, body) => {
      if (op === 'preference') { state = { ...state, tick: state.tick + 1, preferences: { loud: body.value as boolean } }; return state; }
      throw { status: 404, message: 'Unknown request.' };
    });
    byId('quiet')!.dispatch('click');
    await settle();
    expect(page.posted.filter(m => m.op === 'preference').map(m => m.body)).toEqual([{ name: 'loud', value: false }]);
  });

  it('shows why a run was refused', async () => {
    state = base();
    await loadPage(async () => { throw { status: 409, message: 'Not now: the regular pass is running.' }; });
    byId('explain-1')!.dispatch('click');
    await settle();
    expect(page.root.textContent).toContain('Not now: the regular pass is running.');
  });

  it('a board whose view shows its own run line gets no run line, progress or Stop in the header', async () => {
    state = { ...base(), view: { ownRunLine: true }, running: [{ size: 'pass', what: 'pass', label: 'the regular pass', done: 1, total: 3 }] };
    await loadPage(async () => { throw { status: 404, message: 'Unknown request.' }; });
    expect(page.root.textContent).not.toContain('Running the regular pass');
    expect(byId('run-progress')).toBeNull();
    expect(byId('stop-run')).toBeNull();
    expect(disabled('pass')).toBe(true);
  });
});

describe('a board page drawn again', () => {
  it('keeps the scroll position of a box and the caret in the field being typed in', async () => {
    state = base();
    closed = false;
    waiting = [];
    page = installFakePage({ kind: 'runs', session: SESSION, title: 'Review' }, async (op, body) => {
      if (closed) return new Promise(() => undefined);
      if (op === 'state' && typeof body.tick === 'number' && body.tick === state.tick) {
        await new Promise<void>(resolve => waiting.push(resolve));
        if (closed) return new Promise(() => undefined);
      }
      return state;
    });
    vi.resetModules();
    const { startBoard, h } = await import('../../board-pages/shared/board.js' as string);
    startBoard({
      root: page.root,
      render: (view: { items: number }) => h('div', {},
        h('ul', { id: 'list' }, Array.from({ length: view.items ?? 1 }, (_, i) => h('li', {}, `Item ${i + 1}`))),
        h('input', { type: 'text', id: 'question', value: 'Is it reachable?' })),
    });
    await settle();
    byId('list')!.scrollTop = 240;
    const field = byId('question')!;
    field.focus();
    field.selectionStart = 3;
    field.selectionEnd = 5;

    await push({ view: { items: 3 } });
    expect(byId('list')!.textContent).toBe('Item 1Item 2Item 3');
    expect(byId('list')!.scrollTop).toBe(240);
    expect(byId('question')).not.toBe(field);
    expect(page.document.activeElement?.id).toBe('question');
    expect([byId('question')!.selectionStart, byId('question')!.selectionEnd]).toEqual([3, 5]);
  });

  it('waits with the redraw while text on the board is selected, and draws once the selection closes', async () => {
    state = base();
    closed = false;
    waiting = [];
    page = installFakePage({ kind: 'runs', session: SESSION, title: 'Review' }, async (op, body) => {
      if (closed) return new Promise(() => undefined);
      if (op === 'state' && typeof body.tick === 'number' && body.tick === state.tick) {
        await new Promise<void>(resolve => waiting.push(resolve));
        if (closed) return new Promise(() => undefined);
      }
      return state;
    });
    vi.resetModules();
    const { startBoard, h } = await import('../../board-pages/shared/board.js' as string);
    startBoard({
      root: page.root,
      render: (view: { items: number }) => h('ul', { id: 'list' }, Array.from({ length: view.items ?? 1 }, (_, i) => h('li', {}, `Item ${i + 1}`))),
    });
    await settle();
    const list = byId('list')!;
    page.document.selection = { anchorNode: list.children[0], isCollapsed: false, rangeCount: 1 };

    await push({ view: { items: 3 } });
    expect(byId('list')).toBe(list);

    page.document.selection = { anchorNode: null, isCollapsed: true, rangeCount: 0 };
    page.document.dispatch('selectionchange');
    await settle();
    expect(byId('list')).not.toBe(list);
    expect(byId('list')!.textContent).toBe('Item 1Item 2Item 3');
  });
});
