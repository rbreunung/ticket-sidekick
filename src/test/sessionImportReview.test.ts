import { describe, it, expect } from 'vitest';
import { buildChatCommandLink } from '../participant/sessionState';
import { buildReviewPage, parseReviewPageNav, applyReviewSessionToggle } from '../participant/sessionState';
import { parseBulkNewRowReply, applyBulkNewRowSet, applyTicketedActionChange, formatRowChange, CURRENT_SESSION_SCHEMA_VERSION, isSessionExpired, describeImportReplyVocabulary, type TicketedAction, buildImportOverview, buildNewGroupScreen, buildTicketedGroupScreen, initImportViewState, ensureImportViewState, computeImportResultGroups, emptyImportOutcomes, buildImportDoneSummary, parseOverviewReply, parseNewGroupReply, parseTicketedGroupReply, parseStaleGroupReply, IMPORT_COMMANDS, isConfirmation, isCancellation, buildChatCommandLink, type ReviewSession, type ImportReplyContext } from '../participant/sessionState';
import { type ReviewSessionStale } from '../participant/sessionState';

// U4: minimal ReviewRowBase-shaped row for the pageable-review-session tests below.
interface PageRow extends ReviewRowBase {
  id: string;
  existingTicketKey: string | null;
  included: boolean;
}

function makeFreshRows(count: number, startAt = 1): PageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(startAt + i), existingTicketKey: null, included: true,
  }));
}

function makeTicketedRow(id: string, existingTicketKey: string): PageRow {
  return { id, existingTicketKey, included: false };
}

// A second, non-default column set to prove the bulk links render for any importer's columns (R5).
const WALTZ_TEST_COLUMNS: ReviewTableColumn<PageRow>[] = [
  { header: 'Component', accessor: (r) => `component-${r.id}` },
];

