import { describe, it, expect } from 'vitest';
import {
  parseImportReviewReply, buildImportHelp, importCommandCaps, buildImportOverview, buildNewGroupScreen, buildImportScreen,
  buildTicketedGroupScreen, IMPORT_COMMANDS, UNACCEPT_COMPONENT_WORD, isConfirmation, isCancellation, parseReviewPageNav, parseBulkNewRowReply,
  type ImportReplyContext, type ReviewSession, type ReviewRowBase, type ReviewTableColumn,
} from '../participant/sessionState';

const helpOf = (view: 'overview' | 'new' | 'ticketed' | 'stale', c: ImportReplyContext): string => buildImportHelp(view, importCommandCaps(c));

function ctx(over: Partial<ImportReplyContext> = {}): ImportReplyContext {
  return {
    singleGroup: false, groups: ['new', 'ticketed'], newRowIds: ['1', '2', '3'], ticketedRows: [],
    canFold: true, canAccept: true, mergedRowIds: [], ...over,
  };
}

describe('accept CVE replies on the New screen', () => {
  it('reads row numbers with no reason', () => {
    expect(parseImportReviewReply('new', 'accept CVE 2 3', ctx())).toEqual({ kind: 'accept', ids: ['2', '3'] });
  });

  it('reads a reason after "because" and keeps its casing', () => {
    expect(parseImportReviewReply('new', 'Accept cve 2 because Not reachable behind the proxy', ctx()))
      .toEqual({ kind: 'accept', ids: ['2'], reason: 'Not reachable behind the proxy' });
  });

  it('rejects a row that is not on the visible page, naming it', () => {
    const action = parseImportReviewReply('new', 'accept CVE 9', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/Row 9/);
  });

  it('rejects "accept CVE" with no rows and shows how to use it', () => {
    const action = parseImportReviewReply('new', 'accept CVE', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/accept CVE 2/);
  });

  it('is not offered to an importer without the accepted list', () => {
    expect(parseImportReviewReply('new', 'accept CVE 2', ctx({ canAccept: false }))).toMatchObject({ kind: 'invalid' });
  });

  it('is not valid on the overview', () => {
    expect(parseImportReviewReply('overview', 'accept CVE 2', ctx())).toMatchObject({ kind: 'invalid' });
  });
});

