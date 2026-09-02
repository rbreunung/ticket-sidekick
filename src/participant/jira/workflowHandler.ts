import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { IJiraClient } from '../../jira/IJiraClient';
import { discoverAndCacheWorkflow } from '../../services/WorkflowService';
import { looksLikeUnfilledPlaceholder, type ParsedIntent } from './llmHelpers';
import { formatWorkflowDiscoveryMessage } from '../sessionState';

export async function handleDiscoverWorkflow(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
): Promise<void> {
  // R1: the walkthrough's "discover workflow" button opens chat with unsent literal
  // `<PROJECT> <ISSUE_TYPE>` placeholders — treat an unedited token the same as "missing"
  // rather than letting it reach discoverAndCacheWorkflow (a real API call).
  const projectKey = looksLikeUnfilledPlaceholder(intent.projectKey) ? null : intent.projectKey;
  const issueType = looksLikeUnfilledPlaceholder(intent.issueType) ? null : intent.issueType;
  if (!projectKey || !issueType) {
    stream.markdown('Please specify a project and issue type, e.g. `@jira discover workflow VSJI Bug`.');
    return;
  }
  stream.markdown(`_Discovering workflow for **${projectKey}** / **${issueType}**…_\n\n`);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // Same discover-then-cache sequence jira_discoverWorkflow's tool uses (src/tools/jiraTools.ts,
  // src/services/WorkflowService.ts), so the chat flow and the Language Model tool never drift
  // apart on cache handling (R3).
  const { graph, skippedStatuses, preserved } = await discoverAndCacheWorkflow(jiraClient, workspaceRoot, projectKey, issueType);
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    stream.markdown(`No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`);
    return;
  }
  // Real success point (KTD9): workflow actually discovered and persisted, not merely attempted —
  // the "no tickets found" bail-out above already returned before reaching here.
  await vscode.commands.executeCommand('setContext', 'ticketSidekick.workflowViewed', true);

  // Same pure formatter jira_discoverWorkflow's tool result uses (src/tools/jiraTools.ts), so
  // the chat flow and the Language Model tool never drift apart on this wording (R3).
  const summary = formatWorkflowDiscoveryMessage(projectKey, issueType, graph, skippedStatuses, preserved);
  const trulySkippedCount = skippedStatuses.filter(s => !preserved.includes(s)).length;
  logDiag('jira.workflow', 'info', `Workflow discovered — ${projectKey}/${issueType}`, {
    projectKey, issueType, statusCount: statuses.length, preservedCount: preserved.length, trulySkippedCount,
  });
  stream.markdown(summary);
}
