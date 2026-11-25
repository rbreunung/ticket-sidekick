import { announce, api, h, startBoard } from '../shared/board.js';

// The pull request review board, one column. The first step: the model and one background for the
// reviewer (a Jira ticket read into an editable box, the developer's own text, or none); only the
// ticket read runs before Start, and Start waits for it. After the regular pass: a
// header line (pull request, model, passes run) with the token usage per pass, the banners of the
// last run, the pass suggestion and picker, the findings, and Run again. Under the banners, what the
// passes did not review and the findings they dropped. Each finding shows its line, provenance, confidence and source, its description and
// recommendation, and has Explain, a checkbox that selects it for Post and Copy
// (and drafts its comment under it), the draft with Rewrite, Undo and Regenerate; after the list,
// Post and Copy for Teams or as Markdown. Copy names only the format and the selected numbers: the
// extension builds the text. While a pass runs, the live region reads its progress, e.g.
// "Security pass: 2 of 5 batches"; while the regular pass runs, the results list the findings of
// its finished batches.
// The page keeps only what is being typed and not sent yet. Everything from Bitbucket, Jira or the
// model is written as text.

/** Text typed into a field and not sent yet, by field id; the session holds the rest. */
const typed = {};
/** The last field change on its way to the session, so a button pressed right after waits for it. */
let saving = Promise.resolve();

const SEVERITY_TEXT = { critical: 'Critical', warning: 'Warning', suggestion: 'Suggestion' };

/** The action that sends a field's text, by field id. */
const FIELD_ACTIONS = {
  'own-text': text => ({ type: 'own-text', text }),
  'ticket-text': text => ({ type: 'ticket-text', text }),
  'ticket-key': key => ({ type: 'ticket-key', key }),
};

/** The action that sends a field's text; a draft box is `draft-<number>`. */
function fieldAction(id, text) {
  const draft = /^draft-(\d+)$/.exec(id);
  return draft ? { type: 'draft', number: Number(draft[1]), text } : FIELD_ACTIONS[id](text);
}

/**
 * Sends a typed field to the session when the developer leaves it; no model call is made. The save
 * is quiet, so the press that left the field still reaches its button. A refused save keeps the
 * typed text in the field, and the board shows why.
 */
function fieldSaver(board, id) {
  return e => {
    const text = e.target.value;
    saving = saving.then(async () => {
      const saved = await board.act(fieldAction(id, text), { quiet: true });
      if (saved && typed[id] === text) delete typed[id];
    });
  };
}

/**
 * Waits for a field save on its way, sends every field still typed and not sent (`fields` maps a
 * field id to its value in the session), then runs `then`. Every button that sends an action or a
 * run goes through here, so a press right after typing is neither lost nor sent before the text.
 * When a typed field cannot be saved, `then` does not run and the board shows why.
 */
async function afterSaving(board, fields, then) {
  await saving;
  for (const [id, current] of Object.entries(fields)) {
    if (typed[id] === undefined) continue;
    if (typed[id] !== current && !(await board.act(fieldAction(id, typed[id])))) return;
    delete typed[id];
  }
  await then();
}

/** Waits for a field save on its way, then runs `then`. */
const whenSaved = (board, then) => afterSaving(board, {}, then);

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
      ? ' (saved to ticketSidekick.bitbucket.reviewModel when you press Start)'
      : ' (from ticketSidekick.bitbucket.reviewModel)')) : h('p', {}, model.askReason ?? ''),
    model.options.length > 0 ? h('select', {
      id: 'model-pick', 'aria-label': 'Review model', disabled: off,
      onChange: e => { const id = e.target.value; if (id) void whenSaved(board, () => board.act({ type: 'pick-model', id })); },
    }, h('option', { value: '', selected: true }, model.inUse ? 'Pick another model…' : 'Choose a model…'),
    model.options.map(m => h('option', { value: m.id }, m.label))) : null,
    model.problem ? h('p', { class: 'banner' }, model.problem) : null);
}

function backgroundRow(step, board, off) {
  return h('fieldset', { id: 'background', class: 'sources' },
    h('legend', {}, 'Background for the reviewer'),
    step.choices.map(c => h('label', { class: 'source' },
      h('input', {
        type: 'radio', name: 'background', id: `background-${c.id}`, value: c.id, checked: c.id === step.choice, disabled: off || !c.available,
        onChange: () => whenSaved(board, () => board.act({ type: 'background', choice: c.id })),
      }), ` ${c.label}`,
      c.reason ? h('span', { class: 'muted', id: `background-${c.id}-reason` }, ` ${c.reason}`) : null)));
}

