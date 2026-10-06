import { describe, it, expect } from 'vitest';
import {
  parseImportReviewReply, describeImportReplyVocabulary, buildImportOverview, buildNewGroupScreen, buildImportScreen,
  buildAcceptedList, IMPORT_COMMANDS, isConfirmation, isCancellation, parseReviewPageNav, parseBulkNewRowReply,
  type ImportReplyContext, type ReviewSession, type ReviewRowBase, type ReviewTableColumn,
} from '../participant/sessionState';

function ctx(over: Partial<ImportReplyContext> = {}): ImportReplyContext {
  return {
    singleGroup: false, groups: ['new', 'ticketed'], newRowIds: ['1', '2', '3'], ticketedRows: [],
    canFold: true, canAccept: true, mergedRowIds: [], ...over,
  };
}

describe('accept replies on the New screen (R5)', () => {
  it('reads row numbers with no reason', () => {
    expect(parseImportReviewReply('new', 'accept 2 3', ctx())).toEqual({ kind: 'accept', ids: ['2', '3'] });
  });

  it('reads a reason after "because" and keeps its casing', () => {
    expect(parseImportReviewReply('new', 'Accept 2 because Not reachable behind the proxy', ctx()))
      .toEqual({ kind: 'accept', ids: ['2'], reason: 'Not reachable behind the proxy' });
  });

  it('rejects a row that is not on the visible page, naming it', () => {
    const action = parseImportReviewReply('new', 'accept 9', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/Row 9/);
  });

  it('rejects "accept" with no rows and shows how to use it', () => {
    const action = parseImportReviewReply('new', 'accept', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/accept 2/);
  });

  it('is not offered to an importer without the accepted list', () => {
    expect(parseImportReviewReply('new', 'accept 2', ctx({ canAccept: false }))).toMatchObject({ kind: 'invalid' });
  });

  it('is not valid on the overview', () => {
    expect(parseImportReviewReply('overview', 'accept 2', ctx())).toMatchObject({ kind: 'invalid' });
  });
});

