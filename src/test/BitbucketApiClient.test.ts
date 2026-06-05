import { describe, it, expect, vi, afterEach } from 'vitest';
import { BitbucketApiClient, BitbucketApiError } from '../bitbucket/BitbucketApiClient';

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
