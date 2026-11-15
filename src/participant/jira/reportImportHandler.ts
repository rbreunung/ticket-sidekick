// The chat side of the `@jira` email import's session flow (template/issue-type selection -> review
// screen -> batch ticket creation), with its message wording. Every function takes a
// `ReportImportDescriptor<TItem, TRow>` supplying the importer-specific bits; the email import
// (emailHandler.ts) is the one chat importer left, since Veracode and Waltz reports are imported on
// the import board. This file holds the session build, the review build's progress lines and the
// reply dispatch; ticket creation is worded in importCreate.ts over the shared screen streaming in
// importReviewScreen.ts. What they decide and write lives in the vscode-free engine under
// src/imports/, which the import board shares.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import {
  buildImportReview as buildImportReviewCore, buildImportTemplateSession as buildImportTemplateSessionCore,
  resolveTemplateFields, type ImportReviewInput, type ReviewBuildContext, type ReviewBuildEvent,
} from '../../imports/review';
import {
  applyBulkNewRowSet, ticketedTargetKey, applyReviewSessionToggle, buildAllHiddenMessage, buildChatCommandLink, buildImportDoneSummary, buildReviewPage, clampStalePage, clampTicketedPage, pageBoundaryAnswer, staleTotalPages, ticketedTotalPages, buildImportHelp, buildRefusedReply, computeImportResultGroups, ensureImportViewState, importCommandCaps, formatIssueTypeOptionLabel, initImportViewState, isCancellation, isNewGroupDrained, isTicketedRowFinished, neutralizeMarkdownLinks, parseImportReviewReply, pickEmailOption, ticketedRowActions, type ImportReplyContext, type ImportTemplateSelectionSession, type ReviewRowBase, type ReviewSession, type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession,
} from '../sessionState';
import { resolveIssueTypeOrPrompt, sessionWasSuperseded } from './ticketContext';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { createNewRows, diagOf } from './importCreate';
import { IMPORT_SESSION_KINDS, afterGroupAction, screenOptions, streamImportReview } from './importReviewScreen';
import type { ReportImportDescriptor } from './reportImportTypes';

