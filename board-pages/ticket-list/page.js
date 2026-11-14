import { h, startBoard } from '../shared/board.js';

// The ticket list board: the tickets of a query, a selection, and one change applied to the
// selected tickets after a preview. Selection, change and sort belong to the session; the two
// text boxes of the change are only sent when "Set change" is pressed.

const COLUMNS = [
  ['key', 'Ticket'], ['summary', 'Summary'], ['status', 'Status'], ['issueType', 'Type'], ['assignee', 'Assignee'], ['priority', 'Priority'],
];
const RESULT_TEXT = { done: 'Done', failed: 'Failed', refused: 'Not written' };

// What the developer is typing into the change form; kept across repaints, sent on "Set change".
let draft;

const OPERATIONS = [['set', 'Set to'], ['add', 'Add value'], ['remove', 'Remove value']];

function describe(change) {
  if (!change) return 'No change chosen.';
  if (change.type === 'transition') return `Move to "${change.status}"${change.resolution ? ` with resolution "${change.resolution}"` : ''}.`;
  if (change.operation === 'add') return `Add "${change.value}" to ${change.field}.`;
  if (change.operation === 'remove') return `Remove "${change.value}" from ${change.field}.`;
  return `Set ${change.field} to "${change.value}".`;
}

function input(id, label, value, onInput, size = 18) {
  return h('label', {}, label, h('input', { id, type: 'text', value, size, onInput: e => onInput(e.target.value) }));
}

function changeForm(view, board, busy) {
  draft ??= view.change
    ? { type: view.change.type, status: view.change.status ?? '', resolution: view.change.resolution ?? '', field: view.change.field ?? '', value: view.change.value ?? '', operation: view.change.operation ?? 'set' }
    : { type: 'transition', status: '', resolution: '', field: '', value: '', operation: 'set' };
  const kind = h('select', { id: 'change-type', onChange: () => { draft.type = kind.value; board.repaint(); } },
    h('option', { value: 'transition', selected: draft.type === 'transition' }, 'Move to status'),
    h('option', { value: 'field', selected: draft.type === 'field' }, 'Set field'));
  const fields = draft.type === 'transition'
    ? [input('change-status', 'Status', draft.status, v => { draft.status = v; }), input('change-resolution', 'Resolution (optional)', draft.resolution, v => { draft.resolution = v; })]
    : [
      input('change-field', 'Field', draft.field, v => { draft.field = v; }),
      h('label', {}, 'How', h('select', { id: 'change-operation', onChange: e => { draft.operation = e.target.value; } },
        OPERATIONS.map(([value, text]) => h('option', { value, selected: draft.operation === value }, text)))),
      input('change-value', 'Value', draft.value, v => { draft.value = v; }, 30),
    ];
  const send = () => {
    const change = draft.type === 'transition'
      ? { type: 'transition', status: draft.status, ...(draft.resolution.trim() ? { resolution: draft.resolution } : {}) }
      : { type: 'field', field: draft.field, value: draft.value, ...(draft.operation !== 'set' ? { operation: draft.operation } : {}) };
    draft = undefined;
    return board.act({ type: 'change', change });
  };
  return h('section', { 'aria-label': 'Change' },
    h('h2', {}, 'Change for the selected tickets'),
    h('p', { id: 'change-now', role: 'status' }, describe(view.change), view.proposed ? h('strong', {}, ' Proposed by Copilot; check it before you apply.') : null),
    h('div', { class: 'bar' },
      h('label', {}, 'Change', kind), fields,
      h('vscode-button', { id: 'set-change', secondary: true, disabled: busy, onClick: send }, 'Set change'),
      h('vscode-button', { id: 'clear-change', secondary: true, disabled: busy || !view.change, onClick: () => { draft = undefined; return board.act({ type: 'change', change: null }); } }, 'Remove change'),
      h('vscode-button', { id: 'preview', disabled: busy || !view.change || view.selectedCount === 0, onClick: () => board.preview({ type: 'apply' }) }, `Preview for ${view.selectedCount} ticket(s)…`)));
}

