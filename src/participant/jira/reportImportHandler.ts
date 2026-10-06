// Shared, vscode-dependent session-flow orchestration for the report-import chat handlers
// (Veracode, Waltz OSS, and any future importer of the same shape). R1: one implementation for the
// session flow (template/issue-type selection -> dedup search -> review screen -> batch ticket
// creation), including message wording — not just control-flow structure (KTD1). Every function
// here takes a `ReportImportDescriptor<TItem, TRow>` supplying the importer-specific bits (parsing,
// filtering, labels, row fields, column layout) — see KTD3. `veracodeHandler.ts`/`waltzHandler.ts`
// build one descriptor each and re-export thin, same-named wrappers around the functions below so
// `extension.ts`/`JiraParticipant.ts` need no call-site changes.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import { formatKeyLink } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import {
  MAX_REPORT_BYTES, BATCH_LIMIT, DEFAULT_DEDUP_CHUNK_SIZE, findAlreadyTicketed, fetchAllPages, buildReviewRows,
  buildDedupJql, findStaleTickets, templateLabelsOf, type JqlIssueLike, type DedupMap, type RowChange,
} from '../../utils/reportImport';
import {
  isCancellation, pickEmailOption, applyStaleTicketToggle,
  parseResolutionSelection, buildReviewPage,
  buildStaleTargetOptions, formatStaleTargetOption, parseStaleTargetPick, parseStaleIssueTypePick,
  selectedStaleIssueTypes, staleTargetState, staleTargetNeedsResolution, planStaleTransitions,
  selectedOpenStaleTickets, isBackOrCancellation,
  type StaleTargetOption, applyReviewSessionToggle, applyBulkNewRowSet, mergeNewRows, unmergeNewRow, buildAddPrompt, findPartialRewrites, type AddMode,
  applyTicketedActionChange, ticketedRowActions, ticketedTargetKey, isTicketedRowFinished,
  type TicketedAction, type TicketedRowResult,
  buildImportScreen, parseImportReviewReply, describeImportReplyVocabulary, buildImportDoneSummary,
  initImportViewState, ensureImportViewState, emptyImportOutcomes,
  type ImportReplyContext, type ImportScreenOptions,
  CURRENT_SESSION_SCHEMA_VERSION, isSessionExpired, SESSION_EXPIRED_MESSAGE,
  NO_ISSUE_TYPE, resolveTemplateIssueType, formatIssueTypeOptionLabel, buildChatCommandLink,
  type ImportTemplateSelectionSession, type ReviewSession, type ReviewTableColumn, type ReviewRowBase,
  type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession, type JiraSessionKind,
  type VeracodeReviewSession, type WaltzReviewSession, type StaleCloseSession,
} from '../sessionState';
import { resolveProjectKey, resolveIssueTypeOrPrompt, sessionWasSuperseded, STALE_RESOLUTION_SESSION_KEY } from './ticketContext';
import { buildStaleTicketGroups, transitionTickets } from './cleanupHandler';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';

export interface ReportImportRow extends ReviewRowBase {
  labels: string[];
  summary: string;
  descriptionWiki: string;
}

/**
 * Per-importer descriptor (KTD3) — a plain object of typed fields/functions, not a class hierarchy
 * or a registry. Everything genuinely different between an importer lives here; everything about
 * the session flow itself (control flow AND message wording, per KTD1) lives in the functions below
 * and must not be overridable through this object. `TRow` need only satisfy `ReviewRowBase` — the
 * dedup-shaped `ReportImportRow` fields (labels/summary/descriptionWiki) are Veracode/Waltz-specific,
 * not a shared-row requirement, so an importer with no dedup concept (email) can supply its own row
 * shape instead.
 */
