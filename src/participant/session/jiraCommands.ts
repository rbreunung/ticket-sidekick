// The top-level `@jira help` screen, built from one catalog so it cannot drift from the imports the participant
// still offers. Pure (vscode-free); re-exported through ../sessionState.ts. It follows the conventions of the
// import screens' help (`importCommands.ts`): a bold title, flat bullets with the commands in code spans, and a closing
// "`help` prints this list again." sentence. Group headings are the one addition, since this screen lists many areas.
//
// `src/test/jiraCommandsGuard.test.ts` checks that every slash command in package.json and every `Operation` the intent
// parser can return is named in some entry's `covers`.

export const JIRA_HELP_GROUPS = ['Import'] as const;
export type JiraHelpGroup = (typeof JIRA_HELP_GROUPS)[number];

export interface JiraCommandEntry {
  id: string;
  group: JiraHelpGroup;
  /** Syntax and effect, one or two sentences, commands in code spans. */
  help: string;
  /** The slash commands (`/create`) and intent operations (`createTicket`) this entry advertises, as plain strings. */
  covers: readonly string[];
}

/** What `@jira` answers to anything that is not a report import. */
export const JIRA_ONLY_IMPORTS_NOTICE =
  '`@jira` now only imports reports: emails, Veracode Detailed Reports and Waltz OSS Reports. '
  + 'For everything else, ask Copilot in Agent mode, or type `/ts-jira help` to see the commands: '
  + 'viewing, creating, commenting, moving and searching tickets, cleanup rules and the security report all work there.';

export const JIRA_COMMAND_ENTRIES: readonly JiraCommandEntry[] = [
  {
    id: 'email', group: 'Import', covers: ['createFromEmail', 'addEmailComment'],
    help: '`create from email` imports `.eml` files as tickets, and `add email to PROJ-42` adds one as a comment; a preview first lets you strip signatures and boilerplate or keep the email unchanged.',
  },
  {
    id: 'veracode', group: 'Import', covers: ['importVeracode'],
    help: '`import veracode report` creates tickets from a Veracode Detailed Report XML. Inside an import, `help` lists the commands of the screen you are on.',
  },
  {
    id: 'waltz', group: 'Import', covers: ['importWaltzReport'],
    help: '`import oss report` creates tickets from a Waltz OSS Report `.xlsx`. In a Veracode or Waltz import, `export` saves the overview of the project\'s security tickets.',
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
  lines.push('', JIRA_ONLY_IMPORTS_NOTICE, '', '`help` prints this list again.');
  return lines.join('\n');
}