// U4: the pageable review session's core slicing/navigation/toggle-persistence primitives.
describe('buildReviewPage (U4/R6-R8)', () => {
  it('returns everything on one page when the "new" set is at or under BATCH_LIMIT (50)', () => {
    const allRows = makeFreshRows(50);
    const result = buildReviewPage(allRows, 0);
    expect(result.rows).toHaveLength(50);
    expect(result.page).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it('splits a "new" set larger than BATCH_LIMIT into multiple pages of up to 50 rows each', () => {
    const allRows = makeFreshRows(120);
    const first = buildReviewPage(allRows, 0);
    expect(first.rows).toHaveLength(50);
    expect(first.rows.map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
    expect(first.totalPages).toBe(3);

    const second = buildReviewPage(allRows, 1);
    expect(second.rows).toHaveLength(50);
    expect(second.rows[0].id).toBe('51');

    const third = buildReviewPage(allRows, 2);
    expect(third.rows).toHaveLength(20); // remainder
    expect(third.rows[0].id).toBe('101');
  });

  it('always shows every "already ticketed" row in full, on every page, never counted toward paging', () => {
    const allRows = [makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(60), makeTicketedRow('A2', 'PROJ-2')];
    const first = buildReviewPage(allRows, 0);
    const second = buildReviewPage(allRows, 1);
    expect(first.rows.filter(r => r.existingTicketKey !== null).map(r => r.id)).toEqual(['A1', 'A2']);
    expect(second.rows.filter(r => r.existingTicketKey !== null).map(r => r.id)).toEqual(['A1', 'A2']);
    expect(first.totalPages).toBe(2); // 60 "new" rows -> 2 pages, unaffected by the 2 ticketed rows
  });

  it('clamps a negative page request up to page 0', () => {
    const result = buildReviewPage(makeFreshRows(120), -5);
    expect(result.page).toBe(0);
  });

  it('clamps an out-of-range page request down to the last valid page', () => {
    const result = buildReviewPage(makeFreshRows(120), 99);
    expect(result.page).toBe(2); // 3 pages total, 0-based last is 2
    expect(result.rows).toHaveLength(20);
  });

  it('reports exactly one page (never zero) when there are no "new" rows at all', () => {
    const result = buildReviewPage([makeTicketedRow('A1', 'PROJ-1')], 0);
    expect(result.totalPages).toBe(1);
    expect(result.rows).toEqual([makeTicketedRow('A1', 'PROJ-1')]);
  });
});

describe('parseReviewPageNav (U4/R6)', () => {
  it('recognizes "next" and "prev"', () => {
    expect(parseReviewPageNav('next')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('prev')).toEqual({ kind: 'prev' });
  });

  it('recognizes case-insensitively and trims surrounding whitespace', () => {
    expect(parseReviewPageNav('  NEXT  ')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('Prev')).toEqual({ kind: 'prev' });
  });

  it('recognizes the "next page"/"prev page"/"previous"/"previous page" variants', () => {
    expect(parseReviewPageNav('next page')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('prev page')).toEqual({ kind: 'prev' });
    expect(parseReviewPageNav('previous')).toEqual({ kind: 'prev' });
    expect(parseReviewPageNav('previous page')).toEqual({ kind: 'prev' });
  });

  it('recognizes "page <n>", converting the 1-based typed number to a 0-based page index', () => {
    expect(parseReviewPageNav('page 3')).toEqual({ kind: 'goto', page: 2 });
    expect(parseReviewPageNav('PAGE 1')).toEqual({ kind: 'goto', page: 0 });
    expect(parseReviewPageNav('page   7')).toEqual({ kind: 'goto', page: 6 }); // collapses extra whitespace
  });

  it('returns null for anything else, including a bare row-id number and ordinary toggle/confirm replies', () => {
    expect(parseReviewPageNav('2')).toBeNull();
    expect(parseReviewPageNav('A1')).toBeNull();
    expect(parseReviewPageNav('post it')).toBeNull();
    expect(parseReviewPageNav('cancel')).toBeNull();
    expect(parseReviewPageNav('pages')).toBeNull();
    expect(parseReviewPageNav('page')).toBeNull();
    expect(parseReviewPageNav('')).toBeNull();
  });
});

describe('applyReviewSessionToggle (U4/R7-R8)', () => {
  it('toggles the given ids on the visible page rows, same as applyReviewToggle', () => {
    const rows = makeFreshRows(3); // ids '1'..'3', all included
    const result = applyReviewSessionToggle(rows, rows, ['2']);
    expect(result.rows.find(r => r.id === '2')!.included).toBe(false);
    expect(result.rows.find(r => r.id === '1')!.included).toBe(true);
  });

  it('never touches an already-ticketed row — those rows take per-row actions, not toggles (U4)', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const allRows = [ticketed, ...makeFreshRows(3)];
    const toggled = applyReviewSessionToggle(allRows, allRows, ['A1']);
    expect(toggled.rows.find(r => r.id === 'A1')).toEqual(ticketed);
    expect(toggled.allRows.find(r => r.id === 'A1')).toEqual(ticketed);
  });

  it('does NOT mirror a "new" row\'s toggle into allRows — a page revisited later resets to default-included (R7)', () => {
    const allRows = makeFreshRows(60);
    const page0 = buildReviewPage(allRows, 0);

    const toggled = applyReviewSessionToggle(page0.rows, allRows, ['3']); // exclude row '3' on page 0
    expect(toggled.rows.find(r => r.id === '3')!.included).toBe(false); // visible immediately
    expect(toggled.allRows.find(r => r.id === '3')!.included).toBe(true); // NOT written back

    // Page away and back to page 0 — the toggle is gone, row '3' is included again (page-local reset).
    const backToPage0 = buildReviewPage(toggled.allRows, 0);
    expect(backToPage0.rows.find(r => r.id === '3')!.included).toBe(true);
  });

  it('leaves rows not mentioned in ids untouched', () => {
    const rows = makeFreshRows(3);
    const result = applyReviewSessionToggle(rows, rows, ['2']);
    expect(result.rows.find(r => r.id === '1')!.included).toBe(true);
    expect(result.rows.find(r => r.id === '3')!.included).toBe(true);
  });
});

describe('parseBulkNewRowReply (review-table toggle-all)', () => {
  it('recognizes "include all" case-insensitively, trimmed', () => {
    expect(parseBulkNewRowReply('include all')).toBe(true);
    expect(parseBulkNewRowReply('INCLUDE ALL')).toBe(true);
    expect(parseBulkNewRowReply('  include all  ')).toBe(true);
  });

  it('recognizes "exclude all" case-insensitively, trimmed', () => {
    expect(parseBulkNewRowReply('exclude all')).toBe(false);
    expect(parseBulkNewRowReply('EXCLUDE ALL')).toBe(false);
    expect(parseBulkNewRowReply('  Exclude All  ')).toBe(false);
  });

  it('returns null for every existing reply vocabulary (no false positives)', () => {
    expect(parseBulkNewRowReply('2 4')).toBeNull(); // row-id toggle list
    expect(parseBulkNewRowReply('A1')).toBeNull(); // already-ticketed row id
    expect(parseBulkNewRowReply('next')).toBeNull(); // page-nav
    expect(parseBulkNewRowReply('prev')).toBeNull();
    expect(parseBulkNewRowReply('page 2')).toBeNull();
    expect(parseBulkNewRowReply('post it')).toBeNull(); // confirmation
    expect(parseBulkNewRowReply('cancel')).toBeNull(); // cancellation
    expect(parseBulkNewRowReply('PROJ-123')).toBeNull(); // stale-ticket key
    expect(parseBulkNewRowReply('update existing tickets')).toBeNull();
  });

  it('returns null for partial or extended phrases', () => {
    expect(parseBulkNewRowReply('include')).toBeNull();
    expect(parseBulkNewRowReply('all')).toBeNull();
    expect(parseBulkNewRowReply('exclude')).toBeNull();
    expect(parseBulkNewRowReply('include all rows')).toBeNull();
    expect(parseBulkNewRowReply('please exclude all now')).toBeNull();
    expect(parseBulkNewRowReply('')).toBeNull();
  });
});

describe('applyBulkNewRowSet (review-table toggle-all)', () => {
  it('sets included: true on every New row and leaves already-ticketed rows unchanged', () => {
    const ticketed = { ...makeTicketedRow('A1', 'PROJ-1'), included: true }; // re-create, must stay
    const rows = [ticketed, ...makeFreshRows(3).map(r => ({ ...r, included: false }))];
    const result = applyBulkNewRowSet(rows, true);

    expect(result.filter(r => r.existingTicketKey === null).every(r => r.included)).toBe(true);
    expect(result.find(r => r.id === 'A1')!.included).toBe(true); // untouched
  });

  it('sets included: false on every New row and leaves already-ticketed rows unchanged (AE2)', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1'); // excluded, must stay excluded
    const rows = [ticketed, ...makeFreshRows(3)]; // all included by default
    const result = applyBulkNewRowSet(rows, false);

    expect(result.filter(r => r.existingTicketKey === null).every(r => !r.included)).toBe(true);
    expect(result.find(r => r.id === 'A1')!.included).toBe(false); // untouched
  });

  it('does not mutate the input array', () => {
    const rows = makeFreshRows(2);
    applyBulkNewRowSet(rows, false);
    expect(rows.every(r => r.included)).toBe(true);
  });

  it('is a no-op on a page with zero New rows (only already-ticketed rows, all untouched)', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const result = applyBulkNewRowSet([ticketed], true);
    expect(result).toEqual([ticketed]);
  });
});

