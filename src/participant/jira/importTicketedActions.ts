// Report import: the Already-ticketed screen's per-row actions (update, follow-up, rewrite, re-create)
// and the bounded-concurrency runner that applies them.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { BATCH_LIMIT } from '../../utils/reportImport';
import { emptyImportOutcomes, findPartialRewrites, isTicketedRowFinished, ticketedRowActions, ticketedTargetKey, type ReviewRowBase, type ReviewSession, type TicketedAction, type TicketedRowResult } from '../sessionState';
import { planRewrite, writeRewrite } from './importAddToTicket';
import { createOne } from './importCreate';
import type { ReportImportDescriptor } from './reportImportTypes';

/** KTD5/KTD7: which row actions each Already-ticketed run reply runs, and the word to repeat for the rest. */
export const TICKETED_RUNS: Record<'apply' | 'update' | 'recreate', { actions: ReadonlySet<TicketedAction>; command: string }> = {
  apply: { actions: new Set<TicketedAction>(['update', 'follow-up', 'rewrite', 're-create']), command: 'apply' },
  update: { actions: new Set<TicketedAction>(['update']), command: 'update tickets' },
  recreate: { actions: new Set<TicketedAction>(['re-create']), command: 're-create tickets' },
};

// Bounded concurrency for `update` rows (label write + comment per row) — a report with a few
// hundred already-ticketed rows would otherwise turn one reply into that many sequential round trips.
const UPDATE_CONCURRENCY = 8;

