import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import {
  parseWaltzReport, filterComponents, sanitizeComponentLabel, buildSummary, buildLabels, buildDescriptionWiki,
  type WaltzComponent, type WaltzReviewRow,
} from '../../utils/waltzReport';
import type { WaltzTemplateSelectionSession, WaltzReviewSession, StaleResolutionAskSession } from '../sessionState';
import { WALTZ_REVIEW_COLUMNS } from '../sessionState';
import {
  readAndFilterReport, buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  continueAfterStaleResolution,
  type ReportImportDescriptor,
} from './reportImportHandler';
import { resolveMaxReportBytes } from '../../utils/reportImport';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';

// Bounds match ticketSidekick.waltz.maxReportSizeMB's package.json declaration (default 50, range
// 1-200 MB) — single source of truth for the default kept there; these are duplicated here only as
// the numeric bounds resolveMaxReportBytes() needs, since package.json isn't importable.
const DEFAULT_MAX_REPORT_SIZE_MB = 50;
const MIN_MAX_REPORT_SIZE_MB = 1;
const MAX_MAX_REPORT_SIZE_MB = 200;

// Exported so extension.ts's command-palette entry point resolves ticketSidekick.waltz.maxReportSizeMB
// exactly the same way as the @jira chat entry point below, rather than re-deriving the bounds and
// risking the two entry points drifting apart.
export function getWaltzMaxReportBytes(): number {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return resolveMaxReportBytes(
    cfg.get<number>('waltz.maxReportSizeMB'), DEFAULT_MAX_REPORT_SIZE_MB, MIN_MAX_REPORT_SIZE_MB, MAX_MAX_REPORT_SIZE_MB,
  );
}

function getWaltzConfig(): { minVulnRating: string; includeRemediationActions: string[]; maxReportBytes: number } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minVulnRating: cfg.get<string>('waltz.minVulnRating') ?? 'High',
    includeRemediationActions: cfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
    maxReportBytes: getWaltzMaxReportBytes(),
  };
}

async function readAndFilterWaltzFile(filePath: string): Promise<{ items: WaltzComponent[]; rawItems: WaltzComponent[] }> {
  // parseWaltzReport() itself also re-checks size (single source of truth used by the pure unit
  // tests too) — both checks share the same resolved maxReportBytes so they agree with each other
  // and with the user's setting.
  const { maxReportBytes, ...filterConfig } = getWaltzConfig();
  // U6: buildWaltzActiveComponentPredicate needs the raw, unfiltered components (before
  // minVulnRating/includeRemediationActions) — readAndFilterReport returns them directly as
  // `rawItems` alongside the filtered set, no closure capture needed.
  const { items, rawItems } = await readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp),
    raw => parseWaltzReport(raw, maxReportBytes),
    components => filterComponents(components, filterConfig),
    maxReportBytes,
  );
  return { items, rawItems };
}

// U5: the `oss-dependency` label every Waltz-imported ticket carries (alongside its own
// `oss-dep-...` component label) — reportImport.ts's findStaleTickets() searches on this to find
// open tickets whose component has disappeared from the current report. Not yet wired into the
// chat flow (that's U6); exported here so that later unit can call findStaleTickets() with the
// right marker label without duplicating it.
export const WALTZ_STALE_MARKER_LABEL = 'oss-dependency';

// Reused directly by the descriptor's own labelToDedupKey below (dedup search) and by
// findStaleTickets()'s labelToDedupKey (stale search, U6) so both parse the identical
// `oss-dep-...` label shape sanitizeComponentLabel() produces, from one implementation.
function waltzLabelToDedupKey(label: string): string | null {
  return label.startsWith('oss-dep-') ? label : null;
}

/**
 * Builds the "is this component still active" predicate findStaleTickets() needs (U5's R5). A
 * component is active when it's present in the *raw* parsed report (before the
 * minVulnRating/includeRemediationActions filter that decides what gets a *new* ticket — R5 says
 * "absent from the current Waltz report") with a remediationAction that still matches
 * `includeRemediationActions`. Deliberately ignores minVulnRating: R5 only mentions remediation
 * action, so a component that dropped below the rating floor but is still open does not make its
 * ticket stale.
 */
export function buildWaltzActiveComponentPredicate(
  rawComponents: WaltzComponent[],
  includeRemediationActions: string[],
): (dedupKey: string) => boolean {
  const allowedActions = new Set(includeRemediationActions.map(a => a.trim()));
  const actionByKey = new Map(rawComponents.map(c => [sanitizeComponentLabel(c.nameVersion), (c.remediationAction ?? '').trim()] as const));
  return (dedupKey: string) => {
    const action = actionByKey.get(dedupKey);
    return action !== undefined && allowedActions.has(action);
  };
}

