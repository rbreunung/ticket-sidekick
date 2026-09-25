import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { BitbucketCommentResult, BitbucketPR, BitbucketUser, IBitbucketClient, InlineAnchor } from '../../bitbucket/IBitbucketClient';

function loadFixture<T>(filename: string): T {
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockBitbucketClient implements IBitbucketClient {
  public getFileContentCalls: Array<{ project: string; repo: string; path: string; commitHash: string }> = [];
  public getPullRequestDiffCalls: Array<{ project: string; repo: string; prId: number; contextLines?: number }> = [];
  public addPrCommentCalls: Array<{ project: string; repo: string; prId: number; text: string; inline?: InlineAnchor }> = [];
  public addPrCommentError: Error | null = null;
  /** Per-test override for the PR diff; the `bitbucket-diff.json` fixture when unset. */
  public rawDiff: string | undefined;
  /** Per-test file contents by path; the `bitbucket-file.json` fixture for any path not listed. */
  public fileContents = new Map<string, string>();

  async getCurrentUser(): Promise<BitbucketUser> {
    return { displayName: 'Jane Smith', emailAddress: 'jane.smith@example.com' };
  }

  async getPullRequest(_project: string, _repo: string, _prId: number): Promise<BitbucketPR> {
    return loadFixture<BitbucketPR>('bitbucket-pr.json');
  }

  async getPullRequestDiff(project: string, repo: string, prId: number, contextLines?: number): Promise<string> {
    this.getPullRequestDiffCalls.push({ project, repo, prId, contextLines });
    if (this.rawDiff !== undefined) return this.rawDiff;
    const fixture = loadFixture<{ raw: string }>('bitbucket-diff.json');
    return fixture.raw;
  }

  async getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string> {
    this.getFileContentCalls.push({ project, repo, path, commitHash });
    const override = this.fileContents.get(path);
    if (override !== undefined) return override;
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
