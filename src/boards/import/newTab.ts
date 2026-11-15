import type { Applied, ApplyProgress, Planned, Reduced } from '../../sessions/boardKind';
import type { ApplyLineResult, WritePlan } from '../../sessions/sessionTypes';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import { createTicketForRow, droppedFieldsNote } from '../../imports/create';
import { addRowsToTicket } from '../../imports/rewrite';
import { mergeNewRows } from '../../imports/rows';
import type { AddMode, ReviewRowBase, ReviewSession } from '../../imports/types';
import { BATCH_LIMIT, templateLabelsOf } from '../../utils/reportImport';
import type { HandlerPayload, ImportHandler, ImportSession } from './handlers';
import type { ImportWorking } from './kind';
import { newRows, rowKeyOf, ticketedRows, type ImportData, type ImportDeps, type ImportRow } from './read';

// The import board's handler for the New tab: selecting, merging and unmerging rows, adding rows to an existing ticket, and creating tickets. vscode-free.

const NAME = 'new';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const OUT_OF_DATE = 'The New tab is out of date. Refresh it first.';

/** What this handler keeps for itself: the existing tickets New rows were added to (a created record with such a key is an add, not a create). */
interface NewExt {
  added: string[];
}

/** What one Apply of this tab writes. Rows are named by their row keys; each group is one ticket. */
type NewPayload = HandlerPayload & (
  | { op: 'create'; groups: string[][] }
  | { op: 'add'; groups: string[][]; ticket: string; mode: AddMode }
);

/** One would-be ticket: a single row, or the rows of a merge in report order. */
interface Group {
  keys: string[];
  rows: ImportRow[];
}

/** What the page gets beyond the rows: how many tickets the create still has to make, how many one Apply makes, and the rows added to an existing ticket. */
export interface NewTabView {
  toCreate: number;
  perApply: number;
  addedTo: Record<string, string>;
}

function extOf(working: ImportWorking): NewExt {
  const ext = working.ext[NAME] as Partial<NewExt> | undefined;
  return { added: Array.isArray(ext?.added) ? ext!.added : [] };
}

function createdKeys(working: ImportWorking): Set<string> {
  return new Set(working.writes.created.flatMap(c => c.dedupKeys));
}

/** The New rows without a ticket from this board yet, by row key, in report order. */
function openRows(data: ImportData, working: ImportWorking): Map<string, ImportRow> {
  const created = createdKeys(working);
  const open = new Map<string, ImportRow>();
  for (const row of newRows(data)) {
    const key = rowKeyOf(data, row);
    if (!key.split('\n').every(k => created.has(k))) open.set(key, row);
  }
  return open;
}

/** The open rows as tickets: a merge whose rows are all open is one group at its first row's place; every other row is its own. */
function groupsOf(data: ImportData, working: ImportWorking): Group[] {
  const open = openRows(data, working);
  const mergeOf = new Map<string, string[]>();
  for (const merge of working.choices.merges) {
    if (merge.length > 1 && merge.every(key => open.has(key))) for (const key of merge) mergeOf.set(key, merge);
  }
  const groups: Group[] = [];
  const placed = new Set<string>();
  for (const key of open.keys()) {
    if (placed.has(key)) continue;
    const keys = mergeOf.get(key) ?? [key];
    keys.forEach(k => placed.add(k));
    groups.push({ keys, rows: keys.map(k => open.get(k)!) });
  }
  return groups;
}

function isIncluded(group: Group, working: ImportWorking): boolean {
  return !group.keys.some(key => working.choices.excluded.includes(key));
}

/** How a group is named: its flaw ids, or its components. */
function groupRef(group: Group): string {
  const first = group.rows[0];
  if ('issueIds' in first) return `Flaw ${group.rows.flatMap(r => ('issueIds' in r ? r.issueIds : [])).join(', ')}`;
  return group.rows.map(r => ('nameVersion' in r ? r.nameVersion : r.id)).join(', ');
}