function screenSession(allRows: PageRow[], extra: Partial<ReviewSession<PageRow>> = {}): ReviewSession<PageRow> {
  const page = buildReviewPage(allRows, 0);
  return initImportViewState({
    projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
    allRows, rows: page.rows, page: page.page, schemaVersion: 6, ...extra,
  });
}

const itemOpts = { itemNoun: 'item(s)' };

describe('New screen — "Include all" / "Exclude all" links (review-table toggle-all)', () => {
  it('renders both bulk links when New rows exist, each resubmitting its exact token', () => {
    const text = buildNewGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(2)]), [], itemOpts);

    expect(text).toContain('Include all');
    expect(text).toContain('Exclude all');
    // The link's command payload carries the exact reply token the handler parses.
    expect(decodeURIComponent(text)).toContain('"@jira include all"');
    expect(decodeURIComponent(text)).toContain('"@jira exclude all"');
  });

  it('offers merge and unmerge on the New screen only for an importer that can fold (finding folding)', () => {
    const rows = makeFreshRows(3);
    expect(buildNewGroupScreen(screenSession(rows), [], { ...itemOpts, canFold: true })).toContain('`merge 2 4`');
    expect(buildNewGroupScreen(screenSession(rows), [], itemOpts)).not.toContain('merge');
  });

  it('renders neither bulk link, and says so, when every new row has been created', () => {
    const text = buildNewGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1')]), [], itemOpts);

    expect(text).not.toContain('Include all');
    expect(text).toContain('_No new items left to create._');
  });

  it('renders the bulk links for the Waltz column set too (shared renderer — R5)', () => {
    const text = buildNewGroupScreen(screenSession(makeFreshRows(2)), WALTZ_TEST_COLUMNS, { ...itemOpts, itemNoun: 'component(s)' });

    expect(text).toContain('Include all');
    expect(text).toContain('Exclude all');
  });

  it('counts only the rows still included on the visible page in "Create N tickets"', () => {
    const session = screenSession(makeFreshRows(3));
    session.rows = session.rows.map(r => (r.id === '2' ? { ...r, included: false } : r));
    const text = buildNewGroupScreen(session, [], itemOpts);
    expect(text).toContain('**2** ticket(s) will be created.');
    expect(decodeURIComponent(text)).toContain('[Create 2 tickets]');
  });
});

// U4 (import-ticket-updates-parity plan): the shared per-row Already-ticketed screen.
function cmd(label: string, command: string): string {
  return buildChatCommandLink(label, '@jira', command);
}

