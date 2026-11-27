import { describe, it, expect } from 'vitest';
import { compareNatural, isEmptySortValue, sortNatural } from '../utils/naturalCompare';

describe('natural order', () => {
  const order = (values: Array<string | null | undefined>, descending = false) =>
    [...values].sort((a, b) => compareNatural(a, b, descending));

  it('puts "Team 2" before "Team 10" and the empty value last', () => {
    expect(order(['Team 10', 'Team 2', ''])).toEqual(['Team 2', 'Team 10', '']);
  });

  it('turns the order around for descending and still ends with the empty value', () => {
    expect(order(['Team 10', 'Team 2', ''], true)).toEqual(['Team 10', 'Team 2', '']);
  });

  it('treats null, undefined and whitespace as empty', () => {
    expect(order(['b', null, ' ', undefined, 'a'])).toEqual(['a', 'b', null, ' ', undefined]);
    expect(isEmptySortValue('  ')).toBe(true);
    expect(isEmptySortValue('0')).toBe(false);
  });

  it('ignores case', () => {
    expect(compareNatural('alice', 'Alice', false)).toBe(0);
    expect(order(['bob', 'Alice'])).toEqual(['Alice', 'bob']);
  });

  it('keeps the original order of equal values', () => {
    const rows = [{ k: 1, v: 'x' }, { k: 2, v: 'X' }, { k: 3, v: 'x' }];
    expect(sortNatural(rows, r => r.v, false).map(r => r.k)).toEqual([1, 2, 3]);
    expect(sortNatural(rows, r => r.v, true).map(r => r.k)).toEqual([1, 2, 3]);
  });

  it('orders ticket keys by their number', () => {
    expect(order(['PROJ-10', 'PROJ-9', 'PROJ-100'])).toEqual(['PROJ-9', 'PROJ-10', 'PROJ-100']);
  });
});
