import { describe, it, expect } from 'vitest';
import { buildChatCommandLink } from '../participant/sessionState';
import { type ReviewRowBase } from '../participant/sessionState';
import { describeImportReplyVocabulary, type TicketedAction, emptyImportOutcomes, buildImportDoneSummary, parseNewGroupReply, parseTicketedGroupReply, isConfirmation, isCancellation, mergeNewRows, unmergeNewRow, restoreMergedRows, buildAddPrompt, buildChatCommandLink, findPartialRewrites, formatTicketedRowResult, type ImportReplyContext } from '../participant/sessionState';

describe('merge and unmerge replies on the New screen (finding folding, U4)', () => {
  const ctx = (overrides: Partial<ImportReplyContext> = {}): ImportReplyContext => ({
    singleGroup: false, groups: ['new'], newRowIds: ['1', '2', '3'], ticketedRows: [], canFold: true, mergedRowIds: [], ...overrides,
  });

  it.each(['merge 1,2', 'merge 1 2', 'MERGE 1, 2', '  merge   1 ,2  '])('"%s" merges rows 1 and 2', (reply) => {
    expect(parseNewGroupReply(reply, ctx())).toEqual({ kind: 'merge', ids: ['1', '2'] });
  });

  it('merges three rows named in any order', () => {
    expect(parseNewGroupReply('merge 3,1,2', ctx())).toEqual({ kind: 'merge', ids: ['3', '1', '2'] });
  });

  it('AE4: an id that is not on the visible page is invalid and says which one', () => {
    const action = parseNewGroupReply('merge 3,61', ctx());
    expect(action.kind).toBe('invalid');
    expect((action as { reason?: string }).reason).toContain('61');
  });

  it('needs at least two distinct rows', () => {
    expect(parseNewGroupReply('merge 3', ctx()).kind).toBe('invalid');
    expect(parseNewGroupReply('merge 2 2', ctx()).kind).toBe('invalid');
    expect(parseNewGroupReply('merge', ctx()).kind).toBe('invalid');
  });

  it('rejects an already-ticketed row id', () => {
    expect(parseNewGroupReply('merge A1 2', ctx()).kind).toBe('invalid');
  });

  it('unmerge restores a merged row, and is invalid on a row that is not merged', () => {
    expect(parseNewGroupReply('unmerge 1', ctx({ mergedRowIds: ['1'] }))).toEqual({ kind: 'unmerge', id: '1' });
    const action = parseNewGroupReply('unmerge 2', ctx({ mergedRowIds: ['1'] }));
    expect(action.kind).toBe('invalid');
    expect((action as { reason?: string }).reason).toContain('2');
  });

  it('an importer that cannot fold (email) does not understand either word', () => {
    expect(parseNewGroupReply('merge 1,2', ctx({ canFold: false })).kind).toBe('invalid');
    expect(parseNewGroupReply('unmerge 1', ctx({ canFold: false, mergedRowIds: ['1'] })).kind).toBe('invalid');
  });

  it('leaves every existing New-screen reply meaning what it meant', () => {
    expect(parseNewGroupReply('2 3', ctx())).toEqual({ kind: 'toggleRows', ids: ['2', '3'] });
    expect(parseNewGroupReply('ok', ctx())).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('include all', ctx())).toEqual({ kind: 'bulk', include: true });
    expect(parseNewGroupReply('next', ctx())).toEqual({ kind: 'pageNav', nav: { kind: 'next' } });
  });

  it('merge, unmerge and add are never confirmation or cancellation words', () => {
    for (const word of ['merge', 'unmerge', 'add', 'merge 1 2', 'unmerge 1']) {
      expect(isConfirmation(word), word).toBe(false);
      expect(isCancellation(word), word).toBe(false);
    }
  });

  it('the vocabulary hint names merge and unmerge only for an importer that can fold', () => {
    expect(describeImportReplyVocabulary('new', ctx())).toContain('merge');
    expect(describeImportReplyVocabulary('new', ctx({ canFold: false }))).not.toContain('merge');
  });
});

