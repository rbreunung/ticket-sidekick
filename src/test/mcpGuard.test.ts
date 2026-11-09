import { describe, it, expect } from 'vitest';
import { generateKey, keysMatch } from '../mcp/keys';
import { checkRequest, maskPath, type GuardExpectation } from '../mcp/requestGuard';
import { loopbackBypassConfigured } from '../mcp/proxyBypass';

const PORT = 43123;
const expectation: GuardExpectation = { port: PORT, mcpKey: generateKey() };
const host = `127.0.0.1:${PORT}`;
const ownOrigin = `http://127.0.0.1:${PORT}`;

function request(path: string, headers: Record<string, string | undefined>) {
  return checkRequest({ method: 'POST', path, headers }, expectation);
}

function mcp(headers: Record<string, string | undefined>) {
  return request('/mcp', headers);
}

describe('generateKey / keysMatch', () => {
  it('generates distinct keys of 32 random bytes', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
  });

  it('matches only the identical key', () => {
    const key = generateKey();
    expect(keysMatch(key, key)).toBe(true);
    expect(keysMatch(generateKey(), key)).toBe(false);
  });

  it('refuses a key of a different length without throwing', () => {
    expect(keysMatch('short', generateKey())).toBe(false);
    expect(keysMatch(undefined, generateKey())).toBe(false);
  });
});

describe('checkRequest', () => {
  it('refuses a request without an Authorization header with 401', () => {
    expect(mcp({ host })).toMatchObject({ allowed: false, status: 401 });
  });

  it('refuses a wrong bearer key of the same length with 401', () => {
    expect(mcp({ host, authorization: `Bearer ${generateKey()}` })).toMatchObject({ allowed: false, status: 401 });
  });

  it('refuses the right key with a lowercase bearer scheme with 401', () => {
    expect(mcp({ host, authorization: `bearer ${expectation.mcpKey}` })).toMatchObject({ allowed: false, status: 401, reason: 'mcp-key-invalid' });
  });

  it('allows the right bearer key without an Origin header', () => {
    expect(mcp({ host, authorization: `Bearer ${expectation.mcpKey}` })).toEqual({ allowed: true });
  });

  it('allows the right bearer key from the server’s own origin and with a query string', () => {
    const result = request('/mcp?x=1', { host, origin: ownOrigin, authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toEqual({ allowed: true });
  });

  it('refuses Host localhost:<port> with 403 even with a valid key', () => {
    const result = mcp({ host: `localhost:${PORT}`, authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403, reason: 'host-mismatch' });
  });

  it('refuses 127.0.0.1 on another port with 403', () => {
    const result = mcp({ host: '127.0.0.1:1', authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403 });
  });

  it('refuses a foreign Origin with 403 even with a valid key', () => {
    const result = mcp({ host, origin: 'https://evil.example', authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403, reason: 'origin-mismatch' });
  });

  it('answers 404 for any path other than /mcp, even with the key in the path', () => {
    expect(request('/', { host, authorization: `Bearer ${expectation.mcpKey}` })).toMatchObject({ allowed: false, status: 404 });
    expect(request(`/${expectation.mcpKey}/mcp`, { host })).toMatchObject({ allowed: false, status: 404 });
  });

  it('gives refusal reasons that never contain the key', () => {
    for (const result of [mcp({ host }), mcp({ host: 'x', authorization: `Bearer ${expectation.mcpKey}` }), request(`/${expectation.mcpKey}`, { host })]) {
      if (result.allowed) throw new Error('expected a refusal');
      expect(result.reason).not.toContain(expectation.mcpKey);
    }
  });
});

describe('maskPath', () => {
  it('masks a key-length first segment', () => {
    expect(maskPath(`/${expectation.mcpKey}/mcp`)).toBe('/[key]/mcp');
  });

  it('masks a key-length segment anywhere in the path, also when text surrounds the key', () => {
    const marker = 'M'.repeat(43);
    expect(maskPath(`/mcp/${marker}`)).toBe('/mcp/[key]');
    expect(maskPath(`/a/b/c/${marker}/d`)).toBe('/a/b/c/[key]/d');
    expect(maskPath(`/mcp/key=${marker}.json`)).toBe('/mcp/[key]');
  });

  it('keeps short paths readable and drops the query string', () => {
    expect(maskPath('/favicon.ico')).toBe('/favicon.ico');
    expect(maskPath('/.well-known/oauth-protected-resource')).toBe('/.well-known/oauth-protected-resource');
    expect(maskPath('/mcp?x=1')).toBe('/mcp');
  });
});

describe('loopbackBypassConfigured', () => {
  it('accepts 127.0.0.1 in http.noProxy', () => {
    expect(loopbackBypassConfigured(['127.0.0.1'])).toBe(true);
    expect(loopbackBypassConfigured(['example.com', ' 127.0.0.1 '])).toBe(true);
  });

  it('counts 127.0.0.1 with a port as missing, since it bypasses the proxy for that port only', () => {
    expect(loopbackBypassConfigured(['127.0.0.1:8080'])).toBe(false);
    expect(loopbackBypassConfigured(['127.0.0.1:*'])).toBe(false);
  });

  it('does not count localhost, since the server is reached at 127.0.0.1', () => {
    expect(loopbackBypassConfigured(['localhost'])).toBe(false);
  });

  it('is false for a missing, empty or malformed setting', () => {
    expect(loopbackBypassConfigured(undefined)).toBe(false);
    expect(loopbackBypassConfigured([])).toBe(false);
    expect(loopbackBypassConfigured('127.0.0.1')).toBe(false);
    expect(loopbackBypassConfigured([42, null])).toBe(false);
  });
});
