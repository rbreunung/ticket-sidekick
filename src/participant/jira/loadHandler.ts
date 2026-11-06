import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatJiraBody } from '../../utils/markdownFormatter';
import { formatFileSize } from '../../utils/attachmentEligibility';
import type { DiagLogger } from '../../utils/diagTypes';
import type { JiraComment, JiraFieldMeta } from '../../jira/IJiraClient';
import { formatIssueFields, formatKeyLink } from '../../services/TicketService';
import type { TicketService } from '../../services/TicketService';
import { rewriteAttachmentLinks, extractProjectKeyFromTicketKey, neutralizeMarkdownLinks } from '../sessionState';
import { LOAD_TICKET_TOOL } from '../../mcp/jiraTools/toolNames';
import { loadTicketToWorkspace, type LoadWriter, type SkipCause } from './loadCore';

export function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date}):\n${body}`;
  }).join('\n\n---\n\n');
}

/** A load writer over VS Code's file system, rooted at the workspace folder `root`. */
export function workspaceFsWriter(root: vscode.Uri): LoadWriter {
  const at = (relPath: string) => vscode.Uri.joinPath(root, ...relPath.split('/'));
  return {
    createDirectory: async relPath => { await vscode.workspace.fs.createDirectory(at(relPath)); },
    writeFile: async (relPath, bytes) => { await vscode.workspace.fs.writeFile(at(relPath), bytes); },
    readFile: async relPath => vscode.workspace.fs.readFile(at(relPath)),
  };
}

/** Load diagnostics go to the Output channel under the `jira.load` scope. */
const logLoadDiag: DiagLogger = (level, message, details) => logDiag('jira.load', level, message, details);

/** Skip causes that the Copilot tool can fetch again when the attachment is named in its call. */
const REFETCHABLE: ReadonlySet<SkipCause> = new Set(['not-default-type', 'download-failed']);

/** {@link handleLoadTicket}'s result: the loaded ticket's own project key/issue type — read off
 * the issue this function already fetches internally, so the `loadedTicket` follow-up chips
 * built from it never need a second `getIssue` call. */
export interface LoadTicketResult {
  projectKey: string;
  issueType: string;
}

export async function handleLoadTicket(
  ticketKey: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  fieldMeta: JiraFieldMeta[],
  alwaysShowIds: Set<string>,
  hiddenIds: Set<string>,
): Promise<LoadTicketResult> {
  // No issue fetched yet on this early-out — fall back to the key's own project prefix and an
  // unknown issue type, same as elsewhere in this file when there's nothing better to read.
  const noWorkspaceResult: LoadTicketResult = {
    projectKey: extractProjectKeyFromTicketKey(ticketKey) ?? ticketKey.split('-')[0],
    issueType: '',
  };
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    stream.markdown('No workspace folder is open. Open a folder to use `@jira load`.');
    return noWorkspaceResult;
  }
  const wsRoot = workspaceFolder.uri;

  const issue = await ticketService.getIssue(ticketKey);
  const projectKey = extractProjectKeyFromTicketKey(ticketKey) ?? ticketKey.split('-')[0];
  const issueType = (issue.fields.issuetype as { name?: string } | undefined)?.name ?? '';
  const comments = await ticketService.getAllComments(ticketKey);
  const attachments = ticketService.getAttachments(issue);

  // Stream ticket content first (same as @jira show)
  // Build a map of all attachment filenames → Jira content URLs for link rewriting
  const allAttachmentUrls = new Map(attachments.map(a => [a.filename, a.content]));

  // Stream ticket content first (same as @jira show), with inline attachment links
  // rewritten to their Jira URLs so they are clickable in the chat.
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';
  const { table, sections } = formatIssueFields(issue, fieldMeta, alwaysShowIds, hiddenIds, baseUrl);
  const remoteLinks = await ticketService.getRemoteLinks(ticketKey);
  if (remoteLinks.length > 0) {
    const lines = remoteLinks.map(r => `- [${r.object.title}](${r.object.url})`);
    sections.push(`## Web Links\n\n${lines.join('\n')}`);
  }
  const heading = `## ${formatKeyLink(issue.key, baseUrl)}: ${issue.fields.summary}`;
  const showParts: string[] = [heading];
  if (table) showParts.push('', table);
  if (sections.length > 0) showParts.push('', ...sections);
  stream.markdown(rewriteAttachmentLinks(showParts.join('\n'), new Set(), allAttachmentUrls));

  const { downloadedCount, skipped, writeErrors } = await loadTicketToWorkspace(
    ticketKey, ticketService,
    { issue, comments, attachments, remoteLinks },
    { fieldMeta, alwaysShowIds, hiddenIds, baseUrl },
    workspaceFsWriter(wsRoot),
    { onDiag: logLoadDiag },
  );

  // Stream summary
  const summaryLines: string[] = [`\n\nLoaded **${issue.key}** into \`.jira-context/${ticketKey}/\``];
  summaryLines.push(`- \`ticket.md\` — metadata and description`);
  summaryLines.push(`- \`comments.md\` — ${comments.length} comment${comments.length !== 1 ? 's' : ''}`);
  if (downloadedCount > 0) summaryLines.push(`- \`attachments/\` — ${downloadedCount} file${downloadedCount !== 1 ? 's' : ''} downloaded`);
  if (writeErrors.length > 0) summaryLines.push(`\n_Write errors:_\n${writeErrors.map(e => `- ${e}`).join('\n')}`);
  stream.markdown(summaryLines.join('\n'));

  if (skipped.length > 0) {
    // Every skipped attachment is a plain line; names come from Jira, so they are neutralized.
    const lines = skipped.map(s => s.cause === 'unsafe-filename'
      ? `- Not downloaded because the name is unsafe: \`${neutralizeMarkdownLinks(s.filename)}\` (${formatFileSize(s.size)})`
      : `- \`${neutralizeMarkdownLinks(s.filename)}\` — ${formatFileSize(s.size)} (${neutralizeMarkdownLinks(s.mimeType)}) — ${s.reason}`);
    const parts = ['\n\n**Skipped attachments:**', lines.join('\n')];
    if (skipped.some(s => REFETCHABLE.has(s.cause))) {
      parts.push(`_To fetch one of these anyway, ask Copilot to load it with the \`${LOAD_TICKET_TOOL}\` tool, naming the attachment._`);
    }
    stream.markdown(parts.join('\n\n'));
  }
  return { projectKey, issueType };
}
