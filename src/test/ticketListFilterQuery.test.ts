import { describe, expect, it } from 'vitest';
import { filterSearchJql } from '../boards/ticketList/kind';

describe('the search for a saved filter\'s tickets', () => {
  it('names the filter and keeps the sort order of its query', () => {
    expect(filterSearchJql('42', 'project = PROJ ORDER BY priority DESC, key')).toBe('filter = 42 ORDER BY priority DESC, key');
    expect(filterSearchJql('42', 'summary ~ "slow ORDER BY query"')).toBe('filter = 42');
  });

  it('refuses an id that is not a number', () => {
    expect(() => filterSearchJql('42 OR project = X', 'x')).toThrow('is not a saved filter id');
  });
});
