import { announce, api, h, startBoard } from '../shared/board.js';

// The pull request review board. The first step: the model and one background for the reviewer (a
// Jira ticket read into an editable box, the developer's own text, or none); only the ticket read
// runs before Start, and Start waits for it. The results: a summary band above two columns, the
// findings list on the left and the finding picked on the right. The band follows the review: while
// a pass runs it shows a progress line per pass with Stop, the background and the tokens so far;
// after a run it is open with the counts, the next passes (the suggested ones preselected), the
// background, what was not reviewed and the tokens; once the developer picks a finding it folds to
// one line with More passes and Run again. Findings join the list as batches finish. Nothing is
// picked by itself: until the developer picks a finding the detail pane shows the review so far.
// The detail pane shows the finding, the code around its line, its discussion (answers rendered
// from the Markdown tree the extension sends; a link opens through the extension), Discuss in chat,
// and the draft comment with Edit and Preview, Rewrite, Undo and Regenerate. The list's footer has
// Select all, Post and Copy. On a narrow tab the list fills it and a picked finding opens over the
// list; Escape and Back close it and return to the same entry. Copy names only the format and the
// selected numbers: the extension builds the text. The page keeps what is being typed and not sent
// yet, the finding picked, the Preview toggles and whether the tab is narrow; everything else is the
// session's. Everything from Bitbucket, Jira or the model is written as text.

/** Text typed into a field and not sent yet, by field id; the session holds the rest. */
const typed = {};
/** The last field change on its way to the session, so a button pressed right after waits for it. */
let saving = Promise.resolve();

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

// ---- the page's own state ------------------------------------------------------------------------

/** Below this width of the board the list fills the tab and an opened finding is shown over it. */
const NARROW_WIDTH = 720;
/** The tab is too narrow for two columns. Wide until the board's width is known. */
let narrow = false;
/** The finding open in the detail pane, by number; nothing is open until the developer picks one. */
let opened;
/** The findings whose draft is shown as Preview instead of the text box. */
const previewing = new Set();
/** The Copy menu of a narrow tab is open. */
let copyMenuOpen = false;
/** The last Copy's result line, shown in the list footer and read out by the live region. */
let copyLine;
/** The last Discuss in chat's result line, under its finding: `{ number, text, error }`. */
let discussLine;
/** The last link that could not be opened, read out by the live region. */
let linkLine;
/** The board, once it runs, for the width watcher. */
let boardRef;

/** Watches the board's width; without ResizeObserver the board stays in two columns. */
function watchWidth(root) {
  if (typeof ResizeObserver !== 'function') return;
  new ResizeObserver(entries => {
    const width = entries[entries.length - 1]?.contentRect?.width;
    if (typeof width !== 'number') return;
    const next = width < NARROW_WIDTH;
    if (next === narrow) return;
    narrow = next;
    copyMenuOpen = false;
    boardRef?.repaint();
  }).observe(root);
}

// ---- rendered Markdown ---------------------------------------------------------------------------

/**
 * Built elements of rendered Markdown by place and text, so a repaint on every progress tick reuses
 * them instead of building the same answer again. The extension renders the Markdown to a tree of
 * allowed elements; the page builds each with `h()`, and every text stays text.
 */
const builtTrees = new Map();
const MAX_BUILT_TREES = 100;

function markdownBlock(id, text, tree) {
  const key = `${id}\u0000${text}`;
  let el = builtTrees.get(key);
  if (!el) {
    el = h('div', { class: 'markdown' }, (tree ?? []).map(block));
    if (builtTrees.size >= MAX_BUILT_TREES) builtTrees.delete(builtTrees.keys().next().value);
    builtTrees.set(key, el);
  }
  el.id = id;
  return el;
}

/** A link carries its target as data, never as a live link: the extension opens it after VS Code's own confirmation. */
async function openLink(url) {
  linkLine = undefined;
  try {
    await api('open-link', { url });
  } catch (err) {
    linkLine = `Not opened: ${err.message}`;
    announce(linkLine);
  }
}

