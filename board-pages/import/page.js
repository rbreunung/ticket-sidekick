import { announce, h, startBoard, tablist, tabpanel } from '../shared/board.js';

// The import board: a Veracode or Waltz report against Jira, one tab per group (New, Already
// ticketed, Stale, Accepted for Waltz) and a tab of its own for a running ticket merge. Every
// choice belongs to the session; the page keeps only what is being typed or picked for one
// request (a ticket key, a reason, the rows picked for a merge) and which tab it shows while an
// Apply runs. Everything from the report or Jira is written as text.

const MERGE = 'merge';
const RESULT_TEXT = { failed: 'Failed', refused: 'Not written' };
const STEP_TEXT = { done: 'Done', failed: 'Failed', pending: 'Waiting', skipped: 'Skipped', ignored: 'Ignored', running: 'Running' };
/** How a merge in each state is described on its tab and in the tab's label; any other state is running. */
const MERGE_STATES = new Map([
  ['finished', { heading: 'The ticket merge has ended.', tab: 'ended' }],
  ['failed', { heading: 'A step failed. Retry it, ignore it, or stop the merge.', tab: 'a step failed' }],
  ['awaiting-close', { heading: 'Pick the target status and resolution for every issue type, then preview the close.', tab: 'waiting for answers' }],
]);
const MERGE_RUNNING = { heading: 'The merge is running.', tab: 'running' };

// Transient drafts, kept across repaints.
const drafts = { addKey: '', addMode: 'comment', reason: '', keepKey: '', keepRow: '', setShown: '', search: undefined, filter: {} };
/** Already-ticketed rows picked for a merge or an accept, by row id. */
const picked = new Set();
/** The tab the page shows instead of the session's: the merge tab, or a tab chosen while an Apply runs. */
let localTab;
/** Whether the page already showed the current merge run, so a new run opens its tab once. */
let mergeSeen = false;
/** The tab a preview was asked from, so the Apply summary shows above that tab's table. */
let previewTab;

// ---- results of an Apply ------------------------------------------------------------------

function countResults(results) {
  const done = results.filter(r => r.outcome === 'done').length;
  const failed = results.filter(r => r.outcome === 'failed').length;
  const refused = results.filter(r => r.outcome === 'refused').length;
  return `${done} of ${results.length} written.${failed ? ` ${failed} failed.` : ''}${refused ? ` ${refused} not written.` : ''}`;
}

/**
 * The result of an Apply about `ref` (a row's or a merged group's reference, or a ticket key). A
 * result names its target, or, where an Apply gave one result per plan line, its line names it.
 */
function resultFor(ref, apply) {
  if (!apply) return undefined;
  const { results, lines } = apply;
  const named = results.find(r => r.target === ref || r.target.startsWith(`${ref}: `));
  if (named || lines?.length !== results.length) return named;
  const at = lines.findIndex(l => l.target === ref);
  return at >= 0 ? results[at] : undefined;
}

function resultCell(text, outcome) {
  return h('td', { class: 'result' }, text ? h('span', { class: outcome ? `result-${outcome}` : undefined }, text) : '');
}

function failedText(result) {
  return `${RESULT_TEXT[result.outcome] ?? result.outcome}${result.reason ? `: ${result.reason}` : ''}`;
}

/** A row's Result cell text and outcome: waiting in a running Apply, this Apply's result, written earlier, or `idle`. */
function rowOutcome(waiting, result, written, doneWord, idle = '') {
  if (waiting) return ['Waiting to be written', 'pending'];
  if (result) return result.outcome === 'done' ? [`${doneWord}${result.reason ? `. ${result.reason}` : ''}`, 'done'] : [failedText(result), result.outcome];
  return written ? [doneWord, 'done'] : [idle, undefined];
}

function headRow(...labels) {
  return h('thead', {}, h('tr', {}, labels.map(label => h('th', { scope: 'col' }, label))));
}

/** A column title that sorts the rows when clicked: a button inside the header with its own id, so keyboard focus survives the repaint. */
function sortHeader(sort, board, column, text, locked) {
  const active = sort?.column === column;
  return h('th', { scope: 'col', 'aria-sort': active ? (sort.descending ? 'descending' : 'ascending') : 'none' },
    h('button', { class: 'sort', id: `sort-ticketed-${column}`, disabled: locked, onClick: () => board.act({ type: 'ticketed-sort', column }) },
      text, active ? (sort.descending ? ' ▼' : ' ▲') : ''));
}

/** A select with a "Choose…" first option, which `lockPlaceholder` keeps from being picked again. */
function choiceSelect(id, off, current, options, onChange, lockPlaceholder = true) {
  return h('select', { id, disabled: off, onChange },
    h('option', { value: '', selected: current === null, disabled: lockPlaceholder }, 'Choose…'),
    options.map(o => h('option', { value: o.id, selected: o.id === current }, o.label)));
}

function link(text, url) {
  return url ? h('a', { href: url, target: '_blank', rel: 'noreferrer' }, text) : text;
}

// ---- New ------------------------------------------------------------------------------------

