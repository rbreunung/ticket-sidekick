import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAllowedUploadPath, isSafeFilename, isSafePathSegment } from '../tools/pathSafety';

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

describe('isAllowedUploadPath (security fix: code-review P0/P1)', () => {
  const testRoot = fs.mkdtempSync(path.join(os.homedir(), 'ticket-sidekick-test-'));
  const plainFile = path.join(testRoot, 'report.pdf');
  fs.writeFileSync(plainFile, 'stub');
  const dotDir = path.join(testRoot, '.ssh');
  fs.mkdirSync(dotDir);
  const dotDirFile = path.join(dotDir, 'id_rsa');
  fs.writeFileSync(dotDirFile, 'stub');
  const dotFile = path.join(testRoot, '.env');
  fs.writeFileSync(dotFile, 'stub');
  const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-sidekick-outside-'));
  const outsideFile = path.join(outsideHome, 'evil.txt');
  fs.writeFileSync(outsideFile, 'stub');

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(outsideHome, { recursive: true, force: true });
  });

  it('accepts a plain file directly under the home directory', () => {
    expect(isAllowedUploadPath(plainFile)).toBe(true);
  });

  it('rejects a file inside a dotdir under the home directory (e.g. ~/.ssh/id_rsa)', () => {
    expect(isAllowedUploadPath(dotDirFile)).toBe(false);
  });

  it('rejects a dotfile directly under the home directory (e.g. ~/.env)', () => {
    expect(isAllowedUploadPath(dotFile)).toBe(false);
  });

  it('rejects a path outside the home directory entirely', () => {
    expect(isAllowedUploadPath(outsideFile)).toBe(false);
  });

  it('rejects a traversal path that resolves outside the home directory', () => {
    expect(isAllowedUploadPath(path.join(testRoot, '..', '..', 'etc', 'passwd'))).toBe(false);
  });

  it('rejects the home directory itself', () => {
    expect(isAllowedUploadPath(os.homedir())).toBe(false);
  });
});