/** The groups the named row ids belong to, in report order; null when an id names no open New row. */
function groupsOfIds(session: ImportSession, ids: unknown): Group[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) return null;
  const { data } = session.derived;
  const groups = groupsOf(data, session.working);
  const wanted = new Set(ids as string[]);
  const found = new Set<string>();
  const picked = groups.filter(g => g.rows.some(r => {
    const hit = wanted.has(r.id);
    if (hit) found.add(r.id);
    return hit;
  }));
  for (const g of picked) g.rows.forEach(r => found.add(r.id));
  return [...wanted].every(id => found.has(id)) ? picked : null;
}

function withChoices(working: ImportWorking, change: Partial<ImportWorking['choices']>): ImportWorking {
  return { ...working, choices: { ...working.choices, ...change } };
}

function reduceNew(session: ImportSession, action: { type: string } & Record<string, unknown>): Reduced<ImportWorking> | undefined {
  if (!['new-include', 'new-merge', 'new-unmerge'].includes(action.type)) return undefined;
  const { working } = session;
  if (working.outOfDate.includes('new')) return { ok: false, reason: OUT_OF_DATE };
  const { data } = session.derived;

  if (action.type === 'new-include') {
    if (typeof action.included !== 'boolean') return { ok: false, reason: 'Say whether the rows are in the create or left out.' };
    const groups = action.ids === 'all' ? groupsOf(data, working) : groupsOfIds(session, action.ids);
    if (!groups) return { ok: false, reason: 'Pick new rows that have no ticket yet.' };
    const keys = new Set(groups.flatMap(g => g.keys));
    const kept = working.choices.excluded.filter(key => !keys.has(key));
    return { ok: true, working: withChoices(working, { excluded: action.included ? kept : [...kept, ...keys] }) };
  }

  if (action.type === 'new-merge') {
    const groups = groupsOfIds(session, action.ids);
    if (!groups || groups.length < 2) return { ok: false, reason: 'Pick at least two new rows to merge.' };
    const order = [...openRows(data, working).keys()];
    const keys = groups.flatMap(g => g.keys).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const touched = new Set(keys);
    const merges = [...working.choices.merges.filter(m => !m.some(key => touched.has(key))), keys];
    // A merged row starts in the create, like the chat's.
    return { ok: true, working: withChoices(working, { merges, excluded: working.choices.excluded.filter(key => !touched.has(key)) }) };
  }

  const row = typeof action.id === 'string' ? newRows(data).find(r => r.id === action.id) : undefined;
  const key = row ? rowKeyOf(data, row) : undefined;
  const merge = key ? working.choices.merges.find(m => m.includes(key)) : undefined;
  if (!merge) return { ok: false, reason: 'That row is not merged.' };
  return { ok: true, working: withChoices(working, { merges: working.choices.merges.filter(m => m !== merge) }) };
}

function lineFor(group: Group, issueType: string): { target: string; change: string } {
  return {
    target: groupRef(group),
    change: group.rows.length > 1
      ? `New ${issueType} for the ${group.rows.length} merged rows, with the folded title and description`
      : `New ${issueType}: ${group.rows[0].summary}`,
  };
}

