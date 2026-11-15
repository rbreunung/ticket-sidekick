import * as vscode from 'vscode';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { groupFlawsByLocation, type VeracodeFlaw, type VeracodeReviewRow } from '../../utils/veracodeReport';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession, StaleCloseSession } from '../sessionState';
import { VERACODE_REVIEW_COLUMNS } from '../sessionState';
import {
  buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  continueStaleClose,
  type ReportImportDescriptor,
} from './reportImportHandler';
import type { DiagLogger } from '../../utils/diagTypes';
import { logDiag } from '../../utils/diagLog';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';
import { createVeracodeDescriptor, logVeracodeSlaProblems as logVeracodeSlaProblemsCore } from '../../imports/veracode';
import { veracodeSettings } from '../../services/importSettings';

// The importer's labels and stale-check predicate live in src/imports/veracode.ts, which the import board shares.
export { VERACODE_STALE_MARKER_LABEL, buildVeracodeActiveFlawPredicate, veracodeLabelToIssueId } from '../../imports/veracode';

// The settings readers live in src/services/importSettings.ts, which the import board shares; extension.ts reads the size limit from here.
export { getVeracodeMaxReportBytes } from '../../services/importSettings';

const veracodeDiag: DiagLogger = (level, message, details) => logDiag('jira.veracode', level, message, details);

function logVeracodeSlaProblems(): void {
  logVeracodeSlaProblemsCore(veracodeSettings, veracodeDiag);
}

const veracodeDescriptor: ReportImportDescriptor<VeracodeFlaw[], VeracodeReviewRow> = createVeracodeDescriptor(veracodeSettings, {
  reviewColumns: VERACODE_REVIEW_COLUMNS,
  // KTD9: this pop-up previously lived only in extension.ts's own (pre-consolidation) duplicate of
  // this flow; wiring it through the descriptor keeps it alive for both the command-triggered and
  // chat-only entry points once extension.ts is switched onto this shared session builder.
  onIssueTypeFetchFailed: (message, projectKey) => {
    vscode.window.showWarningMessage(
      `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`,
    );
  },
  onDiag: veracodeDiag,
});

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
  logVeracodeSlaProblems();
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

// Resumes a Veracode import's stepped stale-ticket close (issue type → target → resolution) —
// JiraParticipant.ts's router, mirroring handleVeracodeAwaitIssueType above.
export async function handleVeracodeStaleClose(
  reply: string,
  ask: StaleCloseSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  return continueStaleClose(reply, ask, stream, ws, veracodeDescriptor, ticketService, baseUrl);
}
