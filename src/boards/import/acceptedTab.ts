import type { Applied, ApplyProgress, Planned } from '../../sessions/boardKind';
import type { ApplyLineResult, PlanLine, WritePlan } from '../../sessions/sessionTypes';
import {
  ACCEPTED_FILE_NAME, acceptedComponentEntriesOf, acceptedEntriesOf, addAcceptedEntries, isComponentEntry, removeAcceptedComponent, removeAcceptedPair,
  type AcceptedEntry,
} from '../../utils/waltzAccepted';
import type { WaltzReviewRow } from '../../utils/waltzReport';
import type { ImportHandler, ImportSession } from './handlers';
import { importKind, rowRef, type ImportTab, type ImportWorking } from './kind';
import { acceptedFingerprint, readImport, rowKeyOf, type ImportData, type ImportDeps, type ImportRow } from './read';

// The import board's handler for accepting and unaccepting Waltz CVEs and components, and reloading the report. vscode-free.
// Each is a preview and Apply that writes nothing to Jira, so none asks the native confirmation. Accept and unaccept
// write the accepted list through its service, which never writes over a file it could not read in full, then read
// the import again; reload reads the report again and keeps every choice whose rows still exist.

const NAME = 'accepted';
const MAX_REASON = 255;
const NO_WORKSPACE = 'No workspace folder is open, so the accepted list cannot be changed.';

type AcceptedPayload =
  | { handler: typeof NAME; op: 'accept-cve' | 'accept-component'; entries: AcceptedEntry[] }
  | { handler: typeof NAME; op: 'unaccept'; entry: { component: string; cve: string } | { component: string; version: string } }
  | { handler: typeof NAME; op: 'reload' };

type Action = { type: string } & Record<string, unknown>;

function describeEntry(entry: AcceptedEntry): string {
  return isComponentEntry(entry) ? `${entry.component}:${entry.version}` : `${entry.component} · ${entry.cve}`;
}

function plan(title: string, lines: PlanLine[], payload: AcceptedPayload): Planned {
  return { ok: true, plan: { title, lines, risky: false, payload } };
}

/** Why the list cannot be changed now: not a Waltz import, or a file that could not be read in full. */
function listProblem(session: ImportSession): string | undefined {
  if (session.recipe.kind !== 'waltz') return 'Only a Waltz import has an accepted list.';
  const warning = session.derived.data.accepted?.warning;
  return warning ? `${warning} The file was left as it is — fix it first.` : undefined;
}

function reasonOf(action: Action): { ok: true; reason?: string } | { ok: false; reason: string } {
  if (action.reason === undefined || action.reason === null) return { ok: true };
  if (typeof action.reason !== 'string' || action.reason.length > MAX_REASON) return { ok: false, reason: `A reason is text of at most ${MAX_REASON} characters.` };
  const reason = action.reason.trim();
  return reason ? { ok: true, reason } : { ok: true };
}

function namedRows(data: ImportData, action: Action): ImportRow[] | undefined {
  const ids = action.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string')) return undefined;
  const rows = data.review.allRows.filter(r => (ids as string[]).includes(r.id));
  return rows.length === ids.length ? rows : undefined;
}

function planAccept(session: ImportSession, action: Action, op: 'accept-cve' | 'accept-component'): Planned {
  const problem = listProblem(session);
  if (problem) return { ok: false, reason: problem };
  const { data } = session.derived;
  const rows = namedRows(data, action);
  if (!rows) return { ok: false, reason: 'Select the rows to accept; one of them is no longer on the board.' };
  const reason = reasonOf(action);
  if (!reason.ok) return reason;
  const group = (row: ImportRow) => (row as WaltzReviewRow).sourceGroup;

  let wanted: AcceptedEntry[];
  if (op === 'accept-cve') {
    const ticketed = rows.filter(r => r.existingTicketKey !== null);
    if (ticketed.length > 0) return { ok: false, reason: `Accept CVE works on New rows only; use Accept component for ${ticketed.map(rowRef).join(', ')}.` };
    wanted = rows.flatMap(r => acceptedEntriesOf(group(r), reason.reason));
    if (wanted.length === 0) return { ok: false, reason: `${rows.map(rowRef).join(', ')} lists no CVE to accept.` };
  } else {
    const versionless = rows.filter(r => acceptedComponentEntriesOf(group(r)).length === 0);
    if (versionless.length > 0) {
      return { ok: false, reason: `${versionless.map(rowRef).join(', ')} has no version, so it cannot be accepted as a whole component; accept its CVEs instead.` };
    }
    wanted = rows.flatMap(r => acceptedComponentEntriesOf(group(r), reason.reason));
  }
  // Only the entries not on the list yet, matched the way the list matches them.
  const current = data.accepted?.entries ?? [];
  const entries = addAcceptedEntries(current, wanted).entries.slice(current.length);
  if (entries.length === 0) return { ok: false, reason: 'Everything selected is already on the accepted list.' };
  const lines = entries.map(e => ({
    target: ACCEPTED_FILE_NAME,
    change: `Add ${describeEntry(e)}${isComponentEntry(e) ? ' as a whole component' : ''}${e.reason ? ` (${e.reason})` : ''}`,
  }));
  return plan(op === 'accept-cve' ? 'Accept CVEs' : 'Accept components', lines, { handler: NAME, op, entries });
}

