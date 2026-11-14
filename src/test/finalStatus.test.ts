import { describe, it, expect } from 'vitest';
import { isFinalStatus } from '../utils/finalStatus';

// Whether a move closes a ticket: Jira's Done category when the workflow cache has it, else the usual names.

describe('which statuses are final', () => {
  it('follows Jira\'s Done category when it is known, also for an unusual name', () => {
    expect(isFinalStatus('Shipped', ['Shipped', 'Rejected'])).toBe(true);
    expect(isFinalStatus('done', ['Shipped'])).toBe(false);
  });

  it('falls back to the usual names when the categories are not known', () => {
    for (const name of ['Done', 'Closed', 'Resolved', "Won't Fix", 'Rejected', 'Cancelled']) expect(isFinalStatus(name)).toBe(true);
    expect(isFinalStatus('Verification')).toBe(false);
    expect(isFinalStatus('Shipped', [])).toBe(false);
  });
});
