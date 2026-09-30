import * as vscode from 'vscode';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { sanitizeCellText, BATCH_LIMIT, resolveSizeLimitSetting } from '../../utils/reportImport';
import { parseEmlFile, type EmailImportItem, type EmailReviewRow } from '../../utils/emlParser';
import type {
  EmailContentSession, AwaitIssueTypeResume, EmailTemplateSelectionSession, EmailReviewSession, ReviewTableColumn,
  EmailCleanupSession, EmailCleanupTarget, EmailCleanupDecision,
} from '../sessionState';
import {
  isCancellation, isConfirmation, isSessionExpired, SESSION_EXPIRED_MESSAGE, buildChatCommandLink, neutralizeMarkdownLinks, withLastTicket,
  buildPendingEmailCleanupSession, buildEmailCleanupConsent, buildEmailCleanupPreview, parseEmailCleanupReply,
  applyEmailCleanupDecision, resolveSaveTarget,
} from '../sessionState';
import {
  detectPatternBlocks, resolveBoilerplatePatterns, isTooLongForModelCheck, buildModelCheckPrompt, parseModelCheckReply,
  verifyModelBlocks, type BoilerplatePattern,
} from '../../utils/emailBoilerplate';
import { withLmRetry, UnparseableReplyError } from '../../utils/lmRetry';
import { resolveProjectKey, sessionWasSuperseded } from './ticketContext';
import { sendAndCollect } from './llmHelpers';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import {
  buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection,
  continueAfterImportIssueType, handleImportReviewReply, type ReportImportDescriptor,
} from './reportImportHandler';

