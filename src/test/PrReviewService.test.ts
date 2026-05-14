import { describe, it, expect } from 'vitest';
import { parsePrUrl, parseDiff, resolveByNumber } from '../participant/reviewSessionState';
import type { ReviewFinding } from '../participant/reviewSessionState';

describe('parsePrUrl', () => {
  it('parses a Data Center URL with trailing /overview', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42/overview',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ authType: 'datacenter', project: 'PROJ', repo: 'myrepo', prId: 42 });
  });

  it('parses a Data Center URL without trailing segment', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/7',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ authType: 'datacenter', project: 'PROJ', repo: 'myrepo', prId: 7 });
  });

  it('parses a Bitbucket Cloud URL', () => {
    const result = parsePrUrl(
      'https://bitbucket.org/myworkspace/myrepo/pull-requests/99/diff',
      '',
    );
    expect(result).toEqual({ authType: 'cloud', project: 'myworkspace', repo: 'myrepo', prId: 99 });
  });

  it('returns null for an unrecognised URL', () => {
    expect(parsePrUrl('https://github.com/user/repo/pull/1', '')).toBeNull();
  });
});

describe('parseDiff', () => {
  it('splits a two-file diff into FileDiff entries', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1;',
      '+const y = 2;',
      'diff --git a/src/bar.ts b/src/bar.ts',
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -5,3 +5,4 @@',
      ' export {};',
      '+export const z = 3;',
    ].join('\n');

    const result = parseDiff(raw);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('src/foo.ts');
    expect(result[1].path).toBe('src/bar.ts');
    expect(result[0].diff).toContain('+const y = 2;');
  });

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('resolveByNumber', () => {
  const findings: ReviewFinding[] = [
    { id: 1, file: 'a.ts', severity: 'critical', title: 'SQL injection', description: 'Bad', recommendation: 'Fix it' },
    { id: 2, file: 'b.ts', severity: 'warning', title: 'XSS risk', description: 'Also bad', recommendation: 'Also fix' },
  ];

  it('resolves #1 to the first finding', () => {
    expect(resolveByNumber('#1 can this be fixed?', findings)?.id).toBe(1);
  });

  it('resolves a #2 reference', () => {
    expect(resolveByNumber('tell me more about #2', findings)?.id).toBe(2);
  });

  it('returns null when no # reference', () => {
    expect(resolveByNumber('explain the SQL issue', findings)).toBeNull();
  });
});
