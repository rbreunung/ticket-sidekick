import { describe, it, expect } from 'vitest';
import {
  parsePrUrl, parseDiff, resolveByNumber, extractJsonObject, extractPartialFindings, parseNdjsonFindings,
  resolveByNumbers, isAddToReviewIntent, extractUserNote, langFromPath, buildAdaptiveChunks,
  resolveLineType, annotateWithLineTypes, hasPrUrl,
} from '../participant/reviewSessionState';
import type { ReviewFinding } from '../participant/reviewSessionState';
import { PrReviewService } from '../services/PrReviewService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import { dcDiffToUnified } from '../bitbucket/BitbucketApiClient';

describe('parsePrUrl', () => {
  it('parses a Data Center URL with trailing /overview', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42/overview',
    );
    expect(result).toEqual({ project: 'PROJ', repo: 'myrepo', prId: 42 });
  });

  it('parses a Data Center URL without trailing segment', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/7',
    );
    expect(result).toEqual({ project: 'PROJ', repo: 'myrepo', prId: 7 });
  });

  it('parses a Bitbucket Cloud URL', () => {
    const result = parsePrUrl(
      'https://bitbucket.org/myworkspace/myrepo/pull-requests/99/diff',
    );
    expect(result).toEqual({ project: 'myworkspace', repo: 'myrepo', prId: 99 });
  });

  it('returns null for an unrecognised URL', () => {
    expect(parsePrUrl('https://github.com/user/repo/pull/1')).toBeNull();
  });
});