function newRowState(row, ref, ctx, addedTo) {
  const into = addedTo[row.id];
  const result = resultFor(ref, ctx.results);
  if (row.created || into) {
    const key = row.created ?? into;
    const note = result?.outcome === 'done' && result.reason ? `. ${result.reason}` : '';
    const url = row.created === key ? row.createdUrl : undefined;
    return h('td', { class: 'result' }, h('span', { class: 'result-done' }, into ? 'Added to ' : 'Created ', link(key, url), note));
  }
  return resultCell(...rowOutcome(ctx.pending.has(ref), result?.outcome === 'done' ? undefined : result, false, ''));
}

// An email whose subject is already a ticket's summary: name the tickets and offer to add the email to the first as a comment.
function repeatNote(row, ctx) {
  const [first] = row.repeatOf;
  return h('div', { class: 'muted' },
    'Likely a repeat of ', row.repeatOf.map((t, n) => [n > 0 ? ', ' : '', link(t.key, t.url)]), '. ',
    h('vscode-button', {
      id: `add-repeat-${row.id}`, secondary: true, disabled: ctx.writeOff,
      onClick: () => ctx.preview({ type: 'new-add', ids: [row.id], key: first.key, mode: 'comment' }),
    }, `Add as comment to ${first.key}…`));
}

/** "1 ticket", "2 tickets": the count a button names, with the noun in its right number. */
const countOf = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// ---- Email cleanup ----------------------------------------------------------------------------

const MODEL_STATUS = {
  'not-needed': '', 'awaiting-consent': 'Waiting for your answer', declined: 'Not checked (you said no)',
  checked: 'Checked', failed: 'Check failed', 'too-long': 'Too long for the check',
};
const cleanupDrafts = { modelId: '' };

/** The model picker of the check: the model in use, or a pick, plus the reason none can be picked. */
function modelPicker(cleanup, off) {
  const model = cleanup.model ?? {};
  const options = model.options ?? [];
  return [
    model.inUse ? h('span', {}, `Model: ${model.inUse.label}. `) : h('span', {}, 'No model is set for the check. '),
    options.length > 0 ? h('select', {
      id: 'cleanup-model', 'aria-label': 'Model for the email check', disabled: off, onChange: e => { cleanupDrafts.modelId = e.target.value; },
    }, h('option', { value: '', selected: !cleanupDrafts.modelId }, model.inUse ? 'Keep this model' : 'Choose a model…'),
    options.map(o => h('option', { value: o.id, selected: o.id === cleanupDrafts.modelId }, o.label))) : null,
    model.problem ? h('p', { class: 'banner' }, model.problem) : null,
  ];
}

/** The cleanup stage before the New tab: the consent question, then what was found, to strip or keep. */
function cleanupStage(cleanup, board, ctx) {
  const { off, writeOff } = ctx;
  const check = () => ctx.preview({ type: 'cleanup-check', ...(cleanupDrafts.modelId ? { modelId: cleanupDrafts.modelId } : {}) });
  const rows = cleanup.rows;
  const table = h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Emails and the boilerplate found' },
    headRow(cleanup.phase === 'preview' ? 'Clean' : '', 'File', 'Subject', 'Found', 'Model check'),
    h('tbody', {}, rows.map(row => h('tr', { id: `cleanup-${row.id}` },
      h('td', {}, cleanup.phase === 'preview' ? h('input', {
        type: 'checkbox', id: `cleanup-include-${row.id}`, checked: !row.excluded, disabled: off, 'aria-label': `Clean ${row.ref}`,
        onChange: () => board.act({ type: 'cleanup-exclude', id: row.id, excluded: !row.excluded }),
      }) : ''),
      h('td', {}, row.ref), h('td', {}, row.subject),
      h('td', {}, row.blocks.length === 0 ? h('span', { class: 'muted' }, 'Nothing') : h('ul', {}, row.blocks.map(b => h('li', {},
        `${b.kind} (${b.lines} line(s), ${b.source === 'model' ? 'found by the model' : 'your pattern'}): `, h('q', {}, b.excerpt), ' ',
        b.savable ? h('vscode-button', { id: `save-${b.id}`, secondary: true, disabled: writeOff, onClick: () => ctx.apply({ type: 'cleanup-save', block: b.id }) }, 'Save as pattern') : null,
        b.saved ? h('span', { class: 'muted' }, 'Saved') : null)))),
      h('td', {}, `${MODEL_STATUS[row.status] ?? row.status}${row.modelId ? ` (${row.modelId})` : ''}`))))));

  if (cleanup.phase === 'consent') {
    return [
      h('h2', {}, 'Boilerplate cleanup'),
      h('p', {}, cleanup.agreed
        ? `You agreed to the model check by dragging the emails into the chat. Preview the check to see what is sent: ${cleanup.toCheck} email(s) none of your patterns matched.`
        : `${cleanup.toCheck} email(s) match none of your boilerplate patterns. A language model can look for headers, footers and signatures in them. Nothing is sent until you preview the check and apply it.`),
      h('div', { class: 'bar' }, modelPicker(cleanup, off)),
      h('div', { class: 'bar' },
        h('vscode-button', { id: 'cleanup-check', disabled: writeOff || cleanup.toCheck === 0, onClick: check }, 'Preview model check…'),
        h('vscode-button', { id: 'cleanup-skip', secondary: true, disabled: off, onClick: () => board.act({ type: 'cleanup-skip' }) }, 'Continue without the model')),
      ctx.summary,
      table,
    ];
  }
  return [
    h('h2', {}, 'Boilerplate cleanup'),
    h('p', {}, 'This is what was found. Strip removes it from the emails that are ticked, keeping a signature\'s name line; Keep imports every email as it is. The files are never changed.'),
    ctx.summary,
    table,
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'cleanup-strip', disabled: off, onClick: () => board.act({ type: 'cleanup-strip' }) }, 'Strip and continue'),
      h('vscode-button', { id: 'cleanup-keep', secondary: true, disabled: off, onClick: () => board.act({ type: 'cleanup-keep' }) }, 'Keep everything and continue')),
    cleanup.toCheck > 0 ? h('div', { class: 'bar' }, modelPicker(cleanup, off),
      h('vscode-button', { id: 'cleanup-check', secondary: true, disabled: writeOff, onClick: check }, `Preview model check of ${cleanup.toCheck} more email(s)…`)) : null,
  ];
}

