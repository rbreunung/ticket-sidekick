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

function describe(change) {
  if (!change) return 'No change chosen.';
  return change.type === 'transition'
    ? `Move to "${change.status}"${change.resolution ? ` with resolution "${change.resolution}"` : ''}.`
    : `Set ${change.field} to "${change.value}".`;
}

function input(id, label, value, onInput, size = 18) {
  return h('label', {}, label, h('input', { id, type: 'text', value, size, onInput: e => onInput(e.target.value) }));
}

function changeForm(view, board, busy) {
  draft ??= view.change
    ? { type: view.change.type, status: view.change.status ?? '', resolution: view.change.resolution ?? '', field: view.change.field ?? '', value: view.change.value ?? '' }
    : { type: 'transition', status: '', resolution: '', field: '', value: '' };
  const kind = h('select', { id: 'change-type', onChange: () => { draft.type = kind.value; board.repaint(); } },
    h('option', { value: 'transition', selected: draft.type === 'transition' }, 'Move to status'),
    h('option', { value: 'field', selected: draft.type === 'field' }, 'Set field'));
  const fields = draft.type === 'transition'
    ? [input('change-status', 'Status', draft.status, v => { draft.status = v; }), input('change-resolution', 'Resolution (optional)', draft.resolution, v => { draft.resolution = v; })]
    : [input('change-field', 'Field', draft.field, v => { draft.field = v; }), input('change-value', 'Value', draft.value, v => { draft.value = v; }, 30)];
  const send = () => {
    const change = draft.type === 'transition'
      ? { type: 'transition', status: draft.status, ...(draft.resolution.trim() ? { resolution: draft.resolution } : {}) }
      : { type: 'field', field: draft.field, value: draft.value };
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

function sortHeader(view, board, column, text) {
  const active = view.sort?.column === column;
  return h('th', { scope: 'col', 'aria-sort': active ? (view.sort.descending ? 'descending' : 'ascending') : 'none' },
    h('button', { class: 'sort', id: `sort-${column}`, onClick: () => board.act({ type: 'sort', column }) }, text, active ? (view.sort.descending ? ' ▼' : ' ▲') : ''));
}

function render(view, board, busy) {
  const table = h('table', { 'aria-label': 'Tickets' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Select'),
      COLUMNS.map(([column, text]) => sortHeader(view, board, column, text)),
      h('th', { scope: 'col' }, 'Last result'))),
    h('tbody', {}, view.rows.map(row => h('tr', {},
      h('td', {}, h('input', {
        type: 'checkbox', id: `select-${row.key}`, checked: row.selected, disabled: busy, 'aria-label': `Select ${row.key}`,
        onChange: e => board.act({ type: 'select', key: row.key, on: e.target.checked }),
      })),
      h('td', {}, row.url ? h('a', { href: row.url, target: '_blank', rel: 'noreferrer' }, row.key) : row.key),
      h('td', {}, row.summary), h('td', {}, row.status), h('td', {}, row.issueType), h('td', {}, row.assignee), h('td', {}, row.priority),
      h('td', { class: row.result && row.result.outcome !== 'done' ? 'flag-overdue' : undefined },
        row.result ? `${RESULT_TEXT[row.result.outcome]}${row.result.reason ? `: ${row.result.reason}` : ''}` : '')))));

  return h('div', {},
    h('p', { class: 'muted' }, view.jql),
    view.truncated ? h('p', { class: 'banner' }, `More tickets match than are listed; showing the first ${view.rows.length}. Narrow the query to see the rest.`) : null,
    changeForm(view, board, busy),
    h('h2', {}, `${view.rows.length} ticket(s), ${view.selectedCount} selected`),
    h('div', { class: 'bar' },
      h('vscode-button', { id: 'select-all', secondary: true, disabled: busy || view.rows.length === 0, onClick: () => board.act({ type: 'select-all' }) }, 'Select all'),
      h('vscode-button', { id: 'select-none', secondary: true, disabled: busy || view.selectedCount === 0, onClick: () => board.act({ type: 'select-none' }) }, 'Select none')),
    view.rows.length === 0 ? h('p', {}, 'No tickets match.') : table);
}

startBoard({ root: document.getElementById('root'), render });