export interface ReportImportDescriptor<TItem, TRow extends ReviewRowBase> {
  // R6/KTD4: identifies which importer this is to the shared issue-type chat-ask's
  // AwaitIssueTypeResume — JiraParticipant.ts's router uses it to pick which of
  // veracodeHandler.ts's/waltzHandler.ts's/emailHandler.ts's handleXAwaitIssueType wrapper to
  // resume through.
  descriptorKind: 'veracode' | 'waltz' | 'email';
  scope: string; // logDiag scope, e.g. 'jira.veracode' / 'jira.waltz' / 'jira.email'
  importLabel: string; // e.g. 'Veracode' / 'Waltz OSS' — used only in the final diag-log line
  itemNoun: string; // e.g. 'flaw(s)' / 'component(s)' — table/summary wording
  filterKindLabel: string; // e.g. 'severity/status' / 'rating/remediation' — template-selection wording
  noMatchMessage: string; // full "no items matched your filters" message (config key names differ per importer)
  // These three back openReportFilePicker()/handleImportReport() below, which are single-file (one
  // report -> many items) — Veracode/Waltz's only file-picker entry point. Optional because email's
  // one-file-per-item shape doesn't fit that contract; email's own entry points (emailHandler.ts)
  // build EmailImportItem[] themselves via a multi-select picker and call buildImportTemplateSession()
  // directly, bypassing openReportFilePicker()/handleImportReport() entirely — so email's descriptor
  // omits all three rather than supplying values nothing would ever invoke.
  fileFilter?: { label: string; extensions: string[] };
  filePickerTitle?: string;
  // readAndFilterXFile — encoding-aware per importer. U6: also returns the *raw, unfiltered* parsed
  // items (`rawItems`) alongside the filtered `items` — needed by `descriptor.stale.buildActivePredicate`
  // below. `unknown[]` rather than a second generic parameter: Veracode's raw items (individual
  // pre-fold flaws) are a different shape than `TItem` (folded groups) — see ImportTemplateSelectionSession.rawItems.
  parseAndFilter?: (filePath: string) => Promise<{ items: TItem[]; rawItems: unknown[] }>;
  sessionKeys: {
    templateSelection: string;
    review: string;
  };
  // KTD2: dedup is optional — an importer with no dedup key (email) omits all three, and the
  // "already ticketed" search step is skipped entirely instead of run and found empty.
  // U2/R11: both return one candidate value *per member* of the item — a folded Veracode group
  // returns one label/key per flaw it contains, so a match on any one of them counts as
  // already-ticketed; a single-item importer (Waltz) just returns a one-element array (no
  // behavior change there).
  searchLabelOf?: (item: TItem) => string[]; // every label value searched for in the dedup JQL
  dedupKeyOf?: (item: TItem) => string[]; // every key looked up in the dedup map (may differ from searchLabelOf)
  labelToDedupKey?: (label: string) => string | null;
  buildRowFields: (item: TItem, templateLabels: string[]) => Omit<TRow, keyof ReviewRowBase>;
  reviewColumns: ReviewTableColumn<TRow>[];
  itemRefFor: (row: TRow) => string; // e.g. 'Flaw 10101' / 'example-lib:1.2.3' — creation-failure line + log details
  // KTD3: builds the ticket's summary + create-fields from a row (and the batch's resolved template
  // fields) — the only place a row's fields become a `createTicket()` call, so an importer with no
  // `labels`/`descriptionWiki` concept (email) never needs those fields at all.
  buildTicketFields: (row: TRow, additionalFields: Record<string, unknown>) => { summary: string; fields: Record<string, unknown> };
  // KTD4: optional per-row work after a ticket is created (email uses this for attachment upload).
  // A rejection is caught by the shared creation step (createOne) and shown as a warning — it never fails the row,
  // since the ticket already exists by the time this runs.
  afterCreate?: (row: TRow, issueKey: string, ticketService: TicketService) => Promise<void>;
  // KTD9: optional UI-notify callback for issue-type-fetch failure, so Veracode's user-visible
  // showWarningMessage on that path survives being driven through this shared builder. Waltz/email
  // omit it (or could pass a log-only callback) since they have no such warning today.
  onIssueTypeFetchFailed?: (message: string, projectKey: string) => void;
  // U6: optional reverse stale-ticket check (findStaleTickets, R1/R5) — an importer with no
  // marker-label concept (email) omits this and the stale section/ask never runs for it.
  // `buildActivePredicate` receives the batch's raw, unfiltered items (see
  // ImportTemplateSelectionSession.rawItems) and returns the "is this marker id still active"
  // predicate findStaleTickets() needs; the importer's own handler file (veracodeHandler.ts/
  // waltzHandler.ts) casts `rawItems` back to its real type before delegating to
  // buildVeracodeActiveFlawPredicate/buildWaltzActiveComponentPredicate.
  stale?: {
    markerLabel: string;
    labelToDedupKey: (label: string) => string | null;
    buildActivePredicate: (rawItems: unknown[]) => (dedupKey: string) => boolean;
  };
  // Import ticket updates parity (KTD2): optional change tracking for already-ticketed rows —
  // drives the per-row actions (update / follow-up / re-create / leave) on the Already-ticketed
  // screen. Veracode and Waltz configure it; email (no dedup, no Already-ticketed group) omits it.
  // Without it an already-ticketed row only offers re-create / leave.
  changeTracking?: ImportChangeTracking<TItem, TRow>;
  // Finding folding (KTD4): optional merge/unmerge/add support. An importer that omits it (email)
  // offers none of those replies. Both Veracode and Waltz items are groups, so combining items is
  // concatenation (KTD1).
  fold?: ImportFold<TItem, TRow>;
}

/** Finding folding (KTD1/KTD4): what an importer supplies so its New rows can be merged by the user. */
export interface ImportFold<TItem, TRow extends ReviewRowBase> {
  /** The row's group of findings or components. */
  itemOf: (row: TRow) => TItem;
  /** One item holding every member of `items`, in order. */
  combine: (items: TItem[]) => TItem;
  /** The record labels an `add` writes to the target ticket (no template labels: a foreign ticket is not ours to label). */
  recordLabelsOf: (item: TItem) => string[];
  /** The comment an `add` posts: the added item in the folded layout, plus findings a rewrite no longer covers. */
  buildComment: (item: TItem, droppedKeys: string[]) => string;
  /**
   * Optional: narrows a row's item to the findings its ticket did not record yet, for a rewrite's
   * traceability comment (Veracode keeps only the new flaws). Without it the whole item is listed.
   */
  narrowToNew?: (item: TItem, change: FindingsChange) => TItem;
}

type FindingsChange = Extract<RowChange, { kind: 'findings' }>;

/** Import ticket updates parity (KTD2): what an importer supplies so already-ticketed rows can be updated. */
export interface ImportChangeTracking<TItem, TRow extends ReviewRowBase> {
  /** What one finding is called in the Change column, e.g. 'flaw(s)' / 'CVE(s)'. */
  findingNoun: string;
  /** R1/R2/R4: what changed on an item, given the union of labels across all of its tickets; null = no change. */
  describe: (item: TItem, knownLabels: string[]) => RowChange | null;
  /** The record labels `update` adds to the target ticket: all of them for a baseline, only the new ones otherwise. */
  recordLabelsOf: (row: TRow, change: RowChange) => string[];
  /** KTD3: labels with this prefix are replaced, not accumulated, whenever `update` adds one (Waltz: `oss-rating-`). */
  removeLabelPrefix?: string;
  /** R11/R12: the one comment `update` posts — Markdown converted to Jira wiki markup, every report value sanitized. */
  buildUpdateComment: (row: TRow, change: FindingsChange, options: { summaryUnchanged: boolean }) => string;
  /**
   * R12: the ticket's new summary for this change, `null` when this summary cannot be rewritten (the
   * user renamed it — the comment then says so), or `undefined` when no rewrite applies.
   */
  rewriteSummary?: (summary: string, change: FindingsChange) => string | null | undefined;
  /** R14/KTD10: the follow-up ticket's summary and create-fields, covering only the new findings. */
  buildFollowUp: (
    row: TRow, change: FindingsChange, originalKey: string, additionalFields: Record<string, unknown>,
  ) => { summary: string; fields: Record<string, unknown> };
}

