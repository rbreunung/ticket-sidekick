// Shared, vscode-dependent session-flow orchestration for the report-import chat handlers
// (Veracode, Waltz OSS, and any future importer of the same shape). R1: one implementation for the
// session flow (template/issue-type selection -> dedup search -> review screen -> batch ticket
// creation), including message wording — not just control-flow structure (KTD1). Every function
// here takes a `ReportImportDescriptor<TItem, TRow>` supplying the importer-specific bits (parsing,
// filtering, labels, row fields, column layout) — see KTD3. `veracodeHandler.ts`/`waltzHandler.ts`
// build one descriptor each and re-export thin, same-named wrappers around the functions below so
// `extension.ts`/`JiraParticipant.ts` need no call-site changes.
// This file holds the session build (template selection, dedup, stale check, review rows) and the
// reply dispatch; the group actions live beside it — importCreate.ts, importAddToTicket.ts,
// importAccept.ts, importStaleClose.ts, importTicketedActions.ts — over the shared screen streaming
// in importReviewScreen.ts and the descriptor types in reportImportTypes.ts.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import { hasUnfinishedChoices } from '../../utils/ticketMerge';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import { BATCH_LIMIT, DEFAULT_DEDUP_CHUNK_SIZE, MAX_REPORT_BYTES, buildDedupJql, buildReviewRows, applyDroppedMembers, applyMissingDueDate, alignRewriteDefaults, readTargetDescriptions, fetchAllPages, findAlreadyTicketed, findStaleTickets, templateLabelsOf, type DedupMap, type JqlIssueLike } from '../../utils/reportImport';
import { CURRENT_SESSION_SCHEMA_VERSION, NO_ISSUE_TYPE, SESSION_EXPIRED_MESSAGE, applyBulkNewRowSet, applyReviewSessionToggle, applyStaleTicketToggle, applyTicketedActionChange, buildAllHiddenMessage, buildChatCommandLink, buildImportDoneSummary, buildReviewPage, clampStalePage, clampTicketedPage, computeImportResultGroups, describeImportReplyVocabulary, ensureImportViewState, IMPORT_COMMANDS, formatIssueTypeOptionLabel, initImportViewState, isCancellation, isSessionExpired, isTicketedRowFinished, mergeNewRows, neutralizeMarkdownLinks, parseImportReviewReply, pickEmailOption, resolveTemplateIssueType, safeMarkdownText, ticketedRowActions, toAcceptedHidden, unmergeNewRow, type ImportReplyContext, type ImportTemplateSelectionSession, type ReviewRowBase, type ReviewSession, type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession } from '../sessionState';
import { resolveIssueTypeOrPrompt, resolveProjectKey, sessionWasSuperseded } from './ticketContext';
import { buildStaleTicketGroups } from './cleanupHandler';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import type { AcceptedEntry } from '../../utils/waltzAccepted';
import { acceptComponents, acceptRows, showAcceptedList, unacceptEntry } from './importAccept';
import { exportImportOverview } from './importExport';
import { addToTicket, showAddPrompt } from './importAddToTicket';
import { createNewRows } from './importCreate';
import { IMPORT_SESSION_KINDS, afterGroupAction, streamImportReview } from './importReviewScreen';
import { handleMergeRunReply, showMergePrompt, startMerge, type MergeTurn } from './importMerge';
import { closeStaleTickets } from './importStaleClose';
import { TICKETED_RUNS, executeTicketedActions } from './importTicketedActions';
import type { ReportImportDescriptor } from './reportImportTypes';

// Public surface of the import flow: the descriptor types and the group-action entry points other
// modules and the importers' thin wrappers use, kept importable from this file.
export type { ReportImportRow, ReportImportDescriptor, ImportAccepted, ImportFold, ImportChangeTracking } from './reportImportTypes';
export { streamImportReview } from './importReviewScreen';
export { createNewRows } from './importCreate';
export { streamStaleCloseStep, continueStaleClose } from './importStaleClose';
export { executeTicketedActions } from './importTicketedActions';

const NO_REPORT_FILE_MESSAGE = '_This review was not built from a report file I can re-read, so there is nothing to reload. Start the import again._\n\n';

// Page size for the dedup search; fetchAllPages reads every page of each label chunk.
const DEDUP_PAGE_SIZE = 100;