describe('hasPrUrl', () => {
  it('returns true for a Data Center PR URL in a plain prompt', () => {
    expect(hasPrUrl('https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42')).toBe(true);
  });
  it('returns true for a Cloud PR URL embedded in surrounding text', () => {
    expect(hasPrUrl('please review https://bitbucket.org/workspace/repo/pull-requests/7 thanks')).toBe(true);
  });
  it('returns false for a follow-up question with no URL', () => {
    expect(hasPrUrl('can you explain finding #2?')).toBe(false);
  });
  it('returns false for a non-PR URL', () => {
    expect(hasPrUrl('https://bitbucket.company.com/projects/PROJ/repos/myrepo/browse')).toBe(false);
  });
  it('returns false for an empty string', () => {
    expect(hasPrUrl('')).toBe(false);
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

describe('extractJsonObject', () => {
  it('extracts a plain JSON object', () => {
    const json = '{"findings":[],"additionalFilesNeeded":[]}';
    expect(extractJsonObject(json)).toBe(json);
  });

  it('extracts JSON preceded by preamble text', () => {
    const raw = 'Here is my review:\n{"findings":[],"additionalFilesNeeded":[]}';
    expect(extractJsonObject(raw)).toBe('{"findings":[],"additionalFilesNeeded":[]}');
  });

  it('extracts JSON from a markdown ```json code fence', () => {
    const raw = '```json\n{"findings":[],"additionalFilesNeeded":[]}\n```';
    expect(extractJsonObject(raw)).toBe('{"findings":[],"additionalFilesNeeded":[]}');
  });

  it('extracts JSON from a plain ``` code fence', () => {
    const raw = '```\n{"findings":[]}\n```';
    expect(extractJsonObject(raw)).toBe('{"findings":[]}');
  });

  it('stops at the matching } and ignores trailing text with braces', () => {
    const raw = '{"findings":[],"additionalFilesNeeded":[]}\nNote: see {details} here.';
    expect(extractJsonObject(raw)).toBe('{"findings":[],"additionalFilesNeeded":[]}');
  });

  it('returns null when no { is present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
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
  const pr: BitbucketPR = {
    id: 42, title: 'My PR', description: 'A description',
    author: { displayName: 'Jane', emailAddress: 'j@example.com' },
    targetBranch: 'main', fromCommitHash: 'abc123',
  };
  const fileDiffs = [{ path: 'src/foo.ts', diff: '@@ -1 +1 @@\n+const x = 1;' }];

  it('includes file path and diff without full content when fileContents omitted', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);

    const prompt = service.buildPrompt(pr, fileDiffs);

    expect(prompt).toContain('src/foo.ts');
    expect(prompt).toContain('@@ -1 +1 @@');
    expect(prompt).toContain('additionalFilesNeeded');
    expect(prompt).not.toContain('Full content');
  });

  it('includes full content for files present in the fileContents map', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const contents = new Map([['src/foo.ts', 'const x = 1;\n']]);

    const prompt = service.buildPrompt(pr, fileDiffs, contents);

    expect(prompt).toContain('Full content');
    expect(prompt).toContain('const x = 1;');
  });

  it('omits full content for files not in the fileContents map', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const contents = new Map([['src/other.ts', 'unrelated']]);

    const prompt = service.buildPrompt(pr, fileDiffs, contents);

    expect(prompt).toContain('src/foo.ts');
    expect(prompt).not.toContain('Full content');
  });

  it('includes grounding rules in every prompt', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);

    const prompt = service.buildPrompt(pr, fileDiffs);

    expect(prompt).toContain('GROUNDING RULES');
    expect(prompt).toContain('diff --git');
    expect(prompt).toContain('JSON fixtures');
  });

  it('appends additional instructions when provided', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);

    const prompt = service.buildPrompt(pr, fileDiffs, undefined, 'Focus on security only.');

    expect(prompt).toContain('ADDITIONAL INSTRUCTIONS');
    expect(prompt).toContain('Focus on security only.');
  });

  it('does not add an additional instructions block when omitted', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);

    const prompt = service.buildPrompt(pr, fileDiffs);

    expect(prompt).not.toContain('ADDITIONAL INSTRUCTIONS');
  });

  it('includes a re-evaluation note when fileContents is provided (Pass 2)', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const contents = new Map([['src/foo.ts', 'const x = 1;\n']]);

    const prompt = service.buildPrompt(pr, fileDiffs, contents);

    expect(prompt).toContain('second-pass review');
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

describe('dcDiffToUnified', () => {
  it('converts a modified file to unified diff format parseable by parseDiff', () => {
    const response = {
      diffs: [{
        source: { toString: 'src/auth/login.ts' },
        destination: { toString: 'src/auth/login.ts' },
        hunks: [{
          sourceLine: 10, sourceSpan: 2,
          destinationLine: 10, destinationSpan: 3,
          segments: [
            { type: 'CONTEXT' as const, lines: [{ line: 'const x = 1;' }] },
            { type: 'ADDED' as const,   lines: [{ line: 'const y = 2;' }] },
            { type: 'REMOVED' as const, lines: [{ line: 'const z = 3;' }] },
          ],
        }],
      }],
    };

    const unified = dcDiffToUnified(response);
    expect(unified).toContain('diff --git a/src/auth/login.ts b/src/auth/login.ts');
    expect(unified).toContain('+++ b/src/auth/login.ts');
    expect(unified).toContain('@@ -10,2 +10,3 @@');
    expect(unified).toContain('+const y = 2;');
    expect(unified).toContain('-const z = 3;');
    expect(unified).toContain(' const x = 1;');

    const parsed = parseDiff(unified);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/auth/login.ts');
  });

  it('handles a new file (source is null)', () => {
    const response = {
      diffs: [{
        source: null,
        destination: { toString: 'src/new-file.ts' },
        hunks: [{
          sourceLine: 0, sourceSpan: 0,
          destinationLine: 1, destinationSpan: 1,
          segments: [{ type: 'ADDED' as const, lines: [{ line: 'export const x = 1;' }] }],
        }],
      }],
    };

    const unified = dcDiffToUnified(response);
    expect(unified).toContain('+++ b/src/new-file.ts');
    expect(unified).toContain('+export const x = 1;');

    const parsed = parseDiff(unified);
    expect(parsed[0].path).toBe('src/new-file.ts');
  });

  it('produces an empty string for an empty diff response', () => {
    expect(dcDiffToUnified({ diffs: [] })).toBe('');
  });

  it('does not throw when a file entry has no hunks (binary or mode-only change)', () => {
    const response = {
      diffs: [{
        source: { toString: 'assets/logo.png' },
        destination: { toString: 'assets/logo.png' },
        hunks: undefined,
      }],
    };
    const unified = dcDiffToUnified(response as any);
    expect(unified).toContain('diff --git a/assets/logo.png b/assets/logo.png');
    expect(unified).not.toContain('@@');
  });

  it('excludes deleted files from parseDiff results', () => {
    const response = {
      diffs: [{
        source: { toString: 'src/old.ts' },
        destination: null,
        hunks: [{ sourceLine: 1, sourceSpan: 2, destinationLine: 0, destinationSpan: 0,
          segments: [{ type: 'REMOVED' as const, lines: [{ line: 'const x = 1;' }] }] }],
      }],
    };
    const unified = dcDiffToUnified(response);
    const parsed = parseDiff(unified);
    expect(parsed).toHaveLength(0);
  });

  it('includes only modified/added files when mixed with deleted files', () => {
    const response = {
      diffs: [
        {
          source: { toString: 'src/changed.ts' },
          destination: { toString: 'src/changed.ts' },
          hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 1, destinationSpan: 2,
            segments: [
              { type: 'CONTEXT' as const, lines: [{ line: 'const x = 1;' }] },
              { type: 'ADDED' as const, lines: [{ line: 'const y = 2;' }] },
            ],
          }],
        },
        {
          source: { toString: 'src/deleted.ts' },
          destination: null,
          hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 0, destinationSpan: 0,
            segments: [{ type: 'REMOVED' as const, lines: [{ line: 'const z = 3;' }] }],
          }],
        },
      ],
    };
    const unified = dcDiffToUnified(response);
    const parsed = parseDiff(unified);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/changed.ts');
  });

  it('works correctly when response comes from JSON.parse (real API scenario)', () => {
    const apiPayload = JSON.stringify({
      diffs: [{
        source: { toString: 'src/auth/login.ts', components: ['src', 'auth', 'login.ts'], name: 'login.ts' },
        destination: { toString: 'src/auth/login.ts', components: ['src', 'auth', 'login.ts'], name: 'login.ts' },
        hunks: [{
          sourceLine: 1, sourceSpan: 1, destinationLine: 1, destinationSpan: 2,
          segments: [{ type: 'ADDED', lines: [{ line: 'const x = 1;' }] }],
        }],
      }],
    });
    const parsed = parseDiff(dcDiffToUnified(JSON.parse(apiPayload)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('src/auth/login.ts');
  });
});