// KTD1: batch email import is a third ReportImportDescriptor kind, reusing the shared
// parse -> template-pick -> review -> batch-create flow Veracode/Waltz already share in
// reportImportHandler.ts (see that file's KTD1/KTD2/KTD3/KTD4) rather than a parallel session type.
// The dedup fields are omitted — email has no per-item dedup concept (KTD2) — and buildTicketFields/
// afterCreate supply email's own ticket-field-building and attachment-upload step.
// Subject/attachment filenames are untrusted, email-derived content — this table's whole output is
// trust-gated (KTD5, U6) once it carries the per-row toggle links (buildNewGroupScreen), so both
// go through neutralizeMarkdownLinks() (see its own doc comment in sessionState.ts).
const EMAIL_REVIEW_COLUMNS: ReviewTableColumn<EmailReviewRow>[] = [
  { header: 'Subject', accessor: row => neutralizeMarkdownLinks(row.subject) },
  { header: 'Attachments', accessor: row => (row.attachmentNames.length > 0 ? neutralizeMarkdownLinks(row.attachmentNames.join(', ')) : '—') },
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
    review: 'jira.session.emailReview',
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
  // now driven through the shared per-row creation hook (createNewRows). A thrown error here is caught by
  // that shared creation step and shown as a warning; the ticket itself is already created by that point.
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

function getEmailMaxBatchBytes(): number {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return resolveSizeLimitSetting('email.maxBatchSizeMB', (key) => cfg.get(key));
}

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
  const maxBatchBytes = getEmailMaxBatchBytes();
  if (totalBytes > maxBatchBytes) {
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
    const capMb = maxBatchBytes / (1024 * 1024);
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
// and runs the boilerplate cleanup step (KTD8), which continues into the template-selection screen.
// Used when no in-progress session exists.
async function startEmailBatchImport(
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  const items = await pickAndParseEmlFiles(stream);
  if (!items) return;

  const projectKey = await resolveProjectKey(null, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const target: EmailCleanupTarget = { kind: 'batch', projectKey, fileName: describeEmailFileSelection(items) };
  return startEmailCleanup(buildPendingEmailCleanupSession(items, target), jiraClient, stream, ws);
}

// ── Boilerplate cleanup step (KTD8): detect → [consent] → [preview] → the existing flow ──────────

// Exported so extension.ts's Command Palette command stores its `pending` session under this key.
export const EMAIL_CLEANUP_SESSION_KEY = 'jira.session.emailCleanup';

// R1: the user's configured patterns. Invalid entries are dropped and logged with the reason and the
// entry's kind only — never its phrases.
function readBoilerplatePatterns(): BoilerplatePattern[] {
  const raw = vscode.workspace.getConfiguration('ticketSidekick').get<unknown>('email.boilerplatePatterns');
  return resolveBoilerplatePatterns(raw, (reason, entry) => {
    const kind = typeof entry === 'object' && entry !== null && typeof (entry as { kind?: unknown }).kind === 'string'
      ? (entry as { kind: string }).kind.slice(0, 20)
      : undefined;
    logDiag('jira.email', 'warn', `Ignored an invalid ticketSidekick.email.boilerplatePatterns entry — ${reason}`, { reason, kind });
  });
}

function cleanupResult(session: EmailCleanupSession): vscode.ChatResult {
  return session.target.kind === 'comment'
    ? withLastTicket(session.target.ticketKey, ['email-cleanup'])
    : { metadata: { jiraSession: { kinds: ['email-cleanup'] } } };
}

// A branch that ends the cleanup step (cancel, expired) still names the comment target's ticket,
// so it carries lastTicketKey (empty kinds: no session) for a bare follow-up; a batch has none.
function endedCleanupResult(session: EmailCleanupSession): vscode.ChatResult | void {
  return session.target.kind === 'comment' ? withLastTicket(session.target.ticketKey) : undefined;
}

async function showCleanupScreen(
  session: EmailCleanupSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  notice?: string,
): Promise<vscode.ChatResult> {
  await ws.update(EMAIL_CLEANUP_SESSION_KEY, session);
  if (session.phase === 'consent') {
    stream.markdown(trustedChatMarkdown(`${notice ? `${notice}\n\n` : ''}${buildEmailCleanupConsent(session)}`));
  } else {
    stream.markdown(trustedChatMarkdown(buildEmailCleanupPreview(session, notice)));
  }
  return cleanupResult(session);
}

// Runs the configured patterns over every email (R2, R4) and picks the next step: the consent
// screen when a non-empty email had no match and fits the model check (R3), the preview when
// something was found, or — nothing found, nothing to ask — straight into the existing flow (R10).
async function startEmailCleanup(
  session: EmailCleanupSession,
  jiraClient: IJiraClient,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  const patterns = readBoilerplatePatterns();
  for (const row of session.rows) {
    const body = row.item.markdownBody;
    row.blocks = detectPatternBlocks(body, patterns, row.item.senderName);
    if (row.blocks.length > 0 || !body.trim()) row.modelStatus = 'not-needed';
    else row.modelStatus = isTooLongForModelCheck(body) ? 'too-long' : 'awaiting-consent';
  }
  logDiag('jira.email', 'info', 'Boilerplate patterns checked', {
    emails: session.rows.length,
    patterns: patterns.length,
    matched: session.rows.filter(r => r.blocks.length > 0).length,
    awaitingConsent: session.rows.filter(r => r.modelStatus === 'awaiting-consent').length,
  });
  if (session.rows.some(r => r.modelStatus === 'awaiting-consent')) {
    return showCleanupScreen({ ...session, phase: 'consent' }, stream, ws);
  }
  if (session.rows.some(r => r.blocks.length > 0)) {
    return showCleanupScreen({ ...session, phase: 'preview' }, stream, ws);
  }
  return continueAfterCleanup(session, 'keep', jiraClient, stream, ws);
}

// Strip or keep, then hand the (cleaned) items to the flow that ran before this step existed:
// the template pick for a batch, the comment preview for "add email as comment".
async function continueAfterCleanup(
  session: EmailCleanupSession,
  decision: EmailCleanupDecision,
  jiraClient: IJiraClient,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  await ws.update(EMAIL_CLEANUP_SESSION_KEY, undefined);
  const { items, strippedCount, droppedImageCount } = applyEmailCleanupDecision(session, decision);
  if (strippedCount > 0) {
    logDiag('jira.email', 'info', 'Boilerplate stripped', { emails: strippedCount, droppedImages: droppedImageCount });
    stream.markdown(`_Removed boilerplate from ${strippedCount} email(s)` +
      `${droppedImageCount > 0 ? `; ${droppedImageCount} image(s) will not be uploaded` : ''}._\n\n`);
  }
  if (session.target.kind === 'comment') {
    const item = items[0];
    return streamEmailCommentPreview({
      emailId: 'eml-import',
      subject: item.subject,
      senderName: item.senderName,
      receivedDateTime: item.receivedDateTime,
      markdownBody: item.markdownBody,
      inlineImageMap: item.inlineImageMap,
      attachments: item.attachments, // U6: the cleaned set — images only in stripped blocks are gone
      emlFilePath: item.emlFilePath,
      pendingCommentTicketKey: session.target.ticketKey,
    }, stream, ws);
  }
  const templateSession = await buildImportTemplateSession(items, session.target.fileName, session.target.projectKey, jiraClient, emailDescriptor);
  return streamImportTemplateSelection(templateSession, stream, ws, emailDescriptor);
}

// KTD5: one call per email the user consented to; the model proposes, verifyModelBlocks keeps only
// quotes that really occur. A failed or unparseable call leaves that email as nothing detected and
// is logged with metadata only — the reply echoes email text, so neither it nor the body is logged.
// Returns 'cancelled' when the chat request is cancelled: the loop stops, the email in flight and
// every later one stay 'awaiting-consent' (not 'failed'), and emails already checked keep their result.
async function runModelCheck(
  session: EmailCleanupSession,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream,
): Promise<'done' | 'cancelled'> {
  const cancelled = () => token?.isCancellationRequested === true;
  const asked = session.rows.filter(r => r.modelStatus === 'awaiting-consent');
  stream.markdown(`_Checking ${asked.length} email(s) with the Copilot model…_\n\n`);
  const patterns = readBoilerplatePatterns();
  for (const row of asked) {
    if (cancelled()) break;
    const body = row.item.markdownBody;
    let attempts = 0;
    let replyLength = 0;
    try {
      const proposals = await withLmRetry(async () => {
        if (cancelled()) throw new Error('cancelled');
        attempts++;
        const reply = await sendAndCollect(model, [vscode.LanguageModelChatMessage.User(buildModelCheckPrompt(body))], token);
        replyLength = reply.length;
        if (!/[[{]/.test(reply)) throw new UnparseableReplyError(reply);
        return parseModelCheckReply(reply);
      });
      row.blocks = verifyModelBlocks(body, proposals, patterns, row.item.senderName);
      row.modelStatus = 'checked';
      logDiag('jira.email', 'info', 'Model check done', {
        rowId: row.id, attempts, proposals: proposals.length, verifiedBlocks: row.blocks.length, replyLength, bodyLength: body.length,
      });
    } catch (err) {
      if (cancelled()) break; // stays 'awaiting-consent'
      row.blocks = [];
      row.modelStatus = 'failed';
      const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
      logDiag('jira.email', 'warn', 'Model check failed', {
        rowId: row.id, errorCode: code, errorName: err instanceof Error ? err.name : typeof err, attempts, replyLength, bodyLength: body.length,
      });
    }
  }
  if (!cancelled()) return 'done';
  logDiag('jira.email', 'info', 'Model check cancelled', {
    checked: asked.filter(r => r.modelStatus !== 'awaiting-consent').length,
    remaining: asked.filter(r => r.modelStatus === 'awaiting-consent').length,
  });
  return 'cancelled';
}

// Replies to the cleanup step's consent and preview screens (router kind 'email-cleanup'), plus the
// `pending` session the Command Palette stores (detection runs on this chat turn).
export async function handleEmailCleanupReply(
  reply: string,
  session: EmailCleanupSession,
  model: vscode.LanguageModelChat | undefined,
  token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isSessionExpired(session)) {
    await ws.update(EMAIL_CLEANUP_SESSION_KEY, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return endedCleanupResult(session);
  }
  if (session.phase === 'pending') return startEmailCleanup(session, jiraClient, stream, ws);

  const parsed = parseEmailCleanupReply(reply, session.phase, session.rows.map(r => r.id));
  if (parsed.action === 'cancel') {
    await ws.update(EMAIL_CLEANUP_SESSION_KEY, undefined);
    stream.markdown('_Cancelled — nothing was imported._');
    return endedCleanupResult(session);
  }

  if (session.phase === 'consent') {
    if (parsed.action === 'model-check') {
      if (!model) {
        return showCleanupScreen(session, stream, ws, '_No Copilot model is available in this chat — reply **skip model** to continue without it._');
      }
      if (await runModelCheck(session, model, token, stream) === 'cancelled') {
        // Stay at consent: the unchecked emails still await it, and nothing continues into the template pick.
        await ws.update(EMAIL_CLEANUP_SESSION_KEY, session);
        stream.markdown('_Model check stopped — reply **model check** or **skip model** to continue._');
        return cleanupResult(session);
      }
    } else if (parsed.action === 'skip-model') {
      for (const row of session.rows) if (row.modelStatus === 'awaiting-consent') row.modelStatus = 'declined';
    } else {
      return showCleanupScreen(session, stream, ws, '_Reply **model check** to let the model look, or **skip model** to continue without it._');
    }
    if (session.rows.some(r => r.blocks.length > 0)) return showCleanupScreen({ ...session, phase: 'preview' }, stream, ws);
    if (parsed.action === 'model-check') {
      const failed = session.rows.filter(r => r.modelStatus === 'failed').length;
      stream.markdown(`_The model check found no boilerplate${failed > 0 ? ` (model check failed for ${failed} email(s))` : ''} — continuing with the email(s) unchanged._\n\n`);
    }
    return continueAfterCleanup(session, 'keep', jiraClient, stream, ws);
  }

  switch (parsed.action) {
    case 'strip':
    case 'keep':
      return continueAfterCleanup(session, parsed.action, jiraClient, stream, ws);
    case 'toggle': {
      for (const row of session.rows) if (parsed.rowIds.includes(row.id)) row.excluded = !row.excluded;
      return showCleanupScreen(session, stream, ws);
    }
    case 'save':
      return saveBlockAsPattern(session, parsed.blockNumber, stream, ws);
    default:
      return showCleanupScreen(session, stream, ws,
        '_Reply **strip**, **keep**, a row id to exclude or include an email, or **save <n>** for a block the model found._');
  }
}

// R8/KTD9: appends the block's first/last-line pattern to the user's global setting, so the next
// import finds the same text through the patterns without asking about the model.
async function saveBlockAsPattern(
  session: EmailCleanupSession,
  blockNumber: number,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  const target = resolveSaveTarget(session, blockNumber);
  if (!target.ok) {
    const reason = {
      'unknown': `_There is no block #${blockNumber} in this preview._`,
      'pattern-found': `_#${blockNumber} was found by one of your patterns, so it is already saved. Only blocks the model found (they show a Save chip) can be saved._`,
      'no-text': `_#${blockNumber} has no text that could be saved as a pattern._`,
      'already-saved': `_#${blockNumber} is already saved as a pattern._`,
    }[target.reason];
    return showCleanupScreen(session, stream, ws, reason);
  }
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  const current = cfg.inspect<unknown>('email.boilerplatePatterns')?.globalValue;
  try {
    await cfg.update('email.boilerplatePatterns', [...(Array.isArray(current) ? current : []), target.pattern], vscode.ConfigurationTarget.Global);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The phrases are email text: an error that echoes the written value must not put them in the log.
    const phrases = [target.pattern.start, target.pattern.end].filter((p): p is string => !!p);
    const logMessage = phrases.reduce((m, p) => m.split(p).join('<pattern text>'), message);
    logDiag('jira.email', 'error', 'Could not save boilerplate pattern', {
      error: logMessage, errorName: err instanceof Error ? err.name : typeof err, kind: target.pattern.kind,
    });
    return showCleanupScreen(session, stream, ws, `_Could not save the pattern: ${neutralizeMarkdownLinks(message)}_`);
  }
  logDiag('jira.email', 'info', 'Saved boilerplate pattern', { kind: target.pattern.kind, hasEnd: target.pattern.end !== undefined });
  const saved: EmailCleanupSession = { ...session, savedBlocks: [...session.savedBlocks, blockNumber] };
  return showCleanupScreen(saved, stream, ws,
    `_Saved #${blockNumber} as a ${target.pattern.kind} pattern in your user settings — the next import finds it without the model._`);
}

// Entry point for the "createFromEmail" operation (chat: "@jira create from email" / "@jira import
// email" with no ticket key). Handles both invocation paths:
//  1. Command-triggered — extension.ts's ticket-sidekick.importEml command stored a `pending`
//     EmailCleanupSession; detection runs now, on this chat turn (KTD8). A batch cleanup session
//     already at its consent/preview step is re-shown, and an EmailTemplateSelectionSession left
//     from a later step resumes as before.
//  2. Chat-only — opens its own multi-select file picker.
export async function handleCreateFromEmail(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  const cleanup = ws.get<EmailCleanupSession>(EMAIL_CLEANUP_SESSION_KEY);
  if (cleanup) {
    if (isSessionExpired(cleanup)) {
      await ws.update(EMAIL_CLEANUP_SESSION_KEY, undefined);
      stream.markdown(SESSION_EXPIRED_MESSAGE);
      return endedCleanupResult(cleanup);
    }
    if (cleanup.target.kind === 'batch') {
      if (cleanup.phase === 'pending') return startEmailCleanup(cleanup, jiraClient, stream, ws);
      return showCleanupScreen(cleanup, stream, ws);
    }
  }

  const existing = ws.get<EmailTemplateSelectionSession>(emailDescriptor.sessionKeys.templateSelection);
  if (existing) {
    if (isSessionExpired(existing)) {
      await ws.update(emailDescriptor.sessionKeys.templateSelection, undefined);
      stream.markdown(SESSION_EXPIRED_MESSAGE);
      return;
    }
    return streamImportTemplateSelection(existing, stream, ws, emailDescriptor);
  }

  return startEmailBatchImport(stream, jiraClient, ws);
}

export async function handleAddEmailFromChat(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
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

    // U6/R11: the same cleanup step as the batch flow, for one email, ending in the comment preview.
    return startEmailCleanup(buildPendingEmailCleanupSession([item], { kind: 'comment', ticketKey: promptTicketKey }), jiraClient, stream, ws);
  }

  // No ticket key — this is a ticket-creation request, same batch flow as handleCreateFromEmail's
  // fresh-session path (R1: batching applies to every ticket-creation entry point).
  return startEmailBatchImport(stream, jiraClient, ws);
}

export async function handleEmailTemplateSelection(
  reply: string,
  session: EmailTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
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
): Promise<vscode.ChatResult | void> {
  if (sessionWasSuperseded(ws, emailDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer email import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  return continueAfterImportIssueType(
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
): Promise<vscode.ChatResult | void> {
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

// R13: the referenced ticket key is carried on metadata by the caller (handleEmailContentSession)
// instead of a visible marker. The attachment-upload summary is streamed here; the ticket-key marker
// that used to ride along in that string is gone.
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
    stream.markdown(`Uploaded ${uploaded} of ${session.attachments.length} attachment(s).`);
  }
}

export async function streamEmailCommentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<vscode.ChatResult> {
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

  // The preview body is untrusted, email-derived content (`session.markdownBody`) — streamed as a
  // plain, untrusted string so any markdown-looking `command:` link it happens to contain renders
  // as inert text rather than a clickable command. The confirm/cancel footer is a separate,
  // trusted `stream.markdown()` call so only this handler's own two fixed links are live (KTD5).
  stream.markdown(
    `${headerLines.join('\n')}\n\n**Comment preview:**\n\n${session.markdownBody}`,
  );
  stream.markdown(trustedChatMarkdown(
    `\n\nReply ${buildChatCommandLink('Post it', '@jira', 'post it')} to add as comment to **${key}**, ` +
    `or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  // The preview names the target ticket, so it carries lastTicketKey alongside its session kind.
  return withLastTicket(key, ['email-content']);
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
): Promise<vscode.ChatResult | void> {
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';

  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await addEmailAsComment(session.pendingCommentTicketKey!, session, ticketService, stream, baseUrl);
    // R13: carry the referenced ticket key on metadata instead of a visible marker.
    return withLastTicket(session.pendingCommentTicketKey!);
  }
  const pendingKeyMatch = reply.trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
  if (pendingKeyMatch) {
    return streamEmailCommentPreview({ ...session, pendingCommentTicketKey: pendingKeyMatch[1].toUpperCase() }, stream, ws);
  }
  return streamEmailCommentPreview(session, stream, ws);
}
