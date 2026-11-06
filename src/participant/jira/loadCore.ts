import * as fs from 'fs';
import * as path from 'path';
import type { JiraAttachment, JiraComment, JiraFieldMeta, JiraIssue, JiraRemoteLink } from '../../jira/IJiraClient';
import { formatIssueFields } from '../../services/TicketService';
import type { TicketService } from '../../services/TicketService';
import { isSafeFilename } from '../../tools/pathSafety';
import {
  ATTACHMENT_SIZE_LIMIT,
  classifyAttachmentEligibility,
  dedupeByLatestFilename,
  formatFileSize,
} from '../../utils/attachmentEligibility';
import type { DiagLogger } from '../../utils/diagTypes';
import { formatJiraBody } from '../../utils/markdownFormatter';
import type { LoadSkippedSession } from '../sessionState';
import { rewriteAttachmentLinks } from '../sessionState';

// Loads a Jira ticket into `.jira-context/<KEY>/` under a workspace folder: `ticket.md`,
// `comments.md` and the attachments the default filter lets through, plus any attachments named
// by the caller. It writes through a small writer, so `@jira load` writes with VS Code's file
// system and the MCP load tool with Node's, and this module stays free of `vscode`.

/**
 * Writes below one workspace folder. Every path is relative to that folder and uses `/` as its
 * separator.
 */
export interface LoadWriter {
  /** Creates the folder and any missing parents. */
  createDirectory(relPath: string): Promise<void>;
  writeFile(relPath: string, bytes: Uint8Array): Promise<void>;
  /** Rejects when the file does not exist. */
  readFile(relPath: string): Promise<Uint8Array>;
}

/** `relPath` (relative, `/`-separated) as a path under `root` on this machine. */
export function absolutePathIn(root: string, relPath: string): string {
  return path.join(root, ...relPath.split('/'));
}

/** A writer over Node's file system, rooted at the workspace folder `root`. */
export function nodeFsWriter(root: string): LoadWriter {
  return {
    createDirectory: async relPath => { await fs.promises.mkdir(absolutePathIn(root, relPath), { recursive: true }); },
    writeFile: (relPath, bytes) => fs.promises.writeFile(absolutePathIn(root, relPath), bytes),
    readFile: async relPath => fs.promises.readFile(absolutePathIn(root, relPath)),
  };
}

/** `.jira-context/<KEY>`, relative to the workspace folder. The key must be a safe path segment. */
export function jiraContextDir(ticketKey: string): string {
  return `.jira-context/${ticketKey}`;
}

/** `.jira-context/<KEY>/attachments`, relative to the workspace folder. */
export function attachmentsDir(ticketKey: string): string {
  return `${jiraContextDir(ticketKey)}/attachments`;
}

/**
 * Where an attachment is written, relative to the workspace folder, or `undefined` when its Jira
 * filename is unsafe: one that is not a single path segment, or that would resolve to a path
 * outside the ticket's attachments folder.
 */
export function attachmentPath(ticketKey: string, filename: string): string | undefined {
  if (!isSafeFilename(filename)) return undefined;
  const dir = attachmentsDir(ticketKey);
  const target = path.posix.normalize(`${dir}/${filename.replace(/\\/g, '/')}`);
  return target.startsWith(`${dir}/`) && target.length > dir.length + 1 ? target : undefined;
}

/**
 * Makes sure `.jira-context/` is git-ignored at the workspace folder root, appending it to
 * `.gitignore` when missing. Returns whether `.gitignore` was changed; a failure is logged and
 * does not stop the load.
 */
