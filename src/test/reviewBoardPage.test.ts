import { afterEach, describe, expect, it, vi } from 'vitest';
import { asBoardRequest } from '../boards/boardMessages';
import type { BandView, FirstStepView, PassPickerView, ReviewResultsView, ReviewView } from '../boards/review/kind';
import type { BoardState } from '../sessions/sessionManager';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The pull request review board's page in its editor tab, and the review start screen's page: the
// first step (model, background: Jira ticket with its box, own text or none, Start), and the results:
// the summary band above the findings list and the detail pane, or the list with the finding over it
// on a narrow tab. The extension side is a canned state. Everything from Bitbucket, Jira or the model
// must reach the page as text, and rendered Markdown never as a live link.

const SESSION = '0123456789abcdef01234567';
const ACCEPTED_OPS = new Set(['state', 'action', 'run', 'stop', 'refresh', 'discard']);

let page: FakePage;
let stopped = false;
let state: BoardState;
let waiting: Array<() => void> = [];
/** What the extension answers the page's Copy and Post preview. */
let copyAnswer: unknown = { outcome: 'copied', count: 2 };
/** What the extension answers the page's Discuss in chat. */
let discussAnswer: unknown = { outcome: 'opened' };
let previewAnswer: unknown = { planId: 'p'.repeat(48), title: 'Post 1 comment(s)', lines: [{ target: '#2', change: 'Post inline' }], risky: true };
/** A refusal the extension gives an action, when set; `undefined` lets the action through. */
let refuseAction: ((action: Record<string, unknown>) => { status: number; message: string } | undefined) | undefined;

/** The width watchers the page set up; a test calls them as the browser does when the tab is resized. */
let resizeObservers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];

afterEach(() => {
  stopped = true;
  refuseAction = undefined;
  removeFakePage();
  delete (globalThis as Record<string, unknown>).ResizeObserver;
});

const byId = (id: string) => page.document.getElementById(id);
function must(id: string): FakeElement {
  const el = byId(id);
  if (!el) throw new Error(`No element #${id} on the page`);
  return el;
}
const click = async (el: FakeElement) => { el.dispatch('click'); await settle(); };
const posted = (op: string) => page.posted.filter(m => m.op === op).map(m => m.body);
/** Types into a field and leaves it, as the browser sends `input` then `change`. */
async function type(el: FakeElement, text: string, leave = true): Promise<void> {
  el.value = text;
  el.dispatch('input');
  if (leave) el.dispatch('change');
  await settle();
}

function firstStep(extra: Partial<FirstStepView> = {}): FirstStepView {
  return {
    choices: [
      { id: 'ticket', label: 'Jira ticket', available: true },
      { id: 'text', label: 'My own text', available: true },
      { id: 'none', label: 'None', available: true },
    ],
    choice: 'none', ticketKey: '', ownText: '',
    ticket: { text: '', state: 'idle', edited: false, readNeeded: false },
    canStart: true, storedReview: false, ...extra,
  };
}

function view(extra: Partial<ReviewView> = {}): ReviewView {
  return {
    pr: { label: 'PROJ/app#482', url: 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482', title: 'Add export', author: 'Jane Smith' },
    stage: 'first-step',
    model: { inUse: { id: 'gpt', label: 'GPT (copilot)', picked: false }, options: [{ id: 'gpt', label: 'GPT (copilot)' }] },
    firstStep: firstStep(),
    ownRunLine: true,
    ...extra,
  };
}

function counts(extra: Partial<BandView['counts']>): BandView['counts'] {
  return { total: 0, critical: 0, warning: 0, suggestion: 0, againstGoal: 0, ...extra };
}

function band(extra: Partial<BandView> = {}): BandView {
  return {
    state: 'open', counts: counts({ total: 2, critical: 1, suggestion: 1 }), background: 'Your text: “Watch the export”', notReviewed: [],
    tokens: '1,200 input and 300 output tokens in 3 call(s)', ...extra,
  };
}

function results(extra: Partial<ReviewResultsView> = {}): ReviewResultsView {
  return {
    model: 'GPT (copilot)', passesRun: ['Regular'],
    tokens: [{ pass: 'Regular pass', text: '1,200 input and 300 output tokens in 3 call(s)' }],
    statuses: [], hasReview: true, canRunAgain: true, picker: picker(),
    findings: [
      { number: 2, severity: 'critical', location: 'src/a.ts:4', title: 'SQL built from input', markers: [], selected: false },
      { number: 1, severity: 'suggestion', location: 'src/b.ts', title: 'Maybe a race', markers: ['location unverified'], selected: false },
    ],
    selectedCount: 0,
    post: { count: 0, blocker: 'Select the findings to post.' },
    copy: { scope: 'all', count: 2 },
    band: band(),
    reviewed: { files: ['src/a.ts', 'src/b.ts'], batches: 2, commit: 'abc123def456' },
    ...extra,
  };
}

function picker(extra: Partial<PassPickerView> = {}): PassPickerView {
  const choice = (step: PassPickerView['choices'][number]['step'], label: string) => ({ step, label, suggested: false, run: false, picked: false, available: true });
  return {
    suggestion: 'No extra pass is suggested. You can still pick any of them.',
    choices: [choice('security', 'The security pass'), choice('performance', 'The performance pass'), choice('reliability', 'The reliability pass'),
      choice('maintainability', 'The maintainability pass'), choice('critic', 'The critic')],
    canRun: false, runBlocker: 'Pick at least one pass.', ...extra,
  };
}

function boardState(v: ReviewView, extra: Partial<BoardState> = {}): BoardState {
  return {
    id: SESSION, kind: 'review', title: 'Review: PROJ/app#482', status: 'ready', tick: 1, revision: 1, asOf: 1_000,
    restored: false, stored: true, writesBlocked: false, view: v, ...extra,
  };
}

async function push(extra: Partial<BoardState>): Promise<void> {
  state = { ...state, ...extra, tick: state.tick + 1 };
  const wake = waiting;
  waiting = [];
  wake.forEach(w => w());
  await settle();
}

async function loadBoard(initial: BoardState): Promise<void> {
  state = initial;
  waiting = [];
  stopped = false;
  page = installFakePage({ kind: 'review', session: SESSION, title: initial.title }, async (op, body) => {
    if (stopped) return new Promise(() => undefined);
    if (op === 'state') {
      if (typeof body.tick === 'number' && body.tick === state.tick) {
        await new Promise<void>(resolve => waiting.push(resolve));
        if (stopped) return new Promise(() => undefined);
      }
      return state;
    }
    if (op === 'action') {
      const refusal = refuseAction?.(body.action as Record<string, unknown>);
      if (refusal) throw refusal;
      return state;
    }
    if (op === 'run') return state;
    if (op === 'copy') return copyAnswer;
    if (op === 'discuss') return discussAnswer;
    if (op === 'preview') return previewAnswer;
    throw { status: 404, message: 'Unknown request.' };
  });
  resizeObservers = [];
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    constructor(callback: (typeof resizeObservers)[number]) { resizeObservers.push(callback); }
    observe(): void {}
  };
  vi.resetModules();
  await import('../../board-pages/review/page.js' as string);
  await settle();
}