function makeActionRow(
  id: string,
  key: string,
  extra: Partial<PageRow> = {},
): PageRow {
  return {
    id, existingTicketKey: key, included: false,
    target: { key, status: 'In Progress', resolved: false },
    ticketKeys: [key],
    change: null,
    allowedActions: ['re-create', 'leave'],
    action: 'leave',
    ...extra,
  };
}

const changedRow = (id: string, key: string, extra: Partial<PageRow> = {}) => makeActionRow(id, key, {
  change: { kind: 'findings', newIds: ['CVE-1', 'CVE-2'], ratingRise: { from: 'High', to: 'Critical' } },
  allowedActions: ['update', 'follow-up', 're-create', 'leave'],
  action: 'update',
  ...extra,
});

const waltzOpts = { itemNoun: 'component(s)', findingNoun: 'CVE(s)' };

function rowLine(text: string, id: string): string {
  return text.split('\n').find(l => l.startsWith(`| ${id} |`))!;
}

describe('Already-ticketed screen — per-row actions (U4/R5, R6, KTD9)', () => {
  it('an update row with a change lists every allowed action as a link, the current one in bold', () => {
    const text = buildTicketedGroupScreen(screenSession([changedRow('A1', 'PROJ-12')]), [], waltzOpts);
    const line = rowLine(text, 'A1');
    expect(line).toContain(
      `**${cmd('update', 'A1 update')}** · ${cmd('follow-up', 'A1 follow-up')} · ${cmd('re-create', 'A1 re-create')} · ${cmd('leave', 'A1 leave')}`,
    );
  });

  it('a no-change row lists **leave** · re-create', () => {
    const text = buildTicketedGroupScreen(screenSession([makeActionRow('A3', 'PROJ-3')]), [], waltzOpts);
    expect(rowLine(text, 'A3')).toContain(`**${cmd('leave', 'A3 leave')}** · ${cmd('re-create', 'A3 re-create')}`);
  });

  it('a row built without change tracking still gets the per-row actions (leave / re-create)', () => {
    const text = buildTicketedGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1')]), [], itemOpts);
    expect(rowLine(text, 'A1')).toContain(`**${cmd('leave', 'A1 leave')}** · ${cmd('re-create', 'A1 re-create')}`);
  });

  it('shows Ticket, Status and a one-line Change column', () => {
    const text = buildTicketedGroupScreen(screenSession([
      changedRow('A1', 'PROJ-12'),
      makeActionRow('A2', 'PROJ-5', { change: { kind: 'baseline' }, target: { key: 'PROJ-5', status: 'Done', resolved: true } }),
      makeActionRow('A3', 'PROJ-3'),
    ]), [], waltzOpts);
    expect(text).toContain('| # | Ticket | Status | Change | Action |');
    expect(rowLine(text, 'A1')).toContain('| PROJ-12 | In Progress | +2 CVEs, High→Critical |');
    expect(rowLine(text, 'A2')).toContain('| PROJ-5 | Done | baseline |');
    expect(rowLine(text, 'A3')).toContain('| PROJ-3 | In Progress | — |');
  });

  it('a finished row shows its result instead of links; a failed row shows the error and keeps its links', () => {
    const text = buildTicketedGroupScreen(screenSession([
      changedRow('A1', 'PROJ-12', { result: { status: 'done', action: 'update' } }),
      changedRow('A2', 'PROJ-8', { action: 'follow-up', result: { status: 'done', action: 'follow-up', key: 'PROJ-31' } }),
      changedRow('A3', 'PROJ-9', { action: 'follow-up', result: { status: 'done', action: 'follow-up', key: 'PROJ-33', linkMissing: true } }),
      changedRow('A4', 'PROJ-4', { action: 're-create', result: { status: 'done', action: 're-create', key: 'PROJ-32' } }),
      changedRow('A5', 'PROJ-5', { result: { status: 'failed', action: 'update', error: 'Field | labels is read-only' } }),
    ]), [], waltzOpts);
    expect(rowLine(text, 'A1')).toMatch(/\| updated \|$/);
    expect(rowLine(text, 'A2')).toMatch(/\| follow-up PROJ-31 \|$/);
    expect(rowLine(text, 'A3')).toMatch(/\| follow-up PROJ-33 \(link missing\) \|$/);
    expect(rowLine(text, 'A4')).toMatch(/\| re-created as PROJ-32 \|$/);
    for (const id of ['A1', 'A2', 'A3', 'A4']) expect(rowLine(text, id)).not.toContain('command:');
    const failed = rowLine(text, 'A5');
    expect(failed).toContain('✗ update failed: Field \\| labels is read-only');
    expect(failed).toContain(cmd('update', 'A5 update'));
  });

  it('the footer offers "Apply N actions" counting unfinished rows not on leave, plus shortcuts for rows on update / re-create', () => {
    const text = buildTicketedGroupScreen(screenSession([
      changedRow('A1', 'PROJ-1'),
      changedRow('A2', 'PROJ-2', { action: 're-create' }),
      changedRow('A3', 'PROJ-3', { result: { status: 'done', action: 'update' } }),
      makeActionRow('A4', 'PROJ-4'),
    ]), [], waltzOpts);
    expect(text).toContain(cmd('Apply 2 actions', 'apply'));
    expect(text).toContain(cmd('Update 1 tickets', 'update tickets'));
    expect(text).toContain(cmd('Re-create 1 tickets', 're-create tickets'));
    expect(text).toContain('`A2 follow-up`');
  });

  it('with every row on leave, there is nothing to apply and no shortcut link', () => {
    const text = buildTicketedGroupScreen(screenSession([makeActionRow('A1', 'PROJ-1'), makeActionRow('A2', 'PROJ-2')]), [], waltzOpts);
    expect(text).not.toContain('"@jira apply"');
    expect(text).not.toContain('"@jira update tickets"');
    expect(text).not.toContain('"@jira re-create tickets"');
    expect(text).toContain('nothing to apply');
  });

  it('notes the 50-per-reply cap when more rows are pending', () => {
    const rows = Array.from({ length: 60 }, (_, i) => changedRow(`A${i + 1}`, `PROJ-${i + 1}`));
    const text = buildTicketedGroupScreen(screenSession(rows), [], waltzOpts);
    expect(text).toContain(cmd('Apply 60 actions', 'apply'));
    expect(text).toContain('first 50');
  });
});