describe('listing and removing accepted entries (R7)', () => {
  it('"accepted" lists the entries from the overview and from the New screen', () => {
    expect(parseImportReviewReply('overview', 'accepted', ctx())).toEqual({ kind: 'listAccepted' });
    expect(parseImportReviewReply('new', 'accepted', ctx())).toEqual({ kind: 'listAccepted' });
  });

  it('"unaccept <n>" removes the entry at that position from the overview and the New screen', () => {
    expect(parseImportReviewReply('overview', 'unaccept 3', ctx())).toEqual({ kind: 'unaccept', position: 3 });
    expect(parseImportReviewReply('new', 'unaccept 1', ctx())).toEqual({ kind: 'unaccept', position: 1 });
  });

  it('"unaccept" without a number is invalid and says how to use it', () => {
    const action = parseImportReviewReply('new', 'unaccept', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/unaccept 2/);
  });

  it('is invalid on the Stale screen of an import that has an overview', () => {
    expect(parseImportReviewReply('stale', 'accepted', ctx({ groups: ['new', 'stale'] }))).toMatchObject({ kind: 'invalid' });
    expect(parseImportReviewReply('stale', 'unaccept 1', ctx({ groups: ['new', 'stale'] }))).toMatchObject({ kind: 'invalid' });
  });

  it('works on the only group\'s screen when the import has no overview', () => {
    const single = ctx({ singleGroup: true, groups: ['stale'] });
    expect(parseImportReviewReply('stale', 'accepted', single)).toEqual({ kind: 'listAccepted' });
    expect(parseImportReviewReply('ticketed', 'unaccept 2', ctx({ singleGroup: true, groups: ['ticketed'] }))).toEqual({ kind: 'unaccept', position: 2 });
  });

  it('is not offered to an importer without the accepted list', () => {
    expect(parseImportReviewReply('overview', 'accepted', ctx({ canAccept: false }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('the new words stay disjoint from every other reply word', () => {
  const words = ['accept', 'accepted', 'unaccept', IMPORT_COMMANDS.accepted];
  it('are not confirmation or cancellation words, row ids, ticket keys, or page and bulk tokens', () => {
    for (const w of words) {
      expect(isConfirmation(w), w).toBe(false);
      expect(isCancellation(w), w).toBe(false);
      expect(parseReviewPageNav(w), w).toBeNull();
      expect(parseBulkNewRowReply(w), w).toBeNull();
      expect(/^\d+$|^A\d+$/i.test(w), w).toBe(false);
      expect(/^[A-Z][A-Z0-9]+-\d+$/i.test(w), w).toBe(false);
    }
  });

  it('are none of the other import command words', () => {
    const others = Object.entries(IMPORT_COMMANDS).filter(([k]) => k !== 'accepted').map(([, v]) => v as string);
    for (const w of words) expect(others, w).not.toContain(w);
  });
});

describe('screens', () => {
  interface R extends ReviewRowBase { label: string }
  const columns: ReviewTableColumn<R>[] = [{ header: 'Name', accessor: r => r.label }];
  const row = (id: string, existing: string | null = null): R => ({ id, existingTicketKey: existing, included: existing === null, label: `row ${id}` });
  const session = (over: Partial<ReviewSession<R>> = {}): ReviewSession<R> => {
    const allRows = [row('1'), row('A1', 'PROJ-1')];
    return { projectKey: 'PROJ', issueType: 'Task', templateName: null, additionalFields: {}, allRows, rows: allRows, page: 0, schemaVersion: 10, ...over };
  };
  const opts = { itemNoun: 'component(s)', canAccept: true };

  it('the overview shows what was hidden, with a link to list it', () => {
    const text = buildImportOverview(session({ acceptedHidden: { cves: 3, belowFloor: 1 } }), opts);
    expect(text).toContain('3 accepted CVEs hidden');
    expect(text).toContain('1 component below the rating floor');
  });

  it('the overview says nothing about hiding when nothing was hidden', () => {
    expect(buildImportOverview(session(), opts)).not.toContain('hidden');
  });

  it('the New screen of a single-group import shows the same line, so the count is never invisible', () => {
    const s = session({ allRows: [row('1')], rows: [row('1')], singleGroup: true, groups: ['new'], view: 'new', acceptedHidden: { cves: 2, belowFloor: 0 } });
    const text = buildNewGroupScreen(s, columns, opts);
    expect(text).toContain('2 accepted CVEs hidden');
  });

  it('a single-group Already-ticketed screen shows the line too', () => {
    const s = session({ allRows: [row('A1', 'PROJ-1')], rows: [row('A1', 'PROJ-1')], singleGroup: true, groups: ['ticketed'], view: 'ticketed', acceptedHidden: { cves: 2, belowFloor: 0 } });
    expect(buildImportScreen(s, columns, opts)).toContain('2 accepted CVEs hidden');
  });

  it('an Already-ticketed screen that has an overview does not repeat it', () => {
    const s = session({ view: 'ticketed', singleGroup: false, groups: ['new', 'ticketed'], acceptedHidden: { cves: 2, belowFloor: 0 } });
    expect(buildImportScreen(s, columns, opts)).not.toContain('accepted CVEs hidden');
  });

  it('the New screen mentions `accept` only for an importer that has the list', () => {
    const s = session({ view: 'new', singleGroup: false, groups: ['new', 'ticketed'] });
    expect(buildNewGroupScreen(s, columns, opts)).toContain('accept 2');
    expect(buildNewGroupScreen(s, columns, { itemNoun: 'component(s)' })).not.toContain('accept 2');
  });

  it('the vocabulary reminder names the new replies only when they are offered', () => {
    expect(describeImportReplyVocabulary('new', ctx())).toContain('accept');
    expect(describeImportReplyVocabulary('new', ctx({ canAccept: false }))).not.toContain('accept');
    expect(describeImportReplyVocabulary('overview', ctx())).toContain('accepted');
  });
});

describe('buildAcceptedList — the entries, numbered, each with a remove link', () => {
  it('lists component, CVE and reason in file order with a link that resends unaccept <n>', () => {
    const text = buildAcceptedList([
      { component: 'netty-codec', cve: 'CVE-2024-0001', reason: 'not reachable' },
      { component: 'libfoo', cve: 'CVE-2024-0002' },
    ]);
    expect(text).toContain('1. ');
    expect(text).toContain('netty-codec');
    expect(text).toContain('not reachable');
    expect(text).toContain('2. ');
    expect(text).toMatch(/unaccept(%20| )1/);
    expect(text).toMatch(/unaccept(%20| )2/);
  });

  it('says so when the list is empty', () => {
    expect(buildAcceptedList([])).toMatch(/empty/i);
  });

  it('neutralizes link syntax and line breaks in a hand-edited reason', () => {
    const text = buildAcceptedList([{ component: 'libfoo', cve: 'CVE-2024-0001', reason: '[click](http://evil.example)\n# Heading' }]);
    expect(text).not.toContain('](http://evil.example)');
    expect(text.split('\n').filter(l => l.startsWith('#') && l !== '### Accepted CVEs')).toEqual([]);
  });
});