// U4: maps each importer's `descriptorKind` to its two JiraSessionKind literals — replaces the
// per-descriptor `templateTag`/`reviewTag` strings the ChatResult.metadata mechanism no longer
// needs (R1/R3). A plain object literal rather than a `${descriptorKind}-template` template-string
// cast keeps every kind spelled out as a literal JiraSessionKind, so a typo here is a compile error.
// Page size for the dedup search; fetchAllPages reads every page of each label chunk.
const DEDUP_PAGE_SIZE = 100;

const IMPORT_SESSION_KINDS: Record<ReportImportDescriptor<unknown, ReviewRowBase>['descriptorKind'], { template: JiraSessionKind; review: JiraSessionKind }> = {
  veracode: { template: 'veracode-template', review: 'veracode-review' },
  waltz: { template: 'waltz-template', review: 'waltz-review' },
  email: { template: 'email-template', review: 'email-review' },
};

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
  const allRows = buildReviewRows<TItem, TRow>(
    session.items,
    dedupMap,
    dedupKeyOf,
    item => descriptor.buildRowFields(item, templateLabels),
    descriptor.changeTracking,
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

  return streamImportReview(initImportViewState(reviewSession), stream, ws, descriptor, baseUrl);
}

/**
 * Streams the current step of the stepped stale close (stale-ticket target pick plan, KTD4): which
 * issue type to close (R12), which target (R1/R2), or which resolution (R4). Every choice is a
 * clickable reply, plus `Back` to the Stale screen with nothing transitioned (R5).
 */
export async function streamStaleCloseStep(
  close: StaleCloseSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  note?: string,
): Promise<vscode.ChatResult> {
  await ws.update(STALE_RESOLUTION_SESSION_KEY, close);
  const numbered = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${buildChatCommandLink(l, '@jira', String(i + 1))}`).join('\n');
  const back = `${buildChatCommandLink('Back', '@jira', 'back')} to return to the stale tickets without transitioning any`;
  const prefix = note ? `${note}\n\n` : '';
  let body: string;
  if (close.step === 'pick-issue-type') {
    body = 'The selected stale tickets span several issue types, and each run closes one. Which issue type do you want to close now?\n\n' +
      `${numbered(close.issueTypeOptions)}\n\nReply with the name or number, or ${back}.`;
  } else if (close.step === 'pick-target') {
    const selected = selectedCount(close);
    body = `Where should the **${selected}** selected stale **${close.issueType}** ticket(s) go?\n\n` +
      `${numbered(close.targetOptions!.map(formatStaleTargetOption))}\n\n` +
      `Cleanup rules (listed first) apply their own resolution. Reply with the name or number, or ${back}.`;
  } else {
    const options = close.reviewSession.staleTickets?.resolutionOptions ?? [];
    body = `The tickets will move to **${staleTargetState(close.target!)}** — which resolution should be set?\n\n${numbered(options)}\n\n` +
      `Reply with the name or number, ${buildChatCommandLink('None', '@jira', 'none')} to skip setting a resolution, or ${back}.`;
  }
  stream.markdown(trustedChatMarkdown(prefix + body));
  return { metadata: { jiraSession: { kinds: ['stale-resolution-selection'] } } };
}

function selectedCount(close: StaleCloseSession): number {
  const stale = close.reviewSession.staleTickets;
  const group = stale?.groups.find(g => g.issueType === close.issueType);
  return group ? selectedOpenStaleTickets(group, stale!.closedKeys).length : 0;
}

/**
 * Continues the stepped stale close with the user's reply to the current step: moves to the next
 * step, re-shows the same step on an unrecognized reply, returns to the Stale screen on `back`/
 * cancel (R5), or — once the target (and any resolution) is known — runs the transitions for the
 * chosen issue type and returns to the Stale screen or overview (KTD6).
 */
export async function continueStaleClose<TItem, TRow extends ReviewRowBase>(
  reply: string,
  close: StaleCloseSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  ticketService: TicketService,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  // A second, independent import may have started (and claimed the template-selection session key)
  // while this question was open.
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown('_A newer import was started while this one was waiting for an answer — cancelled to avoid transitioning tickets from a stale batch._');
    return;
  }

  const parked = ensureImportViewState(close.reviewSession as unknown as ReviewSession<TRow>);
  const backToStale = async () => {
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown('_No stale tickets were transitioned._\n\n');
    return streamImportReview({ ...parked, view: 'stale' }, stream, ws, descriptor, baseUrl);
  };
  const invalid = "_Didn't understand that — pick one of the options below._";

  if (close.step === 'pick-issue-type') {
    const pick = parseStaleIssueTypePick(reply, close.issueTypeOptions);
    if (pick === 'back') return backToStale();
    if (pick === 'invalid') return streamStaleCloseStep(close, stream, ws, invalid);
    return startTargetPick(pick, parked, close.issueTypeOptions, stream, ws, descriptor, baseUrl);
  }

  if (close.step === 'pick-target') {
    const pick = parseStaleTargetPick(reply, close.targetOptions ?? []);
    if (pick === 'back') return backToStale();
    if (pick === 'invalid') return streamStaleCloseStep(close, stream, ws, invalid);
    if (staleTargetNeedsResolution(pick, parked.staleTickets?.resolutionOptions ?? [])) {
      return streamStaleCloseStep({ ...close, step: 'pick-resolution', target: pick }, stream, ws);
    }
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    const resolution = pick.kind === 'rule' ? pick.resolution : undefined;
    return finishStaleClose(parked, close.issueType!, pick, resolution, ticketService, stream, ws, descriptor, baseUrl);
  }

  // pick-resolution: a resolution name (even "Cancelled") and "none"/"skip" (no resolution) are
  // matched before back/cancel words, which only go back when nothing else matched.
  const choice = parseResolutionSelection(reply, parked.staleTickets?.resolutionOptions ?? []);
  if (choice === 'invalid') {
    return isBackOrCancellation(reply) ? backToStale() : streamStaleCloseStep(close, stream, ws, invalid);
  }
  await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
  return finishStaleClose(parked, close.issueType!, close.target!, choice ?? undefined, ticketService, stream, ws, descriptor, baseUrl);
}

async function startTargetPick<TItem, TRow extends ReviewRowBase>(
  issueType: string,
  session: ReviewSession<TRow>,
  issueTypeOptions: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  const stale = session.staleTickets!;
  const group = stale.groups.find(g => g.issueType === issueType)!;
  const selectedStatuses = selectedOpenStaleTickets(group, stale.closedKeys).map(t => t.currentStatus);
  const targetOptions = buildStaleTargetOptions(group.rules, group.graph, selectedStatuses);
  if (targetOptions.length === 0) {
    // Plan review fix: an empty pick list would strand the user on a question with nothing to pick.
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown(
      `_The selected **${issueType}** tickets can't reach any status in the discovered workflow, and no cleanup rule matches. ` +
      `Run \`@jira discover workflow ${session.projectKey} ${issueType}\` to refresh the workflow cache. No stale tickets were transitioned._\n\n`,
    );
    return streamImportReview({ ...session, view: 'stale' }, stream, ws, descriptor, baseUrl);
  }
  const close: StaleCloseSession = {
    descriptorKind: descriptor.descriptorKind as 'veracode' | 'waltz',
    step: 'pick-target',
    issueTypeOptions,
    issueType,
    targetOptions,
    reviewSession: session as unknown as VeracodeReviewSession | WaltzReviewSession,
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  return streamStaleCloseStep(close, stream, ws);
}

