import { describe, it, expect } from 'vitest';
import { extractTicketId, findJiraKeyInText, isLikelyJiraKey } from '../utils/branchParser';

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

describe('findJiraKeyInText', () => {
  it('finds the ticket key in a PR title', () => {
    expect(findJiraKeyInText('PAY-123: retry captures')).toBe('PAY-123');
  });

  it.each(['Switch to UTF-8 output', 'Use SHA-256 for the digest', 'Patch CVE-2024 handling', 'Follow RFC-7231 status codes'])(
    'does not mistake well-known non-ticket shapes for a key: %s',
    (title) => {
      expect(findJiraKeyInText(title)).toBeUndefined();
      expect(isLikelyJiraKey('UTF-8')).toBe(false);
    },
  );

  it('prefers the real key when a non-ticket shape comes first', () => {
    expect(findJiraKeyInText('UTF-8 handling for PAY-7')).toBe('PAY-7');
  });

  it('ignores a key glued to other letters or digits', () => {
    expect(findJiraKeyInText('aPAY-7 xPAY-8-1')).toBeUndefined();
  });
});
