import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { getConfiguration: vi.fn() },
}));

import { ConfigService } from '../services/ConfigService';

// isConfigured()/isBitbucketConfigured() don't touch `this.context` — a dummy stand-in is
// enough to construct the service.
const configService = new ConfigService({} as never);

describe('ConfigService.isConfigured (Jira)', () => {
  it('is true when both baseUrl and token are set (Data Center)', () => {
    expect(configService.isConfigured({ baseUrl: 'https://jira.example.com', token: 'pat' })).toBe(true);
  });

  it('is true when both baseUrl and token are set (Cloud)', () => {
    expect(configService.isConfigured({ baseUrl: 'https://example.atlassian.net', token: 'base64token' })).toBe(true);
  });

  it('is false when baseUrl is missing', () => {
    expect(configService.isConfigured({ baseUrl: undefined, token: 'pat' })).toBe(false);
  });

  it('is false when token is missing', () => {
    expect(configService.isConfigured({ baseUrl: 'https://jira.example.com', token: undefined })).toBe(false);
  });

  it('is false when both are missing', () => {
    expect(configService.isConfigured({ baseUrl: undefined, token: undefined })).toBe(false);
  });
});

describe('ConfigService.isBitbucketConfigured', () => {
  it('is true for Cloud with only a token set — baseUrl is not required', () => {
    expect(configService.isBitbucketConfigured({ authType: 'cloud', baseUrl: undefined, token: 'apppassword' })).toBe(true);
  });

  it('is false for Cloud with no token', () => {
    expect(configService.isBitbucketConfigured({ authType: 'cloud', baseUrl: undefined, token: undefined })).toBe(false);
  });

  it('is true for Data Center with both baseUrl and token set', () => {
    expect(configService.isBitbucketConfigured({ authType: 'datacenter', baseUrl: 'https://bitbucket.example.com', token: 'pat' })).toBe(true);
  });

  it('is false for Data Center missing baseUrl', () => {
    expect(configService.isBitbucketConfigured({ authType: 'datacenter', baseUrl: undefined, token: 'pat' })).toBe(false);
  });

  it('is false for Data Center missing token', () => {
    expect(configService.isBitbucketConfigured({ authType: 'datacenter', baseUrl: 'https://bitbucket.example.com', token: undefined })).toBe(false);
  });
});
