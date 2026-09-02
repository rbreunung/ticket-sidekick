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
  MAX_REPORT_BYTES, BATCH_LIMIT, DEFAULT_DEDUP_CHUNK_SIZE, findAlreadyTicketed, capNewRows, buildReviewRows,
  buildDedupJql, type JqlIssueLike,
} from '../../utils/reportImport';
import {
  isCancellation, pickEmailOption, buildImportReviewTable, parseReviewInput, applyReviewToggle,
  CURRENT_SESSION_SCHEMA_VERSION, isSessionExpired, SESSION_EXPIRED_MESSAGE,
  NO_ISSUE_TYPE, resolveTemplateIssueType, formatIssueTypeOptionLabel,
  type ImportTemplateSelectionSession, type ReviewSession, type ReviewTableColumn, type ReviewRowBase,
  type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession,
} from '../sessionState';
import { resolveProjectKey, resolveIssueTypeOrPrompt, sessionWasSuperseded } from './ticketContext';

export interface ReportImportRow extends ReviewRowBase {
  labels: string[];
  summary: string;
  descriptionWiki: string;
}

/**
 * Per-importer descriptor (KTD3) — a plain object of typed fields/functions, not a class hierarchy
 * or a registry. Everything genuinely different between Veracode and Waltz lives here; everything
 * about the session flow itself (control flow AND message wording, per KTD1) lives in the functions
 * below and must not be overridable through this object.
 */
export interface ReportImportDescriptor<TItem, TRow extends ReportImportRow> {
  // R6/KTD4: identifies which importer this is to the shared issue-type chat-ask's
  // AwaitIssueTypeResume — JiraParticipant.ts's router uses it to pick which of
  // veracodeHandler.ts's/waltzHandler.ts's handleXAwaitIssueType wrapper to resume through.
  descriptorKind: 'veracode' | 'waltz';
  scope: string; // logDiag scope, e.g. 'jira.veracode' / 'jira.waltz'
  importLabel: string; // e.g. 'Veracode' / 'Waltz OSS' — used only in the final diag-log line
  itemNoun: string; // e.g. 'flaw(s)' / 'component(s)' — table/summary wording
  filterKindLabel: string; // e.g. 'severity/status' / 'rating/remediation' — template-selection wording
  noMatchMessage: string; // full "no items matched your filters" message (config key names differ per importer)
  fileFilter: { label: string; extensions: string[] };
  filePickerTitle: string;
  parseAndFilter: (filePath: string) => Promise<TItem[]>; // readAndFilterXFile — encoding-aware per importer
  sessionKeys: {
    templateSelection: string;
    templateTag: string;
    review: string;
    reviewTag: string;
  };
  searchLabelOf: (item: TItem) => string; // the full label value searched for in the dedup JQL
  dedupKeyOf: (item: TItem) => string; // the key looked up in the dedup map (may differ from searchLabelOf)
  labelToDedupKey: (label: string) => string | null;
  buildRowFields: (item: TItem, templateLabels: string[]) => Omit<TRow, keyof ReviewRowBase>;
  reviewColumns: ReviewTableColumn<TRow>[];
  itemRefFor: (row: TRow) => string; // e.g. 'Flaw 10101' / 'example-lib:1.2.3' — creation-failure line + log details
  // KTD9: optional UI-notify callback for issue-type-fetch failure, so Veracode's user-visible
  // showWarningMessage on that path survives being driven through this shared builder. Waltz omits
  // it (or could pass a log-only callback) since it has no such warning today.
  onIssueTypeFetchFailed?: (message: string, projectKey: string) => void;
}

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
): Promise<TItem[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error(`File exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  const raw = await readContent(filePath);
  const items = await parse(raw);
  return filter(items);
}

// Chat-only entry point's own file picker.
async function openReportFilePicker<TItem, TRow extends ReportImportRow>(
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<{ items: TItem[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [descriptor.fileFilter.label]: descriptor.fileFilter.extensions },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: descriptor.filePickerTitle,
  });
  if (!uris || uris.length === 0) return null;

  try {
    const items = await descriptor.parseAndFilter(uris[0].fsPath);
    return { items, fileName: path.basename(uris[0].fsPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
}

export async function buildImportTemplateSession<TItem, TRow extends ReportImportRow>(
  items: TItem[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  descriptor: ReportImportDescriptor<TItem, TRow>,
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
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : [NO_ISSUE_TYPE],
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
}

export async function streamImportTemplateSelection<TItem, TRow extends ReportImportRow>(
  session: ImportTemplateSelectionSession<TItem>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<void> {
  await ws.update(descriptor.sessionKeys.templateSelection, session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${formatIssueTypeOptionLabel(t.issueType)})_`).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${formatIssueTypeOptionLabel(t)}`).join('\n')}\n\n`;

  stream.markdown(
    `Found **${session.items.length}** ${descriptor.itemNoun} in \`${session.reportFileName}\` matching your ${descriptor.filterKindLabel} filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n${descriptor.sessionKeys.templateTag}`,
  );
}

