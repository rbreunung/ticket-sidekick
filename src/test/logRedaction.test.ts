import { describe, it, expect } from 'vitest';
import { sanitizeDetails } from '../utils/logRedaction';

describe('sanitizeDetails', () => {
  it('redacts values whose key looks like a secret', () => {
    const result = sanitizeDetails({
      token: 'abc123', authorization: 'Bearer xyz', password: 'hunter2', apiKey: 'k-1', normal: 'keep me',
    });
    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.normal).toBe('keep me');
  });

  it('does not redact keys that merely contain unrelated substrings', () => {
    const result = sanitizeDetails({ count: 5, fileName: 'report.xml' });
    expect(result.count).toBe(5);
    expect(result.fileName).toBe('report.xml');
  });

  it('truncates strings over 500 characters', () => {
    const long = 'x'.repeat(600);
    const result = sanitizeDetails({ body: long });
    expect(result.body).toBe('x'.repeat(500) + '…[truncated, 600 chars total]');
  });

  it('leaves short strings untouched', () => {
    const result = sanitizeDetails({ body: 'short text' });
    expect(result.body).toBe('short text');
  });

  it('redacts and truncates inside nested objects', () => {
    const result = sanitizeDetails({
      request: { headers: { authorization: 'Bearer xyz' }, body: 'x'.repeat(600) },
    });
    const request = result.request as Record<string, unknown>;
    const headers = request.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[REDACTED]');
    expect((request.body as string).startsWith('x'.repeat(500))).toBe(true);
  });

  it('caps arrays at 20 items with a marker for the rest', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const result = sanitizeDetails({ items: arr });
    const items = result.items as unknown[];
    expect(items).toHaveLength(21); // 20 items + marker
    expect(items[20]).toBe('…5 more');
  });

  it('caps recursion depth beyond 4 nested object levels', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const result = sanitizeDetails(deep);
    const a = result.a as Record<string, any>;
    expect(a.b.c.d.e).toBe('[MAX_DEPTH]');
  });

  it('does not redact keys that merely contain a sensitive word as a substring', () => {
    const result = sanitizeDetails({ authType: 'cloud', maxInputTokens: 8000, author: 'Jane' });
    expect(result.authType).toBe('cloud');
    expect(result.maxInputTokens).toBe(8000);
    expect(result.author).toBe('Jane');
  });

  it('still redacts compound keys ending in a sensitive word', () => {
    const result = sanitizeDetails({ authToken: 'xyz', apiToken: 'abc', api_key: 'def' });
    expect(result.authToken).toBe('[REDACTED]');
    expect(result.apiToken).toBe('[REDACTED]');
    expect(result.api_key).toBe('[REDACTED]');
  });
});
