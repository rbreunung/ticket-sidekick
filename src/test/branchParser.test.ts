import { describe, it, expect } from 'vitest';
import { extractTicketId } from '../utils/branchParser';

describe('extractTicketId', () => {
  it('extracts ticket ID from standard feature branch', () => {
    expect(extractTicketId('feature/PROJ-123-add-login')).toBe('PROJ-123');
  });

  it('extracts ticket ID from branch with no prefix', () => {
    expect(extractTicketId('PROJ-456-fix-bug')).toBe('PROJ-456');
  });

  it('extracts ticket ID with multi-char project key', () => {
    expect(extractTicketId('bugfix/MYPROJECT-99-some-fix')).toBe('MYPROJECT-99');
  });

  it('returns null for main branch', () => {
    expect(extractTicketId('main')).toBeNull();
  });

  it('returns null for develop branch', () => {
    expect(extractTicketId('develop')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractTicketId('')).toBeNull();
  });

  it('extracts first ticket ID when multiple are present', () => {
    expect(extractTicketId('PROJ-123-relates-to-PROJ-456')).toBe('PROJ-123');
  });

  it('returns null when project key is lowercase', () => {
    expect(extractTicketId('feature/proj-123-fix')).toBeNull();
  });
});