async function ensureJiraContextGitignored(writer: LoadWriter, onDiag?: DiagLogger): Promise<boolean> {
  try {
    let existing = '';
    try {
      existing = new TextDecoder().decode(await writer.readFile('.gitignore'));
    } catch { /* no .gitignore yet: the normal case for a fresh workspace */ }
    if (existing.split('\n').some(line => line.trim() === '.jira-context/')) return false;
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writer.writeFile('.gitignore', new TextEncoder().encode(existing + prefix + '.jira-context/\n'));
    return true;
  } catch (err) {
    onDiag?.('warn', 'Could not update .gitignore', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Why an attachment was not written. */
export type SkipCause = 'too-large' | 'not-default-type' | 'duplicate' | 'download-failed' | 'unsafe-filename';

export type SkippedAttachment = LoadSkippedSession['skipped'][number] & { cause: SkipCause };

export interface LoadTicketCoreResult {
  downloadedCount: number;
  /** Filenames written to `attachments/`. */
  downloadedFiles: string[];
  skipped: SkippedAttachment[];
  /** Names in the requested list that no attachment of the ticket has. */
  notFound: string[];
  /** Every file written, relative to the workspace folder: `ticket.md` and `comments.md` first, then the attachments. */
  writtenFiles: string[];
  /** Whether `.jira-context/` was added to the workspace folder's `.gitignore`. */
  gitignoreUpdated: boolean;
  writeErrors: string[];
}

/** The ticket data a caller fetched once and hands to {@link loadTicketToWorkspace}. */
export interface LoadedTicketData {
  issue: JiraIssue;
  comments: JiraComment[];
  attachments: JiraAttachment[];
  remoteLinks: JiraRemoteLink[];
}

/** Field-display options for rendering `ticket.md`, as `formatIssueFields` takes them. */
export interface LoadDisplayOptions {
  fieldMeta: JiraFieldMeta[];
  alwaysShowIds: Set<string>;
  hiddenIds: Set<string>;
  baseUrl: string;
}

export interface LoadOptions {
  /**
   * Attachment filenames to download as well, even when the default filter would skip them. The
   * size limit and the filename safety check still apply.
   */
  attachments?: readonly string[];
  onDiag?: DiagLogger;
}

const SKIP_REASONS: Record<SkipCause, string> = {
  'too-large': 'over 100 MB size limit',
  'not-default-type': 'unknown binary format',
  duplicate: 'duplicate filename; only the newest attachment with this name is downloaded',
  'download-failed': 'download failed',
  'unsafe-filename': 'unsafe filename',
};

function skippedEntry(att: JiraAttachment, cause: SkipCause): SkippedAttachment {
  return { filename: att.filename, content: att.content, size: att.size, mimeType: att.mimeType, reason: SKIP_REASONS[cause], cause };
}

/**
 * Classifies the attachments, downloads the eligible and the requested ones, writes `ticket.md`
 * and `comments.md`, and makes sure `.jira-context/` is git-ignored, from data the caller already
 * fetched. Streams nothing and keeps no session: the caller renders the returned result.
 */
export async function loadTicketToWorkspace(
  ticketKey: string,
  ticketService: Pick<TicketService, 'downloadAttachment'>,
  data: LoadedTicketData,
  display: LoadDisplayOptions,
  writer: LoadWriter,
  options: LoadOptions = {},
): Promise<LoadTicketCoreResult> {
  const { issue, comments, attachments, remoteLinks } = data;
  const { fieldMeta, alwaysShowIds, hiddenIds, baseUrl } = display;
  const { onDiag } = options;
  const requested = new Set((options.attachments ?? []).map(name => name.trim()).filter(name => name.length > 0));
  const notFound = [...requested].filter(name => !attachments.some(a => a.filename === name));

  // An unsafe filename is never written, whatever its type or whether it was asked for.
  const unsafe = attachments.filter(a => attachmentPath(ticketKey, a.filename) === undefined);
  const safe = attachments.filter(a => attachmentPath(ticketKey, a.filename) !== undefined);
  const { toDownload: eligible, toSkip: filtered } = classifyAttachmentEligibility(safe);
  const named = filtered.filter(a => requested.has(a.filename) && a.size <= ATTACHMENT_SIZE_LIMIT);
  const toSkip = filtered.filter(a => !named.includes(a));
  // Two attachments sharing a filename would race to write the same path, so only the newest is
  // downloaded and the others are listed as skipped.
  const { unique: toDownload, duplicates } = dedupeByLatestFilename([...eligible, ...named]);

  const contextDir = jiraContextDir(ticketKey);
  await writer.createDirectory(attachmentsDir(ticketKey));

  // Download attachments, at most 3 at a time.
  const downloaded = new Set<string>();
  const skippedUrls = new Map<string, string>();
  const downloadFailures: JiraAttachment[] = [];
  for (let i = 0; i < toDownload.length; i += 3) {
    await Promise.all(toDownload.slice(i, i + 3).map(async (att) => {
      try {
        const bytes = await ticketService.downloadAttachment(att.content);
        await writer.writeFile(attachmentPath(ticketKey, att.filename)!, bytes);
        downloaded.add(att.filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onDiag?.('warn', `Attachment download failed — ${att.filename}`, { fileName: att.filename, error: message });
        downloadFailures.push(att);
        skippedUrls.set(att.filename, att.content);
      }
    }));
  }
  for (const att of [...toSkip, ...duplicates, ...unsafe]) skippedUrls.set(att.filename, att.content);

  // ticket.md: the built-in attachment field is replaced by a list of what was downloaded.
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
    // A losing duplicate shares its filename with the attachment that was written, so it is
    // recognised by id before the filename lookup.
    const duplicateIds = new Set(duplicates.map(a => a.id));
    const failedIds = new Set(downloadFailures.map(a => a.id));
    const unsafeIds = new Set(unsafe.map(a => a.id));
    const attLines = attachments.map(att => {
      const size = formatFileSize(att.size);
      if (unsafeIds.has(att.id)) return `- \`${att.filename}\` — ${size} — skipped (unsafe filename)`;
      if (duplicateIds.has(att.id)) return `- \`${att.filename}\` — ${size} — skipped (duplicate filename)`;
      if (downloaded.has(att.filename)) return `- \`attachments/${att.filename}\` — ${size} (${att.mimeType})`;
      if (att.size > ATTACHMENT_SIZE_LIMIT) return `- \`${att.filename}\` — ${size} — skipped (over 100 MB size limit)`;
      if (failedIds.has(att.id)) return `- \`${att.filename}\` — ${size} — download failed`;
      return `- \`${att.filename}\` — ${size} — not downloaded by default (binary non-image); can be fetched on request`;
    });
    mdParts.push('', `## Attachments\n\n${attLines.join('\n')}`);
  }
  const ticketMd = rewriteAttachmentLinks(mdParts.join('\n'), downloaded, skippedUrls);

  const commentBlocks = comments.map((c, i) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim();
    return `## ${i + 1}. ${c.author.displayName} (${date})\n\n${body}`;
  });
  const rawCommentsMd = comments.length > 0
    ? `# Comments — ${ticketKey}\n\n${commentBlocks.join('\n\n---\n\n')}`
    : `# Comments — ${ticketKey}\n\n_No comments._`;
  const commentsMd = rewriteAttachmentLinks(rawCommentsMd, downloaded, skippedUrls);

  const writeErrors: string[] = [];
  const writtenFiles: string[] = [];
  const enc = new TextEncoder();
  for (const [name, content] of [['ticket.md', ticketMd], ['comments.md', commentsMd]] as const) {
    try {
      await writer.writeFile(`${contextDir}/${name}`, enc.encode(content));
      writtenFiles.push(`${contextDir}/${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDiag?.('warn', `Could not write ${name}`, { fileName: name, error: message });
      writeErrors.push(`${name}: ${message}`);
    }
  }
  for (const att of toDownload) {
    if (downloaded.has(att.filename)) writtenFiles.push(attachmentPath(ticketKey, att.filename)!);
  }

  const gitignoreUpdated = await ensureJiraContextGitignored(writer, onDiag);

  const skipped: SkippedAttachment[] = [
    ...toSkip.map(a => skippedEntry(a, a.size > ATTACHMENT_SIZE_LIMIT ? 'too-large' : 'not-default-type')),
    ...duplicates.map(a => skippedEntry(a, 'duplicate')),
    ...downloadFailures.map(a => skippedEntry(a, 'download-failed')),
    ...unsafe.map(a => skippedEntry(a, 'unsafe-filename')),
  ];

  return {
    downloadedCount: downloaded.size,
    downloadedFiles: [...downloaded],
    skipped,
    notFound,
    writtenFiles,
    gitignoreUpdated,
    writeErrors,
  };
}