function planUnaccept(session: ImportSession, action: Action): Planned {
  const problem = listProblem(session);
  if (problem) return { ok: false, reason: problem };
  const component = typeof action.component === 'string' ? action.component : undefined;
  const entries = session.derived.data.accepted?.entries ?? [];
  if (action.type === 'unaccept') {
    const cve = typeof action.cve === 'string' ? action.cve : undefined;
    if (!component || !cve) return { ok: false, reason: 'Name the component and the CVE to take off the accepted list.' };
    const found = removeAcceptedPair(entries, component, cve);
    if (!found) return { ok: false, reason: `${component} · ${cve} is not on the accepted list.` };
    return plan('Unaccept a CVE', [{ target: ACCEPTED_FILE_NAME, change: `Remove ${describeEntry(found.removed)}` }],
      { handler: NAME, op: 'unaccept', entry: { component, cve } });
  }
  const version = typeof action.version === 'string' ? action.version : undefined;
  if (!component || !version) return { ok: false, reason: 'Name the component and the version to take off the accepted list.' };
  const found = removeAcceptedComponent(entries, component, version);
  if (!found) return { ok: false, reason: `${component}:${version} is not on the accepted list.` };
  return plan('Unaccept a component', [{ target: ACCEPTED_FILE_NAME, change: `Remove ${describeEntry(found.removed)} (a whole component)` }],
    { handler: NAME, op: 'unaccept', entry: { component, version } });
}

/** The reload's preview: the read, then every unfinished choice, each kept only if its rows are still in the report. */
function planReload(session: ImportSession): Planned {
  const { data } = session.derived;
  const { choices, writes } = session.working;
  const refOf = (key: string) => {
    const row = data.review.allRows.find(r => rowKeyOf(data, r) === key);
    return row ? rowRef(row) : key.split('\n').join(', ');
  };
  const created = new Set(writes.created.flatMap(c => c.dedupKeys));
  const open = (key: string) => !key.split('\n').every(k => created.has(k));
  const kept = 'kept if the row is still in the report, dropped otherwise';
  const lines: PlanLine[] = [{ target: data.reportFileName, change: 'Read the report and Jira again' }];
  for (const key of choices.excluded.filter(open)) lines.push({ target: refOf(key), change: `Left out of the create: ${kept}` });
  for (const merge of choices.merges.filter(m => m.some(open))) {
    lines.push({ target: merge.map(refOf).join(' + '), change: 'Merged into one ticket: kept if all its rows are still new in the report, dropped otherwise' });
  }
  for (const [key, action] of Object.entries(choices.actions)) lines.push({ target: refOf(key), change: `Action "${action}": ${kept}` });
  for (const key of choices.staleSelected.filter(k => !writes.tickets[k])) {
    lines.push({ target: key, change: 'Selected for closing: kept if the ticket is still stale, dropped otherwise' });
  }
  return plan('Reload the report', lines, { handler: NAME, op: 'reload' });
}

/** The tabs a list change is about: they take the fresh reading as part of the change itself. */
const OWN_TABS: Record<'accept-cve' | 'accept-component' | 'unaccept', ImportTab[]> = {
  'accept-cve': ['new', 'accepted'],
  'accept-component': ['new', 'ticketed', 'stale', 'accepted'],
  unaccept: ['accepted'],
};

