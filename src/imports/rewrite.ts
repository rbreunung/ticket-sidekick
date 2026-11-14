// Report import: adding New rows to an existing ticket as a comment or a rewrite (finding folding), and the rewrite
// plan and write the Already-ticketed `rewrite` action and the ticket merge share. vscode-free; logging goes through
// the injected `onDiag`.
import type { TicketService } from '../services/TicketService';
import type { DiagLogger } from '../utils/diagTypes';
import { stringOrNull } from '../utils/reportImport';
import { logDroppedFields } from './create';
import type { ReportImportDescriptor } from './descriptor';
import { buildReviewPage, restoreMergedRows } from './rows';
import {
  emptyImportOutcomes, isTicketedRowFinished, ticketedTargetKey,
  type AddMode, type ReviewRowBase, type ReviewSession, type TicketedRowResult,
} from './types';

type AddTargetIssue = Awaited<ReturnType<TicketService['getIssue']>>;

/**
 * KTD6: what writing to ticket `key` involves — the findings its description would be rebuilt from
 * (the added rows plus the Already-ticketed rows whose target it is, the ticket's own rows first)
 * and the findings it records that none of those cover, which a rewrite drops and says so.
 */
export function planRewrite<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  key: string,
  issueLabels: string[],
  extraRows: TRow[],
): { regenItem: TItem; droppedKeys: string[] } {
  const fold = descriptor.fold!;
  // A source an earlier merge in this review already folded into `key` still feeds it until a refresh re-derives the targets.
  const ticketRows = session.allRows.filter(r => r.existingTicketKey === key || (r.result?.status === 'done' && r.result.action === 'merge' && r.result.into === key));
  const regenItem = fold.combine([...ticketRows, ...extraRows].map(fold.itemOf));
  const covered = new Set(descriptor.dedupKeyOf?.(regenItem) ?? []);
  const recorded = issueLabels.map(l => descriptor.labelToDedupKey?.(l) ?? null).filter((k): k is string => k !== null);
  return { regenItem, droppedKeys: [...new Set(recorded.filter(k => !covered.has(k)))] };
}

/**
 * KTD10: the labels a rewrite takes off the ticket — the components it recorded that the report no longer has.
 * Only for an importer that reads its target tickets (Waltz); a component merely filtered or accepted away is still in
 * the report, so its label stays.
 */
export function labelsToRemove<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  droppedKeys: string[],
): string[] {
  if (!descriptor.changeTracking?.readsTargetDescriptions) return [];
  const inReport = new Set(session.reportKeys ?? []);
  return droppedKeys.filter(k => !inReport.has(k));
}

/** What a rewrite knows about the ticket it rebuilds: its creation time and Due Date, and which part of the rebuilt item is joining it. */
export interface RewriteTarget<TItem> {
  ticketCreated?: string | null;
  currentDueDate?: string | null;
  joiningItem?: TItem | null;
}

/**
 * KTD7: rebuilds `key` from `regenItem` — the importer's own summary, description and labels (no template labels) — in one write.
 * An importer's Due Date rides in the same write; `dueDate` is what was set, `droppedFields` what Jira refused.
 * `target` is what the caller already read from the ticket and which part of `regenItem` is joining it.
 */
export async function writeRewrite<TItem, TRow extends ReviewRowBase>(
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  key: string,
  regenItem: TItem,
  removeLabels: string[] = [],
  target: RewriteTarget<TItem> = {},
  onDiag?: DiagLogger,
): Promise<{ dueDate: string | null; droppedFields: string[] }> {
  const fields = descriptor.buildRowFields(regenItem, []);
  const built = descriptor.buildTicketFields({ ...fields, id: '0', existingTicketKey: null, included: true } as unknown as TRow, {}, { ticketCreated: target.ticketCreated });
  const dueDate = descriptor.rewriteDueDate?.({
    regenItem, joiningItem: target.joiningItem ?? null, currentDueDate: target.currentDueDate ?? null, ticketCreated: target.ticketCreated ?? null,
  }) ?? null;
  const { droppedFields } = await ticketService.rewriteTicket(key, {
    summary: built.summary,
    description: String(built.fields.description ?? ''),
    labelsToAdd: (built.fields.labels as string[] | undefined) ?? [],
    removePrefix: descriptor.changeTracking?.removeLabelPrefix,
    ...(removeLabels.length > 0 ? { removeLabels } : {}),
    ...(dueDate ? { extraFields: { duedate: dueDate }, optionalFields: ['duedate'] } : {}),
  });
  if (droppedFields) logDroppedFields(onDiag, key, droppedFields);
  return { dueDate: droppedFields?.includes('duedate') ? null : dueDate, droppedFields: droppedFields ?? [] };
}

/** The visible New rows an add names, or null when the page no longer holds them all. */
function rowsToAdd<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, ids: string[]): TRow[] | null {
  const rows = session.rows.filter(r => r.existingTicketKey === null && ids.includes(r.id));
  return rows.length === ids.length ? rows : null;
}

/** What step one of `add … to <KEY>` found: the page no longer holds the rows, the ticket could not be read, or what the add would do. */
export type AddTargetCheck =
  | { kind: 'rows-gone' }
  | { kind: 'read-failed'; error: string }
  | { kind: 'ready'; summary: string; status: string | null; resolved: boolean; rowCount: number; droppedKeys: string[] };