async function finishStaleClose<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  issueType: string,
  target: StaleTargetOption,
  resolution: string | undefined,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  const updated = await runStaleTransitions(session, issueType, staleTargetState(target), resolution, ticketService, stream, descriptor);
  // KTD6: while tickets of another issue type are still selected, stay on the Stale screen.
  const next = selectedStaleIssueTypes(updated.staleTickets!).length > 0 ? { ...updated, view: 'stale' as const } : afterGroupAction(updated);
  return streamImportReview(next, stream, ws, descriptor, baseUrl);
}

function screenOptions<TItem, TRow extends ReviewRowBase>(descriptor: ReportImportDescriptor<TItem, TRow>, baseUrl?: string): ImportScreenOptions {
  return { baseUrl, itemNoun: descriptor.itemNoun, findingNoun: descriptor.changeTracking?.findingNoun, canFold: descriptor.fold !== undefined };
}

/** R10: after a group action, back to the overview — or the same group when there is no overview. */
function afterGroupAction<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
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

/**
 * Creates one ticket for a row — its full ticket (`buildTicketFields`) unless `built` supplies other
 * content (a follow-up's subset). Streams a ✓/✗ progress line; a failure is caught and returned.
 */
async function createOne<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
  built?: { summary: string; fields: Record<string, unknown> },
): Promise<{ key: string } | { error: string }> {
  const { summary: ticketSummary, fields } = built ?? descriptor.buildTicketFields(row, session.additionalFields);
  try {
    const createdTicket = await ticketService.createTicket(session.projectKey, ticketSummary, session.issueType, fields, baseUrl);
    stream.markdown(`✓ ${formatKeyLink(createdTicket.key, baseUrl)} — ${ticketSummary}\n\n`);
    // KTD4 (import consolidation): optional per-row post-creation work (email uses this for
    // attachment upload). A rejection is shown as a warning but never fails the row — the ticket
    // already exists.
    if (descriptor.afterCreate) {
      try {
        await descriptor.afterCreate(row, createdTicket.key, ticketService);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag(descriptor.scope, 'warn', `Post-creation step failed — ${createdTicket.key}`, { issueKey: createdTicket.key, error: message });
        stream.markdown(`_Warning: ${message}_\n\n`);
      }
    }
    return { key: createdTicket.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ref = descriptor.itemRefFor(row);
    logDiag(descriptor.scope, 'error', `Ticket creation failed — ${ref}`, { ref, error: message });
    stream.markdown(`✗ ${ref} — ${message}\n\n`);
    return { error: message };
  }
}

/**
 * R7/R13/R15 (KTD3/KTD4): creates the included new rows on the visible page — at most
 * `BATCH_LIMIT`, which one page never exceeds. Rows excluded on this page are first written into
 * `allRows` so they stay excluded afterwards; successfully created rows then leave `allRows`, so a
 * repeated "create tickets" can never create them twice. Failed rows stay, still included.
 */
export async function createNewRows<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const pageFresh = session.rows.filter(r => r.existingTicketKey === null);
  const toCreate = pageFresh.filter(r => r.included).slice(0, BATCH_LIMIT);
  // A merged row stands for all of its member rows in `allRows` (KTD3).
  const memberIdsOf = (r: TRow) => r.memberIds ?? [r.id];
  const excludedIds = new Set(pageFresh.filter(r => !r.included).flatMap(memberIdsOf));
  if (toCreate.length === 0) {
    stream.markdown('_Nothing selected — no tickets were created._\n\n');
    return session;
  }

  stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);
  const createdIds = new Set<string>();
  let failed = 0;
  for (const row of toCreate) {
    const outcome = await createOne(row, session, ticketService, stream, descriptor, baseUrl);
    if ('key' in outcome) memberIdsOf(row).forEach(id => createdIds.add(id)); else failed++;
  }

  const created = createdIds.size;
  stream.markdown(
    `${pageFresh.length} ${descriptor.itemNoun} on this page — **${created}** created, ${failed} failed, ${excludedIds.size} excluded by you.\n\n`,
  );
  logDiag(descriptor.scope, failed > 0 ? 'warn' : 'info', `${descriptor.importLabel} import — ${created} created, ${failed} failed`, {
    created, failed, excludedByUser: excludedIds.size,
  });

  const allRows = session.allRows
    .filter(r => !(r.existingTicketKey === null && createdIds.has(r.id)))
    .map(r => (r.existingTicketKey === null && excludedIds.has(r.id) ? { ...r, included: false } : r));
  const page = buildReviewPage(allRows, session.page);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    allRows,
    rows: page.rows,
    page: page.page,
    outcomes: { ...outcomes, created: outcomes.created + created, createFailed: outcomes.createFailed + failed },
  };
}