/**
 * Import ticket updates parity (KTD5, R9-R16): runs the already-ticketed rows whose action is in
 * `actions` (every non-`leave` action for `apply`, one action for a shortcut) — at most
 * `BATCH_LIMIT` per reply, the rest stay pending and the reply says how many remain. `update` rows
 * run with bounded concurrency; `follow-up` and `re-create` rows are created one at a time through
 * the same creation step as New rows. Each row records its own result, one row failing never stops
 * the others, and a finished row is never run again.
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
  // KTD11: rewrite rebuilds a whole ticket, so it is all-or-none per target. Checked before anything
  // is written; a violation stops the whole apply.
  if (actions.has('rewrite')) {
    const partial = findPartialRewrites(session.allRows);
    if (partial.length > 0) {
      const detail = partial.map(p => `${p.key}: ${p.rewriteIds.join(', ')} ${p.rewriteIds.length === 1 ? 'is' : 'are'} on rewrite but ${p.otherIds.join(', ')} ${p.otherIds.length === 1 ? 'is' : 'are'} not`).join('; ');
      stream.markdown(`_Nothing was written. Rewrite rebuilds a whole ticket, so it must cover all the rows that point to it or none of them (${detail}). Use \`all rewrite\`, or set the others to another action._\n\n`);
      return session;
    }
  }

  const candidates = session.allRows.filter(r => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return false;
    const { action } = ticketedRowActions(r);
    return action !== 'leave' && actions.has(action);
  });
  if (candidates.length === 0) {
    stream.markdown(command === 'apply'
      ? '_Nothing to apply — every row is set to leave or already done._\n\n'
      : `_Nothing to apply — no row is set to \`${[...actions][0]}\`._\n\n`);
    return session;
  }

  // At most BATCH_LIMIT rows run per reply, but the rows of one ticket's rewrite run together or not
  // at all (KTD11); a single group larger than the cap still runs whole.
  const units = new Map<string, TRow[]>();
  for (const r of candidates) {
    const unit = ticketedRowActions(r).action === 'rewrite' ? `rewrite:${ticketedTargetKey(r)}` : `row:${r.id}`;
    const members = units.get(unit);
    if (members) members.push(r); else units.set(unit, [r]);
  }
  const toRun: TRow[] = [];
  for (const unit of units.values()) {
    if (toRun.length > 0 && toRun.length + unit.length > BATCH_LIMIT) break;
    toRun.push(...unit);
  }
  const remaining = candidates.length - toRun.length;
  stream.markdown(`_Applying ${toRun.length} action(s)…_\n\n`);

  const results = new Map<string, TicketedRowResult>();
  const updates = toRun.filter(r => ticketedRowActions(r).action === 'update');
  const creations = toRun.filter(r => ['follow-up', 're-create'].includes(ticketedRowActions(r).action));
  const rewriteGroups = new Map<string, TRow[]>();
  for (const r of toRun.filter(r => ticketedRowActions(r).action === 'rewrite')) {
    const key = ticketedTargetKey(r);
    const members = rewriteGroups.get(key);
    if (members) members.push(r); else rewriteGroups.set(key, [r]);
  }
  // Rows that update the same ticket (several Waltz components can share one) run one after the
  // other: each label write reads the ticket first, so parallel ones would overwrite each other.
  const updateBuckets = new Map<string, TRow[]>();
  for (const r of updates) {
    const key = ticketedTargetKey(r);
    const bucket = updateBuckets.get(key);
    if (bucket) bucket.push(r); else updateBuckets.set(key, [r]);
  }
  const buckets = [...updateBuckets.values()];
  for (let i = 0; i < buckets.length; i += UPDATE_CONCURRENCY) {
    await Promise.all(buckets.slice(i, i + UPDATE_CONCURRENCY).map(async bucket => {
      for (const row of bucket) {
        results.set(row.id, await updateTicketedRow(row, ticketService, stream, descriptor, baseUrl));
      }
    }));
  }
  for (const row of creations) {
    results.set(row.id, await createForTicketedRow(row, session, ticketService, stream, descriptor, baseUrl));
  }
  let rewrittenTickets = 0;
  let rewriteFailedTickets = 0;
  for (const [key, rows] of rewriteGroups) {
    const result = await rewriteTicketedGroup(rows, key, session, ticketService, stream, descriptor, baseUrl);
    for (const row of rows) results.set(row.id, result);
    if (result.status === 'done') rewrittenTickets++; else rewriteFailedTickets++;
  }

  const all = [...results.values()];
  const count = (action: TicketedAction, status: 'done' | 'failed') => all.filter(r => r.action === action && r.status === status).length;
  const upToDate = all.filter(r => r.status === 'done' && r.action === 'update' && r.note === 'up-to-date').length;
  const updated = count('update', 'done') - upToDate;
  const followedUp = count('follow-up', 'done');
  const recreated = count('re-create', 'done');
  const updateFailed = count('update', 'failed');
  const followUpFailed = count('follow-up', 'failed');
  const recreateFailed = count('re-create', 'failed');
  const failed = updateFailed + followUpFailed + recreateFailed + rewriteFailedTickets;

  let summary = `**${updated}** updated, ${followedUp} follow-up(s) created, ${recreated} re-created` +
    (rewrittenTickets > 0 ? `, ${rewrittenTickets} rewritten` : '') +
    (upToDate > 0 ? `, ${upToDate} already up to date` : '') + `, ${failed} failed.`;
  if (remaining > 0) {
    summary += ` _${remaining} remain — capped at ${BATCH_LIMIT} actions per reply; reply \`${command}\` again to run them._`;
  }
  stream.markdown(`${summary}\n\n`);
  logDiag(descriptor.scope, failed > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} already-ticketed actions — ${updated} updated, ${followedUp} follow-ups, ${recreated} re-created, ${failed} failed`,
    { command, updated, upToDate, followedUp, recreated, rewritten: rewrittenTickets, updateFailed, followUpFailed, recreateFailed, rewriteFailed: rewriteFailedTickets, remaining },
  );

  const mark = (r: TRow): TRow => {
    const result = results.get(r.id);
    return result && r.existingTicketKey !== null ? { ...r, result } : r;
  };
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    allRows: session.allRows.map(mark),
    rows: session.rows.map(mark),
    outcomes: {
      ...outcomes,
      updated: outcomes.updated + updated,
      updateFailed: outcomes.updateFailed + updateFailed,
      followedUp: outcomes.followedUp + followedUp,
      followUpFailed: outcomes.followUpFailed + followUpFailed,
      recreated: outcomes.recreated + recreated,
      recreateFailed: outcomes.recreateFailed + recreateFailed,
      rewritten: outcomes.rewritten + rewrittenTickets,
      rewriteFailed: outcomes.rewriteFailed + rewriteFailedTickets,
    },
  };
}

/**
 * Finding folding (KTD6/KTD7/KTD11): `rewrite` on one target ticket, for every unfinished row that
 * points to it — the ticket's summary, description and labels are rebuilt from all rows that point
 * to it, then one comment names the findings its tickets did not record yet and any it recorded
 * that the rebuilt description no longer covers. A failed write leaves the ticket as it was; a
 * comment that fails afterwards is reported but the rewrite stands.
 */
