import { z } from 'zod';
import {
  absolutePathIn,
  jiraContextDir,
  loadTicketToWorkspace,
  nodeFsWriter,
  type LoadTicketCoreResult,
  type SkippedAttachment,
} from './loadCore';
import { formatFileSize } from '../../utils/attachmentEligibility';
import { resolveTicketKey } from '../branchTicket';
import { defineTool } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { LOAD_TICKET_TOOL } from './toolNames';

// Loads a ticket into `.jira-context/<KEY>/` in the first workspace folder: `ticket.md`, `comments.md` and the attachments the default filter lets
// through, plus the attachments named in the call. The answer names every file written by its
// absolute path and every attachment left out with its size and the reason.

const loadShape = {
  ticketKey: z.string().optional().describe('The ticket key, e.g. PROJ-123. Leave it out to use the key in the current git branch.'),
  attachments: z.array(z.string()).optional().describe(
    'Attachment filenames to download as well, exactly as the ticket lists them, including ones the default filter skips '
    + '(such as binary files). Files over 100 MB are never downloaded.',
  ),
};

/** Skipped attachments that calling the tool again with their names can still fetch. */
const FETCHABLE: ReadonlySet<SkippedAttachment['cause']> = new Set(['not-default-type', 'download-failed']);

function resultMessage(key: string, folder: string, commentCount: number, allNames: string[], result: LoadTicketCoreResult): string {
  const abs = (rel: string) => absolutePathIn(folder, rel);
  const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`;
  // Only the two files the load renders get a description; an attachment may share their names.
  const describe = (rel: string): string => {
    if (rel === `${jiraContextDir(key)}/ticket.md`) return ': fields, description, web links, attachment list';
    if (rel === `${jiraContextDir(key)}/comments.md`) {
      return `: ${plural(commentCount, 'comment')}${commentCount > 0 ? ' (read these too: they often hold details missing from the description)' : ''}`;
    }
    return '';
  };
  const lines = [
    `Loaded ${key} into \`${abs(jiraContextDir(key))}\`. Files written:`,
    ...result.writtenFiles.map(rel => `- \`${abs(rel)}\`${describe(rel)}`),
  ];
  if (result.gitignoreUpdated) lines.push(`Added \`.jira-context/\` to \`${abs('.gitignore')}\`.`);
  lines.push(
    'Read these files by their exact paths (the folder is git-ignored, so file search may not list it). '
    + "If the user's request already asks to analyze the ticket or write a report, continue now using these files as the ticket's content; "
    + 'if the user only asked to download it, stop here and ask what to do next.',
  );
  if (result.notFound.length > 0) {
    const missing = result.notFound.map(n => `\`${n}\``).join(', ');
    const existing = allNames.length > 0 ? ` Its attachments are: ${allNames.join(', ')}.` : ' It has no attachments.';
    lines.push('', `${key} has no attachment named ${missing}.${existing}`);
  }
  if (result.skipped.length > 0) {
    const line = (s: SkippedAttachment) => `${s.filename} (${formatFileSize(s.size)}): ${s.reason}`;
    // Fetching is by name, so a name skipped twice is offered once.
    const fetchable = result.skipped.filter((s, i, all) => FETCHABLE.has(s.cause) && all.findIndex(o => o.filename === s.filename) === i);
    const fetchableNames = new Set(fetchable.map(s => s.filename));
    const other = result.skipped.filter(s => !FETCHABLE.has(s.cause) || !fetchableNames.has(s.filename));
    if (fetchable.length > 0) {
      lines.push('', 'Attachments not downloaded, which can still be fetched:', ...fetchable.map((s, i) => `${i + 1}. ${line(s)}`));
    }
    if (other.length > 0) {
      lines.push('', 'Not downloadable:', ...other.map(s => `- ${line(s)}`));
    }
    if (fetchable.length > 0) {
      lines.push(
        '',
        'Show the user the numbered list above exactly as written, after your answer, and ask which to download: '
        + 'numbers such as "1, 2", or "all". '
        + `When they answer, call ${LOAD_TICKET_TOOL} with ticketKey "${key}" and attachments set to the chosen names. `
        + "Do not download them without asking, unless the user's request already named them.",
      );
    }
  }
  if (result.writeErrors.length > 0) lines.push('', `Write errors: ${result.writeErrors.join('; ')}`);
  return lines.join('\n');
}

export const loadTicketTool = defineTool<JiraToolDeps, typeof loadShape>({
  name: LOAD_TICKET_TOOL,
  title: 'Load a Jira ticket into the workspace',
  description:
    'Use when the user asks to load or download a ticket, e.g. "load PROJ-123". '
    + 'Downloads one Jira ticket into `.jira-context/<KEY>/` in the first workspace folder, so its content can be read as local files: '
    + '`ticket.md` (fields, description, web links, attachment list), `comments.md` (all comments) and, in `attachments/`, '
    + 'the text, image, document and archive attachments. Binary attachments of other types are skipped unless named in attachments; '
    + 'files over 100 MB are always skipped. The answer lists every file written by its absolute path and every skipped attachment '
    + 'with its size and the reason. Without ticketKey, uses the ticket key in the current git branch of the first workspace folder '
    + 'and says which folder and branch it used. Changes nothing in Jira; it only writes local files, overwriting an earlier load.',
  inputSchema: loadShape,
  annotations: {},
  handler: async ({ ticketKey, attachments }, deps) => {
    let subject = ticketKey?.trim() || 'the ticket';
    return runJiraTool(deps, LOAD_TICKET_TOOL, () => `Could not load ${subject}`, async ({ config, ticketService }) => {
      const folder = deps.workspaceFolders()[0];
      if (!folder) return 'No workspace folder is open: the ticket is loaded into `.jira-context/<KEY>/` in the first workspace folder.';

      // The key goes into the path written, so an unsafe one is refused before anything is written.
      const resolved = await resolveTicketKey(ticketKey, [folder], LOAD_TICKET_TOOL, deps.onDiag);
      if (resolved.kind === 'answer') return resolved.text;
      const { key, sourceNote } = resolved;
      subject = resolved.failureSubject;

      const [issue, comments, fieldMeta, remoteLinks] = await Promise.all([
        ticketService.getIssue(key),
        ticketService.getAllComments(key),
        ticketService.getFieldMeta(),
        ticketService.getRemoteLinks(key),
      ]);
      const ticketAttachments = ticketService.getAttachments(issue);
      const result = await loadTicketToWorkspace(
        key, ticketService,
        { issue, comments, attachments: ticketAttachments, remoteLinks },
        {
          fieldMeta,
          alwaysShowIds: new Set(config.additionalDisplayFields),
          hiddenIds: new Set(config.hiddenDisplayFields),
          baseUrl: config.baseUrl,
        },
        nodeFsWriter(folder),
        { attachments, onDiag: deps.onDiag },
      );
      deps.onDiag?.('info', 'Ticket loaded', {
        writtenCount: result.writtenFiles.length,
        skippedCount: result.skipped.length,
        notFoundCount: result.notFound.length,
      });
      return sourceNote + resultMessage(key, folder, comments.length, ticketAttachments.map(a => a.filename), result);
    });
  },
});
