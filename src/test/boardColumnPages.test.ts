import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The security report page and the ticket list page with an Assignee column and one configured extra column:
// the headers in order, the values as text, which headers sort, and what a click sends to the extension.

let page: FakePage;
let stopped = false;

afterEach(() => {
  stopped = true;
  removeFakePage();
});

async function load(kind: string, script: string, view: unknown): Promise<void> {
  stopped = false;
  const state = { id: `${kind}-0123456789abcdef`, kind, title: 'Board', status: 'ready', tick: 1, revision: 1, asOf: 1_000, restored: false, stored: true, conflicts: [], writesBlocked: false, view };
  page = installFakePage({ kind, session: state.id, title: 'Board' }, async (op, body) => {
    if (stopped) return new Promise(() => undefined);
    // Like the extension, answer a state request that already holds this tick only when something changes: never.
    if (op === 'state' && typeof body.tick === 'number' && body.tick === state.tick) return new Promise(() => undefined);
    if (op === 'state' || op === 'action') return state;
    throw { status: 404, message: 'Unknown request.' };
  });
  vi.resetModules();
  await import(script as string);
  await settle();
}

const byId = (id: string) => page.document.getElementById(id);
function must(id: string): FakeElement {
  const el = byId(id);
  if (!el) throw new Error(`No element #${id} on the page`);
  return el;
}
const actionsPosted = () => page.posted.filter(m => m.op === 'action').map(m => m.body.action as Record<string, unknown>);
const headers = () => page.document.body.elements().filter(el => el.tagName === 'th' && el.scope === 'col');
const titleOf = (el: FakeElement) => el.textContent.trim().replace(/ [▲▼]$/, '');
const HOSTILE = '<img src=x onerror=alert(1)>';

describe('the security report page', () => {
  const row = (key: string, assignee: string, value: string) => ({
    source: 'veracode', summary: `Finding ${key}`, rating: 'High', ticketKey: key, ticketUrl: null, status: 'Open',
    assignee, values: [value], dueDate: '2026-12-01', flag: null,
  });
  const view = (sort: unknown = null) => ({
    project: 'PROJ', totalTickets: 2, shownTickets: 2, bySource: { veracode: 2, waltz: 0 }, unreadCount: 0, warnings: [], releases: ['1.0'],
    filters: { release: null, flag: null, tool: null }, sort, columns: [{ id: 'customfield_1', name: 'Squad' }],
    tables: [{ fixVersion: '1.0', releaseDate: '2026-12-15', jiraUrl: null, tickets: 2, overdue: 0, dueBeforeRelease: 0, noDueDate: 0, rows: [row('PROJ-1', 'Dana', HOSTILE), row('PROJ-2', 'Unassigned', '')] }],
  });

  it('shows Assignee between Ticket and Due and the extra column after Flag, with every value as text', async () => {
    await load('security-report', '../../board-pages/security-report/page.js', view());
    expect(headers().filter(h => h.parent?.parent?.getAttribute('aria-label') !== 'Summary by Fix Version' && h.elements().some(el => el.tagName === 'button')).map(titleOf))
      .toEqual(['Source', 'Item', 'Rating', 'Ticket', 'Assignee', 'Due', 'Flag', 'Squad']);
    const cells = page.document.body.elements().filter(el => el.tagName === 'td').map(el => el.textContent);
    expect(cells).toContain('Dana');
    expect(cells).toContain(HOSTILE);
    expect(page.document.body.elements().some(el => el.tagName === 'img')).toBe(false);
  });

  it('sorts from the Assignee and extra column titles and marks the sorted one', async () => {
    await load('security-report', '../../board-pages/security-report/page.js', view({ column: 'extra:customfield_1', descending: true }));
    expect(must('sort-0-extra:customfield_1').parent?.getAttribute('aria-sort')).toBe('descending');
    expect(must('sort-0-assignee').parent?.getAttribute('aria-sort')).toBe('none');
    must('sort-0-assignee').dispatch('click');
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'sort', column: 'assignee' });
  });
});

describe('the ticket list page', () => {
  const row = (key: string, extra: string) => ({
    key, url: null, summary: `Ticket ${key}`, status: 'Open', issueType: 'Bug', assignee: 'Ada', priority: 'High', selected: false, extra: { customfield_1: extra },
  });
  const view = (sort: unknown = null) => ({
    title: 'Tickets', jql: 'project = PROJ', jiraUrl: null, queryUnread: false, truncated: false, rows: [row('PROJ-1', HOSTILE), row('PROJ-2', '')], cleanup: null, pageOnly: false,
    columns: [{ id: 'customfield_1', name: 'Squad' }], totalRows: 2, page: 0, pageCount: 1, selectedCount: 0, outOfDate: null, change: null, proposed: false, sort,
    statuses: [], resolutions: [], fieldOperations: ['set', 'add', 'remove'],
  });

  it('shows the extra column as text, and "Not set" for a ticket that has no value', async () => {
    await load('ticket-list', '../../board-pages/ticket-list/page.js', view());
    expect(headers().map(titleOf)).toEqual(['Select', 'Ticket', 'Summary', 'Status', 'Type', 'Assignee', 'Priority', 'Squad', 'Last result']);
    const cells = page.document.body.elements().filter(el => el.tagName === 'td').map(el => el.textContent);
    expect(cells).toContain(HOSTILE);
    expect(cells).toContain('Not set');
    expect(page.document.body.elements().some(el => el.tagName === 'img')).toBe(false);
  });

  it('sorts from the extra column title and marks the sorted one', async () => {
    await load('ticket-list', '../../board-pages/ticket-list/page.js', view({ column: 'extra:customfield_1', descending: false }));
    expect(must('sort-extra:customfield_1').parent?.getAttribute('aria-sort')).toBe('ascending');
    must('sort-extra:customfield_1').dispatch('click');
    await settle();
    expect(actionsPosted().at(-1)).toEqual({ type: 'sort', column: 'extra:customfield_1' });
  });
});
