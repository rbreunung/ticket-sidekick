// Report import: the shared review-screen streaming (persists the session, renders the current screen)
// and the small helpers every group action uses. A leaf module of the import flow.
import * as vscode from 'vscode';
import { buildImportScreen, ensureImportViewState, type ImportScreenOptions, type JiraSessionKind, type ReviewRowBase, type ReviewSession } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import type { ReportImportDescriptor } from './reportImportTypes';

// U4: maps each importer's `descriptorKind` to its two JiraSessionKind literals — replaces the
// per-descriptor `templateTag`/`reviewTag` strings the ChatResult.metadata mechanism no longer
// needs (R1/R3). A plain object literal rather than a `${descriptorKind}-template` template-string
// cast keeps every kind spelled out as a literal JiraSessionKind, so a typo here is a compile error.
export const IMPORT_SESSION_KINDS: Record<ReportImportDescriptor<unknown, ReviewRowBase>['descriptorKind'], { template: JiraSessionKind; review: JiraSessionKind }> = {
  veracode: { template: 'veracode-template', review: 'veracode-review' },
  waltz: { template: 'waltz-template', review: 'waltz-review' },
  email: { template: 'email-template', review: 'email-review' },
};

function screenOptions<TItem, TRow extends ReviewRowBase>(descriptor: ReportImportDescriptor<TItem, TRow>, baseUrl?: string): ImportScreenOptions {
  return { baseUrl, itemNoun: descriptor.itemNoun, findingNoun: descriptor.changeTracking?.findingNoun, canFold: descriptor.fold !== undefined, canAccept: descriptor.accepted !== undefined };
}

/** R10: after a group action, back to the overview — or the same group when there is no overview. */
export function afterGroupAction<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
  return session.singleGroup ? session : { ...session, view: 'overview' };
}

export async function streamImportReview<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  const current = ensureImportViewState(session);
  await ws.update(descriptor.sessionKeys.review, current);
  // Every screen carries command links (row toggles, group links, actions), so the whole response
  // is trust-gated (KTD5) — every row's own field content is neutralized against markdown-link
  // injection at its source (VERACODE_REVIEW_COLUMNS, WALTZ_REVIEW_COLUMNS, EMAIL_REVIEW_COLUMNS,
  // and the stale screen's own summary cells).
  stream.markdown(trustedChatMarkdown(buildImportScreen(current, descriptor.reviewColumns, screenOptions(descriptor, baseUrl))));
  return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
}
