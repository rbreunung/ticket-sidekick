import type { ApplyLineResult, Conflict, WritePlan } from '../../sessions/sessionTypes';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import { applyTicketedActionChange, buildReviewPage } from '../../imports/rows';
import { runTicketedActions, type TicketedEvent } from '../../imports/ticketedActions';
import {
  findPartialRewrites, isTicketedRowFinished, ticketedRowActions, ticketedTargetKey,
  type ReviewSession, type TicketedAction,
} from '../../imports/types';
import { BATCH_LIMIT } from '../../utils/reportImport';
import type { HandlerPayload, ImportHandler, ImportSession } from './handlers';
import { rowKeyOf, ticketedRows, type ImportData, type ImportDeps, type ImportRow } from './read';
import { decided, type ImportWorking } from './kind';

// The import board's handler for the Already ticketed tab: filters, per-row actions and their writes. vscode-free.
//
// The tab shows the changed rows (rows without a Due Date count as changed), the unchanged ones or
// all. "Set all shown to" changes only the rows the filter shows; Apply writes every row's choice,
// shown or not, through the shared engine: one write per target ticket, a rewrite covering all rows
// of its ticket or none, at most 50 tickets per Apply.

const NAME = 'ticketed';
const ACTIONS: readonly TicketedAction[] = ['update', 'follow-up', 'rewrite', 're-create', 'leave'];

export type TicketedFilter = 'changed' | 'unchanged' | 'all';

/** What this handler keeps in `working.ext.ticketed`. */
interface TicketedState {
  /** Set only for the Unchanged filter, which the kind's own show modes cannot express. */
  unchanged?: boolean;
  /** What the last "set all shown to" did. */
  notice?: string;
}

/** One write of an Apply: a ticket rewritten from all its rows, or one row's own action. */
interface TicketedUnit {
  action: TicketedAction;
  ticket: string;
  rowKeys: string[];
}

interface TicketedPayload extends HandlerPayload {
  units: TicketedUnit[];
}

function stateOf(working: ImportWorking): TicketedState {
  const value = working.ext[NAME];
  return typeof value === 'object' && value !== null ? value as TicketedState : {};
}

function withState(working: ImportWorking, state: TicketedState): ImportWorking {
  return { ...working, ext: { ...working.ext, [NAME]: state } };
}

function isAction(value: unknown): value is TicketedAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function descriptorOf(session: ImportSession, descriptors: ReturnType<ImportDeps['descriptors']>): ReportImportDescriptor<unknown, ImportRow> {
  return descriptors[session.recipe.kind] as unknown as ReportImportDescriptor<unknown, ImportRow>;
}

function rowRef(row: ImportRow): string {
  return 'issueIds' in row ? `Flaw ${row.issueIds.join(', ')}` : row.nameVersion;
}

/** The word the import shows for an action: both report kinds' descriptors call a follow-up "new ticket". */
const LABELS: Record<TicketedAction, string> = { update: 'update', 'follow-up': 'new ticket', rewrite: 'rewrite', 're-create': 're-create', leave: 'leave' };

/**
 * The review's rows with the board's choices laid over them: a chosen action replaces the default,
 * and a row whose ticket the board already wrote counts as finished, as in the chat import.
 */
function boardRows(session: ImportSession): ImportRow[] {
  const { data } = session.derived;
  const { choices, writes } = session.working;
  return data.review.allRows.map(r => {
    if (r.existingTicketKey === null) return r;
    const chosen = choices.actions[rowKeyOf(data, r)];
    const action = chosen ?? r.action ?? 'leave';
    const written = decided(writes, ticketedTargetKey(r));
    return {
      ...r, action,
      ...(written && !isTicketedRowFinished(r) ? { result: { status: 'done' as const, action: 'rewrite' as const } } : {}),
    };
  });
}

/** The chosen actions after a change: kept only where they differ from the row's default. */
function actionsFrom(data: ImportData, rows: ImportRow[], base: Record<string, TicketedAction>): Record<string, TicketedAction> {
  const actions = { ...base };
  const byId = new Map(data.review.allRows.map(r => [r.id, r]));
  for (const row of rows) {
    if (row.existingTicketKey === null) continue;
    const original = byId.get(row.id);
    if (!original) continue;
    const key = rowKeyOf(data, original);
    const action = row.action ?? 'leave';
    if (action === (original.action ?? 'leave')) delete actions[key];
    else actions[key] = action;
  }
  return actions;
}

