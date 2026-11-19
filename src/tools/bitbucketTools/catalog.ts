import type { ToolDefinition } from '../toolDefinition';
import type { BitbucketToolDeps } from './bitbucketAccess';
import { checkConnectionTool } from './checkConnection';
import { getPullRequestTool } from './getPullRequest';
import { getPullRequestDiffTool } from './getPullRequestDiff';
import { openReviewTool } from './openReview';
import { postCommentTool } from './postComment';
import { readFindingsTool } from './readFindings';
import { tokenUsageTool } from './tokenUsage';

// Every Bitbucket tool the extension offers to Copilot. They are registered with VS Code as
// language model tools from this list, so a tool exists for agents exactly when it is listed here.

export * from './toolNames';

export const BITBUCKET_TOOLS: readonly ToolDefinition<BitbucketToolDeps>[] = [
  checkConnectionTool,
  getPullRequestTool,
  getPullRequestDiffTool,
  postCommentTool,
  openReviewTool,
  readFindingsTool,
  tokenUsageTool,
];