describe('a bare accept records nothing and names both spellings', () => {
  it('New: "accept 2 4" is refused, not read as the CVE form', () => {
    const action = parseImportReviewReply('new', 'accept 2 4', ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    const reason = (action as { reason?: string }).reason ?? '';
    expect(reason).toContain('accept CVE');
    expect(reason).toContain('accept component');
  });

  it('New: a bare "accept" is refused the same way', () => {
    const reason = (parseImportReviewReply('new', 'accept', ctx()) as { reason?: string }).reason ?? '';
    expect(reason).toContain('accept CVE');
    expect(reason).toContain('accept component');
  });

  it('Already ticketed: names both spellings and says the CVE form works from New only', () => {
    const c = ctx({ ticketedRows: [{ id: 'A1', allowedActions: ['rewrite', 'leave'] }] });
    for (const text of ['accept', 'accept A1', 'accept CVE 2']) {
      const action = parseImportReviewReply('ticketed', text, c);
      expect(action, text).toMatchObject({ kind: 'invalid' });
      const reason = (action as { reason?: string }).reason ?? '';
      expect(reason, text).toContain('accept component');
      expect(reason, text).toContain('accept CVE');
      expect(reason, text).toContain('New');
    }
  });
});

describe('help replies', () => {
  it('are read on every screen, for an importer with and without the optional capabilities', () => {
    const bare = ctx({ canFold: false, canAccept: false });
    for (const view of ['overview', 'new', 'ticketed', 'stale'] as const) {
      expect(parseImportReviewReply(view, 'help', ctx()), view).toEqual({ kind: 'help' });
      expect(parseImportReviewReply(view, ' HELP ', bare), view).toEqual({ kind: 'help' });
    }
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

  it('"unaccept <component> <CVE>" names the entry itself, which is what the Remove links send', () => {
    expect(parseImportReviewReply('new', 'unaccept netty-codec CVE-2024-1234', ctx()))
      .toEqual({ kind: 'unacceptEntry', component: 'netty-codec', cve: 'cve-2024-1234' });
    expect(parseImportReviewReply('overview', 'unaccept org.example:lib CVE-1', ctx()))
      .toEqual({ kind: 'unacceptEntry', component: 'org.example:lib', cve: 'cve-1' });
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
  const words = ['accept', 'accepted', 'unaccept', IMPORT_COMMANDS.accepted, 'accept component', UNACCEPT_COMPONENT_WORD];
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
    expect(buildNewGroupScreen(s, columns, opts)).toContain('hide `accept CVE` `accept component`');
    expect(buildNewGroupScreen(s, columns, { itemNoun: 'component(s)' })).not.toContain('accept');
  });

  it('the vocabulary reminder names the new replies only when they are offered', () => {
    expect(helpOf('new', ctx())).toContain('accept');
    expect(helpOf('new', ctx({ canAccept: false }))).not.toContain('accept');
    expect(helpOf('overview', ctx())).toContain('accepted');
  });
});

describe('accept component replies (accepted-components plan, U4)', () => {
  const ticketed = (...ids: string[]) => ids.map(id => ({ id, allowedActions: ['leave' as const] }));

  it('New: reads row numbers and keeps the reason as typed', () => {
    expect(parseImportReviewReply('new', 'accept component 2 3', ctx())).toEqual({ kind: 'acceptComponent', ids: ['2', '3'] });
    expect(parseImportReviewReply('new', 'Accept Component 2 because No newer version', ctx()))
      .toEqual({ kind: 'acceptComponent', ids: ['2'], reason: 'No newer version' });
  });

  it('New: rejects a row that is not on the visible page, naming it, and a missing row list', () => {
    const missing = parseImportReviewReply('new', 'accept component 9', ctx());
    expect(missing).toMatchObject({ kind: 'invalid' });
    expect((missing as { reason?: string }).reason).toMatch(/Row 9/);
    const bare = parseImportReviewReply('new', 'accept component', ctx());
    expect(bare).toMatchObject({ kind: 'invalid' });
    expect((bare as { reason?: string }).reason).toMatch(/accept component/);
  });

  it('Already ticketed: reads the A ids of rows still open, with a reason', () => {
    const c = ctx({ ticketedRows: ticketed('A1', 'A2') });
    expect(parseImportReviewReply('ticketed', 'accept component a1 a2 because no update', c))
      .toEqual({ kind: 'acceptComponent', ids: ['A1', 'A2'], reason: 'no update' });
  });

  it('Already ticketed: rejects a finished or unknown row, naming it', () => {
    const action = parseImportReviewReply('ticketed', 'accept component A3', ctx({ ticketedRows: ticketed('A1') }));
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/Row A3/);
  });

  it('Already ticketed: plain "accept A1" is invalid and points at the component form', () => {
    const action = parseImportReviewReply('ticketed', 'accept A1', ctx({ ticketedRows: ticketed('A1') }));
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/accept component/);
  });

  it('is not offered to an importer without the accepted list, and not on the overview or Stale screen', () => {
    expect(parseImportReviewReply('new', 'accept component 2', ctx({ canAccept: false }))).toMatchObject({ kind: 'invalid' });
    expect(parseImportReviewReply('ticketed', 'accept component A1', ctx({ canAccept: false, ticketedRows: ticketed('A1') }))).toMatchObject({ kind: 'invalid' });
    expect(parseImportReviewReply('overview', 'accept component 2', ctx())).toMatchObject({ kind: 'invalid' });
    expect(parseImportReviewReply('stale', 'accept component 2', ctx({ groups: ['new', 'stale'] }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('removing a component entry (accepted-components plan, U4)', () => {
  it('reads the component and version a Remove link names, from the overview and the New screen', () => {
    expect(parseImportReviewReply('overview', `${UNACCEPT_COMPONENT_WORD} netty-codec 4.1.100`, ctx()))
      .toEqual({ kind: 'unacceptComponent', component: 'netty-codec', version: '4.1.100' });
    expect(parseImportReviewReply('new', `${UNACCEPT_COMPONENT_WORD} org.example:lib 1.0-rc1`, ctx()))
      .toEqual({ kind: 'unacceptComponent', component: 'org.example:lib', version: '1.0-rc1' });
  });

  it('the CVE form is still read as a CVE entry, and the component form never as one', () => {
    expect(parseImportReviewReply('new', 'unaccept netty-codec 4.1.100', ctx())).toEqual({ kind: 'unacceptEntry', component: 'netty-codec', cve: '4.1.100' });
    expect(parseImportReviewReply('new', `${UNACCEPT_COMPONENT_WORD} netty-codec CVE-1`, ctx())).toMatchObject({ kind: 'unacceptComponent' });
  });

  it('without a version it is invalid and shows how to use it', () => {
    const action = parseImportReviewReply('new', UNACCEPT_COMPONENT_WORD, ctx());
    expect(action).toMatchObject({ kind: 'invalid' });
    expect((action as { reason?: string }).reason).toMatch(/Remove/);
  });

  it('is invalid on the Stale screen of an import that has an overview, valid on a single screen', () => {
    expect(parseImportReviewReply('stale', `${UNACCEPT_COMPONENT_WORD} libfoo 1.0`, ctx({ groups: ['new', 'stale'] }))).toMatchObject({ kind: 'invalid' });
    expect(parseImportReviewReply('stale', `${UNACCEPT_COMPONENT_WORD} libfoo 1.0`, ctx({ singleGroup: true, groups: ['stale'] })))
      .toEqual({ kind: 'unacceptComponent', component: 'libfoo', version: '1.0' });
  });
});

describe('screens with accepted components (accepted-components plan, U4)', () => {
  const opts = { itemNoun: 'component(s)', canAccept: true };
  interface R extends ReviewRowBase { label: string }
  const columns: ReviewTableColumn<R>[] = [{ header: 'Name', accessor: r => r.label }];
  const row = (id: string, existing: string | null = null): R => ({ id, existingTicketKey: existing, included: existing === null, label: `row ${id}`, ...(existing ? { allowedActions: ['leave' as const], action: 'leave' as const, target: { key: existing, status: 'Open', resolved: false }, ticketKeys: [existing] } : {}) });
  const session = (over: Partial<ReviewSession<R>> = {}): ReviewSession<R> => {
    const allRows = [row('1'), row('A1', 'PROJ-1')];
    return { projectKey: 'PROJ', issueType: 'Task', templateName: null, additionalFields: {}, allRows, rows: allRows, page: 0, schemaVersion: 11, ...over };
  };

  it('the New screen and the Already ticketed screen tell how to accept a component', () => {
    const s = session({ view: 'new', groups: ['new', 'ticketed'], singleGroup: false });
    expect(buildNewGroupScreen(s, columns, opts)).toContain('accept component');
    expect(buildTicketedGroupScreen({ ...s, view: 'ticketed' }, columns, opts)).toContain('hide `accept component`');
  });

  it('the Already ticketed screen says nothing about it for an importer without the accepted list', () => {
    const s = session({ view: 'ticketed', groups: ['new', 'ticketed'], singleGroup: false });
    expect(buildTicketedGroupScreen(s, columns, { ...opts, canAccept: false })).not.toContain('accept component');
  });

  it('the overview counts hidden components apart from CVEs, with the link to list them', () => {
    const text = buildImportOverview(session({ acceptedHidden: { cves: 0, belowFloor: 0, components: 2 } }), opts);
    expect(text).toContain('2 accepted components hidden');
    expect(text).toContain('Show accepted');
  });

  it('the "didn\'t understand" reminder names the component reply where it applies', () => {
    expect(helpOf('new', ctx())).toContain('accept component');
    expect(helpOf('ticketed', ctx())).toContain('accept component');
    expect(helpOf('ticketed', ctx({ canAccept: false }))).not.toContain('accept component');
  });
});

describe('Stale screen page replies', () => {
  it('next, prev and page <n> are read on the Stale screen', () => {
    const c = ctx({ groups: ['new', 'stale'] });
    expect(parseImportReviewReply('stale', 'next', c)).toEqual({ kind: 'pageNav', nav: { kind: 'next' } });
    expect(parseImportReviewReply('stale', 'Prev', c)).toEqual({ kind: 'pageNav', nav: { kind: 'prev' } });
    expect(parseImportReviewReply('stale', 'page 3', c)).toEqual({ kind: 'pageNav', nav: { kind: 'goto', page: 2 } });
  });

  it('the "didn\'t understand" reminder names them', () => {
    expect(helpOf('stale', ctx())).toContain('`next`');
  });
});
