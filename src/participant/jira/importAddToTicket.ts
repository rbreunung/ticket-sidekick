// Report import: adding New rows to an existing ticket as a comment or a rewrite (finding folding), streamed to chat.
// The plan and the writes live in src/imports/rewrite.ts, which the import board shares; this file words each step.
import * as vscode from 'vscode';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { buildAddPrompt, type AddMode, type ReviewRowBase, type ReviewSession } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { addRowsToTicket, checkAddTarget } from '../../imports/rewrite';
import { diagOf, droppedFieldsWarning, dueDateSetNote } from './importCreate';
import type { ReportImportDescriptor } from './reportImportTypes';

export { labelsToRemove, planRewrite, writeRewrite, type RewriteTarget } from '../../imports/rewrite';

const ROWS_GONE_MESSAGE = "_Those rows are no longer on this page, so nothing was added._\n\n";

/** Step one of `add … to <KEY>` (KTD5): reads the ticket and shows the warnings and the two mode links. Writes nothing. */
export async function showAddPrompt<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const check = await checkAddTarget(session, ids, key, ticketService, descriptor, diagOf(descriptor));
  if (check.kind === 'rows-gone') {
    stream.markdown(ROWS_GONE_MESSAGE);
    return;
  }
  if (check.kind === 'read-failed') {
    stream.markdown(`✗ ${key} — ${check.error}\n\n`);
    return;
  }
  stream.markdown(trustedChatMarkdown(buildAddPrompt({
    key, summary: check.summary, status: check.status,
    resolved: check.resolved, ids, rowCount: check.rowCount, droppedKeys: check.droppedKeys, baseUrl,
  })));
}

/** Step two of `add … to <KEY>`: runs the add and streams its result line. */
export async function addToTicket<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  mode: AddMode,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const result = await addRowsToTicket(session, ids, key, mode, ticketService, descriptor, baseUrl, diagOf(descriptor));
  const link = formatKeyLink(key, baseUrl);
  if (result.kind === 'rows-gone') {
    stream.markdown(ROWS_GONE_MESSAGE);
  } else if (result.kind === 'failed') {
    stream.markdown(`✗ ${link} — ${result.error}\n\n`);
  } else {
    const done = mode === 'comment' ? 'labels added and comment posted' : 'rewritten and comment posted';
    stream.markdown(result.commentFailed
      ? `⚠ ${link} — ${mode === 'comment' ? 'labels added' : 'rewritten'}, comment failed: ${result.commentFailed}\n\n`
      : `✓ ${link} — ${done}${dueDateSetNote(result.dueDate, descriptor)}\n\n`);
    if (result.droppedFields.length > 0) stream.markdown(droppedFieldsWarning(link, result.droppedFields));
  }
  return result.session;
}