/**
 * The session after a list change. When only the tabs the change is about (or none) would be marked out of
 * date, the whole fresh reading is taken and every choice whose rows still exist is kept. Otherwise another tab
 * holds unfinished choices the change touched: the kind's own rule marks it, and it offers only Refresh.
 */
function afterListChange(session: ImportSession, fresh: Awaited<ReturnType<typeof readImport>>, own: ImportTab[]): { derived: ImportSession['derived']; working: ImportWorking } {
  const background = importKind.reconcile(session, fresh, 'background');
  if (background.working.outOfDate.every(tab => own.includes(tab))) {
    const refreshed = importKind.reconcile(session, fresh, 'refresh');
    return { derived: refreshed.derived, working: refreshed.working };
  }
  return { derived: background.derived, working: background.working };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function applyListChange(
  session: ImportSession, plan: WritePlan, payload: Exclude<AcceptedPayload, { op: 'reload' }>, deps: ImportDeps, progress?: ApplyProgress<ImportWorking>,
): Promise<Applied<ImportData, ImportWorking>> {
  const unchanged = (reason: string, outcome: 'refused' | 'failed' = 'refused'): Applied<ImportData, ImportWorking> => ({
    results: plan.lines.map(l => ({ target: l.target, outcome, reason })), derived: session.derived, working: session.working,
  });
  const service = deps.descriptors().waltz.accepted?.service();
  if (!service) return unchanged(NO_WORKSPACE);
  let written: { ok: true } | { ok: false; message: string };
  if (payload.op === 'unaccept') {
    const entry = payload.entry;
    written = 'cve' in entry ? service.removePair(entry.component, entry.cve) : service.removeComponent(entry.component, entry.version);
  } else {
    written = service.add(payload.entries);
  }
  if (!written.ok) {
    deps.onDiag?.('warn', 'Import board: the accepted list was not changed', { op: payload.op, error: written.message });
    return unchanged(written.message);
  }
  deps.onDiag?.('info', 'Import board: the accepted list was changed', { op: payload.op, lines: plan.lines.length });

  const writes = { ...session.working.writes, acceptedFile: await acceptedFingerprint(deps.workspaceRoot()) };
  const recorded: ImportSession = { ...session, working: { ...session.working, writes } };
  const results: ApplyLineResult[] = plan.lines.map(l => ({ target: l.target, outcome: 'done' }));
  await progress?.({ working: recorded.working, done: plan.lines.length, total: plan.lines.length });

  try {
    const fresh = await readImport(session.recipe, deps);
    return { results, ...afterListChange(recorded, fresh, OWN_TABS[payload.op]) };
  } catch (err) {
    // The list is written; the board shows what it showed until its next check reads the import again.
    deps.onDiag?.('warn', 'Import board: the import could not be read again after the accepted list changed', { error: messageOf(err) });
    return { results, derived: recorded.derived, working: recorded.working };
  }
}

async function applyReload(session: ImportSession, plan: WritePlan, deps: ImportDeps): Promise<Applied<ImportData, ImportWorking>> {
  const target = plan.lines[0]?.target ?? session.derived.data.reportFileName;
  try {
    const fresh = await readImport(session.recipe, deps);
    const refreshed = importKind.reconcile(session, fresh, 'refresh');
    return { results: [{ target, outcome: 'done' }], derived: refreshed.derived, working: refreshed.working };
  } catch (err) {
    return { results: [{ target, outcome: 'failed', reason: messageOf(err) }], derived: session.derived, working: session.working };
  }
}

export const acceptedTabHandler: ImportHandler = {
  name: NAME,

  plan: (session, action) => {
    switch (action.type) {
      case 'accept-cve': return planAccept(session, action, 'accept-cve');
      case 'accept-component': return planAccept(session, action, 'accept-component');
      case 'unaccept':
      case 'unaccept-component': return planUnaccept(session, action);
      case 'reload-report': return planReload(session);
      default: return undefined;
    }
  },

  apply: async (session, plan, deps, progress) => {
    const payload = plan.payload as AcceptedPayload;
    if (payload.op === 'reload') return applyReload(session, plan, deps);
    return applyListChange(session, plan, payload, deps, progress);
  },
};