// Entry point for the "importX" operation. Handles both invocation paths:
//  1. Command-triggered — an ImportTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only (e.g. "@jira import veracode report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey; resolveProjectKey() falls back to the
// defaultProject setting, then an input box, when it's null.
export async function handleImportReport<TItem, TRow extends ReportImportRow>(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  projectKeyHint: string | null = null,
): Promise<void> {
  const existing = ws.get<ImportTemplateSelectionSession<TItem>>(descriptor.sessionKeys.templateSelection);
  if (existing) {
    if (isSessionExpired(existing)) {
      await ws.update(descriptor.sessionKeys.templateSelection, undefined);
      stream.markdown(SESSION_EXPIRED_MESSAGE);
      return;
    }
    await streamImportTemplateSelection(existing, stream, ws, descriptor);
    return;
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

  const session = await buildImportTemplateSession(picked.items, picked.fileName, projectKey, jiraClient, descriptor);
  await streamImportTemplateSelection(session, stream, ws, descriptor);
}

export async function handleImportTemplateSelection<TItem, TRow extends ReportImportRow>(
  reply: string,
  session: ImportTemplateSelectionSession<TItem>,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update(descriptor.sessionKeys.templateSelection, undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    await streamImportTemplateSelection(session, stream, ws, descriptor);
    return;
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
  const issueType = await resolveIssueTypeOrPrompt(pick.issueType, {
    kind: 'reportImport', descriptorKind: descriptor.descriptorKind, pickedTemplateName, session: resumeSession,
  }, stream, ws);
  if (issueType === null) return;
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }

  await continueAfterImportIssueType(issueType, pickedTemplateName, session, jiraClient, ticketService, stream, ws, descriptor, baseUrl);
}

/**
 * Continuation of handleImportTemplateSelection() once the issue type is known — either resolved
 * directly (a template/entry with a real type) or via R6's chat-based ask
 * (JiraParticipant.ts's shared router calling back in through veracodeHandler.ts/waltzHandler.ts's
 * handleXAwaitIssueType wrappers). `pickedTemplateName` is the picked template's *name* (identity),
 * re-looked-up here — not a pre-resolved template object — matching KTD4.
 */
export async function continueAfterImportIssueType<TItem, TRow extends ReportImportRow>(
  issueType: string,
  pickedTemplateName: string | null,
  session: ImportTemplateSelectionSession<TItem>,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
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
  stream.markdown(`_Checking for already-ticketed ${plural}…_\n\n`);
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];

  // The template session was already cleared above, so a failure here must degrade gracefully
  // rather than throw with nothing left to resume from. findAlreadyTicketed() is itself
  // fault-tolerant per chunk (R5/AE2) and never rejects — this catch is a defensive backstop for a
  // failure outside the per-chunk loop (e.g. an error thrown by descriptor.searchLabelOf/labelToDedupKey
  // themselves). Total per-chunk coverage loss (every chunk failed) is a distinct, non-throwing
  // outcome, surfaced instead via the failedChunks/totalChunks check below, which reuses this
  // same user-facing warning for the total-coverage-loss case.
  let dedupMap: Map<string, string>;
  try {
    const searchLabels = session.items.map(descriptor.searchLabelOf);
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

  // Cap "new" (not-yet-ticketed) items at BATCH_LIMIT *before* building full review rows —
  // buildReviewRows()/buildDescriptionWiki() does real work per row (sorting, Markdown-table
  // rendering, a full markdownToJiraWiki() pass), so filtering after the fact would build and then
  // discard that work for every excess "new" item on a report larger than one run's worth.
  // Already-ticketed rows are never capped. Re-running the import after this batch completes
  // surfaces the next BATCH_LIMIT new candidates for free, since the ones just created are now
  // dedup-matched.
  const capped = capNewRows(session.items, BATCH_LIMIT, item => dedupMap.has(descriptor.dedupKeyOf(item)));
  const rows = buildReviewRows<TItem, TRow>(
    capped.included,
    dedupMap,
    descriptor.dedupKeyOf,
    item => descriptor.buildRowFields(item, templateLabels),
  );

  const reviewSession: ReviewSession<TRow> = {
    projectKey: session.projectKey,
    issueType,
    templateName,
    additionalFields,
    rows,
    totalNewMatched: capped.totalNewMatched,
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  await streamImportReview(reviewSession, stream, ws, descriptor, baseUrl);
}

export async function streamImportReview<TItem, TRow extends ReportImportRow>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  await ws.update(descriptor.sessionKeys.review, session);
  stream.markdown(
    `${buildImportReviewTable(session.rows, baseUrl, session.totalNewMatched, descriptor.reviewColumns, descriptor.itemNoun)}\n\n${descriptor.sessionKeys.reviewTag}`,
  );
}

export async function handleImportReviewReply<TItem, TRow extends ReportImportRow>(
  reply: string,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const rowIds = session.rows.map(r => r.id);
  const decision = parseReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **post it** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n${descriptor.sessionKeys.reviewTag}`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update(descriptor.sessionKeys.review, undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyReviewToggle(session.rows, decision.ids);
    await streamImportReview(session, stream, ws, descriptor, baseUrl);
    return;
  }
  if (decision.action === 'setValue') {
    // This review has no per-row value to set — parseReviewInput's `<id>=<value>` form exists
    // for the template-generation flow, not this one. Treat it the same as an unrecognized
    // reply rather than falling through to 'ok', which would silently confirm the batch.
    stream.markdown(
      `Didn't understand that. Reply **post it** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n${descriptor.sessionKeys.reviewTag}`,
    );
    return;
  }

  // decision.action === 'ok'
  await ws.update(descriptor.sessionKeys.review, undefined);
  await executeImportBatch(session, ticketService, stream, descriptor, baseUrl);
}

