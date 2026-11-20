import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerBoardRequest, asBoardRequest } from '../boards/boardMessages';
import { importKind, type ImportView, type NewRowView, type TicketedRowView } from '../boards/import/kind';
import type { ImportRecipe } from '../boards/import/recipe';
import { registerKind } from '../sessions/boardKind';
import type { BoardState } from '../sessions/sessionManager';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import { EmptyProjectJira, emptyProjectImportDeps, veracodeReport } from './helpers/importBoardFixture';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The import board's page in its editor tab: one tab per group with counts and marks, the rows of
// the tab in view, the merge tab and the progress of an Apply. The page is loaded in a small fake
// document; the extension side is either a canned state or the real import kind behind the tab's
// message route. Everything a report holds must reach the page as text.

const SESSION = 'import-0123456789abcdef';
const ACCEPTED_OPS = new Set(['state', 'action', 'refresh', 'preview', 'apply', 'save', 'discard', 'pick-file']);

let page: FakePage;
let stopped = false;

async function loadPage(): Promise<void> {
  vi.resetModules();
  await import('../../board-pages/import/page.js' as string);
  await settle();
}

afterEach(() => {
  stopped = true;
  removeFakePage();
});

const byId = (id: string) => page.document.getElementById(id);
function must(id: string): FakeElement {
  const el = byId(id);
  if (!el) throw new Error(`No element #${id} on the page`);
  return el;
}
const live = () => byId('board-live')?.textContent ?? '';
const click = async (el: FakeElement) => { el.dispatch('click'); await settle(); };
/** Ticks a checkbox, as a click on it does in the browser. */
const tick = async (el: FakeElement) => { el.checked = !el.checked; el.dispatch('change'); await settle(); };
const buttonNamed = (scope: FakeElement, text: string) => scope.elements().find(el => el.tagName === 'vscode-button' && el.textContent === text);
const actionsPosted = () => page.posted.filter(m => m.op === 'action').map(m => m.body.action as Record<string, unknown>);

// ---- a canned extension side -------------------------------------------------------------

interface Canned {
  state: BoardState;
  /** Answers for the other requests; a thrown `{ status, message }` is a refusal. */
  answer?: (op: string, body: Record<string, unknown>) => Promise<unknown>;
}

let canned: Canned;
let waiting: Array<() => void> = [];

/** Shows a new state to the page, as the extension does when the session changes. */
async function push(state: Partial<BoardState>): Promise<void> {
  canned.state = { ...canned.state, ...state, tick: canned.state.tick + 1 };
  const wake = waiting;
  waiting = [];
  wake.forEach(w => w());
  await settle();
}

function installCanned(c: Canned): void {
  canned = c;
  waiting = [];
  stopped = false;
  page = installFakePage({ kind: 'import', session: SESSION, title: c.state.title }, async (op, body) => {
    if (stopped) return new Promise(() => undefined);
    if (op === 'state') {
      if (typeof body.tick === 'number' && body.tick === canned.state.tick) {
        await new Promise<void>(resolve => waiting.push(resolve));
        if (stopped) return new Promise(() => undefined);
      }
      return canned.state;
    }
    if (op === 'action') return canned.state;
    if (canned.answer) return canned.answer(op, body);
    throw { status: 404, message: 'Unknown request.' };
  });
}

function newRow(n: number, extra: Partial<NewRowView> = {}): NewRowView {
  return { id: `N${n}`, ref: `Flaw ${100 + n}`, summary: `${100 + n} - File${n}.java:1${n} - Hard-coded password`, rating: 'High', included: true, group: `Flaw ${100 + n}`, ...extra };
}

function ticketedRow(n: number, extra: Partial<TicketedRowView> = {}): TicketedRowView {
  return {
    id: `A${n}`, ref: `Flaw ${200 + n}`, summary: `Finding ${n}`, ticket: `PROJ-${n}`, status: 'Open', resolved: false,
    url: `https://jira.example.com/browse/PROJ-${n}`, change: n === 1 ? 'New: 301' : null, action: 'leave',
    allowedActions: ['rewrite', 'leave', 'follow-up'], needsDecision: n === 1, written: false, ...extra,
  };
}

