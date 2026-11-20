import type { BitbucketPR } from '../../bitbucket/IBitbucketClient';
import { defineTool } from '../toolDefinition';
import { pullRequestProblem, pullRequestShape, withBitbucket, type BitbucketToolDeps } from './bitbucketAccess';
import { GET_PULL_REQUEST_TOOL } from './toolNames';

/** The pull request's title, author, target branch, source commit and description. */
export function formatPullRequestSummary(pr: BitbucketPR): string {
  return (
    `## PR #${pr.id} — ${pr.title}\n` +
    `Author: ${pr.author.displayName} → ${pr.targetBranch}\n` +
    `Source commit: ${pr.fromCommitHash}\n\n` +
    (pr.description?.trim() ? pr.description.trim() : '_No description._')
  );
}

export const getPullRequestTool = defineTool<BitbucketToolDeps, typeof pullRequestShape>({
  name: GET_PULL_REQUEST_TOOL,
  title: 'Get a Bitbucket pull request',
  description: 'Fetches a Bitbucket pull request\'s title, description, author, target branch and source commit hash. Changes nothing.',
  inputSchema: pullRequestShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const project = args.project.trim();
    const repo = args.repo.trim();
    const problem = pullRequestProblem(project, repo);
    if (problem) return problem;
    return withBitbucket(deps, GET_PULL_REQUEST_TOOL, `Could not fetch PR #${args.prId} (${project}/${repo})`, async ({ client }) =>
      formatPullRequestSummary(await client.getPullRequest(project, repo, args.prId)));
  },
});