function needsDecision(session: ImportSession, row: ImportRow): boolean {
  const ticket = ticketedTargetKey(row);
  return row.change !== null && row.change !== undefined && !decided(session.working.writes, ticket) && row.result?.status !== 'done';
}

function hasNoDueDate(row: ImportRow): boolean {
  return row.change?.kind === 'findings' && (row.change.dates ?? []).some(d => d.date === 'due' && d.from === null);
}

/** The filter in force: the kind's show mode, with Unchanged kept by this handler. */
function filterOf(session: ImportSession): TicketedFilter {
  const show = session.working.ticketedShow
    ?? (ticketedRows(session.derived.data).some(r => needsDecision(session, r)) ? 'decision' : 'all');
  if (show === 'decision') return 'changed';
  return stateOf(session.working).unchanged ? 'unchanged' : 'all';
}

function matchesText(session: ImportSession, row: ImportRow): boolean {
  const text = session.working.filters.ticketed;
  if (!text) return true;
  const needle = text.toLowerCase();
  return [rowRef(row), row.summary, ticketedTargetKey(row)].some(f => (f ?? '').toLowerCase().includes(needle));
}

/** The Already-ticketed rows the tab shows: those of the filter that match the text filter. */
function shownRows(session: ImportSession): ImportRow[] {
  const filter = filterOf(session);
  return ticketedRows(session.derived.data).filter(r => {
    if (filter === 'changed' && !needsDecision(session, r)) return false;
    if (filter === 'unchanged' && r.change !== null && r.change !== undefined) return false;
    return matchesText(session, r);
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : '(s)'}`;
}

/** The writes an Apply makes, in row order: a rewrite unit per target ticket, any other action per row. */
function unitsOf(data: ImportData, rows: ImportRow[]): TicketedUnit[] {
  const units = new Map<string, TicketedUnit>();
  for (const row of rows) {
    if (row.existingTicketKey === null || isTicketedRowFinished(row)) continue;
    const { action } = ticketedRowActions(row);
    if (action === 'leave') continue;
    const ticket = ticketedTargetKey(row);
    const id = action === 'rewrite' ? `rewrite:${ticket}` : `row:${row.id}`;
    const unit = units.get(id) ?? { action, ticket, rowKeys: [] };
    unit.rowKeys.push(rowKeyOf(data, row));
    units.set(id, unit);
  }
  return [...units.values()];
}

function describeUnit(unit: TicketedUnit, rows: ImportRow[], label: (a: TicketedAction) => string): string {
  const refs = rows.map(rowRef).join('; ');
  switch (unit.action) {
    case 'rewrite': return `Rewrite from ${refs}`;
    case 'follow-up': return `Create a ${label('follow-up')} for ${refs}, linked to ${unit.ticket}`;
    case 're-create': return `Create the ticket for ${refs} again`;
    default: return `Update the labels and comment for ${refs}`;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const ticketedTabHandler: ImportHandler = {
  name: NAME,

  reduce: (session, action) => {
    const { data } = session.derived;
    const working = session.working;
    switch (action.type) {
      case 'ticketed-filter': {
        const filter = action.filter;
        if (filter !== 'changed' && filter !== 'unchanged' && filter !== 'all') {
          return { ok: false, reason: 'Show the changed rows, the unchanged rows, or all rows.' };
        }
        const { notice: _notice, ...state } = stateOf(working);
        return {
          ok: true,
          working: withState(
            { ...working, ticketedShow: filter === 'changed' ? 'decision' : 'all' },
            { ...state, unchanged: filter === 'unchanged' },
          ),
        };
      }
      case 'ticketed-action': {
        if (!isAction(action.action)) return { ok: false, reason: 'That is not an action of this tab.' };
        const row = ticketedRows(data).find(r => r.id === action.id);
        if (!row) return { ok: false, reason: 'That row is no longer on Already ticketed.' };
        const rows = boardRows(session);
        const current = rows.find(r => r.id === row.id)!;
        if (isTicketedRowFinished(current)) return { ok: false, reason: `${ticketedTargetKey(row)} was already written.` };
        if (!ticketedRowActions(current).allowedActions.includes(action.action)) {
          return { ok: false, reason: `${rowRef(row)} does not offer ${LABELS[action.action]}.` };
        }
        const changed = applyTicketedActionChange(rows, row.id, action.action);
        return { ok: true, working: { ...working, choices: { ...working.choices, actions: actionsFrom(data, changed, working.choices.actions) } } };
      }
      case 'ticketed-set-shown': {
        if (!isAction(action.action)) return { ok: false, reason: 'That is not an action of this tab.' };
        const chosen = action.action;
        const shown = new Set(shownRows(session).map(r => r.id));
        const rows = boardRows(session).filter(r => shown.has(r.id) && !isTicketedRowFinished(r));
        if (rows.length === 0) return { ok: false, reason: 'No row is shown that can still be changed.' };
        const offering = rows.filter(r => ticketedRowActions(r).allowedActions.includes(chosen));
        if (offering.length === 0) return { ok: false, reason: `No row shown offers ${LABELS[chosen]}.` };
        const skipped = rows.length - offering.length;
        let changed = boardRows(session);
        for (const row of offering) changed = applyTicketedActionChange(changed, row.id, chosen);
        const notice = `Set ${plural(offering.length, 'row')} to ${LABELS[chosen]}.`
          + (skipped > 0 ? ` ${plural(skipped, 'row')} do not offer ${LABELS[chosen]} and kept their action.` : '');
        return {
          ok: true,
          working: withState(
            { ...working, choices: { ...working.choices, actions: actionsFrom(data, changed, working.choices.actions) } },
            { ...stateOf(working), notice },
          ),
        };
      }
      default:
        return undefined;
    }
  },

  plan: (session, action) => {
    if (action.type !== 'ticketed-apply') return undefined;
    const { data } = session.derived;
    const rows = boardRows(session);
    const partial = findPartialRewrites(rows);
    if (partial.length > 0) {
      const byId = new Map(rows.map(r => [r.id, r]));
      const refs = (ids: string[]) => ids.map(id => rowRef(byId.get(id)!)).join(', ');
      const detail = partial.map(p => `${p.key}: ${refs(p.rewriteIds)} on rewrite, ${refs(p.otherIds)} not`).join('; ');
      return {
        ok: false,
        reason: `Nothing was planned. A rewrite rebuilds a whole ticket, so it must cover all the rows of that ticket or none (${detail}). Set them to the same action.`,
      };
    }
    const units = unitsOf(data, rows);
    if (units.length === 0) return { ok: false, reason: 'Nothing to apply: every row is set to leave or already written.' };

    // One unit writes one ticket; a rewrite of one ticket is one unit, so it is never split.
    const now = units.slice(0, BATCH_LIMIT);
    const remaining = units.length - now.length;
    const byKey = new Map(ticketedRows(data).map(r => [rowKeyOf(data, r), r]));
    const plan: WritePlan<TicketedPayload> = {
      title: `Write ${plural(now.length, 'ticket')} from Already ticketed`
        + (remaining > 0 ? `; ${remaining} more ticket write(s) remain for the next Apply` : ''),
      lines: now.map(unit => ({
        target: unit.ticket,
        change: describeUnit(unit, unit.rowKeys.map(k => byKey.get(k)!), a => LABELS[a]),
      })),
      risky: now.length > 1,
      payload: { handler: NAME, units: now },
    };
    return { ok: true, plan };
  },

  apply: async (session, plan, deps, progress) => {
    const { units } = plan.payload as TicketedPayload;
    const { data } = session.derived;
    const descriptor = descriptorOf(session, deps.descriptors());
    const { ticketService } = await deps.writeAccess();
    const baseUrl = await deps.baseUrl();
    const rows = boardRows(session);
    const engine: ReviewSession<ImportRow> = { ...data.review, allRows: rows, rows: buildReviewPage(rows, 0).rows };

    let working: ImportWorking = { ...session.working, writes: { ...session.working.writes, tickets: { ...session.working.writes.tickets } } };
    const results: ApplyLineResult[] = [];
    const conflicts: Conflict[] = [];
    /** `updated` after this Apply's own writes, so a second write to the same ticket is not taken for someone else's change. */
    const own: Record<string, string> = {};
    let done = 0;

    for (const unit of units) {
      const unitRows = rows.filter(r => r.existingTicketKey !== null && unit.rowKeys.includes(rowKeyOf(data, r)));
      const fits = unitRows.length === unit.rowKeys.length
        && unitRows.every(r => !isTicketedRowFinished(r) && ticketedTargetKey(r) === unit.ticket && ticketedRowActions(r).action === unit.action);
      const finish = async (result: ApplyLineResult) => {
        results.push(result);
        done++;
        if (progress) await progress({ working, done, total: units.length });
      };
      if (!fits) {
        await finish({ target: unit.ticket, outcome: 'refused', reason: 'the rows are no longer as previewed' });
        continue;
      }

      // The truth is Jira: a ticket changed since the board read it is not written to.
      const expected = own[unit.ticket] ?? data.updated[unit.ticket];
      if (expected !== undefined) {
        let current: string | undefined;
        try {
          current = (await deps.updatedTimes([unit.ticket]))[unit.ticket];
        } catch (err) {
          await finish({ target: unit.ticket, outcome: 'failed', reason: `could not be read: ${messageOf(err)}` });
          continue;
        }
        if (current !== expected) {
          conflicts.push({ id: unit.ticket, target: unit.ticket, message: 'changed in Jira and was not written to.', stored: expected, fresh: current ?? 'gone' });
          await finish({ target: unit.ticket, outcome: 'refused', reason: 'changed in Jira since the board read it' });
          continue;
        }
      }

      const ids = new Set(unitRows.map(r => r.id));
      const only: ReviewSession<ImportRow> = {
        ...engine,
        allRows: engine.allRows.map(r => (r.existingTicketKey !== null && !ids.has(r.id) && !isTicketedRowFinished(r) ? { ...r, action: 'leave' as const } : r)),
      };
      const events: TicketedEvent[] = [];
      let outcome: ApplyLineResult;
      let written: string[] = [];
      try {
        const ran = await runTicketedActions(only, new Set([unit.action]), 'apply', ticketService, descriptor, baseUrl, {
          onDiag: deps.onDiag, onEvent: event => events.push(event),
        });
        const result = ran.kind === 'ran' ? ran.session.allRows.find(r => r.id === unitRows[0].id)?.result : undefined;
        if (!result) {
          outcome = { target: unit.ticket, outcome: 'failed', reason: 'nothing was written' };
        } else if (result.status === 'failed') {
          outcome = { target: unit.ticket, outcome: 'failed', reason: result.error };
        } else {
          const notes: string[] = [];
          written = [unit.ticket];
          if (result.action === 'rewrite') {
            const event = events.find((e): e is Extract<TicketedEvent, { kind: 'rewrite' }> => e.kind === 'rewrite');
            if (event?.dueDate) notes.push(descriptor.dueDateNote?.(event.dueDate) ?? `Due Date set to ${event.dueDate}`);
            if (event && event.droppedFields.length > 0) notes.push(`Jira did not accept ${event.droppedFields.join(', ')}, so it was left out`);
            if (result.note === 'comment-failed') notes.push(`rewritten, but the comment could not be added${event?.error ? `: ${event.error}` : ''}`);
          } else if (result.action === 'follow-up' || result.action === 're-create') {
            written.push(result.key);
            notes.push(`created ${result.key}`);
            if (result.action === 'follow-up' && result.linkMissing) notes.push(`but it could not be linked to ${unit.ticket}`);
          } else if (result.action === 'update' && result.note === 'comment-failed') {
            notes.push('labels updated, but the comment could not be added');
          }
          outcome = { target: unit.ticket, outcome: 'done', ...(notes.length > 0 ? { reason: notes.join('; ') } : {}) };
        }
      } catch (err) {
        outcome = { target: unit.ticket, outcome: 'failed', reason: messageOf(err) };
      }

      if (written.length > 0) {
        // Jira's `updated` after the write, so a later check knows the change was the board's own.
        let times: Record<string, string> = {};
        try {
          times = await deps.updatedTimes(written);
        } catch (err) {
          deps.onDiag?.('warn', 'Import board: the update time after a write could not be read', { keys: written, error: messageOf(err) });
        }
        const tickets = { ...working.writes.tickets };
        for (const key of written) {
          tickets[key] = times[key] !== undefined ? { updated: times[key] } : {};
          if (times[key] !== undefined) own[key] = times[key];
        }
        // A created follow-up is not recorded as a New create: the next reading finds it as the row's ticket.
        working = { ...working, writes: { ...working.writes, tickets } };
      }
      await finish(outcome);
    }

    return { results, derived: session.derived, working, conflicts };
  },

  view: (session, tab) => {
    if (tab !== 'ticketed') return undefined;
    const rows = ticketedRows(session.derived.data);
    const changed = rows.filter(r => needsDecision(session, r)).length;
    const unchanged = rows.filter(r => r.change === null || r.change === undefined).length;
    return {
      filter: filterOf(session),
      shown: shownRows(session).map(r => r.id),
      noDueDate: rows.filter(r => hasNoDueDate(r) && !decided(session.working.writes, ticketedTargetKey(r))).map(r => r.id),
      notice: stateOf(session.working).notice ?? null,
      counts: { changed, unchanged, all: rows.length },
      actionLabels: LABELS,
    };
  },
};
