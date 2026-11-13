import { h, startBoard } from '../shared/board.js';

// The security report: a project's unresolved Veracode and Waltz tickets by Fix Version. Filters
// and sort are part of the session, so they are sent to the extension and come back in the view.

const COLUMNS = [
  ['source', 'Source'], ['summary', 'Item'], ['rating', 'Rating'], ['ticket', 'Ticket'], ['due', 'Due'], ['flag', 'Flag'],
];
const FLAG_TEXT = { overdue: 'Overdue', 'due-before-release': 'Due before release' };
const SOURCE_TEXT = { veracode: 'Veracode', waltz: 'Waltz' };
// The option value that stands for "no filter"; '' is taken by "not assigned to a release".
const ALL = '*all*';

function select(id, label, value, options, onChange) {
  const el = h('select', { id, onChange: () => onChange(el.value === ALL ? null : el.value) },
    h('option', { value: ALL, selected: value === null }, 'All'),
    options.map(([v, text]) => h('option', { value: v, selected: value === v }, text)));
  return h('label', {}, label, el);
}

function sortHeader(view, board, tableIndex, column, text) {
  const active = view.sort?.column === column;
  const order = active ? (view.sort.descending ? 'descending' : 'ascending') : 'none';
  return h('th', { scope: 'col', 'aria-sort': order },
    h('button', { class: 'sort', id: `sort-${tableIndex}-${column}`, onClick: () => board.act({ type: 'sort', column }) },
      text, active ? (view.sort.descending ? ' ▼' : ' ▲') : ''));
}

function releaseName(fixVersion) {
  return fixVersion === null || fixVersion === '' ? 'Not assigned to a release' : fixVersion;
}

function render(view, board, busy) {
  const filtered = view.filters.release !== null || view.filters.flag !== null || view.filters.tool !== null;
  const bar = h('div', { class: 'bar', role: 'group', 'aria-label': 'Filters and export' },
    select('filter-release', 'Release', view.filters.release, view.releases.map(r => [r, releaseName(r)]), release => board.act({ type: 'filter', release })),
    select('filter-flag', 'Flag', view.filters.flag, [['overdue', 'Overdue'], ['due-before-release', 'Due before release'], ['none', 'No flag']], flag => board.act({ type: 'filter', flag })),
    select('filter-tool', 'Tool', view.filters.tool, [['veracode', 'Veracode'], ['waltz', 'Waltz']], tool => board.act({ type: 'filter', tool })),
    h('vscode-button', { id: 'clear', secondary: true, disabled: busy || (!filtered && !view.sort), onClick: () => board.act({ type: 'clear' }) }, 'Clear filters'),
    h('vscode-button', { id: 'save-csv', disabled: busy || view.totalTickets === 0, onClick: () => board.save('csv') }, 'Save full report as CSV'),
    h('vscode-button', { id: 'save-xlsx', disabled: busy || view.totalTickets === 0, onClick: () => board.save('xlsx') }, 'Save full report as Excel'));

  const summary = h('table', { 'aria-label': 'Summary by Fix Version' },
    h('thead', {}, h('tr', {}, ['Fix Version', 'Release date', 'Tickets', 'Overdue', 'Due before release', 'No Due Date'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : undefined }, t)))),
    h('tbody', {}, view.tables.map(t => h('tr', {},
      h('th', { scope: 'row' }, t.jiraUrl ? h('a', { href: t.jiraUrl, target: '_blank', rel: 'noreferrer' }, releaseName(t.fixVersion)) : releaseName(t.fixVersion)),
      h('td', {}, t.releaseDate ?? ''),
      h('td', { class: 'num' }, t.tickets), h('td', { class: 'num' }, t.overdue), h('td', { class: 'num' }, t.dueBeforeRelease), h('td', { class: 'num' }, t.noDueDate)))));

  const tables = view.tables.map((t, tableIndex) => h('section', {},
    h('h2', {}, releaseName(t.fixVersion), t.releaseDate ? h('span', { class: 'muted' }, ` · release ${t.releaseDate}`) : null),
    t.rows.length === 0 ? h('p', { class: 'muted' }, 'No rows match the filters.') : h('table', {},
      h('thead', {}, h('tr', {}, COLUMNS.map(([column, text]) => sortHeader(view, board, tableIndex, column, text)))),
      h('tbody', {}, t.rows.map(row => h('tr', {},
        h('td', {}, SOURCE_TEXT[row.source] ?? row.source),
        h('td', {}, row.summary),
        h('td', {}, row.rating),
        h('td', {}, row.ticketKey
          ? (row.ticketUrl ? h('a', { href: row.ticketUrl, target: '_blank', rel: 'noreferrer' }, row.ticketKey) : row.ticketKey)
          : 'No ticket', row.status ? h('span', { class: 'muted' }, ` ${row.status}`) : null),
        h('td', {}, row.dueDate ?? ''),
        h('td', { class: row.flag ? `flag-${row.flag}` : undefined }, FLAG_TEXT[row.flag] ?? '')))))));

  return h('div', {},
    h('p', {}, `${view.totalTickets} open ticket(s): ${view.bySource.veracode} Veracode, ${view.bySource.waltz} Waltz.`),
    view.warnings.map(w => h('p', { class: 'banner' }, w)),
    bar,
    filtered ? h('p', { class: 'muted', role: 'status' }, `Showing ${view.shownTickets} of ${view.totalTickets} tickets. Save writes all ${view.totalTickets} tickets, not only the ${view.shownTickets} shown.`) : null,
    view.totalTickets === 0 ? h('p', {}, `No open Veracode or Waltz tickets in ${view.project}.`) : [summary, tables]);
}

startBoard({ root: document.getElementById('root'), render });
