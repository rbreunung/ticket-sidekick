// Pure confirmation-text and result-message builders shared by the Jira Agent Mode write tools,
// plus the template list the MCP list-templates tool answers with.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { formatFileSize } from '../../utils/attachmentEligibility';
import { LIST_TEMPLATES_TOOL } from '../../mcp/jiraTools/toolNames';
import type { ToolConfirmation } from '../../tools/toolConfirmation';
import type { JiraTemplate, ResolveSpec } from '../../templates/TemplateService';
import { formatBulletList } from './primitives';

// ---------------------------------------------------------------------------------------------
// Language Model tools (Agent Mode) — pure confirmation-text and result-message builders shared
// by every `jira_*` tool in `src/tools/jiraTools.ts`. Kept here (rather than in jiraTools.ts,
// which imports `vscode` and is not Vitest-loadable) so this wording is unit-tested the same way
// every other user-facing message in this file is. `jiraTools.ts` stays thin glue: it resolves
// live data (current field values, project issue types, workflow graphs) via TicketService/
// WorkflowService/TemplateService and hands it to these functions to render.
// ---------------------------------------------------------------------------------------------

/** Renders a "current → new" change, e.g. `Critical → High` (KTD3). Shared by every builder
 * below that shows a before/after value. */
export function formatFieldChangeDisplay(currentValue: string, newValue: string): string {
  return `${currentValue} → ${newValue}`;
}

/** Confirmation for `jira_updateField` — always shows current → new (KTD3), even when the
 * current value could not be fetched (the caller passes a placeholder string in that case; the
 * confirmation still renders, it just can't show a real "before"). */
export function buildUpdateFieldConfirmation(
  ticketKey: string,
  fieldName: string,
  currentValue: string,
  newValue: string,
): ToolConfirmation {
  return {
    title: `Update ${fieldName} on ${ticketKey}`,
    message: `Set **${fieldName}** on **${ticketKey}**: ${formatFieldChangeDisplay(currentValue, newValue)}`,
  };
}

/** Confirmation for `jira_addComment` — names the ticket and shows the literal comment text. */
export function buildAddCommentConfirmation(ticketKey: string, comment: string): ToolConfirmation {
  return {
    title: `Add comment to ${ticketKey}`,
    message: `Post this comment on **${ticketKey}**:\n\n${comment}`,
  };
}

/** Confirmation for `jira_createTicket` — names project/type/summary (KTD4). `issueType` is
 * `null` when it hasn't been resolved yet at confirmation time (e.g. it depends on a template);
 * `invoke()` itself still enforces the never-guess fallback (KTD4) regardless of what this
 * confirmation showed. */
export function buildCreateTicketConfirmation(
  projectKey: string,
  issueType: string | null,
  summary: string,
  templateName: string | null,
  resolvedFields?: Record<string, unknown> | null,
): ToolConfirmation {
  const typeLabel = issueType ? `a **${issueType}**` : 'a ticket (issue type to be resolved)';
  const templateNote = templateName ? ` using template **${templateName}**` : '';
  return {
    title: `Create ticket in ${projectKey}`,
    message: `Create ${typeLabel} in **${projectKey}**${templateNote}: "${summary}"${formatResolvedFieldsNote(resolvedFields)}`,
  };
}

/** Lists the template's own default field values below the main confirmation line, so approving
 * a template-driven create isn't blind to what the template silently sets beyond project/type/
 * summary. `description` is left out — it's already shown separately by the caller when given. */
function formatResolvedFieldsNote(resolvedFields?: Record<string, unknown> | null): string {
  if (!resolvedFields) return '';
  const entries = Object.entries(resolvedFields).filter(([key]) => key !== 'description');
  if (entries.length === 0) return '';
  const lines = entries.map(([key, value]) => `- **${key}**: ${formatResolvedFieldValue(value)}`);
  return `\n\nTemplate will also set:\n${lines.join('\n')}`;
}

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

/** Confirmation for `jira_transitionTicket` — names the ticket and the target status.
 * `currentStatus` is `null` when it couldn't be fetched at confirmation time. */
export function buildTransitionConfirmation(
  ticketKey: string,
  currentStatus: string | null,
  targetStatus: string,
  resolution?: string,
): ToolConfirmation {
  const fromLabel = currentStatus ? `**${currentStatus}**` : 'its current status';
  const resNote = resolution ? ` (resolution: ${resolution})` : '';
  return {
    title: `Move ${ticketKey} to ${targetStatus}`,
    message: `Transition **${ticketKey}** from ${fromLabel} to **${targetStatus}**${resNote}.`,
  };
}

/** Confirmation for `jira_uploadAttachment` — names the ticket, file path, and size (R10). `size`
 * is `null` when it couldn't be read at confirmation time (e.g. the path doesn't exist yet); the
 * confirmation still renders, `invoke()` re-validates existence and size independently (KTD1). */
export function buildUploadAttachmentConfirmation(ticketKey: string, filePath: string, size: number | null): ToolConfirmation {
  const sizeNote = size !== null ? ` (${formatFileSize(size)})` : '';
  return {
    title: `Upload ${filePath} to ${ticketKey}`,
    message: `Upload \`${filePath}\`${sizeNote} as an attachment to **${ticketKey}**.`,
  };
}

/** The never-guess fallback text for `jira_createTicket` (KTD4): when neither `issueType` nor a
 * resolvable `templateName` was given, nothing is created and this lists the project's valid
 * issue types (from `TicketService.getIssueTypes`) as the actionable next step — mirrors the
 * chat create flow's own never-guess sentinel handling
 * (docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md)
 * adapted from a `showInputBox` prompt to a returned list, since Agent Mode has no interactive
 * input box to fall back to. */
export function formatIssueTypeOptionsMessage(projectKey: string, issueTypes: string[]): string {
  if (issueTypes.length === 0) {
    return (
      `No ticket was created: no issue type or resolvable template was given for project ${projectKey}, ` +
      `and its issue types could not be fetched from Jira. Call jira_createTicket again with an explicit "issueType".`
    );
  }
  const list = formatBulletList(issueTypes);
  return (
    `No ticket was created: no issue type or resolvable template was given. Valid issue types for **${projectKey}**:\n\n${list}\n\n` +
    `Call jira_createTicket again with one of these as "issueType", or with a "templateName" from ${LIST_TEMPLATES_TOOL}.`
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
