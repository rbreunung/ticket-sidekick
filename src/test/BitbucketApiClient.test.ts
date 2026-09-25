import { describe, it, expect, vi, afterEach } from 'vitest';
import { BitbucketApiClient, BitbucketApiError, summarizeDcDiffShape } from '../bitbucket/BitbucketApiClient';

function errorFetch(status: number): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: status === 404 ? 'Not Found' : 'Error',
    headers: { get: () => 'application/json' },
    text: () => Promise.resolve(''),
  });
}

describe('BitbucketApiError typing (#9)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a BitbucketApiError carrying the numeric status (DC 404)', async () => {
    vi.stubGlobal('fetch', errorFetch(404));
    const client = new BitbucketApiClient({ baseUrl: 'https://bb.example.com', authType: 'datacenter', token: 'pat' });
    const err = await client.getPullRequest('PROJ', 'repo', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BitbucketApiError);
    expect((err as BitbucketApiError).status).toBe(404);
  });

  it('throws a BitbucketApiError with status 429 for rate limiting (Cloud)', async () => {
    vi.stubGlobal('fetch', errorFetch(429));
    const client = new BitbucketApiClient({ baseUrl: '', authType: 'cloud', token: 'basic' });
    const err = await client.getPullRequest('ws', 'repo', 1).catch((e: unknown) => e);
    expect((err as BitbucketApiError).status).toBe(429);
  });
});

const DC_CONFIG = {
  baseUrl: 'https://bitbucket.example.com',
  authType: 'datacenter' as const,
  token: 'pat',
};
const CLOUD_CONFIG = {
  baseUrl: '',
  authType: 'cloud' as const,
  token: 'basic',
};

describe('getCurrentUser onDiag logging (Cloud, missing scope)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs a warn and degrades gracefully when the Cloud token lacks Account: Read scope', async () => {
    vi.stubGlobal('fetch', errorFetch(403));
    const onDiag = vi.fn();
    const client = new BitbucketApiClient({ ...CLOUD_CONFIG, onDiag });
    const user = await client.getCurrentUser();
    expect(user.displayName).toContain('Account: Read scope');
    expect(onDiag).toHaveBeenCalledWith(
      'warn', expect.stringContaining('scope'),
      expect.objectContaining({ error: expect.stringContaining('403') }),
    );
  });
});

function jsonFetch(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function textFetch(text: string): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'text/plain' },
    text: () => Promise.resolve(text),
  });
}

describe('BitbucketApiClient.getFileContent — URL encoding (#4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('encodes path segments and commit hash for Data Center, preserving separators', async () => {
    const f = jsonFetch({ lines: [{ text: 'line1' }, { text: 'line2' }] });
    vi.stubGlobal('fetch', f);
    const client = new BitbucketApiClient(DC_CONFIG);
    const content = await client.getFileContent('PROJ', 'repo', 'src/my dir/a file.ts', 'feature/x');
    expect(content).toBe('line1\nline2');
    const [url] = f.mock.calls[0] as [string];
    expect(url).toContain('/browse/src/my%20dir/a%20file.ts?');
    expect(url).not.toMatch(/browse\/src\/my dir/); // no raw space
    expect(url).toContain('at=feature%2Fx');
  });

  it('encodes path segments and commit hash for Cloud, preserving separators', async () => {
    const f = textFetch('file body');
    vi.stubGlobal('fetch', f);
    const client = new BitbucketApiClient(CLOUD_CONFIG);
    const content = await client.getFileContent('ws', 'repo', 'src/my dir/a file.ts', 'abc123');
    expect(content).toBe('file body');
    const [url] = f.mock.calls[0] as [string];
    expect(url).toContain('/src/abc123/src/my%20dir/a%20file.ts');
    expect(url).not.toContain('a file.ts'); // no raw space
  });
});

/** Routes each request URL to the first matching body; unmatched URLs fail the test loudly. */
function routeFetch(routes: Array<[RegExp, unknown]>): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (url: string) => {
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`unexpected request: ${url}`);
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      json: () => Promise.resolve(route[1]),
      text: () => Promise.resolve(JSON.stringify(route[1])),
    };
  });
}

const dcFile = (path: string, extra: Record<string, unknown> = {}) => ({
  source: { toString: path }, destination: { toString: path },
  hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 1, destinationSpan: 2, segments: [
    { type: 'CONTEXT', lines: [{ line: 'secret code line one' }] },
    { type: 'ADDED', lines: [{ line: 'secret code line two' }] },
  ] }],
  ...extra,
});
const paths = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `src/f${from + i}.ts`);