describe('Session schema version (U4/KTD8)', () => {
  it('is 9, so a review built with the version-8 row shape (no merged rows, Waltz sourceComponent) expires', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(9);
    expect(isSessionExpired({ schemaVersion: 8 })).toBe(true);
    expect(isSessionExpired({ schemaVersion: 9 })).toBe(false);
  });
});

describe('formatRowChange (U4/R5)', () => {
  it('summarizes a change in one line', () => {
    expect(formatRowChange({ kind: 'findings', newIds: ['a', 'b'], ratingRise: { from: 'High', to: 'Critical' } }, 'CVE(s)')).toBe('+2 CVEs, High→Critical');
    expect(formatRowChange({ kind: 'findings', newIds: ['1'] }, 'flaw(s)')).toBe('+1 flaw');
    expect(formatRowChange({ kind: 'findings', newIds: [], ratingRise: { from: 'High', to: 'Critical' } }, 'CVE(s)')).toBe('High→Critical');
    expect(formatRowChange({ kind: 'baseline' }, 'CVE(s)')).toBe('baseline');
    expect(formatRowChange(null, 'CVE(s)')).toBe('—');
    expect(formatRowChange(undefined, 'CVE(s)')).toBe('—');
  });

  it('renders a Jira-label-derived rating as inert cell text: no live link, no table-cell break', () => {
    const link = formatRowChange({ kind: 'findings', newIds: [], ratingRise: { from: '[Apply](command:workbench.action.chat.open?x)', to: 'Critical' } }, 'CVE(s)');
    expect(link).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(link).not.toContain('](command:');
    const pipe = formatRowChange({ kind: 'findings', newIds: [], ratingRise: { from: 'High', to: 'Crit | x' } }, 'CVE(s)');
    expect(pipe).not.toMatch(/(^|[^\\])\|/);
    expect(pipe).toContain('\\|');
  });
});

describe('applyTicketedActionChange (U4/R8)', () => {
  const rows = (): PageRow[] => [
    changedRow('A1', 'PROJ-1'),
    makeActionRow('A2', 'PROJ-2'),
    changedRow('A3', 'PROJ-3', { result: { status: 'done', action: 'update' } }),
    ...makeFreshRows(1),
  ];

  it('sets one row\'s action', () => {
    const out = applyTicketedActionChange(rows(), 'A1', 'follow-up');
    expect(out.find(r => r.id === 'A1')!.action).toBe('follow-up');
    expect(out.find(r => r.id === 'A2')!.action).toBe('leave');
  });

  it('"all <action>" sets every unfinished row that offers it and leaves the rest', () => {
    const out = applyTicketedActionChange(rows(), 'all', 'update');
    expect(out.find(r => r.id === 'A1')!.action).toBe('update');
    expect(out.find(r => r.id === 'A2')!.action).toBe('leave'); // update not offered
    const all = applyTicketedActionChange(rows(), 'all', 're-create');
    expect(all.find(r => r.id === 'A1')!.action).toBe('re-create');
    expect(all.find(r => r.id === 'A2')!.action).toBe('re-create');
    expect(all.find(r => r.id === 'A3')!.action).toBe('update'); // finished rows keep theirs
    expect(all.find(r => r.id === '1')!.action).toBeUndefined(); // new rows untouched
  });
});