/** A ticket read for the key in the field is going on. */
const readingTicket = (step, board) => step.ticket.state === 'reading' || Boolean(board.running(`read-ticket:${step.ticketKey}`));

const TICKET_STATE_TEXT = {
  idle: 'Not read yet.',
  reading: 'Reading the ticket…',
  read: 'Read from Jira. What you leave in the box is what the reviewer gets.',
};

function ticketBlock(step, board, off) {
  const { ticket } = step;
  const reading = readingTicket(step, board);
  return [
    h('div', { class: 'bar' },
      h('label', {}, 'Ticket key', fieldInput('input', 'ticket-key', step.ticketKey, board, off, { type: 'text', size: 16, placeholder: 'PROJ-123', 'aria-label': 'Ticket key' }))),
    ticket.state === 'failed'
      ? h('p', { id: 'ticket-reason', class: 'banner', role: 'status' }, ticket.reason ?? 'The ticket could not be read.')
      : h('p', { id: 'ticket-state', class: 'muted', role: 'status' }, TICKET_STATE_TEXT[ticket.state] ?? ''),
    textField('ticket-text', 'Ticket text', ticket.text, board, off || reading, 10),
  ];
}

/** The key whose read this page asked for and the session has not taken up yet, so a repaint does not ask twice. */
let readAsked;

/** Starts the ticket read the session asks for, once: when the ticket is picked, its key changes, or on open. */
function readTicketWhenNeeded(step, board, off) {
  if (!step.ticket.readNeeded) { readAsked = undefined; return; }
  if (off || readAsked === step.ticketKey || board.running(`read-ticket:${step.ticketKey}`)) return;
  readAsked = step.ticketKey;
  queueMicrotask(() => { void whenSaved(board, () => board.run({ type: 'read-ticket' })); });
}

function firstStep(view, board, off) {
  const step = view.firstStep;
  const fields = { 'own-text': step.ownText, 'ticket-text': step.ticket.text, 'ticket-key': step.ticketKey };
  const reading = step.choice === 'ticket' && readingTicket(step, board);
  readTicketWhenNeeded(step, board, off);
  return h('section', { id: 'first-step', 'aria-label': 'First step' },
    modelRow(view, board, off),
    h('h2', {}, 'Background'),
    backgroundRow(step, board, off),
    step.choice === 'ticket' ? ticketBlock(step, board, off) : null,
    step.choice === 'text' ? textField('own-text', 'Your text: a goal, or what the reviewer should watch for', step.ownText, board, off, 4) : null,
    step.notice ? h('p', { id: 'first-step-notice', class: 'banner', role: 'status' }, step.notice) : null,
    h('div', { class: 'bar' },
      h('vscode-button', {
        id: 'start', disabled: off || reading || !step.canStart,
        onClick: () => afterSaving(board, fields, () => board.run({ type: 'start' })),
      }, 'Start'),
      step.storedReview ? h('vscode-button', { id: 'back-to-review', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'back-to-review' })) }, 'Back to the review') : null,
      step.startBlocker ? h('span', { class: 'muted' }, step.startBlocker) : null));
}

// ---- the results ------------------------------------------------------------------------------

function passPicker(picker, board, off) {
  return h('section', { id: 'pass-picker', 'aria-label': 'Extra passes' },
    h('h2', {}, 'Extra passes'),
    h('p', { id: 'pass-suggestion' }, picker.suggestion),
    h('fieldset', { class: 'passes' },
      h('legend', {}, 'Passes to run'),
      picker.choices.map(c => h('label', { class: 'pass' },
        h('input', {
          type: 'checkbox', id: `pass-${c.step}`, checked: c.picked, disabled: off || !c.available,
          onChange: e => { const picked = Boolean(e.target.checked); return whenSaved(board, () => board.act({ type: 'pick-pass', step: c.step, picked })); },
        }), ` ${c.label}`,
        c.suggested ? h('span', { class: 'muted' }, ' (suggested)') : null,
        c.run ? h('span', { class: 'muted', id: `pass-${c.step}-run` }, ' (run)') : null,
        c.reason && !c.run ? h('span', { class: 'muted' }, ` ${c.reason}`) : null))),
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'run-selected', disabled: off || !picker.canRun, onClick: () => whenSaved(board, () => board.run({ type: 'passes' })) }, 'Run selected'),
      h('vscode-button', { id: 'keep-as-is', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'keep-as-is' })) }, 'Keep as is'),
      picker.runBlocker ? h('span', { class: 'muted' }, picker.runBlocker) : null));
}

// ---- the findings ------------------------------------------------------------------------------

/** The last Copy's result line, shown after the Copy buttons and read out by the live region. */
let copyLine;

