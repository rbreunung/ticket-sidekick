// Report import: the Already-ticketed group's per-row actions (update, new ticket, rewrite, re-create) and the
// bounded-concurrency runner that applies them. vscode-free; logging goes through the injected `onDiag`, each row's
// result through `onEvent`.
import type { TicketService } from '../services/TicketService';
import { BATCH_LIMIT, stringOrNull } from '../utils/reportImport';
import { createTicketForRow, type CreateEvent } from './create';
import type { BuiltTicketFields, ReportImportDescriptor } from './descriptor';
import { labelsToRemove, planRewrite, writeRewrite } from './rewrite';
import {
  emptyImportOutcomes, findPartialRewrites, isTicketedRowFinished, ticketedRowActions, ticketedTargetKey,
  type ImportHooks, type ReviewRowBase, type ReviewSession, type TicketedAction, type TicketedRowResult,
} from './types';

// Bounded concurrency for `update` rows (label write + comment per row) — a report with a few
// hundred already-ticketed rows would otherwise turn one reply into that many sequential round trips.
const UPDATE_CONCURRENCY = 8;

/** What happens to each row while the actions run, in order. */
export type TicketedEvent =
  | { kind: 'start'; count: number }
  | { kind: 'update'; key: string; outcome: 'baseline' | 'up-to-date' | 'updated' | 'comment-failed' | 'failed'; error?: string }
  | { kind: 'rewrite'; key: string; rowCount: number; outcome: 'done' | 'comment-failed' | 'failed'; error?: string; dueDate: string | null; droppedFields: string[] }
  | { kind: 'row-failed'; ref: string; error: string }
  | { kind: 'link-failed'; key: string; relatesTo: string; error: string }
  | { kind: 'create'; event: CreateEvent };

/** What a run did: refused for a partial rewrite, found nothing to run, or ran with these counts. */
export type TicketedRunResult<TRow extends ReviewRowBase> =
  | { kind: 'partial-rewrite'; session: ReviewSession<TRow>; partial: Array<{ key: string; rewriteIds: string[]; otherIds: string[] }> }
  | { kind: 'nothing'; session: ReviewSession<TRow> }
  | {
    kind: 'ran'; session: ReviewSession<TRow>;
    updated: number; upToDate: number; followedUp: number; recreated: number; rewritten: number; failed: number; remaining: number;
  };

/**
 * Import ticket updates parity: runs the already-ticketed rows whose action is in
 * `actions` (every non-`leave` action for `apply`, one action for a shortcut) — at most
 * `BATCH_LIMIT` per reply, the rest stay pending and the result says how many remain. `update` rows
 * run with bounded concurrency; `follow-up` and `re-create` rows are created one at a time through
 * the same creation step as New rows. Each row records its own result, one row failing never stops
 * the others, and a finished row is never run again.
 */