describe('Overview screen (R1, R2, R3, R15)', () => {
  const staleWithTicket: ReviewSessionStale = {
    groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [{
      key: 'SEC-7', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false,
    }] }],
    ineligible: [],
    resolutionOptions: [],
  };

  it('lists New, Already ticketed and Stale with counts, open links and a Done link — and no "Post it"', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)], { staleTickets: staleWithTicket });
    const text = buildImportOverview(session, itemOpts);
    expect(text).toContain('**New** — 12 items');
    expect(text).toContain('**Already ticketed** — 1 item');
    expect(text).toContain('**Stale tickets**');
    expect(decodeURIComponent(text)).toContain('"@jira open new"');
    expect(decodeURIComponent(text)).toContain('"@jira open already ticketed"');
    expect(decodeURIComponent(text)).toContain('"@jira open stale"');
    expect(decodeURIComponent(text)).toContain('"@jira done"');
    expect(text.toLowerCase()).not.toContain('post it');
  });

  it('shows progress after a partial create ("50 created · 12 left")', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)]);
    session.outcomes = { ...session.outcomes!, created: 50 };
    expect(buildImportOverview(session, itemOpts)).toContain('50 created · 12 left');
  });

  it('reports rows with changes and the updated / follow-up / re-created counts separately (U4/R16)', () => {
    const ticketed = [
      ...Array.from({ length: 3 }, (_, i) => changedRow(`A${i + 1}`, `PROJ-${i + 1}`)),
      ...Array.from({ length: 9 }, (_, i) => makeActionRow(`A${i + 4}`, `PROJ-${i + 4}`)),
    ];
    const session = screenSession([...ticketed, ...makeFreshRows(1)]);
    session.outcomes = { ...session.outcomes!, updated: 2, followedUp: 1, recreated: 1 };
    const text = buildImportOverview(session, waltzOpts);
    expect(text).toContain('**Already ticketed** — 12 components · 3 with changes · 2 updated · 1 follow-up · 1 re-created');
    expect(text).not.toContain('with new findings');
  });

  it('omits "with changes" when no row changed', () => {
    const text = buildImportOverview(screenSession([makeActionRow('A1', 'PROJ-1'), ...makeFreshRows(1)]), waltzOpts);
    expect(text).toContain('**Already ticketed** — 1 component —');
  });

  it('omits a group that had no rows when the import was built', () => {
    const text = buildImportOverview(screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(2)]), itemOpts);
    expect(text).not.toContain('Stale');
  });

  it('keeps New listed with its outcome and no open link once every new row is created', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)]);
    session.allRows = session.allRows.filter(r => r.existingTicketKey !== null);
    session.rows = session.allRows;
    session.outcomes = { ...session.outcomes!, created: 12 };
    const text = buildImportOverview(session, itemOpts);
    expect(text).toContain('**New** — 12 created · 0 left');
    expect(decodeURIComponent(text)).not.toContain('"@jira open new"');
  });
});

describe('Import view state (KTD1, KTD7)', () => {
  const staleOnlyIneligible: ReviewSessionStale = {
    groups: [], ineligible: [{ key: 'PROJ-9', summary: 'x', currentStatus: 'Open', note: 'no rule' }],
  };

  it('New only → a single group that opens directly on the New screen', () => {
    const s = screenSession(makeFreshRows(3));
    expect(s.groups).toEqual(['new']);
    expect(s.singleGroup).toBe(true);
    expect(s.view).toBe('new');
  });

  it('New + Stale → the overview comes first', () => {
    const s = screenSession(makeFreshRows(1), { staleTickets: staleOnlyIneligible });
    expect(s.groups).toEqual(['new', 'stale']);
    expect(s.singleGroup).toBe(false);
    expect(s.view).toBe('overview');
  });

  it('Already ticketed only → opens directly on that screen', () => {
    const s = screenSession([makeTicketedRow('A1', 'PROJ-1')]);
    expect(s.view).toBe('ticketed');
    expect(s.singleGroup).toBe(true);
  });

  it('a Stale group with only tickets lacking a cleanup rule still counts as a group', () => {
    expect(computeImportResultGroups([], staleOnlyIneligible)).toEqual(['stale']);
  });

  it('ensureImportViewState fills in a caller-built session without overwriting an explicit view', () => {
    const bare: ReviewSession<PageRow> = {
      projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
      allRows: makeFreshRows(1), rows: makeFreshRows(1), page: 0, schemaVersion: 6, view: 'overview',
    };
    const filled = ensureImportViewState(bare);
    expect(filled.view).toBe('overview');
    expect(filled.singleGroup).toBe(true);
    expect(filled.outcomes).toEqual(emptyImportOutcomes());
  });

  it('buildImportDoneSummary reports every outcome and any failures', () => {
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), created: 3, closed: 1, createFailed: 1 }))
      .toBe('Import finished — **3** created, 0 updated, 0 follow-ups, 0 re-created, 1 closed, 1 failed.');
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), followedUp: 1, followUpFailed: 1 }))
      .toBe('Import finished — **0** created, 0 updated, 1 follow-up, 0 re-created, 0 closed, 1 failed.');
  });
});