function newTab(view, board, ctx) {
  const cleanup = view.ext['email-cleanup'];
  if (cleanup && cleanup.phase !== 'done') return cleanupStage(cleanup, board, ctx);
  const rows = view.new?.rows ?? [];
  const ext = view.ext.new ?? { toCreate: 0, perApply: 50, addedTo: {} };
  const addedTo = ext.addedTo ?? {};
  const open = rows.filter(r => !r.created && !addedTo[r.id]);
  const selected = open.filter(r => r.included).map(r => r.id);
  const { off, writeOff, waltz, email } = ctx;

  const table = h('div', { class: 'table-wrap' }, h('table', { 'aria-label': email ? 'Emails' : 'New rows' },
    email ? headRow('Create', 'File', 'Subject', 'Result') : headRow('Create', 'Finding', 'Title', waltz ? 'Rating' : 'Severity', 'Merge', 'Result'),
    h('tbody', {}, rows.map(row => {
      const isOpen = !row.created && !addedTo[row.id];
      return h('tr', { id: `row-${row.id}` },
        h('td', {}, isOpen ? h('input', {
          type: 'checkbox', id: `include-${row.id}`, checked: row.included, disabled: off, 'aria-label': `Create ${row.ref}`,
          onChange: () => board.act({ type: 'new-include', ids: [row.id], included: !row.included }),
        }) : ''),
        h('td', {}, row.ref), h('td', {}, row.summary, row.repeatOf && isOpen ? repeatNote(row, ctx) : null), email ? null : h('td', {}, row.rating),
        email ? null : h('td', {}, row.merge ? [`Merged #${row.merge} `, isOpen ? h('vscode-button', {
          id: `unmerge-${row.id}`, secondary: true, disabled: off, onClick: () => board.act({ type: 'new-unmerge', id: row.id }),
        }, 'Unmerge') : null] : ''),
        // A view without the group reference names a row by its own.
        newRowState(row, row.group ?? row.ref, ctx, addedTo));
    }))));

  const addKey = h('input', { id: 'add-key', type: 'text', size: 12, value: drafts.addKey, disabled: off, onInput: e => { drafts.addKey = e.target.value; } });
  // An email is added to a ticket as a comment only.
  const addMode = email ? h('span', {}, 'as a comment') : h('select', { id: 'add-mode', disabled: off, onChange: e => { drafts.addMode = e.target.value; } },
    h('option', { value: 'comment', selected: drafts.addMode === 'comment' }, 'as a comment'),
    h('option', { value: 'rewrite', selected: drafts.addMode === 'rewrite' }, 'as a rewrite'));
  const reason = h('input', { id: 'accept-reason', type: 'text', size: 24, value: drafts.reason, disabled: off, onInput: e => { drafts.reason = e.target.value; } });
  const acceptAction = type => ({ type, ids: selected, ...(drafts.reason.trim() ? { reason: drafts.reason } : {}) });

  return [
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'select-all', secondary: true, disabled: off || open.length === 0, onClick: () => board.act({ type: 'new-include', ids: 'all', included: true }) }, 'Select all'),
      h('vscode-button', { id: 'select-none', secondary: true, disabled: off || selected.length === 0, onClick: () => board.act({ type: 'new-include', ids: 'all', included: false }) }, 'Select none'),
      h('span', { class: 'muted' }, `${selected.length} selected, ${ext.toCreate} ticket(s) to create.`)),
    ext.toCreate > ext.perApply ? h('p', { class: 'muted' }, `One click creates at most ${ext.perApply} tickets; the button names how many remain for the next one.`) : null,
    ctx.summary,
    rows.length === 0 ? null : table,
    h('div', { class: 'bar' },
      email ? null : h('vscode-button', { id: 'merge-selected', secondary: true, disabled: off || selected.length < 2, onClick: () => board.act({ type: 'new-merge', ids: selected }) }, 'Merge selected'),
      h('vscode-button', { id: 'apply-create', disabled: writeOff || ext.toCreate === 0, onClick: () => ctx.apply({ type: 'new-create' }) },
        ext.toCreate === 0 ? 'Create tickets' : `Create ${countOf(Math.min(ext.toCreate, ext.perApply), 'ticket')}`)),
    h('div', { class: 'bar' },
      h('label', {}, 'Add selected to ticket', addKey), addMode,
      h('vscode-button', { id: 'preview-add', secondary: true, disabled: writeOff || selected.length === 0, onClick: () => ctx.preview({ type: 'new-add', ids: selected, key: drafts.addKey, mode: email ? 'comment' : drafts.addMode }) }, 'Preview add…')),
    waltz ? h('div', { class: 'bar' },
      h('label', {}, 'Reason (optional)', reason),
      h('vscode-button', { id: 'apply-accept-cve', secondary: true, disabled: writeOff || selected.length === 0, onClick: () => ctx.apply(acceptAction('accept-cve')) }, selected.length === 0 ? 'Accept CVEs of selected' : `Accept CVEs of ${selected.length} selected`),
      h('vscode-button', { id: 'apply-accept-component', secondary: true, disabled: writeOff || selected.length === 0, onClick: () => ctx.apply(acceptAction('accept-component')) }, selected.length === 0 ? 'Accept components of selected' : `Accept components of ${selected.length} selected`)) : null,
  ];
}

