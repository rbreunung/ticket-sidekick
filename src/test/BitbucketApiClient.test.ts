import { describe, it, expect, vi, afterEach } from 'vitest';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';

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