/** The first workspace folder, where the templates, the workflow cache and the accepted list live; empty when none is open. */
function workspaceRootOf(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

// Public surface of the import flow: the descriptor types and the group-action entry points other
// modules and the importers' thin wrappers use, kept importable from this file.
export type { ReportImportRow, ReportImportDescriptor, ImportAccepted, ImportFold, ImportChangeTracking } from './reportImportTypes';
export { streamImportReview } from './importReviewScreen';
export { createNewRows } from './importCreate';

export async function buildImportTemplateSession<TItem, TRow extends ReviewRowBase>(
  items: TItem[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  rawItems: unknown[] = [],
  reportFilePath?: string,
): Promise<ImportTemplateSelectionSession<TItem>> {
  return buildImportTemplateSessionCore(items, fileName, projectKey, jiraClient, descriptor, rawItems, reportFilePath, workspaceRootOf(), diagOf(descriptor));
}

export async function streamImportTemplateSelection<TItem, TRow extends ReviewRowBase>(
  session: ImportTemplateSelectionSession<TItem>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<vscode.ChatResult> {
  await ws.update(descriptor.sessionKeys.templateSelection, session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) =>
      `${i + 1}. ${buildChatCommandLink(`${t.name} _(${formatIssueTypeOptionLabel(t.issueType)})_`, '@jira', String(i + 1))}`,
    ).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) =>
    `${offset + i + 1}. ${buildChatCommandLink(formatIssueTypeOptionLabel(t), '@jira', String(offset + i + 1))}`,
  ).join('\n')}\n\n`;

  stream.markdown(trustedChatMarkdown(
    `Found **${session.items.length}** ${descriptor.itemNoun} in \`${session.reportFileName}\` matching your ${descriptor.filterKindLabel} filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].template] } } };
}

export async function handleImportTemplateSelection<TItem, TRow extends ReviewRowBase>(
  reply: string,
  session: ImportTemplateSelectionSession<TItem>,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  if (isCancellation(reply)) {
    await ws.update(descriptor.sessionKeys.templateSelection, undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    return streamImportTemplateSelection(session, stream, ws, descriptor);
  }
  await ws.update(descriptor.sessionKeys.templateSelection, undefined);

  // The whole batch shares this one resolved type, so this single detour — before dedup search or
  // review-table work starts — covers every row in the import (mirrors JiraParticipant.ts's
  // create-ticket detour). R6/KTD4: NO_ISSUE_TYPE now always detours to the shared chat-based ask
  // instead of a showInputBox; `pick.kind === 'template' ? pick.name : null` is the picked
  // identity the resume path re-looks up once the type is known.
  const pickedTemplateName = pick.kind === 'template' ? pick.name : null;
  // Generic TItem is erased to the concrete Veracode/Waltz union AwaitIssueTypeResume carries —
  // safe because descriptorKind and session always come from the same importer's own descriptor.
  const resumeSession = session as unknown as VeracodeTemplateSelectionSession | WaltzTemplateSelectionSession;
  const issueTypeOrResult = await resolveIssueTypeOrPrompt(pick.issueType, {
    kind: 'reportImport', descriptorKind: descriptor.descriptorKind, pickedTemplateName, session: resumeSession,
  }, stream, ws);
  if (typeof issueTypeOrResult !== 'string') return issueTypeOrResult;
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }

  return continueAfterImportIssueType(issueTypeOrResult, pickedTemplateName, session, jiraClient, ticketService, stream, ws, descriptor, baseUrl);
}

/**
 * Continuation of handleImportTemplateSelection() once the issue type is known — either resolved
 * directly (a template/entry with a real type) or via R6's chat-based ask
 * (JiraParticipant.ts's shared router calling back in through emailHandler.ts's
 * handleEmailAwaitIssueType). `pickedTemplateName` is the picked template's *name* (identity),
 * re-looked-up here — not a pre-resolved template object — matching KTD4.
 */
export async function continueAfterImportIssueType<TItem, TRow extends ReviewRowBase>(
  issueType: string,
  pickedTemplateName: string | null,
  session: ImportTemplateSelectionSession<TItem>,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  let additionalFields: Record<string, unknown> = {};
  let templateName: string | null = null;
  if (pickedTemplateName) {
    templateName = pickedTemplateName;
    const resolved = await resolveTemplateFields(pickedTemplateName, session.projectKey, jiraClient, descriptor, workspaceRootOf(), diagOf(descriptor));
    additionalFields = resolved.additionalFields;
    if (resolved.problem?.kind === 'missing') {
      stream.markdown(
        `_Warning: template "${pickedTemplateName}" is no longer available — proceeding without its default fields._\n\n`,
      );
    } else if (resolved.problem?.kind === 'unresolved') {
      stream.markdown(
        `_Warning: could not resolve template fields — proceeding without them: ${resolved.problem.error}_\n\n`,
      );
    }
  }

  const { session: reviewSession } = await buildImportReview<TItem, TRow>({
    projectKey: session.projectKey, items: session.items, rawItems: session.rawItems ?? [], reportFilePath: session.reportFilePath,
    issueType, templateName, additionalFields,
  }, jiraClient, ticketService, stream, descriptor);

  // Every finding was kept off the screen by the accepted list and nothing else (ticketed, stale) is
  // left to review: say so, rather than the filter-mismatch wording. Runs after the stale check
  // because Stale counts as a group (KTD1).
  if (reviewSession.acceptedHidden && computeImportResultGroups(reviewSession.allRows, reviewSession.staleTickets).length === 0) {
    stream.markdown(buildAllHiddenMessage(reviewSession.acceptedHidden));
    return {};
  }

  return streamImportReview(initImportViewState(reviewSession), stream, ws, descriptor, baseUrl);
}

/** Streams the review build's progress lines and warnings. */
function streamReviewBuildEvent(stream: vscode.ChatResponseStream): (event: ReviewBuildEvent) => void {
  return event => {
    switch (event.kind) {
      case 'checking-ticketed':
        stream.markdown(`_Checking for already-ticketed ${event.plural}…_\n\n`);
        return;
      case 'dedup-failed':
        stream.markdown(event.error === undefined
          ? `_Warning: could not check for already-ticketed ${event.plural} — proceeding without dedup._\n\n`
          : `_Warning: could not check for already-ticketed ${event.plural} — proceeding without dedup: ${event.error}_\n\n`);
        return;
      case 'descriptions-unread':
        stream.markdown(`_Warning: could not read ${event.failed} ticket(s) to compare their dates — those rows are not checked for date changes._\n\n`);
        return;
      case 'accepted-warning':
        stream.markdown(`_Warning: ${neutralizeMarkdownLinks(event.warning)}_\n\n`);
        return;
      case 'checking-stale':
        stream.markdown('_Checking for stale tickets…_\n\n');
        return;
      case 'stale-truncated':
        stream.markdown(
          `_Checked the first ${event.checked} of ${event.totalFound} ticket(s) carrying the stale-check label` +
          ` — ${event.stale} looked stale, but coverage may be incomplete._\n\n`,
        );
        return;
      case 'stale-failed':
        stream.markdown('_Warning: could not check for stale tickets — proceeding without a stale-ticket section._\n\n');
        return;
    }
  };
}

function reviewBuildContext<TItem, TRow extends ReviewRowBase>(stream: vscode.ChatResponseStream, descriptor: ReportImportDescriptor<TItem, TRow>): ReviewBuildContext {
  return { workspaceRoot: workspaceRootOf(), onDiag: diagOf(descriptor), onEvent: streamReviewBuildEvent(stream) };
}

/** The review build (src/imports/review.ts) with its progress streamed to chat. */
function buildImportReview<TItem, TRow extends ReviewRowBase>(
  input: ImportReviewInput<TItem>,
  resolutions: Pick<IJiraClient, 'getResolutions'>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<{ session: ReviewSession<TRow>; degraded: boolean }> {
  return buildImportReviewCore(input, resolutions, ticketService, descriptor, reviewBuildContext(stream, descriptor));
}

/** Ends an import: clears the stored review, logs it and streams the summary. Used by `done` and by the auto-finish after `create`. */
async function finishImport<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ws: vscode.Memento,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<void> {
  await ws.update(descriptor.sessionKeys.review, undefined);
  const outcomes = session.outcomes!;
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import finished`, { ...outcomes });
  stream.markdown(buildImportDoneSummary(outcomes, descriptor.changeTracking?.actionLabels));
}