// ---- Already ticketed ---------------------------------------------------------------------

const FILTERS = [['changed', 'Changed'], ['unchanged', 'Unchanged'], ['all', 'All']];
/** How many other open tickets a row names before it counts the rest. */
const MAX_ALSO_OPEN_SHOWN = 3;

function ticketedTab(view, board, ctx) {
  const ext = view.ext.ticketed ?? { filter: view.ticketed?.show === 'decision' ? 'changed' : 'all', notice: null, noDueDate: [], counts: {}, actionLabels: {} };
  const all = view.ticketed?.rows ?? [];
  const byId = new Map(all.map(r => [r.id, r]));
  const rows = ext.shown ? ext.shown.map(id => byId.get(id)).filter(Boolean) : all;
  const columns = view.ticketed?.columns ?? [];
  const labels = ext.actionLabels ?? {};
  const noDue = new Set(ext.noDueDate ?? []);
  for (const id of [...picked]) if (!all.some(r => r.id === id && !r.written)) picked.delete(id);
  const { off, writeOff, waltz } = ctx;
  const actions = [...new Set(all.flatMap(r => r.allowedActions))];
  const pickedRows = all.filter(r => picked.has(r.id));
  if (!pickedRows.some(r => r.id === drafts.keepRow)) drafts.keepRow = pickedRows[0]?.id ?? '';

  const filterBar = h('div', { class: 'bar', role: 'group', 'aria-label': 'Show' },
    FILTERS.map(([id, text]) => h('vscode-button', {
      id: `filter-${id}`, secondary: ext.filter !== id, 'aria-pressed': ext.filter === id ? 'true' : 'false', disabled: off,
      onClick: () => board.act({ type: 'ticketed-filter', filter: id }),
    }, ext.counts?.[id] !== undefined ? `${text} (${ext.counts[id]})` : text)));

  if (!actions.includes(drafts.setShown)) drafts.setShown = actions[0] ?? '';
  const setShown = h('select', { id: 'set-shown', 'aria-label': 'Action for every row shown', disabled: off, onChange: e => { drafts.setShown = e.target.value; } },
    actions.map(a => h('option', { value: a, selected: a === drafts.setShown }, labels[a] ?? a)));

  const table = h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Already ticketed rows' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Pick'),
      sortHeader(ext.sort, board, 'ticket', 'Ticket', off), sortHeader(ext.sort, board, 'finding', 'Finding', off), sortHeader(ext.sort, board, 'change', 'Change', off),
      sortHeader(ext.sort, board, 'assignee', 'Assignee', off),
      columns.map(c => sortHeader(ext.sort, board, `extra:${c.id}`, c.name, off)),
      sortHeader(ext.sort, board, 'action', 'Action', off),
      h('th', { scope: 'col' }, 'Result'))),
    h('tbody', {}, rows.map(row => {
      const result = resultFor(row.ticket, ctx.results);
      const state = rowOutcome(ctx.pending.has(row.ticket) && !row.written, result, row.written, 'Written');
      return h('tr', { id: `row-${row.id}` },
        h('td', {}, row.written ? '' : h('input', {
          type: 'checkbox', id: `pick-${row.id}`, checked: picked.has(row.id), disabled: off, 'aria-label': `Pick ${row.ticket} for a merge`,
          onChange: e => { if (e.target.checked) picked.add(row.id); else picked.delete(row.id); board.repaint(); },
        })),
        h('td', {}, link(row.ticket, row.url), row.status ? h('span', { class: 'muted' }, ` ${row.status}${row.resolved ? ', resolved' : ''}`) : null,
          row.alsoOpen?.length ? h('div', { class: 'muted' }, 'also open: ',
            row.alsoOpen.slice(0, MAX_ALSO_OPEN_SHOWN).flatMap((t, i) => [i > 0 ? ', ' : null, link(t.key, t.url)]),
            row.alsoOpen.length > MAX_ALSO_OPEN_SHOWN ? ` +${row.alsoOpen.length - MAX_ALSO_OPEN_SHOWN}` : null) : null),
        h('td', {}, h('div', {}, row.ref), h('div', { class: 'muted' }, row.summary)),
        h('td', {}, row.change ?? 'Unchanged', noDue.has(row.id) ? h('div', {}, 'No Due Date') : null),
        h('td', {}, row.assignee),
        (row.values ?? []).map(value => h('td', {}, value)),
        h('td', {}, h('select', {
          id: `action-${row.id}`, 'aria-label': `Action for ${row.ref}`, disabled: off || row.written,
          onChange: e => board.act({ type: 'ticketed-action', id: row.id, action: e.target.value }),
        }, row.allowedActions.map(a => h('option', { value: a, selected: a === row.action }, labels[a] ?? a)))),
        resultCell(...state));
    }))));

  const keepRow = h('select', { id: 'merge-keep', 'aria-label': 'Ticket to keep', disabled: off || pickedRows.length === 0, onChange: e => { drafts.keepRow = e.target.value; } },
    pickedRows.map(r => h('option', { value: r.id, selected: r.id === drafts.keepRow }, r.ticket)));
  const keepKey = h('input', { id: 'merge-keep-key', type: 'text', size: 12, value: drafts.keepKey, disabled: off, onInput: e => { drafts.keepKey = e.target.value; } });
  const startMerge = () => {
    const keep = drafts.keepKey.trim() || drafts.keepRow;
    return ctx.preview({ type: 'merge-start', ids: pickedRows.map(r => r.id), keep });
  };

  return [
    filterBar,
    ext.notice ? h('p', { class: 'muted' }, ext.notice) : null,
    h('div', { class: 'bar' }, h('label', {}, 'Set all shown to', setShown),
      h('vscode-button', { id: 'set-shown-apply', secondary: true, disabled: off || rows.length === 0, onClick: () => board.act({ type: 'ticketed-set-shown', action: drafts.setShown }) }, 'Set'),
      h('span', { class: 'muted' }, 'Apply writes every row\'s action, shown or not.')),
    ctx.summary,
    rows.length === 0 ? h('p', {}, 'No row matches this filter.') : table,
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'apply-ticketed', disabled: writeOff || ext.toWrite === 0, onClick: () => ctx.apply({ type: 'ticketed-apply' }) },
        ext.toWrite > 0 ? `Write ${countOf(ext.toWrite, 'ticket')}` : 'Write changes')),
    h('div', { class: 'bar' },
      h('span', {}, `${pickedRows.length} picked.`),
      h('label', {}, 'Keep', keepRow), h('label', {}, 'or ticket key', keepKey),
      h('vscode-button', { id: 'preview-merge', secondary: true, disabled: writeOff || pickedRows.length < 1, onClick: startMerge }, 'Preview merge tickets…'),
      waltz ? h('vscode-button', {
        id: 'apply-accept-ticketed', secondary: true, disabled: writeOff || pickedRows.length === 0,
        onClick: () => ctx.apply({ type: 'accept-component', ids: pickedRows.map(r => r.id) }),
      }, pickedRows.length === 0 ? 'Accept components of picked' : `Accept components of ${pickedRows.length} picked`) : null),
  ];
}