/** Every draft box's text in the session, so a typed draft is saved before a run, a selection or Post. */
function draftFields(r) {
  return Object.fromEntries(r.findings.filter(f => f.draft).map(f => [`draft-${f.number}`, f.draft.text]));
}

function draftBlock(f, r, board, off) {
  const d = f.draft;
  const n = f.number;
  const rewriting = Boolean(board.running(`rewrite:${n}`));
  const locked = off || rewriting || Boolean(d.posted);
  const instructionId = `instruction-${n}`;
  return h('div', { class: 'draft', id: `draft-block-${n}` },
    h('label', { class: 'field' }, `Comment for #${n}`, fieldInput('textarea', `draft-${n}`, d.text, board, locked, { rows: 8, 'aria-label': `Comment for #${n}` })),
    d.outdated && !d.posted ? h('p', { class: 'muted', id: `outdated-${n}` },
      'The explanation changed since this draft was made. Regenerate rebuilds it from the finding and its explanation; your edits are lost. ',
      h('vscode-button', { id: `regenerate-${n}`, secondary: true, disabled: locked, onClick: () => whenSaved(board, () => board.act({ type: 'regenerate', number: n })) }, 'Regenerate')) : null,
    d.posted ? h('p', { id: `posted-${n}`, role: 'status' }, d.posted) : h('div', { class: 'bar' },
      h('input', {
        type: 'text', id: instructionId, size: 40, placeholder: 'How should the comment change?', 'aria-label': `Rewrite instruction for #${n}`,
        value: typed[instructionId] ?? '', disabled: locked, onInput: e => { typed[instructionId] = e.target.value; },
      }),
      h('vscode-button', {
        id: `rewrite-${n}`, secondary: true, disabled: locked,
        onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'rewrite', number: n, instruction: typed[instructionId] ?? '' })),
      }, rewriting ? 'Rewriting…' : 'Rewrite'),
      d.canUndo ? h('vscode-button', { id: `undo-${n}`, secondary: true, disabled: locked, onClick: () => whenSaved(board, () => board.act({ type: 'undo-rewrite', number: n })) }, 'Undo') : null),
    d.rewriteError ? h('p', { id: `rewrite-error-${n}`, class: 'banner error', role: 'alert' }, d.rewriteError) : null,
    d.postError ? h('p', { id: `post-error-${n}`, class: 'banner error', role: 'alert' }, d.postError) : null);
}

function findingItem(f, r, board, off) {
  const n = f.number;
  const explaining = Boolean(board.running(`explain:${n}`));
  return h('li', { id: `finding-${n}`, value: n },
    h('input', {
      type: 'checkbox', id: `select-${n}`, checked: f.selected, disabled: off, 'aria-label': `Select #${n} for Post and Copy`,
      onChange: e => afterSaving(board, draftFields(r), () => board.act({ type: 'select', numbers: [n], selected: Boolean(e.target.checked) })),
    }), ' ',
    h('span', { class: `severity severity-${f.severity}` }, `#${n} ${SEVERITY_TEXT[f.severity] ?? f.severity}`), ' ',
    h('span', { class: 'location' }, f.location), ' ',
    h('span', { class: 'title' }, f.title),
    f.markers.length ? h('span', { class: 'muted markers' }, ` (${f.markers.join(', ')})`) : null,
    f.facts?.length ? h('p', { id: `facts-${n}`, class: 'muted facts' }, f.facts.join(' · ')) : null,
    f.description ? h('p', { id: `description-${n}`, class: 'description' }, f.description) : null,
    f.recommendation ? h('p', { id: `recommendation-${n}`, class: 'recommendation' }, `Recommendation: ${f.recommendation}`) : null,
    ' ', h('vscode-button', {
      id: `explain-${n}`, secondary: true, disabled: off || explaining,
      onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'explain', number: n })),
    }, explaining ? 'Explaining…' : 'Explain'),
    f.explanation ? h('pre', { id: `explanation-${n}`, class: 'coverage explanation' }, f.explanation) : null,
    f.explainError ? h('p', { id: `explain-error-${n}`, class: 'banner error', role: 'alert' }, f.explainError) : null,
    f.draft ? draftBlock(f, r, board, off) : null);
}

/** Copy names the format and the selected numbers; the extension builds the text from the session. */
async function copy(board, r, format) {
  const numbers = r.findings.filter(f => f.selected).map(f => f.number);
  try {
    const reply = await api('copy', { format, numbers });
    copyLine = reply.outcome === 'copied'
      ? { text: `Copied ${reply.count} finding${reply.count === 1 ? '' : 's'}.` }
      : { text: `Not copied: ${reply.reason}`, error: true };
  } catch (err) {
    copyLine = { text: `Not copied: ${err.message}`, error: true };
  }
  board.repaint();
}

