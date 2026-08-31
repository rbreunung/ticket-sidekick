import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { IJiraClient } from '../../jira/IJiraClient';
import { discoverWorkflow, loadWorkflowCache, saveWorkflowCache, preserveSkippedStatuses } from '../../services/WorkflowService';
import type { ParsedIntent } from './llmHelpers';

export async function handleDiscoverWorkflow(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
): Promise<void> {
  const projectKey = intent.projectKey;
  const issueType = intent.issueType;
  if (!projectKey || !issueType) {
    stream.markdown('Please specify a project and issue type, e.g. `@jira discover workflow VSJI Bug`.');
    return;
  }
  stream.markdown(`_Discovering workflow for **${projectKey}** / **${issueType}**…_\n\n`);
  const { graph, skippedStatuses } = await discoverWorkflow(jiraClient, projectKey, issueType);
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    stream.markdown(`No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`);
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const cache = loadWorkflowCache(workspaceRoot);
  if (!cache[projectKey]) cache[projectKey] = {};
  // Preserve previously-cached transitions for statuses that had no representative ticket this run
  const oldGraph = cache[projectKey][issueType]?.graph ?? {};
  const preserved = preserveSkippedStatuses(graph, skippedStatuses, oldGraph);
  cache[projectKey][issueType] = { discovered: new Date().toISOString().slice(0, 10), graph };
  saveWorkflowCache(workspaceRoot, cache);
  // Real success point (KTD9): workflow actually discovered and persisted, not merely attempted —
  // the "no tickets found" bail-out above already returned before reaching here.
  await vscode.commands.executeCommand('setContext', 'ticketSidekick.workflowViewed', true);

  const lines = Object.keys(graph).map((s) => {
    const targets = graph[s].map((t) => `${t.name} → **${t.to}**`).join(', ');
    return `**${s}**: ${targets}`;
  });
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${lines.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  const trulySkipped = skippedStatuses.filter(s => !preserved.includes(s));
  if (preserved.length > 0) {
    summary += `\n\n_${preserved.length} status(es) had no tickets and kept cached transitions: ${preserved.join(', ')}._`;
  }
  if (trulySkipped.length > 0) {
    summary += `\n\n⚠️ **${trulySkipped.length} status(es) had no tickets and no cached transitions:** ${trulySkipped.join(', ')}. Re-run discovery once tickets exist in those states.`;
  }
  logDiag('jira.workflow', 'info', `Workflow discovered — ${projectKey}/${issueType}`, {
    projectKey, issueType, statusCount: lines.length, preservedCount: preserved.length, trulySkippedCount: trulySkipped.length,
  });
  stream.markdown(summary);
}
