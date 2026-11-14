// Report import: creating tickets for the included New rows (one batch per page) and the single-row create the
// Already-ticketed re-create and new-ticket actions reuse. vscode-free; logging goes through the injected `onDiag`,
// progress through `onEvent`.
import type { TicketService } from '../services/TicketService';
import type { DiagLogger } from '../utils/diagTypes';
import { BATCH_LIMIT } from '../utils/reportImport';
import type { BuiltTicketFields, ReportImportDescriptor } from './descriptor';
import { buildReviewPage, restoreMergedRows } from './rows';
import { emptyImportOutcomes, type ImportHooks, type ReviewRowBase, type ReviewSession } from './types';

const FIELD_NAMES: Record<string, string> = { duedate: 'Due Date' };

/** The names of optional fields Jira refused on a write that otherwise succeeded. */
export function droppedFieldNames(droppedFields: string[]): string {
  return droppedFields.map(f => FIELD_NAMES[f] ?? f).join(', ');
}

/** The short note a merge step carries when Jira refused an optional field. */
export function droppedFieldsNote(droppedFields: string[]): string {
  return `Jira refused the ${droppedFieldNames(droppedFields)}; written without it`;
}

/** Logs a refused optional field for the Output channel. */
export function logDroppedFields(onDiag: DiagLogger | undefined, issueKey: string, droppedFields: string[]): void {
  onDiag?.('warn', `Jira refused ${droppedFields.join(', ')} — ${issueKey}; written without it`, { issueKey, refused: droppedFields });
}

/** What happens while tickets are created, in order. */
export type CreateEvent =
  | { kind: 'start'; count: number }
  | { kind: 'created'; key: string; summary: string; droppedFields?: string[] }
  | { kind: 'after-create-failed'; key: string; error: string }
  | { kind: 'failed'; ref: string; error: string };

/**
 * Creates one ticket for a row — its full ticket (`buildTicketFields`) unless `built` supplies other
 * content (a follow-up's subset). Reports the created ticket, then any failed post-creation step; a failure is caught and returned.
 */
export async function createTicketForRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  built?: BuiltTicketFields,
  hooks: ImportHooks<CreateEvent> = {},
): Promise<{ key: string } | { error: string }> {
  const { onDiag, onEvent } = hooks;
  const { summary: ticketSummary, fields, optionalFields } = built ?? descriptor.buildTicketFields(row, session.additionalFields);
  try {
    const createdTicket = await ticketService.createTicket(session.projectKey, ticketSummary, session.issueType, fields, baseUrl, optionalFields);
    if (createdTicket.droppedFields) logDroppedFields(onDiag, createdTicket.key, createdTicket.droppedFields);
    onEvent?.({ kind: 'created', key: createdTicket.key, summary: ticketSummary, ...(createdTicket.droppedFields ? { droppedFields: createdTicket.droppedFields } : {}) });
    // KTD4 (import consolidation): optional per-row post-creation work (email uses this for
    // attachment upload). A rejection is shown as a warning but never fails the row — the ticket
    // already exists.
    if (descriptor.afterCreate) {
      try {
        await descriptor.afterCreate(row, createdTicket.key, ticketService);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onDiag?.('warn', `Post-creation step failed — ${createdTicket.key}`, { issueKey: createdTicket.key, error: message });
        onEvent?.({ kind: 'after-create-failed', key: createdTicket.key, error: message });
      }
    }
    return { key: createdTicket.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ref = descriptor.itemRefFor(row);
    onDiag?.('error', `Ticket creation failed — ${ref}`, { ref, error: message });
    onEvent?.({ kind: 'failed', ref, error: message });
    return { error: message };
  }
}

/** What a create run did: the counts for its summary line, and the session after it. `nothingSelected` means nothing was written. */
export interface CreateRowsResult<TRow extends ReviewRowBase> {
  session: ReviewSession<TRow>;
  nothingSelected: boolean;
  onPage: number;
  created: number;
  failed: number;
  excluded: number;
}

/**
 * R7/R13/R15 (KTD3/KTD4): creates the included new rows on the visible page — at most
 * `BATCH_LIMIT`, which one page never exceeds. Rows excluded on this page are first written into
 * `allRows` so they stay excluded afterwards; successfully created rows then leave `allRows`, so a
 * repeated "create tickets" can never create them twice. Failed rows stay, still included.
 */
export async function createNewRowTickets<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  hooks: ImportHooks<CreateEvent> = {},
): Promise<CreateRowsResult<TRow>> {
  const pageFresh = session.rows.filter(r => r.existingTicketKey === null);
  const toCreate = pageFresh.filter(r => r.included).slice(0, BATCH_LIMIT);
  // A merged row stands for all of its member rows in `allRows` (KTD3).
  const memberIdsOf = (r: TRow) => r.memberIds ?? [r.id];
  const excludedIds = new Set(pageFresh.filter(r => !r.included).flatMap(memberIdsOf));
  if (toCreate.length === 0) {
    return { session, nothingSelected: true, onPage: pageFresh.length, created: 0, failed: 0, excluded: excludedIds.size };
  }

  hooks.onEvent?.({ kind: 'start', count: toCreate.length });
  const createdIds = new Set<string>();
  const failedMerged: TRow[] = [];
  let failed = 0;
  for (const row of toCreate) {
    const outcome = await createTicketForRow(row, session, ticketService, descriptor, baseUrl, undefined, hooks);
    if ('key' in outcome) {
      memberIdsOf(row).forEach(id => createdIds.add(id));
    } else {
      failed++;
      if (row.memberIds) failedMerged.push(row);
    }
  }

  const created = toCreate.length - failed;
  hooks.onDiag?.(failed > 0 ? 'warn' : 'info', `${descriptor.importLabel} import — ${created} created, ${failed} failed`, {
    created, failed, excludedByUser: excludedIds.size,
  });

  const allRows = session.allRows
    .filter(r => !(r.existingTicketKey === null && createdIds.has(r.id)))
    .map(r => (r.existingTicketKey === null && excludedIds.has(r.id) ? { ...r, included: false } : r));
  const page = buildReviewPage(allRows, session.page);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    session: {
      ...session,
      allRows,
      // A merged row that failed keeps its merge, so a retry retries the one ticket, not one per member.
      rows: restoreMergedRows(page.rows, failedMerged),
      page: page.page,
      outcomes: { ...outcomes, created: outcomes.created + created, createFailed: outcomes.createFailed + failed },
    },
    nothingSelected: false,
    onPage: pageFresh.length,
    created,
    failed,
    excluded: excludedIds.size,
  };
}
