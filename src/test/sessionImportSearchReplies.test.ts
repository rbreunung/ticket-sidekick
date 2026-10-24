import { describe, it, expect } from 'vitest';
import {
  parseNewGroupReply, parseTicketedGroupReply, parseStaleGroupReply, parseOverviewReply, describeImportReplyVocabulary,
  type ImportReplyContext,
} from '../participant/sessionState';

const ctx = (overrides: Partial<ImportReplyContext> = {}): ImportReplyContext => ({
  singleGroup: false,
  groups: ['new', 'ticketed'],
  newRowIds: ['1', '2', '3'],
  ticketedRows: [{ id: 'A1', allowedActions: ['rewrite', 'leave'] }, { id: 'A3', allowedActions: ['rewrite', 'leave'] }],
  canFold: true,
  canSearch: true,
  canMergeTickets: true,
  ticketTargetKeys: { a1: 'PROJ-5', a3: 'PROJ-12' },
  mergedRowIds: [],
  ...overrides,
});

describe('search reply (import ticket search, U3)', () => {
  it.each([
    ['search netty', 'netty'],
    ['SEARCH  OrderRepository', 'OrderRepository'],
    ['  search netty codec  ', 'netty codec'],
  ])('"%s" on the New screen searches for "%s", keeping the keyword\'s case', (reply, keyword) => {
    expect(parseNewGroupReply(reply, ctx())).toEqual({ kind: 'search', keyword });
  });

  it('searches from the Already ticketed screen too', () => {
    expect(parseTicketedGroupReply('search netty', ctx())).toEqual({ kind: 'search', keyword: 'netty' });
  });

  it.each([parseNewGroupReply, parseTicketedGroupReply])('a bare "search" returns the usage', (parse) => {
    const action = parse('search', ctx());
    expect(action.kind).toBe('invalid');
    expect(action.kind === 'invalid' && action.reason).toContain('search <keyword>');
  });

  it.each([parseOverviewReply, parseStaleGroupReply])('on the overview and Stale screens a search points to the screens that have it', (parse) => {
    const action = parse('search netty', ctx());
    expect(action.kind).toBe('invalid');
    expect(action.kind === 'invalid' && action.reason).toMatch(/New and Already ticketed/);
  });

  it('an importer without search (email) does not read the word as a search', () => {
    expect(parseNewGroupReply('search netty', ctx({ canSearch: false, canFold: false }))).toEqual({ kind: 'invalid' });
  });
});

describe('show reply (import ticket search, U3)', () => {
  it.each([parseNewGroupReply, parseTicketedGroupReply, parseStaleGroupReply, parseOverviewReply])('is read on every screen', (parse) => {
    expect(parse('show', ctx())).toEqual({ kind: 'show' });
    expect(parse('  SHOW ', ctx())).toEqual({ kind: 'show' });
  });

  it('is not offered to an importer without search (email)', () => {
    expect(parseNewGroupReply('show', ctx({ canSearch: false, canFold: false }))).toEqual({ kind: 'invalid' });
  });

  it('does not disturb row toggles', () => {
    expect(parseNewGroupReply('2', ctx())).toEqual({ kind: 'toggleRows', ids: ['2'] });
  });
});

describe('merge … into <ticket> on the New screen (alias of add … to, U3)', () => {
  it('Covers AE4: an A id resolves to the row\'s main ticket', () => {
    expect(parseNewGroupReply('merge 1 2 into A3', ctx())).toEqual({ kind: 'addPrompt', ids: ['1', '2'], key: 'PROJ-12' });
  });

  it('accepts a ticket key, in any case', () => {
    expect(parseNewGroupReply('merge 1 2 into proj-12', ctx())).toEqual({ kind: 'addPrompt', ids: ['1', '2'], key: 'PROJ-12' });
  });

  it('accepts one row', () => {
    expect(parseNewGroupReply('merge 3 into A1', ctx())).toEqual({ kind: 'addPrompt', ids: ['3'], key: 'PROJ-5' });
  });

  it('an unknown A id is refused, naming it', () => {
    const action = parseNewGroupReply('merge 1 2 into A9', ctx());
    expect(action.kind).toBe('invalid');
    expect(action.kind === 'invalid' && action.reason).toContain('A9');
  });

  it('a row that is not a New row on this page is refused, naming it', () => {
    const action = parseNewGroupReply('merge 7 8 into A3', ctx());
    expect(action.kind).toBe('invalid');
    expect(action.kind === 'invalid' && action.reason).toContain('7');
  });

  it('a target that is neither a key nor an A id is refused', () => {
    const action = parseNewGroupReply('merge 1 2 into banana', ctx());
    expect(action.kind).toBe('invalid');
    expect(action.kind === 'invalid' && action.reason).toContain('BANANA');
  });

  it('still combines New rows without "into"', () => {
    expect(parseNewGroupReply('merge 1 2', ctx())).toEqual({ kind: 'merge', ids: ['1', '2'] });
  });

  it('keeps the overview pointer for a ticket merge typed on the New screen', () => {
    for (const reply of ['merge A5 into A3', 'merge PROJ-15 into PROJ-12']) {
      const action = parseNewGroupReply(reply, ctx());
      expect(action.kind).toBe('invalid');
      expect(action.kind === 'invalid' && action.reason).toMatch(/overview or the Already ticketed screen/);
    }
  });

  it('plain add … to still takes a key only', () => {
    expect(parseNewGroupReply('add 1 2 to PROJ-12', ctx())).toEqual({ kind: 'addPrompt', ids: ['1', '2'], key: 'PROJ-12' });
    expect(parseNewGroupReply('add 1 2 to A3', ctx()).kind).toBe('invalid');
  });

  it('the Stale screen still refuses merge … into', () => {
    const action = parseStaleGroupReply('merge 1 2 into A3', ctx());
    expect(action.kind).toBe('invalid');
  });

  it('an importer that cannot fold (email) gets no alias', () => {
    expect(parseNewGroupReply('merge 1 2 into A3', ctx({ canFold: false, canSearch: false, canMergeTickets: false }))).toEqual({ kind: 'invalid' });
  });

  it('the Already ticketed screen keeps its ticket merge', () => {
    expect(parseTicketedGroupReply('merge A1 into A3', ctx())).toEqual({ kind: 'mergeTicketsPrompt', sources: ['A1'], target: 'A3' });
  });
});

describe('screen vocabulary hint (import ticket search, U3)', () => {
  it('lists search, the merge alias and show on the New screen', () => {
    const text = describeImportReplyVocabulary('new', ctx());
    expect(text).toContain('`search netty`');
    expect(text).toContain('`merge 2 4 into A3`');
    expect(text).toContain('`show`');
  });

  it('lists search and show on the Already ticketed screen', () => {
    const text = describeImportReplyVocabulary('ticketed', ctx());
    expect(text).toContain('`search netty`');
    expect(text).toContain('`show`');
  });

  it('lists none of them for an importer without search', () => {
    const text = describeImportReplyVocabulary('new', ctx({ canSearch: false, canFold: false }));
    expect(text).not.toContain('search');
    expect(text).not.toContain('`show`');
  });
});
