// Report import: creating tickets for the included New rows (one batch per page) and the single-row
// create the Already-ticketed re-create/follow-up actions reuse.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { BATCH_LIMIT } from '../../utils/reportImport';
import { buildReviewPage, emptyImportOutcomes, restoreMergedRows, type ReviewRowBase, type ReviewSession } from '../sessionState';
import type { ReportImportDescriptor } from './reportImportTypes';

/**
 * Creates one ticket for a row — its full ticket (`buildTicketFields`) unless `built` supplies other
 * content (a follow-up's subset). Streams a ✓/✗ progress line; a failure is caught and returned.
 */
export async function createOne<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  built?: { summary: string; fields: Record<string, unknown> },
): Promise<{ key: string } | { error: string }> {
  const { summary: ticketSummary, fields } = built ?? descriptor.buildTicketFields(row, session.additionalFields);
  try {
    const createdTicket = await ticketService.createTicket(session.projectKey, ticketSummary, session.issueType, fields, baseUrl);
    stream.markdown(`✓ ${formatKeyLink(createdTicket.key, baseUrl)} — ${ticketSummary}\n\n`);
    // KTD4 (import consolidation): optional per-row post-creation work (email uses this for
    // attachment upload). A rejection is shown as a warning but never fails the row — the ticket
    // already exists.
    if (descriptor.afterCreate) {
      try {
        await descriptor.afterCreate(row, createdTicket.key, ticketService);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag(descriptor.scope, 'warn', `Post-creation step failed — ${createdTicket.key}`, { issueKey: createdTicket.key, error: message });
        stream.markdown(`_Warning: ${message}_\n\n`);
      }
    }
    return { key: createdTicket.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ref = descriptor.itemRefFor(row);
    logDiag(descriptor.scope, 'error', `Ticket creation failed — ${ref}`, { ref, error: message });
    stream.markdown(`✗ ${ref} — ${message}\n\n`);
    return { error: message };
  }
}

/**
 * R7/R13/R15 (KTD3/KTD4): creates the included new rows on the visible page — at most
 * `BATCH_LIMIT`, which one page never exceeds. Rows excluded on this page are first written into
 * `allRows` so they stay excluded afterwards; successfully created rows then leave `allRows`, so a
 * repeated "create tickets" can never create them twice. Failed rows stay, still included.
 */
export async function createNewRows<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const pageFresh = session.rows.filter(r => r.existingTicketKey === null);
  const toCreate = pageFresh.filter(r => r.included).slice(0, BATCH_LIMIT);
  // A merged row stands for all of its member rows in `allRows` (KTD3).
  const memberIdsOf = (r: TRow) => r.memberIds ?? [r.id];
  const excludedIds = new Set(pageFresh.filter(r => !r.included).flatMap(memberIdsOf));
  if (toCreate.length === 0) {
    stream.markdown('_Nothing selected — no tickets were created._\n\n');
    return session;
  }

  stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);
  const createdIds = new Set<string>();
  const failedMerged: TRow[] = [];
  let failed = 0;
  for (const row of toCreate) {
    const outcome = await createOne(row, session, ticketService, stream, descriptor, baseUrl);
    if ('key' in outcome) {
      memberIdsOf(row).forEach(id => createdIds.add(id));
    } else {
      failed++;
      if (row.memberIds) failedMerged.push(row);
    }
  }

  const created = toCreate.length - failed;
  stream.markdown(
    `${pageFresh.length} ${descriptor.itemNoun} on this page — **${created}** created, ${failed} failed, ${excludedIds.size} excluded by you.\n\n`,
  );
  logDiag(descriptor.scope, failed > 0 ? 'warn' : 'info', `${descriptor.importLabel} import — ${created} created, ${failed} failed`, {
    created, failed, excludedByUser: excludedIds.size,
  });

  const allRows = session.allRows
    .filter(r => !(r.existingTicketKey === null && createdIds.has(r.id)))
    .map(r => (r.existingTicketKey === null && excludedIds.has(r.id) ? { ...r, included: false } : r));
  const page = buildReviewPage(allRows, session.page);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    allRows,
    // A merged row that failed keeps its merge, so a retry retries the one ticket, not one per member.
    rows: restoreMergedRows(page.rows, failedMerged),
    page: page.page,
    outcomes: { ...outcomes, created: outcomes.created + created, createFailed: outcomes.createFailed + failed },
  };
}

// --- Add rows to an existing ticket (finding folding, KTD5-KTD7) ------------------------------------
