import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatJiraBody } from '../../utils/markdownFormatter';
import { ATTACHMENT_SIZE_LIMIT, classifyAttachmentEligibility, dedupeByLatestFilename, formatFileSize } from '../../utils/attachmentEligibility';
import type { JiraAttachment, JiraComment, JiraFieldMeta, JiraIssue, JiraRemoteLink } from '../../jira/IJiraClient';
import { formatIssueFields, formatKeyLink } from '../../services/TicketService';
import type { TicketService } from '../../services/TicketService';
import type { LoadSkippedSession } from '../sessionState';
import { rewriteAttachmentLinks, buildChatCommandLink } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';

export function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date}):\n${body}`;
  }).join('\n\n---\n\n');
}

/** `.jira-context/<ticketKey>/` under the workspace root — the one place this path is built,
 * shared by the full load core below and `jira_downloadAttachment` (U4), which needs the same
 * layout for a ticket that was never loaded via the full path. */
export function jiraContextDir(wsRoot: vscode.Uri, ticketKey: string): vscode.Uri {
  return vscode.Uri.joinPath(wsRoot, '.jira-context', ticketKey);
}

/** `.jira-context/<ticketKey>/attachments/` — see {@link jiraContextDir}. */
export function attachmentsDirFor(wsRoot: vscode.Uri, ticketKey: string): vscode.Uri {
  return vscode.Uri.joinPath(jiraContextDir(wsRoot, ticketKey), 'attachments');
}

/** Ensures `.jira-context/` is git-ignored at the workspace root — extracted so both the
 * full load core below and `jira_downloadAttachment` (U4, which can run on a ticket that
 * was never loaded) can call it standalone, not only as a step bundled inside a full load
 * (U2/KTD1). */
export async function ensureJiraContextGitignored(wsRoot: vscode.Uri): Promise<void> {
  try {
    let existing = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsRoot, '.gitignore'));
      existing = new TextDecoder().decode(bytes);
    } catch { /* file absent — not logged, this is the normal case for a fresh workspace */ }
    if (!existing.split('\n').some(line => line.trim() === '.jira-context/')) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(wsRoot, '.gitignore'),
        new TextEncoder().encode(existing + prefix + '.jira-context/\n'),
      );
    }
  } catch (err) {
    logDiag('jira.load', 'warn', 'Could not update .gitignore', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface LoadTicketCoreResult {
  downloadedCount: number;
  skipped: LoadSkippedSession['skipped'];
  writeErrors: string[];
}

/** The issue/comments/attachments/remote-links a caller fetches once (chat or a tool) and
 * hands to {@link loadTicketToWorkspace} — grouped so the function doesn't need four separate
 * positional parameters for data that is always fetched and passed together. */
export interface LoadedTicketData {
  issue: JiraIssue;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  remoteLinks: JiraRemoteLink[];
}

/** Field-display options for rendering `ticket.md` — the same shape `formatIssueFields`
 * (`TicketService.ts`) itself takes, grouped here for the same reason as
 * {@link LoadedTicketData}. */
export interface LoadDisplayOptions {
  fieldMeta: JiraFieldMeta[];
  alwaysShowIds: Set<string>;
  hiddenIds: Set<string>;
  baseUrl: string;
}

/** The non-streaming core of a ticket load (KTD2): classify attachments, download the
 * eligible ones, write `ticket.md`/`comments.md`, ensure `.jira-context/` is git-ignored, and
 * build the skipped-attachments list — given already-fetched data so the caller (chat or a
 * tool) fetches Jira exactly once. Never streams or touches `vscode.Memento` —
 * `handleLoadTicket` (chat) owns the ticket-preview stream and the skipped-attachments resume
 * session; `jira_loadTicket` (tool, U3) renders its own single-string result from the returned
 * `LoadTicketCoreResult`. */
export async function loadTicketToWorkspace(
  ticketKey: string,
  ticketService: TicketService,
  data: LoadedTicketData,
  display: LoadDisplayOptions,
  wsRoot: vscode.Uri,
): Promise<LoadTicketCoreResult> {
  const { issue, comments, attachments, remoteLinks } = data;
  const { fieldMeta, alwaysShowIds, hiddenIds, baseUrl } = display;
  const { toDownload: classified, toSkip } = classifyAttachmentEligibility(attachments);
  // Two attachments sharing a filename would otherwise race to write the same
  // attachments/<name> path concurrently below, silently dropping one (code-review fix) —
  // resolved the same "latest created wins" way jira_downloadAttachment resolves it (KTD5).
  const { unique: toDownload, duplicates } = dedupeByLatestFilename(classified);

  // Create directories
  const contextDir = jiraContextDir(wsRoot, ticketKey);
  const attachmentsDir = attachmentsDirFor(wsRoot, ticketKey);
  await vscode.workspace.fs.createDirectory(attachmentsDir);

  // Download attachments (max 3 concurrent)
  const downloaded = new Set<string>();
  const skippedUrls = new Map<string, string>();
  const downloadFailures: JiraAttachment[] = [];
  for (let i = 0; i < toDownload.length; i += 3) {
    await Promise.all(toDownload.slice(i, i + 3).map(async (att) => {
      try {
        const bytes = await ticketService.downloadAttachment(att.content);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, att.filename), bytes);
        downloaded.add(att.filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.load', 'warn', `Attachment download failed — ${att.filename}`, { fileName: att.filename, error: message });
        downloadFailures.push(att);
        skippedUrls.set(att.filename, att.content);
      }
    }));
  }
  for (const att of toSkip) skippedUrls.set(att.filename, att.content);
  for (const att of duplicates) skippedUrls.set(att.filename, att.content);

  // Build ticket.md — suppress built-in attachment section, append custom one
  const hiddenWithAttachment = new Set([...hiddenIds, 'attachment']);
  const { table: mdTable, sections: mdSections } = formatIssueFields(issue, fieldMeta, alwaysShowIds, hiddenWithAttachment, baseUrl);
  if (remoteLinks.length > 0) {
    const lines = remoteLinks.map(r => `- [${r.object.title}](${r.object.url})`);
    mdSections.push(`## Web Links\n\n${lines.join('\n')}`);
  }
  const mdParts: string[] = [`# ${issue.key}: ${issue.fields.summary}`];
  if (mdTable) mdParts.push('', mdTable);
  if (mdSections.length > 0) mdParts.push('', ...mdSections);
  if (attachments.length > 0) {
    // duplicateIds guards the `downloaded` filename check below: a losing duplicate shares its
    // filename with the winner that was actually written, so a filename-only lookup would
    // otherwise show both as "downloaded" from the same path (code-review fix).
    const duplicateIds = new Set(duplicates.map(a => a.id));
    const attLines = attachments.map(att => {
      const size = formatFileSize(att.size);
      if (duplicateIds.has(att.id)) return `- \`${att.filename}\` — ${size} — skipped (duplicate filename)`;
      if (downloaded.has(att.filename)) return `- \`attachments/${att.filename}\` — ${size} (${att.mimeType})`;
      if (att.size > ATTACHMENT_SIZE_LIMIT) return `- \`${att.filename}\` — ${size} — skipped (over 100 MB size limit)`;
      return `- \`${att.filename}\` — ${size} — skipped (binary non-image)`;
    });
    mdParts.push('', `## Attachments\n\n${attLines.join('\n')}`);
  }
  const ticketMd = rewriteAttachmentLinks(mdParts.join('\n'), downloaded, skippedUrls);

  // Build comments.md
  const commentBlocks = comments.map((c, i) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim();
    return `## ${i + 1}. ${c.author.displayName} (${date})\n\n${body}`;
  });
  const rawCommentsMd = comments.length > 0
    ? `# Comments — ${ticketKey}\n\n${commentBlocks.join('\n\n---\n\n')}`
    : `# Comments — ${ticketKey}\n\n_No comments._`;
  const commentsMd = rewriteAttachmentLinks(rawCommentsMd, downloaded, skippedUrls);

  // Write files
  const writeErrors: string[] = [];
  const enc = new TextEncoder();
  for (const [name, content] of [['ticket.md', ticketMd], ['comments.md', commentsMd]] as const) {
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(contextDir, name), enc.encode(content));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.load', 'warn', `Could not write ${name}`, { fileName: name, error: message });
      writeErrors.push(`${name}: ${message}`);
    }
  }

  await ensureJiraContextGitignored(wsRoot);

  // Build skipped list (oversized + unknown binary + same-filename duplicates + download failures)
  const skipped: LoadSkippedSession['skipped'] = [
    ...toSkip.map(a => ({
      filename: a.filename, content: a.content, size: a.size, mimeType: a.mimeType,
      reason: a.size > ATTACHMENT_SIZE_LIMIT ? 'over 100 MB size limit' : 'unknown binary format',
    })),
    ...duplicates.map(a => ({
      filename: a.filename, content: a.content, size: a.size, mimeType: a.mimeType,
      reason: 'duplicate filename — use jira_downloadAttachment to fetch it by name',
    })),
    ...downloadFailures.map(a => ({
      filename: a.filename, content: a.content, size: a.size, mimeType: a.mimeType, reason: 'download failed',
    })),
  ];

  return { downloadedCount: downloaded.size, skipped, writeErrors };
}

