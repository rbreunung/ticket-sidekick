// Report import: the accepted list (Waltz) — accepting the named rows' CVEs or whole components, narrowing the review
// against the updated list, moving tickets only accepted components kept open onto Stale, listing and removing entries.
// vscode-free; logging goes through the injected `onDiag`.
import type { AcceptedEntry, ParsedAcceptedFile } from '../utils/waltzAccepted';
import type { DiagLogger } from '../utils/diagTypes';
import { templateLabelsOf } from '../utils/reportImport';
import type { TicketService } from '../services/TicketService';
import { buildStaleTicketGroups, type StaleGroupBuildResult } from './cleanup';
import type { ReportImportDescriptor } from './descriptor';
import { buildReviewPage, restoreMergedRows } from './rows';
import { toAcceptedHidden, type AcceptedHidden, type ReviewRowBase, type ReviewSession, type ReviewSessionStale, type StaleCandidate } from './types';

/** What narrowing the review against an updated list changed. */
interface AppliedList<TRow extends ReviewRowBase> {
  allRows: TRow[];
  rows: TRow[];
  page: number;
  acceptedHidden?: AcceptedHidden;
}

/**
 * Narrows every New row against the updated list and drops the Already-ticketed rows it accepts as a whole.
 * `allRows` is what counts the hidden findings; a merged row on the page that was not named is narrowed too
 * (it is page-local, so `allRows` cannot do it) and keeps its id and merge, or falls back to its remaining
 * originals when a member vanished.
 */
function applyAcceptedList<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  entries: AcceptedEntry[],
  namedIds: string[],
  descriptor: ReportImportDescriptor<TItem, TRow>,
): AppliedList<TRow> {
  const accepted = descriptor.accepted!;
  const templateLabels = templateLabelsOf(session.additionalFields);
  const hidden = {
    cves: session.acceptedHidden?.cves ?? 0,
    belowFloor: session.acceptedHidden?.belowFloor ?? 0,
    components: session.acceptedHidden?.components ?? 0,
  };
  // The row narrowed against the updated list: [] when nothing of it is left, the row itself when untouched.
  const narrowRow = (row: TRow, count: boolean): TRow[] => {
    const item = accepted.itemOf(row);
    const narrowed = accepted.narrow(item, entries);
    if (count) {
      hidden.cves += narrowed.hiddenCves;
      hidden.belowFloor += narrowed.belowFloor;
      hidden.components += narrowed.hiddenComponents;
    }
    if (narrowed.item === null) return [];
    if (narrowed.item === item) return [row];
    return [{ ...row, ...descriptor.buildRowFields(narrowed.item, templateLabels) }];
  };
  const allRows = session.allRows.flatMap(r => {
    if (r.existingTicketKey === null) return narrowRow(r, true);
    if (!accepted.isAccepted(accepted.itemOf(r), entries)) return [r];
    hidden.components++;
    return [];
  });
  const keptMerged = session.rows
    .filter(r => r.existingTicketKey === null && r.memberIds !== undefined && !namedIds.includes(r.id))
    .flatMap(r => narrowRow(r, false));
  const page = buildReviewPage(allRows, session.page);
  const acceptedHidden = toAcceptedHidden(hidden);
  return {
    allRows,
    rows: restoreMergedRows(page.rows, keptMerged),
    page: page.page,
    ...(acceptedHidden ? { acceptedHidden } : {}),
  };
}

/** What `accept` did: no workspace (nothing read or written), a failed write (the session as it was), or the entries it added. */
export type AcceptRowsResult<TRow extends ReviewRowBase> =
  | { kind: 'no-workspace' }
  | { kind: 'write-failed'; message: string }
  | { kind: 'done'; session: ReviewSession<TRow>; added: number; rowCount: number };

/**
 * Accepted-CVE list (R5, KTD7): writes the CVEs of the named New rows to the list file, then narrows
 * every New row again against the updated list. A failed write leaves the session exactly as it was.
 */
