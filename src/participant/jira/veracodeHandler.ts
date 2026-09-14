import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import {
  parseVeracodeReport, filterFlaws, severityLabel, groupFlawsByLocation,
  buildGroupSummary, buildGroupDescriptionWiki, buildGroupLabels,
  type VeracodeFlaw, type VeracodeReviewRow,
} from '../../utils/veracodeReport';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession, StaleResolutionAskSession } from '../sessionState';
import { VERACODE_REVIEW_COLUMNS } from '../sessionState';
import {
  readAndFilterReport, buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  continueAfterStaleResolution,
  type ReportImportDescriptor,
} from './reportImportHandler';
import { resolveMaxReportBytes } from '../../utils/reportImport';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';

// Bounds match ticketSidekick.veracode.maxReportSizeMB's package.json declaration (default 50,
// range 1-200 MB) — single source of truth for the default kept there; these are duplicated here
// only as the numeric bounds resolveMaxReportBytes() needs, since package.json isn't importable.
const DEFAULT_MAX_REPORT_SIZE_MB = 50;
const MIN_MAX_REPORT_SIZE_MB = 1;
const MAX_MAX_REPORT_SIZE_MB = 200;

// Exported so extension.ts's command-palette entry point resolves ticketSidekick.veracode.maxReportSizeMB
// exactly the same way as the @jira chat entry point below, rather than re-deriving the bounds and
// risking the two entry points drifting apart.
export function getVeracodeMaxReportBytes(): number {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return resolveMaxReportBytes(
    cfg.get<number>('veracode.maxReportSizeMB'), DEFAULT_MAX_REPORT_SIZE_MB, MIN_MAX_REPORT_SIZE_MB, MAX_MAX_REPORT_SIZE_MB,
  );
}

function getVeracodeConfig(): { minSeverity: number; includeStatuses: string[]; maxReportBytes: number } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minSeverity: cfg.get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
    maxReportBytes: getVeracodeMaxReportBytes(),
  };
}

// U2: folds immediately after parse+filter — before dedup ever runs (KTD1) — so every downstream
// step (dedup search, review-row building, ticket creation) operates on folded groups
// (VeracodeFlaw[], one or more flaws sharing a source file + line, R9) rather than individual
// flaws. A flaw with no location (missing sourceFile/line) never folds with anything and comes
// back as its own singleton group — see groupFlawsByLocation()'s own doc comment.
async function readAndFilterVeracodeFile(filePath: string): Promise<{ items: VeracodeFlaw[][]; rawItems: VeracodeFlaw[] }> {
  // parseVeracodeReport() itself also re-checks size + rejects DOCTYPE/ENTITY (defense in depth,
  // and it's the single source of truth used by the pure unit tests too) — both checks share the
  // same resolved maxReportBytes so they agree with each other and with the user's setting.
  const { maxReportBytes, ...filterConfig } = getVeracodeConfig();
  // U6: captures the raw, unfiltered parsed flaws (before minSeverity/includeRemediationStatuses)
  // as a side effect of readAndFilterReport's own filter step — buildVeracodeActiveFlawPredicate
  // needs these, not the filtered/folded set filterFlaws()/groupFlawsByLocation() produce.
  let rawFlaws: VeracodeFlaw[] = [];
  const filtered = await readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp, 'utf-8'),
    raw => parseVeracodeReport(raw, maxReportBytes),
    flaws => { rawFlaws = flaws; return filterFlaws(flaws, filterConfig); },
    maxReportBytes,
  );
  return { items: groupFlawsByLocation(filtered), rawItems: rawFlaws };
}

// U5: the `veracode` label every Veracode-imported ticket carries (alongside its
// `veracode-issue-<id>` marker label(s)) — reportImport.ts's findStaleTickets() searches on this to
// find open tickets whose finding(s) have disappeared from the current report. Not yet wired into
// the chat flow (that's U6); exported here so that later unit can call findStaleTickets() with the
// right marker label without duplicating it.
export const VERACODE_STALE_MARKER_LABEL = 'veracode';

