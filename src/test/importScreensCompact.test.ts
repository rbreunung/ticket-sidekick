import { describe, it, expect } from 'vitest';
import {
  buildImportOverview, buildNewGroupScreen, buildTicketedGroupScreen, buildStaleGroupScreen, buildAddPrompt, buildMergePrompt, buildCloseMergePrompt,
  buildReviewPage, type ReviewSession, type ReviewRowBase, type ReviewTableColumn, type ImportScreenOptions,
} from '../participant/sessionState';

// The compact import screens: one Commands line and a help link in place of the
// hint paragraphs, and paging controls only for directions that exist.

interface R extends ReviewRowBase { label: string }
const columns: ReviewTableColumn<R>[] = [{ header: 'Name', accessor: r => r.label }];
const fresh = (id: string): R => ({ id, existingTicketKey: null, included: true, label: `row ${id}` });
const ticketedRow = (id: string, key: string): R => ({ id, existingTicketKey: key, included: false, label: `row ${id}` });

function session(over: Partial<ReviewSession<R>> = {}, freshCount = 3, ticketedCount = 0): ReviewSession<R> {
  const allRows = [
    ...Array.from({ length: ticketedCount }, (_, i) => ticketedRow(`A${i + 1}`, `PROJ-${i + 1}`)),
    ...Array.from({ length: freshCount }, (_, i) => fresh(String(i + 1))),
  ];
  const page = over.page ?? 0;
  return {
    projectKey: 'PROJ', issueType: 'Task', templateName: null, additionalFields: {},
    allRows, rows: buildReviewPage(allRows, page).rows, page, schemaVersion: 12, singleGroup: false, groups: ['new', 'ticketed'], view: 'new',
    ...over,
  };
}

const waltz: ImportScreenOptions = { itemNoun: 'component(s)', canFold: true, canAccept: true, canMergeTickets: true, canExport: true, canSearch: true };
const veracode: ImportScreenOptions = { ...waltz, canAccept: false };
const email: ImportScreenOptions = { itemNoun: 'email(s)' };

const REMOVED_SENTENCES = ['to navigate', 'to combine rows on this page', 'to hide those rows', 'to stop offering those components', 'a list of row numbers to toggle'];

describe('New screen', () => {
  it('shows one Commands line and none of the old hint paragraphs', () => {
    const text = buildNewGroupScreen(session(), columns, waltz);
    expect(text.match(/Commands:/g)).toHaveLength(1);
    for (const gone of REMOVED_SENTENCES) expect(text, gone).not.toContain(gone);
    expect(text).toContain('Include all');
    expect(text).toContain('Create 3 tickets');
  });

  it('lists the accept words for Waltz only, and search for any importer with ticket search', () => {
    expect(buildNewGroupScreen(session(), columns, waltz)).toContain('hide `accept CVE` `accept component`');
    const vera = buildNewGroupScreen(session(), columns, veracode);
    expect(vera).not.toContain('accept');
    expect(vera).toContain('find `search`');
    expect(buildNewGroupScreen(session(), columns, email)).not.toContain('search');
  });

  it('ends with the way out as a bare link', () => {
    expect(buildNewGroupScreen(session(), columns, waltz)).toMatch(/\[Back to overview\]\([^)]*\)$/);
    const single = buildNewGroupScreen(session({ singleGroup: true, groups: ['new'] }), columns, waltz);
    expect(single).toMatch(/\[Done\]\([^)]*\)$/);
  });
});