describe('resolveByNumbers', () => {
  const findings: ReviewFinding[] = [
    { id: 1, file: 'a.ts', severity: 'critical', title: 'T1', description: 'D', recommendation: 'R' },
    { id: 2, file: 'b.ts', severity: 'warning',  title: 'T2', description: 'D', recommendation: 'R' },
    { id: 3, file: 'c.ts', severity: 'suggestion', title: 'T3', description: 'D', recommendation: 'R' },
    { id: 5, file: 'd.ts', severity: 'critical', title: 'T5', description: 'D', recommendation: 'R' },
  ];

  it('returns multiple findings by #N references', () => {
    const result = resolveByNumbers('#2 #3, #5 add to review', findings);
    expect(result.map((f) => f.id)).toEqual([2, 3, 5]);
  });

  it('returns a single finding', () => {
    expect(resolveByNumbers('#1 add to review', findings).map((f) => f.id)).toEqual([1]);
  });

  it('deduplicates repeated references', () => {
    expect(resolveByNumbers('#2 #2 add to review', findings)).toHaveLength(1);
  });

  it('returns empty array when no #N references', () => {
    expect(resolveByNumbers('add to review', findings)).toHaveLength(0);
  });

  it('silently skips unknown IDs', () => {
    const result = resolveByNumbers('#1 #99 add to review', findings);
    expect(result.map((f) => f.id)).toEqual([1]);
  });
});

describe('isAddToReviewIntent', () => {
  it('returns true for "#2 #3 add to review"', () => {
    expect(isAddToReviewIntent('#2 #3 add to review')).toBe(true);
  });

  it('returns true for "please add #1 and #4 to review"', () => {
    expect(isAddToReviewIntent('please add #1 and #4 to review')).toBe(true);
  });

  it('returns false when no #N reference', () => {
    expect(isAddToReviewIntent('add to review')).toBe(false);
  });

  it('returns false when "add" is missing', () => {
    expect(isAddToReviewIntent('#2 review')).toBe(false);
  });

  it('returns false for a plain follow-up like "#2 can this be fixed?"', () => {
    expect(isAddToReviewIntent('#2 can this be fixed?')).toBe(false);
  });
});

describe('extractUserNote', () => {
  it('returns empty string for a pure command', () => {
    expect(extractUserNote('#2 #3 add to review')).toBe('');
  });

  it('extracts trailing explanation text', () => {
    const note = extractUserNote('#2 add to review this is blocking CI');
    expect(note).toBe('this is blocking CI');
  });

  it('handles comma-separated refs with no extra text', () => {
    expect(extractUserNote('#2, #3, #5 add to review')).toBe('');
  });

  it('extracts explanation after comma-separated refs', () => {
    const note = extractUserNote('#2, #3 add to review — urgent');
    expect(note).toContain('urgent');
  });
});

