import { describe, it, expect } from 'vitest';
import { loopbackBypassConfigured } from '../prototype/proxyBypass';

describe('loopbackBypassConfigured', () => {
  it('accepts 127.0.0.1 in http.noProxy', () => {
    expect(loopbackBypassConfigured(['127.0.0.1'])).toBe(true);
    expect(loopbackBypassConfigured(['example.com', ' 127.0.0.1 '])).toBe(true);
  });

  it('accepts 127.0.0.1 with a port, which still covers the prototype only on that port', () => {
    expect(loopbackBypassConfigured(['127.0.0.1:*'])).toBe(true);
  });

  it('does not count localhost, since the prototype connects to 127.0.0.1', () => {
    expect(loopbackBypassConfigured(['localhost'])).toBe(false);
  });

  it('is false for a missing, empty or malformed setting', () => {
    expect(loopbackBypassConfigured(undefined)).toBe(false);
    expect(loopbackBypassConfigured([])).toBe(false);
    expect(loopbackBypassConfigured('127.0.0.1')).toBe(false);
    expect(loopbackBypassConfigured([42, null])).toBe(false);
  });
});