/**
 * Shared read+parse+filter orchestration (stat + size cap, then parse + filter). The two importers
 * differ only in how the file is read (utf-8 string for Veracode's XML, Buffer for Waltz's xlsx) and
 * in their own parse/filter functions — those differences are supplied by the caller, not
 * re-implemented here. Returns both the filtered `items` and the pre-filter `rawItems` (`parse()`'s
 * own output) directly — callers that need the raw, unfiltered set (U6's stale-check predicate) no
 * longer need to smuggle it out of the `filter` callback via a mutable outer variable.
 */
export async function readAndFilterReport<TRaw, TItem>(
  filePath: string,
  readContent: (filePath: string) => Promise<TRaw>,
  parse: (raw: TRaw) => TItem[] | Promise<TItem[]>,
  filter: (items: TItem[]) => TItem[],
  maxBytes: number = MAX_REPORT_BYTES,
): Promise<{ items: TItem[]; rawItems: TItem[] }> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes / (1024 * 1024)} MB size limit.`);
  }
  const raw = await readContent(filePath);
  const rawItems = await parse(raw);
  return { items: filter(rawItems), rawItems };
}

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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  let issueTypes: string[] = [];
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Could not fetch issue types — ${projectKey}, you'll be asked to type it`, {
      projectKey, error: message,
    });
    descriptor.onIssueTypeFetchFailed?.(message, projectKey);
  }

  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: resolveTemplateIssueType(t.issueType, issueTypes) }));
    } catch (err) {
      logDiag(descriptor.scope, 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();

  return {
    reportFileName: fileName,
    ...(reportFilePath ? { reportFilePath } : {}),
    projectKey,
    items,
    rawItems,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : [NO_ISSUE_TYPE],
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (workspaceRoot) {
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        const fullTemplate = templates.find(t => t.name === pickedTemplateName);
        if (fullTemplate) {
          const resolver = new FieldResolver(jiraClient, session.projectKey);
          additionalFields = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
        } else {
          // The template was renamed or removed from .jira-templates.json between the list being
          // shown and this reply — additionalFields would otherwise silently stay {} with no signal,
          // unlike the thrown-error path right below, which does warn (R6/AE3).
          logDiag(descriptor.scope, 'warn', `Template no longer found — proceeding without it — ${pickedTemplateName}`, { templateName: pickedTemplateName });
          stream.markdown(
            `_Warning: template "${pickedTemplateName}" is no longer available — proceeding without its default fields._\n\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag(descriptor.scope, 'warn', `Could not resolve template fields — ${pickedTemplateName}`, { templateName: pickedTemplateName, error: message });
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ${message}_\n\n`,
        );
      }
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

/** What a review is built from: the filtered report items, the choices made at import time, and where the report came from. */
interface ImportReviewInput<TItem> {
  projectKey: string;
  items: TItem[];
  rawItems: unknown[];
  reportFilePath?: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>;
  /** Target-ticket descriptions already read for this review (remediation dates, KTD1), reused by a rebuild. */
  descriptionCache?: Record<string, string | null>;
}

/**
 * The dedup search, the review rows and the stale check, in one place (KTD9): the first import and every
 * refresh or reload build the review through this, so a rebuilt review is the review a fresh import would show.
 * Streams its progress lines; the caller decides what to show when nothing is left to review.
 */
async function buildImportReview<TItem, TRow extends ReviewRowBase>(
  input: ImportReviewInput<TItem>,
  resolutions: Pick<IJiraClient, 'getResolutions'>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<{ session: ReviewSession<TRow>; degraded: boolean }> {
  // True when a Jira search the review depends on failed in whole or in part: the result is then a first-import best
  // effort, not something a refresh may put in place of a review that was built from complete data.
  let degraded = false;
  const plural = descriptor.itemNoun.replace('(s)', 's'); // 'flaw(s)' -> 'flaws', 'component(s)' -> 'components'
  const templateLabels = templateLabelsOf(input.additionalFields);

  // KTD2: dedup is optional — an importer that omits searchLabelOf/dedupKeyOf/labelToDedupKey (email)
  // has no per-item dedup key, so the "already ticketed" search is skipped entirely rather than run
  // and found empty. dedupMap stays empty, so every item is treated as new below.
  let dedupMap: DedupMap = new Map();
  if (descriptor.searchLabelOf && descriptor.dedupKeyOf && descriptor.labelToDedupKey) {
    stream.markdown(`_Checking for already-ticketed ${plural}…_\n\n`);
    // The template session was already cleared above, so a failure here must degrade gracefully
    // rather than throw with nothing left to resume from. findAlreadyTicketed() is itself
    // fault-tolerant per chunk (R5/AE2) and never rejects — this catch is a defensive backstop for a
    // failure outside the per-chunk loop (e.g. an error thrown by descriptor.searchLabelOf/labelToDedupKey
    // themselves). Total per-chunk coverage loss (every chunk failed) is a distinct, non-throwing
    // outcome, surfaced instead via the failedChunks/totalChunks check below, which reuses this
    // same user-facing warning for the total-coverage-loss case.
    try {
      // U2/R11: flattens across every item's own multiple candidate labels (a folded Veracode
      // group contributes one label per member flaw) so every member flaw's label is searched for.
      const searchLabels = input.items.flatMap(descriptor.searchLabelOf);
      const result = await findAlreadyTicketed(
        searchLabels,
        DEFAULT_DEDUP_CHUNK_SIZE,
        // U3/KTD1: resolution + created let buildReviewRows pick each item's newest open ticket; duedate lets Veracode see which have none.
        // Every page is read: the union of an item's tickets decides its target and known findings.
        chunk => fetchAllPages(
          (startAt, pageToken) => ticketService.searchTicketsRaw(buildDedupJql(input.projectKey, chunk), DEDUP_PAGE_SIZE, ['resolution', 'created', 'duedate'], startAt, pageToken)
            .then(r => ({ ...r, issues: r.issues as JqlIssueLike[] })),
          DEDUP_PAGE_SIZE,
          undefined,
          issue => issue.key,
        ),
        descriptor.labelToDedupKey,
        (level, message, details) => logDiag(descriptor.scope, level, message, details),
      );
      dedupMap = result.map;
      if (result.failedChunks > 0) degraded = true;
      if (result.totalChunks > 0 && result.failedChunks === result.totalChunks) {
        logDiag(descriptor.scope, 'warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
          projectKey: input.projectKey, failedChunks: result.failedChunks, totalChunks: result.totalChunks,
        });
        stream.markdown(`_Warning: could not check for already-ticketed ${plural} — proceeding without dedup._\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag(descriptor.scope, 'warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
        projectKey: input.projectKey, error: message,
      });
      stream.markdown(`_Warning: could not check for already-ticketed ${plural} — proceeding without dedup: ${message}_\n\n`);
      dedupMap = new Map();
      degraded = true;
    }
  }

  // Remediation dates (KTD1): an importer with its own action policy compares what each target ticket recorded with
  // the report, so it reads those tickets' descriptions (the search cannot carry them: on Cloud it returns ADF).
  // A read that fails leaves that ticket's description unknown, which skips the date comparison for it and marks the
  // review degraded so a refresh does not replace a review built from complete data.
  const waltzStyle = !!descriptor.changeTracking?.readsTargetDescriptions && !!descriptor.dedupKeyOf;
  let ticketDescriptions: Record<string, string | null> | undefined;
  if (waltzStyle && dedupMap.size > 0) {
    const reads = await readTargetDescriptions<TItem>({
      items: input.items,
      dedupMap,
      dedupKeyOf: descriptor.dedupKeyOf!,
      cache: input.descriptionCache,
      read: async key => {
        const description = (await ticketService.getIssue(key)).fields.description as unknown;
        return typeof description === 'string' ? description : null;
      },
      onFail: (key, err) => logDiag(descriptor.scope, 'warn', `Could not read the description of ${key} — its dates are not compared`, {
        issueKey: key, error: err instanceof Error ? err.message : String(err),
      }),
    });
    ticketDescriptions = reads.read;
    if (reads.failed > 0) {
      degraded = true;
      stream.markdown(`_Warning: could not read ${reads.failed} ticket(s) to compare their dates — those rows are not checked for date changes._\n\n`);
    }
  }

  // U4: every matched item gets its lightweight row fields built eagerly (severity/CWE/summary/
  // labels) — no pre-build cap here anymore. The review screen pages through the full "new" set
  // instead of silently dropping the remainder of a run (buildReviewPage below); an importer whose
  // full ticket description is expensive to build (Veracode's folded-group description) defers
  // that part to ticket-creation time via its own buildTicketFields, rather than paying the cost
  // here for every candidate the user may never confirm.
  const dedupKeyOf = descriptor.dedupKeyOf ?? (() => []);
  // Accepted-CVE list (KTD1): applied to the New items only, after the dedup split, so Already ticketed
  // and Stale keep seeing the full report (R8). A missing list file or workspace hides nothing; a
  // broken one hides nothing and is reported.
  const acceptedHidden = { cves: 0, belowFloor: 0, components: 0 };
  let narrowNew: ((item: TItem) => TItem | null) | undefined;
  let dropTicketed: ((item: TItem) => boolean) | undefined;
  let acceptedEntries: AcceptedEntry[] = [];
  if (descriptor.accepted) {
    const accepted = descriptor.accepted;
    const loaded = accepted.service()?.load();
    if (loaded?.warning) {
      logDiag(descriptor.scope, 'warn', 'Accepted-CVE list could not be applied in full', { warning: loaded.warning });
      stream.markdown(`_Warning: ${neutralizeMarkdownLinks(loaded.warning)}_\n\n`);
    }
    if (loaded && loaded.entries.length > 0) {
      acceptedEntries = loaded.entries;
      narrowNew = item => {
        const narrowed = accepted.narrow(item, loaded.entries);
        acceptedHidden.cves += narrowed.hiddenCves;
        acceptedHidden.belowFloor += narrowed.belowFloor;
        acceptedHidden.components += narrowed.hiddenComponents;
        return narrowed.item;
      };
      dropTicketed = item => {
        const dropped = accepted.isAccepted(item, loaded.entries);
        if (dropped) acceptedHidden.components++;
        return dropped;
      };
    }
  }
  const reportKeys = waltzStyle ? descriptor.changeTracking!.reportKeysOf?.(input.rawItems) ?? [] : undefined;
  let allRows = buildReviewRows<TItem, TRow>(
    input.items,
    dedupMap,
    dedupKeyOf,
    item => descriptor.buildRowFields(item, templateLabels),
    descriptor.changeTracking,
    narrowNew,
    dropTicketed,
  );
  // KTD10/KTD8: a member that left the report counts as a change for every row of its ticket, and rows of one
  // ticket share a `rewrite` default because `rewrite` rebuilds the whole ticket.
  if (waltzStyle && descriptor.fold && descriptor.labelToDedupKey) {
    allRows = applyDroppedMembers<TItem, TRow>({
      rows: allRows,
      dedupMap,
      itemOf: descriptor.fold.itemOf,
      dedupKeyOf,
      labelToDedupKey: descriptor.labelToDedupKey,
      reportKeys: new Set(reportKeys),
      derive: descriptor.changeTracking!.deriveActions!,
    });
  }
  // A Due Date is set once (Veracode): an open ticket without one is a change for dates, before the shared rewrite defaults align.
  const backfill = descriptor.changeTracking?.dueDateBackfill;
  if (backfill && descriptor.fold && descriptor.changeTracking?.deriveActions) {
    allRows = applyMissingDueDate<TItem, TRow>({
      rows: allRows, dedupMap, itemOf: descriptor.fold.itemOf, expectedFor: backfill.expectedFor, derive: descriptor.changeTracking.deriveActions,
    });
  }
  if (descriptor.changeTracking?.deriveActions) allRows = alignRewriteDefaults(allRows);
  const initialPage = buildReviewPage(allRows, 0);
  const hiddenCounts = toAcceptedHidden(acceptedHidden);

  let reviewSession: ReviewSession<TRow> = {
    projectKey: input.projectKey,
    issueType: input.issueType,
    templateName: input.templateName,
    additionalFields: input.additionalFields,
    ...(input.reportFilePath ? { reportFilePath: input.reportFilePath } : {}),
    allRows,
    rows: initialPage.rows,
    page: initialPage.page,
    ...(ticketDescriptions ? { ticketDescriptions } : {}),
    ...(reportKeys ? { reportKeys } : {}),
    ...(hiddenCounts ? { acceptedHidden: hiddenCounts } : {}),
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };

  // U6/R1/R5: reverse stale-ticket check — an importer with no marker-label concept (email) omits
  // `descriptor.stale` and this whole block is skipped, exactly like the dedup block above.
  if (descriptor.stale) {
    stream.markdown('_Checking for stale tickets…_\n\n');
    const issueDetails = new Map<string, { summary: string; currentStatus: string; issueType: string }>();
    const staleResult = await findStaleTickets(
      input.projectKey,
      descriptor.stale.markerLabel,
      async (jql, maxResults, startAt, pageToken) => {
        const result = await ticketService.searchTicketsRaw(jql, maxResults, [], startAt, pageToken);
        // Captured as a side effect of the search findStaleTickets() already runs — searchJql's
        // baseFields always include summary/status/issuetype (see JiraApiClient.ts), so this needs
        // no second fetch keyed by the returned stale keys. `JiraIssue.fields` already types these
        // (issuetype is optional for older fixtures only), so no cast is needed to read them.
        for (const issue of result.issues) {
          issueDetails.set(issue.key, {
            summary: issue.fields.summary,
            currentStatus: issue.fields.status.name,
            issueType: issue.fields.issuetype?.name ?? '',
          });
        }
        // JiraIssue[] structurally satisfies JqlIssueLike[] (a strict subset of fields), so no
        // narrowing cast is needed on the return either.
        return result;
      },
      descriptor.stale.labelToDedupKey,
      descriptor.stale.buildActivePredicate(input.rawItems, acceptedEntries),
      (level, message, details) => logDiag(descriptor.scope, level, message, details),
    );

    if (staleResult.searchFailed) {
      degraded = true;
      stream.markdown('_Warning: could not check for stale tickets — proceeding without a stale-ticket section._\n\n');
    } else {
      // Code-review fix: hoisted out of the `stale.length > 0` branch below — this must render
      // whenever the search was truncated, independent of how many of the checked tickets turned
      // out stale, or KTD10's "must not silently lose coverage past one search page" guarantee is
      // defeated on any project with >BATCH_LIMIT open marker-labeled tickets where none of the
      // checked ones happen to be stale. Wording fixed too: `totalFound` is the total open
      // marker-labeled ticket count the search matched, not a stale count.
      if (staleResult.truncated) {
        stream.markdown(
          `_Checked the first ${staleResult.checked} of ${staleResult.totalFound} ticket(s) carrying the stale-check label` +
          ` — ${staleResult.stale.length} looked stale, but coverage may be incomplete._\n\n`,
        );
      }
      // Accepted components (KTD5): an importer with an accepted list keeps the open tickets it did not flag.
      if (descriptor.accepted && staleResult.pending.length > 0) {
        const staleCandidates = staleResult.pending.flatMap(m => {
          const detail = issueDetails.get(m.key);
          return detail ? [{ key: m.key, summary: detail.summary, currentStatus: detail.currentStatus, issueType: detail.issueType, activeIds: m.ids }] : [];
        });
        if (staleCandidates.length > 0) reviewSession = { ...reviewSession, staleCandidates };
      }
      if (staleResult.stale.length > 0) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // Code-review fix: buildStaleTicketGroups() (and the synchronous
        // TemplateService.loadTemplates() it calls internally) had no guard here, unlike the
        // dedup-search block above — a transient failure (auth blip, network timeout, malformed
        // templates file) would propagate past the point where the prior template-selection
        // session was already cleared and discard the whole in-progress review (the dedup work,
        // the folded rows, the page the user was on). Degrade the same way
        // `staleResult.searchFailed` already does instead of throwing.
        try {
          const grouped = await buildStaleTicketGroups(staleResult.stale, issueDetails, input.projectKey, resolutions, workspaceRoot, descriptor.scope);
          // The target (and any resolution) is picked only when the user closes selected tickets
          // (stale-ticket target pick plan, R1) — nothing is asked here.
          reviewSession = { ...reviewSession, staleTickets: grouped };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag(descriptor.scope, 'warn', 'Could not check for stale tickets — proceeding without a stale-ticket section', {
            projectKey: input.projectKey, error: message,
          });
          stream.markdown('_Warning: could not check for stale tickets — proceeding without a stale-ticket section._\n\n');
        }
      }
    }
  }

  return { session: reviewSession, degraded };
}

/**
 * The descriptions read for a review stay valid across a rebuild until this session rewrites, adds to or merges a
 * ticket (the writes that change a description), whether or not that write succeeded in full.
 */
function canReuseDescriptions<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): boolean {
  const o = session.outcomes;
  return !o || o.rewritten + o.rewriteFailed + o.added + o.addFailed + o.merged + o.mergeFailed === 0;
}

type RefreshResult<TRow extends ReviewRowBase> = { ok: true; session: ReviewSession<TRow> } | { ok: false; missing: boolean; message: string };

/**
 * Waltz ticket merge (KTD9): rebuilds the review from its report file. Keeps what the user did that still
 * means something (issue type, template, fields, outcomes) and recomputes what depends on the rows — the
 * groups, whether there is an overview, the page positions. The previous view stays only when its group
 * still exists. A file that is gone or no longer parses leaves the review as it was.
 */
async function refreshReview<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  filePath: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<RefreshResult<TRow>> {
  let parsed: { items: TItem[]; rawItems: unknown[] };
  try {
    parsed = await descriptor.parseAndFilter!(filePath);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    const detail = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Could not re-read the report — ${filePath}`, { path: filePath, missing, error: detail });
    return { ok: false, missing, message: missing ? `The report file \`${path.basename(filePath)}\` is no longer there.` : `Could not re-read the report: ${neutralizeMarkdownLinks(detail)}` };
  }
  const { session: built, degraded } = await buildImportReview<TItem, TRow>({
    projectKey: session.projectKey, items: parsed.items, rawItems: parsed.rawItems, reportFilePath: filePath,
    issueType: session.issueType, templateName: session.templateName, additionalFields: session.additionalFields,
    ...(canReuseDescriptions(session) ? { descriptionCache: session.ticketDescriptions } : {}),
  }, { getResolutions: () => ticketService.getResolutions() }, ticketService, stream, descriptor);
  if (degraded) {
    logDiag(descriptor.scope, 'warn', 'Refresh left the review as it was: a Jira search failed, so a rebuild would show items as New that already have tickets', { path: filePath });
    return { ok: false, missing: false, message: 'Jira could not be searched in full, so the review was left as it was rather than rebuilt from partial data.' };
  }
  const fresh = initImportViewState(built);
  // The view stays only while the review keeps its shape: still with an overview (or still without one) and the
  // screen's group still there. A review that gained or lost its overview starts from the fresh view instead.
  const keepsView = session.view !== undefined && session.singleGroup === fresh.singleGroup
    && (session.view === 'overview' ? !fresh.singleGroup : fresh.groups!.includes(session.view));
  const page = buildReviewPage(fresh.allRows, session.page);
  return {
    ok: true,
    session: {
      ...fresh,
      view: keepsView ? session.view! : fresh.view,
      outcomes: session.outcomes ?? fresh.outcomes,
      rows: page.rows,
      page: page.page,
      ticketedPage: clampTicketedPage(session.ticketedPage ?? 0, fresh.allRows),
      stalePage: clampStalePage(session.stalePage ?? 0, fresh.staleTickets),
    },
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
      stream.markdown(trustedChatMarkdown(`${action.reason ?? "Didn't understand that."} ${describeImportReplyVocabulary(view, ctx)}`));
      return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
    case 'open':
      session.view = action.view;
      return rerender();
    case 'back':
      session.view = 'overview';
      return rerender();
    case 'done': {
      await ws.update(descriptor.sessionKeys.review, undefined);
      const outcomes = session.outcomes!;
      logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import finished`, { ...outcomes });
      stream.markdown(buildImportDoneSummary(outcomes, descriptor.changeTracking?.actionLabels));
      return;
    }
    case 'pageNav': {
      if (view === 'stale') {
        const from = clampStalePage(session.stalePage ?? 0, session.staleTickets);
        const target = action.nav.kind === 'next' ? from + 1 : action.nav.kind === 'prev' ? from - 1 : action.nav.page;
        session.stalePage = clampStalePage(target, session.staleTickets);
        return rerender();
      }
      if (view === 'ticketed') {
        const from = clampTicketedPage(session.ticketedPage ?? 0, session.allRows);
        const target = action.nav.kind === 'next' ? from + 1 : action.nav.kind === 'prev' ? from - 1 : action.nav.page;
        session.ticketedPage = clampTicketedPage(target, session.allRows);
        return rerender();
      }
      const current = buildReviewPage(session.allRows, session.page);
      const target = action.nav.kind === 'next' ? current.page + 1 : action.nav.kind === 'prev' ? current.page - 1 : action.nav.page;
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
    case 'export':
      await exportImportOverview(session, action.csv, ticketService, stream, descriptor, baseUrl);
      return rerender();
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