// --- Add rows to an existing ticket (finding folding, KTD5-KTD7) ------------------------------------

type AddTargetIssue = Awaited<ReturnType<TicketService['getIssue']>>;

/**
 * KTD6: what writing to ticket `key` involves — the findings its description would be rebuilt from
 * (the added rows plus the Already-ticketed rows whose target it is, the ticket's own rows first)
 * and the findings it records that none of those cover, which a rewrite drops and says so.
 */
function planRewrite<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  key: string,
  issueLabels: string[],
  extraRows: TRow[],
): { regenItem: TItem; droppedKeys: string[] } {
  const fold = descriptor.fold!;
  const ticketRows = session.allRows.filter(r => r.existingTicketKey === key);
  const regenItem = fold.combine([...ticketRows, ...extraRows].map(fold.itemOf));
  const covered = new Set(descriptor.dedupKeyOf?.(regenItem) ?? []);
  const recorded = issueLabels.map(l => descriptor.labelToDedupKey?.(l) ?? null).filter((k): k is string => k !== null);
  return { regenItem, droppedKeys: [...new Set(recorded.filter(k => !covered.has(k)))] };
}

/** KTD7: rebuilds `key` from `regenItem` — the importer's own summary, description and labels (no template labels) — in one write. */
async function writeRewrite<TItem, TRow extends ReviewRowBase>(
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  key: string,
  regenItem: TItem,
): Promise<void> {
  const fields = descriptor.buildRowFields(regenItem, []);
  const built = descriptor.buildTicketFields({ ...fields, id: '0', existingTicketKey: null, included: true } as unknown as TRow, {});
  await ticketService.rewriteTicket(key, {
    summary: built.summary,
    description: String(built.fields.description ?? ''),
    labelsToAdd: (built.fields.labels as string[] | undefined) ?? [],
    removePrefix: descriptor.changeTracking?.removeLabelPrefix,
  });
}

/** The visible New rows an add names, or null (with a message) when the page no longer holds them. */
function rowsToAdd<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, ids: string[], stream: vscode.ChatResponseStream): TRow[] | null {
  const rows = session.rows.filter(r => r.existingTicketKey === null && ids.includes(r.id));
  if (rows.length !== ids.length) {
    stream.markdown("_Those rows are no longer on this page, so nothing was added._\n\n");
    return null;
  }
  return rows;
}

/** Step one of `add … to <KEY>` (KTD5): reads the ticket and shows the warnings and the two mode links. Writes nothing. */
async function showAddPrompt<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const rows = rowsToAdd(session, ids, stream);
  if (!rows) return;
  let issue: AddTargetIssue;
  try {
    issue = await ticketService.getIssue(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Could not read the target ticket — ${key}`, { issueKey: key, error: message });
    stream.markdown(`✗ ${key} — ${message}\n\n`);
    return;
  }
  const { droppedKeys } = planRewrite(session, descriptor, key, issue.fields.labels ?? [], rows);
  stream.markdown(trustedChatMarkdown(buildAddPrompt({
    key, summary: issue.fields.summary ?? '', status: issue.fields.status?.name ?? null,
    resolved: issue.fields.resolution != null, ids, rowCount: rows.length, droppedKeys, baseUrl,
  })));
}

/**
 * Step two of `add … to <KEY>` (KTD5-KTD7): Comment adds the record labels and posts a comment listing
 * the added findings; Rewrite rebuilds summary, description and labels and then posts that comment
 * plus any dropped findings. A failed write keeps the rows in New; a comment that fails after the
 * write is reported and the rows still leave New, because their findings are now recorded.
 */
async function addToTicket<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ids: string[],
  key: string,
  mode: AddMode,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const rows = rowsToAdd(session, ids, stream);
  if (!rows) return session;
  const fold = descriptor.fold!;
  const link = formatKeyLink(key, baseUrl);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  const failWith = (message: string): ReviewSession<TRow> => {
    logDiag(descriptor.scope, 'error', `Add to existing ticket failed — ${key}`, { issueKey: key, mode, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { ...session, outcomes: { ...outcomes, addFailed: outcomes.addFailed + rows.length } };
  };

  let comment: string;
  try {
    const issue = await ticketService.getIssue(key);
    const labels = issue.fields.labels ?? [];
    const addedItem = fold.combine(rows.map(fold.itemOf));
    const plan = planRewrite(session, descriptor, key, labels, rows);
    const ratingPrefix = descriptor.changeTracking?.removeLabelPrefix;
    if (mode === 'comment') {
      // A rating label already on the ticket is left alone: a comment must not change its rating.
      const recordLabels = fold.recordLabelsOf(addedItem);
      const toAdd = ratingPrefix && labels.some(l => l.startsWith(ratingPrefix))
        ? recordLabels.filter(l => !l.startsWith(ratingPrefix)) : recordLabels;
      await ticketService.updateLabels(key, toAdd);
      comment = fold.buildComment(addedItem, []);
    } else {
      await writeRewrite(ticketService, descriptor, key, plan.regenItem);
      comment = fold.buildComment(addedItem, plan.droppedKeys);
    }
  } catch (err) {
    return failWith(err instanceof Error ? err.message : String(err));
  }

  let commentFailed: string | null = null;
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (err) {
    commentFailed = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Added to ticket but the comment failed — ${key}`, { issueKey: key, mode, error: commentFailed });
  }
  const done = mode === 'comment' ? 'labels added and comment posted' : 'rewritten and comment posted';
  stream.markdown(commentFailed
    ? `⚠ ${link} — ${mode === 'comment' ? 'labels added' : 'rewritten'}, comment failed: ${commentFailed}\n\n`
    : `✓ ${link} — ${done}\n\n`);
  logDiag(descriptor.scope, commentFailed ? 'warn' : 'info', `${descriptor.importLabel} import — ${rows.length} row(s) added to ${key} (${mode})`, { issueKey: key, mode });

  // The added rows leave New. Other rows on the page (merged ones included) are left as they are.
  const gone = new Set(rows.flatMap(r => r.memberIds ?? [r.id]));
  const isGone = (r: TRow) => r.existingTicketKey === null && gone.has(r.id);
  return {
    ...session,
    allRows: session.allRows.filter(r => !isGone(r)),
    rows: session.rows.filter(r => !(r.existingTicketKey === null && ids.includes(r.id))),
    outcomes: { ...outcomes, added: outcomes.added + rows.length },
  };
}