function sortHeader(view, board, column, text, locked) {
  const active = view.sort?.column === column;
  return h('th', { scope: 'col', 'aria-sort': active ? (view.sort.descending ? 'descending' : 'ascending') : 'none' },
    h('button', { class: 'sort', id: `sort-${column}`, disabled: locked, onClick: () => board.act({ type: 'sort', column }) }, text, active ? (view.sort.descending ? ' ▼' : ' ▲') : ''));
}

function outOfDateBanner(view) {
  if (!view.outOfDate) return null;
  const { changed, gone, added } = view.outOfDate;
  const parts = [
    changed.length ? `${changed.length} changed in Jira (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''})` : null,
    gone.length ? `${gone.length} no longer match the query` : null,
    added ? `${added} new ticket(s) match` : null,
  ].filter(Boolean);
  return h('section', { class: 'banner', role: 'alert', 'aria-label': 'Out of date' },
    h('p', {}, h('strong', {}, 'This list is out of date. '), `${parts.join('; ')}. Press Refresh to see the tickets as they are now; until then nothing can be changed here.`));
}

function pager(view, board, busy) {
  if (view.pageCount <= 1) return null;
  const go = page => board.act({ type: 'page', page });
  return h('nav', { class: 'bar', 'aria-label': 'Pages' },
    h('vscode-button', { id: 'page-previous', secondary: true, disabled: busy || view.page === 0, onClick: () => go(view.page - 1) }, 'Previous page'),
    h('span', { role: 'status' }, `Page ${view.page + 1} of ${view.pageCount}`),
    h('vscode-button', { id: 'page-next', secondary: true, disabled: busy || view.page >= view.pageCount - 1, onClick: () => go(view.page + 1) }, 'Next page'));
}

function render(view, board, busy) {
  const locked = busy || Boolean(view.outOfDate);
  const table = h('table', { 'aria-label': 'Tickets' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Select'),
      COLUMNS.map(([column, text]) => sortHeader(view, board, column, text, locked)),
      h('th', { scope: 'col' }, 'Last result'))),
    h('tbody', {}, view.rows.map(row => h('tr', {},
      h('td', {}, h('input', {
        type: 'checkbox', id: `select-${row.key}`, checked: row.selected, disabled: locked, 'aria-label': `Select ${row.key}`,
        onChange: e => board.act({ type: 'select', key: row.key, on: e.target.checked }),
      })),
      h('td', {}, row.url ? h('a', { href: row.url, target: '_blank', rel: 'noreferrer' }, row.key) : row.key),
      h('td', {}, row.summary), h('td', {}, row.status), h('td', {}, row.issueType), h('td', {}, row.assignee), h('td', {}, row.priority),
      h('td', { class: row.result && row.result.outcome !== 'done' ? 'flag-overdue' : undefined },
        row.result ? `${RESULT_TEXT[row.result.outcome]}${row.result.reason ? `: ${row.result.reason}` : ''}` : '')))));

  return h('div', {},
    h('p', { class: 'muted' }, view.jql),
    outOfDateBanner(view),
    view.truncated ? h('p', { class: 'banner' }, `More tickets match than are listed; showing the first ${view.totalRows}. Narrow the query to see the rest.`) : null,
    changeForm(view, board, locked),
    h('h2', {}, `${view.totalRows} ticket(s), ${view.selectedCount} selected`),
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'select-all', secondary: true, disabled: locked || view.totalRows === 0, onClick: () => board.act({ type: 'select-all' }) }, 'Select all'),
      h('vscode-button', { id: 'select-none', secondary: true, disabled: locked || view.selectedCount === 0, onClick: () => board.act({ type: 'select-none' }) }, 'Select none')),
    pager(view, board, busy),
    view.totalRows === 0 ? h('p', {}, 'No tickets match.') : table,
    pager(view, board, busy));
}

startBoard({ root: document.getElementById('root'), render });