const waltzDescriptor: ReportImportDescriptor<WaltzComponent, WaltzReviewRow> = {
  descriptorKind: 'waltz',
  scope: 'jira.waltz',
  importLabel: 'Waltz OSS',
  itemNoun: 'component(s)',
  filterKindLabel: 'rating/remediation',
  noMatchMessage:
    'No components in this report matched your current filters ' +
    '(`ticketSidekick.waltz.minVulnRating` / `ticketSidekick.waltz.includeRemediationActions`).',
  fileFilter: { label: 'OSS report', extensions: ['xlsx'] },
  filePickerTitle: 'Select OSS Report (.xlsx)',
  parseAndFilter: readAndFilterWaltzFile,
  sessionKeys: {
    templateSelection: 'jira.session.waltzTemplateSelection',
    review: 'jira.session.waltzReview',
  },
  // U2: Waltz stays single-key — one component maps to exactly one label/dedup key, wrapped in a
  // one-element array to satisfy the (now folding-aware) descriptor contract. No behavior change.
  searchLabelOf: component => [sanitizeComponentLabel(component.nameVersion)],
  dedupKeyOf: component => [sanitizeComponentLabel(component.nameVersion)],
  labelToDedupKey: waltzLabelToDedupKey,
  buildRowFields: (component, templateLabels) => ({
    nameVersion: component.nameVersion,
    maxVulnRating: component.maxVulnRating,
    summary: buildSummary(component),
    labels: buildLabels(component, templateLabels),
    descriptionWiki: buildDescriptionWiki(component),
  }),
  reviewColumns: WALTZ_REVIEW_COLUMNS,
  itemRefFor: row => row.nameVersion,
  buildTicketFields: (row, additionalFields) => ({
    summary: row.summary,
    fields: { ...additionalFields, labels: row.labels, description: row.descriptionWiki },
  }),
  // Waltz has no issue-type-fetch-failure pop-up today — omitting onIssueTypeFetchFailed keeps that
  // path log-only, matching current behavior (KTD9).
  // U6: wires reportImportHandler.ts's reverse stale-ticket check up to U5's own marker
  // label/predicate builder — rawItems here is always what readAndFilterWaltzFile's rawItems (or
  // extension.ts's own captured pre-filter parse) produced: unfiltered WaltzComponent[].
  stale: {
    markerLabel: WALTZ_STALE_MARKER_LABEL,
    labelToDedupKey: waltzLabelToDedupKey,
    buildActivePredicate: rawItems => buildWaltzActiveComponentPredicate(rawItems as WaltzComponent[], getWaltzConfig().includeRemediationActions),
  },
};

// The exported functions below are thin wrappers around the shared implementations in
// reportImportHandler.ts (R1) — names/signatures unchanged from before this consolidation so
// extension.ts and JiraParticipant.ts need no call-site changes.

export async function buildWaltzTemplateSession(
  components: WaltzComponent[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  // U6: the *raw, unfiltered* components (pre minVulnRating/includeRemediationActions) —
  // extension.ts's command-triggered entry point now captures these itself and passes them
  // through; defaults to `components` (already filtered) for any other caller, which degrades the
  // stale check gracefully rather than crashing.
  rawComponents: WaltzComponent[] = components,
): Promise<WaltzTemplateSelectionSession> {
  return buildImportTemplateSession(components, fileName, projectKey, jiraClient, waltzDescriptor, rawComponents);
}

// Entry point for the "importWaltzReport" operation. Handles both invocation paths:
//  1. Command-triggered — a WaltzTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import oss report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import oss report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportWaltzReport(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<vscode.ChatResult | void> {
  return handleImportReport(request, stream, token, jiraClient, ticketService, ws, waltzDescriptor, projectKeyHint);
}

export async function handleWaltzTemplateSelection(
  reply: string,
  session: WaltzTemplateSelectionSession,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return handleImportTemplateSelection(reply, session, jiraClient, ticketService, stream, ws, waltzDescriptor, baseUrl);
}

// R6/KTD4: resumes a Waltz import once the shared issue-type chat-ask (JiraParticipant.ts's
// router) has a typed type for a 'reportImport'-kind resume with descriptorKind 'waltz'.
// Mirrors the sessionWasSuperseded() guard handleImportTemplateSelection already runs after its
// own (now-shared) detour, since a newer import may have started while this one was waiting.
export async function handleWaltzAwaitIssueType(
  resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }>,
  issueType: string,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  if (sessionWasSuperseded(ws, waltzDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  return continueAfterImportIssueType(
    issueType, resume.pickedTemplateName, resume.session as WaltzTemplateSelectionSession,
    jiraClient, ticketService, stream, ws, waltzDescriptor, baseUrl,
  );
}

export async function handleWaltzReviewReply(
  reply: string,
  session: WaltzReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return handleImportReviewReply(reply, session, ticketService, stream, ws, waltzDescriptor, baseUrl);
}

// U6: resumes a Waltz stale-ticket batch's chained per-issue-type-group resolution ask
// (JiraParticipant.ts's router, mirroring handleWaltzAwaitIssueType above).
export async function handleWaltzStaleResolution(
  reply: string,
  ask: StaleResolutionAskSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return continueAfterStaleResolution(reply, ask, stream, ws, waltzDescriptor, ticketService, baseUrl);
}
