import { describe, it, expect } from 'vitest';
import { generateKey, keysMatch } from '../prototype/keys';
import { checkRequest, maskPath, type GuardExpectation } from '../prototype/requestGuard';
import { PlanStore } from '../prototype/planStore';

const PORT = 43123;
const expectation: GuardExpectation = { port: PORT, mcpKey: generateKey(), canvasKey: generateKey() };
const host = `127.0.0.1:${PORT}`;
const ownOrigin = `http://127.0.0.1:${PORT}`;

function mcp(headers: Record<string, string | undefined>) {
  return checkRequest({ method: 'POST', path: '/mcp', headers }, expectation);
}

function canvas(path: string, headers: Record<string, string | undefined>) {
  return checkRequest({ method: 'POST', path, headers }, expectation);
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

describe('checkRequest — MCP route', () => {
  it('refuses a request without an Authorization header with 401', () => {
    expect(mcp({ host })).toMatchObject({ allowed: false, status: 401 });
  });

  it('refuses a wrong bearer key of the same length with 401', () => {
    expect(mcp({ host, authorization: `Bearer ${generateKey()}` })).toMatchObject({ allowed: false, status: 401 });
  });

  it('allows the right bearer key without an Origin header', () => {
    expect(mcp({ host, authorization: `Bearer ${expectation.mcpKey}` })).toEqual({ allowed: true, route: 'mcp' });
  });

  it('refuses Host localhost:<port> with 403 even with a valid key', () => {
    const result = mcp({ host: `localhost:${PORT}`, authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403 });
  });

  it('refuses 127.0.0.1 on another port with 403', () => {
    const result = mcp({ host: '127.0.0.1:1', authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403 });
  });

  it('refuses a foreign Origin with 403 even with a valid key', () => {
    const result = mcp({ host, origin: 'https://evil.example', authorization: `Bearer ${expectation.mcpKey}` });
    expect(result).toMatchObject({ allowed: false, status: 403 });
  });
});

describe('checkRequest — canvas route', () => {
  it('allows the canvas key path from the server’s own origin', () => {
    const result = canvas(`/${expectation.canvasKey}/api/plan`, { host, origin: ownOrigin });
    expect(result).toEqual({ allowed: true, route: 'canvas', subPath: '/api/plan' });
  });

  it('treats the bare key path as the board root', () => {
    const result = canvas(`/${expectation.canvasKey}`, { host });
    expect(result).toEqual({ allowed: true, route: 'canvas', subPath: '/' });
  });

  it('refuses a post from another origin with 403', () => {
    const result = canvas(`/${expectation.canvasKey}/api/apply`, { host, origin: 'https://evil.example' });
    expect(result).toMatchObject({ allowed: false, status: 403 });
  });

  it('refuses an unknown first path segment with 401 and a reason that holds no key', () => {
    const result = canvas(`/${generateKey()}/api/plan`, { host, origin: ownOrigin });
    expect(result).toMatchObject({ allowed: false, status: 401 });
    if (result.allowed) throw new Error('expected a refusal');
    expect(result.reason).not.toContain(expectation.canvasKey);
    expect(result.reason).not.toContain(expectation.mcpKey);
  });

  it('does not accept the MCP key as a canvas path', () => {
    const result = canvas(`/${expectation.mcpKey}/api/plan`, { host, origin: ownOrigin });
    expect(result).toMatchObject({ allowed: false, status: 401 });
  });
});

describe('maskPath', () => {
  it('masks a key-length first segment', () => {
    expect(maskPath(`/${expectation.canvasKey}/api/plan`)).toBe('/[key]/api/plan');
  });

  it('keeps short paths such as /favicon.ico readable', () => {
    expect(maskPath('/favicon.ico')).toBe('/favicon.ico');
    expect(maskPath('/.well-known/oauth-protected-resource')).toBe('/.well-known/oauth-protected-resource');
    expect(maskPath('/mcp?x=1')).toBe('/mcp');
  });
});

describe('PlanStore', () => {
  it('hands out a plan once', () => {
    const store = new PlanStore<{ comment: string }>();
    const id = store.add({ comment: 'hello' });
    expect(store.take(id)).toEqual({ comment: 'hello' });
    expect(store.take(id)).toBeUndefined();
  });

  it('forgets every plan on clear', () => {
    const store = new PlanStore<string>();
    const a = store.add('a');
    const b = store.add('b');
    store.clear();
    expect(store.take(a)).toBeUndefined();
    expect(store.take(b)).toBeUndefined();
  });

  it('returns undefined for an id it never issued', () => {
    expect(new PlanStore<string>().take('nope')).toBeUndefined();
  });
});
