// Report import: creating tickets for the included New rows, streamed to chat. The creation itself lives in
// src/imports/create.ts, which the import board shares; this file words each step.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import type { DiagLogger } from '../../utils/diagTypes';
import { createNewRowTickets, createTicketForRow, droppedFieldNames, type CreateEvent } from '../../imports/create';
import type { ReviewRowBase, ReviewSession } from '../sessionState';
import type { BuiltTicketFields, ReportImportDescriptor } from './reportImportTypes';

export { droppedFieldsNote } from '../../imports/create';

/** The importer's Output-channel logger, for the engine calls. */
export function diagOf(descriptor: { scope: string }): DiagLogger {
  return (level, message, details) => logDiag(descriptor.scope, level, message, details);
}

/** The warning for optional fields Jira refused on a write that otherwise succeeded (KTD6). */
export function droppedFieldsWarning(link: string, droppedFields: string[]): string {
  const names = droppedFieldNames(droppedFields);
  return `_Warning: Jira refused the ${names} on ${link} (the field is probably not on the project's screen), so it was written without. The dates are in the description._\n\n`;
}

/** Streams one creation step: a ✓/✗ progress line, and the warnings that go with it. */
export function streamCreateEvent(stream: vscode.ChatResponseStream, baseUrl?: string): (event: CreateEvent) => void {
  return event => {
    switch (event.kind) {
      case 'start':
        stream.markdown(`_Creating ${event.count} ticket(s)…_\n\n`);
        return;
      case 'created':
        stream.markdown(`✓ ${formatKeyLink(event.key, baseUrl)} — ${event.summary}\n\n`);
        if (event.droppedFields) stream.markdown(droppedFieldsWarning(formatKeyLink(event.key, baseUrl), event.droppedFields));
        return;
      case 'after-create-failed':
        stream.markdown(`_Warning: ${event.error}_\n\n`);
        return;
      case 'failed':
        stream.markdown(`✗ ${event.ref} — ${event.error}\n\n`);
        return;
    }
  };
}

/**
 * Creates one ticket for a row — its full ticket (`buildTicketFields`) unless `built` supplies other
 * content (a follow-up's subset). Streams a ✓/✗ progress line; a failure is caught and returned.
 */
export function createOne<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  built?: BuiltTicketFields,
): Promise<{ key: string } | { error: string }> {
  return createTicketForRow(row, session, ticketService, descriptor, baseUrl, built, { onDiag: diagOf(descriptor), onEvent: streamCreateEvent(stream, baseUrl) });
}

/** Creates the included New rows on the visible page and streams each ticket and the page's summary line. */
export async function createNewRows<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const result = await createNewRowTickets(session, ticketService, descriptor, baseUrl, { onDiag: diagOf(descriptor), onEvent: streamCreateEvent(stream, baseUrl) });
  if (result.nothingSelected) {
    stream.markdown('_Nothing selected — no tickets were created._\n\n');
    return session;
  }
  stream.markdown(
    `${result.onPage} ${descriptor.itemNoun} on this page — **${result.created}** created, ${result.failed} failed, ${result.excluded} excluded by you.\n\n`,
  );
  return result.session;
}