async function rewriteTicketedGroup<TItem, TRow extends ReviewRowBase>(
  rows: TRow[],
  key: string,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  const fold = descriptor.fold;
  const link = formatKeyLink(key, baseUrl);
  let comment: string;
  try {
    if (!fold) throw new Error('rewrite is not available for this import');
    const issue = await ticketService.getIssue(key);
    const added = rows.flatMap(r => {
      const change = r.change;
      if (change?.kind !== 'findings' || change.newIds.length === 0) return [];
      const item = fold.itemOf(r);
      return [fold.narrowToNew ? fold.narrowToNew(item, change) : item];
    });
    const addedItem = fold.combine(added);
    const plan = planRewrite(session, descriptor, key, issue.fields.labels ?? [], []);
    await writeRewrite(ticketService, descriptor, key, plan.regenItem);
    comment = fold.buildComment(addedItem, plan.droppedKeys);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Rewrite of existing ticket failed — ${key}`, { issueKey: key, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { status: 'failed', action: 'rewrite', error: message };
  }
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (commentErr) {
    const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
    logDiag(descriptor.scope, 'warn', `Rewritten but the comment failed — ${key}`, { issueKey: key, error: message });
    stream.markdown(`⚠ ${link} — rewritten, but the comment could not be posted: ${message}\n\n`);
    return { status: 'done', action: 'rewrite', note: 'comment-failed' };
  }
  stream.markdown(`✓ ${link} — rewritten from ${rows.length} row(s)\n\n`);
  return { status: 'done', action: 'rewrite' };
}

/**
 * R11-R13: `update` on one row — one read-merge-write of the target ticket's record labels (plus
 * the rewritten summary on a rating rise), then one comment listing the change. A baseline row only
 * gets its record labels. A comment failure after the labels were written is reported as such (the
 * labels are not undone), and a ticket that already carries everything is left untouched.
 */
async function updateTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  const tracking = descriptor.changeTracking;
  const change = row.change;
  const ticketKey = ticketedTargetKey(row);
  const link = formatKeyLink(ticketKey, baseUrl);
  try {
    if (!tracking || !change) throw new Error('nothing to update on this row');
    const labels = tracking.recordLabelsOf(row, change);
    const prefix = tracking.removeLabelPrefix;
    const removePrefix = prefix && labels.some(l => l.startsWith(prefix)) ? prefix : undefined;
    const findings = change.kind === 'findings' ? change : null;
    const rewriteSummary = findings && tracking.rewriteSummary
      ? (summary: string) => tracking.rewriteSummary!(summary, findings)
      : undefined;
    const written = await ticketService.updateLabels(ticketKey, labels, { removePrefix, rewriteSummary });

    if (!findings) {
      stream.markdown(`✓ ${link} — baseline recorded\n\n`);
      return { status: 'done', action: 'update', note: 'baseline' };
    }
    if (written.added.length === 0 && written.removed.length === 0 && !written.summaryRewritten) {
      stream.markdown(`– ${link} — already up to date\n\n`);
      return { status: 'done', action: 'update', note: 'up-to-date' };
    }
    try {
      await ticketService.addComment(ticketKey, tracking.buildUpdateComment(row, findings, { summaryUnchanged: written.summaryUnchanged }), baseUrl);
    } catch (commentErr) {
      const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
      logDiag(descriptor.scope, 'warn', `Labels updated but comment failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
      stream.markdown(`⚠ ${link} — labels updated but the comment could not be posted: ${message}\n\n`);
      return { status: 'done', action: 'update', note: 'comment-failed' };
    }
    stream.markdown(`✓ ${link} — updated\n\n`);
    return { status: 'done', action: 'update' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Update of existing ticket failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { status: 'failed', action: 'update', error: message };
  }
}

/**
 * R14/R15: `re-create` creates the row's full ticket as for a New row; `follow-up` creates a ticket
 * with only the new findings and links it "Relates" to the target ticket. A failed link keeps the
 * ticket, warns and logs (AE5).
 */
async function createForTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  if (ticketedRowActions(row).action === 're-create') {
    const created = await createOne(row, session, ticketService, stream, descriptor, baseUrl);
    return 'key' in created
      ? { status: 'done', action: 're-create', key: created.key }
      : { status: 'failed', action: 're-create', error: created.error };
  }

  const change = row.change;
  const tracking = descriptor.changeTracking;
  const originalKey = ticketedTargetKey(row);
  if (!tracking || change?.kind !== 'findings' || change.newIds.length === 0) {
    const error = 'no new findings for a follow-up';
    stream.markdown(`✗ ${descriptor.itemRefFor(row)} — ${error}\n\n`);
    return { status: 'failed', action: 'follow-up', error };
  }
  let built: { summary: string; fields: Record<string, unknown> };
  try {
    built = tracking.buildFollowUp(row, change, originalKey, session.additionalFields);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Could not build follow-up — ${descriptor.itemRefFor(row)}`, { originalKey, error });
    stream.markdown(`✗ ${descriptor.itemRefFor(row)} — ${error}\n\n`);
    return { status: 'failed', action: 'follow-up', error };
  }
  const created = await createOne(row, session, ticketService, stream, descriptor, baseUrl, built);
  if (!('key' in created)) return { status: 'failed', action: 'follow-up', error: created.error };

  try {
    await ticketService.linkIssues(created.key, originalKey);
    return { status: 'done', action: 'follow-up', key: created.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Follow-up created but not linked — ${created.key}`, {
      issueKey: created.key, relatesTo: originalKey, error: message,
    });
    stream.markdown(`⚠ ${formatKeyLink(created.key, baseUrl)} was created but could not be linked to ${originalKey}: ${message}\n\n`);
    return { status: 'done', action: 'follow-up', key: created.key, linkMissing: true };
  }
}
