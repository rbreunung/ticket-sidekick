import { formatTemplateListWithDefaults } from '../../participant/sessionState';
import { TemplateService } from '../../templates/TemplateService';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { LIST_TEMPLATES_TOOL } from './toolNames';

// The ticket templates of the workspace (`.jira-templates.json` in the first workspace folder,
// the file `@jira` reads), each with the fields it sets. Reading them needs no Jira connection.

export const listTemplatesTool = defineTool<JiraToolDeps, Record<string, never>>({
  name: LIST_TEMPLATES_TOOL,
  title: 'List the Jira ticket templates',
  description:
    'Lists the ticket templates defined in the workspace\'s .jira-templates.json: each template\'s name, its issue type, '
    + 'the default field values it sets, the fields it looks up when a ticket is created, and its description sections. '
    + 'Takes no input and changes nothing.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async (_args, deps) => {
    const folder = deps.workspaceFolders()[0];
    if (!folder) return 'No workspace folder is open — templates are read from .jira-templates.json in the workspace root.';
    try {
      return formatTemplateListWithDefaults(new TemplateService(folder).loadTemplates().templates);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.onDiag?.('error', `${LIST_TEMPLATES_TOOL} failed`, { error: message });
      return `Could not load templates: ${message.split(/\r?\n/)[0].slice(0, 160)}`;
    }
  },
});