export async function runTicketedActions<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  actions: ReadonlySet<TicketedAction>,
  command: string,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  hooks: ImportHooks<TicketedEvent> = {},
): Promise<TicketedRunResult<TRow>> {
  // Rewrite rebuilds a whole ticket, so it is all-or-none per target. Checked before anything
  // is written; a violation stops the whole apply.
  if (actions.has('rewrite')) {
    const partial = findPartialRewrites(session.allRows);
    if (partial.length > 0) return { kind: 'partial-rewrite', session, partial };
  }

  const candidates = session.allRows.filter(r => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return false;
    const { action } = ticketedRowActions(r);
    return action !== 'leave' && actions.has(action);
  });
  if (candidates.length === 0) return { kind: 'nothing', session };

  // At most BATCH_LIMIT rows run per reply, but the rows of one ticket's rewrite run together or not
  // at all; a single group larger than the cap still runs whole.
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
  hooks.onEvent?.({ kind: 'start', count: toRun.length });

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
        results.set(row.id, await updateTicketedRow(row, ticketService, descriptor, baseUrl, hooks));
      }
    }));
  }
  for (const row of creations) {
    results.set(row.id, await createForTicketedRow(row, session, ticketService, descriptor, baseUrl, hooks));
  }
  let rewrittenTickets = 0;
  let rewriteFailedTickets = 0;
  for (const [key, rows] of rewriteGroups) {
    const result = await rewriteTicketedGroup(rows, key, session, ticketService, descriptor, baseUrl, hooks);
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

  hooks.onDiag?.(failed > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} already-ticketed actions — ${updated} updated, ${followedUp} follow-ups, ${recreated} re-created, ${failed} failed`,
    { command, updated, upToDate, followedUp, recreated, rewritten: rewrittenTickets, updateFailed, followUpFailed, recreateFailed, rewriteFailed: rewriteFailedTickets, remaining },
  );

  const mark = (r: TRow): TRow => {
    const result = results.get(r.id);
    return result && r.existingTicketKey !== null ? { ...r, result } : r;
  };
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    kind: 'ran',
    updated, upToDate, followedUp, recreated, rewritten: rewrittenTickets, failed, remaining,
    session: {
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
    },
  };
}

/**
 * Finding folding: `rewrite` on one target ticket, for every unfinished row that
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
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl: string | undefined,
  hooks: ImportHooks<TicketedEvent>,
): Promise<TicketedRowResult> {
  const fold = descriptor.fold;
  let comment: string;
  let droppedFields: string[] = [];
  let dueDate: string | null = null;
  const report = (outcome: 'done' | 'comment-failed' | 'failed', error?: string) =>
    hooks.onEvent?.({ kind: 'rewrite', key, rowCount: rows.length, outcome, ...(error !== undefined ? { error } : {}), dueDate, droppedFields });
  try {
    if (!fold) throw new Error('rewrite is not available for this import');
    const issue = await ticketService.getIssue(key);
    const ticketCreated = stringOrNull(issue.fields.created);
    const added = rows.flatMap(r => {
      const change = r.change;
      if (change?.kind !== 'findings' || change.newIds.length === 0) return [];
      const item = fold.itemOf(r);
      return [fold.narrowToNew ? fold.narrowToNew(item, change) : item];
    });
    const addedItem = fold.combine(added);
    const plan = planRewrite(session, descriptor, key, issue.fields.labels ?? [], []);
    const written = await writeRewrite(ticketService, descriptor, key, plan.regenItem, labelsToRemove(session, descriptor, plan.droppedKeys), {
      ticketCreated, currentDueDate: stringOrNull(issue.fields.duedate), joiningItem: addedItem,
    }, hooks.onDiag);
    droppedFields = written.droppedFields;
    dueDate = written.dueDate;
    const dateChanges = rows.flatMap(r => (r.change?.kind === 'findings' && r.change.dates?.length
      ? [{ ref: descriptor.itemRefFor(r), changes: r.change.dates }] : []));
    comment = fold.buildComment(addedItem, plan.droppedKeys, { dateChanges, dueDate, ticketCreated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hooks.onDiag?.('error', `Rewrite of existing ticket failed — ${key}`, { issueKey: key, error: message });
    report('failed', message);
    return { status: 'failed', action: 'rewrite', error: message };
  }
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (commentErr) {
    const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
    hooks.onDiag?.('warn', `Rewritten but the comment failed — ${key}`, { issueKey: key, error: message });
    report('comment-failed', message);
    return { status: 'done', action: 'rewrite', note: 'comment-failed' };
  }
  report('done');
  return { status: 'done', action: 'rewrite' };
}

/**
 * `update` on one row — one read-merge-write of the target ticket's record labels (plus
 * the rewritten summary on a rating rise), then one comment listing the change. A baseline row only
 * gets its record labels. A comment failure after the labels were written is reported as such (the
 * labels are not undone), and a ticket that already carries everything is left untouched.
 */
async function updateTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl: string | undefined,
  hooks: ImportHooks<TicketedEvent>,
): Promise<TicketedRowResult> {
  const tracking = descriptor.changeTracking;
  const change = row.change;
  const ticketKey = ticketedTargetKey(row);
  const report = (outcome: 'baseline' | 'up-to-date' | 'updated' | 'comment-failed' | 'failed', error?: string) =>
    hooks.onEvent?.({ kind: 'update', key: ticketKey, outcome, ...(error !== undefined ? { error } : {}) });
  try {
    if (!tracking || !change) throw new Error('nothing to update on this row');
    if (!tracking.recordLabelsOf || !tracking.buildUpdateComment) throw new Error('update is not offered for this import');
    const labels = tracking.recordLabelsOf(row, change);
    const prefix = tracking.removeLabelPrefix;
    const removePrefix = prefix && labels.some(l => l.startsWith(prefix)) ? prefix : undefined;
    const findings = change.kind === 'findings' ? change : null;
    const rewriteSummary = findings && tracking.rewriteSummary
      ? (summary: string) => tracking.rewriteSummary!(summary, findings)
      : undefined;
    const written = await ticketService.updateLabels(ticketKey, labels, { removePrefix, rewriteSummary });

    if (!findings) {
      report('baseline');
      return { status: 'done', action: 'update', note: 'baseline' };
    }
    if (written.added.length === 0 && written.removed.length === 0 && !written.summaryRewritten) {
      report('up-to-date');
      return { status: 'done', action: 'update', note: 'up-to-date' };
    }
    try {
      await ticketService.addComment(ticketKey, tracking.buildUpdateComment(row, findings, { summaryUnchanged: written.summaryUnchanged }), baseUrl);
    } catch (commentErr) {
      const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
      hooks.onDiag?.('warn', `Labels updated but comment failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
      report('comment-failed', message);
      return { status: 'done', action: 'update', note: 'comment-failed' };
    }
    report('updated');
    return { status: 'done', action: 'update' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hooks.onDiag?.('error', `Update of existing ticket failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
    report('failed', message);
    return { status: 'failed', action: 'update', error: message };
  }
}

/**
 * `re-create` creates the row's full ticket as for a New row; `follow-up` creates a ticket
 * with only the new findings and links it "Relates" to the target ticket. A failed link keeps the
 * ticket, warns and logs.
 */
async function createForTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl: string | undefined,
  hooks: ImportHooks<TicketedEvent>,
): Promise<TicketedRowResult> {
  const createHooks: ImportHooks<CreateEvent> = { onDiag: hooks.onDiag, onEvent: event => hooks.onEvent?.({ kind: 'create', event }) };
  if (ticketedRowActions(row).action === 're-create') {
    const created = await createTicketForRow(row, session, ticketService, descriptor, baseUrl, undefined, createHooks);
    return 'key' in created
      ? { status: 'done', action: 're-create', key: created.key }
      : { status: 'failed', action: 're-create', error: created.error };
  }

  const tracking = descriptor.changeTracking;
  const originalKey = ticketedTargetKey(row);
  // A follow-up that holds only the new findings needs some; an importer with its own action policy (Waltz) creates a
  // full ticket instead, which is also offered on a row with no change, so it needs none.
  const fullTicket = !!tracking?.deriveActions;
  const change = row.change?.kind === 'findings' ? row.change : (fullTicket ? { kind: 'findings' as const, newIds: [] } : null);
  if (!tracking || !change || (!fullTicket && change.newIds.length === 0)) {
    const error = 'no new findings for a follow-up';
    hooks.onEvent?.({ kind: 'row-failed', ref: descriptor.itemRefFor(row), error });
    return { status: 'failed', action: 'follow-up', error };
  }
  let built: BuiltTicketFields;
  try {
    built = tracking.buildFollowUp(row, change, originalKey, session.additionalFields);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    hooks.onDiag?.('error', `Could not build follow-up — ${descriptor.itemRefFor(row)}`, { originalKey, error });
    hooks.onEvent?.({ kind: 'row-failed', ref: descriptor.itemRefFor(row), error });
    return { status: 'failed', action: 'follow-up', error };
  }
  const created = await createTicketForRow(row, session, ticketService, descriptor, baseUrl, built, createHooks);
  if (!('key' in created)) return { status: 'failed', action: 'follow-up', error: created.error };

  try {
    await ticketService.linkIssues(created.key, originalKey);
    return { status: 'done', action: 'follow-up', key: created.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hooks.onDiag?.('warn', `Follow-up created but not linked — ${created.key}`, {
      issueKey: created.key, relatesTo: originalKey, error: message,
    });
    hooks.onEvent?.({ kind: 'link-failed', key: created.key, relatesTo: originalKey, error: message });
    return { status: 'done', action: 'follow-up', key: created.key, linkMissing: true };
  }
}

