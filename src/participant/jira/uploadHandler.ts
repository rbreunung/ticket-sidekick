import * as vscode from 'vscode';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import { MAX_ATTACHMENT_BYTES } from '../../jira/JiraApiClient';
import { formatFileSize, inferContentType } from '../../utils/attachmentEligibility';
import { extractTicketId } from '../../utils/branchParser';
import {
  type PendingUploadFile, type UploadReviewSession, type AwaitUploadTicketSession,
  CURRENT_SESSION_SCHEMA_VERSION, resolveTicketKeyForUpload, buildUploadConfirmationMessage,
  buildUploadResultMessage, isConfirmation, isCancellation, withLastTicket,
} from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { parseLastTicketFromContext } from './ticketContext';
import type { ParsedIntent } from './llmHelpers';

// upload-attachment-to-ticket plan (U2): `@jira upload` chat flow. See docs/jira-flows.md for the
// session-type summary.

export const UPLOAD_REVIEW_SESSION_KEY = 'jira.session.uploadReview';
export const AWAIT_UPLOAD_TICKET_SESSION_KEY = 'jira.session.awaitUploadTicket';

/** R1-R3: collects every attached-file reference on the current chat message (a `vscode.Uri`
 * directly, or the `uri` of a `vscode.Location`), deduped by string form — `request.references`
 * is an array, and a user may attach more than one file in a single message (R8). */
function collectReferenceUris(refs: readonly vscode.ChatPromptReference[]): vscode.Uri[] {
  const seen = new Set<string>();
  const uris: vscode.Uri[] = [];
  for (const ref of refs) {
    const uri = ref.value instanceof vscode.Uri
      ? ref.value
      : ref.value instanceof vscode.Location ? ref.value.uri : undefined;
    if (uri && !seen.has(uri.toString())) {
      seen.add(uri.toString());
      uris.push(uri);
    }
  }
  return uris;
}

/** R1-R3: an explicit path always wins; otherwise every chat-attached file, then the active
 * editor, then the multi-select file picker. Returns `null` when the picker was cancelled or
 * nothing was selected — the caller does nothing further in that case, matching
 * `emailHandler.ts`'s `pickAndParseEmlFiles()` precedent. */
async function resolveSourceUris(explicitFilePath: string | null, request: vscode.ChatRequest): Promise<vscode.Uri[] | null> {
  if (explicitFilePath) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const resolved = path.isAbsolute(explicitFilePath) ? explicitFilePath : path.join(workspaceRoot, explicitFilePath);
    return [vscode.Uri.file(resolved)];
  }

  const referenced = collectReferenceUris(request.references);
  if (referenced.length > 0) return referenced;

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) return [activeUri];

  const picked = await vscode.window.showOpenDialog({ canSelectMany: true, title: 'Select file(s) to upload' });
  if (!picked || picked.length === 0) return null;
  return picked;
}

/** R7: reads and base64-encodes every resolved URI, rejecting the whole batch before a session is
 * built if any file exceeds `MAX_ATTACHMENT_BYTES` or can't be read (AE1). Returns `null` on
 * rejection — the caller has already streamed the reason. */