describe('langFromPath', () => {
  it.each([
    ['src/app.ts',    'typescript'],
    ['src/comp.tsx',  'typescript'],
    ['src/app.js',    'javascript'],
    ['src/app.jsx',   'javascript'],
    ['app.py',        'python'],
    ['App.java',      'java'],
    ['style.css',     'css'],
    ['config.json',   'json'],
    ['deploy.sh',     'bash'],
    ['data.yaml',     'yaml'],
    ['data.yml',      'yaml'],
    ['query.sql',     'sql'],
    ['unknown.xyz',   ''],
    ['no-extension',  ''],
  ])('%s → %s', (path, lang) => {
    expect(langFromPath(path)).toBe(lang);
  });
});

describe('PrReviewService.formatPrComment', () => {
  const service = new PrReviewService(new MockBitbucketClient());

  const finding: ReviewFinding = {
    id: 1, file: 'src/auth/login.ts', line: 42,
    severity: 'critical', title: 'SQL injection',
    description: 'Direct string concatenation in query.',
    recommendation: 'Use parameterized queries.',
  };

  it('includes severity icon, label, title, file, line, description, recommendation', () => {
    const text = service.formatPrComment(finding);
    expect(text).toContain('🔴');
    expect(text).toContain('[CRITICAL]');
    expect(text).toContain('SQL injection');
    expect(text).toContain('src/auth/login.ts');
    expect(text).toContain('L42');
    expect(text).toContain('Direct string concatenation in query.');
    expect(text).toContain('Use parameterized queries.');
  });

  it('appends user note as italicised paragraph with 📝', () => {
    const text = service.formatPrComment(finding, 'blocks the release');
    expect(text).toContain('📝');
    expect(text).toContain('*blocks the release*');
  });

  it('omits user note section when not provided', () => {
    const text = service.formatPrComment(finding);
    expect(text).not.toContain('📝');
  });

  it('omits line number when finding.line is undefined', () => {
    const f: ReviewFinding = { ...finding, line: undefined };
    expect(service.formatPrComment(f)).not.toContain('L42');
  });

  it('wraps codeExample in a language-tagged code fence', () => {
    const f: ReviewFinding = { ...finding, codeExample: 'db.query(sql, [u]);' };
    const text = service.formatPrComment(f);
    expect(text).toContain('```typescript');
    expect(text).toContain('db.query(sql, [u]);');
    expect(text).toContain('```');
  });

  it('strips LLM-added fences from codeExample before wrapping', () => {
    const f: ReviewFinding = { ...finding, codeExample: '```typescript\nconst x = 1;\n```' };
    const text = service.formatPrComment(f);
    expect(text).not.toMatch(/```typescript\s*```typescript/);
    expect(text).toContain('const x = 1;');
  });

  it('omits code block when codeExample is absent', () => {
    expect(service.formatPrComment(finding)).not.toContain('```');
  });

  it('uses correct language for a Python file', () => {
    const f: ReviewFinding = { ...finding, file: 'app.py', codeExample: 'x = 1' };
    expect(service.formatPrComment(f)).toContain('```python');
  });
});

