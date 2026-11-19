import { h, startBoard } from '../shared/board.js';

// The pull request review board, one column. The first step: the model, the requirements source
// (a Jira ticket, a goal or none), the goal and its rewording, and an optional question; nothing runs
// before Start, and only Reword calls the model before it. After the regular pass: a header line
// (pull request, model, requirements source, passes run), the coverage block and the findings.
// The page keeps only what is being typed and not sent yet. Everything from Bitbucket, Jira or the
// model is written as text.

/** Text typed into a field and not sent yet, by field id; the session holds the rest. */
const typed = {};
/** The last field change on its way to the session, so a button pressed right after waits for it. */
let saving = Promise.resolve();

const SEVERITY_TEXT = { critical: 'Critical', warning: 'Warning', suggestion: 'Suggestion' };

/** The action that sends a field's text, by field id. */
const FIELD_ACTIONS = {
  goal: text => ({ type: 'goal', text }),
  points: text => ({ type: 'points', text }),
  question: text => ({ type: 'question', text }),
  'ticket-key': key => ({ type: 'ticket-key', key }),
};

/** Sends a typed field to the session when the developer leaves it; no model call is made. */
function fieldSaver(board, id) {
  return e => {
    const text = e.target.value;
    saving = saving.then(() => board.act(FIELD_ACTIONS[id](text))).finally(() => { delete typed[id]; });
  };
}

/** Sends every field still typed and not sent (`fields` maps a field id to its value in the session), then runs `then`. */
async function afterSaving(board, fields, then) {
  await saving;
  for (const [id, current] of Object.entries(fields)) {
    if (typed[id] !== undefined && typed[id] !== current) await board.act(FIELD_ACTIONS[id](typed[id]));
    delete typed[id];
  }
  await then();
}

function fieldInput(tag, id, value, board, off, extra = {}) {
  return h(tag, {
    id, value: typed[id] ?? value, disabled: off, ...extra,
    onInput: e => { typed[id] = e.target.value; },
    onChange: fieldSaver(board, id),
  });
}

function textField(id, label, value, board, off, rows) {
  return h('label', { class: 'field' }, label, fieldInput('textarea', id, value, board, off, { rows, 'aria-label': label }));
}

function headerLine(view) {
  return h('p', { id: 'pr-line' },
    h('strong', {}, view.pr.label), ` ${view.pr.title}`,
    h('span', { class: 'muted' }, ` by ${view.pr.author}`));
}

// ---- the first step ---------------------------------------------------------------------------

function modelRow(view, board, off) {
  const { model } = view;
  return h('section', { id: 'model', 'aria-label': 'Model' },
    h('h2', {}, 'Model'),
    model.inUse ? h('p', {}, model.inUse.label, h('span', { class: 'muted' }, model.inUse.picked
      ? ' (saved to ticketSidekick.bitbucket.reviewModel when you press Reword or Start)'
      : ' (from ticketSidekick.bitbucket.reviewModel)')) : h('p', {}, model.askReason ?? ''),
    model.options.length > 0 ? h('select', {
      id: 'model-pick', 'aria-label': 'Review model', disabled: off,
      onChange: e => { if (e.target.value) void board.act({ type: 'pick-model', id: e.target.value }); },
    }, h('option', { value: '', selected: true }, model.inUse ? 'Pick another model…' : 'Choose a model…'),
    model.options.map(m => h('option', { value: m.id }, m.label))) : null,
    model.problem ? h('p', { class: 'banner' }, model.problem) : null);
}

function sourceRow(step, board, off) {
  return h('fieldset', { id: 'source', class: 'sources' },
    h('legend', {}, 'Requirements source'),
    step.sources.map(s => h('label', { class: 'source' },
      h('input', {
        type: 'radio', name: 'source', id: `source-${s.id}`, value: s.id, checked: s.id === step.source, disabled: off || !s.available,
        onChange: () => board.act({ type: 'source', source: s.id }),
      }), ` ${s.label}`,
      s.reason ? h('span', { class: 'muted', id: `source-${s.id}-reason` }, ` ${s.reason}`) : null)));
}

function ticketRow(step, board, off) {
  return h('div', { class: 'bar' },
    h('label', {}, 'Ticket key', fieldInput('input', 'ticket-key', step.ticketKey, board, off, { type: 'text', size: 16, placeholder: 'PROJ-123', 'aria-label': 'Ticket key' })));
}