/**
 * Overview-hub dispatch: a reply is parsed against the vocabulary of the screen currently shown — and
 * only that screen — then applied. Toggles and page moves re-render the same screen; "open …" / "back"
 * switch screens; "create tickets" runs on its own and returns to the overview; "done" (or cancelling
 * on the overview) ends the import with a summary.
 */
export async function handleImportReviewReply<TItem, TRow extends ReviewRowBase>(
  reply: string,
  incoming: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  // A newer import claimed the template-selection key since this review was built (e.g. a
  // command-palette import that writes its session with no chat turn) — never act on this one.
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    await ws.update(descriptor.sessionKeys.review, undefined);
    stream.markdown('_A newer import was started — this review was closed without creating, updating or closing anything further._');
    return;
  }

  // Callers (and tests) hold on to the session object they passed in, so state changes are applied
  // to it in place as well as persisted.
  const session = incoming;
  Object.assign(session, ensureImportViewState(session));
  const view = session.view!;
  const ctx: ImportReplyContext = {
    singleGroup: session.singleGroup!,
    groups: session.groups!,
    newRowIds: session.rows.filter(r => r.existingTicketKey === null).map(r => r.id),
    ticketedRows: session.allRows
      .filter(r => r.existingTicketKey !== null && !isTicketedRowFinished(r))
      .map(r => ({ id: r.id, allowedActions: ticketedRowActions(r).allowedActions })),
    stale: session.staleTickets,
    canFold: descriptor.fold !== undefined,
    canAccept: descriptor.accepted !== undefined,
    canMergeTickets: descriptor.ticketMerge !== undefined,
    canExport: descriptor.overviewExport !== undefined,
    canSearch: descriptor.dedupKeyOf !== undefined,
    ticketTargetKeys: Object.fromEntries(session.allRows.filter(r => r.existingTicketKey !== null).map(r => [r.id.toLowerCase(), ticketedTargetKey(r)])),
    actionLabels: descriptor.changeTracking?.actionLabels,
    mergedRowIds: session.rows.filter(r => r.existingTicketKey === null && r.memberIds !== undefined).map(r => r.id),
  };
  const rerender = () => streamImportReview(session, stream, ws, descriptor, baseUrl);
  const action = parseImportReviewReply(view, reply, ctx);

  switch (action.kind) {
    case 'invalid':
      stream.markdown(trustedChatMarkdown(buildRefusedReply({ view, caps: importCommandCaps(ctx), typed: reply, reason: action.reason })));
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    case 'help':
      logDiag(descriptor.scope, 'info', `${descriptor.importLabel} help`, { view });
      stream.markdown(trustedChatMarkdown(buildImportHelp(view, importCommandCaps(ctx))));
      await ws.update(descriptor.sessionKeys.review, session);
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    case 'open':
      session.view = action.view;
      return rerender();
    case 'back':
      session.view = 'overview';
      return rerender();
    case 'done':
      return finishImport(session, ws, stream, descriptor);
    case 'pageNav': {
      const bounds = view === 'stale'
        ? { page: clampStalePage(session.stalePage ?? 0, session.staleTickets), totalPages: staleTotalPages(session.staleTickets) }
        : view === 'ticketed'
          ? { page: clampTicketedPage(session.ticketedPage ?? 0, session.allRows), totalPages: ticketedTotalPages(session.allRows) }
          : buildReviewPage(session.allRows, session.page);
      const boundary = pageBoundaryAnswer(action.nav, bounds.page, bounds.totalPages);
      if (boundary) {
        stream.markdown(boundary);
        return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
      }
      const target = action.nav.kind === 'next' ? bounds.page + 1 : action.nav.kind === 'prev' ? bounds.page - 1 : action.nav.page;
      if (view === 'stale') {
        session.stalePage = clampStalePage(target, session.staleTickets);
        return rerender();
      }
      if (view === 'ticketed') {
        session.ticketedPage = clampTicketedPage(target, session.allRows);
        return rerender();
      }
      const next = buildReviewPage(session.allRows, target);
      session.rows = next.rows;
      session.page = next.page;
      return rerender();
    }
    case 'bulk':
      session.rows = applyBulkNewRowSet(session.rows, action.include);
      return rerender();
    case 'toggleRows': {
      // A new-row toggle stays page-local (applyReviewSessionToggle's own contract).
      const toggled = applyReviewSessionToggle(session.rows, session.allRows, action.ids);
      session.rows = toggled.rows;
      session.allRows = toggled.allRows;
      return rerender();
    }
    case 'create':
      Object.assign(session, afterGroupAction(await createNewRows(session, ticketService, stream, descriptor, baseUrl)));
      // Nothing left to act on (no New row, no other command to offer): end the import now instead of showing a Done-only screen.
      if (isNewGroupDrained(session, screenOptions(descriptor, baseUrl))) return finishImport(session, ws, stream, descriptor);
      return rerender();
    default:
      // The Veracode and Waltz replies (fold, accept, ticket merge, search, export, reload, the Already-ticketed and
      // Stale actions) are offered only by an importer with those capabilities, which no chat import has any more.
      return rerender();
  }
}
