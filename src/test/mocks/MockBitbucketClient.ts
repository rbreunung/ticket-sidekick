import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { BitbucketCommentResult, BitbucketPR, BitbucketUser, IBitbucketClient, InlineAnchor } from '../../bitbucket/IBitbucketClient';

function loadFixture<T>(filename: string): T {
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockBitbucketClient implements IBitbucketClient {
  public getFileContentCalls: Array<{ project: string; repo: string; path: string; commitHash: string }> = [];
  public addPrCommentCalls: Array<{ project: string; repo: string; prId: number; text: string; inline?: InlineAnchor }> = [];
  public addPrCommentError: Error | null = null;

  async getCurrentUser(): Promise<BitbucketUser> {
    return { displayName: 'Jane Smith', emailAddress: 'jane.smith@example.com' };
  }

  async getPullRequest(_project: string, _repo: string, _prId: number): Promise<BitbucketPR> {
    return loadFixture<BitbucketPR>('bitbucket-pr.json');
  }

  async getPullRequestDiff(_project: string, _repo: string, _prId: number): Promise<string> {
    const fixture = loadFixture<{ raw: string }>('bitbucket-diff.json');
    return fixture.raw;
  }

  async getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string> {
    this.getFileContentCalls.push({ project, repo, path, commitHash });
    const fixture = loadFixture<{ content: string }>('bitbucket-file.json');
    return fixture.content;
  }

  async addPrComment(
    project: string,
    repo: string,
    prId: number,
    text: string,
    inline?: InlineAnchor,
  ): Promise<BitbucketCommentResult> {
    this.addPrCommentCalls.push({ project, repo, prId, text, inline });
    if (this.addPrCommentError) throw this.addPrCommentError;
    return { commentId: this.addPrCommentCalls.length * 100 };
  }
}
