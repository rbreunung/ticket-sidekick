import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import {
  parseVeracodeReport, filterFlaws, buildSummary, buildDescriptionWiki, buildLabels, severityLabel,
  type VeracodeFlaw, type VeracodeReviewRow,
} from '../../utils/veracodeReport';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from '../sessionState';
import { VERACODE_REVIEW_COLUMNS } from '../sessionState';
import {
  readAndFilterReport, buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  type ReportImportDescriptor,
} from './reportImportHandler';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';

function getVeracodeConfig(): { minSeverity: number; includeStatuses: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minSeverity: cfg.get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
  };
}

async function readAndFilterVeracodeFile(filePath: string): Promise<VeracodeFlaw[]> {
  // parseVeracodeReport() itself also re-checks size + rejects DOCTYPE/ENTITY (defense in depth,
  // and it's the single source of truth used by the pure unit tests too).
  return readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp, 'utf-8'),
    raw => parseVeracodeReport(raw),
    flaws => filterFlaws(flaws, getVeracodeConfig()),
  );
}

const veracodeDescriptor: ReportImportDescriptor<VeracodeFlaw, VeracodeReviewRow> = {
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
    templateTag: '<!-- jira:veracode-template -->',
    review: 'jira.session.veracodeReview',
    reviewTag: '<!-- jira:veracode-review -->',
  },
  searchLabelOf: flaw => `veracode-issue-${flaw.issueId}`,
  dedupKeyOf: flaw => flaw.issueId,
  labelToDedupKey: label => {
    const match = label.match(/^veracode-issue-(\d+)$/);
    return match ? match[1] : null;
  },
  buildRowFields: (flaw, templateLabels) => ({
    issueId: flaw.issueId,
    severity: flaw.severity,
    severityLabelText: severityLabel(flaw.severity),
    cweId: flaw.cweId,
    summary: buildSummary(flaw),
    labels: buildLabels(flaw, templateLabels),
    descriptionWiki: buildDescriptionWiki(flaw),
  }),
  reviewColumns: VERACODE_REVIEW_COLUMNS,
  itemRefFor: row => `Flaw ${row.issueId}`,
  // KTD9: this pop-up previously lived only in extension.ts's own (pre-consolidation) duplicate of
  // this flow; wiring it through the descriptor keeps it alive for both the command-triggered and
  // chat-only entry points once extension.ts is switched onto this shared session builder.
  onIssueTypeFetchFailed: (message, projectKey) => {
    vscode.window.showWarningMessage(
      `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`,
    );
  },
};

// The exported functions below are thin wrappers around the shared implementations in
// reportImportHandler.ts (R1) — names/signatures unchanged from before this consolidation so
// extension.ts and JiraParticipant.ts need no call-site changes.

export async function buildVeracodeTemplateSession(
  flaws: VeracodeFlaw[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<VeracodeTemplateSelectionSession> {
  return buildImportTemplateSession(flaws, fileName, projectKey, jiraClient, veracodeDescriptor);
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
): Promise<void> {
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
): Promise<void> {
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
): Promise<void> {
  if (sessionWasSuperseded(ws, veracodeDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  await continueAfterImportIssueType(
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
): Promise<void> {
  return handleImportReviewReply(reply, session, ticketService, stream, ws, veracodeDescriptor, baseUrl);
}