// ---- Stale ----------------------------------------------------------------------------------

function staleTab(view, board, ctx) {
  const rows = view.stale?.rows ?? [];
  const ext = view.ext.stale ?? { groups: [], selectable: [] };
  const selectable = new Set(ext.selectable);
  const { off, writeOff } = ctx;
  const table = h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Stale tickets' },
    headRow('Close', 'Ticket', 'Summary', 'Status', 'Type', 'Result'),
    h('tbody', {}, rows.map(row => {
      const result = resultFor(row.key, ctx.results);
      const state = rowOutcome(ctx.pending.has(row.key) && !row.written, result, row.written, 'Closed', row.note ? `Cannot be closed here: ${row.note}` : '');
      return h('tr', { id: `row-${row.key}` },
        h('td', {}, selectable.has(row.key) ? h('input', {
          type: 'checkbox', id: `stale-${row.key}`, checked: row.selected, disabled: off, 'aria-label': `Close ${row.key}`,
          onChange: () => board.act({ type: 'toggle-stale', keys: [row.key] }),
        }) : ''),
        h('td', {}, link(row.key, row.url)), h('td', {}, row.summary), h('td', {}, row.status), h('td', {}, row.issueType),
        resultCell(...state));
    }))));
  const groups = ext.groups.filter(g => g.selected > 0).map((g, n) => h('div', { class: 'bar' },
    h('strong', {}, `${g.issueType} (${g.selected})`),
    h('label', {}, 'Move to', choiceSelect(`stale-target-${n}`, off, g.target, g.targetOptions,
      e => board.act({ type: 'stale-target', issueType: g.issueType, target: e.target.value || null }), false)),
    g.resolutionOptions.length ? h('label', {}, 'Resolution', choiceSelect(`stale-resolution-${n}`, off, g.resolution, g.resolutionOptions,
      e => board.act({ type: 'stale-resolution', issueType: g.issueType, resolution: e.target.value }))) : null,
    g.missing ? h('span', { class: 'muted' }, `Not ready: ${g.missing}.`) : null));
  const marked = ext.groups.reduce((sum, g) => sum + g.selected, 0);
  return [
    ctx.summary,
    rows.length === 0 ? null : table,
    groups,
    h('div', { class: 'bar' }, h('vscode-button', { id: 'apply-close', disabled: writeOff || marked === 0, onClick: () => ctx.apply({ type: 'close-stale' }) }, marked === 0 ? 'Close tickets' : `Close ${countOf(marked, 'ticket')}`)),
  ];
}

