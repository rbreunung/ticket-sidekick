import { describe, it, expect } from 'vitest';
import { mergeNewRows, unmergeNewRow, restoreMergedRows } from '../imports/rows';
import type { ReviewRowBase } from '../imports/types';

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