function baseView(extra: Partial<ImportView> = {}): ImportView {
  return {
    title: 'Veracode import: report.xml', reportKind: 'Veracode', reportFile: 'report.xml', reportPath: '/work/report.xml',
    project: 'PROJ', template: 'Security bug', issueType: 'Bug',
    tabs: [
      { id: 'new', label: 'New', count: 7, outOfDate: false, hasWork: true },
      { id: 'ticketed', label: 'Already ticketed', count: 3, outOfDate: false, hasWork: true },
      { id: 'stale', label: 'Stale', count: 0, outOfDate: false, hasWork: false, empty: 'No open ticket is stale.' },
    ],
    tab: 'new', openingTab: 'new', finished: false, filter: '',
    new: { rows: [1, 2, 3, 4, 5, 6, 7].map(n => newRow(n)) },
    dropped: [], notices: [],
    ext: { new: { toCreate: 7, perApply: 50, addedTo: {} }, 'search-export': { search: null, finishedMessage: 'Nothing left to do: every tab of this import is handled. You can still save the overview, or close the import.' } },
    ...extra,
  };
}

function boardState(view: ImportView | undefined, extra: Partial<BoardState> = {}): BoardState {
  return {
    id: SESSION, kind: 'import', title: view?.title ?? 'Veracode import: report.xml', status: 'ready', tick: 1, revision: 1, asOf: 1_000,
    restored: false, stored: true, conflicts: [], writesBlocked: false, ...(view ? { view } : {}), ...extra,
  };
}

const rowEl = (id: string) => must(`row-${id}`);
const resultOf = (id: string) => rowEl(id).elements().find(el => el.getAttribute('class') === 'result')?.textContent ?? '';