function planNew(session: ImportSession, action: { type: string } & Record<string, unknown>): Planned | undefined {
  if (action.type !== 'new-create' && action.type !== 'new-add') return undefined;
  const { working, recipe } = session;
  if (working.outOfDate.includes('new')) return { ok: false, reason: OUT_OF_DATE };
  const { data } = session.derived;

  if (action.type === 'new-create') {
    const included = groupsOf(data, working).filter(g => isIncluded(g, working));
    if (included.length === 0) return { ok: false, reason: 'Nothing to create: no new row is selected.' };
    const batch = included.slice(0, BATCH_LIMIT);
    const remaining = included.length - batch.length;
    const payload: NewPayload = { handler: NAME, op: 'create', groups: batch.map(g => g.keys) };
    const plan: WritePlan<NewPayload> = {
      title: `Create ${batch.length} ticket(s) in ${recipe.projectKey}${remaining > 0 ? `. ${remaining} more remain for the next Apply` : ''}`,
      lines: batch.map(g => lineFor(g, recipe.issueType)),
      risky: batch.length > 1,
      payload,
    };
    return { ok: true, plan };
  }

  const ticket = typeof action.key === 'string' ? action.key.trim().toUpperCase() : '';
  if (!ISSUE_KEY.test(ticket)) return { ok: false, reason: 'Name the ticket to add the rows to by its ticket key, for example SEC-12.' };
  if (action.mode !== 'comment' && action.mode !== 'rewrite') return { ok: false, reason: 'Add the rows as a comment or as a rewrite.' };
  const groups = groupsOfIds(session, action.ids);
  if (!groups) return { ok: false, reason: 'Pick new rows that have no ticket yet.' };
  const ref = groups.map(groupRef).join('; ');
  const payload: NewPayload = { handler: NAME, op: 'add', groups: groups.map(g => g.keys), ticket, mode: action.mode };
  const plan: WritePlan<NewPayload> = {
    title: `Add ${ref} to ${ticket} as a ${action.mode}`,
    lines: [{
      target: ticket,
      change: action.mode === 'comment'
        ? `Add the record labels of ${ref} and post a comment listing the added findings`
        : `Rewrite the summary, description and labels from the ticket's findings and ${ref}, set the Due Date by the rewrite rule, and post a comment listing the added findings and any that are no longer listed`,
    }],
    risky: false,
    payload,
  };
  return { ok: true, plan };
}

type AnyDescriptor = ReportImportDescriptor<unknown, ImportRow & ReviewRowBase>;

function descriptorOf(session: ImportSession, deps: ImportDeps): AnyDescriptor {
  const descriptors = deps.descriptors();
  return (session.recipe.kind === 'waltz' ? descriptors.waltz : descriptors.veracode) as unknown as AnyDescriptor;
}

/** The row the engine writes for a group: the row itself, or the merged row the chat builds from its members. */
function engineRow(group: Group, review: ReviewSession<ImportRow>, descriptor: AnyDescriptor): ImportRow {
  if (group.rows.length === 1) return group.rows[0];
  const fold = descriptor.fold!;
  const templateLabels = templateLabelsOf(review.additionalFields);
  return mergeNewRows(group.rows, group.rows.map(r => r.id), members =>
    descriptor.buildRowFields(fold.combine(members.map(fold.itemOf)), templateLabels))[0];
}

/** The payload's groups as they stand now; null for a group whose rows are no longer open New rows. */
function currentGroups(session: ImportSession, groups: string[][]): Array<Group | null> {
  const open = openRows(session.derived.data, session.working);
  return groups.map(keys => (keys.every(k => open.has(k)) ? { keys, rows: keys.map(k => open.get(k)!) } : null));
}

const GONE = 'This row is no longer a new row without a ticket, so nothing was written.';

function dedupKeysOf(group: Group): string[] {
  return group.keys.flatMap(key => key.split('\n'));
}

