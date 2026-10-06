// Report import: adding New rows to an existing ticket as a comment or a rewrite (finding folding),
// and the rewrite plan the Already-ticketed `rewrite` action shares.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { buildAddPrompt, buildReviewPage, emptyImportOutcomes, isTicketedRowFinished, restoreMergedRows, ticketedTargetKey, type AddMode, type ReviewRowBase, type ReviewSession, type TicketedRowResult } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import type { ReportImportDescriptor } from './reportImportTypes';

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
  const ticketRows = session.allRows.filter(r => r.existingTicketKey === key);
  const regenItem = fold.combine([...ticketRows, ...extraRows].map(fold.itemOf));
  const covered = new Set(descriptor.dedupKeyOf?.(regenItem) ?? []);
  const recorded = issueLabels.map(l => descriptor.labelToDedupKey?.(l) ?? null).filter((k): k is string => k !== null);
  return { regenItem, droppedKeys: [...new Set(recorded.filter(k => !covered.has(k)))] };
}

/** KTD7: rebuilds `key` from `regenItem` — the importer's own summary, description and labels (no template labels) — in one write. */
export async function writeRewrite<TItem, TRow extends ReviewRowBase>(
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  key: string,
  regenItem: TItem,
): Promise<void> {
  const fields = descriptor.buildRowFields(regenItem, []);
  const built = descriptor.buildTicketFields({ ...fields, id: '0', existingTicketKey: null, included: true } as unknown as TRow, {});
  await ticketService.rewriteTicket(key, {
    summary: built.summary,
    description: String(built.fields.description ?? ''),
    labelsToAdd: (built.fields.labels as string[] | undefined) ?? [],
    removePrefix: descriptor.changeTracking?.removeLabelPrefix,
  });
}

/** The visible New rows an add names, or null (with a message) when the page no longer holds them. */
function rowsToAdd<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, ids: string[], stream: vscode.ChatResponseStream): TRow[] | null {
  const rows = session.rows.filter(r => r.existingTicketKey === null && ids.includes(r.id));
  if (rows.length !== ids.length) {
    stream.markdown("_Those rows are no longer on this page, so nothing was added._\n\n");
    return null;
  }
  return rows;
}

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
  const rows = rowsToAdd(session, ids, stream);
  if (!rows) return;
  let issue: AddTargetIssue;
  try {
    issue = await ticketService.getIssue(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Could not read the target ticket — ${key}`, { issueKey: key, error: message });
    stream.markdown(`✗ ${key} — ${message}\n\n`);
    return;
  }
  const { droppedKeys } = planRewrite(session, descriptor, key, issue.fields.labels ?? [], rows);
  stream.markdown(trustedChatMarkdown(buildAddPrompt({
    key, summary: issue.fields.summary ?? '', status: issue.fields.status?.name ?? null,
    resolved: issue.fields.resolution != null, ids, rowCount: rows.length, droppedKeys, baseUrl,
  })));
}

/**
 * Step two of `add … to <KEY>` (KTD5-KTD7): Comment adds the record labels and posts a comment listing
 * the added findings; Rewrite rebuilds summary, description and labels and then posts that comment
 * plus any dropped findings. A failed write keeps the rows in New; a comment that fails after the
 * write is reported and the rows still leave New, because their findings are now recorded.
 */
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
  const rows = rowsToAdd(session, ids, stream);
  if (!rows) return session;
  const fold = descriptor.fold!;
  const link = formatKeyLink(key, baseUrl);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  const failWith = (message: string): ReviewSession<TRow> => {
    logDiag(descriptor.scope, 'error', `Add to existing ticket failed — ${key}`, { issueKey: key, mode, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { ...session, outcomes: { ...outcomes, addFailed: outcomes.addFailed + rows.length } };
  };

  let comment: string;
  try {
    const issue = await ticketService.getIssue(key);
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
      comment = fold.buildComment(addedItem, []);
    } else {
      await writeRewrite(ticketService, descriptor, key, plan.regenItem);
      comment = fold.buildComment(addedItem, plan.droppedKeys);
    }
  } catch (err) {
    return failWith(err instanceof Error ? err.message : String(err));
  }

  let commentFailed: string | null = null;
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (err) {
    commentFailed = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Added to ticket but the comment failed — ${key}`, { issueKey: key, mode, error: commentFailed });
  }
  const done = mode === 'comment' ? 'labels added and comment posted' : 'rewritten and comment posted';
  stream.markdown(commentFailed
    ? `⚠ ${link} — ${mode === 'comment' ? 'labels added' : 'rewritten'}, comment failed: ${commentFailed}\n\n`
    : `✓ ${link} — ${done}\n\n`);
  logDiag(descriptor.scope, commentFailed ? 'warn' : 'info', `${descriptor.importLabel} import — ${rows.length} row(s) added to ${key} (${mode})`, { issueKey: key, mode });

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
    ...session,
    allRows,
    rows: restoreMergedRows(page.rows, keptMerged),
    page: page.page,
    outcomes: { ...outcomes, added: outcomes.added + rows.length },
  };
}