// ---- Accepted -------------------------------------------------------------------------------

function acceptedTab(view, board, ctx) {
  const rows = view.accepted?.rows ?? [];
  const { writeOff } = ctx;
  return [
    ctx.summary,
    rows.length === 0 ? null : h('div', { class: 'table-wrap' }, h('table', { 'aria-label': 'Accepted' },
      headRow('Component', 'Accepted', 'Reason', ''),
      h('tbody', {}, rows.map((row, n) => h('tr', { id: `accepted-${n}` },
        h('td', {}, row.component),
        h('td', {}, row.cve ?? `Whole component, version ${row.version ?? ''}`),
        h('td', {}, row.reason ?? ''),
        h('td', {}, h('vscode-button', {
          id: `unaccept-${n}`, secondary: true, disabled: writeOff,
          onClick: () => ctx.apply(row.cve !== undefined
            ? { type: 'unaccept', component: row.component, cve: row.cve }
            : { type: 'unaccept-component', component: row.component, version: row.version }),
        }, row.cve !== undefined ? 'Unaccept' : 'Unaccept component'))))))),
  ];
}

// ---- Ticket merge ---------------------------------------------------------------------------

function stepLine(step) {
  return `${step.key}: ${step.label} — ${STEP_TEXT[step.status] ?? step.status}${step.error ? `: ${step.error}` : ''}${step.note ? ` (${step.note})` : ''}`;
}

function mergeTab(merge, board, ctx) {
  const off = ctx.locked;
  const can = action => merge.actions.includes(action);
  const question = merge.question;
  const { heading } = MERGE_STATES.get(merge.state) ?? MERGE_RUNNING;
  return [
    h('p', {}, `Merging ${merge.sources.join(', ')} into ${merge.survivor}. ${heading}`),
    ctx.summary,
    h('ol', { 'aria-label': 'Merge steps' }, merge.steps.map(step => h('li', {}, stepLine(step)))),
    merge.state === 'failed' ? h('div', { class: 'bar' },
      can('retry') ? h('vscode-button', { id: 'merge-retry', disabled: off, onClick: () => ctx.apply({ type: 'merge-retry' }) }, 'Retry') : null,
      can('ignore') ? h('vscode-button', { id: 'merge-ignore', secondary: true, disabled: off, onClick: () => ctx.apply({ type: 'merge-ignore' }) }, 'Ignore') : null,
      can('stop') ? h('vscode-button', { id: 'merge-stop', secondary: true, disabled: off, onClick: () => ctx.apply({ type: 'merge-stop' }) }, 'Stop') : null) : null,
    question ? [
      question.resolution ? h('p', { class: 'muted' }, `Resolution set without asking: ${question.resolution}.`) : null,
      question.groups.map((g, n) => h('div', { class: 'bar' },
        h('strong', {}, `${g.issueType}: ${g.tickets.join(', ')}`),
        g.note ? h('span', {}, g.note) : [
          h('label', {}, 'Target status', choiceSelect(`merge-close-target-${n}`, off, g.target, g.targetOptions,
            e => board.act({ type: 'merge-close-target', issueType: g.issueType, option: e.target.value }))),
          g.needsResolution ? h('label', {}, 'Resolution', choiceSelect(`merge-close-resolution-${n}`, off, g.resolution, g.resolutionOptions,
            e => board.act({ type: 'merge-close-resolution', issueType: g.issueType, resolution: e.target.value }))) : null,
        ])),
      question.unanswered.length ? h('p', {}, `Still to answer: ${question.unanswered.join(', ')}.`) : null,
      h('div', { class: 'bar' },
        h('vscode-button', { id: 'apply-merge-close', disabled: off || question.unanswered.length > 0 || !can('close'), onClick: () => ctx.apply({ type: 'merge-close' }) },
          `Close ${countOf(question.groups.reduce((n, g) => n + g.tickets.length, 0), 'ticket')}`),
        can('stop') ? h('vscode-button', { id: 'merge-stop', secondary: true, disabled: off, onClick: () => ctx.apply({ type: 'merge-stop' }) }, 'Stop') : null),
    ] : null,
    merge.report ? [
      merge.report.missing.length ? h('p', {}, `Not done: ${merge.report.missing.map(stepLine).join('; ')}.`) : null,
      merge.report.closedWithout.length ? h('p', {}, `Closed without their resolution: ${merge.report.closedWithout.map(s => s.key).join(', ')}.`) : null,
    ] : null,
    can('acknowledge') ? h('div', { class: 'bar' }, h('vscode-button', {
      id: 'merge-acknowledge', disabled: off, onClick: () => { localTab = undefined; return board.act({ type: 'merge-acknowledge' }); },
    }, 'Acknowledge and close this tab')) : null,
  ];
}