export async function executeImportBatch<TItem, TRow extends ReportImportRow>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const includedRows = session.rows.filter(r => r.included);
  const toCreate = includedRows.slice(0, BATCH_LIMIT);
  // "New" rows are already pre-capped at BATCH_LIMIT before the session is built (see
  // handleImportTemplateSelection above), but a user can still toggle extra already-ticketed rows
  // back to "re-create", pushing the included count past the cap at execution time — droppedOverCap
  // reflects that real slicing outcome directly, rather than re-deriving it from a signal that
  // doesn't actually track whether *this* slice dropped anything.
  const droppedOverCap = includedRows.length - toCreate.length;
  const excludedByUser = session.rows.filter(r => !r.included && r.existingTicketKey === null).length;
  const alreadyTicketedSkipped = session.rows.filter(r => !r.included && r.existingTicketKey !== null).length;

  if (toCreate.length === 0) {
    stream.markdown('_Nothing selected — no tickets were created._');
    return;
  }

  stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);
  let created = 0;
  let failed = 0;

  for (const row of toCreate) {
    try {
      const fields = { ...session.additionalFields, labels: row.labels, description: row.descriptionWiki };
      const createdTicket = await ticketService.createTicket(session.projectKey, row.summary, session.issueType, fields, baseUrl);
      const keyRef = formatKeyLink(createdTicket.key, baseUrl);
      stream.markdown(`✓ ${keyRef} — ${row.summary}\n\n`);
      created++;
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
