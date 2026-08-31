import { describe, it, expect } from 'vitest';
import { buildBitbucketNotConfiguredMessage, computeBitbucketFollowups, type BitbucketFollowupState } from '../participant/reviewSessionState';
import { isGreetingOrEmpty } from '../participant/sessionState';

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

describe('computeBitbucketFollowups', () => {
  it('returns example prompts for a greeting, capped at 3', () => {
    const state: BitbucketFollowupState = { kind: 'greeting' };

    const chips = computeBitbucketFollowups(state);

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
  });

  it('returns "add findings to review"/"explain finding #1"-shaped chips after a completed review', () => {
    const state: BitbucketFollowupState = { kind: 'reviewCompleted', findingCount: 3 };

    const chips = computeBitbucketFollowups(state);

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.some((c) => /add.*findings?.*review/i.test(c.prompt) || /add.*findings?.*review/i.test(c.label ?? ''))).toBe(true);
    expect(chips.some((c) => /explain/i.test(c.prompt) || /explain/i.test(c.label ?? ''))).toBe(true);
  });

  it('suggests asking a question instead of "add findings" when the review found nothing', () => {
    const state: BitbucketFollowupState = { kind: 'reviewCompleted', findingCount: 0 };

    const chips = computeBitbucketFollowups(state);

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => !/add.*findings?.*review/i.test(c.prompt))).toBe(true);
  });

  it('returns no chips when there is no prior operation state', () => {
    expect(computeBitbucketFollowups({ kind: 'none' })).toEqual([]);
  });
});

describe('isGreetingOrEmpty (shared with @jira — re-verified from the @bitbucket call site)', () => {
  it('detects a bare greeting and an empty prompt', () => {
    expect(isGreetingOrEmpty('hi')).toBe(true);
    expect(isGreetingOrEmpty('')).toBe(true);
  });

  it('does not classify a PR URL prompt as a greeting', () => {
    expect(isGreetingOrEmpty('https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42')).toBe(false);
  });
});
