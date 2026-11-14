// Shared, vscode-dependent session-flow orchestration for the report-import chat handlers
// (Veracode, Waltz OSS, and any future importer of the same shape). R1: one implementation for the
// session flow (template/issue-type selection -> dedup search -> review screen -> batch ticket
// creation), including message wording — not just control-flow structure (KTD1). Every function
// here takes a `ReportImportDescriptor<TItem, TRow>` supplying the importer-specific bits (parsing,
// filtering, labels, row fields, column layout) — see KTD3. `veracodeHandler.ts`/`waltzHandler.ts`
// build one descriptor each and re-export thin, same-named wrappers around the functions below so
// `extension.ts`/`JiraParticipant.ts` need no call-site changes.
// This file holds the chat side of the session build (template selection, the review build's progress
// lines) and the reply dispatch; the group actions' chat wording lives beside it — importCreate.ts,
// importAddToTicket.ts, importAccept.ts, importStaleClose.ts, importTicketedActions.ts, importMerge.ts —
// over the shared screen streaming in importReviewScreen.ts. What they decide and write lives in the
// vscode-free engine under src/imports/ (the review build in src/imports/review.ts), which the import
// board shares.
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import { hasUnfinishedChoices } from '../../utils/ticketMerge';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { templateLabelsOf } from '../../utils/reportImport';
import {
  buildImportReview as buildImportReviewCore, buildImportTemplateSession as buildImportTemplateSessionCore, refreshReview as refreshReviewCore,
  resolveTemplateFields, type ImportReviewInput, type ReviewBuildContext, type ReviewBuildEvent,
} from '../../imports/review';
import { SESSION_EXPIRED_MESSAGE, applyBulkNewRowSet, buildSearchFollowUp, buildSearchResults, findTicketsBySummary, ticketedTargetKey, applyReviewSessionToggle, applyStaleTicketToggle, applyTicketedActionChange, buildAllHiddenMessage, buildChatCommandLink, buildImportDoneSummary, buildReviewPage, clampStalePage, clampTicketedPage, pageBoundaryAnswer, staleTotalPages, ticketedTotalPages, buildImportHelp, buildRefusedReply, computeImportResultGroups, ensureImportViewState, importCommandCaps, IMPORT_COMMANDS, formatIssueTypeOptionLabel, initImportViewState, isCancellation, isNewGroupDrained, isSessionExpired, isTicketedRowFinished, mergeNewRows, neutralizeMarkdownLinks, parseImportReviewReply, pickEmailOption, safeMarkdownText, ticketedRowActions, unmergeNewRow, type ImportReplyContext, type ImportTemplateSelectionSession, type ReviewRowBase, type ReviewSession, type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession } from '../sessionState';
import { resolveIssueTypeOrPrompt, resolveProjectKey, sessionWasSuperseded } from './ticketContext';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { acceptComponents, acceptRows, showAcceptedList, unacceptEntry } from './importAccept';
import { exportImportOverview } from './importExport';
import { addToTicket, showAddPrompt } from './importAddToTicket';
import { createNewRows, diagOf } from './importCreate';
import { IMPORT_SESSION_KINDS, afterGroupAction, screenOptions, streamImportReview } from './importReviewScreen';
import { handleMergeRunReply, showMergePrompt, startMerge, type MergeTurn } from './importMerge';
import { closeStaleTickets } from './importStaleClose';
import { TICKETED_RUNS, executeTicketedActions } from './importTicketedActions';
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
export { streamStaleCloseStep, continueStaleClose } from './importStaleClose';
export { executeTicketedActions } from './importTicketedActions';

const NO_REPORT_FILE_MESSAGE = '_This review was not built from a report file I can re-read, so there is nothing to reload. Start the import again._\n\n';

export { readAndFilterReport } from '../../imports/review';