/**
 * "close tickets" on the Stale screen (stale-ticket target pick plan, R1/R12): with nothing
 * selected, says so; with several issue types selected, asks which one to close now; otherwise
 * goes straight to the target pick for the one selected issue type. Nothing transitions until the
 * target (and any resolution) is picked.
 */
async function closeStaleTickets<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  const issueTypes = session.staleTickets ? selectedStaleIssueTypes(session.staleTickets) : [];
  if (issueTypes.length === 0) {
    stream.markdown('_Nothing selected — no stale tickets were closed._\n\n');
    return streamImportReview(session, stream, ws, descriptor, baseUrl);
  }
  await ws.update(descriptor.sessionKeys.review, session);
  if (issueTypes.length > 1) {
    const close: StaleCloseSession = {
      descriptorKind: descriptor.descriptorKind as 'veracode' | 'waltz',
      step: 'pick-issue-type',
      issueTypeOptions: issueTypes,
      reviewSession: session as unknown as VeracodeReviewSession | WaltzReviewSession,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    return streamStaleCloseStep(close, stream, ws);
  }
  return startTargetPick(issueTypes[0], session, issueTypes, stream, ws, descriptor, baseUrl);
}

/**
 * Transitions the chosen issue type's selected, not-yet-transitioned stale tickets to `targetState`
 * through cleanupHandler.ts's shared `transitionTickets()`, with paths computed from the group's
 * stored workflow graph (KTD2). A ticket already there or with no path is skipped with a note and
 * deselected (R11); transitioned tickets are marked so they are never transitioned again.
 */
