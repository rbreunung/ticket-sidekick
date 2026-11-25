import { afterEach, describe, expect, it, vi } from 'vitest';
import { asBoardRequest } from '../boards/boardMessages';
import type { FirstStepView, PassPickerView, ReviewResultsView, ReviewView } from '../boards/review/kind';
import type { BoardState } from '../sessions/sessionManager';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The pull request review board's page in its editor tab, and the review start screen's page: the
// first step (model, background: Jira ticket with its box, own text or none, Start), and after the regular pass the
// one-column results (header line, findings). The extension side is a
// canned state. Everything from Bitbucket, Jira or the model must reach the page as text.

const SESSION = '0123456789abcdef01234567';
const ACCEPTED_OPS = new Set(['state', 'action', 'run', 'stop', 'refresh', 'discard']);

let page: FakePage;
let stopped = false;
let state: BoardState;
let waiting: Array<() => void> = [];
/** What the extension answers the page's Copy and Post preview. */
let copyAnswer: unknown = { outcome: 'copied', count: 2 };
let previewAnswer: unknown = { planId: 'p'.repeat(48), title: 'Post 1 comment(s)', lines: [{ target: '#2', change: 'Post inline' }], risky: true };
/** A refusal the extension gives an action, when set; `undefined` lets the action through. */
let refuseAction: ((action: Record<string, unknown>) => { status: number; message: string } | undefined) | undefined;

afterEach(() => {
  stopped = true;
  refuseAction = undefined;
  removeFakePage();
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
    ...extra,
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
    restored: false, stored: true, conflicts: [], writesBlocked: false, view: v, ...extra,
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
    if (op === 'preview') return previewAnswer;
    throw { status: 404, message: 'Unknown request.' };
  });
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

describe('the review board page: results', () => {
  it('shows one column: header line, then the findings with number, severity, location, title and markers, and no requirements block', async () => {
    await loadBoard(boardState(view({ stage: 'review', results: results() })));
    expect(must('pr-line').textContent).toBe('PROJ/app#482 Add export by Jane Smith');
    expect(must('review-header').textContent).toBe('Model: GPT (copilot) · Passes run: Regular');
    expect(must('finding-2').textContent.trim()).toBe('#2 Critical src/a.ts:4 SQL built from input Explain');
    expect(must('finding-1').textContent.trim()).toBe('#1 Suggestion src/b.ts Maybe a race (location unverified) Explain');
    const order = page.root.elements().map(el => el.id).filter(id => ['review-header', 'findings'].includes(id));
    expect(order).toEqual(['review-header', 'findings']);
    for (const id of ['coverage', 'recheck', 'requirements-source', 'requirements-failure', 'reword']) expect(byId(id), id).toBeNull();
  });

  it('shows crafted finding text as plain text: no HTML or link becomes an element', async () => {
    const crafted = '<img src=x onerror=alert(1)>[click](https://evil.example) <b>bold</b>';
    await loadBoard(boardState(view({
      stage: 'review',
      pr: { label: 'PROJ/app#482', url: 'u', title: crafted, author: crafted },
      results: results({ findings: [{ number: 1, severity: 'warning', location: crafted, title: crafted, markers: [] }] }),
    })));
    expect(must('finding-1').textContent).toContain(crafted);
    const all = page.document.body.elements();
    expect(all.some(el => el.tagName === 'img' || el.tagName === 'b' || el.tagName === 'a')).toBe(false);
  });

  it('marks an out-of-date review and offers New review, which goes back to the first step', async () => {
    await loadBoard(boardState(view({ stage: 'review', results: results({ outOfDate: { reviewed: 'abc123def456', head: 'fff000fff000' } }) })));
    expect(must('out-of-date').textContent).toMatch(/new commit \(fff000fff000\).*abc123def456/);
    await click(must('new-review'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'new-review' } }]);
  });

  it('says so when there are no findings', async () => {
    await loadBoard(boardState(view({ stage: 'review', results: results({ findings: [] }) })));
    expect(page.root.textContent).toContain('No issues found.');
  });
});

