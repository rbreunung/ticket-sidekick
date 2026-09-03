import * as vscode from 'vscode';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { sanitizeCellText, BATCH_LIMIT, MAX_EMAIL_BATCH_BYTES } from '../../utils/reportImport';
import { parseEmlFile, type EmailImportItem, type EmailReviewRow } from '../../utils/emlParser';
import type {
  EmailContentSession, AwaitIssueTypeResume, EmailTemplateSelectionSession, EmailReviewSession, ReviewTableColumn,
} from '../sessionState';
import { isCancellation, isConfirmation, isSessionExpired, SESSION_EXPIRED_MESSAGE } from '../sessionState';
import { resolveProjectKey, sessionWasSuperseded } from './ticketContext';
import {
  buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection,
  continueAfterImportIssueType, handleImportReviewReply, type ReportImportDescriptor,
} from './reportImportHandler';

// KTD1: batch email import is a third ReportImportDescriptor kind, reusing the shared
// parse -> template-pick -> review -> batch-create flow Veracode/Waltz already share in
// reportImportHandler.ts (see that file's KTD1/KTD2/KTD3/KTD4) rather than a parallel session type.
// The dedup fields are omitted — email has no per-item dedup concept (KTD2) — and buildTicketFields/
// afterCreate supply email's own ticket-field-building and attachment-upload step.
const EMAIL_REVIEW_COLUMNS: ReviewTableColumn<EmailReviewRow>[] = [
  { header: 'Subject', accessor: row => row.subject },
  { header: 'Attachments', accessor: row => (row.attachmentNames.length > 0 ? row.attachmentNames.join(', ') : '—') },
];

// Exported so extension.ts's Command Palette command writes the session under exactly the key this
// module reads it back from, instead of duplicating the string literal.
export const EMAIL_TEMPLATE_SESSION_KEY = 'jira.session.emailTemplateSelection';

