import { describe, it, expect } from 'vitest';
import { buildBitbucketNotConfiguredMessage } from '../participant/reviewSessionState';

describe('buildBitbucketNotConfiguredMessage', () => {
  it('names the base URL setting for Data Center when baseUrl is missing', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: undefined, token: undefined });

    expect(message).toContain('ticketSidekick.bitbucket.baseUrl');
  });

  it('names the Data Center PAT setup command when baseUrl is set but the token is missing', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: 'https://bitbucket.example.com', token: undefined });

    expect(message).toContain('Ticket Sidekick: Set Bitbucket Personal Access Token');
  });

  it('names the Cloud credentials setup command for Cloud with no token — baseUrl is never mentioned', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'cloud', baseUrl: undefined, token: undefined });

    expect(message).toContain('Ticket Sidekick: Configure Bitbucket Cloud Credentials');
    expect(message).not.toContain('baseUrl');
  });

  it('never emits a trusted MarkdownString command link — plain text only', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: undefined, token: undefined });

    expect(message).not.toContain('(command:');
  });
});