function inline(node) {
  switch (node.type) {
    case 'text': return node.text;
    case 'code': return h('code', {}, node.text);
    case 'emphasis': return h('em', {}, node.children.map(inline));
    case 'strong': return h('strong', {}, node.children.map(inline));
    case 'break': return h('br', {});
    case 'link': return h('span', {
      class: 'link', role: 'link', tabIndex: 0, 'data-url': node.href, title: node.href,
      onClick: () => openLink(node.href),
      onKeydown: e => { if (e.key === 'Enter') { e.preventDefault(); void openLink(node.href); } },
    }, node.children.map(inline));
    default: return '';
  }
}

function cell(tag, c) {
  return h(tag, { class: c.align ? `align-${c.align}` : null }, c.children.map(inline));
}

function block(node) {
  switch (node.type) {
    case 'paragraph': return h('p', { class: node.tight ? 'tight' : null }, node.children.map(inline));
    case 'heading': return h(`h${Math.min(6, node.level + 2)}`, {}, node.children.map(inline));
    case 'list': return h(node.ordered ? 'ol' : 'ul', { start: node.ordered && node.start !== undefined ? node.start : undefined },
      node.items.map(item => h('li', {}, item.children.map(block))));
    case 'code-block': return h('pre', { class: 'code-block' },
      h('code', { class: node.language ? `language-${node.language}` : null }, node.spans.map(span => (span.cls ? h('span', { class: span.cls }, span.text) : span.text))));
    case 'blockquote': return h('blockquote', {}, node.children.map(block));
    case 'table': return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, node.head.map(row => h('tr', {}, row.map(c => cell('th', c))))),
      h('tbody', {}, node.body.map(row => h('tr', {}, row.map(c => cell('td', c)))))));
    default: return null;
  }
}

// ---- the summary band ----------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function countsText(c) {
  return [plural(c.total, 'finding'), `${c.critical} critical`, plural(c.warning, 'warning'), plural(c.suggestion, 'suggestion'), `${c.againstGoal} against goal`].join(' · ');
}

function passPicker(picker, board, off) {
  const picked = picker.choices.filter(c => c.picked).length;
  return h('section', { id: 'pass-picker', 'aria-label': 'Next passes' },
    h('h3', {}, 'Next passes'),
    h('p', { id: 'pass-suggestion', class: 'muted' }, picker.suggestion),
    h('fieldset', { class: 'passes' },
      h('legend', { class: 'visually-hidden' }, 'Passes to run'),
      picker.choices.map(c => h('label', { class: 'pass' },
        h('input', {
          type: 'checkbox', id: `pass-${c.step}`, checked: c.picked, disabled: off || !c.available,
          onChange: e => { const on = Boolean(e.target.checked); return whenSaved(board, () => board.act({ type: 'pick-pass', step: c.step, picked: on })); },
        }), ` ${c.label}`,
        c.suggested ? h('span', { class: 'muted' }, ' (suggested)') : null,
        c.run ? h('span', { class: 'muted', id: `pass-${c.step}-run` }, ' (run)') : null,
        c.reason && !c.run ? h('span', { class: 'muted' }, ` ${c.reason}`) : null))),
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'run-selected', disabled: off || !picker.canRun, onClick: () => whenSaved(board, () => board.run({ type: 'passes' })) }, `Run selected (${picked})`),
      h('vscode-button', { id: 'keep-as-is', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'keep-as-is' })) }, 'Not now'),
      picker.runBlocker ? h('span', { class: 'muted' }, picker.runBlocker) : null));
}

function reviewButtons(r, board, off) {
  return [
    r.canRunAgain ? h('vscode-button', { id: 'run-again', secondary: true, disabled: off, onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'again' })) }, 'Run again') : null,
    h('vscode-button', { id: 'new-review', secondary: true, disabled: off, onClick: () => afterSaving(board, draftFields(r), () => board.act({ type: 'new-review' })) }, 'New review'),
  ];
}