const emailDescriptor: ReportImportDescriptor<EmailImportItem, EmailReviewRow> = {
  descriptorKind: 'email',
  scope: 'jira.email',
  importLabel: 'Email',
  itemNoun: 'email(s)',
  filterKindLabel: 'selection',
  noMatchMessage: '_No emails were selected._',
  // fileFilter/filePickerTitle/parseAndFilter omitted (optional on ReportImportDescriptor, see its
  // doc comment) — email's entry points below build `items` themselves via a multi-select picker and
  // call buildImportTemplateSession() directly, never through the single-file
  // openReportFilePicker()/handleImportReport() those three fields exist for.
  sessionKeys: {
    templateSelection: EMAIL_TEMPLATE_SESSION_KEY,
    templateTag: '<!-- jira:email-template -->',
    review: 'jira.session.emailReview',
    reviewTag: '<!-- jira:email-review -->',
  },
  buildRowFields: item => ({
    subject: item.subject,
    senderName: item.senderName,
    attachmentNames: item.attachments.filter(a => !a.isInline).map(a => a.name),
    markdownBody: item.markdownBody,
    inlineImageMap: item.inlineImageMap,
    attachments: item.attachments,
    emlFilePath: item.emlFilePath,
  }),
  reviewColumns: EMAIL_REVIEW_COLUMNS,
  itemRefFor: row => row.subject,
  buildTicketFields: (row, additionalFields) => ({
    summary: row.subject,
    fields: { ...additionalFields, description: buildEmailJiraWiki(row.markdownBody) },
  }),
  // KTD4: uploads the row's attachments after ticket creation, then honors the existing
  // email.deleteEmlAfterImport setting — same two steps finishEmailTicket() used to run inline,
  // now driven through executeImportBatch's shared per-row hook. A thrown error here is caught by
  // executeImportBatch and shown as a warning; the ticket itself is already created by that point.
  afterCreate: async (row, issueKey, ticketService) => {
    let uploaded = 0;
    const failures: string[] = [];
    if (row.attachments.length > 0) {
      await Promise.all(row.attachments.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { issueKey, fileName: att.name, error: message });
            failures.push(`${att.name}: ${message}`);
          }),
      ));
    }
    const deleteAfter = vscode.workspace.getConfiguration('ticketSidekick').get<boolean>('email.deleteEmlAfterImport', false);
    if (deleteAfter) {
      await fs.promises.unlink(row.emlFilePath).catch((err: unknown) => {
        logDiag('jira.email', 'warn', `Could not delete .eml after import — ${row.emlFilePath}`, {
          emlFilePath: row.emlFilePath, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (failures.length > 0) {
      throw new Error(`Uploaded ${uploaded} of ${row.attachments.length} attachment(s); failed: ${failures.join('; ')}`);
    }
  },
  // KTD9: matches veracodeHandler.ts's own onIssueTypeFetchFailed — this is the one warning that
  // always surfaces as a native pop-up regardless of entry point (chat or Command Palette), so the
  // Command Palette's ticket-sidekick.importEml command doesn't silently lose the warning it used to
  // show inline before this consolidation.
  onIssueTypeFetchFailed: (message, projectKey) => {
    vscode.window.showWarningMessage(
      `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`,
    );
  },
};

// Checks the file-count cap (KTD6) and the aggregate attachment-byte cap (KTD7) for a set of
// selected .eml files, before any file is read. Returns an error message to show the user, or null
// when both caps are satisfied. Shared by every entry point's file picker (chat and Command Palette)
// so the two caps are enforced identically everywhere.
export async function checkEmailBatchCaps(uris: vscode.Uri[]): Promise<string | null> {
  if (uris.length > BATCH_LIMIT) {
    return `Selected ${uris.length} files — the batch limit is ${BATCH_LIMIT}. Select ${BATCH_LIMIT} or fewer and try again.`;
  }

  // Independent stats — run concurrently rather than one file at a time.
  const sizes = await Promise.all(uris.map(uri =>
    fs.promises.stat(uri.fsPath).then(stat => stat.size).catch(() => 0), // a stat failure surfaces properly below, when the file is actually read and parsed
  ));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes > MAX_EMAIL_BATCH_BYTES) {
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
    const capMb = MAX_EMAIL_BATCH_BYTES / (1024 * 1024);
    return `Selected files total ${totalMb} MB — the batch limit is ${capMb} MB. Select fewer or smaller files and try again.`;
  }
  return null;
}

// Parses every selected file (concurrently — each file's parse is independent). A file that fails to
// parse is excluded and reported via `onFailure`, once, with every failed file's basename and reason
// — it never reaches the review screen or the batch-creation summary. Shared by every entry point
// (the chat-triggered pickers below and extension.ts's Command Palette command) so the fan-out and
// per-file error handling live in exactly one place.
export async function parseEmlFiles(
  uris: vscode.Uri[],
  onFailure: (failures: string[]) => void,
  logScope: string,
): Promise<EmailImportItem[]> {
  const results = await Promise.allSettled(uris.map(uri => parseEmlFile(uri.fsPath)));
  const items: EmailImportItem[] = [];
  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(result.value);
    } else {
      const uri = uris[i];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logDiag(logScope, 'error', `Could not import .eml file — ${uri.fsPath}`, { emlPath: uri.fsPath, error: message });
      failures.push(`${path.basename(uri.fsPath)}: ${message}`);
    }
  });
  if (failures.length > 0) onFailure(failures);
  return items;
}

// "1 file" -> its basename; "N files" -> "N selected file(s)" — the fileName ImportTemplateSelectionSession
// shows in "Found N email(s) in `<fileName>` ...". Shared by every entry point that builds the session.
export function describeEmailFileSelection(items: EmailImportItem[]): string {
  return items.length === 1 ? path.basename(items[0].emlFilePath) : `${items.length} selected file(s)`;
}

// Opens a multi-select .eml picker, enforces both caps (checkEmailBatchCaps above) before any file is
// read, then parses every selected file (parseEmlFiles above). Returns null when the user cancelled
// the picker, a cap was exceeded, or nothing parsed.
async function pickAndParseEmlFiles(stream: vscode.ChatResponseStream): Promise<EmailImportItem[] | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { Email: ['eml'] },
    title: 'Select .eml file(s) to import',
  });
  if (!uris || uris.length === 0) return null;

  const capError = await checkEmailBatchCaps(uris);
  if (capError) {
    stream.markdown(`_${capError}_`);
    return null;
  }

  const items = await parseEmlFiles(uris, failures => {
    stream.markdown(`_Could not import ${failures.length} file(s):_\n${failures.map(f => `- ${f}`).join('\n')}\n\n`);
  }, 'jira.email');
  if (items.length === 0) {
    stream.markdown('_No emails could be imported._');
    return null;
  }
  return items;
}