// ---- the board ------------------------------------------------------------------------------

function searchBox(view, board, locked) {
  const search = view.ext['search-export']?.search;
  drafts.search ??= search?.query ?? '';
  const input = h('input', { id: 'search-text', type: 'text', size: 24, value: drafts.search, 'aria-label': 'Search the matched tickets', disabled: locked, onInput: e => { drafts.search = e.target.value; } });
  return h('section', { 'aria-label': 'Search' },
    h('div', { class: 'bar' }, input,
      h('vscode-button', { id: 'search', secondary: true, disabled: locked, onClick: () => board.act({ type: 'search', query: drafts.search }) }, 'Search matched tickets')),
    search ? [
      search.results.length ? h('ul', {}, search.results.map(r => h('li', {}, link(r.key, r.url), ` ${r.summary}`, r.status ? h('span', { class: 'muted' }, ` (${r.status})`) : null))) : null,
      search.message ? h('p', { class: 'muted' }, search.message) : null,
    ] : null);
}

/** The filter text last sent per tab, so Enter and leaving the field do not send it twice. */
const sentFilter = {};

function filterBox(view, board, tab, off) {
  drafts.filter[tab] ??= view.filter;
  // Once the board shows the sent text, the next commit compares with the board again.
  if (sentFilter[tab] === (view.filter ?? '')) delete sentFilter[tab];
  // Sent on Enter and on leaving the field, not on the browser's change event: a repaint redraws the
  // field with the typed text, and a redrawn field fires no change event for text typed before it.
  const commit = () => {
    const text = drafts.filter[tab] ?? '';
    if (text === (sentFilter[tab] ?? view.filter ?? '')) return;
    sentFilter[tab] = text;
    void board.act({ type: 'filter', tab, text });
  };
  return h('div', { class: 'bar' },
    h('label', {}, 'Filter', h('input', {
      id: 'filter-text', type: 'text', size: 20, value: drafts.filter[tab] ?? '', disabled: off,
      onInput: e => { drafts.filter[tab] = e.target.value; },
      onKeydown: e => { if (e.key === 'Enter') commit(); },
      onBlur: commit,
    })));
}

const TAB_BODIES = new Map([['new', newTab], ['ticketed', ticketedTab], ['stale', staleTab]]);

function tabLabel(t) {
  return `${t.label} (${t.count}${t.outOfDate ? ', out of date' : ''})`;
}