function runningBand(view, r, board) {
  const run = r.running;
  const lines = run.passes?.length ? run.passes : [{ step: run.step, text: view.progress ?? '', done: run.done, total: run.total }];
  return h('section', { id: 'band', class: 'band running', 'aria-label': 'Review summary' },
    h('h2', {}, run.what === 'regular' ? 'Regular pass · running' : 'Extra passes · running'),
    h('ul', { id: 'run-lines', class: 'run-lines' }, lines.map(l => h('li', { id: `run-line-${l.step}` },
      h('span', {}, l.text),
      l.total > 0 ? h('progress', { max: l.total, value: l.done, 'aria-label': l.text }) : null))),
    run.note ? h('p', { id: 'run-note', class: 'muted' }, run.note) : null,
    h('p', { id: 'progress-text', class: 'visually-hidden' }, view.progress ?? ''),
    h('p', { id: 'band-background' }, `Background: ${r.band.background}`),
    h('div', { class: 'bar' },
      h('span', { id: 'band-tokens', class: 'muted' }, `Tokens so far: ${r.band.tokens || 'none counted yet'}`),
      h('vscode-button', { id: 'stop-run', onClick: () => board.stop() }, 'Stop')));
}

function openBand(r, board, off) {
  return h('section', { id: 'band', class: 'band', 'aria-label': 'Review summary' },
    h('div', { class: 'band-head' },
      h('h2', {}, 'Summary'),
      r.hasReview ? h('vscode-button', { id: 'band-fold', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'band', open: false })) }, 'Fold') : null),
    h('p', { id: 'review-header', class: 'muted' },
      [`Model: ${r.model || 'unknown'}`, `Passes run: ${r.passesRun.length ? r.passesRun.join(', ') : 'none'}`].join(' · ')),
    r.hasReview ? h('p', { id: 'band-counts' }, countsText(r.band.counts)) : null,
    r.picker ? passPicker(r.picker, board, off) : null,
    h('p', { id: 'band-background' }, `Background: ${r.band.background}`),
    r.notes?.length ? h('section', { id: 'review-notes', 'aria-label': 'Not reviewed and dropped' },
      h('h3', {}, 'Not reviewed and dropped'),
      h('ul', {}, r.notes.map((line, i) => h('li', { id: `review-note-${i}` }, line)))) : null,
    r.tokens.length ? h('ul', { id: 'tokens', class: 'muted', 'aria-label': 'Token usage per pass' },
      r.tokens.map(t => h('li', {}, `${t.pass}: ${t.text}`))) : null,
    h('div', { class: 'bar' }, reviewButtons(r, board, off)));
}

function foldedBand(r, board, off) {
  const b = r.band;
  const parts = [
    countsText(b.counts),
    `passes: ${r.passesRun.length ? r.passesRun.join(', ') : 'none'}`,
    `background: ${b.background}`,
    `not reviewed: ${b.notReviewed.length}`,
    `tokens: ${b.tokens || 'none'}`,
  ];
  return h('section', { id: 'band', class: 'band folded', 'aria-label': 'Review summary' },
    h('p', { id: 'band-line' }, parts.join(' · ')),
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'more-passes', secondary: true, disabled: off, onClick: () => whenSaved(board, () => board.act({ type: 'band', open: true })) }, 'More passes'),
      reviewButtons(r, board, off)));
}

function band(view, r, board, off) {
  if (r.band.state === 'running' && r.running) return runningBand(view, r, board);
  return r.band.state === 'folded' ? foldedBand(r, board, off) : openBand(r, board, off);
}

// ---- the findings list ---------------------------------------------------------------------------

const SEVERITY_TEXT = { critical: 'Critical', warning: 'Warning', suggestion: 'Suggestion' };

/** Every draft box's text in the session, so a typed draft is saved before a run, a selection or Post. */
function draftFields(r) {
  return Object.fromEntries(r.findings.filter(f => f.draft).map(f => [`draft-${f.number}`, f.draft.text]));
}

/** Opens a finding in the detail pane; the first pick after a run folds the band. */
function openFinding(n, r, board, off) {
  opened = n;
  copyMenuOpen = false;
  board.repaint();
  if (narrow) document.getElementById('back-to-list')?.focus();
  if (r.band.state === 'open' && r.hasReview && !off) void whenSaved(board, () => board.act({ type: 'band', open: false }, { quiet: true }));
}

/** Back to the list on a narrow tab: the overlay closes and the focus returns to the same entry. */
function closeFinding(board) {
  const n = opened;
  opened = undefined;
  board.repaint();
  document.getElementById(`entry-${n}`)?.focus();
}

