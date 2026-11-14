import * as vscode from 'vscode';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { WaltzComponent, WaltzReviewRow } from '../../utils/waltzReport';
import { logDiag } from '../../utils/diagLog';
import type { WaltzTemplateSelectionSession, WaltzReviewSession, StaleCloseSession } from '../sessionState';
import { WALTZ_REVIEW_COLUMNS } from '../sessionState';
import {
  buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  continueStaleClose,
  type ReportImportDescriptor,
} from './reportImportHandler';
import { resolveSizeLimitSetting } from '../../utils/reportImport';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';
import { createWaltzDescriptor } from '../../imports/waltz';

// The importer's labels and stale-check predicate live in src/imports/waltz.ts, which the import board shares.
export { WALTZ_STALE_MARKER_LABEL, buildWaltzActiveComponentPredicate } from '../../imports/waltz';

// Exported so extension.ts's command-palette entry point resolves ticketSidekick.waltz.maxReportSizeMB
// exactly the same way as the @jira chat entry point below, rather than re-deriving the bounds and
// risking the two entry points drifting apart.
export function getWaltzMaxReportBytes(): number {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return resolveSizeLimitSetting('waltz.maxReportSizeMB', (key) => cfg.get(key));
}

function getWaltzMinVulnRating(): string {
  return vscode.workspace.getConfiguration('ticketSidekick').get<string>('waltz.minVulnRating') ?? 'High';
}

function getWaltzConfig(): { minVulnRating: string; includeRemediationActions: string[]; maxReportBytes: number } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minVulnRating: getWaltzMinVulnRating(),
    includeRemediationActions: cfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
    maxReportBytes: getWaltzMaxReportBytes(),
  };
}

const waltzDescriptor: ReportImportDescriptor<WaltzComponent[], WaltzReviewRow> = createWaltzDescriptor({
  filter: getWaltzConfig,
  minVulnRating: getWaltzMinVulnRating,
  workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
}, {
  reviewColumns: WALTZ_REVIEW_COLUMNS,
  // Waltz has no issue-type-fetch-failure pop-up today — omitting onIssueTypeFetchFailed keeps that
  // path log-only, matching current behavior (KTD9).
  onDiag: (level, message, details) => logDiag('jira.waltz', level, message, details),
});

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
  reportFilePath?: string,
): Promise<WaltzTemplateSelectionSession> {
  return buildImportTemplateSession(components.map(component => [component]), fileName, projectKey, jiraClient, waltzDescriptor, rawComponents, reportFilePath);
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

// Resumes a Waltz import's stepped stale-ticket close (issue type → target → resolution) —
// JiraParticipant.ts's router, mirroring handleWaltzAwaitIssueType above.
export async function handleWaltzStaleClose(
  reply: string,
  ask: StaleCloseSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return continueStaleClose(reply, ask, stream, ws, waltzDescriptor, ticketService, baseUrl);
}