describe('the review board page: first step', () => {
  it('asks for a model when none is set, and the pick is sent as an action', async () => {
    await loadBoard(boardState(view({
      model: { options: [{ id: 'gpt', label: 'GPT (copilot)' }], askReason: 'ticketSidekick.bitbucket.reviewModel is empty. Pick the model every review call uses; it is saved to the setting.' },
      firstStep: firstStep({ canStart: false, startBlocker: 'Pick the model first.' }),
    })));
    expect(must('model').textContent).toMatch(/reviewModel is empty/);
    expect(must('start').disabled).toBe(true);
    const select = must('model-pick');
    select.value = 'gpt';
    select.dispatch('change');
    await settle();
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'pick-model', id: 'gpt' } }]);
    expect(posted('run')).toEqual([]);
  });

  it('shows the ticket choice as unavailable with its reason, and own text and none can still be picked', async () => {
    await loadBoard(boardState(view({
      firstStep: firstStep({ choices: [
        { id: 'ticket', label: 'Jira ticket', available: false, reason: 'Jira is not configured, so no ticket can be read.' },
        { id: 'text', label: 'My own text', available: true },
        { id: 'none', label: 'None', available: true },
      ] }),
    })));
    expect(must('background-ticket').disabled).toBe(true);
    expect(must('background-none').checked).toBe(true);
    expect(must('background-ticket-reason').textContent).toMatch(/Jira is not configured/);
    must('background-text').dispatch('change');
    await settle();
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'background', choice: 'text' } }]);
  });

  it('leaving the own text box sends only the text, and the first step has no goal, question or Reword', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ choice: 'text' }) })));
    await type(must('own-text'), 'only backend endpoint, export button later');
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'own-text', text: 'only backend endpoint, export button later' } }]);
    expect(posted('run')).toEqual([]);
    for (const id of ['goal', 'question', 'reword', 'points', 'reword-error']) expect(byId(id), id).toBeNull();
  });

  it('starts the ticket read the session asks for once, shows the box as being read and keeps Start waiting', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ choice: 'ticket', ticketKey: 'PROJ-12', ticket: { text: '', state: 'idle', edited: false, readNeeded: true } }) })));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'read-ticket' } }]);

    await push({ running: [{ size: 'call', what: 'read-ticket:PROJ-12', label: 'the read of PROJ-12', done: 0, total: 1 }],
      view: view({ firstStep: firstStep({ choice: 'ticket', ticketKey: 'PROJ-12', ticket: { text: '', state: 'reading', edited: false, readNeeded: false } }) }) });
    expect(must('ticket-state').textContent).toBe('Reading the ticket…');
    expect(must('ticket-text').disabled).toBe(true);
    expect(must('start').disabled).toBe(true);
    expect(posted('run')).toHaveLength(1);

    await push({ running: [], view: view({ firstStep: firstStep({ choice: 'ticket', ticketKey: 'PROJ-12', ticket: { text: 'Ticket PROJ-12: Add export', state: 'read', edited: false, readNeeded: false } }) }) });
    expect(must('ticket-text').value).toBe('Ticket PROJ-12: Add export');
    expect(must('start').disabled).toBeFalsy();
    await type(must('ticket-text'), 'Ticket PROJ-12: only the CSV part');
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'ticket-text', text: 'Ticket PROJ-12: only the CSV part' } }]);
  });

  it('shows why the ticket could not be read, and Start stays available', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({
      choice: 'ticket', ticketKey: 'PROJ-123',
      ticket: { text: '', state: 'failed', reason: 'The ticket PROJ-123 was not found in Jira, or you have no access to it.', edited: false, readNeeded: false },
    }) })));
    expect(must('ticket-reason').textContent).toBe('The ticket PROJ-123 was not found in Jira, or you have no access to it.');
    expect(must('start').disabled).toBeFalsy();
    expect(posted('run')).toEqual([]);
  });

  it('Start sends a typed own text first, then starts the regular pass; nothing else is posted', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ choice: 'text' }) })));
    await type(must('own-text'), 'does this handle retries?', false);
    await click(must('start'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'own-text', text: 'does this handle retries?' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'start' } }]);
    for (const message of page.posted) {
      expect(ACCEPTED_OPS.has(message.op), message.op).toBe(true);
      expect(asBoardRequest(message)).toBeDefined();
    }
    expect(JSON.stringify(page.posted)).not.toContain(SESSION);
  });
});

type F = ReviewResultsView['findings'][number];
const f2 = (extra: Partial<F> = {}): F => ({ number: 2, severity: 'critical', location: 'src/a.ts:4', title: 'SQL built from input', markers: [], selected: false, ...extra });
const f1 = (extra: Partial<F> = {}): F => ({ number: 1, severity: 'suggestion', location: 'src/b.ts', title: 'Maybe a race', markers: [], selected: false, ...extra });
const draft = (extra: Partial<NonNullable<F['draft']>> = {}): NonNullable<F['draft']> => ({
  text: 'Draft of #2', outdated: false, canUndo: false, preview: [{ type: 'paragraph', children: [{ type: 'text', text: 'Draft of #2' }] }], ...extra,
});
const selected2 = (extra: Partial<ReviewResultsView> = {}, d: Partial<NonNullable<F['draft']>> = {}, f: Partial<F> = {}) => results({
  findings: [f2({ selected: true, draft: draft(d), ...f }), f1()],
  selectedCount: 1, post: { count: 1 }, copy: { scope: 'selected', count: 1 }, ...extra,
});
const stage = 'review' as const;
const reviewView = (r: ReviewResultsView, extra: Partial<ReviewView> = {}) => view({ stage, results: r, ...extra });
/** Picks a finding in the list, as a click on its entry does. */
const openEntry = (n: number) => click(must(`entry-${n}`));
/** The ids of the elements on the page, in document order, among `ids`. */
const orderOf = (ids: string[]) => page.root.elements().map(el => el.id).filter(id => ids.includes(id));
const inside = (outer: string, id: string) => must(outer).elements().some(el => el.id === id);