async function runStaleTransitions<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  issueType: string,
  targetState: string,
  resolution: string | undefined,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const stale = session.staleTickets;
  const group = stale?.groups.find(g => g.issueType === issueType);
  if (!stale || !group) return session;
  const closed = stale.closedKeys ?? [];
  const { runnable, skipped } = planStaleTransitions(group, targetState, closed);
  stream.markdown(`_Transitioning ${runnable.length} stale **${issueType}** ticket(s) to **${targetState}**…_\n\n`);

  const result = runnable.length > 0
    ? await transitionTickets(runnable, ticketService, resolution, descriptor.scope)
    : { failures: [] as Array<{ key: string; reason: string }> };
  const failedKeys = new Set(result.failures.map(f => f.key));
  const newlyClosed = runnable.filter(t => !failedKeys.has(t.key)).map(t => t.key);
  const failedTickets = runnable.length - newlyClosed.length;

  let summary = `**${newlyClosed.length}** stale ticket(s) transitioned to **${targetState}**, ${failedTickets} failed` +
    (skipped.length > 0 ? `, ${skipped.length} skipped.` : '.');
  if (skipped.length > 0) summary += '\n\n' + skipped.map(s => `– ${s.key} skipped — ${s.reason}`).join('\n');
  if (result.failures.length > 0) {
    summary += '\n\n' + result.failures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
    summary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
  }
  stream.markdown(`${summary}\n\n`);
  logDiag(descriptor.scope, result.failures.length > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} stale-ticket close — ${newlyClosed.length} transitioned to ${targetState}, ${failedTickets} failed, ${skipped.length} skipped`,
    { issueType, targetState, transitioned: newlyClosed.length, failed: failedTickets, skipped: skipped.length },
  );

  const skippedKeys = new Set(skipped.map(s => s.key));
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    staleTickets: {
      ...stale,
      groups: stale.groups.map(g => (g !== group ? g : {
        ...g,
        tickets: g.tickets.map(t => (skippedKeys.has(t.key) ? { ...t, included: false } : t)),
      })),
      closedKeys: [...closed, ...newlyClosed],
    },
    outcomes: { ...outcomes, closed: outcomes.closed + newlyClosed.length, closeFailed: outcomes.closeFailed + failedTickets },
  };
}

/** KTD5/KTD7: which row actions each Already-ticketed run reply runs, and the word to repeat for the rest. */
const TICKETED_RUNS: Record<'apply' | 'update' | 'recreate', { actions: ReadonlySet<TicketedAction>; command: string }> = {
  apply: { actions: new Set<TicketedAction>(['update', 'follow-up', 'rewrite', 're-create']), command: 'apply' },
  update: { actions: new Set<TicketedAction>(['update']), command: 'update tickets' },
  recreate: { actions: new Set<TicketedAction>(['re-create']), command: 're-create tickets' },
};

// Bounded concurrency for `update` rows (label write + comment per row) — a report with a few
// hundred already-ticketed rows would otherwise turn one reply into that many sequential round trips.
const UPDATE_CONCURRENCY = 8;

/**
 * Import ticket updates parity (KTD5, R9-R16): runs the already-ticketed rows whose action is in
 * `actions` (every non-`leave` action for `apply`, one action for a shortcut) — at most
 * `BATCH_LIMIT` per reply, the rest stay pending and the reply says how many remain. `update` rows
 * run with bounded concurrency; `follow-up` and `re-create` rows are created one at a time through
 * the same creation step as New rows. Each row records its own result, one row failing never stops
 * the others, and a finished row is never run again.
 */
export async function executeTicketedActions<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  actions: ReadonlySet<TicketedAction>,
  command: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  // KTD11: rewrite rebuilds a whole ticket, so it is all-or-none per target. Checked before anything
  // is written; a violation stops the whole apply.
  if (actions.has('rewrite')) {
    const partial = findPartialRewrites(session.allRows);
    if (partial.length > 0) {
      const detail = partial.map(p => `${p.key}: ${p.rewriteIds.join(', ')} ${p.rewriteIds.length === 1 ? 'is' : 'are'} on rewrite but ${p.otherIds.join(', ')} ${p.otherIds.length === 1 ? 'is' : 'are'} not`).join('; ');
      stream.markdown(`_Nothing was written. Rewrite rebuilds a whole ticket, so it must cover all the rows that point to it or none of them (${detail}). Use \`all rewrite\`, or set the others to another action._\n\n`);
      return session;
    }
  }

  const candidates = session.allRows.filter(r => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return false;
    const { action } = ticketedRowActions(r);
    return action !== 'leave' && actions.has(action);
  });
  if (candidates.length === 0) {
    stream.markdown(command === 'apply'
      ? '_Nothing to apply — every row is set to leave or already done._\n\n'
      : `_Nothing to apply — no row is set to \`${[...actions][0]}\`._\n\n`);
    return session;
  }

  // At most BATCH_LIMIT rows run per reply, but the rows of one ticket's rewrite run together or not
  // at all (KTD11); a single group larger than the cap still runs whole.
  const units = new Map<string, TRow[]>();
  for (const r of candidates) {
    const unit = ticketedRowActions(r).action === 'rewrite' ? `rewrite:${ticketedTargetKey(r)}` : `row:${r.id}`;
    units.set(unit, [...(units.get(unit) ?? []), r]);
  }
  const toRun: TRow[] = [];
  for (const unit of units.values()) {
    if (toRun.length > 0 && toRun.length + unit.length > BATCH_LIMIT) break;
    toRun.push(...unit);
  }
  const remaining = candidates.length - toRun.length;
  stream.markdown(`_Applying ${toRun.length} action(s)…_\n\n`);

  const results = new Map<string, TicketedRowResult>();
  const updates = toRun.filter(r => ticketedRowActions(r).action === 'update');
  const creations = toRun.filter(r => ['follow-up', 're-create'].includes(ticketedRowActions(r).action));
  const rewriteGroups = new Map<string, TRow[]>();
  for (const r of toRun.filter(r => ticketedRowActions(r).action === 'rewrite')) {
    const key = ticketedTargetKey(r);
    rewriteGroups.set(key, [...(rewriteGroups.get(key) ?? []), r]);
  }
  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    const batch = updates.slice(i, i + UPDATE_CONCURRENCY);
    await Promise.all(batch.map(async row => {
      results.set(row.id, await updateTicketedRow(row, ticketService, stream, descriptor, baseUrl));
    }));
  }
  for (const row of creations) {
    results.set(row.id, await createForTicketedRow(row, session, ticketService, stream, descriptor, baseUrl));
  }
  let rewrittenTickets = 0;
  let rewriteFailedTickets = 0;
  for (const [key, rows] of rewriteGroups) {
    const result = await rewriteTicketedGroup(rows, key, session, ticketService, stream, descriptor, baseUrl);
    for (const row of rows) results.set(row.id, result);
    if (result.status === 'done') rewrittenTickets++; else rewriteFailedTickets++;
  }

  const all = [...results.values()];
  const count = (action: TicketedAction, status: 'done' | 'failed') => all.filter(r => r.action === action && r.status === status).length;
  const upToDate = all.filter(r => r.status === 'done' && r.action === 'update' && r.note === 'up-to-date').length;
  const updated = count('update', 'done') - upToDate;
  const followedUp = count('follow-up', 'done');
  const recreated = count('re-create', 'done');
  const updateFailed = count('update', 'failed');
  const followUpFailed = count('follow-up', 'failed');
  const recreateFailed = count('re-create', 'failed');
  const failed = updateFailed + followUpFailed + recreateFailed + rewriteFailedTickets;

  let summary = `**${updated}** updated, ${followedUp} follow-up(s) created, ${recreated} re-created` +
    (rewrittenTickets > 0 ? `, ${rewrittenTickets} rewritten` : '') +
    (upToDate > 0 ? `, ${upToDate} already up to date` : '') + `, ${failed} failed.`;
  if (remaining > 0) {
    summary += ` _${remaining} remain — capped at ${BATCH_LIMIT} actions per reply; reply \`${command}\` again to run them._`;
  }
  stream.markdown(`${summary}\n\n`);
  logDiag(descriptor.scope, failed > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} already-ticketed actions — ${updated} updated, ${followedUp} follow-ups, ${recreated} re-created, ${failed} failed`,
    { command, updated, upToDate, followedUp, recreated, rewritten: rewrittenTickets, updateFailed, followUpFailed, recreateFailed, rewriteFailed: rewriteFailedTickets, remaining },
  );

  const mark = (r: TRow): TRow => {
    const result = results.get(r.id);
    return result && r.existingTicketKey !== null ? { ...r, result } : r;
  };
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    allRows: session.allRows.map(mark),
    rows: session.rows.map(mark),
    outcomes: {
      ...outcomes,
      updated: outcomes.updated + updated,
      updateFailed: outcomes.updateFailed + updateFailed,
      followedUp: outcomes.followedUp + followedUp,
      followUpFailed: outcomes.followUpFailed + followUpFailed,
      recreated: outcomes.recreated + recreated,
      recreateFailed: outcomes.recreateFailed + recreateFailed,
      rewritten: outcomes.rewritten + rewrittenTickets,
      rewriteFailed: outcomes.rewriteFailed + rewriteFailedTickets,
    },
  };
}

/**
 * Finding folding (KTD6/KTD7/KTD11): `rewrite` on one target ticket, for every unfinished row that
 * points to it — the ticket's summary, description and labels are rebuilt from all rows that point
 * to it, then one comment names the findings its tickets did not record yet and any it recorded
 * that the rebuilt description no longer covers. A failed write leaves the ticket as it was; a
 * comment that fails afterwards is reported but the rewrite stands.
 */
async function rewriteTicketedGroup<TItem, TRow extends ReviewRowBase>(
  rows: TRow[],
  key: string,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  const fold = descriptor.fold;
  const link = formatKeyLink(key, baseUrl);
  let comment: string;
  try {
    if (!fold) throw new Error('rewrite is not available for this import');
    const issue = await ticketService.getIssue(key);
    const added = rows.flatMap(r => {
      const change = r.change;
      if (change?.kind !== 'findings' || change.newIds.length === 0) return [];
      const item = fold.itemOf(r);
      return [fold.narrowToNew ? fold.narrowToNew(item, change) : item];
    });
    const addedItem = fold.combine(added);
    const plan = planRewrite(session, descriptor, key, issue.fields.labels ?? [], []);
    await writeRewrite(ticketService, descriptor, key, plan.regenItem);
    comment = fold.buildComment(addedItem, plan.droppedKeys);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Rewrite of existing ticket failed — ${key}`, { issueKey: key, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { status: 'failed', action: 'rewrite', error: message };
  }
  try {
    await ticketService.addComment(key, comment, baseUrl);
  } catch (commentErr) {
    const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
    logDiag(descriptor.scope, 'warn', `Rewritten but the comment failed — ${key}`, { issueKey: key, error: message });
    stream.markdown(`⚠ ${link} — rewritten, but the comment could not be posted: ${message}\n\n`);
    return { status: 'done', action: 'rewrite', note: 'comment-failed' };
  }
  stream.markdown(`✓ ${link} — rewritten from ${rows.length} row(s)\n\n`);
  return { status: 'done', action: 'rewrite' };
}