describe('the review board page: passes and runs', () => {
  const stage = 'review' as const;

  it('with no extra pass suggested, says so and still offers all five passes; a tick is sent as an action', async () => {
    await loadBoard(boardState(view({ stage, results: results() })));
    expect(must('pass-suggestion').textContent).toBe('No extra pass is suggested. You can still pick any of them.');
    const boxes = ['security', 'performance', 'reliability', 'maintainability', 'critic'].map(step => must(`pass-${step}`));
    expect(boxes.every(b => !b.disabled && !b.checked)).toBe(true);
    expect(must('run-selected').disabled).toBe(true);
    const order = page.root.elements().map(el => el.id).filter(id => ['review-header', 'pass-picker', 'findings'].includes(id));
    expect(order).toEqual(['review-header', 'pass-picker', 'findings']);

    boxes[0].checked = true;
    boxes[0].dispatch('change');
    await settle();
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'pick-pass', step: 'security', picked: true } }]);
  });

  it('marks a pass already run, and Run selected starts one run; Keep as is is an action', async () => {
    const p = picker({ suggestion: 'Suggested: the security pass.', canRun: true });
    p.choices[0] = { ...p.choices[0], run: true, available: false, reason: 'Run already.' };
    p.choices[4] = { ...p.choices[4], picked: true };
    await loadBoard(boardState(view({ stage, results: results({ picker: { ...p, runBlocker: undefined } }) })));
    expect(must('pass-security').disabled).toBe(true);
    expect(must('pass-security-run').textContent).toBe(' (run)');
    expect(must('pass-critic').checked).toBe(true);
    await click(must('run-selected'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'passes' } }]);
    await click(must('keep-as-is'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'keep-as-is' } }]);
  });

  it('while a pass runs, every other control is locked, Stop is enabled, and the live region reads the pass progress', async () => {
    const p = picker({ canRun: true });
    await loadBoard(boardState(view({ stage, results: results({ picker: { ...p, runBlocker: undefined } }) })));
    await push({
      running: [{ size: 'pass', what: 'passes', label: 'the security pass', done: 2, total: 5 }],
      view: view({ stage, progress: 'Security pass: 2 of 5 batches', results: results({ picker: { ...p, runBlocker: undefined } }) }),
    });
    for (const id of ['run-selected', 'keep-as-is', 'run-again', 'new-review', 'pass-security', 'pass-critic', 'refresh', 'discard']) {
      expect(must(id).disabled, id).toBe(true);
    }
    expect(must('stop-run').disabled).toBeFalsy();
    expect(must('board-live').textContent).toBe('Security pass: 2 of 5 batches');
    expect(must('progress-text').textContent).toBe('Security pass: 2 of 5 batches');
    await click(must('stop-run'));
    expect(page.posted.filter(m => m.op === 'stop')).toHaveLength(1);
  });

  it('while the regular pass runs, the findings so far are listed, and before the first batch finishes it says none are found yet', async () => {
    const running = [{ size: 'pass' as const, what: 'regular', label: 'the regular pass', done: 0, total: 3 }];
    await loadBoard(boardState(view({
      stage, progress: 'Regular pass: 0 of 3 batches',
      results: results({ hasReview: false, picker: undefined, findings: [], passesRun: [], tokens: [], running: { what: 'regular', step: 'regular', done: 0, total: 3 } }),
    }), { running }));
    expect(must('no-findings-yet').textContent).toBe('No findings yet.');
    expect(byId('no-issues')).toBeFalsy();
    expect(byId('pass-picker')).toBeFalsy();

    await push({
      running: [{ ...running[0], done: 1 }],
      view: view({ stage, progress: 'Regular pass: 1 of 3 batches', results: results({ picker: undefined, passesRun: [], tokens: [], running: { what: 'regular', step: 'regular', done: 1, total: 3 } }) }),
    });
    expect(byId('finding-2')).toBeTruthy();
    expect(byId('finding-1')).toBeTruthy();
    expect(must('explain-2').disabled).toBe(true);
  });

  it('a finished review with no findings shows "No issues found" with the picker, the token usage and Run again', async () => {
    await loadBoard(boardState(view({ stage, results: results({ findings: [] }) })));
    expect(must('no-issues').textContent).toBe('No issues found.');
    expect(byId('pass-picker')).toBeTruthy();
    expect(must('tokens').textContent).toBe('Regular pass: 1,200 input and 300 output tokens in 3 call(s)');
    await click(must('run-again'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'again' } }]);
  });

  it('a regular pass whose batches all failed shows the failure banner and Run again, and no findings controls', async () => {
    await loadBoard(boardState(view({
      stage,
      results: results({
        hasReview: false, picker: undefined, findings: [], passesRun: [],
        statuses: ['The regular pass failed: The model is overloaded No batch gave a readable reply, so there are no findings. Run again tries once more.'],
      }),
    })));
    expect(must('pass-status-0').textContent).toMatch(/^The regular pass failed/);
    for (const id of ['pass-picker', 'findings', 'no-issues', 'run-selected']) expect(byId(id), id).toBeFalsy();
    expect(byId('run-again')).toBeTruthy();
  });


  it('a board restored after a restart mid-pass shows the interrupted banner and no running state', async () => {
    await loadBoard(boardState(view({
      stage,
      results: results({ statuses: ['The security pass was cut off by a restart: 2 of 5 batches finished, and their findings are kept. It is not marked as run, so you can pick it again.'] }),
    }), { restored: true }));
    expect(must('pass-status-0').textContent).toMatch(/cut off by a restart: 2 of 5 batches finished/);
    expect(byId('stop-run')).toBeFalsy();
    expect(byId('run-progress')).toBeFalsy();
    expect(must('run-selected').disabled).toBe(true);
    expect(must('pass-security').disabled).toBeFalsy();
  });
});