describe('the review board page: the results stage', () => {
  it('shows the band above two columns, the list on the left and the review so far on the right, with nothing picked', async () => {
    await loadBoard(boardState(reviewView(results({ findings: [f2(), f1({ markers: ['location unverified'] })] }))));
    expect(must('pr-line').textContent).toBe('PROJ/app#482 Add export by Jane Smith');
    expect(orderOf(['band', 'columns', 'findings-column', 'detail'])).toEqual(['band', 'columns', 'findings-column', 'detail']);
    expect(inside('findings-column', 'findings')).toBe(true);
    expect(must('finding-2').textContent).toBe('#2 Critical SQL built from input src/a.ts:4');
    expect(must('finding-1').textContent).toBe('#1 Suggestion Maybe a race src/b.ts location unverified');
    expect(must('select-2').tagName).toBe('input');
    expect(page.root.elements().some(el => el.getAttribute('aria-current') === 'true')).toBe(false);
    expect(byId('review-so-far')).toBeTruthy();
    for (const id of ['coverage', 'recheck', 'requirements-source', 'requirements-failure', 'reword']) expect(byId(id), id).toBeNull();
  });

  it('every marker in the list is a word that is shown', async () => {
    const markers = ['against goal', 'probably a false alarm', 'draft', 'posted'];
    await loadBoard(boardState(reviewView(results({ findings: [f2({ markers })] }))));
    const shown = must('finding-2').elements().filter(el => (el.getAttribute('class') ?? '').split(' ').includes('marker'));
    expect(shown.map(el => el.textContent)).toEqual(markers);
  });

  it('shows crafted finding text as plain text: no HTML or link becomes an element', async () => {
    const crafted = '<img src=x onerror=alert(1)>[click](https://evil.example) <b>bold</b>';
    await loadBoard(boardState(view({
      stage, pr: { label: 'PROJ/app#482', url: 'u', title: crafted, author: crafted },
      results: results({ findings: [{ number: 1, severity: 'warning', location: crafted, title: crafted, markers: [], selected: false, description: crafted }] }),
    })));
    await openEntry(1);
    expect(must('finding-1').textContent).toContain(crafted);
    expect(must('description-1').textContent).toBe(crafted);
    expect(page.document.body.elements().some(el => ['img', 'b', 'a'].includes(el.tagName))).toBe(false);
  });

  it('marks an out-of-date review and offers New review, which goes back to the first step', async () => {
    await loadBoard(boardState(reviewView(results({ outOfDate: { reviewed: 'abc123def456', head: 'fff000fff000' } }))));
    expect(must('out-of-date').textContent).toMatch(/new commit \(fff000fff000\).*abc123def456/);
    await click(must('new-review'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'new-review' } }]);
  });

  it('a pass that found nothing says "No issues found" in the list and what was reviewed in the detail pane', async () => {
    await loadBoard(boardState(reviewView(results({ findings: [], band: band({ counts: counts({}) }) }))));
    expect(must('no-issues').textContent).toBe('No issues found.');
    expect(must('reviewed-summary').textContent).toBe('Reviewed 2 files in 2 batches at commit abc123def456.');
    expect(must('reviewed-files').textContent).toBe('src/a.tssrc/b.ts');
    expect(byId('pass-picker')).toBeTruthy();
  });

  it('a regular pass whose batches all failed shows the failure banner and Run again, and no columns', async () => {
    await loadBoard(boardState(reviewView(results({
      hasReview: false, picker: undefined, findings: [], passesRun: [], reviewed: undefined,
      statuses: ['The regular pass failed: The model is overloaded No batch gave a readable reply, so there are no findings. Run again tries once more.'],
    }))));
    expect(must('pass-status-0').textContent).toMatch(/^The regular pass failed/);
    for (const id of ['pass-picker', 'columns', 'findings', 'no-issues', 'run-selected']) expect(byId(id), id).toBeFalsy();
    expect(byId('run-again')).toBeTruthy();
  });
});

