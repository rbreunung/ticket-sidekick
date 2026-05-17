import { describe, it, expect } from 'vitest';
import { parsePrUrl, parseDiff, resolveByNumber } from '../participant/reviewSessionState';
import type { ReviewFinding } from '../participant/reviewSessionState';
import { PrReviewService } from '../services/PrReviewService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { BitbucketPR } from '../bitbucket/IBitbucketClient';

describe('parsePrUrl', () => {
  it('parses a Data Center URL with trailing /overview', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42/overview',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ project: 'PROJ', repo: 'myrepo', prId: 42 });
  });

  it('parses a Data Center URL without trailing segment', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/7',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ project: 'PROJ', repo: 'myrepo', prId: 7 });
  });

  it('parses a Bitbucket Cloud URL', () => {
    const result = parsePrUrl(
      'https://bitbucket.org/myworkspace/myrepo/pull-requests/99/diff',
      '',
    );
    expect(result).toEqual({ project: 'myworkspace', repo: 'myrepo', prId: 99 });
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

  it('handles a JSON-decoded diff string (Bitbucket Cloud returns JSON-encoded diff)', () => {
    // Cloud wraps the diff in a JSON string; after JSON.parse the newlines are real \n
    const raw = [
      'diff --git a/src/auth/login.ts b/src/auth/login.ts',
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      '@@ -1 +1 @@',
      '+const x = 1;',
      'diff --git a/src/auth/tokenStore.ts b/src/auth/tokenStore.ts',
      '--- a/src/auth/tokenStore.ts',
      '+++ b/src/auth/tokenStore.ts',
      '@@ -15,6 +15,8 @@',
      "+ localStorage.setItem('auth_token', token);",
    ].join('\n');

    const result = parseDiff(raw);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe('src/auth/login.ts');
    expect(result[1].path).toBe('src/auth/tokenStore.ts');
  });

  it('handles \\r-only line endings (Bitbucket Cloud format)', () => {
    const raw = [
      'diff --git a/src/auth/login.ts b/src/auth/login.ts',
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      '@@ -38,7 +38,12 @@',
      "-const user = await db.query('SELECT * FROM users WHERE username = ' + username);",
      '+const user = await db.query(`SELECT * FROM users WHERE username = ${username}`);',
    ].join('\r');

    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/auth/login.ts');
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

describe('PrReviewService.gatherFileContents', () => {
  it('uses workspace reader when it returns content', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const localContent = 'const x = 1;\n';
    const reader = async (_path: string) => localContent;

    const result = await service.gatherFileContents('PROJ', 'myrepo', 'abc123', ['src/foo.ts'], reader);

    expect(result.get('src/foo.ts')).toBe(localContent);
    expect(client.getFileContentCalls).toHaveLength(0);
  });

  it('falls back to API when workspace reader returns null', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const reader = async (_path: string) => null;

    const result = await service.gatherFileContents('PROJ', 'myrepo', 'abc123', ['src/foo.ts'], reader);

    expect(client.getFileContentCalls).toHaveLength(1);
    expect(client.getFileContentCalls[0]).toMatchObject({ path: 'src/foo.ts', commitHash: 'abc123' });
    expect(result.get('src/foo.ts')).toBeDefined();
  });

  it('returns "(file not available)" when API fetch fails for a single file', async () => {
    const client = new MockBitbucketClient();
    client.getFileContent = async () => { throw new Error('404 Not found'); };
    const service = new PrReviewService(client);
    const reader = async (_path: string) => null;

    const result = await service.gatherFileContents('PROJ', 'myrepo', 'abc123', ['src/missing.ts'], reader);

    expect(result.get('src/missing.ts')).toBe('(file not available)');
  });

  it('fetches all files in parallel', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const reader = async (_path: string) => null;
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

    await service.gatherFileContents('PROJ', 'myrepo', 'abc123', paths, reader);

    expect(client.getFileContentCalls).toHaveLength(3);
  });
});

describe('PrReviewService.buildPrompt', () => {
  it('includes file path, diff, and full content sections', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const pr: BitbucketPR = {
      id: 42, title: 'My PR', description: 'A description',
      author: { displayName: 'Jane', emailAddress: 'j@example.com' },
      targetBranch: 'main', fromCommitHash: 'abc123',
    };
    const fileDiffs = [{ path: 'src/foo.ts', diff: '@@ -1 +1 @@\n+const x = 1;' }];
    const contents = new Map([['src/foo.ts', 'const x = 1;\n']]);

    const prompt = service.buildPrompt(pr, fileDiffs, contents);

    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('@@ -1 +1 @@');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).toContain('additionalFilesNeeded');
  });
});

describe('PrReviewService.formatReview', () => {
  it('renders header, severity counts, file sections, and numbered findings', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const pr: BitbucketPR = {
      id: 42, title: 'Add OAuth login flow', description: '',
      author: { displayName: 'Jane Smith', emailAddress: '' },
      targetBranch: 'main', fromCommitHash: 'abc123',
    };
    const findings: ReviewFinding[] = [
      { id: 1, file: 'src/auth/login.ts', line: 42, severity: 'critical',
        title: 'SQL injection', description: 'Bad query', recommendation: 'Use params' },
      { id: 2, file: 'src/auth/login.ts', severity: 'warning',
        title: 'No error handling', description: 'Missing try/catch', recommendation: 'Add try/catch' },
    ];

    const output = service.formatReview(findings, pr, 1);

    expect(output).toContain('## PR #42');
    expect(output).toContain('Jane Smith');
    expect(output).toContain('**#1**');
    expect(output).toContain('**#2**');
    expect(output).toContain('🔴');
    expect(output).toContain('🟡');
    expect(output).toContain('<!-- bitbucket:review-session -->');
  });

  it('renders a no-issues message when findings is empty', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const pr: BitbucketPR = {
      id: 1, title: 'Clean PR', description: '',
      author: { displayName: 'Bob', emailAddress: '' },
      targetBranch: 'main', fromCommitHash: 'def456',
    };

    const output = service.formatReview([], pr, 2);

    expect(output).toContain('_No issues found._');
    expect(output).toContain('<!-- bitbucket:review-session -->');
  });
});