export function acceptRowCves<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  descriptor: ReportImportDescriptor<TItem, TRow>,
  onDiag?: DiagLogger,
): AcceptRowsResult<TRow> {
  const accepted = descriptor.accepted!;
  const service = accepted.service();
  if (!service) return { kind: 'no-workspace' };
  const named = session.rows.filter(r => r.existingTicketKey === null && action.ids.includes(r.id));
  const written = service.add(named.flatMap(r => accepted.entriesOf(accepted.itemOf(r), action.reason)));
  if (!written.ok) {
    onDiag?.('warn', `${descriptor.importLabel} import — accepting rows failed`, { error: written.message });
    return { kind: 'write-failed', message: written.message };
  }
  onDiag?.('info', `${descriptor.importLabel} import — accepted entries added`, { rows: named.length, added: written.added });

  const applied = applyAcceptedList(session, written.entries, action.ids, descriptor);
  return { kind: 'done', session: { ...session, ...applied }, added: written.added, rowCount: named.length };
}

/**
 * What `accept component` did: no workspace, nothing with a version to accept, a failed write, or the entries it added and
 * the open tickets it moved under Stale (or could not). `versionless` names the rows that have no version.
 */
export type AcceptComponentsResult<TRow extends ReviewRowBase> =
  | { kind: 'no-workspace' }
  | { kind: 'nothing'; versionless: string[] }
  | { kind: 'write-failed'; message: string }
  | { kind: 'done'; session: ReviewSession<TRow>; added: number; rowCount: number; moved: number; moveFailed: number; versionless: string[] };

/**
 * Accepted components (KTD3, KTD5): writes one component + version entry per component of the named rows
 * (New rows or Already-ticketed rows), narrows the review against the updated list, and moves the open
 * tickets that only accepted components kept alive from the stored candidates onto the Stale list. A failed
 * write leaves the session exactly as it was.
 */
export async function acceptRowComponents<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  workspaceRoot: string,
  onDiag?: DiagLogger,
): Promise<AcceptComponentsResult<TRow>> {
  const accepted = descriptor.accepted!;
  const service = accepted.service();
  if (!service) return { kind: 'no-workspace' };
  // A row whose report name carries no version has nothing to match an entry on: name it rather than report it as already accepted.
  const all = session.rows.filter(r => action.ids.includes(r.id));
  const versionless = all.filter(r => accepted.componentEntriesOf(accepted.itemOf(r)).length === 0);
  const named = all.filter(r => !versionless.includes(r));
  const versionlessIds = versionless.map(r => r.id);
  if (named.length === 0) return { kind: 'nothing', versionless: versionlessIds };
  const written = service.add(named.flatMap(r => accepted.componentEntriesOf(accepted.itemOf(r), action.reason)));
  if (!written.ok) {
    onDiag?.('warn', `${descriptor.importLabel} import — accepting components failed`, { error: written.message });
    return { kind: 'write-failed', message: written.message };
  }
  onDiag?.('info', `${descriptor.importLabel} import — accepted components added`, { rows: named.length, added: written.added });

  const applied = applyAcceptedList(session, written.entries, action.ids, descriptor);
  const narrowed: ReviewSession<TRow> = { ...session, ...applied };
  const keys = new Set(named.flatMap(r => descriptor.dedupKeyOf?.(accepted.itemOf(r)) ?? []));
  const moved = await moveCandidatesToStale(narrowed, keys, ticketService, descriptor, workspaceRoot, onDiag);
  return {
    kind: 'done', session: moved.session, added: written.added, rowCount: named.length, moved: moved.count, moveFailed: moved.failed, versionless: versionlessIds,
  };
}

/**
 * Moves the stored candidates whose every remaining active id is now accepted onto the Stale list, grouped
 * and made eligible exactly as the build does it. Tickets already listed keep their selection and closed
 * state. A failure to build the groups is logged and leaves the candidates as they were.
 */