/** Step one of `add … to <KEY>` (KTD5): reads the ticket and works out what a rewrite would drop. Writes nothing. */
export async function checkAddTarget<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  onDiag?: DiagLogger,
): Promise<AddTargetCheck> {
  const rows = rowsToAdd(session, ids);
  if (!rows) return { kind: 'rows-gone' };
  let issue: AddTargetIssue;
  try {
    issue = await ticketService.getIssue(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onDiag?.('warn', `Could not read the target ticket — ${key}`, { issueKey: key, error: message });
    return { kind: 'read-failed', error: message };
  }
  const { droppedKeys } = planRewrite(session, descriptor, key, issue.fields.labels ?? [], rows);
  return {
    kind: 'ready', summary: issue.fields.summary ?? '', status: issue.fields.status?.name ?? null,
    resolved: issue.fields.resolution != null, rowCount: rows.length, droppedKeys,
  };
}

/**
 * What step two of `add … to <KEY>` did: the page no longer holds the rows (nothing written), the write failed (the rows
 * stay in New), or it was written — with the comment posted unless `commentFailed` says why not.
 */
export type AddResult<TRow extends ReviewRowBase> =
  | { kind: 'rows-gone'; session: ReviewSession<TRow> }
  | { kind: 'failed'; session: ReviewSession<TRow>; error: string }
  | { kind: 'done'; session: ReviewSession<TRow>; commentFailed: string | null; dueDate: string | null; droppedFields: string[] };

/**
 * Step two of `add … to <KEY>` (KTD5-KTD7): Comment adds the record labels and posts a comment listing
 * the added findings; Rewrite rebuilds summary, description and labels and then posts that comment
 * plus any dropped findings. A failed write keeps the rows in New; a comment that fails after the
 * write is reported and the rows still leave New, because their findings are now recorded.
 */
export async function addRowsToTicket<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  mode: AddMode,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  onDiag?: DiagLogger,
): Promise<AddResult<TRow>> {
  const rows = rowsToAdd(session, ids);
  if (!rows) return { kind: 'rows-gone', session };
  const fold = descriptor.fold!;
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  const failWith = (message: string): AddResult<TRow> => {
    onDiag?.('error', `Add to existing ticket failed — ${key}`, { issueKey: key, mode, error: message });
    return { kind: 'failed', error: message, session: { ...session, outcomes: { ...outcomes, addFailed: outcomes.addFailed + rows.length } } };
  };

  let comment: string;
  let droppedFields: string[] = [];
  let dueDate: string | null = null;
  try {
    const issue = await ticketService.getIssue(key);
    const ticketCreated = stringOrNull(issue.fields.created);
    const labels = issue.fields.labels ?? [];
    const addedItem = fold.combine(rows.map(fold.itemOf));
    const plan = planRewrite(session, descriptor, key, labels, rows);
    const ratingPrefix = descriptor.changeTracking?.removeLabelPrefix;
    if (mode === 'comment') {
      // A rating label already on the ticket is left alone: a comment must not change its rating.
      const recordLabels = fold.recordLabelsOf(addedItem);
      const toAdd = ratingPrefix && labels.some(l => l.startsWith(ratingPrefix))
        ? recordLabels.filter(l => !l.startsWith(ratingPrefix)) : recordLabels;
      await ticketService.updateLabels(key, toAdd);
      comment = fold.buildComment(addedItem, [], { ticketCreated });
    } else {
      const written = await writeRewrite(ticketService, descriptor, key, plan.regenItem, labelsToRemove(session, descriptor, plan.droppedKeys), {
        ticketCreated, currentDueDate: stringOrNull(issue.fields.duedate), joiningItem: addedItem,
      }, onDiag);
      droppedFields = written.droppedFields;
      dueDate = written.dueDate;
      comment = fold.buildComment(addedItem, plan.droppedKeys, { dueDate, ticketCreated });
    }
  } catch (err) {
    return failWith(err instanceof Error ? err.message : String(err));
  }

  let commentFailed: string | null = null;
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (err) {
    commentFailed = err instanceof Error ? err.message : String(err);
    onDiag?.('warn', `Added to ticket but the comment failed — ${key}`, { issueKey: key, mode, error: commentFailed });
  }
  onDiag?.(commentFailed ? 'warn' : 'info', `${descriptor.importLabel} import — ${rows.length} row(s) added to ${key} (${mode})`, { issueKey: key, mode });

  // The added rows leave New. Other rows on the page (merged ones included) are left as they are.
  const gone = new Set(rows.flatMap(r => r.memberIds ?? [r.id]));
  const isGone = (r: TRow) => r.existingTicketKey === null && gone.has(r.id);
  // A rewrite rebuilt the ticket from the rows that already point to it, so those are done too.
  const rewrittenResult: TicketedRowResult = commentFailed
    ? { status: 'done', action: 'rewrite', note: 'comment-failed' } : { status: 'done', action: 'rewrite' };
  const markRewritten = (r: TRow): TRow =>
    mode === 'rewrite' && r.existingTicketKey !== null && !isTicketedRowFinished(r) && ticketedTargetKey(r) === key
      ? { ...r, result: rewrittenResult } : r;
  // The page is rebuilt from allRows so rows from the next page slide in; merged rows that stay keep their merge.
  const allRows = session.allRows.filter(r => !isGone(r)).map(markRewritten);
  const page = buildReviewPage(allRows, session.page);
  const keptMerged = session.rows.filter(r => r.existingTicketKey === null && r.memberIds && !ids.includes(r.id));
  return {
    kind: 'done',
    commentFailed,
    dueDate,
    droppedFields,
    session: {
      ...session,
      allRows,
      rows: restoreMergedRows(page.rows, keptMerged),
      page: page.page,
      outcomes: { ...outcomes, added: outcomes.added + rows.length },
    },
  };
}