describe('Data Center diff coverage and recovery (U9, R17, R25)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // AE9: a truncated response omits the files after the cut; the changes list names them.
  it('reports the files a truncated diff omitted, using the paged changes list', async () => {
    const f = routeFetch([
      [/\/changes\?.*start=0/, { values: paths(1, 30).map((p) => ({ path: { toString: p }, type: 'MODIFY' })), isLastPage: false, nextPageStart: 30 }],
      [/\/changes\?.*start=30/, { values: paths(31, 55).map((p) => ({ path: { toString: p }, type: 'MODIFY' })), isLastPage: true }],
      [/\/pull-requests\/42\/diff\?/, { diffs: paths(1, 40).map((p) => dcFile(p)), truncated: true }],
    ]);
    vi.stubGlobal('fetch', f);
    const client = new BitbucketApiClient(DC_CONFIG);
    const coverage = await client.getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.truncated).toBe(true);
    expect(coverage.cutFiles.map((c) => c.path)).toEqual(paths(41, 55));
    expect(coverage.raw).toContain('diff --git a/src/f40.ts b/src/f40.ts');
  });

  it('reports a file whose own entry is marked truncated', async () => {
    vi.stubGlobal('fetch', routeFetch([
      [/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts'), dcFile('src/b.ts', { truncated: true })] }],
    ]));
    const coverage = await new BitbucketApiClient(DC_CONFIG).getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.cutFiles).toEqual([{ path: 'src/b.ts' }]);
  });

  it('makes no changes-list call for a complete diff', async () => {
    const f = routeFetch([[/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts')] }]]);
    vi.stubGlobal('fetch', f);
    const coverage = await new BitbucketApiClient(DC_CONFIG).getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.cutFiles).toEqual([]);
    expect(coverage.truncated).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('carries the source path of a renamed file into the cut list and the per-file request', async () => {
    const f = routeFetch([
      [/\/changes\?/, { values: [
        { path: { toString: 'src/a.ts' }, type: 'MODIFY' },
        { path: { toString: 'src/new name.ts' }, srcPath: { toString: 'src/old.ts' }, type: 'MOVE' },
      ], isLastPage: true }],
      [/\/pull-requests\/42\/diff\/src\/new%20name\.ts\?/, { diffs: [dcFile('src/new name.ts', { truncated: true })] }],
      [/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts')], truncated: true }],
    ]);
    vi.stubGlobal('fetch', f);
    const client = new BitbucketApiClient(DC_CONFIG);
    const coverage = await client.getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.cutFiles).toEqual([{ path: 'src/new name.ts', srcPath: 'src/old.ts' }]);

    const fileDiff = await client.getPullRequestFileDiff('PROJ', 'repo', 42, 'src/new name.ts', 12, 'src/old.ts');
    const [url] = f.mock.calls.at(-1) as [string];
    expect(url).toContain('/pull-requests/42/diff/src/new%20name.ts?');
    expect(url).toContain('contextLines=12');
    expect(url).toContain('srcPath=src%2Fold.ts');
    expect(fileDiff.truncated).toBe(true);
    expect(fileDiff.raw).toContain('+++ b/src/new name.ts');
  });

  it('reports a file whose only truncated flag is at hunk/segment level', async () => {
    const hunkTruncated = {
      source: { toString: 'src/c.ts' }, destination: { toString: 'src/c.ts' },
      hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 1, destinationSpan: 2, truncated: true, segments: [
        { type: 'CONTEXT', lines: [{ line: 'x' }] },
      ] }],
    };
    const segmentTruncated = {
      source: { toString: 'src/d.ts' }, destination: { toString: 'src/d.ts' },
      hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 1, destinationSpan: 2, segments: [
        { type: 'CONTEXT', lines: [{ line: 'x' }], truncated: true },
      ] }],
    };
    vi.stubGlobal('fetch', routeFetch([
      [/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts'), hunkTruncated, segmentTruncated] }],
    ]));
    const coverage = await new BitbucketApiClient(DC_CONFIG).getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.cutFiles).toEqual([{ path: 'src/c.ts' }, { path: 'src/d.ts' }]);
  });

  it('carries srcPath for a file-level-truncated rename, without a changes-list call', async () => {
    const renamedTruncated = {
      source: { toString: 'src/old.ts' }, destination: { toString: 'src/new.ts' }, truncated: true,
    };
    const f = routeFetch([
      [/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts'), renamedTruncated] }],
    ]);
    vi.stubGlobal('fetch', f);
    const coverage = await new BitbucketApiClient(DC_CONFIG).getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.cutFiles).toEqual([{ path: 'src/new.ts', srcPath: 'src/old.ts' }]);
    expect(f).toHaveBeenCalledTimes(1); // response.truncated is not set, so no changes-list fallback
  });

  it('keeps the file-level cutFiles and truncated:true when the changes-list request fails', async () => {
    const onDiag = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (/\/changes\?/.test(url)) {
        return { ok: false, status: 500, statusText: 'Error', headers: { get: () => 'application/json' }, text: () => Promise.resolve('') };
      }
      if (/\/pull-requests\/42\/diff\?/.test(url)) {
        const body = { diffs: [dcFile('src/a.ts'), dcFile('src/b.ts', { truncated: true })], truncated: true };
        return {
          ok: true, status: 200,
          headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        };
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const client = new BitbucketApiClient({ ...DC_CONFIG, onDiag });
    const coverage = await client.getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    expect(coverage.truncated).toBe(true);
    expect(coverage.cutFiles).toEqual([{ path: 'src/b.ts' }]);
    expect(onDiag).toHaveBeenCalledWith(
      'warn', expect.stringContaining('PR changes list'),
      expect.objectContaining({ status: 500 }),
    );
  });

  it('reports no cut files and makes one request on Cloud', async () => {
    const f = textFetch('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+y\n');
    vi.stubGlobal('fetch', f);
    const coverage = await new BitbucketApiClient(CLOUD_CONFIG).getPullRequestDiffWithCoverage('ws', 'repo', 42, 12);
    expect(coverage).toMatchObject({ truncated: false, cutFiles: [] });
    expect(coverage.raw).toContain('+++ b/x.ts');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('fails with the response keys when a Data Center diff has no diffs array', async () => {
    vi.stubGlobal('fetch', routeFetch([[/\/pull-requests\/42\/diff\?/, { errors: [{ message: 'x' }], size: 0 }]]));
    await expect(new BitbucketApiClient(DC_CONFIG).getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12))
      .rejects.toThrow(/errors, size/);
  });

  // R25: every Data Center diff, changes and per-file response logs a content-free shape summary.
  it('logs a shape summary for each Data Center response it reads', async () => {
    const onDiag = vi.fn();
    vi.stubGlobal('fetch', routeFetch([
      [/\/changes\?/, { values: [{ path: { toString: 'src/a.ts' } }, { path: { toString: 'src/b.ts' } }], isLastPage: true }],
      [/\/pull-requests\/42\/diff\/src\/b\.ts\?/, { diffs: [dcFile('src/b.ts')] }],
      [/\/pull-requests\/42\/diff\?/, { diffs: [dcFile('src/a.ts')], truncated: true }],
    ]));
    const client = new BitbucketApiClient({ ...DC_CONFIG, onDiag });
    await client.getPullRequestDiffWithCoverage('PROJ', 'repo', 42, 12);
    await client.getPullRequestFileDiff('PROJ', 'repo', 42, 'src/b.ts', 12);
    const messages = onDiag.mock.calls.map((c) => c[1] as string);
    expect(messages.filter((m) => m.startsWith('Data Center response shape'))).toHaveLength(3);
    const logged = JSON.stringify(onDiag.mock.calls);
    expect(logged).not.toContain('secret code line');
  });
});

