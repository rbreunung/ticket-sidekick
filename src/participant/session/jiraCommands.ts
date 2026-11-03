// The top-level `@jira help` screen, built from one catalog so it cannot drift from the commands and operations the
// participant offers. Pure (vscode-free); re-exported through ../sessionState.ts. It follows the conventions of the
// import screens' help (`importCommands.ts`): a bold title, flat bullets with the commands in code spans, and a closing
// "`help` prints this list again." sentence. Group headings are the one addition, since this screen lists many areas.
//
// `src/test/jiraCommandsGuard.test.ts` checks that every slash command in package.json and every `Operation` the intent
// parser can return is named in some entry's `covers`.

export const JIRA_HELP_GROUPS = ['Tickets', 'Bulk work and setup', 'Import', 'Security report'] as const;
export type JiraHelpGroup = (typeof JIRA_HELP_GROUPS)[number];

export interface JiraCommandEntry {
  id: string;
  group: JiraHelpGroup;
  /** Syntax and effect, one or two sentences, commands in code spans. */
  help: string;
  /** The slash commands (`/create`) and intent operations (`createTicket`) this entry advertises, as plain strings. */
  covers: readonly string[];
}

export const JIRA_COMMAND_ENTRIES: readonly JiraCommandEntry[] = [
  // --- Tickets ---
  {
    id: 'create', group: 'Tickets', covers: ['/create', 'createTicket'],
    help: '`/create` or `create a bug in PROJ: login fails after password reset` picks the template and issue type, shows a preview, and creates the ticket when you reply `create it`.',
  },
  {
    id: 'view', group: 'Tickets', covers: ['/view', 'getTicket', 'summarizeTicket', 'showFields', 'validateFields'],
    help: '`/view PROJ-123` shows a ticket\'s fields, description and comments; `summarize PROJ-123` gives a one-paragraph synthesis, `show fields on PROJ-123` lists every field with its ID, and `check required fields on PROJ-123` validates them.',
  },
  {
    id: 'comments', group: 'Tickets', covers: ['/comment', 'addComment', 'showComments', 'getComments'],
    help: '`/comment PROJ-123 thanks, looks good to merge` adds a comment; `show comments` lists them in full and `what do the comments say about the login bug?` summarizes them.',
  },
  {
    id: 'field', group: 'Tickets', covers: ['/field', 'updateField'],
    help: '`/field PROJ-123 set priority to High` updates a field by name or ID; `add frontend to labels`, `remove backend from labels` and `assign to me` work too. Without a key it uses the ticket from your current git branch.',
  },
  {
    id: 'move', group: 'Tickets', covers: ['/move', 'transition'],
    help: '`/move PROJ-123 to In Progress` moves a ticket to a new status; add `with resolution "Not a Bug"` to set a resolution in the same step.',
  },
  {
    id: 'search', group: 'Tickets', covers: ['/search', 'searchJql', 'listMyFilters', 'bulkTransition', 'multiTicketTransition', 'bulkUpdateField'],
    help: '`/search my open bugs in PROJ` searches with JQL or plain language, `show my filters` runs your saved filters, and on a result `transition these tickets` or `set priority to High on these tickets` changes them all.',
  },
  {
    id: 'load', group: 'Tickets', covers: ['/load', 'loadTicket'],
    help: '`/load PROJ-123` downloads the description, comments and attachments into `.jira-context/PROJ-123/` in your workspace.',
  },
  {
    id: 'upload', group: 'Tickets', covers: ['uploadAttachment'],
    help: '`upload the report to PROJ-123` attaches local files to a ticket after a confirmation.',
  },
  {
    id: 'spell-check', group: 'Tickets', covers: ['spellCheck'],
    help: '`spell check PROJ-123` proofreads the description and shows the corrections before saving.',
  },

  // --- Bulk work and setup ---
  {
    id: 'cleanup', group: 'Bulk work and setup', covers: ['runCleanup'],
    help: '`run cleanup "Close released bugs"` or `close PROJ Bug` reviews tickets against your `cleanupRules` and moves them in one batch.',
  },
  {
    id: 'workflow', group: 'Bulk work and setup', covers: ['discoverWorkflow'],
    help: '`discover workflow for PROJ Bug` maps the status transitions for a project and issue type.',
  },
  {
    id: 'template', group: 'Bulk work and setup', covers: ['generateTemplate'],
    help: '`generate a template from PROJ-123 called "Billing Bug"` saves a reusable ticket template after you review it.',
  },
  {
    id: 'check', group: 'Bulk work and setup', covers: ['/check'],
    help: '`/check` verifies the connection and credentials and shows the active configuration.',
  },

  // --- Import ---
  {
    id: 'email', group: 'Import', covers: ['createFromEmail', 'addEmailComment'],
    help: '`create from email` imports `.eml` files as tickets, and `add email to PROJ-42` adds one as a comment; signatures and boilerplate are stripped first, after a preview.',
  },
  {
    id: 'veracode', group: 'Import', covers: ['importVeracode'],
    help: '`import veracode report` creates tickets from a Veracode Detailed Report XML. Inside an import, `help` lists the commands of the screen you are on.',
  },
  {
    id: 'waltz', group: 'Import', covers: ['importWaltzReport'],
    help: '`import oss report` creates tickets from a Waltz OSS Report `.xlsx`. In a Veracode or Waltz import, `export` gives the same report as `/security-report`.',
  },

  // --- Security report ---
  {
    id: 'security-report', group: 'Security report', covers: ['/security-report'],
    help: '`/security-report PROJ` lists the project\'s open Veracode and Waltz tickets by Fix Version with their Due Dates, flagged ⚠ overdue or ⚠ due before release; `/security-report PROJ csv` or `/security-report PROJ xlsx` saves them as a file.',
  },
];

/** The version comes from package.json at runtime; keep only version-shaped characters so it cannot alter the markdown. */
function safeVersion(version: string): string {
  const cleaned = version.replace(/[^A-Za-z0-9.+-]/g, '');
  return cleaned || 'unknown';
}

/** The full `@jira help` screen: title with the tool name and version, one heading per group with its bullets, and the closing sentence. */
export function buildJiraHelp(version: string): string {
  const lines = [`**Ticket Sidekick \`@jira\` · v${safeVersion(version)} — Help**`];
  for (const group of JIRA_HELP_GROUPS) {
    lines.push('', `**${group}**`);
    for (const entry of JIRA_COMMAND_ENTRIES.filter(e => e.group === group)) lines.push(`- ${entry.help}`);
  }
  lines.push('', '`help` prints this list again.');
  return lines.join('\n');
}
