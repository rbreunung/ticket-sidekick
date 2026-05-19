import { describe, it, expect } from 'vitest';
import { redactUrls, tokenStatus } from '../utils/diagUtils';

describe('redactUrls', () => {
  it('replaces hostname but keeps scheme and path', () => {
    expect(redactUrls('https://jira.corp.com/rest/api/2/myself'))
      .toBe('https://[redacted]/rest/api/2/myself');
  });

  it('replaces hostname in an error message', () => {
    expect(redactUrls('Authentication failed at https://jira.corp.com/rest/api/2/myself. Check credentials.'))
      .toBe('Authentication failed at https://[redacted]/rest/api/2/myself. Check credentials.');
  });

  it('handles http scheme', () => {
    expect(redactUrls('http://internal.server/path')).toBe('http://[redacted]/path');
  });

  it('redacts a bare base URL with no path', () => {
    expect(redactUrls('https://bb.corp.com')).toBe('https://[redacted]');
  });

  it('leaves text without URLs unchanged', () => {
    expect(redactUrls('No URLs here.')).toBe('No URLs here.');
  });

  it('redacts multiple URLs in one string', () => {
    const input = 'See https://a.com/x and https://b.com/y for details.';
    expect(redactUrls(input)).toBe('See https://[redacted]/x and https://[redacted]/y for details.');
  });
});

describe('tokenStatus', () => {
  it('returns present with length for a non-empty token', () => {
    expect(tokenStatus('abc123')).toBe('present (6 chars)');
  });

  it('returns absent for undefined', () => {
    expect(tokenStatus(undefined)).toBe('**absent**');
  });

  it('returns absent for empty string', () => {
    expect(tokenStatus('')).toBe('**absent**');
  });
});
