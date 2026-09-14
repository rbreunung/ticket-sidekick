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
  MAX_REPORT_BYTES, BATCH_LIMIT, DEFAULT_DEDUP_CHUNK_SIZE, findAlreadyTicketed, buildReviewRows,
  buildDedupJql, findStaleTickets, type JqlIssueLike,
} from '../../utils/reportImport';
import {
  isCancellation, pickEmailOption, buildImportReviewTable, buildStaleReviewSection,
  parseReviewInput, parseReviewPageNav, parseStaleTicketToggle, applyStaleTicketToggle,
  parseResolutionSelection, buildReviewPage, applyReviewSessionToggle,
  isUpdateExistingTicketsReply, markRowsUpdatedExisting,
  CURRENT_SESSION_SCHEMA_VERSION, isSessionExpired, SESSION_EXPIRED_MESSAGE,
  NO_ISSUE_TYPE, resolveTemplateIssueType, formatIssueTypeOptionLabel, buildChatCommandLink,
  type ImportTemplateSelectionSession, type ReviewSession, type ReviewTableColumn, type ReviewRowBase,
  type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession, type JiraSessionKind,
  type VeracodeReviewSession, type WaltzReviewSession, type StaleResolutionAskSession,
  type StaleTicketGroup,
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
  // A rejection is caught by executeImportBatch and shown as a warning — it never fails the row,
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
  // U3: optional "update existing tickets" bulk action (R13) — an importer with no folded-group/
  // multi-id concept (Waltz, email — each item maps to exactly one ticket, so there is never a
  // "new finding on an already-ticketed line" case) omits this and the reply keyword/table column/
  // footer hint never appear for it, exactly like `stale` above. Only Veracode configures it today.
  updateExisting?: {
    // Every candidate id this row's finding group covers (e.g. a folded Veracode group's member
    // flaw ids) — the full set, not just the new ones; executeUpdateExistingTickets() diffs this
    // against the ticket's own current labels to find what's missing.
    idsOf: (row: TRow) => string[];
    // Maps one id to the Jira label that represents it on a ticket (e.g. `veracode-issue-<id>`).
    labelOf: (id: string) => string;
    // Builds the summarizing comment body for only the ids newly added this run (`newIds` — a
    // subset of idsOf(row), not the row's whole group) as Markdown converted to Jira wiki markup —
    // see buildNewFindingsCommentWiki()'s own doc comment for the sanitize-then-convert contract
    // this MUST follow (addComment() sends its body to Jira verbatim, no sanitization of its own).
    buildCommentWiki: (row: TRow, newIds: string[]) => string;
  };
}

// U4: maps each importer's `descriptorKind` to its two JiraSessionKind literals — replaces the
// per-descriptor `templateTag`/`reviewTag` strings the ChatResult.metadata mechanism no longer
// needs (R1/R3). A plain object literal rather than a `${descriptorKind}-template` template-string
// cast keeps every kind spelled out as a literal JiraSessionKind, so a typo here is a compile error.
const IMPORT_SESSION_KINDS: Record<ReportImportDescriptor<unknown, ReviewRowBase>['descriptorKind'], { template: JiraSessionKind; review: JiraSessionKind }> = {
  veracode: { template: 'veracode-template', review: 'veracode-review' },
  waltz: { template: 'waltz-template', review: 'waltz-review' },
  email: { template: 'email-template', review: 'email-review' },
};

/**
 * Shared read+parse+filter orchestration (stat + size cap, then parse + filter). The two importers
 * differ only in how the file is read (utf-8 string for Veracode's XML, Buffer for Waltz's xlsx) and
 * in their own parse/filter functions — those differences are supplied by the caller, not
 * re-implemented here.
 */