describe('buildAdaptiveChunks', () => {
  function makeDiff(path: string, diffLength: number): { path: string; diff: string } {
    return { path, diff: 'x'.repeat(diffLength) };
  }

  it('returns empty array for empty input', () => {
    expect(buildAdaptiveChunks([], 10000)).toEqual([]);
  });

  it('packs all files into one chunk when budget is large', () => {
    const diffs = [makeDiff('a.ts', 100), makeDiff('b.ts', 100), makeDiff('c.ts', 100)];
    const chunks = buildAdaptiveChunks(diffs, 100000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('splits into multiple chunks when budget is tight', () => {
    // Each file costs: CHUNK_FILE_OVERHEAD(50) + ceil(400/4)(100) = 150 tokens
    // Fixed overhead per chunk: CHUNK_FIXED_OVERHEAD(1500)
    // Budget 1700: fits 1 file (1500+150=1650 ≤ 1700), not 2 (1500+300=1800 > 1700)
    const diffs = [makeDiff('a.ts', 400), makeDiff('b.ts', 400), makeDiff('c.ts', 400)];
    const chunks = buildAdaptiveChunks(diffs, 1700);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[2]).toHaveLength(1);
  });

  it('always includes at least one file per chunk even when it exceeds budget', () => {
    const diffs = [makeDiff('huge.ts', 400000)];
    const chunks = buildAdaptiveChunks(diffs, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].path).toBe('huge.ts');
  });

  it('packs multiple files until budget is hit, then starts new chunk', () => {
    const diffs = Array.from({ length: 4 }, (_, i) => makeDiff(`f${i}.ts`, 400));
    const chunks = buildAdaptiveChunks(diffs, 1700);
    expect(chunks).toHaveLength(4);
    expect(chunks.flatMap(c => c)).toHaveLength(4);
  });
});

describe('extractPartialFindings', () => {
  const finding1 = { file: 'src/a.ts', severity: 'warning', title: 'Issue A', description: 'desc a', recommendation: 'rec a' };
  const finding2 = { file: 'src/b.ts', severity: 'critical', title: 'Issue B', description: 'desc b', recommendation: 'rec b' };

  it('returns all findings from a complete response', () => {
    const raw = JSON.stringify({ findings: [finding1, finding2], additionalFilesNeeded: [] });
    const result = extractPartialFindings(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject(finding1);
    expect(result[1]).toMatchObject(finding2);
  });

  it('returns only complete findings when response is truncated mid-last-finding', () => {
    const complete = JSON.stringify(finding1);
    const truncated = JSON.stringify(finding2).slice(0, 30);
    const raw = `{"findings":[${complete},${truncated}`;
    const result = extractPartialFindings(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(finding1);
  });

  it('returns empty array when truncated before any complete finding', () => {
    const raw = '{"findings":[{"file":"src/a.ts","severity":"war';
    expect(extractPartialFindings(raw)).toEqual([]);
  });

  it('returns empty array when no findings key present', () => {
    expect(extractPartialFindings('{"additionalFilesNeeded":[]}')).toEqual([]);
  });

  it('returns empty array for empty findings array', () => {
    expect(extractPartialFindings('{"findings":[]}')).toEqual([]);
  });
});

describe('parseNdjsonFindings', () => {
  const f1 = { file: 'src/a.ts', severity: 'critical', title: 'T1', description: 'D1', recommendation: 'R1' };
  const f2 = { file: 'src/b.ts', severity: 'warning', title: 'T2', description: 'D2', recommendation: 'R2' };

  it('parses a complete NDJSON response', () => {
    const raw = [
      JSON.stringify(f1),
      JSON.stringify(f2),
      '{"additionalFilesNeeded":["src/c.ts"]}',
    ].join('\n');
    const result = parseNdjsonFindings(raw);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject(f1);
    expect(result.findings[1]).toMatchObject(f2);
    expect(result.additionalFilesNeeded).toEqual(['src/c.ts']);
    expect(result.hasMetaLine).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('recovers findings when meta line is absent (truncated)', () => {
    const raw = [JSON.stringify(f1), JSON.stringify(f2)].join('\n');
    const result = parseNdjsonFindings(raw);
    expect(result.findings).toHaveLength(2);
    expect(result.hasMetaLine).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('returns empty findings and no truncation for empty raw', () => {
    const result = parseNdjsonFindings('');
    expect(result.findings).toHaveLength(0);
    expect(result.hasMetaLine).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('does not treat old single-object JSON format as a meta line', () => {
    const raw = JSON.stringify({ findings: [f1], additionalFilesNeeded: [] });
    const result = parseNdjsonFindings(raw);
    expect(result.findings).toHaveLength(0);
    expect(result.hasMetaLine).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('ignores incomplete last line without throwing', () => {
    const incomplete = JSON.stringify(f2).slice(0, 20);
    const raw = JSON.stringify(f1) + '\n' + incomplete + '\n{"additionalFilesNeeded":[]}';
    const result = parseNdjsonFindings(raw);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject(f1);
    expect(result.hasMetaLine).toBe(true);
    expect(result.truncated).toBe(false);
  });
});

describe('PrReviewService.postFindingsAsComments', () => {
  const baseFinding = (id: number, file: string, line?: number): ReviewFinding => ({
    id, file, line, severity: 'critical', title: `T${id}`, description: 'D', recommendation: 'R',
  });

  it('posts one comment per finding and returns results', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const findings = [baseFinding(1, 'a.ts', 10), baseFinding(2, 'b.ts')];

    const results = await service.postFindingsAsComments('PROJ', 'myrepo', 42, findings);

    expect(client.addPrCommentCalls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.result !== null)).toBe(true);
    expect(results.every((r) => r.error === undefined)).toBe(true);
  });

  it('passes inline anchor when finding has line and lineType set', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const finding: ReviewFinding = { ...baseFinding(1, 'src/auth.ts', 42), lineType: 'ADDED', fileType: 'TO' };
    await service.postFindingsAsComments('PROJ', 'myrepo', 42, [finding]);

    expect(client.addPrCommentCalls[0].inline).toEqual({ filePath: 'src/auth.ts', line: 42, lineType: 'ADDED', fileType: 'TO' });
  });

  it('omits inline anchor when finding has line but no lineType (line not in diff)', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    await service.postFindingsAsComments('PROJ', 'myrepo', 42, [baseFinding(1, 'src/auth.ts', 42)]);

    expect(client.addPrCommentCalls[0].inline).toBeUndefined();
  });

  it('omits inline anchor when finding.line is absent', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    await service.postFindingsAsComments('PROJ', 'myrepo', 42, [baseFinding(1, 'a.ts')]);

    expect(client.addPrCommentCalls[0].inline).toBeUndefined();
  });

  it('includes user note in comment text', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    await service.postFindingsAsComments('PROJ', 'myrepo', 42, [baseFinding(1, 'a.ts')], 'blocks release');

    expect(client.addPrCommentCalls[0].text).toContain('blocks release');
  });

  it('continues posting after a failure and reports both', async () => {
    const client = new MockBitbucketClient();
    let callCount = 0;
    client.addPrComment = async (p, r, id, text, inline) => {
      client.addPrCommentCalls.push({ project: p, repo: r, prId: id, text, inline });
      callCount++;
      if (callCount === 1) throw new Error('Network error');
      return { commentId: 999 };
    };

    const service = new PrReviewService(client);
    const findings = [baseFinding(1, 'a.ts'), baseFinding(2, 'b.ts')];
    const results = await service.postFindingsAsComments('PROJ', 'myrepo', 42, findings);

    expect(results[0].result).toBeNull();
    expect(results[0].error).toContain('Network error');
    expect(results[1].result?.commentId).toBe(999);
  });

  it('includes code example in posted comment when finding has codeExample', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const f: ReviewFinding = { ...baseFinding(1, 'src/auth.ts', 5), codeExample: 'db.query(sql, [id])' };
    await service.postFindingsAsComments('PROJ', 'myrepo', 42, [f]);

    expect(client.addPrCommentCalls[0].text).toContain('```typescript');
    expect(client.addPrCommentCalls[0].text).toContain('db.query(sql, [id])');
  });
});

describe('PrReviewService.postCommentItems', () => {
  const baseFinding = (id: number, lineType?: 'ADDED' | 'CONTEXT' | 'REMOVED'): ReviewFinding => ({
    id, file: 'src/auth.ts', line: 42, lineType, fileType: lineType ? 'TO' : undefined,
    severity: 'critical', title: `T${id}`, description: 'D', recommendation: 'R',
  });

  it('posts each item with the provided text', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const items = [
      { finding: baseFinding(1, 'ADDED'), text: 'Comment A' },
      { finding: baseFinding(2, 'CONTEXT'), text: 'Comment B' },
    ];
    const results = await service.postCommentItems('PROJ', 'repo', 42, items);
    expect(client.addPrCommentCalls).toHaveLength(2);
    expect(client.addPrCommentCalls[0].text).toBe('Comment A');
    expect(client.addPrCommentCalls[1].text).toBe('Comment B');
    expect(results.every(r => r.result !== null)).toBe(true);
  });

  it('sends inline anchor when finding has lineType', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    await service.postCommentItems('PROJ', 'repo', 42, [{ finding: baseFinding(1, 'ADDED'), text: 'X' }]);
    expect(client.addPrCommentCalls[0].inline).toEqual({
      filePath: 'src/auth.ts', line: 42, lineType: 'ADDED', fileType: 'TO',
    });
  });

  it('omits inline anchor when finding.lineType is undefined', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    await service.postCommentItems('PROJ', 'repo', 42, [{ finding: baseFinding(1, undefined), text: 'X' }]);
    expect(client.addPrCommentCalls[0].inline).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveLineType
// ---------------------------------------------------------------------------

const SAMPLE_DIFF = `diff --git a/src/api.ts b/src/api.ts
index abc..def 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -10,6 +10,7 @@
 function connect() {
-  const url = OLD_URL;
+  const url = NEW_URL;
+  const timeout = 5000;
 return url;
 }
`;

describe('resolveLineType', () => {
  // diff layout (TO-side line numbers):
  //  10 → context  "function connect() {"
  //  11 → ADDED    "  const url = NEW_URL;"   (FROM-side 11 is the REMOVED line)
  //  12 → ADDED    "  const timeout = 5000;"
  //  13 → context  " return url;"
  //  14 → context  " }"

  it('identifies an added line', () => {
    expect(resolveLineType(SAMPLE_DIFF, 11)).toEqual({ lineType: 'ADDED', fileType: 'TO' });
  });

  it('identifies a second added line', () => {
    expect(resolveLineType(SAMPLE_DIFF, 12)).toEqual({ lineType: 'ADDED', fileType: 'TO' });
  });

  it('identifies a context line', () => {
    expect(resolveLineType(SAMPLE_DIFF, 10)).toEqual({ lineType: 'CONTEXT', fileType: 'TO' });
    expect(resolveLineType(SAMPLE_DIFF, 13)).toEqual({ lineType: 'CONTEXT', fileType: 'TO' });
  });

  it('identifies a removed line by its FROM-side line number when no TO-side line has the same number', () => {
    // Two consecutive removed lines: FROM=5 and FROM=6 are removed, TO numbering never reaches 6.
    // This avoids the ambiguity where the context line after a removal inherits the same TO-side number.
    const twoRemovedDiff = `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -5,3 +5,1 @@\n-removed line 1\n-removed line 2\n context\n`;
    expect(resolveLineType(twoRemovedDiff, 6)).toEqual({ lineType: 'REMOVED', fileType: 'FROM' });
  });

  it('prefers TO-side (ADDED) over FROM-side (REMOVED) when both share the same line number', () => {
    // SAMPLE_DIFF has a replace: -OLD_URL +NEW_URL both at position 11.
    // The LLM sees the new file where line 11 is the added line, not the removed one.
    expect(resolveLineType(SAMPLE_DIFF, 11)).toEqual({ lineType: 'ADDED', fileType: 'TO' });
  });

  it('returns null for a line number not present in the diff', () => {
    expect(resolveLineType(SAMPLE_DIFF, 999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// annotateWithLineTypes
// ---------------------------------------------------------------------------

describe('annotateWithLineTypes', () => {
  const diffs = [{ path: 'src/api.ts', diff: SAMPLE_DIFF }];

  it('annotates a finding whose line is an added line', () => {
    const findings = [{ file: 'src/api.ts', line: 11, severity: 'critical' as const, title: 'T', description: 'D', recommendation: 'R' }];
    const result = annotateWithLineTypes(findings, diffs);
    expect(result[0].lineType).toBe('ADDED');
    expect(result[0].fileType).toBe('TO');
  });

  it('annotates a finding whose line is a context line', () => {
    const findings = [{ file: 'src/api.ts', line: 10, severity: 'warning' as const, title: 'T', description: 'D', recommendation: 'R' }];
    const result = annotateWithLineTypes(findings, diffs);
    expect(result[0].lineType).toBe('CONTEXT');
    expect(result[0].fileType).toBe('TO');
  });

  it('leaves findings without a line number unchanged', () => {
    const findings = [{ file: 'src/api.ts', severity: 'suggestion' as const, title: 'T', description: 'D', recommendation: 'R' }];
    const result = annotateWithLineTypes(findings, diffs);
    expect(result[0].lineType).toBeUndefined();
  });

  it('leaves findings whose file is not in the diff unchanged', () => {
    const findings = [{ file: 'src/other.ts', line: 5, severity: 'critical' as const, title: 'T', description: 'D', recommendation: 'R' }];
    const result = annotateWithLineTypes(findings, diffs);
    expect(result[0].lineType).toBeUndefined();
  });

  it('leaves lineType undefined when the line number is not found in the diff', () => {
    const findings = [{ file: 'src/api.ts', line: 999, severity: 'warning' as const, title: 'T', description: 'D', recommendation: 'R' }];
    const result = annotateWithLineTypes(findings, diffs);
    expect(result[0].lineType).toBeUndefined();
  });
});