describe('mergeNewRows and unmergeNewRow (finding folding, U4)', () => {
  interface Row extends ReviewRowBase { summary: string }
  const row = (id: string, summary = `row ${id}`, extra: Partial<Row> = {}): Row => ({ id, existingTicketKey: null, included: true, summary, ...extra });
  const build = (members: Row[]) => ({ summary: members.map(m => m.summary).join(' + ') });

  it('replaces the named rows with one row that keeps the first member\'s id and position', () => {
    const rows = [row('1'), row('2'), row('3'), row('4')];
    const merged = mergeNewRows(rows, ['2', '4'], build);
    expect(merged.map(r => r.id)).toEqual(['1', '2', '3']);
    expect(merged[1]).toMatchObject({ id: '2', summary: 'row 2 + row 4', memberIds: ['2', '4'], included: true, existingTicketKey: null });
  });

  it('takes members in page order whatever order the ids were typed in', () => {
    const merged = mergeNewRows([row('1'), row('2'), row('3')], ['3', '1'], build);
    expect(merged.map(r => r.id)).toEqual(['1', '2']);
    expect(merged[0].memberIds).toEqual(['1', '3']);
  });

  it('merging an already-merged row unions the member ids', () => {
    const once = mergeNewRows([row('1'), row('2'), row('3')], ['1', '2'], build);
    const twice = mergeNewRows(once, ['1', '3'], build);
    expect(twice).toHaveLength(1);
    expect(twice[0].memberIds).toEqual(['1', '2', '3']);
  });

  it('never touches an already-ticketed row, even when its id is named', () => {
    const rows = [row('A1', 'ticketed', { existingTicketKey: 'PROJ-1' }), row('1'), row('2')];
    const merged = mergeNewRows(rows, ['A1', '1', '2'], build);
    expect(merged.find(r => r.id === 'A1')).toBeDefined();
    expect(merged.find(r => r.id === '1')?.memberIds).toEqual(['1', '2']);
  });

  it('unmerge puts the original rows back in place from allRows', () => {
    const all = [row('1'), row('2'), row('3')];
    const merged = mergeNewRows(all, ['1', '3'], build);
    const restored = unmergeNewRow(merged, all, '1');
    expect(restored.map(r => r.id)).toEqual(['1', '3', '2']);
    expect(restored.every(r => r.memberIds === undefined)).toBe(true);
  });

  it('unmerge on a row that is not merged changes nothing', () => {
    const all = [row('1'), row('2')];
    expect(unmergeNewRow(all, all, '1')).toEqual(all);
  });
});

describe('add replies on the New screen (finding folding, U5)', () => {
  const ctx = (overrides: Partial<ImportReplyContext> = {}): ImportReplyContext => ({
    singleGroup: false, groups: ['new'], newRowIds: ['1', '2', '3'], ticketedRows: [], canFold: true, mergedRowIds: [], ...overrides,
  });

  it('a bare add names the rows and the ticket, normalizing the key, and asks for the mode', () => {
    expect(parseNewGroupReply('add 3,1 to proj-123', ctx())).toEqual({ kind: 'addPrompt', ids: ['3', '1'], key: 'PROJ-123' });
    expect(parseNewGroupReply('ADD 2 to PROJ-7', ctx())).toEqual({ kind: 'addPrompt', ids: ['2'], key: 'PROJ-7' });
  });

  it('an explicit mode executes: as comment, as rewrite', () => {
    expect(parseNewGroupReply('add 1 2 to PROJ-123 as comment', ctx())).toEqual({ kind: 'add', ids: ['1', '2'], key: 'PROJ-123', mode: 'comment' });
    expect(parseNewGroupReply('add 1 to PROJ-123 as rewrite', ctx())).toEqual({ kind: 'add', ids: ['1'], key: 'PROJ-123', mode: 'rewrite' });
  });

  it('rejects an id that is not a New row on the visible page, naming it', () => {
    const action = parseNewGroupReply('add 3,61 to PROJ-123', ctx());
    expect(action.kind).toBe('invalid');
    expect((action as { reason?: string }).reason).toContain('61');
    expect(parseNewGroupReply('add A1 to PROJ-123', ctx()).kind).toBe('invalid');
  });

  it('rejects a missing or malformed ticket key and an unknown mode, with a usage reason', () => {
    for (const reply of ['add 1', 'add 1 to foo', 'add 1 to PROJ-123 as delete', 'add', 'add to PROJ-1']) {
      const action = parseNewGroupReply(reply, ctx());
      expect(action.kind, reply).toBe('invalid');
      expect((action as { reason?: string }).reason, reply).toContain('add 2 4 to PROJ-123');
    }
  });

  it('an importer that cannot fold (email) does not understand add', () => {
    expect(parseNewGroupReply('add 1 to PROJ-123', ctx({ canFold: false })).kind).toBe('invalid');
  });

  it('the vocabulary hint names add only for an importer that can fold', () => {
    expect(describeImportReplyVocabulary('new', ctx())).toContain('add 2 4 to PROJ-123');
    expect(describeImportReplyVocabulary('new', ctx({ canFold: false }))).not.toContain('add 2');
  });
});