describe('the review board page: findings, drafts, Post and Copy', () => {
  const stage = 'review' as const;
  type F = ReviewResultsView['findings'][number];
  const f2 = (extra: Partial<F> = {}): F => ({ number: 2, severity: 'critical', location: 'src/a.ts:4', title: 'SQL built from input', markers: [], selected: false, ...extra });
  const f1 = (extra: Partial<F> = {}): F => ({ number: 1, severity: 'suggestion', location: 'src/b.ts', title: 'Maybe a race', markers: [], selected: false, ...extra });
  const draft = (extra: Partial<NonNullable<F['draft']>> = {}): NonNullable<F['draft']> => ({ text: 'Draft of #2', outdated: false, canUndo: false, ...extra });
  const selected2 = (extra: Partial<ReviewResultsView> = {}, d: Partial<NonNullable<F['draft']>> = {}, f: Partial<F> = {}) => results({
    findings: [f2({ selected: true, draft: draft(d), ...f }), f1()],
    selectedCount: 1, post: { count: 1 }, copy: { scope: 'selected', count: 1 }, ...extra,
  });

  it('Explain starts one run for its finding, shows Explaining… while it runs and the answer as text after', async () => {
    await loadBoard(boardState(view({ stage, results: results() })));
    await click(must('explain-2'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'explain', number: 2 } }]);
    await push({ running: [{ size: 'call', what: 'explain:2', label: 'the explanation of #2', done: 0, total: 1 }] });
    expect(must('explain-2').disabled).toBe(true);
    expect(must('explain-2').textContent).toBe('Explaining…');
    expect(must('explain-1').disabled).toBeFalsy();
    expect(must('select-1').disabled).toBeFalsy();
    await push({ running: undefined, view: view({ stage, results: results({ findings: [f2({ explanation: '<b>Because</b> [x](https://evil.example)' }), f1({ explainError: 'Explain failed: rate limited' })] }) }) });
    expect(must('explanation-2').textContent).toBe('<b>Because</b> [x](https://evil.example)');
    expect(must('explanation-2').elements().length).toBe(0);
    expect(must('explain-error-1').textContent).toBe('Explain failed: rate limited');
  });

  it('a checkbox selects one finding and select all selects every finding, each as an action', async () => {
    await loadBoard(boardState(view({ stage, results: results() })));
    expect(must('post').disabled).toBe(true);
    expect(must('copy-teams').textContent).toBe('Copy all 2 for Teams');
    const box = must('select-2');
    box.checked = true;
    box.dispatch('change');
    await settle();
    const all = must('select-all');
    all.checked = true;
    all.dispatch('change');
    await settle();
    expect(posted('action')).toEqual([
      { revision: 1, action: { type: 'select', numbers: [2], selected: true } },
      { revision: 1, action: { type: 'select', numbers: [2, 1], selected: true } },
    ]);
  });

  it('shows the draft under its finding; it is saved on leaving the box, and an outdated draft offers Regenerate', async () => {
    await loadBoard(boardState(view({ stage, results: selected2({}, { outdated: true }) })));
    expect(must('draft-2').value).toBe('Draft of #2');
    expect(must('finding-2').textContent).toMatch(/explanation changed/);
    await type(must('draft-2'), 'My comment');
    await click(must('regenerate-2'));
    expect(posted('action')).toEqual([
      { revision: 1, action: { type: 'draft', number: 2, text: 'My comment' } },
      { revision: 1, action: { type: 'regenerate', number: 2 } },
    ]);
    expect(must('post').textContent).toBe('Post 1 comment(s)');
    expect(must('copy-markdown').textContent).toBe('Copy 1 selected as Markdown');
  });

  it('Rewrite saves a typed draft first, then runs with the typed instruction; the box is locked while it runs, and Undo and the error line show after', async () => {
    await loadBoard(boardState(view({ stage, results: selected2() })));
    await type(must('draft-2'), 'Hand-edited', false);
    await type(must('instruction-2'), 'Make it shorter', false);
    await click(must('rewrite-2'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'Hand-edited' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'rewrite', number: 2, instruction: 'Make it shorter' } }]);
    await push({ running: [{ size: 'call', what: 'rewrite:2', label: 'the rewrite', done: 0, total: 1 }] });
    expect(must('draft-2').disabled).toBe(true);
    expect(must('rewrite-2').textContent).toBe('Rewriting…');
    expect(must('select-1').disabled).toBeFalsy();
    await push({ running: undefined, view: view({ stage, results: selected2({}, { text: 'Hand-edited', rewriteError: 'Rewrite failed: model unavailable' }) }) });
    expect(must('rewrite-error-2').textContent).toBe('Rewrite failed: model unavailable');
    await push({ view: view({ stage, results: selected2({}, { text: 'Shorter', canUndo: true }) }) });
    await click(must('undo-2'));
    expect(posted('action').at(-1)).toEqual({ revision: 1, action: { type: 'undo-rewrite', number: 2 } });
  });

  it('Post saves a typed draft, then asks for the preview; a posted draft is read-only and a failed one says why', async () => {
    await loadBoard(boardState(view({ stage, results: selected2() })));
    await type(must('draft-2'), 'Final words', false);
    await click(must('post'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'draft', number: 2, text: 'Final words' } }]);
    expect(posted('preview')).toEqual([{ revision: 1, action: { type: 'post' } }]);
    await push({ view: view({ stage, results: results({ findings: [f2({ draft: draft({ posted: 'Posted as comment 100.' }) }), f1({ selected: true, draft: draft({ text: 'x', postError: 'Not posted: Bitbucket said 500' }) })] }) }) });
    expect(must('draft-2').disabled).toBe(true);
    expect(must('posted-2').textContent).toBe('Posted as comment 100.');
    expect(must('post-error-1').textContent).toBe('Not posted: Bitbucket said 500');
  });

  it('Copy names the format and the selected numbers only, and says what was copied in the live region', async () => {
    copyAnswer = { outcome: 'copied', count: 1 };
    await loadBoard(boardState(view({ stage, results: selected2() })));
    await click(must('copy-teams'));
    expect(posted('copy')).toEqual([{ format: 'teams', numbers: [2] }]);
    expect(must('copy-result').textContent).toBe('Copied 1 finding.');
    expect(page.document.getElementById('board-live')?.textContent).toBe('Copied 1 finding.');
    copyAnswer = { outcome: 'failed', reason: 'clipboard unavailable' };
    await click(must('copy-markdown'));
    expect(posted('copy').at(-1)).toEqual({ format: 'markdown', numbers: [2] });
    expect(must('copy-result').textContent).toBe('Not copied: clipboard unavailable');
  });

  it('Copy with nothing selected sends no numbers, for every finding', async () => {
    copyAnswer = { outcome: 'copied', count: 2 };
    await loadBoard(boardState(view({ stage, results: results() })));
    await click(must('copy-markdown'));
    expect(posted('copy')).toEqual([{ format: 'markdown', numbers: [] }]);
    expect(must('copy-result').textContent).toBe('Copied 2 findings.');
  });
});