export async function handleLoadTicket(
  ticketKey: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  fieldMeta: JiraFieldMeta[],
  alwaysShowIds: Set<string>,
  hiddenIds: Set<string>,
): Promise<boolean> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    stream.markdown('No workspace folder is open. Open a folder to use `@jira load`.');
    return false;
  }
  const wsRoot = workspaceFolder.uri;

  const issue = await ticketService.getIssue(ticketKey);
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
    wsRoot,
  );

  // Stream summary
  const summaryLines: string[] = [`\n\nLoaded **${issue.key}** into \`.jira-context/${ticketKey}/\``];
  summaryLines.push(`- \`ticket.md\` — metadata and description`);
  summaryLines.push(`- \`comments.md\` — ${comments.length} comment${comments.length !== 1 ? 's' : ''}`);
  if (downloadedCount > 0) summaryLines.push(`- \`attachments/\` — ${downloadedCount} file${downloadedCount !== 1 ? 's' : ''} downloaded`);
  if (writeErrors.length > 0) summaryLines.push(`\n_Write errors:_\n${writeErrors.map(e => `- ${e}`).join('\n')}`);
  stream.markdown(summaryLines.join('\n'));

  if (skipped.length > 0) {
    const listLines = skipped.map((s, i) =>
      `${i + 1}. ${buildChatCommandLink(`\`${s.filename}\` — ${formatFileSize(s.size)} (${s.mimeType}) — ${s.reason}`, '@jira', String(i + 1))}`,
    );
    stream.markdown(trustedChatMarkdown(
      `\n\n**Skipped attachments:**\n\n${listLines.join('\n')}\n\nReply with a number to download it anyway.`,
    ));
    await ws.update('jira.session.loadSkipped', { ticketKey, skipped } satisfies LoadSkippedSession);
    stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    return true;
  }
  stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
  return false;
}