describe('Per-screen reply parsing (KTD2, R6)', () => {
  const stale: ReviewSessionStale = {
    groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [{
      key: 'SEC-7', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false,
    }] }],
    ineligible: [],
    resolutionOptions: [],
  };
  const ctx: ImportReplyContext = {
    singleGroup: false, groups: ['new', 'ticketed', 'stale'],
    newRowIds: ['1', '2', '3'],
    ticketedRows: [
      { id: 'A1', allowedActions: ['update', 'follow-up', 're-create', 'leave'] },
      { id: 'A2', allowedActions: ['update', 're-create', 'leave'] },
      { id: 'A3', allowedActions: ['re-create', 'leave'] },
    ],
    stale,
  };

  it('overview: open links, done, cancellation, and nothing else', () => {
    expect(parseOverviewReply('open stale', ctx)).toEqual({ kind: 'open', view: 'stale' });
    expect(parseOverviewReply('Open Already  Ticketed', ctx)).toEqual({ kind: 'open', view: 'ticketed' });
    expect(parseOverviewReply('DONE', ctx)).toEqual({ kind: 'done' });
    expect(parseOverviewReply('cancel', ctx)).toEqual({ kind: 'done' });
    expect(parseOverviewReply('3', ctx)).toEqual({ kind: 'invalid' });
    expect(parseOverviewReply('post it', ctx)).toEqual({ kind: 'invalid' });
    expect(parseOverviewReply('open stale', { ...ctx, groups: ['new'] })).toEqual({ kind: 'invalid' });
  });

  it('New: confirmation words create; row ids, bulk and page words work; other screens\' tokens do not (AE2)', () => {
    expect(parseNewGroupReply('ok', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('post it', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('create tickets', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('2 3', ctx)).toEqual({ kind: 'toggleRows', ids: ['2', '3'] });
    expect(parseNewGroupReply('next', ctx)).toEqual({ kind: 'pageNav', nav: { kind: 'next' } });
    expect(parseNewGroupReply('exclude all', ctx)).toEqual({ kind: 'bulk', include: false });
    expect(parseNewGroupReply('A1', ctx)).toEqual({ kind: 'invalid' });
    expect(parseNewGroupReply('SEC-7', ctx)).toEqual({ kind: 'invalid' });
    expect(parseNewGroupReply('2 A1', ctx)).toEqual({ kind: 'invalid' }); // never half-applied
    expect(parseNewGroupReply('back', ctx)).toEqual({ kind: 'back' });
    expect(parseNewGroupReply('skip', ctx)).toEqual({ kind: 'back' }); // a cancellation word
  });

  it('New under a single group: back/cancel/done all end the import', () => {
    const single = { ...ctx, singleGroup: true };
    expect(parseNewGroupReply('done', single)).toEqual({ kind: 'done' });
    expect(parseNewGroupReply('cancel', single)).toEqual({ kind: 'done' });
  });

  it('Already ticketed: `<row id> <action>` and `all <action>` set actions (U4/KTD7)', () => {
    expect(parseTicketedGroupReply('A2 follow-up', { ...ctx, ticketedRows: [{ id: 'A2', allowedActions: ['update', 'follow-up', 're-create', 'leave'] }] }))
      .toEqual({ kind: 'setAction', id: 'A2', action: 'follow-up' });
    expect(parseTicketedGroupReply('a1 Re-Create', ctx)).toEqual({ kind: 'setAction', id: 'A1', action: 're-create' });
    expect(parseTicketedGroupReply('A1 followup', ctx)).toEqual({ kind: 'setAction', id: 'A1', action: 'follow-up' });
    expect(parseTicketedGroupReply('A1 follow up', ctx)).toEqual({ kind: 'setAction', id: 'A1', action: 'follow-up' });
    expect(parseTicketedGroupReply('all leave', ctx)).toEqual({ kind: 'setAllActions', action: 'leave' });
    expect(parseTicketedGroupReply('all follow-up', ctx)).toEqual({ kind: 'setAllActions', action: 'follow-up' });
  });

  it('Covers AE6: an action a row does not offer is rejected with a message', () => {
    const reply = parseTicketedGroupReply('A3 follow-up', ctx);
    expect(reply.kind).toBe('invalid');
    expect((reply as { reason?: string }).reason).toContain('A3');
    expect(parseTicketedGroupReply('A2 follow-up', ctx).kind).toBe('invalid');
    // No unfinished row offers the action at all.
    expect(parseTicketedGroupReply('all follow-up', { ...ctx, ticketedRows: [{ id: 'A3', allowedActions: ['re-create', 'leave'] }] }).kind).toBe('invalid');
  });

  it('a finished row (absent from ticketedRows) or an unknown row cannot be set', () => {
    expect(parseTicketedGroupReply('A9 leave', ctx).kind).toBe('invalid');
  });

  it('Already ticketed: paging/expand phrases never run apply; genuine assent still does', () => {
    for (const phrase of ['show all', 'load more', 'show more', 'load all', 'Show All']) {
      expect(parseTicketedGroupReply(phrase, ctx)).toEqual({ kind: 'invalid' });
    }
    expect(parseTicketedGroupReply('ok', ctx)).toEqual({ kind: 'apply' });
    expect(parseTicketedGroupReply('yes', ctx)).toEqual({ kind: 'apply' });
  });

  it('a bare row id no longer toggles anything', () => {
    expect(parseTicketedGroupReply('A1', ctx)).toEqual({ kind: 'invalid' });
    expect(parseTicketedGroupReply('3', ctx)).toEqual({ kind: 'invalid' });
  });

  it('apply, confirmation words and the shortcuts', () => {
    expect(parseTicketedGroupReply('apply', ctx)).toEqual({ kind: 'apply' });
    expect(parseTicketedGroupReply('ok', ctx)).toEqual({ kind: 'apply' });
    expect(parseTicketedGroupReply('post it', ctx)).toEqual({ kind: 'apply' });
    expect(parseTicketedGroupReply('update tickets', ctx)).toEqual({ kind: 'update' });
    expect(parseTicketedGroupReply('update existing tickets', ctx)).toEqual({ kind: 'update' });
    expect(parseTicketedGroupReply('re-create tickets', ctx)).toEqual({ kind: 'recreate' });
  });

  it('exit words still leave the screen', () => {
    expect(parseTicketedGroupReply('back', ctx)).toEqual({ kind: 'back' });
    expect(parseTicketedGroupReply('cancel', ctx)).toEqual({ kind: 'back' });
    expect(parseTicketedGroupReply('done', { ...ctx, singleGroup: true })).toEqual({ kind: 'done' });
  });

  it('the vocabulary reminder names the per-row replies', () => {
    const text = describeImportReplyVocabulary('ticketed', ctx);
    expect(text).toContain('`apply`');
    expect(text).toContain('`A2 follow-up`');
    expect(text).toContain('`all leave`');
    expect(text).toContain('`update tickets`');
    expect(text).toContain('`re-create tickets`');
  });

  it('Stale: ticket keys toggle, confirmation words close, row ids are rejected', () => {
    expect(parseStaleGroupReply('SEC-7', ctx)).toEqual({ kind: 'toggleStale', keys: ['SEC-7'] });
    expect(parseStaleGroupReply('ok', ctx)).toEqual({ kind: 'close' });
    expect(parseStaleGroupReply('close tickets', ctx)).toEqual({ kind: 'close' });
    expect(parseStaleGroupReply('A1', ctx)).toEqual({ kind: 'invalid' });
    expect(parseStaleGroupReply('SEC-7 3', ctx)).toEqual({ kind: 'invalid' }); // mixed reply rejected whole
  });

  it('a closed stale ticket can no longer be toggled', () => {
    expect(parseStaleGroupReply('SEC-7', { ...ctx, stale: { ...stale, closedKeys: ['SEC-7'] } })).toEqual({ kind: 'invalid' });
  });

  it('no command word is a confirmation/cancellation word, a row id, or a ticket key', () => {
    const actions: TicketedAction[] = ['update', 'follow-up', 're-create', 'leave'];
    const rowReplies = actions.flatMap(a => [`A1 ${a}`, `all ${a}`]);
    for (const word of [...Object.values(IMPORT_COMMANDS), ...actions, ...rowReplies]) {
      expect(isConfirmation(word)).toBe(false);
      expect(isCancellation(word)).toBe(false);
      expect(/^\d+$|^a\d+$/i.test(word)).toBe(false);
      expect(/^[A-Z][A-Z0-9]+-\d+$/i.test(word)).toBe(false);
      expect(parseReviewPageNav(word)).toBeNull();
      expect(parseBulkNewRowReply(word)).toBeNull();
    }
  });
});
