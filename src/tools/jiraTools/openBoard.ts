import { z } from 'zod';
import { defineTool } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { OPEN_BOARD_TOOL } from './toolNames';

// Opens a board in an editor tab of the VS Code window. The extension fills the board itself; the
// answer says only whether it opened, so a list of tickets or a report never enters the chat.

const openBoardShape = {
  board: z.enum(['security-report', 'ticket-list', 'sessions']).describe(
    'security-report: a project\'s open Veracode and Waltz tickets by release. ticket-list: the tickets of a JQL query or saved filter, '
    + 'where the user selects tickets and moves them or sets a field. sessions: the stored board sessions of this workspace.',
  ),
  project: z.string().optional().describe('security-report: the Jira project key, e.g. PROJ. Leave out to use the default project.'),
  jql: z.string().optional().describe('ticket-list: a JQL query, e.g. project = PROJ AND status = Done.'),
  filter: z.string().optional().describe('ticket-list: a saved filter\'s id or name, in place of jql.'),
  change: z.object({
    type: z.enum(['transition', 'field']),
    status: z.string().optional().describe('For a transition: the status to move to.'),
    resolution: z.string().optional().describe('For a transition: the resolution to set, if any.'),
    field: z.string().optional().describe('For a field change: the field\'s name or id.'),
    value: z.string().optional().describe('For a field change: the new value.'),
  }).optional().describe('ticket-list: a change the user asked for. The board shows it as proposed and writes nothing until the user applies it.'),
};

export const openBoardTool = defineTool<JiraToolDeps, typeof openBoardShape>({
  name: OPEN_BOARD_TOOL,
  title: 'Open a Ticket Sidekick board',
  description:
    'Opens a board in its own editor tab: the security report of a project, a ticket list for a JQL query or saved filter, or the stored sessions. '
    + 'Use it whenever the user asks to see a list of tickets, to search Jira, to change more than one ticket, or for the security report; '
    + 'do not list the tickets in chat and do not change them one by one. For a change to several tickets, pass it as change: the user reviews and applies it on the board. '
    + 'The answer says only whether the board opened, never its content. Changes nothing in Jira.',
  inputSchema: openBoardShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    if (!deps.openBoard) return 'Not opened: boards are not available in this window.';
    const input = args.board === 'security-report' ? { project: args.project }
      : args.board === 'ticket-list' ? { jql: args.jql, filter: args.filter, change: args.change }
        : {};
    const opened = await deps.openBoard(args.board, input);
    return opened.ok ? `Opened in an editor tab: ${opened.title}.` : `Not opened: ${opened.reason}`;
  },
});