describe('the review board page: the summary band', () => {
  it('after the regular pass the band is open with the counts and Security preselected; picking a finding folds it to one line with More passes', async () => {
    const p = picker({ suggestion: 'Suggested: the security pass.', canRun: true, runBlocker: undefined });
    p.choices[0] = { ...p.choices[0], suggested: true, picked: true };
    const nine = results({ picker: p, band: band({ counts: counts({ total: 9, critical: 2, warning: 5, suggestion: 2, againstGoal: 1 }) }) });
    await loadBoard(boardState(reviewView(nine)));
    expect(must('band-counts').textContent).toBe('9 findings · 2 critical · 5 warnings · 2 suggestions · 1 against goal');
    expect(must('pass-security').checked).toBe(true);
    expect(must('run-selected').textContent).toBe('Run selected (1)');
    expect(must('band-background').textContent).toBe('Background: Your text: “Watch the export”');
    expect(must('tokens').textContent).toBe('Regular pass: 1,200 input and 300 output tokens in 3 call(s)');

    await openEntry(2);
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'band', open: false } }]);
    expect(must('detail-title').textContent).toBe('#2 · SQL built from input');

    await push({ view: reviewView({ ...nine, band: { ...nine.band, state: 'folded' } }) });
    expect(byId('pass-picker')).toBeNull();
    expect(must('band-line').textContent).toBe(
      '9 findings · 2 critical · 5 warnings · 2 suggestions · 1 against goal · passes: Regular · background: Your text: “Watch the export” · not reviewed: 0 · tokens: 1,200 input and 300 output tokens in 3 call(s)');
    expect(must('detail-title').textContent).toBe('#2 · SQL built from input');
    await click(must('more-passes'));
    expect(posted('action').at(-1)).toEqual({ revision: 1, action: { type: 'band', open: true } });
    expect(byId('run-again')).toBeTruthy();
  });

  it('a tick picks a pass, Run selected starts one run, a pass run is marked, and Not now is an action', async () => {
    const p = picker({ suggestion: 'Suggested: the security pass.', canRun: true, runBlocker: undefined });
    p.choices[0] = { ...p.choices[0], run: true, available: false, reason: 'Run already.' };
    p.choices[4] = { ...p.choices[4], picked: true };
    await loadBoard(boardState(reviewView(results({ picker: p }))));
    expect(must('pass-security').disabled).toBe(true);
    expect(must('pass-security-run').textContent).toBe(' (run)');
    const performance = must('pass-performance');
    performance.checked = true;
    performance.dispatch('change');
    await settle();
    await click(must('run-selected'));
    await click(must('keep-as-is'));
    expect(must('keep-as-is').textContent).toBe('Not now');
    expect(posted('action')).toEqual([
      { revision: 1, action: { type: 'pick-pass', step: 'performance', picked: true } },
      { revision: 1, action: { type: 'keep-as-is' } },
    ]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'passes' } }]);
  });

  it('while two passes run the band shows a line per pass, the background and the tokens so far, and its own Stop; the header has no run line or Stop', async () => {
    const running = [{ size: 'pass' as const, what: 'passes', label: 'the security and reliability passes', done: 7, total: 14 }];
    const r = results({
      band: band({ state: 'running', tokens: '41,000 input and 6,000 output tokens in 8 call(s)' }),
      running: {
        what: 'passes', step: 'security', done: 5, total: 7,
        passes: [{ step: 'security', text: 'Security pass: 5 of 7 batches', done: 5, total: 7 }, { step: 'reliability', text: 'Reliability pass: 3 of 7 batches', done: 3, total: 7 }],
      },
    });
    await loadBoard(boardState(reviewView(r, { progress: 'Security pass: 5 of 7 batches; Reliability pass: 3 of 7 batches' }), { running }));
    expect(must('run-line-security').textContent).toBe('Security pass: 5 of 7 batches');
    expect(must('run-line-reliability').textContent).toBe('Reliability pass: 3 of 7 batches');
    expect(must('band-background').textContent).toBe('Background: Your text: “Watch the export”');
    expect(must('band-tokens').textContent).toBe('Tokens so far: 41,000 input and 6,000 output tokens in 8 call(s)');
    expect(page.root.textContent).not.toContain('Running the security and reliability passes');
    expect(byId('run-progress')).toBeNull();
    expect(inside('band', 'stop-run')).toBe(true);
    for (const id of ['select-2', 'select-all', 'post', 'refresh', 'discard']) expect(must(id).disabled, id).toBe(true);
    expect(must('entry-2').disabled).toBeFalsy();
    expect(must('stop-run').disabled).toBeFalsy();
    expect(must('board-live').textContent).toBe('Security pass: 5 of 7 batches; Reliability pass: 3 of 7 batches');
    await click(must('stop-run'));
    expect(page.posted.filter(m => m.op === 'stop')).toHaveLength(1);
  });

  it('a board restored after a restart mid-pass shows the interrupted banner and no running state', async () => {
    await loadBoard(boardState(reviewView(results({
      statuses: ['The security pass was cut off by a restart: 2 of 5 batches finished, and their findings are kept. It is not marked as run, so you can pick it again.'],
    })), { restored: true }));
    expect(must('pass-status-0').textContent).toMatch(/cut off by a restart: 2 of 5 batches finished/);
    expect(byId('stop-run')).toBeFalsy();
    expect(must('run-selected').disabled).toBe(true);
    expect(must('pass-security').disabled).toBeFalsy();
  });

  it('lists what the passes did not review and the findings they dropped in the band, as text', async () => {
    const crafted = '<b>src/evil.ts</b>';
    await loadBoard(boardState(reviewView(results({
      statuses: ['1 of 3 batches of the regular pass had a part that failed; the findings of the others are shown.'],
      notes: [`regular batch 2/3 — could not review ${crafted} after retrying: overloaded`, '2 findings were removed by the critic as unverifiable: #3, #4.'],
    }))));
    expect(must('review-note-0').textContent).toBe(`regular batch 2/3 — could not review ${crafted} after retrying: overloaded`);
    expect(must('review-note-1').textContent).toBe('2 findings were removed by the critic as unverifiable: #3, #4.');
    expect(orderOf(['pass-status-0', 'band', 'review-notes', 'findings'])).toEqual(['pass-status-0', 'band', 'review-notes', 'findings']);
    expect(page.document.body.elements().some(el => el.tagName === 'b')).toBe(false);
  });
});

describe('the review board page: findings arriving while the regular pass runs', () => {
  const runningRegular = (done: number) => [{ size: 'pass' as const, what: 'regular', label: 'the regular pass', done, total: 3 }];
  const live = (done: number, findings: F[], extra: Partial<ReviewResultsView> = {}) => reviewView(results({
    hasReview: false, picker: undefined, passesRun: [], tokens: [], findings,
    band: band({ state: 'running', counts: counts({ total: findings.length, critical: findings.filter(f => f.severity === 'critical').length, warning: 0, suggestion: findings.filter(f => f.severity === 'suggestion').length }) }),
    running: { what: 'regular', step: 'regular', done, total: 3 }, ...extra,
  }), { progress: `Regular pass: ${done} of 3 batches` });

  it('before the first batch finishes the list says none are found yet and nothing is reviewed', async () => {
    await loadBoard(boardState(live(0, [], { reviewed: undefined }), { running: runningRegular(0) }));
    expect(must('no-findings-yet').textContent).toBe('No findings yet.');
    expect(byId('no-issues')).toBeFalsy();
    expect(byId('pass-picker')).toBeFalsy();
    expect(must('reviewed-summary').textContent).toBe('Nothing reviewed yet.');
  });

  it('while findings arrive and none is picked, the detail pane shows the counts and what was reviewed, and nothing is selected', async () => {
    await loadBoard(boardState(live(1, [f2(), f1()]), { running: runningRegular(1) }));
    expect(must('so-far-counts').textContent).toBe('2 findings · 1 critical · 0 warnings · 1 suggestion · 0 against goal');
    expect(must('reviewed-summary').textContent).toBe('Reviewed 2 files in 2 batches at commit abc123def456. 1 of 3 batches finished so far.');
    expect(page.root.elements().some(el => el.getAttribute('aria-current') === 'true')).toBe(false);
    expect(must('findings-heading').textContent).toBe('Findings (2) — more coming');
  });

  it('the list grows on repaint, the picked finding stays picked and focused, and the list keeps its scroll position; Explain waits', async () => {
    await loadBoard(boardState(live(1, [f2(), f1()]), { running: runningRegular(1) }));
    await openEntry(1);
    must('entry-1').focus();
    must('findings').scrollTop = 80;
    expect(posted('action')).toEqual([]);
    await push({ running: runningRegular(2), view: live(2, [f2(), { ...f1(), number: 3, title: 'Another' }, f1()]) });
    expect(byId('finding-3')).toBeTruthy();
    expect(must('entry-1').getAttribute('aria-current')).toBe('true');
    expect(page.document.activeElement?.id).toBe('entry-1');
    expect(must('findings').scrollTop).toBe(80);
    expect(must('detail-title').textContent).toBe('#1 · Maybe a race');
    expect(must('explain-1').disabled).toBe(true);
  });
});

