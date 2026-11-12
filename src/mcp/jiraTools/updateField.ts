import { z } from 'zod';
import { renderFieldValue, supportedFieldId } from '../../services/TicketService';
import { fingerprint } from '../../tools/recentCallGuard';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { fieldValueToJira } from './text';
import { ticketKeyProblem } from './ticketKeyInput';
import { LIST_FIELDS_TOOL, UPDATE_FIELD_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

/** The longest previous value quoted back; a long description is cut. */
const MAX_PREVIOUS_CHARS = 500;

const updateFieldShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  fieldName: z.string().describe('The field, by display name or id: summary, description, priority, assignee, labels, components, fix version, sprint, or any other field such as a custom field.'),
  value: z.string().describe(
    'The new value. The description is written as Markdown and converted to Jira wiki markup; labels and components are comma-separated; '
    + 'assignee is a name, an email or "me"; a sprint by its name.',
  ),
  operation: z.enum(['set', 'add', 'remove']).optional().describe('For a list field such as labels or components: add or remove the given values and keep the others. Default: set, which replaces the whole value.'),
};

export const updateFieldTool = defineTool<JiraToolDeps, typeof updateFieldShape>({
  name: UPDATE_FIELD_TOOL,
  title: 'Update a field of a Jira ticket',
  description:
    'Sets one field of one Jira ticket, named by display name or id: summary, description, priority, assignee, labels, components, fix version, sprint, '
    + 'or any other field such as a custom field. For a list field, operation "add" or "remove" changes single values and keeps the rest. '
    + `When you do not know a field's name, look it up with ${LIST_FIELDS_TOOL}. `
    + 'To set a field on several tickets, open the ticket-list canvas with the change as input.change; do not call this once per ticket. '
    + 'The description is written as Markdown. The answer quotes the value the field had before. '
    + 'The same change to the same field within a minute is skipped, so a repeated call does not write it twice.',
  inputSchema: updateFieldShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const fieldName = args.fieldName.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!fieldName) return 'A field name is required.';

    const operation = args.operation ?? 'set';

    return writeOnce(
      deps.recentWrites,
      fingerprint(UPDATE_FIELD_TOOL, key, supportedFieldId(fieldName) ?? fieldName.toLowerCase(), operation, args.value),
      operation === 'set'
        ? `Skipped: ${fieldName} on ${key} was set to the same value within the last minute. Wait a minute to set it again.`
        : `Skipped: the same values were ${operation === 'add' ? 'added to' : 'removed from'} ${fieldName} on ${key} within the last minute. Wait a minute to do it again.`,
      markWritten => runJiraTool(deps, UPDATE_FIELD_TOOL, `Could not update ${fieldName} on ${key}`, async ({ config, ticketService }) => {
        const fieldMeta = await ticketService.getFieldMeta();
        let fieldId = supportedFieldId(fieldName);
        if (!fieldId) {
          try {
            fieldId = await ticketService.resolveFieldId(fieldName, fieldMeta);
          } catch {
            return `No field named "${fieldName}" was found. Call ${LIST_FIELDS_TOOL} with the ticket key to see its fields. Nothing was changed.`;
          }
        }
        const raw = await ticketService.getRawField(key, fieldId);
        const meta = fieldMeta.find(f => f.id === fieldId);
        const previous = meta ? renderFieldValue(raw, meta) : (raw === null || raw === undefined ? '_Not set_' : String(raw));
        // The everyday fields take Markdown and names as before; any other value goes as typed.
        const value = supportedFieldId(fieldName) && operation === 'set' ? fieldValueToJira(fieldName, args.value) : args.value;
        const outcome = await ticketService.updateAnyField(key, fieldName, value, operation, config.baseUrl);
        if (!outcome.written) return outcome.message;
        markWritten();
        const quoted = previous.length > MAX_PREVIOUS_CHARS ? `${previous.slice(0, MAX_PREVIOUS_CHARS - 1)}…` : previous;
        return `${outcome.message}\n\nPrevious value:\n\n${quoted}`;
      }),
    );
  },
});