function listEntry(f, r, board, off) {
  const n = f.number;
  return h('li', { id: `finding-${n}`, class: opened === n ? 'entry open' : 'entry' },
    h('input', {
      type: 'checkbox', id: `select-${n}`, checked: f.selected, disabled: off, 'aria-label': `Select #${n} for Post and Copy`,
      onChange: e => afterSaving(board, draftFields(r), () => board.act({ type: 'select', numbers: [n], selected: Boolean(e.target.checked) })),
    }),
    h('button', {
      type: 'button', id: `entry-${n}`, class: 'entry-open', 'aria-current': opened === n ? 'true' : null,
      onClick: () => openFinding(n, r, board, off),
    },
    h('span', { class: 'number' }, `#${n}`), ' ',
    h('span', { class: `severity severity-${f.severity}` }, SEVERITY_TEXT[f.severity] ?? f.severity), ' ',
    h('span', { class: 'title' }, f.title), ' ',
    h('span', { class: 'location' }, f.location),
    f.markers.map(m => [' ', h('span', { class: `marker marker-${m.replace(/[^a-z]+/g, '-')}` }, m)])));
}

/** Copy names the format and the selected numbers; the extension builds the text from the session. */
async function copy(board, r, format) {
  const numbers = r.findings.filter(f => f.selected).map(f => f.number);
  discussLine = undefined;
  copyMenuOpen = false;
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

function copyButtons(r, board) {
  const scope = r.copy?.scope === 'selected' ? `${r.copy.count} selected` : `all ${r.copy?.count ?? r.findings.length}`;
  const item = (id, format, label) => h('vscode-button', {
    id, secondary: true, role: narrow ? 'menuitem' : null,
    onClick: () => afterSaving(board, draftFields(r), () => copy(board, r, format)),
  }, label);
  if (!narrow) return [item('copy-teams', 'teams', `Copy ${scope} for Teams`), item('copy-markdown', 'markdown', `Copy ${scope} as Markdown`)];
  return h('span', { class: 'copy-menu' },
    h('vscode-button', {
      id: 'copy-menu', secondary: true, 'aria-haspopup': 'menu', 'aria-expanded': copyMenuOpen ? 'true' : 'false',
      onClick: () => { copyMenuOpen = !copyMenuOpen; board.repaint(); if (copyMenuOpen) document.getElementById('copy-teams')?.focus(); },
    }, `Copy ${scope}`),
    copyMenuOpen ? h('span', {
      id: 'copy-menu-items', class: 'menu', role: 'menu', 'aria-label': 'Copy format',
      onKeydown: e => { if (e.key === 'Escape') { e.preventDefault(); copyMenuOpen = false; board.repaint(); document.getElementById('copy-menu')?.focus(); } },
    }, item('copy-teams', 'teams', 'Copy for Teams'), item('copy-markdown', 'markdown', 'Copy as Markdown')) : null);
}

function listFooter(r, board, off) {
  const all = r.findings.map(f => f.number);
  const post = r.post ?? { count: 0, blocker: 'Select the findings to post.' };
  return h('div', { id: 'findings-actions', class: 'list-footer' },
    h('div', { class: 'bar' },
      h('label', { class: 'select-all' }, h('input', {
        type: 'checkbox', id: 'select-all', checked: all.length > 0 && r.findings.every(f => f.selected), disabled: off || all.length === 0,
        onChange: e => afterSaving(board, draftFields(r), () => board.act({ type: 'select', numbers: all, selected: Boolean(e.target.checked) })),
      }), ' Select all'),
      h('vscode-button', {
        id: 'post', disabled: off || post.count === 0,
        onClick: () => afterSaving(board, draftFields(r), () => board.preview({ type: 'post' })),
      }, `Post ${plural(post.count, 'comment')}`),
      copyButtons(r, board)),
    post.blocker ? h('p', { id: 'post-blocker', class: 'muted' }, post.blocker) : null,
    copyLine ? h('p', { id: 'copy-result', class: copyLine.error ? 'banner error' : 'muted', role: copyLine.error ? 'alert' : null }, copyLine.text) : null);
}

function findingsList(r, board, off) {
  const live = r.running?.what === 'regular';
  return [
    h('h2', { id: 'findings-heading' }, `Findings (${r.findings.length})`, live ? h('span', { class: 'muted' }, ' — more coming') : null),
    r.findings.length === 0
      ? (live ? h('p', { id: 'no-findings-yet', class: 'muted' }, 'No findings yet.') : h('p', { id: 'no-issues' }, 'No issues found.'))
      : h('ul', { id: 'findings', class: 'findings', 'aria-labelledby': 'findings-heading' }, r.findings.map(f => listEntry(f, r, board, off))),
  ];
}

// ---- the detail pane -----------------------------------------------------------------------------

const SIGN = { added: '+', removed: '-', context: ' ' };

function codeBlock(f) {
  const n = f.number;
  if (!f.excerpt?.length) return h('p', { id: `code-note-${n}`, class: 'muted' }, f.excerptNote ?? 'No code to show.');
  return h('pre', { id: `code-${n}`, class: 'excerpt', 'aria-label': `Code around #${n}` }, f.excerpt.map(l => h('span', {
    class: `code-line ${l.kind}${l.marked ? ' marked' : ''}`,
  },
  h('span', { class: 'ln' }, l.line === undefined ? '' : String(l.line)),
  h('span', { class: 'sign' }, SIGN[l.kind] ?? ' '),
  l.marked ? h('span', { class: 'visually-hidden' }, 'The finding\'s line: ') : null,
  l.text)));
}

/** Discuss in chat names the finding only; the extension builds the prompt and opens Copilot Chat. */
async function discuss(board, n) {
  copyLine = undefined;
  try {
    const reply = await api('discuss', { number: n });
    discussLine = reply.outcome === 'opened' ? { number: n, text: `Copilot Chat is open with a prompt about #${n}. Add your question and send it.` }
      : reply.outcome === 'copied' ? { number: n, text: `Copilot Chat could not be opened, so the prompt about #${n} was copied. Paste it into Copilot Chat in Agent mode and add your question.` }
        : { number: n, text: `Not opened: ${reply.reason}`, error: true };
  } catch (err) {
    discussLine = { number: n, text: `Not opened: ${err.message}`, error: true };
  }
  board.repaint();
}

/** The discussion of a finding: each question and its rendered answer, then the follow-up box. */
function threadBlock(f, r, board, off) {
  const n = f.number;
  const asking = Boolean(board.running(`follow-up:${n}`));
  const questionId = `follow-up-question-${n}`;
  return h('div', { class: 'thread', id: `thread-${n}` },
    h('ol', { class: 'turns', 'aria-label': `Discussion of #${n}` }, f.thread.map((t, i) => h('li', { id: `turn-${n}-${i + 1}` },
      h('p', { class: 'muted question' }, i === 0 ? 'Explain' : `You: ${t.question}`),
      markdownBlock(`answer-${n}-${i + 1}`, t.answer, t.tree)))),
    h('div', { class: 'bar' },
      h('input', {
        type: 'text', id: questionId, size: 40, placeholder: 'Ask a follow-up', 'aria-label': `Follow-up question on #${n}`,
        value: typed[questionId] ?? '', disabled: off || asking, onInput: e => { typed[questionId] = e.target.value; },
      }),
      h('vscode-button', {
        id: `follow-up-${n}`, secondary: true, disabled: off || asking,
        onClick: () => afterSaving(board, draftFields(r), async () => {
          const question = typed[questionId] ?? '';
          // The question stays in the box when the board refuses it.
          if (await board.run({ type: 'follow-up', number: n, question })) delete typed[questionId];
        }),
      }, asking ? 'Asking…' : 'Ask')));
}

function draftBlock(f, r, board, off) {
  const d = f.draft;
  const n = f.number;
  const rewriting = Boolean(board.running(`rewrite:${n}`));
  const regenerating = Boolean(board.running(`regenerate:${n}`));
  const locked = off || rewriting || regenerating || Boolean(d.posted);
  const instructionId = `instruction-${n}`;
  const preview = previewing.has(n);
  return h('div', { class: 'draft', id: `draft-block-${n}` },
    h('div', { class: 'bar toggle', role: 'group', 'aria-label': `Comment for #${n}: edit or preview` },
      h('vscode-button', {
        id: `draft-edit-${n}`, secondary: preview, 'aria-pressed': preview ? 'false' : 'true',
        onClick: () => { previewing.delete(n); board.repaint(); },
      }, 'Edit'),
      h('vscode-button', {
        id: `draft-preview-${n}`, secondary: !preview, 'aria-pressed': preview ? 'true' : 'false',
        onClick: () => afterSaving(board, draftFields(r), () => { previewing.add(n); board.repaint(); }),
      }, 'Preview')),
    preview
      ? h('div', { class: 'preview', 'aria-label': `Preview of the comment for #${n}` }, markdownBlock(`draft-preview-body-${n}`, d.text, d.preview))
      : h('label', { class: 'field' }, `Comment for #${n}`, fieldInput('textarea', `draft-${n}`, d.text, board, locked, { rows: 8, 'aria-label': `Comment for #${n}` })),
    d.outdated && !d.posted ? h('p', { class: 'muted', id: `outdated-${n}` },
      'The discussion changed since this draft was made. Regenerate writes it again from the finding and the discussion; Undo brings your text back. ',
      h('vscode-button', { id: `regenerate-${n}`, secondary: true, disabled: locked, onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'regenerate', number: n })) }, regenerating ? 'Regenerating…' : 'Regenerate')) : null,
    d.posted ? h('p', { id: `posted-${n}`, role: 'status' }, d.posted) : h('div', { class: 'bar' },
      h('input', {
        type: 'text', id: instructionId, size: 40, placeholder: 'How should the comment change?', 'aria-label': `Rewrite instruction for #${n}`,
        value: typed[instructionId] ?? '', disabled: locked, onInput: e => { typed[instructionId] = e.target.value; },
      }),
      h('vscode-button', {
        id: `rewrite-${n}`, secondary: true, disabled: locked,
        onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'rewrite', number: n, instruction: typed[instructionId] ?? '' })),
      }, rewriting ? 'Rewriting…' : 'Rewrite'),
      d.canUndo ? h('vscode-button', { id: `undo-${n}`, secondary: true, disabled: locked, onClick: () => afterSaving(board, draftFields(r), () => board.act({ type: 'undo-rewrite', number: n })) }, 'Undo') : null),
    d.rewriteError ? h('p', { id: `rewrite-error-${n}`, class: 'banner error', role: 'alert' }, d.rewriteError) : null,
    d.postError ? h('p', { id: `post-error-${n}`, class: 'banner error', role: 'alert' }, d.postError) : null);
}