describe('the review board page: the detail pane', () => {
  it('shows the finding\'s line, provenance, confidence and source, its description and recommendation, as text', async () => {
    const crafted = '<img src=x onerror=alert(1)> [click](https://evil.example)';
    await loadBoard(boardState(reviewView(results({
      findings: [f2({
        location: 'src/a.ts:19', facts: ['L19 (also L12, L15)', 'new code', 'confidence 0.9', 'source: security, general'],
        description: `The id reaches the query unchecked. ${crafted}`, recommendation: 'Use a bound parameter.',
      })],
    }))));
    await openEntry(2);
    expect(must('facts-2').textContent).toBe('L19 (also L12, L15) · new code · confidence 0.9 · source: security, general');
    expect(must('description-2').textContent).toBe(`The id reaches the query unchecked. ${crafted}`);
    expect(must('recommendation-2').textContent).toBe('Recommendation: Use a bound parameter.');
    expect(page.document.body.elements().some(el => el.tagName === 'img' || el.tagName === 'a')).toBe(false);
  });

  it('shows the code around the finding\'s line with its line numbers and the line marked; an unverified one shows no code and says so', async () => {
    await loadBoard(boardState(reviewView(results({
      findings: [
        f2({ excerpt: [{ line: 3, kind: 'context', text: 'const q = "SELECT";' }, { line: 4, kind: 'added', text: 'run(q + id);', marked: true }, { line: 4, kind: 'removed', text: 'run(q, [id]);' }] }),
        f1({ markers: ['location unverified'], excerptNote: 'The location could not be verified, so no code is shown.' }),
      ],
    }))));
    await openEntry(2);
    const lines = must('code-2').children;
    expect(lines.map(l => l.children[0].textContent)).toEqual(['3', '4', '4']);
    expect(lines.map(l => l.children[1].textContent)).toEqual([' ', '+', '-']);
    expect(lines.filter(l => (l.getAttribute('class') ?? '').includes('marked')).map(l => l.textContent)).toEqual(['4+The finding\'s line: run(q + id);']);
    await openEntry(1);
    expect(byId('code-1')).toBeNull();
    expect(must('code-note-1').textContent).toBe('The location could not be verified, so no code is shown.');
  });

  it('Explain starts one run for its finding, shows Explaining… while it runs, and the answer rendered from its tree after', async () => {
    await loadBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    await openEntry(2);
    await click(must('explain-2'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'explain', number: 2 } }]);
    await push({ running: [{ size: 'call', what: 'explain:2', label: 'the explanation of #2', done: 0, total: 1 }] });
    expect(must('explain-2').disabled).toBe(true);
    expect(must('explain-2').textContent).toBe('Explaining…');
    expect(must('select-1').disabled).toBeFalsy();
    const answer = 'Because **the id** is used:\n\n```diff\n+run(q + id);\n```';
    const tree: NonNullable<F['thread']>[number]['tree'] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'Because ' }, { type: 'strong', children: [{ type: 'text', text: 'the id' }] }, { type: 'text', text: ' is used:' }] },
      { type: 'code-block', language: 'diff', spans: [{ text: '+run(q + id);', cls: 'hljs-addition' }, { text: '\n' }] },
    ];
    await push({ running: undefined, view: reviewView(results({ band: band({ state: 'folded' }), findings: [f2({ thread: [{ question: 'Explain', answer, tree }] }), f1()] })) });
    expect(must('turn-2-1').textContent).toBe('ExplainBecause the id is used:+run(q + id);\n');
    expect(must('answer-2-1').elements().map(e => e.tagName)).toEqual(['p', 'strong', 'pre', 'code', 'span']);
    expect(byId('explain-2')).toBeFalsy();
  });

  it('a link in an answer carries its target as data, not as a link, and opens through the extension', async () => {
    const tree: NonNullable<F['thread']>[number]['tree'] = [{ type: 'paragraph', children: [{ type: 'link', href: 'https://owasp.org/x', children: [{ type: 'text', text: 'OWASP' }] }] }];
    await loadBoard(boardState(reviewView(results({ findings: [f2({ thread: [{ question: 'Explain', answer: '[OWASP](https://owasp.org/x)', tree }] })] }))));
    await openEntry(2);
    expect(page.document.body.elements().some(el => el.getAttribute('href') !== null || el.href !== undefined)).toBe(false);
    const link = must('answer-2-1').elements().find(el => el.getAttribute('role') === 'link')!;
    expect(link.getAttribute('data-url')).toBe('https://owasp.org/x');
    link.dispatch('keydown', { key: 'Enter' });
    await settle();
    expect(posted('open-link')).toEqual([{ url: 'https://owasp.org/x' }]);
  });

  it('a follow-up starts one run with the typed question and keeps the box locked while it runs; the new turn shows below the first', async () => {
    const turn = (question: string, answer: string) => ({ question, answer, tree: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: answer }] }] });
    await loadBoard(boardState(reviewView(results({ findings: [f2({ thread: [turn('Explain', 'First answer.')] }), f1()] }))));
    await openEntry(2);
    await type(must('follow-up-question-2'), 'Is it reachable?', false);
    await click(must('follow-up-2'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'follow-up', number: 2, question: 'Is it reachable?' } }]);
    await push({ running: [{ size: 'call', what: 'follow-up:2', label: 'the follow-up on #2', done: 0, total: 1 }] });
    expect(must('follow-up-2').disabled).toBe(true);
    expect(must('follow-up-2').textContent).toBe('Asking…');
    await push({ running: undefined, view: reviewView(results({ findings: [f2({ thread: [turn('Explain', 'First answer.'), turn('Is it reachable?', 'Yes.')] }), f1()] })) });
    expect(must('turn-2-1').textContent).toContain('First answer.');
    expect(must('turn-2-2').textContent).toBe('You: Is it reachable?Yes.');
    expect(must('follow-up-question-2').value).toBe('');
  });

  it('a checkbox in the list selects one finding, Select all in the footer every finding, and Draft a comment selects the open one', async () => {
    await loadBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    expect(must('post').disabled).toBe(true);
    const box = must('select-2');
    box.checked = true;
    box.dispatch('change');
    await settle();
    const all = must('select-all');
    all.checked = true;
    all.dispatch('change');
    await settle();
    await openEntry(1);
    await click(must('draft-start-1'));
    expect(posted('action')).toEqual([
      { revision: 1, action: { type: 'select', numbers: [2], selected: true } },
      { revision: 1, action: { type: 'select', numbers: [2, 1], selected: true } },
      { revision: 1, action: { type: 'select', numbers: [1], selected: true } },
    ]);
  });

  it('shows the draft of the open finding; it is saved on leaving the box, and an outdated draft offers Regenerate', async () => {
    await loadBoard(boardState(reviewView(selected2({ band: band({ state: 'folded' }) }, { outdated: true }))));
    await openEntry(2);
    expect(must('draft-2').value).toBe('Draft of #2');
    expect(must('outdated-2').textContent).toMatch(/discussion changed/);
    await type(must('draft-2'), 'My comment');
    await click(must('regenerate-2'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'My comment' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'regenerate', number: 2 } }]);
    expect(must('post').textContent).toBe('Post 1 comment');
    expect(must('copy-markdown').textContent).toBe('Copy 1 selected as Markdown');
  });

  it('Preview shows the draft with its diff block highlighted; turning Preview off shows the same text in the box', async () => {
    const text = 'Use a bound parameter:\n\n```diff\n-run(q + id);\n+run(q, [id]);\n```';
    const preview: NonNullable<F['draft']>['preview'] = [
      { type: 'paragraph', children: [{ type: 'text', text: 'Use a bound parameter:' }] },
      { type: 'code-block', language: 'diff', spans: [{ text: '-run(q + id);', cls: 'hljs-deletion' }, { text: '\n' }, { text: '+run(q, [id]);', cls: 'hljs-addition' }, { text: '\n' }] },
    ];
    await loadBoard(boardState(reviewView(selected2({ band: band({ state: 'folded' }) }, { text, preview }))));
    await openEntry(2);
    await click(must('draft-preview-2'));
    expect(byId('draft-2')).toBeNull();
    expect(must('draft-preview-2').getAttribute('aria-pressed')).toBe('true');
    const body = must('draft-preview-body-2');
    expect(body.elements().filter(el => el.tagName === 'span').map(el => [el.getAttribute('class'), el.textContent])).toEqual([
      ['hljs-deletion', '-run(q + id);'], ['hljs-addition', '+run(q, [id]);'],
    ]);
    expect(body.elements().some(el => el.getAttribute('href') !== null)).toBe(false);
    await click(must('draft-edit-2'));
    expect(must('draft-2').value).toBe(text);
    expect(posted('action')).toEqual([]);
  });

  it('Rewrite saves a typed draft first, then runs with the typed instruction; the box is locked while it runs, and Undo and the error line show after', async () => {
    const folded = { band: band({ state: 'folded' as const }) };
    await loadBoard(boardState(reviewView(selected2(folded))));
    await openEntry(2);
    await type(must('draft-2'), 'Hand-edited', false);
    await type(must('instruction-2'), 'Make it shorter', false);
    await click(must('rewrite-2'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'Hand-edited' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'rewrite', number: 2, instruction: 'Make it shorter' } }]);
    await push({ running: [{ size: 'call', what: 'rewrite:2', label: 'the rewrite', done: 0, total: 1 }] });
    expect(must('draft-2').disabled).toBe(true);
    expect(must('rewrite-2').textContent).toBe('Rewriting…');
    expect(must('select-1').disabled).toBeFalsy();
    await push({ running: undefined, view: reviewView(selected2(folded, { text: 'Hand-edited', rewriteError: 'Rewrite failed: model unavailable' })) });
    expect(must('rewrite-error-2').textContent).toBe('Rewrite failed: model unavailable');
    await push({ view: reviewView(selected2(folded, { text: 'Shorter', canUndo: true })) });
    await click(must('undo-2'));
    expect(posted('action').at(-1)).toEqual({ revision: 1, action: { type: 'undo-rewrite', number: 2 } });
  });

  it('Post saves a typed draft, then asks for the preview; a posted draft is read-only and a failed one says why', async () => {
    const folded = { band: band({ state: 'folded' as const }) };
    await loadBoard(boardState(reviewView(selected2(folded))));
    await openEntry(2);
    await type(must('draft-2'), 'Final words', false);
    await click(must('post'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'Final words' } }]);
    expect(posted('preview')).toEqual([{ revision: 1, action: { type: 'post' } }]);
    await push({ view: reviewView(results({ ...folded, findings: [f2({ draft: draft({ posted: 'Posted as comment 100.' }) }), f1({ selected: true, draft: draft({ text: 'x', postError: 'Not posted: Bitbucket said 500' }) })] })) });
    expect(must('draft-2').disabled).toBe(true);
    expect(must('posted-2').textContent).toBe('Posted as comment 100.');
    await openEntry(1);
    expect(must('post-error-1').textContent).toBe('Not posted: Bitbucket said 500');
  });

  it('Copy names the format and the selected numbers only, and says what was copied in the live region', async () => {
    copyAnswer = { outcome: 'copied', count: 1 };
    await loadBoard(boardState(reviewView(selected2())));
    await click(must('copy-teams'));
    expect(posted('copy')).toEqual([{ format: 'teams', numbers: [2] }]);
    expect(must('copy-result').textContent).toBe('Copied 1 finding.');
    expect(must('board-live').textContent).toBe('Copied 1 finding.');
    copyAnswer = { outcome: 'failed', reason: 'clipboard unavailable' };
    await click(must('copy-markdown'));
    expect(posted('copy').at(-1)).toEqual({ format: 'markdown', numbers: [2] });
    expect(must('copy-result').textContent).toBe('Not copied: clipboard unavailable');
  });

  it('Copy with nothing selected sends no numbers, for every finding', async () => {
    copyAnswer = { outcome: 'copied', count: 2 };
    await loadBoard(boardState(reviewView(results())));
    expect(must('copy-teams').textContent).toBe('Copy all 2 for Teams');
    await click(must('copy-markdown'));
    expect(posted('copy')).toEqual([{ format: 'markdown', numbers: [] }]);
    expect(must('copy-result').textContent).toBe('Copied 2 findings.');
  });

  it('the Copy and Discuss result lines of one review are gone when a new review starts', async () => {
    copyAnswer = { outcome: 'copied', count: 2 };
    discussAnswer = { outcome: 'opened' };
    await loadBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    await openEntry(2);
    await click(must('discuss-2'));
    await click(must('copy-markdown'));
    expect(must('copy-result').textContent).toBe('Copied 2 findings.');

    await push({ view: view({ firstStep: firstStep() }) });
    await push({ view: reviewView(results({ band: band({ state: 'folded' }) })) });
    expect(byId('copy-result')).toBeNull();
    expect(byId('discuss-result-2')).toBeNull();
  });

  it('Discuss in chat names only the finding number, and says when the prompt was copied because the chat could not open', async () => {
    discussAnswer = { outcome: 'opened' };
    await loadBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    await openEntry(2);
    await click(must('discuss-2'));
    expect(posted('discuss')).toEqual([{ number: 2 }]);
    expect(must('discuss-result-2').textContent).toBe('Copilot Chat is open with a prompt about #2. Add your question and send it.');
    discussAnswer = { outcome: 'copied' };
    await openEntry(1);
    await click(must('discuss-1'));
    expect(posted('discuss').at(-1)).toEqual({ number: 1 });
    expect(must('discuss-result-1').textContent).toMatch(/^Copilot Chat could not be opened, so the prompt about #1 was copied\./);
    expect(must('board-live').textContent).toMatch(/prompt about #1 was copied/);
  });
});

