import { afterEach, describe, expect, it, vi } from 'vitest';
import { asBoardRequest } from '../boards/boardMessages';
import type { FirstStepView, PassPickerView, ReviewResultsView, ReviewView } from '../boards/review/kind';
import type { BoardState } from '../sessions/sessionManager';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The pull request review board's page in its editor tab, and the review start screen's page: the
// first step (model, requirements source, goal and its rewording, question, Start), and after the
// regular pass the one-column results (header line, coverage, findings). The extension side is a
// canned state. Everything from Bitbucket, Jira or the model must reach the page as text.

const SESSION = '0123456789abcdef01234567';
const ACCEPTED_OPS = new Set(['state', 'action', 'run', 'stop', 'refresh', 'discard']);

let page: FakePage;
let stopped = false;
let state: BoardState;
let waiting: Array<() => void> = [];

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
    sources: [
      { id: 'ticket', label: 'Jira ticket', available: true },
      { id: 'goal', label: 'A goal', available: true },
      { id: 'none', label: 'None', available: true },
    ],
    source: 'none', ticketKey: '', goal: '', points: '', pointsFromOtherGoal: false, question: '',
    canReword: true, canStart: true, storedReview: false, ...extra,
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
    model: 'GPT (copilot)', requirements: 'Jira ticket PROJ-12', passesRun: ['Regular'],
    coverage: 'Requirements coverage (PROJ-12)\n- Export as CSV: met',
    tokens: [{ pass: 'Regular pass', text: '1,200 input and 300 output tokens in 3 call(s)' }],
    statuses: [], hasReview: true, canRecheck: false, canRunAgain: true, picker: picker(),
    findings: [
      { number: 2, severity: 'critical', location: 'src/a.ts:4', title: 'SQL built from input', markers: [] },
      { number: 1, severity: 'suggestion', location: 'src/b.ts', title: 'Maybe a race', markers: ['location unverified'] },
    ],
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
    if (op === 'action' || op === 'run') return state;
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
      firstStep: firstStep({ canStart: false, startBlocker: 'Pick the model first.', canReword: false }),
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

  it('shows the ticket source as unavailable with its reason', async () => {
    await loadBoard(boardState(view({
      firstStep: firstStep({ sources: [
        { id: 'ticket', label: 'Jira ticket', available: false, reason: 'Jira is not configured, so no ticket can be read.' },
        { id: 'goal', label: 'A goal', available: true },
        { id: 'none', label: 'None', available: true },
      ] }),
    })));
    expect(must('source-ticket').disabled).toBe(true);
    expect(must('source-none').checked).toBe(true);
    expect(must('source-ticket-reason').textContent).toMatch(/Jira is not configured/);
  });

  it('leaving the goal field sends only the goal; Reword sends a typed goal first, then one rewording run', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ source: 'goal' }) })));
    await type(must('goal'), 'only backend endpoint, export button later');
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'goal', text: 'only backend endpoint, export button later' } }]);
    expect(posted('run')).toEqual([]);

    await type(must('goal'), 'only the backend endpoint', false);
    await click(must('reword'));
    expect(posted('action').at(-1)).toEqual({ revision: 1, action: { type: 'goal', text: 'only the backend endpoint' } });
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'reword' } }]);
  });

  it('locks Start and Reword while the rewording runs, then shows the points to correct', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ source: 'goal', goal: 'only backend endpoint' }) })));
    await push({ running: [{ size: 'call', what: 'reword', label: 'the goal rewording', done: 0, total: 1 }] });
    expect(must('start').disabled).toBe(true);
    expect(must('reword').disabled).toBe(true);
    expect(must('reword').textContent).toBe('Rewording…');

    await push({ running: undefined, view: view({ firstStep: firstStep({ source: 'goal', goal: 'only backend endpoint', points: 'In scope:\n- The backend export endpoint' }) }) });
    expect(must('start').disabled).toBeFalsy();
    expect(must('points').value).toBe('In scope:\n- The backend export endpoint');
  });

  it('shows a failed rewording as an error line', async () => {
    await loadBoard(boardState(view({ firstStep: firstStep({ source: 'goal', goal: 'x', rewordError: 'The goal could not be reworded: The model reply could not be read. Start uses your words as they stand.' }) })));
    expect(must('reword-error').textContent).toMatch(/could not be reworded/);
    expect(must('reword-error').getAttribute('role')).toBe('alert');
  });

  it('Start sends a typed question first, then starts the regular pass; nothing else is posted', async () => {
    await loadBoard(boardState(view()));
    await type(must('question'), 'does this handle retries?', false);
    await click(must('start'));
    expect(posted('action')).toEqual([{ revision: 1, action: { type: 'question', text: 'does this handle retries?' } }]);
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'start' } }]);
    for (const message of page.posted) {
      expect(ACCEPTED_OPS.has(message.op), message.op).toBe(true);
      expect(asBoardRequest(message)).toBeDefined();
    }
    expect(JSON.stringify(page.posted)).not.toContain(SESSION);
  });
});

