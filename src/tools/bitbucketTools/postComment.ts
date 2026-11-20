import { z } from 'zod';
import type { ReviewFinding } from '../../review/reviewSessionState';
import { PrReviewService } from '../../services/PrReviewService';
import { writeOnce } from '../jiraTools/writeGuard';
import { MAX_PREVIEW_CHARS } from '../jiraToolConfirmation';
import { fingerprint } from '../recentCallGuard';
import { defineTool, ToolFailure } from '../toolDefinition';
import { pullRequestProblem, pullRequestShape, withBitbucket, type BitbucketToolDeps } from './bitbucketAccess';
import { POST_COMMENT_TOOL } from './toolNames';

const postCommentShape = {
  ...pullRequestShape,
  comment: z.string().describe('The comment text to post to the pull request\'s activity feed.'),
};

/**
 * A finding without a line: `postCommentItems` anchors a comment inline only when its finding has
 * a line, so this posts a plain comment to the activity feed.
 */
const FEED_COMMENT: ReviewFinding = { id: 1, file: '', severity: 'suggestion', title: 'Comment', description: '', recommendation: '' };

/**
 * Why a comment is not posted because its confirmation could not show it in full; the user must
 * be able to read every character they approve.
 */
function tooLongToConfirm(comment: string): string | undefined {
  return comment.length > MAX_PREVIEW_CHARS
    ? `The comment is ${comment.length} characters long; at most ${MAX_PREVIEW_CHARS} can be shown in full for confirmation, so it was not posted. Shorten it or split it into several comments.`
    : undefined;
}

export const postCommentTool = defineTool<BitbucketToolDeps, typeof postCommentShape>({
  name: POST_COMMENT_TOOL,
  title: 'Post a comment on a Bitbucket pull request',
  description:
    'Posts a comment to a Bitbucket pull request\'s activity feed (not tied to a line). This writes to Bitbucket: the user is asked to '
    + 'confirm the exact comment text before it is posted. The same comment on the same pull request within a minute is skipped, so a '
    + 'repeated call does not post it twice.',
  inputSchema: postCommentShape,
  annotations: { destructiveHint: true },
  // The input line of the confirmation is cut after a short length; this shows the whole comment,
  // exactly as it is posted.
  preview: async args => {
    const comment = args.comment.trim();
    const refused = tooLongToConfirm(comment);
    if (refused) throw new Error(refused);
    return [{ name: 'Comment to post', value: comment }];
  },
  handler: async (args, deps) => {
    const project = args.project.trim();
    const repo = args.repo.trim();
    const comment = args.comment.trim();
    const problem = pullRequestProblem(project, repo);
    if (problem) return problem;
    if (!comment) return 'Comment text is required.';
    const refused = tooLongToConfirm(comment);
    if (refused) return refused;
    const label = `PR #${args.prId} (${project}/${repo})`;

    return writeOnce(
      deps.recentWrites,
      fingerprint(POST_COMMENT_TOOL, project, repo, args.prId, comment),
      `Skipped: an identical comment on ${label} was just posted in the last minute. If this is intentional, change the text or wait before retrying.`,
      markWritten => withBitbucket(deps, POST_COMMENT_TOOL, `Could not post the comment on ${label}`, async ({ client }) => {
        const service = new PrReviewService(client, deps.onDiag);
        const [posted] = await service.postCommentItems(project, repo, args.prId, [{ finding: FEED_COMMENT, text: comment }]);
        if (!posted.result) throw new ToolFailure(`Could not post the comment on ${label}: ${posted.error ?? 'Bitbucket gave no answer.'}`, 'post failed');
        markWritten();
        const { commentId, commentUrl } = posted.result;
        return `Posted comment #${commentId} on ${label}${commentUrl ? `: ${commentUrl}` : ''}.`;
      }),
    );
  },
});