describe('the review board page on a narrow tab', () => {
  async function narrowBoard(initial: BoardState): Promise<void> {
    await loadBoard(initial);
    for (const observer of resizeObservers) observer([{ contentRect: { width: 420 } }]);
    await settle();
  }

  it('the list fills the tab; a picked finding opens over the list, and Escape returns the focus to the same entry', async () => {
    await narrowBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    expect(must('columns').getAttribute('class')).toBe('columns narrow');
    expect(byId('detail')).toBeNull();
    await openEntry(2);
    expect(inside('findings-column', 'detail')).toBe(true);
    expect(must('detail').getAttribute('class')).toBe('detail overlay');
    expect(page.document.activeElement?.id).toBe('back-to-list');
    expect(byId('findings-actions')).toBeTruthy();
    must('detail').dispatch('keydown', { key: 'Escape' });
    await settle();
    expect(byId('detail')).toBeNull();
    expect(page.document.activeElement?.id).toBe('entry-2');
  });

  it('Back closes the finding and returns to the same entry; going wide again shows both columns', async () => {
    await narrowBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    await openEntry(1);
    await click(must('back-to-list'));
    expect(byId('detail')).toBeNull();
    expect(page.document.activeElement?.id).toBe('entry-1');
    for (const observer of resizeObservers) observer([{ contentRect: { width: 1400 } }]);
    await settle();
    expect(must('columns').getAttribute('class')).toBe('columns');
    expect(byId('detail')).toBeTruthy();
  });

  it('with #3 open over the list, the footer stays and its Copy menu offers both formats for the selected findings', async () => {
    copyAnswer = { outcome: 'copied', count: 1 };
    const three = results({
      band: band({ state: 'folded' }), findings: [f2(), { ...f1(), number: 3, title: 'Third', selected: true }, f1()],
      selectedCount: 1, post: { count: 1 }, copy: { scope: 'selected', count: 1 },
    });
    await narrowBoard(boardState(reviewView(three)));
    await openEntry(3);
    expect(byId('copy-teams')).toBeNull();
    for (const id of ['select-all', 'post', 'copy-menu']) expect(inside('findings-actions', id), id).toBe(true);
    expect(byId('detail')).toBeTruthy();
    await click(must('copy-menu'));
    expect(must('copy-menu').getAttribute('aria-expanded')).toBe('true');
    expect(must('copy-teams').textContent).toBe('Copy for Teams');
    expect(must('copy-markdown').textContent).toBe('Copy as Markdown');
    expect(page.document.activeElement?.id).toBe('copy-teams');
    await click(must('copy-markdown'));
    expect(posted('copy')).toEqual([{ format: 'markdown', numbers: [3] }]);
    expect(byId('copy-menu-items')).toBeNull();
  });

  it('the Copy menu closes on a press outside it, and on Escape with the focus elsewhere', async () => {
    await narrowBoard(boardState(reviewView(results({ band: band({ state: 'folded' }) }))));
    await click(must('copy-menu'));
    expect(byId('copy-menu-items')).toBeTruthy();
    page.document.dispatch('pointerdown', { target: must('copy-teams') });
    page.document.dispatch('pointerup');
    await settle();
    expect(byId('copy-menu-items')).toBeTruthy();

    page.document.dispatch('pointerdown', { target: must('select-all') });
    page.document.dispatch('pointerup');
    await settle();
    expect(byId('copy-menu-items')).toBeNull();

    await click(must('copy-menu'));
    must('select-all').focus();
    page.document.dispatch('keydown', { key: 'Escape' });
    await settle();
    expect(byId('copy-menu-items')).toBeNull();
    expect(page.document.activeElement?.id).toBe('copy-menu');
  });
});