// Shared by both ticket-creation entry points below: prompts for files, resolves the project key,
// and streams the template-selection screen. Used when no in-progress session exists.
async function startEmailBatchImport(
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
  ws: vscode.Memento,
): Promise<void> {
  const items = await pickAndParseEmlFiles(stream);
  if (!items) return;

  const projectKey = await resolveProjectKey(null, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildImportTemplateSession(items, describeEmailFileSelection(items), projectKey, jiraClient, emailDescriptor);
  await streamImportTemplateSelection(session, stream, ws, emailDescriptor);
}

// Thin wrapper mirroring buildVeracodeTemplateSession/buildWaltzTemplateSession — used by
// extension.ts's ticket-sidekick.importEml Command Palette command, which does its own multi-select
// file picking (VS Code command context, not a chat stream) and then hands off into this same
// shared session builder.
export async function buildEmailTemplateSession(
  items: EmailImportItem[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<EmailTemplateSelectionSession> {
  return buildImportTemplateSession(items, fileName, projectKey, jiraClient, emailDescriptor);
}

// Entry point for the "createFromEmail" operation (chat: "@jira create from email" / "@jira import
// email" with no ticket key). Handles both invocation paths:
//  1. Command-triggered — an EmailTemplateSelectionSession is already in workspaceState (built by
//     extension.ts's ticket-sidekick.importEml command).
//  2. Chat-only — opens its own multi-select file picker.
export async function handleCreateFromEmail(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  const existing = ws.get<EmailTemplateSelectionSession>(emailDescriptor.sessionKeys.templateSelection);
  if (existing) {
    if (isSessionExpired(existing)) {
      await ws.update(emailDescriptor.sessionKeys.templateSelection, undefined);
      stream.markdown(SESSION_EXPIRED_MESSAGE);
      return;
    }
    await streamImportTemplateSelection(existing, stream, ws, emailDescriptor);
    return;
  }

  await startEmailBatchImport(stream, jiraClient, ws);
}

export async function handleAddEmailFromChat(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  // Extract ticket key from prompt if present (e.g. "add email to PROJ-42")
  const ticketKeyMatch = request.prompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  const promptTicketKey = ticketKeyMatch?.[1]?.toUpperCase() ?? null;

  // A ticket key was given — this is the comment-attach flow, unaffected by batching: exactly one
  // file, added as a comment to the named ticket, never a new ticket.
  if (promptTicketKey) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Email: ['eml'] },
      title: 'Select .eml file to import',
    });
    if (!uris || uris.length === 0) return;

    let item: EmailImportItem;
    try {
      item = await parseEmlFile(uris[0].fsPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.email', 'error', `Could not import .eml file — ${uris[0].fsPath}`, { emlPath: uris[0].fsPath, error: message });
      stream.markdown(`_Could not import email: ${message}_`);
      return;
    }

    const quickSession: EmailContentSession = {
      emailId: 'eml-import',
      subject: item.subject,
      senderName: item.senderName,
      receivedDateTime: item.receivedDateTime,
      markdownBody: item.markdownBody,
      inlineImageMap: item.inlineImageMap,
      attachments: item.attachments,
      emlFilePath: item.emlFilePath,
      pendingCommentTicketKey: promptTicketKey,
    };
    await streamEmailCommentPreview(quickSession, stream, ws);
    return;
  }

  // No ticket key — this is a ticket-creation request, same batch flow as handleCreateFromEmail's
  // fresh-session path (R1: batching applies to every ticket-creation entry point).
  await startEmailBatchImport(stream, jiraClient, ws);
}

export async function handleEmailTemplateSelection(
  reply: string,
  session: EmailTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  return handleImportTemplateSelection(reply, session, jiraClient, ticketService, stream, ws, emailDescriptor, baseUrl);
}