function goalRows(step, board, off, rewording) {
  return [
    textField('goal', 'Goal', step.goal, board, off || rewording, 3),
    h('div', { class: 'bar' },
      h('vscode-button', {
        id: 'reword', secondary: true, disabled: off || rewording || !step.canReword,
        onClick: () => afterSaving(board, { goal: step.goal }, () => board.run({ type: 'reword' })),
      }, rewording ? 'Rewording…' : 'Reword'),
      step.rewordBlocker && !rewording ? h('span', { class: 'muted' }, step.rewordBlocker) : null),
    step.rewordError ? h('p', { id: 'reword-error', class: 'banner error', role: 'alert' }, step.rewordError) : null,
    step.points || typed.points !== undefined ? [
      textField('points', 'Reworded goal (correct it before Start)', step.points, board, off || rewording, 8),
      step.pointsFromOtherGoal ? h('p', { class: 'muted' }, 'These points were reworded from an earlier wording of the goal. Reword again to replace them, or correct them here.') : null,
    ] : null,
  ];
}

function firstStep(view, board, off) {
  const step = view.firstStep;
  const rewording = Boolean(board.running('reword'));
  const fields = { goal: step.goal, points: step.points, question: step.question, 'ticket-key': step.ticketKey };
  return h('section', { id: 'first-step', 'aria-label': 'First step' },
    modelRow(view, board, off),
    h('h2', {}, 'Requirements'),
    sourceRow(step, board, off || rewording),
    step.source === 'ticket' ? ticketRow(step, board, off) : null,
    step.source === 'goal' ? goalRows(step, board, off, rewording) : null,
    h('h2', {}, 'Question'),
    textField('question', 'An optional question for the review', step.question, board, off, 2),
    step.notice ? h('p', { id: 'first-step-notice', class: 'banner', role: 'status' }, step.notice) : null,
    h('div', { class: 'bar' },
      h('vscode-button', {
        id: 'start', disabled: off || rewording || !step.canStart,
        onClick: () => afterSaving(board, fields, () => board.run({ type: 'start' })),
      }, 'Start'),
      step.storedReview ? h('vscode-button', { id: 'back-to-review', secondary: true, disabled: off, onClick: () => board.act({ type: 'back-to-review' }) }, 'Back to the review') : null,
      rewording ? h('span', { class: 'muted', role: 'status' }, 'Start waits until the rewording ends.')
        : step.startBlocker ? h('span', { class: 'muted' }, step.startBlocker) : null));
}

// ---- the results ------------------------------------------------------------------------------

function results(view, board, off) {
  const r = view.results;
  return h('section', { id: 'results', 'aria-label': 'Review' },
    h('p', { id: 'review-header', class: 'muted' },
      [`Model: ${r.model || 'unknown'}`, `Requirements: ${r.requirements}`, `Passes run: ${r.passesRun.length ? r.passesRun.join(', ') : 'none'}`].join(' · ')),
    r.outOfDate ? h('p', { id: 'out-of-date', class: 'banner', role: 'status' },
      `Out of date: the pull request has a new commit (${r.outOfDate.head}) since this review read ${r.outOfDate.reviewed}. Nothing runs by itself; press New review to review it again.`) : null,
    r.status ? h('p', { id: 'pass-status', class: 'banner' }, r.status) : null,
    // The pass picker goes here, above the coverage and the findings.
    r.requirementsLine ? h('p', { id: 'requirements-line', class: 'banner' }, r.requirementsLine) : null,
    r.coverage ? h('section', { id: 'coverage', 'aria-label': 'Requirements coverage' }, h('pre', { class: 'coverage' }, r.coverage)) : null,
    h('h2', {}, `Findings (${r.findings.length})`),
    r.findings.length === 0 ? h('p', { class: 'muted' }, 'No issues found.') : h('ol', { id: 'findings', class: 'findings' },
      r.findings.map(f => h('li', { id: `finding-${f.number}`, value: f.number },
        h('span', { class: `severity severity-${f.severity}` }, `#${f.number} ${SEVERITY_TEXT[f.severity] ?? f.severity}`), ' ',
        h('span', { class: 'location' }, f.location), ' ',
        h('span', { class: 'title' }, f.title),
        f.markers.length ? h('span', { class: 'muted markers' }, ` (${f.markers.join(', ')})`) : null))),
    r.tokens ? h('p', { id: 'tokens', class: 'muted' }, `Token usage: ${r.tokens}.`) : null,
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'new-review', secondary: true, disabled: off, onClick: () => board.act({ type: 'new-review' }) }, 'New review')));
}

startBoard({
  root: document.getElementById('root'),
  loading: () => h('p', { class: 'muted' }, 'Reading the pull request…'),
  render: (view, board, locked) => h('div', {},
    headerLine(view),
    view.stage === 'first-step' ? firstStep(view, board, locked) : results(view, board, locked)),
});