describe('the import board page', () => {
  it('shows a crafted finding title as plain text: no HTML, link or wiki markup becomes an element', async () => {
    const crafted = '101 - =HYPERLINK("https://evil.example")<img src=x onerror=alert(1)>[click](https://evil.example){color:red}x{color} *bold*';
    installCanned({ state: boardState(baseView({ new: { rows: [newRow(1, { summary: crafted, ref: 'Flaw <b>101</b>' })] } })) });
    await loadPage();

    expect(rowEl('N1').textContent).toContain(crafted);
    expect(rowEl('N1').textContent).toContain('Flaw <b>101</b>');
    const all = page.document.body.elements();
    expect(all.some(el => el.tagName === 'img' || el.tagName === 'b')).toBe(false);
    expect(all.some(el => el.tagName === 'a' && String(el.href ?? '').includes('evil.example'))).toBe(false);
  });

  it('shows a loading state while the session is built', async () => {
    installCanned({ state: boardState(undefined, { status: 'building' }) });
    await loadPage();
    expect(page.root.textContent).toMatch(/Reading the report/);
  });

  it('shows one tab per group with its count, and the arrow keys move between the tabs', async () => {
    installCanned({ state: boardState(baseView()) });
    await loadPage();

    const list = page.root.elements().find(el => el.getAttribute('role') === 'tablist')!;
    const tabs = list.elements().filter(el => el.getAttribute('role') === 'tab');
    expect(tabs.map(t => t.textContent)).toEqual(['New (7)', 'Already ticketed (3)', 'Stale (0)']);
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = must(tabs[0].getAttribute('aria-controls')!);
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);

    tabs[0].focus();
    tabs[0].dispatch('keydown', { key: 'ArrowRight' });
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'tab', tab: 'ticketed' });
    expect(page.document.activeElement?.id).toBe('tab-ticketed');

    must('tab-new').dispatch('keydown', { key: 'ArrowLeft' });
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'tab', tab: 'stale' });
    must('tab-new').dispatch('keydown', { key: 'End' });
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'tab', tab: 'stale' });
  });

  it('posts only the requests the tab accepts and never names the session', async () => {
    installCanned({
      state: boardState(baseView()),
      answer: async op => {
        if (op === 'preview') return { planId: 'p1', title: 'Create 7 ticket(s) in PROJ', lines: [], risky: true };
        if (op === 'save') return { outcome: 'saved' };
        throw { status: 404, message: 'Unknown request.' };
      },
    });
    await loadPage();
    await tick(must('include-N2'));
    await click(must('merge-selected'));
    await click(must('preview-create'));
    page.document.body.elements().find(el => el.tagName === 'dialog')?.close();
    await click(must('save-csv'));
    await click(must('reload-report'));

    expect(page.posted.length).toBeGreaterThan(4);
    for (const message of page.posted) {
      expect(ACCEPTED_OPS.has(message.op), message.op).toBe(true);
      expect(asBoardRequest(message)).toBeDefined();
    }
    expect(JSON.stringify(page.posted)).not.toContain(SESSION);
    expect(page.posted.map(m => m.op)).toEqual(expect.arrayContaining(['state', 'action', 'preview', 'save']));
  });

  it('a partial Apply shows each row\'s state, takes the done rows out of the selection and announces the summary', async () => {
    let finishApply!: (value: unknown) => void;
    installCanned({
      state: boardState(baseView()),
      answer: async op => {
        if (op === 'preview') {
          return { planId: 'p1', title: 'Create 7 ticket(s) in PROJ', risky: true, lines: [1, 2, 3, 4, 5, 6, 7].map(n => ({ target: `Flaw ${100 + n}`, change: 'New Bug' })) };
        }
        if (op === 'apply') return new Promise(resolve => { finishApply = resolve; });
        throw { status: 404, message: 'Unknown request.' };
      },
    });
    await loadPage();
    await click(must('preview-create'));
    const dialog = page.document.body.elements().find(el => el.tagName === 'dialog')!;
    await click(buttonNamed(dialog, 'Apply')!);

    // While the Apply runs: the rows written so far show their ticket, the rest wait, and every
    // control but the tabs is disabled.
    const during = baseView({ new: { rows: [1, 2, 3, 4, 5, 6, 7].map(n => newRow(n, n <= 2 ? { created: `PROJ-${n}` } : {})) } });
    await push({ view: during, applying: { done: 2, total: 7 } });
    expect(resultOf('N1')).toMatch(/Created PROJ-1/);
    expect(resultOf('N5')).toMatch(/Waiting to be written/);
    expect(live()).toMatch(/Applying: 2 of 7 done/);
    expect(must('preview-create').disabled).toBe(true);
    expect(must('include-N5').disabled).toBe(true);
    expect(must('tab-ticketed').disabled).toBeFalsy();

    const after = baseView({
      new: { rows: [1, 2, 3, 4, 5, 6, 7].map(n => newRow(n, n <= 4 ? { created: `PROJ-${n}`, createdUrl: `https://jira.example.com/browse/PROJ-${n}` } : {})) },
      ext: { ...baseView().ext, new: { toCreate: 3, perApply: 50, addedTo: {} } },
    });
    canned.state = { ...canned.state, view: after, applying: undefined, tick: canned.state.tick + 1, revision: 2 };
    finishApply({
      state: canned.state,
      results: [
        { target: 'Flaw 101: PROJ-1', outcome: 'done' },
        { target: 'Flaw 102: PROJ-2', outcome: 'done', reason: 'Jira did not accept Due Date, so it was left out' },
        { target: 'Flaw 103: PROJ-3', outcome: 'done' },
        { target: 'Flaw 104: PROJ-4', outcome: 'done' },
        { target: 'Flaw 105', outcome: 'failed', reason: 'Jira answered 500' },
        { target: '106', outcome: 'refused', reason: 'This row is no longer a new row without a ticket, so nothing was written.' },
        { target: '107', outcome: 'refused', reason: 'This row is no longer a new row without a ticket, so nothing was written.' },
      ],
    });
    await settle();

    expect(resultOf('N1')).toBe('Created PROJ-1');
    expect(rowEl('N1').elements().find(el => el.tagName === 'a')?.href).toBe('https://jira.example.com/browse/PROJ-1');
    expect(resultOf('N2')).toBe('Created PROJ-2. Jira did not accept Due Date, so it was left out');
    expect(resultOf('N5')).toBe('Failed: Jira answered 500');
    expect(resultOf('N6')).toMatch(/^Not written: /);
    // Done rows are no longer selectable; the rest keep their selection.
    expect(byId('include-N1')).toBeNull();
    expect(must('include-N5').checked).toBe(true);
    expect(must('apply-summary').textContent).toBe('Create 7 ticket(s) in PROJ: 4 of 7 written. 1 failed. 2 not written.');
    expect(live()).toContain('4 of 7 written. 1 failed. 2 not written.');
  });

  it('announces the out-of-date mark as text, and offers only Refresh on that tab', async () => {
    const view = baseView();
    view.tabs[0] = { ...view.tabs[0], outOfDate: true };
    installCanned({ state: boardState(view), answer: async () => canned.state });
    await loadPage();

    expect(must('tab-new').textContent).toBe('New (7, out of date)');
    expect(live()).toMatch(/New is out of date/);
    expect(must('preview-create').disabled).toBe(true);
    expect(must('include-N1').disabled).toBe(true);
    await click(must('refresh-tab'));
    expect(page.posted.at(-1)?.op).toBe('refresh');
  });

  it('announces an Apply refused by a running merge, and selecting rows still works', async () => {
    const view = baseView({
      ext: {
        ...baseView().ext,
        merge: {
          state: 'awaiting-close', mode: 'rewrite', survivor: 'PROJ-1', sources: ['PROJ-2'], actions: ['close', 'stop'],
          steps: [{ kind: 'survivor-rewrite', label: 'rewrite the kept ticket', key: 'PROJ-1', status: 'done' }, { kind: 'close', label: 'close', key: 'PROJ-2', status: 'pending' }],
          question: { groups: [{ issueType: 'Bug', tickets: ['PROJ-2'], targetOptions: [{ id: 'status:Done', label: 'Done' }], target: null, needsResolution: true, resolutionOptions: [{ id: 'resolution:Duplicate', label: 'Duplicate' }], resolution: null }], unanswered: ['Bug'] },
        },
      },
    });
    installCanned({
      state: boardState(view),
      answer: async op => {
        if (op === 'preview') throw { status: 400, message: 'A ticket merge is not finished. Finish or stop the merge first.' };
        throw { status: 404, message: 'Unknown request.' };
      },
    });
    await loadPage();
    // The run opens on its own tab; New is one arrow press away.
    expect(must('tab-merge').getAttribute('aria-selected')).toBe('true');
    await click(must('tab-new'));
    expect(must('panel-new').textContent).toMatch(/A ticket merge is running/);

    await click(must('preview-create'));
    expect(live()).toContain('A ticket merge is not finished. Finish or stop the merge first.');
    expect(must('include-N3').disabled).toBeFalsy();
    await tick(must('include-N3'));
    expect(actionsPosted().at(-1)).toEqual({ type: 'new-include', ids: ['N3'], included: false });
  });

  it('runs the ticket merge on its own tab: steps with status, the close questions, and acknowledge', async () => {
    const failed = { kind: 'link', label: 'link the tickets', key: 'PROJ-2', status: 'failed', error: 'Jira answered 403' };
    const merge = {
      state: 'failed', mode: 'rewrite', survivor: 'PROJ-1', sources: ['PROJ-2'], actions: ['retry', 'ignore', 'stop'], failed,
      steps: [{ kind: 'survivor-rewrite', label: 'rewrite the kept ticket', key: 'PROJ-1', status: 'done' }, failed],
    };
    installCanned({
      state: boardState(baseView({ tab: 'ticketed', new: undefined, ticketed: { show: 'all', rows: [ticketedRow(1), ticketedRow(2)] }, ext: { ...baseView().ext, merge } })),
      answer: async op => {
        if (op === 'preview') return { planId: 'p2', title: 'Retry', lines: [], risky: false };
        throw { status: 404, message: 'Unknown request.' };
      },
    });
    await loadPage();
    const panel = must('panel-merge');
    expect(panel.textContent).toContain('PROJ-2: link the tickets — Failed: Jira answered 403');
    expect(panel.textContent).toContain('PROJ-1: rewrite the kept ticket — Done');
    await click(must('merge-retry'));
    expect(page.posted.at(-1)).toMatchObject({ op: 'preview', body: { action: { type: 'merge-retry' } } });
    page.document.body.elements().find(el => el.tagName === 'dialog')?.close();
    expect(byId('merge-ignore')).not.toBeNull();
    expect(byId('merge-stop')).not.toBeNull();

    await push({
      view: baseView({
        tab: 'ticketed', new: undefined, ticketed: { show: 'all', rows: [] },
        ext: {
          ...baseView().ext,
          merge: {
            ...merge, state: 'awaiting-close', actions: ['close', 'stop'], failed: undefined,
            question: { groups: [{ issueType: 'Bug', tickets: ['PROJ-2'], targetOptions: [{ id: 'status:Done', label: 'Done' }], target: null, needsResolution: true, resolutionOptions: [{ id: 'resolution:Duplicate', label: 'Duplicate' }], resolution: null }], unanswered: ['Bug'] },
          },
        },
      }),
    });
    const target = must('merge-close-target-0');
    target.value = 'status:Done';
    target.dispatch('change');
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'merge-close-target', issueType: 'Bug', option: 'status:Done' });
    expect(must('preview-merge-close').disabled).toBe(true);

    await push({ view: baseView({ tab: 'ticketed', new: undefined, ticketed: { show: 'all', rows: [] }, ext: { ...baseView().ext, merge: { ...merge, state: 'finished', actions: ['acknowledge'], failed: undefined, report: { missing: [], closedWithout: [], workflowHint: false } } } }) });
    await click(must('merge-acknowledge'));
    expect(actionsPosted().at(-1)).toEqual({ type: 'merge-acknowledge' });
  });

  it('filters Already ticketed and sets all shown rows to one action', async () => {
    installCanned({
      state: boardState(baseView({
        tab: 'ticketed', new: undefined,
        ticketed: { show: 'decision', rows: [ticketedRow(1), ticketedRow(2), ticketedRow(3)] },
        ext: { ...baseView().ext, ticketed: { filter: 'changed', shown: ['A1'], noDueDate: ['A1'], notice: null, counts: { changed: 1, unchanged: 2, all: 3 }, actionLabels: { update: 'update', 'follow-up': 'new ticket', rewrite: 'rewrite', 're-create': 're-create', leave: 'leave' } } },
      })),
    });
    await loadPage();
    // Only the rows of the filter are shown.
    expect(byId('row-A1')).not.toBeNull();
    expect(byId('row-A2')).toBeNull();
    expect(must('filter-changed').getAttribute('aria-pressed')).toBe('true');
    expect(rowEl('A1').textContent).toContain('No Due Date');
    await click(must('filter-unchanged'));
    expect(actionsPosted().at(-1)).toEqual({ type: 'ticketed-filter', filter: 'unchanged' });
    const set = must('set-shown');
    set.value = 'rewrite';
    await click(must('set-shown-apply'));
    expect(actionsPosted().at(-1)).toEqual({ type: 'ticketed-set-shown', action: 'rewrite' });
    const action = must('action-A1');
    action.value = 'follow-up';
    action.dispatch('change');
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'ticketed-action', id: 'A1', action: 'follow-up' });
    expect(action.elements().find(o => o.value === 'follow-up')?.textContent).toBe('new ticket');
  });

  it('names the other open tickets on an Already ticketed row, and the dates side by side', async () => {
    installCanned({
      state: boardState(baseView({
        tab: 'ticketed', new: undefined,
        ticketed: { show: 'all', rows: [
          ticketedRow(1, { alsoOpen: [{ key: 'PROJ-9', url: 'https://jira.example.com/browse/PROJ-9' }], change: 'Policy date 2026-11-01 → 2026-12-01' }),
          ticketedRow(2),
        ] },
      })),
    });
    await loadPage();
    expect(rowEl('A1').textContent).toContain('also open: PROJ-9');
    const other = rowEl('A1').elements().find(el => el.tagName === 'a' && el.textContent === 'PROJ-9');
    expect(String(other?.href)).toBe('https://jira.example.com/browse/PROJ-9');
    expect(rowEl('A1').textContent).toContain('Policy date 2026-11-01 → 2026-12-01');
    expect(rowEl('A2').textContent).not.toContain('also open');
  });

  it('says how many findings the accepted list hid', async () => {
    installCanned({ state: boardState(baseView({ acceptedHidden: '2 accepted CVEs hidden · 1 accepted component hidden' })) });
    await loadPage();
    expect(must('accepted-hidden').textContent).toBe('2 accepted CVEs hidden · 1 accepted component hidden');
  });

  it('says there is nothing left to do and offers Close on a finished import', async () => {
    installCanned({ state: boardState(baseView({ finished: true, new: { rows: [] } })), answer: async () => ({ ok: true }) });
    await loadPage();
    expect(page.root.textContent).toContain('Nothing left to do');
    await click(must('discard-finished'));
    expect(page.posted.at(-1)?.op).toBe('discard');
  });

  it('offers to pick the file again when the report file is missing, and refuses writes meanwhile', async () => {
    installCanned({
      state: boardState(baseView(), { error: 'The report file /work/report.xml was not found.', errorCode: 'report-not-found', writesBlocked: true }),
      answer: async op => (op === 'pick-file' ? { outcome: 'picked', id: 'import-new', state: { ...canned.state, error: undefined, errorCode: undefined, writesBlocked: false } } : undefined),
    });
    await loadPage();
    expect(must('preview-create').disabled).toBe(true);
    await click(must('pick-file-again'));
    expect(page.posted.at(-1)).toMatchObject({ op: 'pick-file', body: {} });
    expect(must('preview-create').disabled).toBeFalsy();
  });
});

