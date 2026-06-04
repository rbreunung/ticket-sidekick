import { describe, it, expect } from 'vitest';
import { tokenStatus } from '../utils/diagUtils';

describe('tokenStatus', () => {
  it('returns present with length for a non-empty token', () => {
    expect(tokenStatus('abc123')).toBe('present (6 chars)');
  });

  it('returns absent for undefined', () => {
    expect(tokenStatus(undefined)).toBe('**absent**');
  });

  it('returns absent for empty string', () => {
    expect(tokenStatus('')).toBe('**absent**');
  });
});