describe('the review board page: a field left by pressing a button', () => {
  const withDraft = (d: Partial<NonNullable<F['draft']>> = {}) => results({
    findings: [f2({ selected: true, draft: draft({ outdated: true, canUndo: true, ...d }) })],
    selectedCount: 1, post: { count: 1 }, copy: { scope: 'selected', count: 1 },
  });

  it('a mouse press on Start after typing the own text saves it first and starts once; the button is not replaced under the pointer', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ choice: 'text' }) })));
    const start = must('start');
    const question = must('own-text');
    question.value = 'does this handle retries?';
    question.dispatch('input');
    // The press: the pointer goes down on Start, which takes the focus from the text box.
    page.document.dispatch('pointerdown');
    question.dispatch('change');
    await settle();
    expect(byId('start')).toBe(start);
    expect(start.disabled).toBeFalsy();
    page.document.dispatch('pointerup');
    start.dispatch('click');
    await settle();
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'own-text', text: 'does this handle retries?' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'start' } }]);
  });

  it('a key press on Undo, Regenerate, Not now or New review right after leaving a draft box waits for the draft to be saved, then runs once', async () => {
    for (const id of ['undo-2', 'regenerate-2', 'keep-as-is', 'new-review']) {
      await loadBoard(boardState(reviewView(withDraft())));
      await openEntry(2);
      // Picking the finding folded the band; the band stays open here, as the session did not answer.
      page.posted.splice(0);
      const box = must('draft-2');
      box.value = 'My comment';
      box.dispatch('input');
      box.dispatch('change');
      must(id).dispatch('click');
      await settle();
      const saved = { revision: 1, action: { type: 'draft', number: 2, text: 'My comment' } };
      if (id === 'regenerate-2') {
        // Regenerate is a run: the draft is saved first, then the run starts once.
        expect(posted('action'), id).toEqual([saved]);
        expect(posted('run'), id).toEqual([{ revision: 1, request: { type: 'regenerate', number: 2 } }]);
      } else {
        const expected = { 'undo-2': { type: 'undo-rewrite', number: 2 }, 'keep-as-is': { type: 'keep-as-is' }, 'new-review': { type: 'new-review' } }[id];
        expect(posted('action'), id).toEqual([saved, { revision: 1, action: expected }]);
      }
      stopped = true;
      removeFakePage();
    }
  });

  it('Run again right after leaving a draft box saves the draft first, then starts once', async () => {
    await loadBoard(boardState(reviewView(withDraft())));
    await openEntry(2);
    page.posted.splice(0);
    const box = must('draft-2');
    box.value = 'My comment';
    box.dispatch('input');
    box.dispatch('change');
    must('run-again').dispatch('click');
    await settle();
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'My comment' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'again' } }]);
  });

  it('a refused draft save keeps the typed text in the box and says why', async () => {
    refuseAction = action => action.type === 'draft' ? { status: 400, message: 'The comment is longer than Bitbucket accepts.' } : undefined;
    await loadBoard(boardState(reviewView(withDraft({ outdated: false, canUndo: false }))));
    await openEntry(2);
    await type(must('draft-2'), 'A very long comment');
    // Drawn again from the session, the box still holds what was typed.
    await push({});
    expect(must('draft-2').value).toBe('A very long comment');
    expect(page.root.textContent).toContain('The comment is longer than Bitbucket accepts.');
  });
});

