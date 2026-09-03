import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import {
  parseWaltzReport, filterComponents, sanitizeComponentLabel, buildSummary, buildLabels, buildDescriptionWiki,
  type WaltzComponent, type WaltzReviewRow,
} from '../../utils/waltzReport';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from '../sessionState';
import { WALTZ_REVIEW_COLUMNS } from '../sessionState';
import {
  readAndFilterReport, buildImportTemplateSession, handleImportReport,
  handleImportTemplateSelection, handleImportReviewReply, continueAfterImportIssueType,
  type ReportImportDescriptor,
} from './reportImportHandler';
import type { AwaitIssueTypeResume } from '../sessionState';
import { sessionWasSuperseded } from './ticketContext';

function getWaltzConfig(): { minVulnRating: string; includeRemediationActions: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minVulnRating: cfg.get<string>('waltz.minVulnRating') ?? 'High',
    includeRemediationActions: cfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
  };
}

async function readAndFilterWaltzFile(filePath: string): Promise<WaltzComponent[]> {
  // parseWaltzReport() itself also re-checks size (single source of truth used by the pure unit tests too).
  return readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp),
    raw => parseWaltzReport(raw),
    components => filterComponents(components, getWaltzConfig()),
  );
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
    templateTag: '<!-- jira:waltz-template -->',
    review: 'jira.session.waltzReview',
    reviewTag: '<!-- jira:waltz-review -->',
  },
  searchLabelOf: component => sanitizeComponentLabel(component.nameVersion),
  dedupKeyOf: component => sanitizeComponentLabel(component.nameVersion),
  labelToDedupKey: label => (label.startsWith('oss-dep-') ? label : null),
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
};

// The exported functions below are thin wrappers around the shared implementations in
// reportImportHandler.ts (R1) — names/signatures unchanged from before this consolidation so
// extension.ts and JiraParticipant.ts need no call-site changes.

export async function buildWaltzTemplateSession(
  components: WaltzComponent[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<WaltzTemplateSelectionSession> {
  return buildImportTemplateSession(components, fileName, projectKey, jiraClient, waltzDescriptor);
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
): Promise<void> {
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
): Promise<void> {
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
): Promise<void> {
  if (sessionWasSuperseded(ws, waltzDescriptor.sessionKeys.templateSelection)) {
    stream.markdown('_A newer import was started while this one was waiting for the issue type — cancelled to avoid creating a stale batch._');
    return;
  }
  await continueAfterImportIssueType(
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
): Promise<void> {
  return handleImportReviewReply(reply, session, ticketService, stream, ws, waltzDescriptor, baseUrl);
}
