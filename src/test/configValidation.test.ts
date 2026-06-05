import { describe, it, expect } from 'vitest';
import { validateBaseUrl } from '../services/configValidation';

describe('validateBaseUrl', () => {
  it('accepts a well-formed https URL', () => {
    expect(validateBaseUrl('https://jira.mycompany.com')).toBeNull();
  });

  it('accepts an http URL with a sub-path', () => {
    expect(validateBaseUrl('http://server.local/jira')).toBeNull();
  });

  it('returns null when the URL is absent (presence handled separately)', () => {
    expect(validateBaseUrl(undefined)).toBeNull();
    expect(validateBaseUrl('')).toBeNull();
  });

  it('rejects a URL with no scheme', () => {
    const msg = validateBaseUrl('jira.mycompany.com');
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/https?:\/\//);
  });

  it('rejects a non-http(s) scheme', () => {
    const msg = validateBaseUrl('ftp://jira.mycompany.com');
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/http/i);
  });

  it('rejects an obviously malformed value', () => {
    expect(validateBaseUrl('http://')).toBeTruthy();
  });
});