/**
 * R11-R13: `update` on one row — one read-merge-write of the target ticket's record labels (plus
 * the rewritten summary on a rating rise), then one comment listing the change. A baseline row only
 * gets its record labels. A comment failure after the labels were written is reported as such (the
 * labels are not undone), and a ticket that already carries everything is left untouched.
 */
async function updateTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  const tracking = descriptor.changeTracking;
  const change = row.change;
  const ticketKey = ticketedTargetKey(row);
  const link = formatKeyLink(ticketKey, baseUrl);
  try {
    if (!tracking || !change) throw new Error('nothing to update on this row');
    const labels = tracking.recordLabelsOf(row, change);
    const prefix = tracking.removeLabelPrefix;
    const removePrefix = prefix && labels.some(l => l.startsWith(prefix)) ? prefix : undefined;
    const findings = change.kind === 'findings' ? change : null;
    const rewriteSummary = findings && tracking.rewriteSummary
      ? (summary: string) => tracking.rewriteSummary!(summary, findings)
      : undefined;
    const written = await ticketService.updateLabels(ticketKey, labels, { removePrefix, rewriteSummary });

    if (!findings) {
      stream.markdown(`✓ ${link} — baseline recorded\n\n`);
      return { status: 'done', action: 'update', note: 'baseline' };
    }
    if (written.added.length === 0 && written.removed.length === 0 && !written.summaryRewritten) {
      stream.markdown(`– ${link} — already up to date\n\n`);
      return { status: 'done', action: 'update', note: 'up-to-date' };
    }
    try {
      await ticketService.addComment(ticketKey, tracking.buildUpdateComment(row, findings, { summaryUnchanged: written.summaryUnchanged }), baseUrl);
    } catch (commentErr) {
      const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
      logDiag(descriptor.scope, 'warn', `Labels updated but comment failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
      stream.markdown(`⚠ ${link} — labels updated but the comment could not be posted: ${message}\n\n`);
      return { status: 'done', action: 'update', note: 'comment-failed' };
    }
    stream.markdown(`✓ ${link} — updated\n\n`);
    return { status: 'done', action: 'update' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Update of existing ticket failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
    stream.markdown(`✗ ${link} — ${message}\n\n`);
    return { status: 'failed', action: 'update', error: message };
  }
}

/**
 * R14/R15: `re-create` creates the row's full ticket as for a New row; `follow-up` creates a ticket
 * with only the new findings and links it "Relates" to the target ticket. A failed link keeps the
 * ticket, warns and logs (AE5).
 */
async function createForTicketedRow<TItem, TRow extends ReviewRowBase>(
  row: TRow,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<TicketedRowResult> {
  if (ticketedRowActions(row).action === 're-create') {
    const created = await createOne(row, session, ticketService, stream, descriptor, baseUrl);
    return 'key' in created
      ? { status: 'done', action: 're-create', key: created.key }
      : { status: 'failed', action: 're-create', error: created.error };
  }

  const change = row.change;
  const tracking = descriptor.changeTracking;
  const originalKey = ticketedTargetKey(row);
  if (!tracking || change?.kind !== 'findings' || change.newIds.length === 0) {
    const error = 'no new findings for a follow-up';
    stream.markdown(`✗ ${descriptor.itemRefFor(row)} — ${error}\n\n`);
    return { status: 'failed', action: 'follow-up', error };
  }
  let built: { summary: string; fields: Record<string, unknown> };
  try {
    built = tracking.buildFollowUp(row, change, originalKey, session.additionalFields);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Could not build follow-up — ${descriptor.itemRefFor(row)}`, { originalKey, error });
    stream.markdown(`✗ ${descriptor.itemRefFor(row)} — ${error}\n\n`);
    return { status: 'failed', action: 'follow-up', error };
  }
  const created = await createOne(row, session, ticketService, stream, descriptor, baseUrl, built);
  if (!('key' in created)) return { status: 'failed', action: 'follow-up', error: created.error };

  try {
    await ticketService.linkIssues(created.key, originalKey);
    return { status: 'done', action: 'follow-up', key: created.key };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'warn', `Follow-up created but not linked — ${created.key}`, {
      issueKey: created.key, relatesTo: originalKey, error: message,
    });
    stream.markdown(`⚠ ${formatKeyLink(created.key, baseUrl)} was created but could not be linked to ${originalKey}: ${message}\n\n`);
    return { status: 'done', action: 'follow-up', key: created.key, linkMissing: true };
  }
}