describe('summarizeDcDiffShape (R25)', () => {
  it('names every truncated flag with its level and counts files, hunks and segments without line text', () => {
    const summary = summarizeDcDiffShape({
      diffs: [
        dcFile('src/a.ts', { truncated: true }),
        { source: { toString: 'src/gone.ts' }, destination: null, hunks: [{ segments: [{ type: 'REMOVED', truncated: true, lines: [{ line: 'x', truncated: true }] }] }] },
      ],
      truncated: true,
      contextLines: 12,
    });
    expect(summary).toContain('keys=[diffs,truncated,contextLines]');
    expect(summary).toContain('truncated: response');
    expect(summary).toContain('files=1');
    expect(summary).toContain('segments=1');
    expect(summary).toContain('lines=1');
    expect(summary).toContain('files=2 hunks=2 segments=3');
    expect(summary).toContain('src+dst=1 src-only=1 dst-only=0');
    expect(summary).not.toContain('secret code line');
  });

  it('lists the actual keys instead of throwing when the diffs array is missing', () => {
    const summary = summarizeDcDiffShape({ errors: [], weird: true });
    expect(summary).toContain('keys=[errors,weird]');
    expect(summary).toContain('no diffs array');
  });

  it('describes a non-object response', () => {
    expect(summarizeDcDiffShape('oops')).toContain('not an object');
  });
});
