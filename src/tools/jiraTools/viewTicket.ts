import { z } from 'zod';
import type { JiraAttachment, JiraComment } from '../../jira/IJiraClient';
import { formatCommentsInFull } from '../../participant/sessionState';
import { formatFileSize } from '../../utils/attachmentEligibility';
import { newestFirst } from '../../utils/requirementsSource';
import { resolveTicketKey } from '../branchTicket';
import { defineTool } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { VIEW_TICKET_TOOL } from './toolNames';

// The whole ticket in one answer: the fields the display settings choose, the full description,
// the attachments and the comments, newest first. Without a key, the key in the current git
// branch is used, and the answer says where it came from.

export const MAX_VIEW_COMMENTS = 100;

function attachmentsSection(attachments: JiraAttachment[]): string {
  if (attachments.length === 0) return '## Attachments\n\nNo attachments.';
  const lines = attachments.map(a => `- ${a.filename} — ${formatFileSize(a.size)} (${a.mimeType})`);
  return `## Attachments (${attachments.length})\n\n${lines.join('\n')}`;
}

function commentsSection(comments: JiraComment[]): string {
  if (comments.length === 0) return '## Comments\n\nNo comments.';
  const shown = newestFirst(comments).slice(0, MAX_VIEW_COMMENTS);
  const left = comments.length - shown.length;
  const note = left > 0
    ? `\n\n_${left} older comment${left === 1 ? '' : 's'} left out; only the newest ${MAX_VIEW_COMMENTS} are shown._`
    : '';
  return `## Comments (${comments.length}, newest first)\n\n${formatCommentsInFull(shown)}${note}`;
}

export const viewTicketTool = defineTool<JiraToolDeps, { ticketKey: z.ZodOptional<z.ZodString> }>({
  name: VIEW_TICKET_TOOL,
  title: 'View a Jira ticket',
  description:
    'Shows one Jira ticket in full: the fields chosen by the Ticket Sidekick display settings, the whole description, '
    + `the attachments (name, size and type) and the comments, newest first, up to ${MAX_VIEW_COMMENTS}, with a note when older ones are left out. `
    + 'Without ticketKey, uses the ticket key in the current git branch of the first workspace folder and says which folder and branch it used, '
    + 'or that the branch holds no key. Changes nothing.',
  inputSchema: {
    ticketKey: z.string().optional().describe('The ticket key, e.g. PROJ-123. Leave it out to use the key in the current git branch.'),
  },
  annotations: { readOnlyHint: true },
  handler: async ({ ticketKey }, deps) => {
    let subject = ticketKey?.trim() || 'the ticket';
    return runJiraTool(deps, VIEW_TICKET_TOOL, () => `Could not read ${subject}`, async ({ config, ticketService }) => {
      const resolved = await resolveTicketKey(ticketKey, deps.workspaceFolders(), VIEW_TICKET_TOOL, deps.onDiag);
      if (resolved.kind === 'answer') return resolved.text;
      const { key, sourceNote } = resolved;
      subject = resolved.failureSubject;

      const [issue, fieldMeta, comments] = await Promise.all([
        ticketService.getIssue(key),
        ticketService.getFieldMeta(),
        ticketService.getAllComments(key),
      ]);
      // The description is always part of the view and the attachments get their own list below,
      // so the display settings decide every other field.
      const alwaysShow = new Set(config.additionalDisplayFields.filter(id => id !== 'attachment'));
      const hidden = new Set([...config.hiddenDisplayFields.filter(id => id !== 'description'), 'attachment']);
      const fields = await ticketService.renderTicket(issue, fieldMeta, alwaysShow, hidden, config.baseUrl);
      return `${sourceNote}${fields}\n\n${attachmentsSection(ticketService.getAttachments(issue))}\n\n${commentsSection(comments)}`;
    });
  },
});