export async function readAndFilterReport<TRaw, TItem>(
  filePath: string,
  readContent: (filePath: string) => Promise<TRaw>,
  parse: (raw: TRaw) => TItem[] | Promise<TItem[]>,
  filter: (items: TItem[]) => TItem[],
  maxBytes: number = MAX_REPORT_BYTES,
): Promise<TItem[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes / (1024 * 1024)} MB size limit.`);
  }
  const raw = await readContent(filePath);
  const items = await parse(raw);
  return filter(items);
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
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];

  // KTD2: dedup is optional — an importer that omits searchLabelOf/dedupKeyOf/labelToDedupKey (email)
  // has no per-item dedup key, so the "already ticketed" search is skipped entirely rather than run
  // and found empty. dedupMap stays empty, so every item is treated as new below.
  let dedupMap: Map<string, string> = new Map();
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
        chunk => ticketService.searchTicketsRaw(buildDedupJql(session.projectKey, chunk), 100).then(r => r.issues as JqlIssueLike[]),
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
        // no second fetch keyed by the returned stale keys.
        for (const issue of result.issues) {
          issueDetails.set(issue.key, {
            summary: String((issue.fields as { summary?: unknown }).summary ?? ''),
            currentStatus: (issue.fields as { status?: { name: string } }).status?.name ?? '',
            issueType: (issue.fields as { issuetype?: { name: string } }).issuetype?.name ?? '',
          });
        }
        return result as { issues: JqlIssueLike[]; total?: number; isLast?: boolean };
      },
      descriptor.stale.labelToDedupKey,
      descriptor.stale.buildActivePredicate(session.rawItems ?? []),
      (level, message, details) => logDiag(descriptor.scope, level, message, details),
    );

    if (staleResult.searchFailed) {
      stream.markdown('_Warning: could not check for stale tickets — proceeding without a stale-ticket section._\n\n');
    } else if (staleResult.stale.length > 0) {
      if (staleResult.truncated) {
        stream.markdown(`_Found ${staleResult.totalFound} possibly-stale ticket(s) — showing the first ${staleResult.stale.length}._\n\n`);
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const grouped = await buildStaleTicketGroups(staleResult.stale, issueDetails, session.projectKey, jiraClient, workspaceRoot);

      if (grouped.pendingGroups.length > 0) {
        // R1/KTD15: descriptorKind is always 'veracode'/'waltz' here — email never sets
        // descriptor.stale, so this branch is unreachable for it (erasure cast mirrors the one a
        // few lines up for AwaitIssueTypeResume's own resumeSession).
        const ask: StaleResolutionAskSession = {
          descriptorKind: descriptor.descriptorKind as 'veracode' | 'waltz',
          pendingGroups: grouped.pendingGroups,
          resolvedGroups: grouped.resolvedGroups,
          ineligible: grouped.ineligible,
          reviewSession: reviewSession as unknown as VeracodeReviewSession | WaltzReviewSession,
          schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
        };
        return streamStaleResolutionAsk(ask, stream, ws);
      }

      reviewSession = { ...reviewSession, staleTickets: { groups: grouped.resolvedGroups, ineligible: grouped.ineligible } };
    }
  }

  return streamImportReview(reviewSession, stream, ws, descriptor, baseUrl);
}

/**
 * U6: streams the stale-ticket batch's chained per-issue-type-group resolution ask — one group at a
 * time (`ask.pendingGroups[0]`), mirroring `ResolutionSelectionSession`/cleanupHandler.ts's own
 * numbered resolution pick (not the generic free-text `streamAwaitIssueType` prompt — see
 * `StaleResolutionAskSession`'s own doc comment in sessionState.ts for why).
 */
export async function streamStaleResolutionAsk(
  ask: StaleResolutionAskSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(STALE_RESOLUTION_SESSION_KEY, ask);
  const group = ask.pendingGroups[0];
  const list = group.resolutionOptions.map((r, i) => `${i + 1}. ${buildChatCommandLink(r, '@jira', String(i + 1))}`).join('\n');
  stream.markdown(trustedChatMarkdown(
    `**${group.tickets.length}** stale **${group.issueType}** ticket(s) can move to **${group.targetState}** — ` +
    `which resolution should be set?\n\n${list}\n\n` +
    `Reply with the name or number, or ${buildChatCommandLink('None', '@jira', 'none')} to skip setting a resolution.`,
  ));
  return { metadata: { jiraSession: { kinds: ['stale-resolution-selection'] } } };
}

/**
 * Continues the chained stale-resolution ask once a reply for the currently-asked group comes in —
 * either re-prompting the same group (invalid reply), moving on to the next pending group, or (once
 * every group is resolved) merging the accumulated `staleTickets` into the parked review session and
 * streaming the merged review screen (KTD10-15's "chain the ask once per group, not once per
 * ticket" rule).
 */
export async function continueAfterStaleResolution<TItem, TRow extends ReviewRowBase>(
  reply: string,
  ask: StaleResolutionAskSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  // Mirrors handleVeracodeAwaitIssueType/handleWaltzAwaitIssueType's own guard: a second, independent
  // import may have started (and claimed the template-selection session key) while this ask was open.
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown('_A newer import was started while this one was waiting for a resolution — cancelled to avoid creating a stale batch._');
    return;
  }

  const group = ask.pendingGroups[0];
  const choice = parseResolutionSelection(reply, group.resolutionOptions);
  if (choice === 'invalid') {
    return streamStaleResolutionAsk(ask, stream, ws);
  }

  const resolvedGroups: StaleTicketGroup[] = [
    ...ask.resolvedGroups,
    { issueType: group.issueType, ruleName: group.ruleName, targetState: group.targetState, resolution: choice ?? undefined, tickets: group.tickets },
  ];
  const remainingPending = ask.pendingGroups.slice(1);
  if (remainingPending.length > 0) {
    return streamStaleResolutionAsk({ ...ask, pendingGroups: remainingPending, resolvedGroups }, stream, ws);
  }

  await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
  const reviewSession = {
    ...ask.reviewSession,
    staleTickets: { groups: resolvedGroups, ineligible: ask.ineligible },
  } as unknown as ReviewSession<TRow>;
  return streamImportReview(reviewSession, stream, ws, descriptor, baseUrl);
}

export async function streamImportReview<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  await ws.update(descriptor.sessionKeys.review, session);
  // U4: re-derives total page count from `allRows` on every render (cheap — two filters, no
  // per-row rebuild work) rather than trusting a possibly-stale stored value, so the "Page X of Y"
  // line always agrees with the row set actually being shown.
  const { totalPages } = buildReviewPage(session.allRows, session.page);
  // U6: the table's own Include? column is now a per-row toggle command-link (R8), so this whole
  // response must be trust-gated (KTD5) — every row's own field content going through it is
  // neutralized against markdown-link injection at its source (VERACODE_REVIEW_COLUMNS,
  // WALTZ_REVIEW_COLUMNS, EMAIL_REVIEW_COLUMNS in sessionState.ts/emailHandler.ts).
  const staleSection = session.staleTickets ? '\n\n' + buildStaleReviewSection(session.staleTickets, baseUrl) : '';
  stream.markdown(trustedChatMarkdown(
    buildImportReviewTable(
      session.rows, baseUrl, session.page, totalPages, descriptor.reviewColumns, descriptor.itemNoun,
      Boolean(descriptor.updateExisting),
    ) + staleSection,
  ));
  return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
}

export async function handleImportReviewReply<TItem, TRow extends ReviewRowBase>(
  reply: string,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  // U4/R6: page-navigation replies are checked ahead of parseReviewInput — none of the strings
  // they match collide with its toggle/ok/cancel parsing (see parseReviewPageNav's own doc
  // comment), so this never intercepts a real toggle/confirm/cancel reply.
  const pageNav = parseReviewPageNav(reply);
  if (pageNav) {
    const current = buildReviewPage(session.allRows, session.page);
    const targetPage =
      pageNav.kind === 'next' ? current.page + 1 :
      pageNav.kind === 'prev' ? current.page - 1 :
      pageNav.page;
    const nextPage = buildReviewPage(session.allRows, targetPage);
    session.rows = nextPage.rows;
    session.page = nextPage.page;
    return streamImportReview(session, stream, ws, descriptor, baseUrl);
  }

  // U6/R5-R6: a stale-ticket-key toggle (e.g. `PROJ-123`) is checked next — after page-nav, before
  // the New/Already-ticketed sections' own row-id toggle parsing — so its disjoint vocabulary
  // (always hyphenated; row ids never are) is recognized first rather than falling through to
  // parseReviewInput's "didn't understand" path. See parseStaleTicketToggle's own doc comment.
  if (session.staleTickets) {
    const staleKeys = parseStaleTicketToggle(reply, session.staleTickets);
    if (staleKeys) {
      session.staleTickets = applyStaleTicketToggle(session.staleTickets, staleKeys);
      return streamImportReview(session, stream, ws, descriptor, baseUrl);
    }
  }

  // U3/R13: "update existing tickets" — checked after page-nav (U4) and the stale-ticket-key toggle
  // (U6), before the New/Already-ticketed sections' own row-id toggle parsing (its exact-match-only
  // vocabulary can't collide with either). Gated on descriptor.updateExisting so an importer that
  // doesn't configure it (Waltz, email) never runs this — this action is independent of, and does
  // not require, a "post it" confirm on the New/Stale sections (governing decision), so it neither
  // clears the review session nor short-circuits the rest of this function's flow on other replies.
  if (descriptor.updateExisting && isUpdateExistingTicketsReply(reply)) {
    const updated = await executeUpdateExistingTickets(session, ticketService, stream, descriptor, baseUrl);
    return streamImportReview(updated, stream, ws, descriptor, baseUrl);
  }

  const rowIds = session.rows.map(r => r.id);
  const decision = parseReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(trustedChatMarkdown(
      `Didn't understand that. Reply ${buildChatCommandLink('Post it', '@jira', 'post it')} to proceed, ` +
      `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).`,
    ));
    return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
  }
  if (decision.action === 'cancel') {
    await ws.update(descriptor.sessionKeys.review, undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    // U4/R7-R8: a toggled "already ticketed" row is mirrored into `allRows` so it survives a later
    // page-navigation recompute (that section is shown in full on every page); a toggled "new" row
    // is deliberately left page-local — see applyReviewSessionToggle's own doc comment.
    const toggled = applyReviewSessionToggle(session.rows, session.allRows, decision.ids);
    session.rows = toggled.rows;
    session.allRows = toggled.allRows;
    return streamImportReview(session, stream, ws, descriptor, baseUrl);
  }
  if (decision.action === 'setValue') {
    // This review has no per-row value to set — parseReviewInput's `<id>=<value>` form exists
    // for the template-generation flow, not this one. Treat it the same as an unrecognized
    // reply rather than falling through to 'ok', which would silently confirm the batch.
    stream.markdown(trustedChatMarkdown(
      `Didn't understand that. Reply ${buildChatCommandLink('Post it', '@jira', 'post it')} to proceed, ` +
      `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).`,
    ));
    return { metadata: { jiraSession: { kinds: [IMPORT_SESSION_KINDS[descriptor.descriptorKind].review] } } };
  }

  // decision.action === 'ok'
  await ws.update(descriptor.sessionKeys.review, undefined);
  await executeImportBatch(session, ticketService, stream, descriptor, baseUrl);
}