function findingDetail(f, r, board, off) {
  const n = f.number;
  const explaining = Boolean(board.running(`explain:${n}`));
  return [
    narrow ? h('vscode-button', { id: 'back-to-list', secondary: true, onClick: () => closeFinding(board) }, '← Back to the findings') : null,
    h('h2', { id: 'detail-title' }, `#${n} · ${f.title}`),
    h('p', { id: `detail-location-${n}`, class: 'muted' },
      h('span', { class: `severity severity-${f.severity}` }, SEVERITY_TEXT[f.severity] ?? f.severity), ` · ${f.location}`,
      f.markers.map(m => [' ', h('span', { class: `marker marker-${m.replace(/[^a-z]+/g, '-')}` }, m)])),
    f.facts?.length ? h('p', { id: `facts-${n}`, class: 'muted facts' }, f.facts.join(' · ')) : null,
    f.description ? h('p', { id: `description-${n}`, class: 'description' }, f.description) : null,
    f.recommendation ? h('p', { id: `recommendation-${n}`, class: 'recommendation' }, `Recommendation: ${f.recommendation}`) : null,
    h('h3', {}, 'Code'),
    codeBlock(f),
    h('h3', {}, 'Discussion'),
    f.thread?.length ? threadBlock(f, r, board, off) : h('div', { class: 'bar' }, h('vscode-button', {
      id: `explain-${n}`, secondary: true, disabled: off || explaining,
      onClick: () => afterSaving(board, draftFields(r), () => board.run({ type: 'explain', number: n })),
    }, explaining ? 'Explaining…' : 'Explain')),
    f.threadError ? h('p', { id: `thread-error-${n}`, class: 'banner error', role: 'alert' }, f.threadError) : null,
    h('div', { class: 'bar' }, h('vscode-button', {
      id: `discuss-${n}`, secondary: true, disabled: off,
      onClick: () => afterSaving(board, draftFields(r), () => discuss(board, n)),
    }, 'Discuss in chat')),
    discussLine?.number === n ? h('p', { id: `discuss-result-${n}`, class: discussLine.error ? 'banner error' : 'muted', role: discussLine.error ? 'alert' : null }, discussLine.text) : null,
    h('h3', {}, 'Draft comment'),
    f.draft ? draftBlock(f, r, board, off) : h('div', { class: 'bar' }, h('vscode-button', {
      id: `draft-start-${n}`, secondary: true, disabled: off,
      onClick: () => afterSaving(board, draftFields(r), () => board.act({ type: 'select', numbers: [n], selected: true })),
    }, 'Draft a comment'), h('span', { class: 'muted' }, 'Selects it for Post and drafts its comment.')),
  ];
}

