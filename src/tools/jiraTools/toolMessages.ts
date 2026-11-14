// Pure message builders for the Jira tools: the issue-type list the create ticket tool answers
// with when it has no issue type, and the template list the list-templates tool answers with.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { CREATE_TICKET_TOOL, LIST_TEMPLATES_TOOL } from './toolNames';
import type { JiraTemplate, ResolveSpec } from '../../templates/TemplateService';
import { formatBulletList } from '../../utils/chatPrimitives';

/** A template field value as text: a name or value object by its name, a list joined by commas. */
function formatResolvedFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '_(not set)_';
  if (Array.isArray(value)) return value.map((v) => formatResolvedFieldValue(v)).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.value === 'string') return obj.value;
    return JSON.stringify(value);
  }
  return String(value);
}

/** The never-guess fallback text for the create ticket tool (KTD4): when neither `issueType` nor a
 * resolvable `templateName` was given, nothing is created and this lists the project's valid
 * issue types (from `TicketService.getIssueTypes`) as the actionable next step — mirrors the
 * chat create flow's own never-guess sentinel handling
 * (docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md)
 * adapted from a `showInputBox` prompt to a returned list, since a tool has no interactive
 * input box to fall back to. */
export function formatIssueTypeOptionsMessage(projectKey: string, issueTypes: string[]): string {
  if (issueTypes.length === 0) {
    return (
      `No ticket was created: no issue type or resolvable template was given for project ${projectKey}, ` +
      `and its issue types could not be fetched from Jira. Call ${CREATE_TICKET_TOOL} again with an explicit "issueType".`
    );
  }
  const list = formatBulletList(issueTypes);
  return (
    `No ticket was created: no issue type or resolvable template was given. Valid issue types for **${projectKey}**:\n\n${list}\n\n` +
    `Call ${CREATE_TICKET_TOOL} again with one of these as "issueType", or with a "templateName" from ${LIST_TEMPLATES_TOOL}.`
  );
}

const NO_TEMPLATES_MESSAGE =
  'No templates found. Create a `.jira-templates.json` file in the workspace root to define reusable ticket templates.';

function formatTemplateHeading(t: { name: string; issueType?: string }): string {
  return `**${t.name}**${t.issueType ? ` (${t.issueType})` : ' (issue type not set on the template)'}`;
}

function formatResolveSpec(spec: ResolveSpec): string {
  return spec.id !== undefined ? `${spec.type} id ${spec.id}` : `${spec.type} "${spec.name ?? ''}", looked up when the ticket is created`;
}

/**
 * The template list with what each template sets: its default field values, the fields it looks
 * up by name when a ticket is created, and its description sections. An agent's create call
 * names only the template, so this is where the values a template adds can be seen beforehand.
 */
export function formatTemplateListWithDefaults(templates: JiraTemplate[]): string {
  if (templates.length === 0) return NO_TEMPLATES_MESSAGE;
  const blocks = templates.map(t => {
    const lines = Object.entries(t.defaultFields ?? {}).map(([field, value]) => `  - ${field}: ${formatResolvedFieldValue(value)}`);
    for (const [field, spec] of Object.entries(t.resolveFields ?? {})) {
      const specs = Array.isArray(spec) ? spec : [spec];
      lines.push(`  - ${field}: ${specs.map(formatResolveSpec).join(', ')}`);
    }
    if (t.descriptionSections && t.descriptionSections.length > 0) lines.push(`  - Description sections: ${t.descriptionSections.join(', ')}`);
    if (lines.length === 0) lines.push('  - no default fields');
    return [`- ${formatTemplateHeading(t)}`, ...lines].join('\n');
  });
  return `Available templates:\n\n${blocks.join('\n')}`;
}