describe('buildAddPrompt (finding folding, KTD5, KTD13)', () => {
  const base = { key: 'PROJ-123', summary: 'Hand-made netty upgrade', status: 'Open', resolved: false, ids: ['3', '5'], rowCount: 2, droppedKeys: [] as string[] };

  it('offers Comment and Rewrite as links that resend the command with the mode', () => {
    const text = buildAddPrompt(base);
    expect(text).toContain(buildChatCommandLink('Comment', '@jira', 'add 3,5 to PROJ-123 as comment'));
    expect(text).toContain(buildChatCommandLink('Rewrite', '@jira', 'add 3,5 to PROJ-123 as rewrite'));
  });

  it('names the ticket and says Rewrite overwrites its description and title', () => {
    const text = buildAddPrompt(base);
    expect(text).toContain('PROJ-123');
    expect(text).toContain('Hand-made netty upgrade');
    expect(text.toLowerCase()).toContain('overwrite');
    expect(text).toContain('labels');
  });

  it('warns when the ticket is resolved', () => {
    expect(buildAddPrompt({ ...base, status: 'Done', resolved: true })).toContain('resolved');
    expect(buildAddPrompt(base)).not.toContain('resolved');
  });

  it('lists the findings a rewrite would drop, and omits the section when none', () => {
    const withDropped = buildAddPrompt({ ...base, droppedKeys: ['1001', '1002'] });
    expect(withDropped).toContain('1001');
    expect(withDropped).toContain('1002');
    expect(buildAddPrompt(base)).not.toContain('would drop');
  });

  it('neutralizes a ticket summary that tries to be a chat command link', () => {
    const text = buildAddPrompt({ ...base, summary: '[click](command:workbench.action.chat.open)' });
    expect(text).not.toContain('[click](command:');
  });

  it('defuses angle-bracket command autolinks in the summary, status and dropped keys', () => {
    const evil = '<command:workbench.action.chat.open?%7B%22query%22%3A%22x%22%7D>';
    const text = buildAddPrompt({ ...base, summary: evil, status: evil, droppedKeys: [evil] });
    expect(text).not.toMatch(/(?<!\\)<command:/);
    expect(text).toContain('\\<command:');
  });

  it('a backslash in the summary cannot un-escape the defused bracket', () => {
    const text = buildAddPrompt({ ...base, summary: '\\<command:workbench.action.chat.open>' });
    expect(text).toContain('\\\\\\<command:');
  });
});

describe('restoreMergedRows (finding folding)', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, existingTicketKey: null, included: true, ...extra }) as never;

  it('puts a merged row back in place of its members', () => {
    const merged = row('1', { memberIds: ['1', '2'], included: true });
    const rebuilt = [row('1'), row('2'), row('3')];
    expect(restoreMergedRows(rebuilt, [merged]).map(r => (r as { id: string }).id)).toEqual(['1', '3']);
    expect(restoreMergedRows(rebuilt, [merged])[0]).toBe(merged);
  });

  it('leaves the originals when a member is no longer on the page', () => {
    const merged = row('1', { memberIds: ['1', '2'] });
    const rebuilt = [row('1'), row('3')];
    expect(restoreMergedRows(rebuilt, [merged])).toEqual(rebuilt);
  });
});

describe('add outcomes in the import summaries (finding folding, U5)', () => {
  it('the done summary counts rows added to existing tickets only when there are some', () => {
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), created: 2 })).not.toContain('added');
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), created: 2, added: 3 })).toContain('3 added to existing tickets');
  });

  it('a failed add counts in the failure total', () => {
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), addFailed: 2 })).toContain('2 failed');
  });
});

describe('rewrite as a ticketed action (finding folding, U6)', () => {
  const row = (id: string, key: string, action: TicketedAction, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({
    id, existingTicketKey: key, included: false, target: { key, status: 'Open', resolved: false }, action,
    allowedActions: ['update', 'rewrite', 're-create', 'leave'], ...extra,
  });

  it('parses "<row> rewrite" and "all rewrite" on the Already-ticketed screen', () => {
    const ctx: ImportReplyContext = { singleGroup: false, groups: ['ticketed'], newRowIds: [], ticketedRows: [{ id: 'A1', allowedActions: ['update', 'rewrite', 'leave'] }] };
    expect(parseTicketedGroupReply('A1 rewrite', ctx)).toEqual({ kind: 'setAction', id: 'A1', action: 'rewrite' });
    expect(parseTicketedGroupReply('all rewrite', ctx)).toEqual({ kind: 'setAllActions', action: 'rewrite' });
  });

  it('findPartialRewrites reports a target whose unfinished rows are only partly on rewrite', () => {
    const rows = [row('A1', 'PROJ-1', 'rewrite'), row('A2', 'PROJ-1', 'leave'), row('A3', 'PROJ-1', 'rewrite'), row('A4', 'PROJ-2', 'update')];
    expect(findPartialRewrites(rows)).toEqual([{ key: 'PROJ-1', rewriteIds: ['A1', 'A3'], otherIds: ['A2'] }]);
  });

  it('is empty when every unfinished row of a target is on rewrite, or none is', () => {
    expect(findPartialRewrites([row('A1', 'PROJ-1', 'rewrite'), row('A2', 'PROJ-1', 'rewrite'), row('A3', 'PROJ-2', 'leave')])).toEqual([]);
  });

  it('ignores a finished row of the target', () => {
    const done = row('A2', 'PROJ-1', 'update', { result: { status: 'done', action: 'update' } });
    expect(findPartialRewrites([row('A1', 'PROJ-1', 'rewrite'), done])).toEqual([]);
  });

  it('shows a rewrite result in the Action cell wording', () => {
    expect(formatTicketedRowResult({ status: 'done', action: 'rewrite' })).toBe('rewritten');
    expect(formatTicketedRowResult({ status: 'done', action: 'rewrite', note: 'comment-failed' })).toContain('comment failed');
  });
});