async function applyNew(
  session: ImportSession, plan: WritePlan, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>,
): Promise<Applied<ImportData, ImportWorking>> {
  const payload = plan.payload as NewPayload;
  const descriptor = descriptorOf(session, deps);
  const review = session.derived.data.review;
  const { ticketService } = await deps.writeAccess();
  const baseUrl = await deps.baseUrl();
  const groups = currentGroups(session, payload.groups);
  const results: ApplyLineResult[] = [];
  let working = session.working;
  const record = (dedupKeys: string[], key: string, tickets?: ImportWorking['writes']['tickets']) => {
    working = { ...working, writes: { ...working.writes, created: [...working.writes.created, { dedupKeys, key }], ...(tickets ? { tickets } : {}) } };
  };

  if (payload.op === 'create') {
    for (const [n, group] of groups.entries()) {
      if (!group) {
        results.push({ target: payload.groups[n].join(', '), outcome: 'refused', reason: GONE });
      } else {
        let dropped: string[] | undefined;
        const outcome = await createTicketForRow(engineRow(group, review, descriptor), review, ticketService, descriptor, baseUrl, undefined, {
          onDiag: deps.onDiag,
          onEvent: event => { if (event.kind === 'created') dropped = event.droppedFields; },
        });
        if ('key' in outcome) {
          record(dedupKeysOf(group), outcome.key);
          results.push({ target: `${groupRef(group)}: ${outcome.key}`, outcome: 'done', ...(dropped?.length ? { reason: droppedFieldsNote(dropped) } : {}) });
        } else {
          results.push({ target: groupRef(group), outcome: 'failed', reason: outcome.error });
        }
      }
      await progress?.({ working, done: n + 1, total: groups.length });
    }
    return { results, derived: session.derived, working };
  }

  const ticket = payload.ticket;
  if (groups.some(g => g === null)) {
    return { results: [{ target: ticket, outcome: 'refused', reason: GONE }], derived: session.derived, working };
  }
  const live = groups as Group[];
  const rows = live.map(g => engineRow(g, review, descriptor));
  const engineSession: ReviewSession<ImportRow> = { ...review, rows: [...ticketedRows(session.derived.data), ...rows] };
  const target = `${live.map(groupRef).join('; ')}: ${ticket}`;
  const result = await addRowsToTicket(engineSession, rows.map(r => r.id), ticket, payload.mode, ticketService, descriptor, baseUrl, deps.onDiag);
  if (result.kind === 'rows-gone') {
    results.push({ target, outcome: 'refused', reason: GONE });
  } else if (result.kind === 'failed') {
    results.push({ target, outcome: 'failed', reason: result.error });
  } else {
    let updated: string | undefined;
    try {
      updated = (await deps.updatedTimes([ticket]))[ticket];
    } catch {
      // Without it a later check sees the ticket as changed by someone else.
    }
    record(live.flatMap(dedupKeysOf), ticket, { ...working.writes.tickets, [ticket]: updated !== undefined ? { updated } : {} });
    const ext = extOf(working);
    working = { ...working, ext: { ...working.ext, [NAME]: { added: [...new Set([...ext.added, ticket])] } satisfies NewExt } };
    const notes = [
      ...(result.commentFailed ? [`the comment could not be posted: ${result.commentFailed}`] : []),
      ...(result.dueDate ? [descriptor.dueDateNote ? descriptor.dueDateNote(result.dueDate) : `Due Date set to ${result.dueDate}`] : []),
      ...(result.droppedFields.length > 0 ? [droppedFieldsNote(result.droppedFields)] : []),
    ];
    results.push({ target, outcome: 'done', ...(notes.length > 0 ? { reason: notes.join('; ') } : {}) });
  }
  await progress?.({ working, done: 1, total: 1 });
  return { results, derived: session.derived, working };
}

export const newTabHandler: ImportHandler = {
  name: NAME,
  reduce: reduceNew,
  plan: planNew,
  apply: applyNew,
  view: (session, tab) => {
    if (tab !== 'new') return undefined;
    const { data } = session.derived;
    const { working } = session;
    const added = new Set(extOf(working).added);
    const addedTo: Record<string, string> = {};
    for (const row of newRows(data)) {
      const keys = rowKeyOf(data, row).split('\n');
      const into = working.writes.created.find(c => added.has(c.key) && keys.every(k => c.dedupKeys.includes(k)));
      if (into) addedTo[row.id] = into.key;
    }
    const view: NewTabView = {
      toCreate: groupsOf(data, working).filter(g => isIncluded(g, working)).length,
      perApply: BATCH_LIMIT,
      addedTo,
    };
    return view;
  },
};