/** Nothing is open: what the review covered so far. */
function reviewSoFar(r) {
  const seen = r.reviewed;
  const run = r.running?.what === 'regular' ? r.running : undefined;
  return h('div', { id: 'review-so-far' },
    h('h2', {}, run ? 'The review so far' : 'The review'),
    h('p', { id: 'so-far-counts' }, countsText(r.band.counts)),
    seen ? [
      h('p', { id: 'reviewed-summary' },
        `Reviewed ${plural(seen.files.length, 'file')} in ${plural(seen.batches, 'batch', 'batches')} at commit ${seen.commit}.`,
        run ? ` ${run.done} of ${run.total} batches finished so far.` : ''),
      h('ul', { id: 'reviewed-files', class: 'muted' }, seen.files.map(file => h('li', {}, file))),
    ] : h('p', { id: 'reviewed-summary', class: 'muted' }, 'Nothing reviewed yet.'),
    r.findings.length ? h('p', { class: 'muted' }, 'Pick a finding in the list to read it here.') : null);
}

function detailPane(r, board, off) {
  const f = r.findings.find(x => x.number === opened);
  return h('section', {
    id: 'detail', class: narrow ? 'detail overlay' : 'detail', 'aria-label': f ? `Finding #${f.number}` : 'Review so far',
    onKeydown: e => { if (narrow && f && e.key === 'Escape') { e.preventDefault(); closeFinding(board); } },
  }, f ? findingDetail(f, r, board, off) : reviewSoFar(r));
}