async function moveCandidatesToStale<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  acceptedKeys: Set<string>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  workspaceRoot: string,
  onDiag?: DiagLogger,
): Promise<{ session: ReviewSession<TRow>; count: number; failed: number }> {
  const candidates = session.staleCandidates ?? [];
  if (candidates.length === 0 || acceptedKeys.size === 0) return { session, count: 0, failed: 0 };
  const stillOpen: StaleCandidate[] = [];
  const newlyStale: StaleCandidate[] = [];
  for (const c of candidates) {
    const remaining = c.activeIds.filter(id => !acceptedKeys.has(id));
    if (remaining.length === c.activeIds.length) stillOpen.push(c);
    else if (remaining.length === 0) newlyStale.push(c);
    else stillOpen.push({ ...c, activeIds: remaining });
  }
  if (newlyStale.length === 0) return { session: { ...session, staleCandidates: stillOpen }, count: 0, failed: 0 };

  let built: StaleGroupBuildResult;
  try {
    const details = new Map(newlyStale.map(c => [c.key, { summary: c.summary, currentStatus: c.currentStatus, issueType: c.issueType }]));
    built = await buildStaleTicketGroups(newlyStale.map(c => ({ key: c.key, ids: c.activeIds })), details, session.projectKey, ticketService, workspaceRoot, onDiag);
  } catch (err) {
    onDiag?.('warn', `${descriptor.importLabel} import — could not offer accepted components' tickets under Stale`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { session, count: 0, failed: newlyStale.length };
  }

  const existing: ReviewSessionStale = session.staleTickets ?? { groups: [], ineligible: [], resolutionOptions: [] };
  const groups = existing.groups.map(g => ({ ...g, tickets: [...g.tickets] }));
  for (const group of built.groups) {
    const target = groups.find(g => g.issueType === group.issueType);
    if (target) target.tickets.push(...group.tickets.filter(t => !target.tickets.some(x => x.key === t.key)));
    else groups.push(group);
  }
  const ineligible = [...existing.ineligible, ...built.ineligible.filter(i => !existing.ineligible.some(x => x.key === i.key))];
  const staleTickets: ReviewSessionStale = {
    ...existing,
    groups,
    ineligible,
    resolutionOptions: existing.resolutionOptions.length > 0 ? existing.resolutionOptions : built.resolutionOptions,
  };
  // The Stale group may be new to this review: the overview lists it from now on.
  const viewGroups = session.groups ?? [];
  const nextGroups = viewGroups.includes('stale') ? viewGroups : [...viewGroups, 'stale' as const];
  return {
    session: { ...session, staleTickets, staleCandidates: stillOpen, groups: nextGroups, singleGroup: nextGroups.length <= 1 },
    count: newlyStale.length,
    failed: 0,
  };
}

/** The accepted list as read now, with the warning when the file could not be read in full; null when no workspace folder is open. */
export function loadAcceptedList<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
): ParsedAcceptedFile | null {
  const service = descriptor.accepted!.service();
  return service ? service.load() : null;
}

/** Which entry `unaccept` removes: by its position in the list, a component + CVE pair, or a whole component at a version. */
export type UnacceptTarget =
  | { kind: 'unaccept'; position: number }
  | { kind: 'unacceptEntry'; component: string; cve: string }
  | { kind: 'unacceptComponent'; component: string; version: string };

/** What `unaccept` did: no workspace, a refused removal (the file's own reason), or the entry it removed. */
export type UnacceptResult =
  | { kind: 'no-workspace' }
  | { kind: 'failed'; message: string }
  | { kind: 'removed'; removed: AcceptedEntry };

/** Removes one entry from the list file. Rows already hidden stay hidden in the review that is open. */
export function removeAcceptedEntry<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
  action: UnacceptTarget,
  onDiag?: DiagLogger,
): UnacceptResult {
  const service = descriptor.accepted!.service();
  if (!service) return { kind: 'no-workspace' };
  const removal = action.kind === 'unaccept' ? service.remove(action.position)
    : action.kind === 'unacceptComponent' ? service.removeComponent(action.component, action.version)
    : service.removePair(action.component, action.cve);
  if (!removal.ok) return { kind: 'failed', message: removal.message };
  onDiag?.('info', `${descriptor.importLabel} import — accepted entry removed`, action.kind === 'unaccept' ? { position: action.position } : { entry: true });
  return { kind: 'removed', removed: removal.removed };
}
