import { describe, it, expect } from 'vitest';
import { isSafeFilename, isSafePathSegment } from '../tools/pathSafety';

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

describe('isSafeFilename (code-review fix: isSafePathSegment was too strict for real filenames)', () => {
  it('accepts a normal filename', () => {
    expect(isSafeFilename('error.log')).toBe(true);
  });

  it('accepts a filename containing ".." as a substring, not as a whole segment', () => {
    expect(isSafeFilename('v1..2-notes.txt')).toBe(true);
    expect(isSafeFilename('diff..patch')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isSafeFilename('')).toBe(false);
  });

  it('rejects a value containing a forward slash or backslash', () => {
    expect(isSafeFilename('dir/file.txt')).toBe(false);
    expect(isSafeFilename('dir\\file.txt')).toBe(false);
  });

  it('rejects the literal traversal segments "." and ".."', () => {
    expect(isSafeFilename('.')).toBe(false);
    expect(isSafeFilename('..')).toBe(false);
  });
});