describe('the review board page: a field left by pressing a button', () => {
  const stage = 'review' as const;
  type F = ReviewResultsView['findings'][number];
  const withDraft = (d: Partial<NonNullable<F['draft']>> = {}) => results({
    findings: [{ number: 2, severity: 'critical', location: 'src/a.ts:4', title: 'SQL built from input', markers: [], selected: true, draft: { text: 'Draft of #2', outdated: true, canUndo: true, ...d } }],
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

  it('a key press on Undo, Regenerate, Keep as is or New review right after leaving a draft box waits for the draft to be saved, then runs once', async () => {
    for (const id of ['undo-2', 'regenerate-2', 'keep-as-is', 'new-review']) {
      await loadBoard(boardState(view({ stage, results: withDraft() })));
      const box = must('draft-2');
      box.value = 'My comment';
      box.dispatch('input');
      box.dispatch('change');
      must(id).dispatch('click');
      await settle();
      const expected = { 'undo-2': { type: 'undo-rewrite', number: 2 }, 'regenerate-2': { type: 'regenerate', number: 2 }, 'keep-as-is': { type: 'keep-as-is' }, 'new-review': { type: 'new-review' } }[id];
      expect(posted('action'), id).toEqual([
        { revision: 1, action: { type: 'draft', number: 2, text: 'My comment' } },
        { revision: 1, action: expected },
      ]);
      stopped = true;
      removeFakePage();
    }
  });

  it('Run again right after leaving a draft box saves the draft first, then starts once', async () => {
    await loadBoard(boardState(view({ stage, results: withDraft() })));
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
    await loadBoard(boardState(view({ stage, results: withDraft({ outdated: false, canUndo: false }) })));
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

describe('the review board page: what was not reviewed and the finding detail', () => {
  it('lists what the passes did not review and the findings they dropped under the banners, as text', async () => {
    const crafted = '<b>src/evil.ts</b>';
    await loadBoard(boardState(view({
      stage: 'review',
      results: results({
        statuses: ['1 of 3 batches of the regular pass had a part that failed; the findings of the others are shown.'],
        notes: [
          `regular batch 2/3 — could not review ${crafted} after retrying: overloaded`,
          '1 finding was dropped because it named a file outside this pull request.',
          '2 findings were removed by the critic as unverifiable: #3, #4.',
        ],
      }),
    })));
    expect(must('review-note-0').textContent).toBe(`regular batch 2/3 — could not review ${crafted} after retrying: overloaded`);
    expect(must('review-note-1').textContent).toBe('1 finding was dropped because it named a file outside this pull request.');
    expect(must('review-note-2').textContent).toBe('2 findings were removed by the critic as unverifiable: #3, #4.');
    const order = page.root.elements().map(el => el.id).filter(id => ['pass-status-0', 'review-notes', 'findings'].includes(id));
    expect(order).toEqual(['pass-status-0', 'review-notes', 'findings']);
    expect(page.document.body.elements().some(el => el.tagName === 'b')).toBe(false);
  });

  it('shows no notes section when nothing was left out', async () => {
    await loadBoard(boardState(view({ stage: 'review', results: results({ notes: [] }) })));
    expect(byId('review-notes')).toBeNull();
  });

  it('shows each finding\'s line, provenance, confidence and source, its description and its recommendation, as text', async () => {
    const crafted = '<img src=x onerror=alert(1)> [click](https://evil.example)';
    await loadBoard(boardState(view({
      stage: 'review',
      results: results({
        findings: [{
          number: 2, severity: 'critical', location: 'src/a.ts:19', title: 'SQL built from input', markers: [], selected: false,
          facts: ['L19 (also L12, L15)', 'new code', 'confidence 0.9', 'source: security, general'],
          description: `The id reaches the query unchecked. ${crafted}`, recommendation: 'Use a bound parameter.',
        }],
      }),
    })));
    expect(must('facts-2').textContent).toBe('L19 (also L12, L15) · new code · confidence 0.9 · source: security, general');
    expect(must('description-2').textContent).toBe(`The id reaches the query unchecked. ${crafted}`);
    expect(must('recommendation-2').textContent).toBe('Recommendation: Use a bound parameter.');
    expect(page.document.body.elements().some(el => el.tagName === 'img' || el.tagName === 'a')).toBe(false);
  });
});
