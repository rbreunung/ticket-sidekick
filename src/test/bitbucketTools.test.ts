import { describe, it, expect } from 'vitest';
import {
  formatPullRequestSummary,
  buildPostCommentConfirmation,
  buildBitbucketNotConfiguredMessage,
} from '../participant/reviewSessionState';
import { PrReviewService } from '../services/PrReviewService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { ReviewFinding } from '../participant/reviewSessionState';

// These tests cover the pure builders `src/tools/bitbucketTools.ts` (vscode-coupled, not
// Vitest-loadable — see CLAUDE.md's Testing section) delegates to for every bitbucket_* Language
// Model tool's confirmation text and result wording (U3), mirroring jiraTools.test.ts's approach.

describe('bitbucket_getPullRequest (delegates to IBitbucketClient.getPullRequest)', () => {
  it('returns PR metadata via the mock client, formatted by formatPullRequestSummary', async () => {
    const client = new MockBitbucketClient();
    const pr = await client.getPullRequest('PROJ', 'myrepo', 42);
    const text = formatPullRequestSummary(pr);
    expect(text).toContain(`PR #${pr.id}`);
    expect(text).toContain(pr.title);
    expect(text).toContain(pr.author.displayName);
    expect(text).toContain(pr.targetBranch);
  });

  it('falls back to a placeholder when the PR has no description', () => {
    const text = formatPullRequestSummary({
      id: 7,
      title: 'No description here',
      description: '',
      author: { displayName: 'Jane Smith', emailAddress: 'jane@example.com' },
      targetBranch: 'main',
      fromCommitHash: 'abc123',
    });
    expect(text).toContain('_No description._');
  });
});

describe('bitbucket_postComment confirmation', () => {
  it('names the PR (project/repo#id) and includes the literal comment text', () => {
    const confirmation = buildPostCommentConfirmation('PROJ', 'myrepo', 42, 'This looks good to me.');
    expect(confirmation.title).toContain('PROJ/myrepo#42');
    expect(confirmation.message).toContain('PROJ/myrepo#42');
    expect(confirmation.message).toContain('This looks good to me.');
  });
});

describe('bitbucket_postComment (delegates to PrReviewService.postCommentItems)', () => {
  it('posts a plain (non-inline) comment and returns the comment id/url', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const finding: ReviewFinding = { id: 1, file: '', severity: 'suggestion', title: 'Comment', description: '', recommendation: '' };

    const [result] = await service.postCommentItems('PROJ', 'myrepo', 42, [{ finding, text: 'This looks good to me.' }]);

    expect(result.error).toBeUndefined();
    expect(result.result).not.toBeNull();
    expect(client.addPrCommentCalls).toHaveLength(1);
    expect(client.addPrCommentCalls[0]).toMatchObject({ project: 'PROJ', repo: 'myrepo', prId: 42, text: 'This looks good to me.' });
    // No line/lineType on the synthetic finding — the comment is posted to the activity feed,
    // not anchored inline.
    expect(client.addPrCommentCalls[0].inline).toBeUndefined();
  });

  it('reports a per-item error without throwing when the post fails', async () => {
    const client = new MockBitbucketClient();
    client.addPrCommentError = new Error('502 Bad Gateway');
    const service = new PrReviewService(client);
    const finding: ReviewFinding = { id: 1, file: '', severity: 'suggestion', title: 'Comment', description: '', recommendation: '' };

    const [result] = await service.postCommentItems('PROJ', 'myrepo', 42, [{ finding, text: 'This looks good to me.' }]);

    expect(result.result).toBeNull();
    expect(result.error).toContain('502 Bad Gateway');
  });
});

describe('bitbucket tools — not-configured path (R4)', () => {
  it('returns U1\'s buildBitbucketNotConfiguredMessage text when credentials are unset (Data Center, no baseUrl)', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'datacenter', baseUrl: undefined, token: undefined });
    expect(message).toContain('baseUrl');
  });

  it('returns U1\'s buildBitbucketNotConfiguredMessage text when credentials are unset (Cloud, no token)', () => {
    const message = buildBitbucketNotConfiguredMessage({ authType: 'cloud', baseUrl: undefined, token: undefined });
    expect(message).toContain('credentials not configured');
  });
});