describe('page line', () => {
  const pageLine = (text: string) => text.split('\n').find(l => l.startsWith('_Page')) ?? '';

  it('page 1 of 3 offers next and page <n>, no prev', () => {
    const line = pageLine(buildNewGroupScreen(session({ page: 0 }, 120), columns, waltz));
    expect(line).toContain('_Page 1 of 3._');
    expect(line).toContain('[next]');
    expect(line).toContain('`page <n>`');
    expect(line).not.toContain('[prev]');
  });

  it('page 2 of 3 offers both directions and page <n>', () => {
    const line = pageLine(buildNewGroupScreen(session({ page: 1 }, 120), columns, waltz));
    expect(line).toContain('[prev]');
    expect(line).toContain('[next]');
    expect(line).toContain('`page <n>`');
  });

  it('page 3 of 3 offers prev and page <n>, no next', () => {
    const line = pageLine(buildNewGroupScreen(session({ page: 2 }, 120), columns, waltz));
    expect(line).toContain('[prev]');
    expect(line).toContain('`page <n>`');
    expect(line).not.toContain('[next]');
  });

  it('two pages offer only the one valid direction and no page <n>', () => {
    const first = pageLine(buildNewGroupScreen(session({ page: 0 }, 60), columns, waltz));
    expect(first).toContain('[next]');
    expect(first).not.toContain('[prev]');
    expect(first).not.toContain('page <n>');
    const last = pageLine(buildNewGroupScreen(session({ page: 1 }, 60), columns, waltz));
    expect(last).toContain('[prev]');
    expect(last).not.toContain('[next]');
    expect(last).not.toContain('page <n>');
  });

  it('a single page shows no paging text at all', () => {
    expect(buildNewGroupScreen(session(), columns, waltz)).not.toContain('_Page');
  });

  it('the Already ticketed screen follows the same rules', () => {
    const many = session({ view: 'ticketed' }, 0, 45);
    expect(pageLine(buildTicketedGroupScreen({ ...many, ticketedPage: 0 }, columns, waltz))).not.toContain('[prev]');
    const last = pageLine(buildTicketedGroupScreen({ ...many, ticketedPage: 2 }, columns, waltz));
    expect(last).toContain('[prev]');
    expect(last).not.toContain('[next]');
    expect(buildTicketedGroupScreen(session({ view: 'ticketed' }, 0, 3), columns, waltz)).not.toContain('_Page');
  });

  it('the Stale screen follows the same rules', () => {
    const tickets = Array.from({ length: 25 }, (_, i) => ({ key: `PROJ-${i + 1}`, summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false }));
    const stale = { groups: [{ issueType: 'Bug', rules: [], graph: {} as never, tickets }], ineligible: [], resolutionOptions: [] };
    const page2 = pageLine(buildStaleGroupScreen(session({ view: 'stale', groups: ['stale'], staleTickets: stale, stalePage: 1 }, 0), waltz));
    expect(page2).toContain('[prev]');
    expect(page2).not.toContain('[next]');
  });
});

describe('Already ticketed screen', () => {
  it('keeps the Apply link, the batch notice and the one-kind shortcuts, and drops the how-to sentences', () => {
    const text = buildTicketedGroupScreen(session({ view: 'ticketed' }, 0, 3), columns, waltz);
    expect(text.match(/Commands:/g)).toHaveLength(1);
    expect(text).toContain('tickets `merge A5 into A3` `search`');
    expect(text).toContain('hide `accept component`');
    for (const gone of ['Change a row with', 'combine tickets into one', 'to stop offering those components']) expect(text, gone).not.toContain(gone);
  });
});

describe('Stale screen', () => {
  const stale = (included: boolean) => ({
    groups: [{ issueType: 'Bug', rules: [], graph: {} as never, tickets: [{ key: 'PROJ-9', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included }] }],
    ineligible: [], resolutionOptions: [],
  });

  it('says plainly that nothing is marked, then shows the Commands line', () => {
    const text = buildStaleGroupScreen(session({ view: 'stale', groups: ['stale'], staleTickets: stale(false) }, 0), waltz);
    expect(text).toContain('Nothing marked to close');
    expect(text).not.toContain('Close 0 tickets');
    expect(text).toContain('Commands: toggle `PROJ-123`');
  });

  it('keeps the Close link when a ticket is marked', () => {
    expect(buildStaleGroupScreen(session({ view: 'stale', groups: ['stale'], staleTickets: stale(true) }, 0), waltz)).toContain('Close 1 tickets');
  });
});

describe('overview', () => {
  it('ends with the help link and has no Commands line', () => {
    const text = buildImportOverview(session(), waltz);
    expect(text).not.toContain('Commands:');
    expect(text).toMatch(/\[help\]\([^)]*\)$/);
  });
});

describe('add and merge prompts', () => {
  it('end with a help link and keep their confirmation links', () => {
    const add = buildAddPrompt({ key: 'PROJ-1', summary: 's', status: 'Open', resolved: false, ids: ['1'], rowCount: 1, droppedKeys: [] });
    expect(add).toMatch(/\[help\]\([^)]*\)$/);
    expect(add).toContain('[Comment]');
    expect(add).toContain('[Rewrite]');
    const merge = buildMergePrompt({ survivor: { key: 'PROJ-1', summary: 's', status: 'Open' }, sources: [{ key: 'PROJ-2', summary: 't', status: 'Open' }], warnings: [], droppedKeys: [] });
    expect(merge).toMatch(/\[help\]\([^)]*\)$/);
    expect(merge).toContain('[Merge]');
    const close = buildCloseMergePrompt({
      survivor: { key: 'PROJ-1', summary: 's', status: 'Open' }, sources: [{ ticket: { key: 'PROJ-2', summary: 't', status: 'Open' }, movable: [], unlisted: [], elsewhere: [] }],
      itemNoun: 'flaw', survivorLost: [], survivorElsewhere: [], newItems: [], warnings: [],
    });
    expect(close).toMatch(/\[help\]\([^)]*\)$/);
  });
});
