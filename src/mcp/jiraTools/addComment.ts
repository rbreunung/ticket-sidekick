import { z } from 'zod';
import { fingerprint } from '../../tools/recentCallGuard';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { ADD_COMMENT_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

const addCommentShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  comment: z.string().describe('The comment text, written as Markdown; it is converted to Jira wiki markup.'),
};

export const addCommentTool = defineTool<JiraToolDeps, typeof addCommentShape>({
  name: ADD_COMMENT_TOOL,
  title: 'Add a comment to a Jira ticket',
  description:
    'Adds one comment to a Jira ticket. Write the comment as Markdown (headings, lists, tables, code); it reaches Jira as '
    + 'wiki markup, as from @jira. The same comment on the same ticket within a minute is skipped, so a repeated call does not post it twice.',
  inputSchema: addCommentShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const comment = args.comment.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!comment) return 'Comment text is required.';

    return writeOnce(
      deps.recentWrites,
      fingerprint(ADD_COMMENT_TOOL, key, comment),
      `Skipped: the same comment was added to ${key} within the last minute. Change the text or wait a minute to add it again.`,
      markWritten => runJiraTool(deps, ADD_COMMENT_TOOL, `Could not add a comment to ${key}`, async ({ config, ticketService }) => {
        const answer = await ticketService.addComment(key, markdownToJiraWiki(comment), config.baseUrl);
        markWritten();
        return answer;
      }),
    );
  },
});