// Extracted so the descriptor's own labelToDedupKey (dedup search) and findStaleTickets()'s
// labelToDedupKey (stale search, U6) parse the identical `veracode-issue-<id>` label shape from one
// implementation instead of two copies that could drift apart.
export function veracodeLabelToIssueId(label: string): string | null {
  const match = label.match(/^veracode-issue-(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Builds the "is this flaw id still active" predicate findStaleTickets() needs (U5's R2/R3). A
 * flaw id is active when it's present in the *raw* parsed report (before the
 * minSeverity/includeRemediationStatuses filter that decides what gets a *new* ticket — R2 says
 * "absent from the raw parsed report") with a remediationStatus that still matches
 * `includeStatuses`. Deliberately ignores minSeverity: R2 only mentions remediation status, so a
 * flaw that dropped below the severity floor but is still open does not make its ticket stale.
 */
export function buildVeracodeActiveFlawPredicate(
  rawFlaws: VeracodeFlaw[],
  includeStatuses: string[],
): (issueId: string) => boolean {
  const statusSet = new Set(includeStatuses.map(s => s.toLowerCase()));
  const statusById = new Map(rawFlaws.map(f => [f.issueId, f.remediationStatus] as const));
  return (issueId: string) => {
    const status = statusById.get(issueId);
    return status !== undefined && statusSet.has(status.toLowerCase());
  };
}

const veracodeDescriptor: ReportImportDescriptor<VeracodeFlaw[], VeracodeReviewRow> = {
  descriptorKind: 'veracode',
  scope: 'jira.veracode',
  importLabel: 'Veracode',
  itemNoun: 'flaw(s)',
  filterKindLabel: 'severity/status',
  noMatchMessage:
    'No flaws in this report matched your current filters ' +
    '(`ticketSidekick.veracode.minSeverity` / `ticketSidekick.veracode.includeRemediationStatuses`).',
  fileFilter: { label: 'Veracode report', extensions: ['xml'] },
  filePickerTitle: 'Select Veracode Detailed Report (.xml)',
  parseAndFilter: readAndFilterVeracodeFile,
  sessionKeys: {
    templateSelection: 'jira.session.veracodeTemplateSelection',
    review: 'jira.session.veracodeReview',
  },
  // U2/R11: one label/key per member flaw in the folded group — a match on any one of them
  // (an already-ticketed single flaw from a prior, unfolded run, say) counts the whole group as
  // already-ticketed.
  searchLabelOf: group => group.map(flaw => `veracode-issue-${flaw.issueId}`),
  dedupKeyOf: group => group.map(flaw => flaw.issueId),
  labelToDedupKey: veracodeLabelToIssueId,
  buildRowFields: (group, templateLabels) => {
    const first = group[0];
    return {
      issueIds: group.map(flaw => flaw.issueId),
      severity: first.severity,
      severityLabelText: severityLabel(first.severity),
      cweId: first.cweId,
      summary: buildGroupSummary(group),
      labels: buildGroupLabels(group, templateLabels),
      // U4/R6-R7: no eager buildGroupDescriptionWiki() call here — the group is kept on the row
      // instead, and the full description is built just-in-time in buildTicketFields below, only
      // for a row the user actually confirms into creation.
      sourceGroup: group,
    };
  },
  reviewColumns: VERACODE_REVIEW_COLUMNS,
  itemRefFor: row => `Flaw ${row.issueIds.join(', ')}`,
  buildTicketFields: (row, additionalFields) => ({
    summary: row.summary,
    fields: { ...additionalFields, labels: row.labels, description: buildGroupDescriptionWiki(row.sourceGroup) },
  }),
  // KTD9: this pop-up previously lived only in extension.ts's own (pre-consolidation) duplicate of
  // this flow; wiring it through the descriptor keeps it alive for both the command-triggered and
  // chat-only entry points once extension.ts is switched onto this shared session builder.
  onIssueTypeFetchFailed: (message, projectKey) => {
    vscode.window.showWarningMessage(
      `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`,
    );
  },
  // U6: wires reportImportHandler.ts's reverse stale-ticket check up to U5's own marker
  // label/predicate builder — rawItems here is always what readAndFilterVeracodeFile's rawItems
  // (or extension.ts's own captured pre-filter parse) produced: individual, unfiltered VeracodeFlaw[].
  stale: {
    markerLabel: VERACODE_STALE_MARKER_LABEL,
    labelToDedupKey: veracodeLabelToIssueId,
    buildActivePredicate: rawItems => buildVeracodeActiveFlawPredicate(rawItems as VeracodeFlaw[], getVeracodeConfig().includeStatuses),
  },
};

// The exported functions below are thin wrappers around the shared implementations in
// reportImportHandler.ts (R1) — names/signatures unchanged from before this consolidation so
// extension.ts and JiraParticipant.ts need no call-site changes.

// Signature unchanged (still takes raw, unfolded flaws) — extension.ts's command-triggered entry
// point (registerReportImportCommand's `parse`/`filter` produce VeracodeFlaw[], not groups) calls
// this directly, so folding happens here rather than requiring that call site to change too.
export async function buildVeracodeTemplateSession(
  flaws: VeracodeFlaw[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  // U6: the *raw, unfiltered* flaws (pre minSeverity/includeRemediationStatuses) — extension.ts's
  // command-triggered entry point now captures these itself (see its own `parse` step) and passes
  // them through; defaults to `flaws` (already filtered) for any other caller, which degrades the
  // stale check gracefully rather than crashing (a filtered-out flaw would just look "inactive").
  rawFlaws: VeracodeFlaw[] = flaws,
): Promise<VeracodeTemplateSelectionSession> {
  return buildImportTemplateSession(groupFlawsByLocation(flaws), fileName, projectKey, jiraClient, veracodeDescriptor, rawFlaws);
}

// Entry point for the "importVeracode" operation. Handles both invocation paths:
//  1. Command-triggered — a VeracodeTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import veracode report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import veracode report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportVeracodeReport(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<vscode.ChatResult | void> {
  return handleImportReport(request, stream, token, jiraClient, ticketService, ws, veracodeDescriptor, projectKeyHint);
}

export async function handleVeracodeTemplateSelection(
  reply: string,
  session: VeracodeTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return handleImportTemplateSelection(reply, session, jiraClient, ticketService, stream, ws, veracodeDescriptor, baseUrl);
}

// R6/KTD4: resumes a Veracode import once the shared issue-type chat-ask (JiraParticipant.ts's
// router) has a typed type for a 'reportImport'-kind resume with descriptorKind 'veracode'.
// Mirrors the sessionWasSuperseded() guard handleImportTemplateSelection already runs after its
// own (now-shared) detour, since a newer import may have started while this one was waiting.
export async function handleVeracodeAwaitIssueType(
  resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }>,
  issueType: string,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  if (sessionWasSuperseded(ws, veracodeDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  return continueAfterImportIssueType(
    issueType, resume.pickedTemplateName, resume.session as VeracodeTemplateSelectionSession,
    jiraClient, ticketService, stream, ws, veracodeDescriptor, baseUrl,
  );
}

export async function handleVeracodeReviewReply(
  reply: string,
  session: VeracodeReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return handleImportReviewReply(reply, session, ticketService, stream, ws, veracodeDescriptor, baseUrl);
}

// U6: resumes a Veracode stale-ticket batch's chained per-issue-type-group resolution ask
// (JiraParticipant.ts's router, mirroring handleVeracodeAwaitIssueType above).
export async function handleVeracodeStaleResolution(
  reply: string,
  ask: StaleResolutionAskSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return continueAfterStaleResolution(reply, ask, stream, ws, veracodeDescriptor, baseUrl);
}
