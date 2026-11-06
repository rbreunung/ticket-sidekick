import { z } from 'zod';
import { renderFieldValue, supportedFieldId } from '../../services/TicketService';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { fieldValueToJira } from './text';
import { ticketKeyProblem } from './ticketKeyInput';
import { UPDATE_FIELD_TOOL } from './toolNames';

/** The longest previous value quoted back; a long description is cut. */
const MAX_PREVIOUS_CHARS = 500;

const updateFieldShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  fieldName: z.string().describe('The field: summary, description, priority, assignee, labels, components or fix version.'),
  value: z.string().describe(
    'The new value. The description is written as Markdown and converted to Jira wiki markup; labels and components are comma-separated; '
    + 'assignee is a name, an email or "me".',
  ),
};

export const updateFieldTool = defineTool<JiraToolDeps, typeof updateFieldShape>({
  name: UPDATE_FIELD_TOOL,
  title: 'Update a field of a Jira ticket',
  description:
    'Sets one field of a Jira ticket: summary, description, priority, assignee, labels, components or fix version. '
    + 'The description is written as Markdown. The answer quotes the value the field had before.',
  inputSchema: updateFieldShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const fieldName = args.fieldName.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!fieldName) return 'A field name is required.';

    return runJiraTool(deps, UPDATE_FIELD_TOOL, `Could not update ${fieldName} on ${key}`, async ({ config, ticketService }) => {
      const fieldId = supportedFieldId(fieldName);
      // An unsupported field is answered by updateField itself, with the supported list, before any write.
      if (!fieldId) return ticketService.updateField(key, fieldName, args.value, config.baseUrl);

      const [fieldMeta, raw] = await Promise.all([ticketService.getFieldMeta(), ticketService.getRawField(key, fieldId)]);
      const meta = fieldMeta.find(f => f.id === fieldId);
      const previous = meta ? renderFieldValue(raw, meta) : (raw === null || raw === undefined ? '_Not set_' : String(raw));
      const answer = await ticketService.updateField(key, fieldName, fieldValueToJira(fieldName, args.value), config.baseUrl);
      if (!answer.startsWith('Updated ')) return answer;
      const quoted = previous.length > MAX_PREVIOUS_CHARS ? `${previous.slice(0, MAX_PREVIOUS_CHARS - 1)}…` : previous;
      return `${answer}\n\nPrevious value:\n\n${quoted}`;
    });
  },
});