function render(view, board, locked, state) {
  const merge = view.ext.merge;
  if (merge && !mergeSeen) localTab = MERGE;
  mergeSeen = Boolean(merge);
  if (!merge && localTab === MERGE) localTab = undefined;
  // A tab picked while an Apply ran is sent once the Apply has ended.
  if (!locked && localTab && localTab !== MERGE) {
    const wanted = localTab;
    localTab = undefined;
    if (wanted !== view.tab) {
      localTab = wanted;
      setTimeout(() => { if (localTab === wanted) { localTab = undefined; void board.act({ type: 'tab', tab: wanted }); } }, 0);
    }
  }
  const shown = localTab ?? view.tab;
  const current = view.tabs.find(t => t.id === shown);
  const reportMissing = state.errorCode === 'report-not-found';
  const writesOff = Boolean(state.writesBlocked);
  const mergeRunning = merge && merge.state !== 'finished';

  // Results of the last Apply, for the tab it was asked from.
  const last = board.lastApply;
  const resultsHere = last && previewTab === shown ? last : undefined;
  const plan = board.applyingPlan;
  const pending = new Set(plan && previewTab === shown && state.applying ? plan.lines.map(l => l.target) : []);
  const summary = resultsHere ? h('p', { id: 'apply-summary', class: 'banner', role: 'note' }, `${last.title}: ${countResults(last.results)}`) : null;

  const frozen = Boolean(current?.outOfDate);
  const off = locked || frozen;
  const ctx = {
    locked, writesOff, results: resultsHere, pending, summary, frozen, off,
    writeOff: off || writesOff,
    waltz: view.tabs.some(t => t.id === 'accepted'),
    email: view.reportKind === 'Email',
    preview: action => { previewTab = shown; return board.preview(action); },
    apply: action => { previewTab = shown; return board.apply(action); },
  };

  const tabs = [...view.tabs.map(t => ({ id: t.id, label: tabLabel(t) })), ...(merge ? [{ id: MERGE, label: `Ticket merge (${(MERGE_STATES.get(merge.state) ?? MERGE_RUNNING).tab})` }] : [])];
  const select = id => {
    if (id === MERGE) { localTab = MERGE; board.repaint(); return; }
    if (locked) { localTab = id; board.repaint(); return; }
    localTab = undefined;
    if (id === view.tab) { board.repaint(); return; }
    void board.act({ type: 'tab', tab: id });
  };

  let body;
  if (shown === MERGE && merge) body = mergeTab(merge, board, ctx);
  else if (locked && localTab && localTab !== view.tab) body = [h('p', { class: 'muted' }, 'This tab shows its rows once the Apply has ended.')];
  else if (current?.unavailable) body = [h('p', {}, current.unavailable)];
  else {
    const content = (TAB_BODIES.get(shown) ?? acceptedTab)(view, board, ctx);
    body = [
      current?.outOfDate ? h('section', { class: 'banner', 'aria-label': 'Out of date' },
        h('p', {}, h('strong', {}, `${current.label} is out of date. `), 'Its rows changed since you made your choices here. Refresh to read it again; Refresh keeps every choice whose rows still exist and names the ones it drops.'),
        h('vscode-button', { id: 'refresh-tab', disabled: locked, onClick: () => board.refresh() }, 'Refresh')) : null,
      mergeRunning ? h('p', { class: 'banner' }, 'A ticket merge is running. Apply on this tab is refused until the merge is finished or stopped; you can still make your choices.') : null,
      current?.warning ? h('p', { class: 'banner' }, current.warning) : null,
      current && current.count === 0 && current.empty ? h('p', {}, current.empty) : null,
      filterBox(view, board, shown, ctx.off),
      content,
    ];
  }

  // What the live region reads out: progress, the last result or refusal, and the out-of-date marks.
  const stale = view.tabs.filter(t => t.outOfDate).map(t => t.label);
  announce([
    state.applying ? `Applying: ${state.applying.done} of ${state.applying.total} done.` : null,
    !state.applying && resultsHere ? `${last.title}: ${countResults(last.results)}` : null,
    !state.applying && board.message && board.message !== last?.message ? board.message : null,
    stale.length ? `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} out of date. Refresh to see ${stale.length === 1 ? 'it' : 'them'} as now.` : null,
  ].filter(Boolean).join(' '));

  return h('div', {},
    h('p', { class: 'muted' }, `${ctx.email ? `Emails: ${view.reportFile}` : `${view.reportKind} report ${view.reportFile}`} in ${view.project}. Template "${view.template}", issue type ${view.issueType}.`),
    reportMissing ? h('section', { class: 'banner error', 'aria-label': 'Report file missing' },
      h('p', {}, 'The report file is missing, so nothing can be written. Your choices are kept. Pick the file at its new place to go on.'),
      h('vscode-button', { id: 'pick-file-again', disabled: locked, onClick: () => board.pickFile() }, 'Pick the file again…')) : null,
    view.finished ? h('section', { class: 'banner', 'aria-label': 'Finished' },
      h('p', {}, view.ext['search-export']?.finishedMessage ?? 'Nothing left to do.'),
      h('vscode-button', { id: 'discard-finished', secondary: true, disabled: locked, onClick: () => board.discard() }, 'Close')) : null,
    view.notices.map(n => h('p', { class: 'banner' }, n)),
    view.acceptedHidden ? h('p', { id: 'accepted-hidden', class: 'muted' }, view.acceptedHidden) : null,
    view.dropped.length ? h('section', { class: 'banner', 'aria-label': 'Dropped choices' },
      h('p', {}, 'Refresh could not keep these choices:'),
      h('ul', {}, view.dropped.map(d => h('li', {}, d))),
      h('vscode-button', { id: 'dismiss-dropped', secondary: true, disabled: locked, onClick: () => board.act({ type: 'dismiss-dropped' }) }, 'Dismiss')) : null,
    // Reload, the security overview export and the matched-ticket search belong to Veracode and Waltz reports.
    ctx.email ? null : h('div', { class: 'bar' },
      h('vscode-button', { id: 'reload-report', secondary: true, disabled: locked || writesOff, onClick: () => { previewTab = shown; return board.apply({ type: 'reload-report' }); } }, 'Reload report'),
      h('vscode-button', { id: 'save-csv', secondary: true, disabled: locked, onClick: () => board.save('csv') }, 'Save overview as CSV…'),
      h('vscode-button', { id: 'save-xlsx', secondary: true, disabled: locked, onClick: () => board.save('xlsx') }, 'Save overview as Excel…')),
    ctx.email ? null : searchBox(view, board, locked),
    tablist({ label: 'Groups', tabs, selected: shown, onSelect: select }),
    tabpanel(shown, body));
}

function loading(state) {
  return h('p', { role: 'status' }, state.status === 'failed'
    ? 'The import could not be read.'
    : 'Reading the report and searching Jira for the tickets it already has…');
}

startBoard({ root: document.getElementById('root'), render, loading });
