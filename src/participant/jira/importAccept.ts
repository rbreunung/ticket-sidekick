// Report import: the accepted-CVE list replies (accepted-CVE list plan, U5) — `accept` writes the named
// rows' CVEs to the list file and narrows the New rows again; `accepted` lists the entries and `unaccept`
// removes one.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { isComponentEntry, type AcceptedEntry } from '../../utils/waltzAccepted';
import { templateLabelsOf } from '../../utils/reportImport';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { buildAcceptedList, buildReviewPage, neutralizeMarkdownLinks, restoreMergedRows, toAcceptedHidden, type AcceptedHidden, type ReviewRowBase, type ReviewSession, type ReviewSessionStale, type StaleCandidate } from '../sessionState';
import type { TicketService } from '../../services/TicketService';
import { buildStaleTicketGroups, type StaleGroupBuildResult } from './cleanupHandler';
import type { ReportImportDescriptor } from './reportImportTypes';

const NO_WORKSPACE_ACCEPTED_MESSAGE = '_No workspace folder is open, so the accepted list cannot be read or changed._\n\n';

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

/**
 * Accepted-CVE list (R5, KTD7): writes the CVEs of the named New rows to the list file, then narrows
 * every New row again against the updated list. A failed write leaves the session exactly as it was.
 */
export async function acceptRows<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const accepted = descriptor.accepted!;
  const service = accepted.service();
  if (!service) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return session;
  }
  const named = session.rows.filter(r => r.existingTicketKey === null && action.ids.includes(r.id));
  const written = service.add(named.flatMap(r => accepted.entriesOf(accepted.itemOf(r), action.reason)));
  if (!written.ok) {
    logDiag(descriptor.scope, 'warn', `${descriptor.importLabel} import — accepting rows failed`, { error: written.message });
    stream.markdown(`✗ ${neutralizeMarkdownLinks(written.message)}\n\n`);
    return session;
  }
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import — accepted entries added`, { rows: named.length, added: written.added });

  const applied = applyAcceptedList(session, written.entries, action.ids, descriptor);
  stream.markdown(written.added > 0
    ? `✓ Accepted ${written.added} CVE(s) from ${named.length} row(s) — hidden from this and future imports.\n\n`
    : '_Those CVEs were already on the accepted list._\n\n');
  return { ...session, ...applied };
}

/**
 * Accepted components (KTD3, KTD5): writes one component + version entry per component of the named rows
 * (New rows or Already-ticketed rows), narrows the review against the updated list, and moves the open
 * tickets that only accepted components kept alive from the stored candidates onto the Stale list. A failed
 * write leaves the session exactly as it was.
 */
export async function acceptComponents<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const accepted = descriptor.accepted!;
  const service = accepted.service();
  if (!service) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return session;
  }
  const named = session.rows.filter(r => action.ids.includes(r.id));
  const written = service.add(named.flatMap(r => accepted.componentEntriesOf(accepted.itemOf(r), action.reason)));
  if (!written.ok) {
    logDiag(descriptor.scope, 'warn', `${descriptor.importLabel} import — accepting components failed`, { error: written.message });
    stream.markdown(`✗ ${neutralizeMarkdownLinks(written.message)}\n\n`);
    return session;
  }
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import — accepted components added`, { rows: named.length, added: written.added });

  const applied = applyAcceptedList(session, written.entries, action.ids, descriptor);
  const narrowed: ReviewSession<TRow> = { ...session, ...applied };
  const keys = new Set(named.flatMap(r => descriptor.dedupKeyOf?.(accepted.itemOf(r)) ?? []));
  const moved = await moveCandidatesToStale(narrowed, keys, ticketService, descriptor);
  stream.markdown(written.added > 0
    ? `✓ Accepted ${written.added} component${written.added === 1 ? '' : 's'} from ${named.length} row(s) — hidden from this and future imports.` +
      `${moved.count > 0 ? ` ${moved.count} open ticket(s) are now offered under Stale.` : ''}` +
      `${moved.failed > 0 ? ` ✗ Could not offer ${moved.failed} open ticket(s) under Stale; they are offered on the next import.` : ''}\n\n`
    : '_Those components were already accepted._\n\n');
  return moved.session;
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    built = await buildStaleTicketGroups(newlyStale.map(c => ({ key: c.key, ids: c.activeIds })), details, session.projectKey, ticketService, workspaceRoot, descriptor.scope);
  } catch (err) {
    logDiag(descriptor.scope, 'warn', `${descriptor.importLabel} import — could not offer accepted components' tickets under Stale`, {
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

/** `accepted`: lists the entries, each with a Remove link; a list file that could not be read in full is warned about first. */
export function showAcceptedList<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
  stream: vscode.ChatResponseStream,
): void {
  const service = descriptor.accepted!.service();
  if (!service) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return;
  }
  const loaded = service.load();
  if (loaded.warning) stream.markdown(`_Warning: ${neutralizeMarkdownLinks(loaded.warning)}_\n\n`);
  stream.markdown(trustedChatMarkdown(`${buildAcceptedList(loaded.entries)}\n\n`));
}

function describeRemoved(removed: AcceptedEntry): string {
  return isComponentEntry(removed)
    ? `${neutralizeMarkdownLinks(removed.component)}:${neutralizeMarkdownLinks(removed.version)}`
    : `${neutralizeMarkdownLinks(removed.component)} · ${neutralizeMarkdownLinks(removed.cve)}`;
}

/**
 * `unaccept <n>` / `unaccept <component> <CVE>` / `unaccept-component <component> <version>` (what the Remove
 * links send): removes one entry from the list file. Rows already hidden stay hidden in the review that is
 * open; the entry's findings come back on the next import. Every piece of file text shown here is neutralized.
 */
export function unacceptEntry<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
  action: { kind: 'unaccept'; position: number } | { kind: 'unacceptEntry'; component: string; cve: string } | { kind: 'unacceptComponent'; component: string; version: string },
  stream: vscode.ChatResponseStream,
): void {
  const service = descriptor.accepted!.service();
  if (!service) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return;
  }
  const removal = action.kind === 'unaccept' ? service.remove(action.position)
    : action.kind === 'unacceptComponent' ? service.removeComponent(action.component, action.version)
    : service.removePair(action.component, action.cve);
  if (!removal.ok) {
    stream.markdown(`✗ ${neutralizeMarkdownLinks(removal.message)}\n\n`);
    return;
  }
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import — accepted entry removed`, action.kind === 'unaccept' ? { position: action.position } : { entry: true });
  stream.markdown(`✓ Removed ${describeRemoved(removal.removed)} from the accepted list. It is offered again on the next import; rows already hidden stay hidden in this review.\n\n`);
}
