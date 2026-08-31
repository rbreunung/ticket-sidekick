import { describe, it, expect } from 'vitest';
import { isSafePathSegment } from '../tools/pathSafety';

describe('isSafePathSegment', () => {
  it('accepts a normal Jira ticket key', () => {
    expect(isSafePathSegment('PROJ-123')).toBe(true);
  });

  it('accepts a normal Bitbucket project/repo slug', () => {
    expect(isSafePathSegment('my-repo_2')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isSafePathSegment('')).toBe(false);
  });

  it('rejects a value containing a forward slash', () => {
    expect(isSafePathSegment('PROJ/123')).toBe(false);
  });

  it('rejects a value containing a backslash', () => {
    expect(isSafePathSegment('PROJ\\123')).toBe(false);
  });

  it('rejects a value containing a parent-directory traversal segment', () => {
    expect(isSafePathSegment('../../rest/api/2/secure')).toBe(false);
    expect(isSafePathSegment('PROJ-123/../../other')).toBe(false);
  });
});
