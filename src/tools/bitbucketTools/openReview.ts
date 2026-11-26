import { z } from 'zod';
import { parseReviewUrl, reviewSessionId } from '../../boards/review/recipe';
import { defineTool } from '../toolDefinition';
import { withBitbucket, type BitbucketToolDeps } from './bitbucketAccess';
import { OPEN_REVIEW_TOOL, READ_FINDINGS_TOOL } from './toolNames';

// Opens the review board of a pull request in an editor tab. The review itself runs on the board,
// where the developer picks the background and starts it; the answer says only whether the board
// opened, so the call does not wait for a review that can take minutes.

const openReviewShape = {
  url: z.string().describe('The pull request\'s link, e.g. https://bitbucket.example.com/projects/KEY/repos/repo/pull-requests/42 or https://bitbucket.org/workspace/repo/pull-requests/42.'),
  ticketKey: z.string().optional().describe('A Jira key the user named as the background for the reviewer, e.g. PROJ-123. The board reads the ticket before the review starts.'),
  background: z.string().optional().describe('A goal or focus text the user gave for the review, e.g. "watch thread safety"; it is the background for the reviewer. A Jira key goes in ticketKey, not here.'),
};

export const openReviewTool = defineTool<BitbucketToolDeps, typeof openReviewShape>({
  name: OPEN_REVIEW_TOOL,
  title: 'Open a pull request review',
  description:
    'Opens the review board of a Bitbucket pull request in its own editor tab, where the user starts the review and decides how deep it goes. '
    + 'Use it whenever the user asks to review a pull request or pastes a pull request link: a plain chat request with a pull request link means opening a review. Pass a Jira key the user named as ticketKey and any goal or focus text as background. '
    + `The answer says only whether the board opened, not the review's result: the review runs on the board, and ${READ_FINDINGS_TOOL} reads its findings afterwards. `
    + 'Changes nothing in Bitbucket.',
  inputSchema: openReviewShape,
  annotations: { readOnlyHint: true },
  handler: (args, deps) =>
    withBitbucket(deps, OPEN_REVIEW_TOOL, 'Not opened', async () => {
      if (!deps.openReview) return 'Not opened: boards are not available in this window.';
      const ticketKey = args.ticketKey?.trim();
      const background = args.background?.trim();
      const parsed = parseReviewUrl(args.url);
      // A review past the first step keeps what it was started with; the request's key and text do not change it.
      const stored = parsed.ok && (ticketKey || background) ? await deps.storedReview(reviewSessionId(parsed.recipe)) : undefined;
      const opened = await deps.openReview({
        url: args.url,
        ...(ticketKey ? { ticketKey } : {}),
        ...(background ? { background } : {}),
      });
      if (!opened.ok) return `Not opened: ${opened.reason}`;
      const kept = stored?.working.stage === 'review'
        ? ' A review of this pull request is shown already, so the board keeps its background; New review on the board starts over on the first step, where the background can be changed.'
        : '';
      return `Opened in an editor tab: ${opened.title}.${kept} The review runs on the board when the user starts it; read its result with ${READ_FINDINGS_TOOL}.`;
    }),
});
