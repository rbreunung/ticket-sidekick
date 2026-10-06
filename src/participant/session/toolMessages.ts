// Pure confirmation-text and result-message builders shared by the `jira_*` Agent Mode tools.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { formatFileSize } from '../../utils/attachmentEligibility';
import type { ToolConfirmation } from '../../tools/toolConfirmation';
import { formatBulletList } from './primitives';
import { LoadSkippedSession } from './sessionTypes';

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

/** Confirmation for `jira_loadTicket` — names the ticket and the target folder (R4).
 * Deterministic from `ticketKey` alone, so `prepareInvocation()` needs no network call. */
export function buildLoadTicketConfirmation(ticketKey: string): ToolConfirmation {
  return {
    title: `Load ${ticketKey}`,
    message: `Load **${ticketKey}**'s description, comments, and attachments into \`.jira-context/${ticketKey}/\`.`,
  };
}

/** Result text for `jira_loadTicket` (R8/KTD4) — names the files it wrote as available for
 * follow-up reading and explicitly asks the calling model to check with the user before
 * reading them to analyze the ticket, rather than continuing on its own: Agent Mode tool
 * calls have no chip mechanism (chips are `@jira` chat-only), so this returned text is the
 * only channel available to steer that next step toward the user's decision. */
export function buildLoadTicketResultMessage(
  ticketKey: string,
  commentCount: number,
  downloadedCount: number,
  skipped: LoadSkippedSession['skipped'],
  writeErrors: string[],
): string {
  const files = ['ticket.md', 'comments.md'];
  if (downloadedCount > 0) files.push('attachments/');
  const lines = [
    `Loaded ${ticketKey} into \`.jira-context/${ticketKey}/\` (${files.join(', ')}) — ${commentCount} comment${commentCount !== 1 ? 's' : ''}` +
      `${downloadedCount > 0 ? `, ${downloadedCount} attachment${downloadedCount !== 1 ? 's' : ''} downloaded` : ''}.`,
    'Ask the user before reading these to analyze the ticket. Make no assumption.',
  ];
  if (skipped.length > 0) {
    const names = skipped.map(s => s.filename).join(', ');
    lines.push(`${skipped.length} attachment${skipped.length !== 1 ? 's' : ''} skipped (oversized or an unrecognized type): ${names}. Call jira_downloadAttachment to fetch one by name.`);
  }
  if (writeErrors.length > 0) {
    lines.push(`Write errors: ${writeErrors.join('; ')}`);
  }
  return lines.join('\n');
}

/** Confirmation for `jira_downloadAttachment` — names the ticket, filename, and target path (R10). */
export function buildDownloadAttachmentConfirmation(ticketKey: string, filename: string): ToolConfirmation {
  return {
    title: `Download ${filename} from ${ticketKey}`,
    message: `Download **${filename}** from **${ticketKey}** into \`.jira-context/${ticketKey}/attachments/${filename}\`.`,
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

/** Not-found message for `jira_downloadAttachment` (R10/KTD5) — lists the ticket's actual
 * attachment filenames instead of a raw not-found error, so the calling model can retry with
 * a correct one. */
export function buildAttachmentNotFoundMessage(ticketKey: string, filename: string, availableFilenames: string[]): string {
  if (availableFilenames.length === 0) {
    return `${ticketKey} has no attachments. "${filename}" does not exist on this ticket.`;
  }
  return `"${filename}" does not exist on ${ticketKey}. Its attachments are:\n\n${formatBulletList(availableFilenames)}`;
}

/** Result text for `jira_downloadAttachment` on success (R9/R10, KTD5) — names the ticket,
 * filename, and target path, and, when the filename matched more than one attachment, says a
 * duplicate was resolved to the most recently created one. */
export function buildDownloadAttachmentResultMessage(ticketKey: string, filename: string, matchCount: number): string {
  const base = `Downloaded **${filename}** from **${ticketKey}** into \`.jira-context/${ticketKey}/attachments/${filename}\`.`;
  if (matchCount > 1) {
    return `${base} ${matchCount} attachments on this ticket share that filename — the most recently created one was used.`;
  }
  return base;
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
    `Call jira_createTicket again with one of these as "issueType", or with a "templateName" from jira_listTemplates.`
  );
}

/** Result text for `jira_listTemplates` — a missing/empty `.jira-templates.json` is a normal,
 * error-free outcome (an empty list), not a failure. */
export function formatTemplateListMessage(templates: Array<{ name: string; issueType?: string }>): string {
  if (templates.length === 0) {
    return 'No templates found. Create a `.jira-templates.json` file in the workspace root to define reusable ticket templates.';
  }
  const list = formatBulletList(
    templates.map(t => `**${t.name}**${t.issueType ? ` (${t.issueType})` : ' (issue type not set on the template)'}`),
  );
  return `Available templates:\n\n${list}`;
}
