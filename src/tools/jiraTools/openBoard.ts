import * as path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { defineTool } from '../toolDefinition';
import { narrowQuery, resolveFilter } from './findTickets';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { OPEN_BOARD_TOOL } from './toolNames';

// Opens a board in an editor tab of the VS Code window. The extension fills the board itself; the
// answer says only whether it opened, so a list of tickets or a report never enters the chat.

const openBoardShape = {
  board: z.enum(['security-report', 'ticket-list', 'sessions', 'import']).describe(
    'security-report: a project\'s open Veracode and Waltz tickets by release. ticket-list: the tickets of a JQL query or saved filter, '
    + 'where the user selects tickets and moves them or sets a field, or a cleanup rule\'s tickets. sessions: the stored board sessions of this workspace. '
    + 'import: imports a Veracode Detailed Report or a Waltz OSS Report into Jira tickets.',
  ),
  kind: z.enum(['veracode', 'waltz']).optional().describe('import: the report kind, veracode (Detailed Report XML) or waltz (OSS Report .xlsx).'),
  path: z.string().optional().describe('import: the report file, a path in the workspace or an absolute path or file URI, e.g. a file dragged into the chat.'),
  project: z.string().optional().describe('security-report: the Jira project key, e.g. PROJ. Leave out to use the default project.'),
  jql: z.string().optional().describe('ticket-list: a JQL query, e.g. project = PROJ AND status = Done.'),
  filter: z.string().optional().describe('ticket-list: a saved filter\'s id or name, in place of jql.'),
  cleanupRule: z.string().optional().describe('ticket-list: the name of a cleanup rule in .jira-templates.json, in place of jql or filter; \"<rule> in <version>\" also names a fix version. The board moves the rule\'s tickets to its target status.'),
  fixVersion: z.string().optional().describe(
    'ticket-list: with jql or filter, narrow to a fix version by name. With cleanupRule, the fix version in place of the rule\'s own: '
    + 'released, unreleased, a pattern with *, or a version name ("released" in double quotes for a version of that name).',
  ),
  sprint: z.string().optional().describe('ticket-list with jql or filter: narrow to a sprint, by name.'),
  assignee: z.string().optional().describe('ticket-list with jql or filter: narrow to an assignee, a user name or "me".'),
  myTeam: z.boolean().optional().describe('ticket-list with jql or filter: narrow by the team JQL of the ticketSidekick.jira.myTeamJql setting.'),
  change: z.object({
    type: z.enum(['transition', 'field']),
    status: z.string().optional().describe('For a transition: the status to move to.'),
    resolution: z.string().optional().describe('For a transition: the resolution to set, if any.'),
    field: z.string().optional().describe('For a field change: the field\'s name or id.'),
    value: z.string().optional().describe('For a field change: the new value.'),
    operation: z.enum(['set', 'add', 'remove']).optional().describe('For a list field such as labels: add or remove the value and keep the others. Default: set.'),
  }).optional().describe('ticket-list: a change the user asked for. The board shows it as proposed and writes nothing until the user applies it.'),
};

/** The board name of the import start screen (`IMPORT_START_BOARD` in src/boards/import/startScreen.ts). */
const IMPORT_START_BOARD = 'import-start';

/** An absolute path for a report path, workspace-relative path or file URI; undefined when a relative path has no workspace to resolve against. */
function reportPathOf(value: string, workspaceFolder: string | undefined): string | undefined {
  let p = value.trim();
  if (p.startsWith('file:')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(p)) return p;
  return workspaceFolder ? path.resolve(workspaceFolder, p) : undefined;
}

export const openBoardTool = defineTool<JiraToolDeps, typeof openBoardShape>({
  name: OPEN_BOARD_TOOL,
  title: 'Open a Ticket Sidekick board',
  description:
    'Opens a board in its own editor tab: the security report of a project, a ticket list for a JQL query or saved filter, the stored sessions, '
    + 'or the import board for a Veracode or Waltz report. '
    + 'Use it whenever the user asks to see a list of tickets, to search Jira, to change more than one ticket, or for the security report; '
    + 'do not list the tickets in chat and do not change them one by one. For a change to several tickets, pass it as change: the user reviews and applies it on the board. '
    + 'For a cleanup by a rule from .jira-templates.json, pass the rule\'s name as cleanupRule. Narrow a list with fixVersion, sprint, assignee or myTeam instead of writing those clauses into jql yourself. '
    + 'For a report import, pass board import with kind and path; the user reviews and creates the tickets on the board. '
    + 'The answer says only whether the board opened, never its content. Changes nothing in Jira.',
  inputSchema: openBoardShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    if (!deps.openBoard) return 'Not opened: boards are not available in this window.';
    const open = async (input: unknown) => {
      const opened = await deps.openBoard!(args.board, input);
      return opened.ok ? `Opened in an editor tab: ${opened.title}.` : `Not opened: ${opened.reason}`;
    };
    if (args.board === 'security-report') return open({ project: args.project });
    if (args.board === 'sessions') return open({});
    if (args.board === 'import') {
      // The start screen, opened as the import board when the file reads and the template and project settings are complete.
      const reportPath = args.kind && args.path ? reportPathOf(args.path, deps.workspaceFolders()[0]) : undefined;
      const opened = await deps.openBoard(IMPORT_START_BOARD, { kind: args.kind, ...(reportPath ? { reportPath } : {}), openWhenReady: true });
      return opened.ok ? `Opened in an editor tab: ${opened.title}.` : `Not opened: ${opened.reason}`;
    }

    const narrowing = { fixVersion: args.fixVersion, sprint: args.sprint, assignee: args.assignee, myTeam: args.myTeam };
    if (args.cleanupRule) {
      if (args.jql || args.filter) return 'Not opened: give a cleanup rule, a JQL query or a filter, not more than one.';
      if (args.sprint || args.assignee || args.myTeam) return 'Not opened: a cleanup rule is narrowed by fixVersion only; the rule itself says which tickets it closes.';
      if (args.change) return 'Not opened: a cleanup moves tickets to its rule\'s target status; leave change out.';
      return open({ cleanupRule: args.cleanupRule, ...(args.fixVersion ? { fixVersion: args.fixVersion } : {}) });
    }
    const narrows = Boolean(args.fixVersion?.trim() || args.sprint?.trim() || args.assignee?.trim() || args.myTeam);
    if (!narrows) return open({ jql: args.jql, filter: args.filter, change: args.change });
    if ((args.jql ? 1 : 0) + (args.filter ? 1 : 0) !== 1) return 'Not opened: narrowing needs either jql or filter.';

    // The narrowed query is worked out here, with Jira's names, and the board opens on it.
    let answer: string | undefined;
    const failed = await runJiraTool(deps, OPEN_BOARD_TOOL, 'Not opened', async ({ access, config, ticketService }) => {
      let base = args.jql ?? '';
      if (args.filter) {
        const resolved = await resolveFilter(args.filter, ticketService);
        if (typeof resolved === 'string') return `Not opened: ${resolved}`;
        base = resolved.jql;
      }
      const narrowed = await narrowQuery(base, narrowing, { client: access.client, myTeamJql: config.myTeamJql }, OPEN_BOARD_TOOL);
      if (typeof narrowed === 'string') return `Not opened: ${narrowed}`;
      answer = await open({ jql: narrowed.jql, change: args.change });
      return answer;
    });
    return answer ?? failed;
  },
});