describe('the review board page: results', () => {
  it('shows one column: header line, coverage, then the findings with number, severity, location, title and markers', async () => {
    await loadBoard(boardState(view({ stage: 'review', results: results() })));
    expect(must('pr-line').textContent).toBe('PROJ/app#482 Add export by Jane Smith');
    expect(must('review-header').textContent).toBe('Model: GPT (copilot) · Requirements: Jira ticket PROJ-12 · Passes run: Regular');
    expect(must('coverage').textContent).toBe('Requirements coverage (PROJ-12)\n- Export as CSV: met');
    expect(must('finding-2').textContent).toBe('#2 Critical src/a.ts:4 SQL built from input');
    expect(must('finding-1').textContent).toBe('#1 Suggestion src/b.ts Maybe a race (location unverified)');
    const order = page.root.elements().map(el => el.id).filter(id => ['review-header', 'coverage', 'findings'].includes(id));
    expect(order).toEqual(['review-header', 'coverage', 'findings']);
  });

  it('shows crafted finding and coverage text as plain text: no HTML or link becomes an element', async () => {
    const crafted = '<img src=x onerror=alert(1)>[click](https://evil.example) <b>bold</b>';
    await loadBoard(boardState(view({
      stage: 'review',
      pr: { label: 'PROJ/app#482', url: 'u', title: crafted, author: crafted },
      results: results({ coverage: crafted, findings: [{ number: 1, severity: 'warning', location: crafted, title: crafted, markers: [] }] }),
    })));
    expect(must('finding-1').textContent).toContain(crafted);
    expect(must('coverage').textContent).toBe(crafted);
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
    const order = page.root.elements().map(el => el.id).filter(id => ['review-header', 'pass-picker', 'coverage', 'findings'].includes(id));
    expect(order).toEqual(['review-header', 'pass-picker', 'coverage', 'findings']);

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
    await loadBoard(boardState(view({ stage, results: results({ picker: { ...p, runBlocker: undefined }, requirementsLine: 'The requirements check failed.', canRecheck: true }) })));
    await push({
      running: [{ size: 'pass', what: 'passes', label: 'the security pass', done: 2, total: 5 }],
      view: view({ stage, progress: 'Security pass: 2 of 5 batches', results: results({ picker: { ...p, runBlocker: undefined }, requirementsLine: 'The requirements check failed.', canRecheck: true }) }),
    });
    for (const id of ['run-selected', 'keep-as-is', 'run-again', 'new-review', 'recheck', 'pass-security', 'pass-critic', 'refresh', 'discard']) {
      expect(must(id).disabled, id).toBe(true);
    }
    expect(must('stop-run').disabled).toBeFalsy();
    expect(must('board-live').textContent).toBe('Security pass: 2 of 5 batches');
    expect(must('progress-text').textContent).toBe('Security pass: 2 of 5 batches');
    await click(must('stop-run'));
    expect(page.posted.filter(m => m.op === 'stop')).toHaveLength(1);
  });

  it('a finished review with no findings shows "No issues found" with the picker, the token usage and Run again', async () => {
    await loadBoard(boardState(view({ stage, results: results({ findings: [], coverage: undefined }) })));
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
        hasReview: false, picker: undefined, coverage: undefined, findings: [], passesRun: [],
        statuses: ['The regular pass failed: The model is overloaded No batch gave a readable reply, so there are no findings. Run again tries once more.'],
      }),
    })));
    expect(must('pass-status-0').textContent).toMatch(/^The regular pass failed/);
    for (const id of ['pass-picker', 'findings', 'no-issues', 'run-selected']) expect(byId(id), id).toBeFalsy();
    expect(byId('run-again')).toBeTruthy();
  });

  it('shows a failed requirements check in the coverage position with Re-check, locked only while the re-check runs', async () => {
    const p = { ...picker({ canRun: true }), runBlocker: undefined };
    const r = results({ picker: p, coverage: undefined, requirementsLine: 'The requirements check did not run: the ticket PROJ-12 could not be read (Issue does not exist). The findings stand.', canRecheck: true });
    await loadBoard(boardState(view({ stage, results: r })));
    const order = page.root.elements().map(el => el.id).filter(id => ['pass-picker', 'requirements-failure', 'findings'].includes(id));
    expect(order).toEqual(['pass-picker', 'requirements-failure', 'findings']);
    expect(must('requirements-line').textContent).toMatch(/ticket PROJ-12 could not be read/);
    await click(must('recheck'));
    expect(posted('run')).toEqual([{ revision: 1, request: { type: 'recheck' } }]);

    await push({ running: [{ size: 'call', what: 'recheck', label: 'the requirements re-check', done: 0, total: 1 }] });
    expect(must('recheck').disabled).toBe(true);
    expect(must('recheck').textContent).toBe('Re-checking…');
    expect(must('run-selected').disabled).toBeFalsy();
  });

  it('a board restored after a restart mid-pass shows the interrupted banner and no running state', async () => {
    await loadBoard(boardState(view({
      stage,
      results: results({ statuses: ['The security pass was cut off by a restart after 2 of 5 batches. The batches it had not saved yet are lost. It is not marked as run, so you can pick it again.'] }),
    }), { restored: true }));
    expect(must('pass-status-0').textContent).toMatch(/cut off by a restart after 2 of 5 batches/);
    expect(byId('stop-run')).toBeFalsy();
    expect(byId('run-progress')).toBeFalsy();
    expect(must('run-selected').disabled).toBe(true);
    expect(must('pass-security').disabled).toBeFalsy();
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

  it('shows the Bitbucket setup hint and does not offer Open', async () => {
    page = installFakePage({ kind: 'review-start', session: '', title: 'Review a pull request' }, async () => ({ url: '', bitbucketHint: 'Bitbucket is not configured.' }));
    vi.resetModules();
    await import('../../board-pages/review-start/page.js' as string);
    await settle();
    expect(page.root.textContent).toContain('Bitbucket is not configured.');
    expect(must('open').disabled).toBe(true);
  });
});
