// Report import: the accepted-CVE list replies (accepted-CVE list plan, U5) — `accept` writes the named
// rows' CVEs to the list file and narrows the New rows again; `accepted` lists the entries and `unaccept`
// removes one. The list changes live in src/imports/accept.ts, which the import board shares; this file words them.
import * as vscode from 'vscode';
import { isComponentEntry, type AcceptedEntry } from '../../utils/waltzAccepted';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { buildAcceptedList, neutralizeMarkdownLinks, type ReviewRowBase, type ReviewSession } from '../sessionState';
import type { TicketService } from '../../services/TicketService';
import { acceptRowComponents, acceptRowCves, loadAcceptedList, removeAcceptedEntry, type UnacceptTarget } from '../../imports/accept';
import { diagOf } from './importCreate';
import type { ReportImportDescriptor } from './reportImportTypes';

const NO_WORKSPACE_ACCEPTED_MESSAGE = '_No workspace folder is open, so the accepted list cannot be read or changed._\n\n';

/** `accept`: writes the named New rows' CVEs to the list and streams what it did. */
export async function acceptRows<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const result = acceptRowCves(session, action, descriptor, diagOf(descriptor));
  if (result.kind === 'no-workspace') {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return session;
  }
  if (result.kind === 'write-failed') {
    stream.markdown(`✗ ${neutralizeMarkdownLinks(result.message)}\n\n`);
    return session;
  }
  stream.markdown(result.added > 0
    ? `✓ Accepted ${result.added} CVE(s) from ${result.rowCount} row(s) — hidden from this and future imports.\n\n`
    : '_Those CVEs were already on the accepted list._\n\n');
  return result.session;
}

/** `accept component`: writes the named rows' components to the list and streams what it did and what moved under Stale. */
export async function acceptComponents<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  action: { ids: string[]; reason?: string },
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const result = await acceptRowComponents(session, action, ticketService, descriptor, workspaceRoot, diagOf(descriptor));
  if (result.kind === 'no-workspace') {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return session;
  }
  if (result.kind === 'write-failed') {
    stream.markdown(`✗ ${neutralizeMarkdownLinks(result.message)}\n\n`);
    return session;
  }
  const versionless = result.versionless;
  const versionlessNote = versionless.length > 0
    ? `${versionless.map(id => `Row ${id}`).join(', ')} ${versionless.length === 1 ? 'has' : 'have'} no version, so ${versionless.length === 1 ? 'it' : 'they'} can't be accepted as a whole component; use \`accept\` for the CVEs.\n\n`
    : '';
  if (result.kind === 'nothing') {
    stream.markdown(versionlessNote);
    return session;
  }
  stream.markdown(result.added > 0
    ? `✓ Accepted ${result.added} component${result.added === 1 ? '' : 's'} from ${result.rowCount} row(s) — hidden from this and future imports.` +
      `${result.moved > 0 ? ` ${result.moved} open ticket(s) are now offered under Stale.` : ''}` +
      `${result.moveFailed > 0 ? ` ✗ Could not offer ${result.moveFailed} open ticket(s) under Stale; they are offered on the next import.` : ''}\n\n`
    : '_Those components were already accepted._\n\n');
  stream.markdown(versionlessNote);
  return result.session;
}

/** `accepted`: lists the entries, each with a Remove link; a list file that could not be read in full is warned about first. */
export function showAcceptedList<TItem, TRow extends ReviewRowBase>(
  descriptor: ReportImportDescriptor<TItem, TRow>,
  stream: vscode.ChatResponseStream,
): void {
  const loaded = loadAcceptedList(descriptor);
  if (!loaded) {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return;
  }
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
  action: UnacceptTarget,
  stream: vscode.ChatResponseStream,
  // Waltz ticket merge (KTD10): the review will rebuild itself from its report next, so it does not say the item waits for the next import.
  willRefresh = false,
): boolean {
  const result = removeAcceptedEntry(descriptor, action, diagOf(descriptor));
  if (result.kind === 'no-workspace') {
    stream.markdown(NO_WORKSPACE_ACCEPTED_MESSAGE);
    return false;
  }
  if (result.kind === 'failed') {
    stream.markdown(`✗ ${neutralizeMarkdownLinks(result.message)}\n\n`);
    return false;
  }
  stream.markdown(willRefresh
    ? `✓ Removed ${describeRemoved(result.removed)} from the accepted list.\n\n`
    : `✓ Removed ${describeRemoved(result.removed)} from the accepted list. It is offered again on the next import; rows already hidden stay hidden in this review.\n\n`);
  return true;
}