describe('the review start screen page', () => {
  it('sends the typed link on Open and shows why a link was refused', async () => {
    let answer: Record<string, unknown> = { url: '' };
    page = installFakePage({ kind: 'review-start', session: '', title: 'Review a pull request' }, async () => answer);
    vi.resetModules();
    await import('../../board-pages/review-start/page.js' as string);
    await settle();

    answer = { url: 'https://example.com/x', problem: 'That is not the link of a Bitbucket pull request.' };
    await type(must('pr-url'), 'https://example.com/x', false);
    await click(must('open'));
    expect(page.posted.map(m => [m.op, m.body])).toEqual([['view', {}], ['open', { url: 'https://example.com/x' }]]);
    expect(must('problem').textContent).toBe('That is not the link of a Bitbucket pull request.');
  });

  it('looking at the tab again refreshes in the background: the link field stays enabled and focused, with what was typed', async () => {
    let answer: Promise<Record<string, unknown>> = Promise.resolve({ url: '' });
    page = installFakePage({ kind: 'review-start', session: '', title: 'Review a pull request' }, async () => answer);
    vi.resetModules();
    await import('../../board-pages/review-start/page.js' as string);
    await settle();
    const input = must('pr-url');
    input.focus();
    input.value = 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-';
    input.dispatch('input');

    let answerView: (v: Record<string, unknown>) => void = () => undefined;
    answer = new Promise(resolve => { answerView = resolve; });
    page.window.dispatch('focus');
    await settle();
    expect(page.posted.map(m => m.op)).toEqual(['view', 'view']);
    expect(byId('pr-url')).toBe(input);
    expect(input.disabled).toBeFalsy();

    answerView({ url: '' });
    await settle();
    expect(byId('pr-url')).toBe(input);
    expect(input.disabled).toBeFalsy();
    expect(page.document.activeElement?.id).toBe('pr-url');
    expect(input.value).toBe('https://bitbucket.example.com/projects/PROJ/repos/app/pull-');
  });

  it('a refresh that finds Bitbucket set up now drops the hint and offers Open, keeping the typed link', async () => {
    let answer: Record<string, unknown> = { url: '', bitbucketHint: 'Bitbucket is not configured.' };
    page = installFakePage({ kind: 'review-start', session: '', title: 'Review a pull request' }, async () => answer);
    vi.resetModules();
    await import('../../board-pages/review-start/page.js' as string);
    await settle();
    await type(must('pr-url'), 'https://bitbucket.example.com/x', false);
    must('pr-url').focus();
    answer = { url: '' };
    page.window.dispatch('focus');
    await settle();
    expect(page.root.textContent).not.toContain('Bitbucket is not configured.');
    expect(must('open').disabled).toBeFalsy();
    expect(must('pr-url').value).toBe('https://bitbucket.example.com/x');
    expect(page.document.activeElement?.id).toBe('pr-url');
  });

  it('shows the Bitbucket setup hint and does not offer Open', async () => {
    page = installFakePage({ kind: 'review-start', session: '', title: 'Review a pull request' }, async () => ({ url: '', bitbucketHint: 'Bitbucket is not configured.' }));
    vi.resetModules();
    await import('../../board-pages/review-start/page.js' as string);
    await settle();
    expect(page.root.textContent).toContain('Bitbucket is not configured.');
    expect(must('open').disabled).toBe(true);
  });
});