export async function executeImportBatch<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const includedRows = session.rows.filter(r => r.included);
  const toCreate = includedRows.slice(0, BATCH_LIMIT);
  // U4: `session.rows` is already at most one page (BATCH_LIMIT "new" rows, see buildReviewPage)
  // plus every "already ticketed" row — so this slice is normally a no-op. A user can still toggle
  // extra already-ticketed rows back to "re-create" on top of a full page, pushing the included
  // count past BATCH_LIMIT at execution time — droppedOverCap reflects that real slicing outcome
  // directly, rather than re-deriving it from a signal that doesn't actually track whether *this*
  // slice dropped anything.
  const droppedOverCap = includedRows.length - toCreate.length;
  const excludedByUser = session.rows.filter(r => !r.included && r.existingTicketKey === null).length;
  const alreadyTicketedSkipped = session.rows.filter(r => !r.included && r.existingTicketKey !== null).length;

  // U6: one "post it" reply runs both the creation batch and the stale-ticket transition pass, so
  // an empty New/Already-ticketed selection must not short-circuit past an included stale ticket.
  const staleGroups = session.staleTickets?.groups ?? [];
  const includedStaleCount = staleGroups.reduce((n, g) => n + g.tickets.filter(t => t.included).length, 0);

  if (toCreate.length === 0 && includedStaleCount === 0) {
    stream.markdown('_Nothing selected — no tickets were created._');
    return;
  }

  let created = 0;
  let failed = 0;

  if (toCreate.length > 0) {
    stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);

    for (const row of toCreate) {
      const { summary: ticketSummary, fields } = descriptor.buildTicketFields(row, session.additionalFields);
      try {
        const createdTicket = await ticketService.createTicket(session.projectKey, ticketSummary, session.issueType, fields, baseUrl);
        const keyRef = formatKeyLink(createdTicket.key, baseUrl);
        stream.markdown(`✓ ${keyRef} — ${ticketSummary}\n\n`);
        created++;
        // KTD4: optional per-row post-creation work (email uses this for attachment upload). A
        // rejection is shown as a warning but never fails the row — the ticket already exists.
        if (descriptor.afterCreate) {
          try {
            await descriptor.afterCreate(row, createdTicket.key, ticketService);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logDiag(descriptor.scope, 'warn', `Post-creation step failed — ${createdTicket.key}`, { issueKey: createdTicket.key, error: message });
            stream.markdown(`_Warning: ${message}_\n\n`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const ref = descriptor.itemRefFor(row);
        logDiag(descriptor.scope, 'error', `Ticket creation failed — ${ref}`, { ref, error: message });
        stream.markdown(`✗ ${ref} — ${message}\n\n`);
        failed++;
      }
    }

    const total = session.rows.length;
    let summary =
      `${total} ${descriptor.itemNoun} reviewed — **${created}** created, ${failed} failed, ` +
      `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
    if (droppedOverCap > 0) {
      summary += `\n\n_${droppedOverCap} included ${descriptor.itemNoun} were not created — capped at ${BATCH_LIMIT} tickets per run. ` +
        `Re-run the import to process the remainder (already-created tickets are automatically skipped)._`;
    }
    logDiag(descriptor.scope, failed > 0 ? 'warn' : 'info', `${descriptor.importLabel} import complete — ${created} created, ${failed} failed`, {
      total, created, failed, excludedByUser, alreadyTicketedSkipped,
    });
    stream.markdown(summary);
  }

  // U6/R4/KTD10-15: transition every included stale ticket, one group at a time (each group carries
  // its own already-chosen resolution) — reuses cleanupHandler.ts's transitionTickets() rather than
  // re-implementing the per-ticket transition logic.
  if (includedStaleCount > 0) {
    stream.markdown(`\n\n_Transitioning ${includedStaleCount} stale ticket(s)…_\n\n`);
    let staleTransitioned = 0;
    let staleFailed = 0;
    let staleSkipped = 0;
    const staleFailures: Array<{ key: string; reason: string }> = [];
    for (const group of staleGroups) {
      const result = await transitionTickets(group.tickets, ticketService, group.resolution, descriptor.scope);
      staleTransitioned += result.transitioned;
      staleFailed += result.failed;
      staleSkipped += result.skipped;
      staleFailures.push(...result.failures);
    }
    const staleProcessed = staleTransitioned + staleFailed + staleSkipped;
    let staleSummary =
      `${staleProcessed} stale ticket(s) processed — **${staleTransitioned}** transitioned, ${staleFailed} failed, ${staleSkipped} skipped.`;
    if (staleFailures.length > 0) {
      staleSummary += '\n\n' + staleFailures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
      staleSummary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
    }
    logDiag(descriptor.scope, staleFailed > 0 ? 'warn' : 'info',
      `${descriptor.importLabel} stale-ticket transition complete — ${staleTransitioned} transitioned, ${staleFailed} failed, ${staleSkipped} skipped`,
      { staleTransitioned, staleFailed, staleSkipped },
    );
    stream.markdown(staleSummary);
  }
}

/**
 * U3/R13: "update existing tickets" — walks every Already-ticketed row in `session.allRows` (the
 * full, unpaged candidate set — NOT `session.rows`, since that section is always shown in full per
 * R8 but this action must cover every already-ticketed row the report matched, not just whichever
 * page happens to be visible) and, for each one whose finding group has an id not yet reflected on
 * its ticket's labels, adds the missing `label(s)` + a summarizing comment (via
 * `TicketService.addMissingLabels` — the read-merge-write step — then `addComment`).
 *
 * Idempotency (R13): `addMissingLabels` itself is the idempotency check — it returns an empty array
 * when every candidate label is already present, and this loop treats that as "skip" (no comment
 * posted, no second write) rather than re-deriving "already covered" from anything cached in the
 * session. A per-row failure is caught, logged, and reported without aborting the rest of the batch
 * (mirrors executeImportBatch's per-row try/catch).
 *
 * Deliberately does NOT clear the review session or gate on "post it" — this reply is independent
 * of, and does not require, a confirm on the New/Stale sections (governing decision). Returns the
 * session with `updatedExisting` mirrored onto every row this run actually updated
 * (markRowsUpdatedExisting), for the caller to re-render.
 */
export async function executeUpdateExistingTickets<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<ReviewSession<TRow>> {
  const cfg = descriptor.updateExisting;
  if (!cfg) return session; // defensive only — callers already gate on descriptor.updateExisting

  const ticketedRows = session.allRows.filter(r => r.existingTicketKey !== null);
  if (ticketedRows.length === 0) {
    stream.markdown('_No already-ticketed rows to update._\n\n');
    return session;
  }

  stream.markdown(`_Checking ${ticketedRows.length} already-ticketed row(s) for new findings…_\n\n`);
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const updatedKeys = new Set<string>();

  for (const row of ticketedRows) {
    const ticketKey = row.existingTicketKey!;
    try {
      const ids = cfg.idsOf(row);
      const labelsToAdd = ids.map(cfg.labelOf);
      const addedLabels = await ticketService.addMissingLabels(ticketKey, labelsToAdd);
      if (addedLabels.length === 0) {
        skipped++;
        continue;
      }
      // labelOf is expected to be injective (each id maps to its own distinct label) — recovering
      // which ids were newly added from which labels came back added, rather than requiring the
      // descriptor to also supply an inverse mapping function.
      const addedLabelSet = new Set(addedLabels);
      const newIds = ids.filter(id => addedLabelSet.has(cfg.labelOf(id)));
      await ticketService.addComment(ticketKey, cfg.buildCommentWiki(row, newIds), baseUrl);
      stream.markdown(`✓ ${formatKeyLink(ticketKey, baseUrl)} — ${newIds.length} new finding(s) added\n\n`);
      updated++;
      updatedKeys.add(ticketKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag(descriptor.scope, 'error', `Update existing ticket failed — ${ticketKey}`, { issueKey: ticketKey, error: message });
      stream.markdown(`✗ ${formatKeyLink(ticketKey, baseUrl)} — ${message}\n\n`);
      failed++;
    }
  }

  logDiag(
    descriptor.scope, failed > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} update-existing-tickets complete — ${updated} updated, ${skipped} already up to date, ${failed} failed`,
    { updated, skipped, failed },
  );
  stream.markdown(`${updated} ticket(s) updated, ${skipped} already up to date, ${failed} failed.\n\n`);

  const marked = markRowsUpdatedExisting(session.rows, session.allRows, updatedKeys);
  return { ...session, rows: marked.rows, allRows: marked.allRows };
}