// R6/KTD4: resumes a batch email import once the shared issue-type chat-ask (JiraParticipant.ts's
// router) has a typed type for a 'reportImport'-kind resume with descriptorKind 'email'. Mirrors
// handleVeracodeAwaitIssueType's/handleWaltzAwaitIssueType's sessionWasSuperseded() guard.
export async function handleEmailAwaitIssueType(
  resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }>,
  issueType: string,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  if (sessionWasSuperseded(ws, emailDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer email import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  await continueAfterImportIssueType(
    issueType, resume.pickedTemplateName, resume.session as EmailTemplateSelectionSession,
    jiraClient, ticketService, stream, ws, emailDescriptor, baseUrl,
  );
}

export async function handleEmailReviewReply(
  reply: string,
  session: EmailReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  return handleImportReviewReply(reply, session, ticketService, stream, ws, emailDescriptor, baseUrl);
}

// Pure helper — converts markdown email body to Jira Wiki markup with inline-image placeholders resolved.
// The captured filename is attacker-controlled (email-derived) and is interpolated directly into
// literal Jira image-embed syntax OUTSIDE markdownToJiraWiki() — sanitize the captured value alone
// (not the whole !name|thumbnail! template, whose own "!"/"|" delimiters must survive).
export function buildEmailJiraWiki(markdownBody: string): string {
  let jiraWiki = markdownToJiraWiki(markdownBody);
  jiraWiki = jiraWiki.replace(/\n{3,}/g, '\n\n');
  return jiraWiki.replace(/\[📎 ([^\]]+)\]/g, (_match, name: string) => `!${sanitizeCellText(name)}|thumbnail!`);
}

// Pure helper — builds the From/Date comment header. senderName is the email's attacker-controlled
// "From" display name, interpolated directly into live Jira wiki markup outside markdownToJiraWiki()
// — sanitize the value alone (not the whole "*From:* ..." string, whose intentional "*" bold markers
// must survive).
export function buildEmailCommentHeader(senderName?: string, receivedDateTime?: string): string {
  const parts: string[] = [];
  if (senderName) parts.push(`*From:* ${sanitizeCellText(senderName)}`);
  if (receivedDateTime) parts.push(`*Date:* ${receivedDateTime.slice(0, 10)}`);
  return parts.length > 0 ? parts.join('  ·  ') + '\n\n' : '';
}

export async function addEmailAsComment(
  ticketKey: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  baseUrl: string,
): Promise<void> {
  const jiraWiki = buildEmailJiraWiki(session.markdownBody);
  const header = buildEmailCommentHeader(session.senderName, session.receivedDateTime);
  const commentBody = `${header}${jiraWiki}`;

  const result = await ticketService.addComment(ticketKey, commentBody, baseUrl);
  stream.markdown(result);

  if (session.attachments.length > 0) {
    let uploaded = 0;
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(ticketKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { ticketKey, fileName: att.name, error: message });
            stream.markdown(`_Warning: could not upload ${att.name}: ${message}_`);
          }),
      ),
    );
    stream.markdown(`Uploaded ${uploaded} of ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${ticketKey} -->`);
  } else {
    stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
  }
}

export async function streamEmailCommentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  const key = session.pendingCommentTicketKey!;

  const headerLines: string[] = [];
  if (session.senderName || session.receivedDateTime) {
    const fromPart = session.senderName ? `**From:** ${session.senderName}` : '';
    const datePart = session.receivedDateTime ? `**Date:** ${session.receivedDateTime.slice(0, 10)}` : '';
    if (fromPart && datePart) headerLines.push(`${fromPart} · ${datePart}`);
    else headerLines.push(fromPart || datePart);
  }
  headerLines.push(`**Subject:** ${session.subject}`);
  const nonInlineAttachments = session.attachments.filter(a => !a.isInline);
  if (nonInlineAttachments.length > 0) {
    headerLines.push(`**Attachments:** ${nonInlineAttachments.map(a => a.name).join(', ')}`);
  }

  stream.markdown(
    `${headerLines.join('\n')}\n\n` +
    `**Comment preview:**\n\n${session.markdownBody}\n\n` +
    `Reply **post it** to add as comment to **${key}**, or **(c)** to cancel.\n\n<!-- jira:email-content -->`,
  );
}

// Handles replies to the comment-attach preview (streamEmailCommentPreview above) — the only
// remaining consumer of EmailContentSession/jira.session.emailContent now that ticket creation
// routes through the email ReportImportDescriptor's own session type instead.
export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';

  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await addEmailAsComment(session.pendingCommentTicketKey!, session, ticketService, stream, baseUrl);
    return;
  }
  const pendingKeyMatch = reply.trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
  if (pendingKeyMatch) {
    await streamEmailCommentPreview({ ...session, pendingCommentTicketKey: pendingKeyMatch[1].toUpperCase() }, stream, ws);
    return;
  }
  await streamEmailCommentPreview(session, stream, ws);
}