// Chat-only entry point's own file picker. Single-file only — callable only by handleImportReport()
// below, whose own callers (Veracode/Waltz's thin wrappers) always supply fileFilter/filePickerTitle/
// parseAndFilter; email never reaches this function at all (see the descriptor fields' doc comment).
async function openReportFilePicker<TItem, TRow extends ReviewRowBase>(
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<{ items: TItem[]; rawItems: unknown[]; fileName: string; filePath: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [descriptor.fileFilter!.label]: descriptor.fileFilter!.extensions },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: descriptor.filePickerTitle,
  });
  if (!uris || uris.length === 0) return null;

  try {
    const { items, rawItems } = await descriptor.parseAndFilter!(uris[0].fsPath);
    return { items, rawItems, fileName: path.basename(uris[0].fsPath), filePath: uris[0].fsPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
}

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

// Entry point for the "importX" operation. Handles both invocation paths:
//  1. Command-triggered — an ImportTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only (e.g. "@jira import veracode report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey; resolveProjectKey() falls back to the
// defaultProject setting, then an input box, when it's null.
export async function handleImportReport<TItem, TRow extends ReviewRowBase>(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  projectKeyHint: string | null = null,
): Promise<vscode.ChatResult | void> {
  const existing = ws.get<ImportTemplateSelectionSession<TItem>>(descriptor.sessionKeys.templateSelection);
  if (existing) {
    if (isSessionExpired(existing)) {
      await ws.update(descriptor.sessionKeys.templateSelection, undefined);
      stream.markdown(SESSION_EXPIRED_MESSAGE);
      return;
    }
    return streamImportTemplateSelection(existing, stream, ws, descriptor);
  }

  const picked = await openReportFilePicker(stream, descriptor);
  if (!picked) return;
  if (picked.items.length === 0) {
    stream.markdown(descriptor.noMatchMessage);
    return;
  }

  const projectKey = await resolveProjectKey(projectKeyHint, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildImportTemplateSession(picked.items, picked.fileName, projectKey, jiraClient, descriptor, picked.rawItems, picked.filePath);
  return streamImportTemplateSelection(session, stream, ws, descriptor);
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
 * (JiraParticipant.ts's shared router calling back in through veracodeHandler.ts/waltzHandler.ts's
 * handleXAwaitIssueType wrappers). `pickedTemplateName` is the picked template's *name* (identity),
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

/** The refresh (src/imports/review.ts), with the reason it left the review as it was worded for chat. */
async function refreshReview<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  filePath: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<{ ok: true; session: ReviewSession<TRow> } | { ok: false; missing: boolean; message: string }> {
  const result = await refreshReviewCore(session, filePath, ticketService, descriptor, reviewBuildContext(stream, descriptor));
  if (result.ok) return result;
  if ('degraded' in result) {
    return { ok: false, missing: false, message: 'Jira could not be searched in full, so the review was left as it was rather than rebuilt from partial data.' };
  }
  return {
    ok: false,
    missing: result.missing,
    message: result.missing ? `The report file \`${path.basename(filePath)}\` is no longer there.` : `Could not re-read the report: ${neutralizeMarkdownLinks(result.error)}`,
  };
}

/** Rebuilds `session` in place from its report file, or from `filePathOverride` (a file the user picked instead). */
async function refreshInPlace<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  filePathOverride?: string,
): Promise<{ ok: true } | { ok: false; missing: boolean }> {
  const filePath = filePathOverride ?? session.reportFilePath;
  if (!filePath) {
    stream.markdown(NO_REPORT_FILE_MESSAGE);
    return { ok: false, missing: false };
  }
  stream.markdown(`_Re-reading \`${neutralizeMarkdownLinks(path.basename(filePath))}\` and checking Jira again…_\n\n`);
  const result = await refreshReview(session, filePath, ticketService, stream, descriptor);
  if (!result.ok) {
    stream.markdown(`✗ ${result.message}\n\n`);
    return result;
  }
  // The rebuilt review replaces the old one; keys it no longer has (a merge run, the out-of-date mark) must not survive.
  for (const key of Object.keys(session)) delete (session as unknown as Record<string, unknown>)[key];
  Object.assign(session, result.session);
  return { ok: true };
}

/** KTD10: after the accepted list changed, rebuild at once when nothing the user set up is lost; otherwise mark the screens out of date. */
async function syncAfterListChange<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<void> {
  if (hasUnfinishedChoices(session)) {
    session.outOfDate = true;
    return;
  }
  const outcome = await refreshInPlace(session, ticketService, stream, descriptor);
  if (!outcome.ok) session.outOfDate = true;
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
 * Overview-hub dispatch (KTD2): a reply is parsed against the vocabulary of the screen currently
 * shown — and only that screen (R6) — then applied. Toggles and page moves re-render the same
 * screen; "open …" / "back" switch screens; each group action runs on its own (R11) and returns to
 * the overview (R10); "done" (or cancelling on the overview) ends the import with a summary (R3).
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
  // A merge that is waiting for the user reads the reply first, ahead of the screen's own vocabulary (KTD3).
  const afterMerge = async (turn: MergeTurn): Promise<vscode.ChatResult | void> => {
    if (turn !== 'finished') {
      if (turn === 'waiting') await ws.update(descriptor.sessionKeys.review, session);
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    }
    Object.assign(session, afterGroupAction(session));
    // A merge that ended with a missing or skipped step leaves a cancelled ticket open, which a rebuild could pick as the target.
    if (descriptor.ticketMerge && session.reportFilePath && !session.outOfDate) await syncAfterListChange(session, ticketService, stream, descriptor);
    return rerender();
  };
  if (session.mergeRun && descriptor.ticketMerge) {
    return afterMerge(await handleMergeRunReply(reply, session, ticketService, stream, descriptor, baseUrl));
  }
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
    case 'merge': {
      // Page-local like a toggle (KTD3): only `rows` changes, `allRows` keeps the originals, so a
      // page move discards the merge and an unmerge can restore them.
      const fold = descriptor.fold!;
      const templateLabels = templateLabelsOf(session.additionalFields);
      session.rows = mergeNewRows(session.rows, action.ids, members =>
        descriptor.buildRowFields(fold.combine(members.map(fold.itemOf)), templateLabels));
      return rerender();
    }
    case 'unmerge':
      session.rows = unmergeNewRow(session.rows, session.allRows, action.id);
      return rerender();
    case 'accept':
      Object.assign(session, await acceptRows(session, action, stream, descriptor));
      return rerender();
    case 'acceptComponent':
      Object.assign(session, await acceptComponents(session, action, ticketService, stream, descriptor));
      return rerender();
    case 'listAccepted':
      showAcceptedList(descriptor, stream);
      return rerender();
    case 'search': {
      // Like `export`: the results are the last thing on screen, and nothing in the session changes.
      const outcome = findTicketsBySummary(session.allRows, session.ticketInfo, action.keyword);
      const matched = outcome.kind === 'results' ? outcome.total : 0;
      logDiag(descriptor.scope, 'info', `${descriptor.importLabel} ticket search`, { matches: matched });
      const followUp = buildSearchFollowUp(view === 'ticketed' ? 'ticketed' : 'new', { canFold: ctx.canFold === true, canMergeTickets: ctx.canMergeTickets === true }, matched > 0);
      stream.markdown(trustedChatMarkdown(`${buildSearchResults(outcome, action.keyword, baseUrl)}\n\n${followUp}`));
      await ws.update(descriptor.sessionKeys.review, session);
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    }
    case 'show':
      return rerender();
    case 'export':
      // The export stays the last thing on screen (no review screen printed over it); the session stays open on the screen it was on.
      await exportImportOverview(session, action.format, ticketService, stream, descriptor, baseUrl);
      await ws.update(descriptor.sessionKeys.review, session);
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    case 'unaccept':
    case 'unacceptEntry':
    case 'unacceptComponent': {
      const willRefresh = descriptor.ticketMerge !== undefined && session.reportFilePath !== undefined;
      const removed = unacceptEntry(descriptor, action, stream, willRefresh);
      if (removed && willRefresh) await syncAfterListChange(session, ticketService, stream, descriptor);
      return rerender();
    }
    case 'mergeTicketsPrompt':
      return afterMerge(await showMergePrompt(session, action.sources, action.target, ticketService, stream, descriptor, baseUrl));
    case 'mergeTickets':
      return afterMerge(await startMerge(session, action.sources, action.target, ticketService, stream, descriptor, baseUrl));
    case 'reloadPrompt': {
      if (!session.reportFilePath) {
        stream.markdown(NO_REPORT_FILE_MESSAGE);
        return rerender();
      }
      const lost = hasUnfinishedChoices(session)
        ? 'You have unfinished choices (excluded or merged New rows, or Already-ticketed actions you changed) and they will be lost.'
        : 'Nothing you have set up on these screens will be lost.';
      stream.markdown(trustedChatMarkdown(
        `Reload re-reads **${safeMarkdownText(path.basename(session.reportFilePath))}**, checks Jira again and rebuilds every screen from the result. It also picks up changes to the accepted list. ${lost}\n\n` +
        `${buildChatCommandLink('Reload now', '@jira', `${IMPORT_COMMANDS.reload} confirm`)}`,
      ));
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    }
    case 'reload': {
      const outcome = await refreshInPlace(session, ticketService, stream, descriptor);
      if (!outcome.ok && outcome.missing) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { [descriptor.fileFilter!.label]: descriptor.fileFilter!.extensions },
          defaultUri: vscode.Uri.file(path.dirname(session.reportFilePath!)),
          title: descriptor.filePickerTitle,
        });
        if (!picked || picked.length === 0) stream.markdown('_No file picked — the review is unchanged._\n\n');
        else await refreshInPlace(session, ticketService, stream, descriptor, picked[0].fsPath);
      }
      return rerender();
    }
    case 'addPrompt':
      await showAddPrompt(session, action.ids, action.key, ticketService, stream, descriptor, baseUrl);
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    case 'add':
      Object.assign(session, afterGroupAction(await addToTicket(session, action.ids, action.key, action.mode, ticketService, stream, descriptor, baseUrl)));
      return rerender();
    case 'toggleRows': {
      // A new-row toggle stays page-local (applyReviewSessionToggle's own contract).
      const toggled = applyReviewSessionToggle(session.rows, session.allRows, action.ids);
      session.rows = toggled.rows;
      session.allRows = toggled.allRows;
      return rerender();
    }
    case 'toggleStale':
      session.staleTickets = applyStaleTicketToggle(session.staleTickets!, action.keys);
      return rerender();
    case 'create':
      Object.assign(session, afterGroupAction(await createNewRows(session, ticketService, stream, descriptor, baseUrl)));
      // Nothing left to act on (no New row, no other command to offer): end the import now instead of showing a Done-only screen.
      if (isNewGroupDrained(session, screenOptions(descriptor, baseUrl))) return finishImport(session, ws, stream, descriptor);
      return rerender();
    case 'setAction':
    case 'setAllActions': {
      // Mirrored into both arrays: the Already-ticketed rows are on every page (R8), and a page move
      // re-derives `rows` from `allRows`.
      const target = action.kind === 'setAction' ? action.id : 'all';
      session.rows = applyTicketedActionChange(session.rows, target, action.action);
      session.allRows = applyTicketedActionChange(session.allRows, target, action.action);
      return rerender();
    }
    case 'apply':
    case 'update':
    case 'recreate': {
      const run = TICKETED_RUNS[action.kind];
      Object.assign(session, afterGroupAction(
        await executeTicketedActions(session, run.actions, run.command, ticketService, stream, descriptor, baseUrl),
      ));
      return rerender();
    }
    case 'close':
      return closeStaleTickets(session, stream, ws, descriptor, baseUrl);
  }
}
