import * as fs from 'fs';
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
    + 'import: imports a Veracode Detailed Report, a Waltz OSS Report or .eml emails into Jira tickets.',
  ),
  kind: z.enum(['veracode', 'waltz', 'email']).optional().describe('import: the report kind, veracode (Detailed Report XML), waltz (OSS Report .xlsx) or email (.eml files).'),
  path: z.string().optional().describe('import: the report file, a path in the workspace or an absolute path or file URI, e.g. a file dragged into the chat.'),
  paths: z.array(z.string()).max(50).optional().describe('import with kind email: the .eml files, in place of path, each like path.'),
  dragged: z.boolean().optional().describe('import with kind email: true when the user dragged the emails into the chat, which counts as agreeing to the model check of their text.'),
  project: z.string().optional().describe('security-report: the Jira project key, e.g. PROJ. Leave out to use the default project.'),
  jql: z.string().optional().describe('ticket-list: a JQL query, e.g. project = PROJ AND status = Done.'),
  filter: z.string().optional().describe('ticket-list: a saved filter\'s id or name, or one of Jira\'s built-in filters such as -1 (My open issues), in place of jql.'),
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

/** The title of the import start screen (`IMPORT_START_TITLE` in src/boards/import/startScreen.ts). */
const IMPORT_START_TITLE = 'Jira Import Board';

/**
 * Whether a path names a file on another machine: a UNC path (`\\server\share`, `//server/share`)
 * or a file URI with a host. The start screen reads the report as soon as it opens, so a network
 * path from a prompt would make VS Code connect to that machine (and on Windows send the user's
 * credentials) before the user did anything. Such a report is picked in the file dialog instead.
 */
export function isNetworkPath(value: string): boolean {
  const p = value.trim();
  if (/^[\\/]{2}/.test(p)) return true;
  if (/^file:/i.test(p)) {
    try {
      const host = new URL(p).hostname;
      return host !== '' && host.toLowerCase() !== 'localhost';
    } catch {
      return false;
    }
  }
  return false;
}

/** An absolute path for a report path, workspace-relative path or file URI; undefined when a relative path has no workspace to resolve against. */
function reportPathOf(value: string, workspaceFolder: string | undefined): string | undefined {
  let p = value.trim();
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(p)) return p;
  return workspaceFolder ? path.resolve(workspaceFolder, p) : undefined;
}

/**
 * The first email path an agent gave that the board must not read: its real path (links followed) is
 * not an `.eml` file, or runs through a dotfile or dotfolder such as `.ssh`. An agent steered by text
 * it read could otherwise put any local file in front of the user as an email to send to Jira. A
 * path that does not exist passes; the start screen says it is missing.
 */
async function refusedEmailPath(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    const real = await fs.promises.realpath(p).catch(() => p);
    const hidden = real.split(/[\\/]/).some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
    if (hidden || path.extname(real).toLowerCase() !== '.eml') return p;
  }
  return undefined;
}

export const openBoardTool = defineTool<JiraToolDeps, typeof openBoardShape>({
  name: OPEN_BOARD_TOOL,
  title: 'Open a Ticket Sidekick board',
  description:
    'Opens a board in its own editor tab: the security report of a project, a ticket list for a JQL query or saved filter, the stored sessions, '
    + 'or the Jira Import Board for a Veracode or Waltz report or for .eml emails. '
    + 'Use it whenever the user asks to see a list of tickets, to search Jira, to change more than one ticket, or for the security report; '
    + 'do not list the tickets in chat and do not change them one by one. For a change to several tickets, pass it as change: the user reviews and applies it on the board. '
    + 'For a cleanup by a rule from .jira-templates.json, pass the rule\'s name as cleanupRule. Narrow a list with fixVersion, sprint, assignee or myTeam instead of writing those clauses into jql yourself. '
    + 'For a report import, pass board import with kind and path; the user reviews and creates the tickets on the board. '
    + 'For emails, pass kind email with paths, and dragged true when the user dragged them into the chat; the user creates tickets or adds the emails as comments on the board. '
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
      const given = [...(args.path ? [args.path] : []), ...(args.paths ?? [])];
      if (given.some(isNetworkPath)) {
        return 'Not opened: the report is on another machine (a network path). Ask the user to copy it into the workspace or to choose it in the Jira Import Board\'s file dialog.';
      }
      // The start screen, opened as the import board when the files read and the template and project settings are complete.
      const resolved = args.kind ? given.map(p => reportPathOf(p, deps.workspaceFolders()[0])).filter((p): p is string => p !== undefined) : [];
      if (args.kind === 'email') {
        const refused = await refusedEmailPath(resolved);
        if (refused) return `Not opened: "${refused}" is not an .eml file outside a dotfile or dotfolder. Ask the user to choose the emails in the Jira Import Board's file dialog.`;
      }
      const files = args.kind === 'email'
        ? { ...(resolved.length > 0 ? { reportPaths: resolved } : {}), ...(args.dragged === true ? { emailConsent: true } : {}) }
        : resolved[0] ? { reportPath: resolved[0] } : {};
      const opened = await deps.openBoard(IMPORT_START_BOARD, { kind: args.kind, ...files, openWhenReady: true });
      if (!opened.ok) return `Not opened: ${opened.reason}`;
      // Only whether the tab opened, plus whether the report was loaded, so the agent does not claim more than happened.
      if (opened.title === IMPORT_START_TITLE) {
        return `Opened in an editor tab: ${opened.title}. The report was not loaded: the user finishes the choices on the start screen.`;
      }
      return `Opened in an editor tab: ${opened.title}.`;
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