// ---- the real import kind behind the tab's message route ---------------------------------

const CRAFTED_FILE = '=HYPERLINK("https://evil.example")<img src=x onerror=alert(1)>[click](https://evil.example){color:red}x{color}.java';

describe('the import board page against the import kind', () => {
  let dir: string;
  let jira: EmptyProjectJira;
  let manager: SessionManager;
  let saved: Uint8Array[];

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-page-'));
    jira = new EmptyProjectJira();
    saved = [];
    const deps = emptyProjectImportDeps(dir, jira);
    manager = new SessionManager({
      store: new SessionStore(path.join(dir, 'sessions')),
      kinds: [registerKind(importKind, () => deps)],
      now: () => Date.now(),
      confirm: async () => true,
      saveFile: async file => { saved.push(file.bytes); return true; },
    });
  });

  afterEach(async () => {
    stopped = true;
    removeFakePage();
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('shows the crafted title as text, writes it to Jira through the sanitizers, and exports it with the formula prefix', async () => {
    const reportPath = path.join(dir, 'report.xml');
    fs.writeFileSync(reportPath, veracodeReport([CRAFTED_FILE]));
    const recipe: ImportRecipe = { kind: 'veracode', projectKey: 'PROJ', reportPath, templateName: 'Security bug', issueType: 'Bug' };
    const opened = await manager.open('import', recipe);
    if (!opened.ok) throw new Error(opened.reason);
    const tab = { kind: 'import', id: opened.id };
    stopped = false;
    let next = 1;
    page = installFakePage({ kind: 'import', session: opened.id, title: opened.title }, async (op, body) => {
      if (stopped) return new Promise(() => undefined);
      // The tab names the session; long waits are cut short for the test.
      const request = asBoardRequest({ id: next++, op, body: op === 'state' && body.wait ? { ...body, wait: 50 } : body })!;
      const reply = await answerBoardRequest(manager, tab, request, { openStored: async () => ({ ok: false, reason: 'no' }) }, () => undefined);
      if (!reply.ok) throw { status: reply.status, message: reply.error };
      return reply.data;
    });
    await loadPage();
    for (let n = 0; n < 50 && !byId('preview-create'); n++) await settle();

    const row = page.root.elements().find(el => el.tagName === 'tr' && el.textContent.includes('Flaw 101'))!;
    expect(row.textContent).toContain(CRAFTED_FILE);
    expect(page.document.body.elements().some(el => el.tagName === 'img')).toBe(false);
    expect(page.document.body.elements().some(el => el.tagName === 'a' && String(el.href ?? '').includes('evil.example'))).toBe(false);

    await click(must('preview-create'));
    const dialog = page.document.body.elements().find(el => el.tagName === 'dialog')!;
    await click(buttonNamed(dialog, 'Apply')!);
    for (let n = 0; n < 50 && jira.createIssueCalls.length === 0; n++) await settle();
    await settle();

    expect(jira.createIssueCalls).toHaveLength(1);
    const description = String(jira.createIssueCalls[0].additionalFields!.description);
    // The report's file name reaches the wiki description with its link, colour and table characters taken out.
    expect(description).toContain('|=HYPERLINK("https://evil.example")<img src=x onerror=alert(1)>click(https://evil.example)color:redxcolor.java|');
    expect(description).not.toContain('[click');
    expect(description).not.toContain('{color');
    for (let n = 0; n < 50 && !byId('apply-summary'); n++) await settle();
    expect(must('apply-summary').textContent).toMatch(/1 of 1 written/);

    for (const message of page.posted) expect(ACCEPTED_OPS.has(message.op), message.op).toBe(true);
    expect(JSON.stringify(page.posted)).not.toContain(opened.id);

    await click(must('save-csv'));
    for (let n = 0; n < 50 && saved.length === 0; n++) await settle();
    const csv = new TextDecoder().decode(saved[0]);
    expect(csv).toContain('"\'=HYPERLINK(""https://evil.example"")');
  });
});
