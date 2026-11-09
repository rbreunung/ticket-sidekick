import { z } from 'zod';
import type { IJiraClient } from '../../jira/IJiraClient';
import { formatIssueTypeOptionsMessage } from '../../participant/sessionState';
import { FieldResolver } from '../../templates/FieldResolver';
import { TemplateService } from '../../templates/TemplateService';
import { fingerprint } from '../../tools/recentCallGuard';
import type { DiagLogger } from '../../utils/diagTypes';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { CREATE_TICKET_TOOL, LIST_TEMPLATES_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

// Creates one ticket, preferably from a workspace template (`.jira-templates.json`, the file
// `@jira` reads). The issue type is never guessed: without one, and without a template that names
// one, the answer lists the project's issue types and nothing is created.

const createShape = {
  projectKey: z.string().describe('The project key, e.g. PROJ.'),
  summary: z.string().describe('The ticket title, one line.'),
  templateName: z.string().optional().describe(`A template name from ${LIST_TEMPLATES_TOOL}; its issue type and fields are applied.`),
  issueType: z.string().optional().describe('The issue type, e.g. Bug. Needed when no template gives one.'),
  description: z.string().optional().describe('The description, written as Markdown; it is converted to Jira wiki markup.'),
};

/** The longest field value quoted back in the list of template fields applied. */
const MAX_FIELD_VALUE_CHARS = 120;

type TemplateFields =
  | { kind: 'resolved'; issueType?: string; fields: Record<string, unknown> }
  | { kind: 'none'; note?: string };

async function templateFields(
  client: IJiraClient,
  folder: string | undefined,
  projectKey: string,
  templateName: string,
  onDiag?: DiagLogger,
): Promise<TemplateFields> {
  if (!folder) return { kind: 'none', note: 'No workspace folder is open, so no template was applied.' };
  let templates;
  try {
    ({ templates } = new TemplateService(folder).loadTemplates());
  } catch (err) {
    onDiag?.('warn', 'Could not load templates for a create', { error: err instanceof Error ? err.message : String(err) });
    return { kind: 'none', note: 'The workspace templates could not be read, so no template was applied.' };
  }
  const template = templates.find(t => t.name === templateName);
  if (!template) return { kind: 'none', note: `No template is named "${templateName}" (see ${LIST_TEMPLATES_TOOL}).` };
  // A template whose fields cannot be resolved stops the create: the error reaches the agent as a failure.
  const fields = await new FieldResolver(client, projectKey).resolve(template.defaultFields, template.resolveFields);
  return { kind: 'resolved', issueType: template.issueType, fields };
}

function fieldValueText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_FIELD_VALUE_CHARS ? `${text.slice(0, MAX_FIELD_VALUE_CHARS - 1)}…` : text;
}

export const createTicketTool = defineTool<JiraToolDeps, typeof createShape>({
  name: CREATE_TICKET_TOOL,
  title: 'Create a Jira ticket',
  description:
    `Creates one Jira ticket. For a ticket the user asks for in their own words, follow the ts-jira-create skill first: it picks a template and shows the user a draft. `
    + `Prefer a templateName from ${LIST_TEMPLATES_TOOL}: the template gives the issue type and default fields. `
    + 'Without a template, give the issueType; the issue type is never guessed, so a call without either lists the project\'s issue types '
    + 'and creates nothing. Write the description as Markdown. The answer names the template fields applied. '
    + 'The same ticket requested again within a minute is skipped.',
  inputSchema: createShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const projectKey = args.projectKey.trim();
    const summary = args.summary.trim();
    const templateName = args.templateName?.trim() || undefined;
    const requestedType = args.issueType?.trim() || undefined;
    const description = args.description?.trim() || undefined;
    if (!projectKey) return 'A project key is required, e.g. PROJ.';
    if (!summary) return 'A summary is required.';
    if (/[\r\n]/.test(summary)) return 'The summary must be one line.';

    return writeOnce(
      deps.recentWrites,
      fingerprint(CREATE_TICKET_TOOL, projectKey, summary, requestedType ?? '', templateName ?? '', description ?? ''),
      `Skipped: the same ticket was created in ${projectKey} within the last minute. Change something or wait a minute to create it again.`,
      markWritten => runJiraTool(deps, CREATE_TICKET_TOOL, `Could not create the ticket in ${projectKey}`, async ({ access, config, ticketService }) => {
        let issueType = requestedType;
        let fields: Record<string, unknown> = {};
        let templateNote = '';
        if (templateName) {
          const template = await templateFields(access.client, deps.workspaceFolders()[0], projectKey, templateName, deps.onDiag);
          if (template.kind === 'resolved') {
            issueType ??= template.issueType;
            fields = template.fields;
          } else if (template.note) {
            templateNote = template.note;
          }
        }
        if (!issueType) {
          let issueTypes: string[] = [];
          try {
            issueTypes = (await ticketService.getIssueTypes(projectKey)).map(t => t.name);
          } catch (err) {
            deps.onDiag?.('warn', 'Could not read the issue types for a create', { error: err instanceof Error ? err.message : String(err) });
          }
          return [templateNote, formatIssueTypeOptionsMessage(projectKey, issueTypes)].filter(Boolean).join('\n\n');
        }

        // The answer lists only the template values the ticket was created with: a description given
        // here replaces the template's, and the answer says so instead of claiming the template's.
        const replacedDescription = description !== undefined && 'description' in fields;
        const applied = Object.entries(fields).filter(([id]) => !(replacedDescription && id === 'description'));
        const templateFieldLines = applied.map(([id, value]) => `- ${id}: ${fieldValueText(value)}`);
        const created = await ticketService.createTicket(
          projectKey, summary, issueType,
          description ? { ...fields, description: markdownToJiraWiki(description) } : fields,
          config.baseUrl,
        );
        markWritten();
        const parts = [created.message];
        if (templateFieldLines.length > 0) parts.push(`Template fields applied from "${templateName}":\n${templateFieldLines.join('\n')}`);
        if (replacedDescription) parts.push(`The description given replaced the template's description.`);
        if (templateNote) parts.push(templateNote);
        if (created.droppedFields?.length) parts.push(`Jira refused ${created.droppedFields.join(', ')}, so the ticket was created without it.`);
        return parts.join('\n\n');
      }),
    );
  },
});
