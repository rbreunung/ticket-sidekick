import { z } from 'zod';
import { defineTool } from '../toolDefinition';
import { withBitbucket, type BitbucketToolDeps } from './bitbucketAccess';
import { OPEN_REVIEW_TOOL, READ_FINDINGS_TOOL } from './toolNames';

// Opens the review board of a pull request in an editor tab. The review itself runs on the board,
// where the developer picks what to check and starts it; the answer says only whether the board
// opened, so the call does not wait for a review that can take minutes.

const openReviewShape = {
  url: z.string().describe('The pull request\'s link, e.g. https://bitbucket.example.com/projects/KEY/repos/repo/pull-requests/42 or https://bitbucket.org/workspace/repo/pull-requests/42.'),
  ticketKey: z.string().optional().describe('A Jira key the user named to check the pull request against, e.g. PROJ-123.'),
  question: z.string().optional().describe('A question the user asked about the pull request, to answer with the review.'),
};

export const openReviewTool = defineTool<BitbucketToolDeps, typeof openReviewShape>({
  name: OPEN_REVIEW_TOOL,
  title: 'Open a pull request review',
  description:
    'Opens the review board of a Bitbucket pull request in its own editor tab, where the user starts the review and decides how deep it goes. '
    + 'Use it whenever the user asks to review a pull request or pastes a pull request link: a plain chat request with a pull request link means opening a review. Pass a Jira key or a question the user named. '
    + `The answer says only whether the board opened, not the review's result: the review runs on the board, and ${READ_FINDINGS_TOOL} reads its findings afterwards. `
    + 'Changes nothing in Bitbucket.',
  inputSchema: openReviewShape,
  annotations: { readOnlyHint: true },
  handler: (args, deps) =>
    withBitbucket(deps, OPEN_REVIEW_TOOL, 'Not opened', async () => {
      if (!deps.openReview) return 'Not opened: boards are not available in this window.';
      const opened = await deps.openReview({
        url: args.url,
        ...(args.ticketKey?.trim() ? { ticketKey: args.ticketKey.trim() } : {}),
        ...(args.question?.trim() ? { question: args.question.trim() } : {}),
      });
      if (!opened.ok) return `Not opened: ${opened.reason}`;
      return `Opened in an editor tab: ${opened.title}. The review runs on the board when the user starts it; read its result with ${READ_FINDINGS_TOOL}.`;
    }),
});