async function readPendingFiles(uris: vscode.Uri[], stream: vscode.ChatResponseStream): Promise<PendingUploadFile[] | null> {
  // Reads run concurrently (code-review fix) — each file is an independent local read, so a
  // multi-file batch (picker or multiple chat attachments, R8) doesn't wait on them one at a time.
  const reads = await Promise.all(uris.map(async (uri) => {
    const name = path.basename(uri.fsPath);
    try {
      return { name, bytes: await vscode.workspace.fs.readFile(uri) };
    } catch (err) {
      return { name, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  const failed = reads.find((r): r is { name: string; error: string } => 'error' in r);
  if (failed) {
    stream.markdown(`_Could not read "${failed.name}": ${failed.error}_`);
    return null;
  }

  const files: PendingUploadFile[] = [];
  const oversized: string[] = [];
  for (const { name, bytes } of reads as Array<{ name: string; bytes: Uint8Array }>) {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      oversized.push(`${name} (${formatFileSize(bytes.byteLength)})`);
      continue;
    }
    files.push({
      name,
      size: bytes.byteLength,
      contentType: inferContentType(name),
      base64Content: Buffer.from(bytes).toString('base64'),
    });
  }
  if (oversized.length > 0) {
    stream.markdown(`_Not uploaded — over the 25 MB limit: ${oversized.join(', ')}._`);
    return null;
  }
  return files;
}

async function streamUploadReview(
  ticketKey: string,
  files: PendingUploadFile[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  const session: UploadReviewSession = { ticketKey, files, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION };
  await ws.update(UPLOAD_REVIEW_SESSION_KEY, session);
  stream.markdown(trustedChatMarkdown(buildUploadConfirmationMessage(ticketKey, files)));
  return { metadata: { jiraSession: { kinds: ['upload-review'] } } };
}

function describeFiles(files: PendingUploadFile[]): string {
  return files.length === 1 ? `**${files[0].name}**` : `these ${files.length} files`;
}

/** Entry point for the `uploadAttachment` operation (chat: "@jira upload the report to
 * PROJ-123"). R1-R6: resolves the file(s), then the ticket, then shows a confirmation before any
 * upload runs. */
export async function handleUploadAttachment(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  intent: ParsedIntent,
): Promise<vscode.ChatResult | void> {
  const uris = await resolveSourceUris(intent.filePath, request);
  if (!uris) return;

  const files = await readPendingFiles(uris, stream);
  if (!files || files.length === 0) return;

  const lastTicketKey = parseLastTicketFromContext(chatContext);
  const ticketKey = resolveTicketKeyForUpload(request.prompt, files[0].name, lastTicketKey);
  if (!ticketKey) {
    const session: AwaitUploadTicketSession = { files, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION };
    await ws.update(AWAIT_UPLOAD_TICKET_SESSION_KEY, session);
    stream.markdown(`Which ticket should I upload ${describeFiles(files)} to? (e.g. PROJ-123)`);
    return { metadata: { jiraSession: { kinds: ['await-upload-ticket'] } } };
  }

  return streamUploadReview(ticketKey, files, stream, ws);
}

/** Resumes an `upload-review` session (R6): confirm uploads every pending file and reports
 * per-file results (R8); cancel discards the batch; anything else re-shows the confirmation. */
export async function handleUploadReviewReply(
  reply: string,
  session: UploadReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isCancellation(reply)) {
    await ws.update(UPLOAD_REVIEW_SESSION_KEY, undefined);
    stream.markdown('_Cancelled — no files were uploaded._');
    return;
  }
  if (!isConfirmation(reply)) {
    stream.markdown(trustedChatMarkdown(buildUploadConfirmationMessage(session.ticketKey, session.files)));
    return { metadata: { jiraSession: { kinds: ['upload-review'] } } };
  }

  await ws.update(UPLOAD_REVIEW_SESSION_KEY, undefined);
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  for (const file of session.files) {
    try {
      await ticketService.uploadAttachment(session.ticketKey, file.name, file.contentType, file.base64Content);
      results.push({ name: file.name, ok: true });
      logDiag('jira.upload', 'info', `Uploaded attachment — ${session.ticketKey}/${file.name}`, { ticketKey: session.ticketKey, filename: file.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: file.name, ok: false, error: message });
      logDiag('jira.upload', 'error', `Upload failed — ${session.ticketKey}/${file.name}`, { ticketKey: session.ticketKey, filename: file.name, error: message });
    }
  }
  stream.markdown(buildUploadResultMessage(session.ticketKey, results));
  return withLastTicket(session.ticketKey);
}

/** Resumes an `await-upload-ticket` session (R5, KTD4): a plain free-text reply naming the
 * ticket, re-asking on anything that doesn't contain a ticket key. */
export async function handleAwaitUploadTicketReply(
  reply: string,
  session: AwaitUploadTicketSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isCancellation(reply)) {
    await ws.update(AWAIT_UPLOAD_TICKET_SESSION_KEY, undefined);
    stream.markdown('_Cancelled — no files were uploaded._');
    return;
  }

  const ticketKey = extractTicketId(reply);
  if (!ticketKey) {
    stream.markdown(`I need a ticket key (e.g. PROJ-123) to upload ${describeFiles(session.files)} to. Which ticket?`);
    return { metadata: { jiraSession: { kinds: ['await-upload-ticket'] } } };
  }

  await ws.update(AWAIT_UPLOAD_TICKET_SESSION_KEY, undefined);
  return streamUploadReview(ticketKey, session.files, stream, ws);
}