function findingsBlock(r, board, off) {
  const all = r.findings.map(f => f.number);
  const copyScope = r.copy?.scope === 'selected' ? `${r.copy.count} selected` : `all ${r.copy?.count ?? all.length}`;
  const post = r.post ?? { count: 0, blocker: 'Select the findings to post.' };
  return [
    h('h2', {}, `Findings (${r.findings.length})`),
    r.findings.length === 0 ? (r.running?.what === 'regular'
      ? h('p', { id: 'no-findings-yet', class: 'muted' }, 'No findings yet.')
      : h('p', { id: 'no-issues' }, 'No issues found.')) : [
      h('label', { class: 'select-all' }, h('input', {
        type: 'checkbox', id: 'select-all', checked: r.findings.every(f => f.selected), disabled: off,
        onChange: e => afterSaving(board, draftFields(r), () => board.act({ type: 'select', numbers: all, selected: Boolean(e.target.checked) })),
      }), ' Select all'),
      h('ol', { id: 'findings', class: 'findings' }, r.findings.map(f => findingItem(f, r, board, off))),
      h('div', { class: 'bar', id: 'findings-actions' },
        h('vscode-button', {
          id: 'post', disabled: off || post.count === 0,
          onClick: () => afterSaving(board, draftFields(r), () => board.preview({ type: 'post' })),
        }, `Post ${post.count} comment(s)`),
        post.blocker ? h('span', { class: 'muted' }, post.blocker) : null,
        h('vscode-button', { id: 'copy-teams', secondary: true, onClick: () => afterSaving(board, draftFields(r), () => copy(board, r, 'teams')) }, `Copy ${copyScope} for Teams`),
        h('vscode-button', { id: 'copy-markdown', secondary: true, onClick: () => afterSaving(board, draftFields(r), () => copy(board, r, 'markdown')) }, `Copy ${copyScope} as Markdown`)),
      copyLine ? h('p', { id: 'copy-result', class: copyLine.error ? 'banner error' : 'muted', role: copyLine.error ? 'alert' : null }, copyLine.text) : null,
    ],
  ];
}

function results(view, board, off) {
  const r = view.results;
  return h('section', { id: 'results', 'aria-label': 'Review' },
    h('p', { id: 'review-header', class: 'muted' },
      [`Model: ${r.model || 'unknown'}`, `Passes run: ${r.passesRun.length ? r.passesRun.join(', ') : 'none'}`].join(' · ')),
    r.tokens.length ? h('ul', { id: 'tokens', class: 'muted', 'aria-label': 'Token usage per pass' },
      r.tokens.map(t => h('li', {}, `${t.pass}: ${t.text}`))) : null,
    view.progress ? h('p', { id: 'progress-text', class: 'muted' }, view.progress) : null,
    r.outOfDate ? h('p', { id: 'out-of-date', class: 'banner', role: 'status' },
      `Out of date: the pull request has a new commit (${r.outOfDate.head}) since this review read ${r.outOfDate.reviewed}. Nothing runs by itself; Run again reviews it at the new commit.`) : null,
    r.statuses.map((line, i) => h('p', { id: `pass-status-${i}`, class: 'banner' }, line)),
    r.notes?.length ? h('section', { id: 'review-notes', 'aria-label': 'Not reviewed and dropped' },
      h('h2', {}, 'Not reviewed and dropped'),
      h('ul', {}, r.notes.map((line, i) => h('li', { id: `review-note-${i}` }, line)))) : null,
    r.notice ? h('p', { id: 'review-notice', class: 'banner', role: 'status' }, r.notice) : null,
    r.hasReview || r.running?.what === 'regular' ? [
      r.picker ? passPicker(r.picker, board, off) : null,
      findingsBlock(r, board, off),
    ] : null,
    h('div', { class: 'bar' },
      r.canRunAgain ? h('vscode-button', { id: 'run-again', disabled: off, onClick: () => whenSaved(board, () => board.run({ type: 'again' })) }, 'Run again') : null,
      h('vscode-button', { id: 'new-review', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'new-review' })) }, 'New review')));
}

startBoard({
  root: document.getElementById('root'),
  loading: () => h('p', { class: 'muted' }, 'Reading the pull request…'),
  render: (view, board, locked) => {
    announce(view.progress ?? copyLine?.text ?? '');
    return h('div', {},
      headerLine(view),
      view.stage === 'first-step' ? [view.progress ? h('p', { id: 'progress-text', class: 'muted' }, view.progress) : null, firstStep(view, board, locked)]
        : results(view, board, locked));
  },
});
