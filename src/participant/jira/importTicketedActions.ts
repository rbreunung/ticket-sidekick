// Report import: the Already-ticketed screen's per-row actions, streamed to chat. The runner lives in
// src/imports/ticketedActions.ts, which the import board shares; this file words each row's result and the summary.
import * as vscode from 'vscode';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { BATCH_LIMIT } from '../../utils/reportImport';
import { runTicketedActions, type TicketedEvent } from '../../imports/ticketedActions';
import type { ReviewRowBase, ReviewSession, TicketedAction } from '../sessionState';
import { diagOf, droppedFieldsWarning, dueDateSetNote, streamCreateEvent } from './importCreate';
import type { ReportImportDescriptor } from './reportImportTypes';

export { TICKETED_RUNS } from '../../imports/ticketedActions';

/** Streams one row's result as the actions run. */
function streamTicketedEvent<TItem, TRow extends ReviewRowBase>(
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): (event: TicketedEvent) => void {
  const created = streamCreateEvent(stream, baseUrl);
  return event => {
    switch (event.kind) {
      case 'start':
        stream.markdown(`_Applying ${event.count} action(s)…_\n\n`);
        return;
      case 'create':
        created(event.event);
        return;
      case 'row-failed':
        stream.markdown(`✗ ${event.ref} — ${event.error}\n\n`);
        return;
      case 'link-failed':
        stream.markdown(`⚠ ${formatKeyLink(event.key, baseUrl)} was created but could not be linked to ${event.relatesTo}: ${event.error}\n\n`);
        return;
      case 'update': {
        const link = formatKeyLink(event.key, baseUrl);
        if (event.outcome === 'baseline') stream.markdown(`✓ ${link} — baseline recorded\n\n`);
        else if (event.outcome === 'up-to-date') stream.markdown(`– ${link} — already up to date\n\n`);
        else if (event.outcome === 'comment-failed') stream.markdown(`⚠ ${link} — labels updated but the comment could not be posted: ${event.error}\n\n`);
        else if (event.outcome === 'updated') stream.markdown(`✓ ${link} — updated\n\n`);
        else stream.markdown(`✗ ${link} — ${event.error}\n\n`);
        return;
      }
      case 'rewrite': {
        const link = formatKeyLink(event.key, baseUrl);
        if (event.outcome === 'failed') {
          stream.markdown(`✗ ${link} — ${event.error}\n\n`);
          return;
        }
        stream.markdown(event.outcome === 'comment-failed'
          ? `⚠ ${link} — rewritten, but the comment could not be posted: ${event.error}\n\n`
          : `✓ ${link} — rewritten from ${event.rowCount} row(s)${dueDateSetNote(event.dueDate, descriptor)}\n\n`);
        if (event.droppedFields.length > 0) stream.markdown(droppedFieldsWarning(link, event.droppedFields));
        return;
      }
    }
  };
}

/**
 * Runs the already-ticketed rows whose action is in `actions` and streams each row's result and the summary line,
 * or why nothing ran.
 */
export async function executeTicketedActions<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  actions: ReadonlySet<TicketedAction>,
  command: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const result = await runTicketedActions(session, actions, command, ticketService, descriptor, baseUrl, {
    onDiag: diagOf(descriptor), onEvent: streamTicketedEvent(stream, descriptor, baseUrl),
  });
  if (result.kind === 'partial-rewrite') {
    const detail = result.partial.map(p => `${p.key}: ${p.rewriteIds.join(', ')} ${p.rewriteIds.length === 1 ? 'is' : 'are'} on rewrite but ${p.otherIds.join(', ')} ${p.otherIds.length === 1 ? 'is' : 'are'} not`).join('; ');
    stream.markdown(`_Nothing was written. Rewrite rebuilds a whole ticket, so it must cover all the rows that point to it or none of them (${detail}). Use \`all rewrite\`, or set the others to another action._\n\n`);
    return result.session;
  }
  if (result.kind === 'nothing') {
    stream.markdown(command === 'apply'
      ? '_Nothing to apply — every row is set to leave or already done._\n\n'
      : `_Nothing to apply — no row is set to \`${[...actions][0]}\`._\n\n`);
    return result.session;
  }

  const { updated, upToDate, followedUp, recreated, rewritten, failed, remaining } = result;
  const followUpWord = descriptor.changeTracking?.actionLabels?.['follow-up'] ?? 'follow-up';
  let summary = `**${updated}** updated, ${followedUp} ${followUpWord}(s) created, ${recreated} re-created` +
    (rewritten > 0 ? `, ${rewritten} rewritten` : '') +
    (upToDate > 0 ? `, ${upToDate} already up to date` : '') + `, ${failed} failed.`;
  if (remaining > 0) {
    summary += ` _${remaining} remain — capped at ${BATCH_LIMIT} actions per reply; reply \`${command}\` again to run them._`;
  }
  stream.markdown(`${summary}\n\n`);
  return result.session;
}
