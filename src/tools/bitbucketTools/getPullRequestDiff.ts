import { z } from 'zod';
import { defineTool } from '../toolDefinition';
import { pullRequestProblem, pullRequestShape, withBitbucket, type BitbucketToolDeps } from './bitbucketAccess';
import { GET_PULL_REQUEST_DIFF_TOOL } from './toolNames';

const diffShape = {
  ...pullRequestShape,
  contextLines: z.number().int().min(0).max(1000).optional().describe(
    'Diff context lines to request around each hunk. Default: the ticketSidekick.bitbucket.reviewContextLines setting.',
  ),
};

export const getPullRequestDiffTool = defineTool<BitbucketToolDeps, typeof diffShape>({
  name: GET_PULL_REQUEST_DIFF_TOOL,
  title: 'Get a Bitbucket pull request diff',
  description: 'Fetches the unified diff of a Bitbucket pull request. Changes nothing.',
  inputSchema: diffShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const project = args.project.trim();
    const repo = args.repo.trim();
    const problem = pullRequestProblem(project, repo);
    if (problem) return problem;
    const label = `PR #${args.prId} (${project}/${repo})`;
    return withBitbucket(deps, GET_PULL_REQUEST_DIFF_TOOL, `Could not fetch the diff for ${label}`, async ({ client, config }) => {
      // Without an explicit value the configured context lines apply, as in a review.
      const diff = await client.getPullRequestDiff(project, repo, args.prId, args.contextLines ?? config.reviewContextLines);
      if (!diff.trim()) return `${label} has no textual diff.`;
      return `## Diff for ${label}\n\n${diff}`;
    });
  },
});
