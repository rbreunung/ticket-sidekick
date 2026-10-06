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
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import { BATCH_LIMIT, DEFAULT_DEDUP_CHUNK_SIZE, MAX_REPORT_BYTES, buildDedupJql, buildReviewRows, fetchAllPages, findAlreadyTicketed, findStaleTickets, templateLabelsOf, type DedupMap, type JqlIssueLike } from '../../utils/reportImport';
import { CURRENT_SESSION_SCHEMA_VERSION, NO_ISSUE_TYPE, SESSION_EXPIRED_MESSAGE, applyBulkNewRowSet, applyReviewSessionToggle, applyStaleTicketToggle, applyTicketedActionChange, buildAllHiddenMessage, buildChatCommandLink, buildImportDoneSummary, buildReviewPage, computeImportResultGroups, describeImportReplyVocabulary, ensureImportViewState, formatIssueTypeOptionLabel, initImportViewState, isCancellation, isSessionExpired, isTicketedRowFinished, mergeNewRows, neutralizeMarkdownLinks, parseImportReviewReply, pickEmailOption, resolveTemplateIssueType, ticketedRowActions, unmergeNewRow, type ImportReplyContext, type ImportTemplateSelectionSession, type ReviewRowBase, type ReviewSession, type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession } from '../sessionState';
import { resolveIssueTypeOrPrompt, resolveProjectKey, sessionWasSuperseded } from './ticketContext';
import { buildStaleTicketGroups } from './cleanupHandler';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { acceptRows, showAcceptedList, unacceptEntry } from './importAccept';
import { addToTicket, showAddPrompt } from './importAddToTicket';
import { createNewRows } from './importCreate';
import { IMPORT_SESSION_KINDS, afterGroupAction, streamImportReview } from './importReviewScreen';
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
): Promise<{ items: TItem[]; rawItems: unknown[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [descriptor.fileFilter!.label]: descriptor.fileFilter!.extensions },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: descriptor.filePickerTitle,
  });
  if (!uris || uris.length === 0) return null;

  try {
    const { items, rawItems } = await descriptor.parseAndFilter!(uris[0].fsPath);
    return { items, rawItems, fileName: path.basename(uris[0].fsPath) };
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

  const session = await buildImportTemplateSession(picked.items, picked.fileName, projectKey, jiraClient, descriptor, picked.rawItems);
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

  const plural = descriptor.itemNoun.replace('(s)', 's'); // 'flaw(s)' -> 'flaws', 'component(s)' -> 'components'
  const templateLabels = templateLabelsOf(additionalFields);

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
      const searchLabels = session.items.flatMap(descriptor.searchLabelOf);
      const result = await findAlreadyTicketed(
        searchLabels,
        DEFAULT_DEDUP_CHUNK_SIZE,
        // U3/KTD1: resolution + created let buildReviewRows pick each item's newest open ticket.
        // Every page is read: the union of an item's tickets decides its target and known findings.
        chunk => fetchAllPages(
          startAt => ticketService.searchTicketsRaw(buildDedupJql(session.projectKey, chunk), DEDUP_PAGE_SIZE, ['resolution', 'created'], startAt)
            .then(r => ({ ...r, issues: r.issues as JqlIssueLike[] })),
          DEDUP_PAGE_SIZE,
        ),
        descriptor.labelToDedupKey,
        (level, message, details) => logDiag(descriptor.scope, level, message, details),
      );
      dedupMap = result.map;
      if (result.totalChunks > 0 && result.failedChunks === result.totalChunks) {
        logDiag(descriptor.scope, 'warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
          projectKey: session.projectKey, failedChunks: result.failedChunks, totalChunks: result.totalChunks,
        });
        stream.markdown(`_Warning: could not check for already-ticketed ${plural} — proceeding without dedup._\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag(descriptor.scope, 'warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
        projectKey: session.projectKey, error: message,
      });
      stream.markdown(`_Warning: could not check for already-ticketed ${plural} — proceeding without dedup: ${message}_\n\n`);
      dedupMap = new Map();
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
  const acceptedHidden = { cves: 0, belowFloor: 0 };
  let narrowNew: ((item: TItem) => TItem | null) | undefined;
  if (descriptor.accepted) {
    const accepted = descriptor.accepted;
    const loaded = accepted.service()?.load();
    if (loaded?.warning) {
      logDiag(descriptor.scope, 'warn', 'Accepted-CVE list could not be applied in full', { warning: loaded.warning });
      stream.markdown(`_Warning: ${neutralizeMarkdownLinks(loaded.warning)}_\n\n`);
    }
    if (loaded && loaded.entries.length > 0) {
      narrowNew = item => {
        const narrowed = accepted.narrow(item, loaded.entries);
        acceptedHidden.cves += narrowed.hiddenCves;
        acceptedHidden.belowFloor += narrowed.belowFloor;
        return narrowed.item;
      };
    }
  }
  const allRows = buildReviewRows<TItem, TRow>(
    session.items,
    dedupMap,
    dedupKeyOf,
    item => descriptor.buildRowFields(item, templateLabels),
    descriptor.changeTracking,
    narrowNew,
  );
  const initialPage = buildReviewPage(allRows, 0);

  let reviewSession: ReviewSession<TRow> = {
    projectKey: session.projectKey,
    issueType,
    templateName,
    additionalFields,
    allRows,
    rows: initialPage.rows,
    page: initialPage.page,
    ...(acceptedHidden.cves > 0 || acceptedHidden.belowFloor > 0 ? { acceptedHidden } : {}),
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };

  // U6/R1/R5: reverse stale-ticket check — an importer with no marker-label concept (email) omits
  // `descriptor.stale` and this whole block is skipped, exactly like the dedup block above.
  if (descriptor.stale) {
    stream.markdown('_Checking for stale tickets…_\n\n');
    const issueDetails = new Map<string, { summary: string; currentStatus: string; issueType: string }>();
    const staleResult = await findStaleTickets(
      session.projectKey,
      descriptor.stale.markerLabel,
      async (jql, maxResults) => {
        const result = await ticketService.searchTicketsRaw(jql, maxResults);
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
      descriptor.stale.buildActivePredicate(session.rawItems ?? []),
      (level, message, details) => logDiag(descriptor.scope, level, message, details),
    );

    if (staleResult.searchFailed) {
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
          `_Checked the first ${BATCH_LIMIT} of ${staleResult.totalFound} ticket(s) carrying the stale-check label` +
          ` — ${staleResult.stale.length} looked stale, but coverage may be incomplete._\n\n`,
        );
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
          const grouped = await buildStaleTicketGroups(staleResult.stale, issueDetails, session.projectKey, jiraClient, workspaceRoot, descriptor.scope);
          // The target (and any resolution) is picked only when the user closes selected tickets
          // (stale-ticket target pick plan, R1) — nothing is asked here.
          reviewSession = { ...reviewSession, staleTickets: grouped };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag(descriptor.scope, 'warn', 'Could not check for stale tickets — proceeding without a stale-ticket section', {
            projectKey: session.projectKey, error: message,
          });
          stream.markdown('_Warning: could not check for stale tickets — proceeding without a stale-ticket section._\n\n');
        }
      }
    }
  }

  // Every finding was kept off the screen by the accepted list and nothing else (ticketed, stale) is
  // left to review: say so, rather than the filter-mismatch wording. Runs after the stale check
  // because Stale counts as a group (KTD1).
  if (reviewSession.acceptedHidden && computeImportResultGroups(reviewSession.allRows, reviewSession.staleTickets).length === 0) {
    stream.markdown(buildAllHiddenMessage(reviewSession.acceptedHidden));
    return {};
  }

  return streamImportReview(initImportViewState(reviewSession), stream, ws, descriptor, baseUrl);
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
    mergedRowIds: session.rows.filter(r => r.existingTicketKey === null && r.memberIds !== undefined).map(r => r.id),
  };
  const action = parseImportReviewReply(view, reply, ctx);
  const rerender = () => streamImportReview(session, stream, ws, descriptor, baseUrl);

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
      stream.markdown(buildImportDoneSummary(outcomes));
      return;
    }
    case 'pageNav': {
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
    case 'listAccepted':
      showAcceptedList(descriptor, stream);
      return rerender();
    case 'unaccept':
    case 'unacceptEntry':
      unacceptEntry(descriptor, action, stream);
      return rerender();
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
