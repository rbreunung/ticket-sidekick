// Report import: the accepted-CVE list replies (accepted-CVE list plan, U5) — `accept` writes the named
// rows' CVEs to the list file and narrows the New rows again; `accepted` lists the entries and `unaccept`
// removes one.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { templateLabelsOf } from '../../utils/reportImport';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { buildAcceptedList, buildReviewPage, neutralizeMarkdownLinks, restoreMergedRows, type ReviewRowBase, type ReviewSession } from '../sessionState';
import type { ReportImportDescriptor } from './reportImportTypes';

const NO_WORKSPACE_ACCEPTED_MESSAGE = '_No workspace folder is open, so the accepted list cannot be read or changed._\n\n';

/**
 * Accepted-CVE list (R5, KTD7): writes the CVEs of the named New rows to the list file, then narrows
 * every New row again against the updated list. `allRows` is what counts the hidden findings; a merged
 * row on the page that was not named is narrowed too (it is page-local, so `allRows` cannot do it) and
 * keeps its id and merge, or falls back to its remaining originals when a member vanished. A failed
 * write leaves the session exactly as it was.
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

  const templateLabels = templateLabelsOf(session.additionalFields);
  const hidden = { cves: session.acceptedHidden?.cves ?? 0, belowFloor: session.acceptedHidden?.belowFloor ?? 0 };
  // The row narrowed against the updated list: [] when nothing of it is left, the row itself when untouched.
  const narrowRow = (row: TRow, count: boolean): TRow[] => {
    const item = accepted.itemOf(row);
    const narrowed = accepted.narrow(item, written.entries);
    if (count) {
      hidden.cves += narrowed.hiddenCves;
      hidden.belowFloor += narrowed.belowFloor;
    }
    if (narrowed.item === null) return [];
    if (narrowed.item === item) return [row];
    return [{ ...row, ...descriptor.buildRowFields(narrowed.item, templateLabels) }];
  };
  const allRows = session.allRows.flatMap(r => (r.existingTicketKey !== null ? [r] : narrowRow(r, true)));
  const keptMerged = session.rows
    .filter(r => r.existingTicketKey === null && r.memberIds !== undefined && !action.ids.includes(r.id))
    .flatMap(r => narrowRow(r, false));
  const page = buildReviewPage(allRows, session.page);
  stream.markdown(written.added > 0
    ? `✓ Accepted ${written.added} CVE(s) from ${named.length} row(s) — hidden from this and future imports.\n\n`
    : '_Those CVEs were already on the accepted list._\n\n');
  return {
    ...session,
    allRows,
    rows: restoreMergedRows(page.rows, keptMerged),
    page: page.page,
    ...(hidden.cves > 0 || hidden.belowFloor > 0 ? { acceptedHidden: hidden } : {}),
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

/**
 * `unaccept <n>` / `unaccept <component> <CVE>` (what a Remove link sends): removes one entry from the
 * list file. Rows already hidden stay hidden in the review that is open; the entry's findings come back on
 * the next import. Every piece of file text shown here is neutralized.
 */
export function unacceptEntry<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
  action: { kind: 'unaccept'; position: number } | { kind: 'unacceptEntry'; component: string; cve: string },
  stream: vscode.ChatResponseStream,
): void {
  const service = descriptor.accepted!.service();
  if (!service) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return;
  }
  const removal = action.kind === 'unaccept' ? service.remove(action.position) : service.removePair(action.component, action.cve);
  if (!removal.ok) {
    stream.markdown(`✗ ${neutralizeMarkdownLinks(removal.message)}\n\n`);
    return;
  }
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import — accepted entry removed`, action.kind === 'unaccept' ? { position: action.position } : { entry: true });
  stream.markdown(`✓ Removed ${neutralizeMarkdownLinks(removal.removed.component)} · ${neutralizeMarkdownLinks(removal.removed.cve)} from the accepted list. It is offered again on the next import; rows already hidden stay hidden in this review.\n\n`);
}
