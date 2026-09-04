export type BitbucketAuthType = 'datacenter' | 'cloud';

export interface BitbucketUser {
  displayName: string;
  emailAddress: string;
}

export interface BitbucketPR {
  id: number;
  title: string;
  description: string;
  author: BitbucketUser;
  targetBranch: string;
  fromCommitHash: string;
}

/**
 * Review depth, ordered by capability quick < standard < smart < deep — not by
 * mode-keyword detection priority (that precedence is deep > smart > quick > standard,
 * see `resolveReviewMode` in reviewSessionState.ts / KTD1). `deep` is the only mode that
 * runs the critic (verification) pass; `smart` and `deep` additionally run persona lenses.
 */
export type ReviewMode = 'quick' | 'standard' | 'smart' | 'deep';

export interface BitbucketConfig {
  baseUrl: string | undefined;
  authType: BitbucketAuthType;
  token: string | undefined;
  showConnectionInfo?: boolean;
  reviewInstructions?: string;
  modelContextTokens?: number;
  contextBudgetRatio?: number;
  reviewMode?: ReviewMode;
  reviewExcludePatterns?: string[];
  /** Diff context lines requested around each hunk (wider = more surrounding code for the reviewer). */
  reviewContextLines?: number;
  /** Model self-rated confidence below this folds into a low-confidence section (0–1). */
  confidenceThreshold?: number;
  /** When true, emit one fenced structured diagnostic record per review (R7). Default false. */
  detailedDiagnostics?: boolean;
}

export interface BitbucketCommentResult {
  commentId: number;
  commentUrl?: string;
}

export interface InlineAnchor {
  filePath: string;
  line: number;
  lineType: 'ADDED' | 'CONTEXT' | 'REMOVED';
  fileType: 'TO' | 'FROM';
}

export interface IBitbucketClient {
  getCurrentUser(): Promise<BitbucketUser>;
  getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPR>;
  getPullRequestDiff(project: string, repo: string, prId: number, contextLines?: number): Promise<string>;
  getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string>;
  addPrComment(
    project: string,
    repo: string,
    prId: number,
    text: string,
    inline?: InlineAnchor,
  ): Promise<BitbucketCommentResult>;
}