function columns(r, board, off) {
  // A finding the critic removed is no longer open.
  if (opened !== undefined && !r.findings.some(f => f.number === opened)) opened = undefined;
  const overlay = narrow && opened !== undefined;
  const list = h('div', { id: 'findings-column', class: 'list-column' },
    h('div', { class: 'list-area' }, findingsList(r, board, off), overlay ? detailPane(r, board, off) : null),
    listFooter(r, board, off));
  return h('div', { id: 'columns', class: narrow ? 'columns narrow' : 'columns' }, list, narrow ? null : detailPane(r, board, off));
}

function results(view, board, off) {
  const r = view.results;
  return h('section', { id: 'results', 'aria-label': 'Review' },
    r.outOfDate ? h('p', { id: 'out-of-date', class: 'banner', role: 'status' },
      `Out of date: the pull request has a new commit (${r.outOfDate.head}) since this review read ${r.outOfDate.reviewed}. Nothing runs by itself; Run again reviews it at the new commit.`) : null,
    r.statuses.map((line, i) => h('p', { id: `pass-status-${i}`, class: 'banner' }, line)),
    r.notice ? h('p', { id: 'review-notice', class: 'banner', role: 'status' }, r.notice) : null,
    band(view, r, board, off),
    r.hasReview || r.running?.what === 'regular' ? columns(r, board, off) : null);
}

boardRef = startBoard({
  root: document.getElementById('root'),
  loading: () => h('p', { class: 'muted' }, 'Reading the pull request…'),
  render: (view, board, locked) => {
    announce(view.progress ?? discussLine?.text ?? copyLine?.text ?? linkLine ?? '');
    return h('div', {},
      headerLine(view),
      view.stage === 'first-step' ? [view.progress ? h('p', { id: 'progress-text', class: 'muted' }, view.progress) : null, firstStep(view, board, locked)]
        : results(view, board, locked));
  },
});
watchWidth(document.getElementById('root'));
