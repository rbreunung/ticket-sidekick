import { z } from 'zod';
import { TicketService } from '../../services/TicketService';
import { TemplateService, type JiraTemplate } from '../../templates/TemplateService';
import { buildTemplateFromCandidates, formatTemplateFieldValue, nextFreeTemplateName } from '../../templates/templateFromTicket';
import { fingerprint } from '../../tools/recentCallGuard';
import { defineTool, type ConfirmationLine } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { CREATE_TEMPLATE_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

// Saves a new ticket template, built from a reference ticket's fields, to `.jira-templates.json` in
// the first workspace folder. The confirmation shows the whole entry; it is the only review, and a
// field nobody wants is removed from the file afterwards. A taken name gets the next free number.

const createTemplateShape = {
  ticketKey: z.string().describe('The reference ticket, e.g. PROJ-123. Its issue type and its template fields (priority, labels, components, sprint, team) are copied.'),
  name: z.string().describe('The name of the new template, as the user gave it.'),
};

const NO_FOLDER = 'No workspace folder is open — templates are saved to .jira-templates.json in the workspace root. Nothing was saved.';

/** The template as it would be saved now, or why it cannot be built. */
async function buildTemplate(
  ticketService: TicketService,
  folder: string,
  key: string,
  name: string,
  hiddenFields: readonly string[],
): Promise<{ template: JiraTemplate; renamed: boolean } | { problem: string }> {
  let existing: string[];
  try {
    existing = new TemplateService(folder).loadTemplates().templates.map(t => t.name);
  } catch (err) {
    return { problem: `${err instanceof Error ? err.message : String(err)}. Fix or remove the file first. Nothing was saved.` };
  }
  const issue = await ticketService.getIssue(key);
  const issueType = (issue.fields.issuetype as { name?: string } | undefined)?.name;
  if (!issueType) return { problem: `Could not read the issue type of ${key}. Nothing was saved.` };
  const candidates = await ticketService.getTemplateCandidatesFromTicket(key, undefined, new Set(hiddenFields));
  const savedAs = nextFreeTemplateName(name, existing);
  return { template: buildTemplateFromCandidates(savedAs, issueType, candidates), renamed: savedAs !== name };
}

function describeTemplate(template: JiraTemplate, asked: string, renamed: boolean): ConfirmationLine[] {
  const fields = Object.entries(template.defaultFields);
  return [
    { name: 'Saved as', value: renamed ? `${template.name} (the name "${asked}" is taken)` : template.name },
    { name: 'Issue type', value: template.issueType ?? '' },
    {
      name: 'Fields',
      value: fields.length === 0 ? 'none: the ticket sets no template fields' : fields.map(([id, value]) => `${id}: ${formatTemplateFieldValue(value)}`).join('\n'),
    },
  ];
}

export const createTemplateTool = defineTool<JiraToolDeps, typeof createTemplateShape>({
  name: CREATE_TEMPLATE_TOOL,
  title: 'Create a ticket template from a Jira ticket',
  description:
    'Saves a new ticket template to the workspace\'s .jira-templates.json, built from one reference ticket: its issue type and the '
    + 'values of its template fields (priority, labels, components, sprint, team). Fields that are empty on the ticket are left out. '
    + 'When a template with that name exists, the new one is saved as "<name> (2)", "<name> (3)" and so on; no template is replaced. '
    + 'Ask the user for the name before calling. The same template within a minute is skipped.',
  inputSchema: createTemplateShape,
  annotations: { destructiveHint: true },
  preview: async (args, deps) => {
    const access = await deps.getJira();
    const folder = deps.workspaceFolders()[0];
    if (!access.configured || !folder) return [];
    const built = await buildTemplate(new TicketService(access.client), folder, args.ticketKey.trim(), args.name.trim(), access.config.hiddenDisplayFields);
    return 'problem' in built ? [{ name: 'Will be refused', value: built.problem }] : describeTemplate(built.template, args.name.trim(), built.renamed);
  },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const name = args.name.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!name) return 'A template name is required. Ask the user for one. Nothing was saved.';
    const folder = deps.workspaceFolders()[0];
    if (!folder) return NO_FOLDER;

    return writeOnce(
      deps.recentWrites,
      fingerprint(CREATE_TEMPLATE_TOOL, folder, key, name),
      `Skipped: a template "${name}" from ${key} was saved within the last minute.`,
      markWritten => runJiraTool(deps, CREATE_TEMPLATE_TOOL, `Could not create a template from ${key}`, async ({ config, ticketService }) => {
        const built = await buildTemplate(ticketService, folder, key, name, config.hiddenDisplayFields);
        if ('problem' in built) return built.problem;
        try {
          // The name was free a moment ago; a template saved meanwhile under it is never replaced.
          const saved = new TemplateService(folder).saveTemplate(built.template);
          if (saved.status === 'collision') return `A template named "${built.template.name}" was saved meanwhile. Call again to save under the next free name. Nothing was saved.`;
        } catch (err) {
          return `${err instanceof Error ? err.message : String(err)}. Nothing was saved.`;
        }
        markWritten();
        deps.onDiag?.('info', `Template saved — ${built.template.name}`, { ticketKey: key, issueType: built.template.issueType });
        const lines = describeTemplate(built.template, name, built.renamed);
        return [
          `Saved the template "${built.template.name}" (${built.template.issueType}) from ${key} to .jira-templates.json.`,
          '',
          ...lines.slice(1).map(l => `${l.name}:\n${l.value}`),
          '',
          `To create a ticket from it: /ts-jira-create <what the ticket is about> using the template "${built.template.name}"`,
        ].join('\n');
      }),
    );
  },
});
