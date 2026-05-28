import * as vscode from 'vscode';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import { loadWorkflowCache, findPath } from '../../services/WorkflowService';
import { TemplateService } from '../../templates/TemplateService';
import type { CleanupRule } from '../../templates/TemplateService';
import type { TransitionBatchSession, TransitionBatchTicket, TransitionSubtask, ResolutionSelectionSession } from '../sessionState';
import { parseResolutionSelection, parseSkipInput } from '../sessionState';
import type { ParsedIntent } from './llmHelpers';

export async function streamReviewScreen(
  session: TransitionBatchSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
  header: string,
): Promise<void> {
  await workspaceState.update('jira.session.transitionReview', session);
  const lines: string[] = [header, ''];
  for (const t of session.tickets) {
    const finalState = t.transitionPath.at(-1)?.to ?? '?';
    const tRes = session.resolution ? ` (${session.resolution})` : '';
    lines.push(`**${t.key}**  ${t.summary}  ·  _${t.currentStatus} → ${finalState}${tRes}_`);
    for (const s of t.subtasks) {
      const sFinal = s.transitionPath.at(-1)?.to ?? '?';
      const sRes = s.resolution
        ? ` (${s.resolution})`
        : session.resolution ? ` (${session.resolution})` : '';
      lines.push(`  **${s.key}**  ${s.summary}  ·  _${s.currentStatus} → ${sFinal}${sRes}_`);
    }
  }
  lines.push('', 'ok · (c) · key numbers to skip (e.g. 11 14)');
  stream.markdown(lines.join('\n') + '\n\n<!-- jira:transition-review -->');
}

export async function executeCleanupBatch(
  session: TransitionBatchSession,
  skipKeys: Set<string>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let transitioned = 0;
  let failed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const ticket of session.tickets) {
    if (skipKeys.has(ticket.key)) {
      skipped += 1 + ticket.subtasks.length;
      continue;
    }

    for (const sub of ticket.subtasks) {
      if (skipKeys.has(sub.key)) { skipped++; continue; }
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, sub.resolution ?? session.resolution);
        const hops = sub.transitionPath.length;
        stream.markdown(`✓ ${sub.key}  → ${sub.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
        transitioned++;
      } catch (err) {
        stream.markdown(`✗ ${sub.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
        failures.push(sub.key);
        failed++;
      }
    }

    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      const hops = ticket.transitionPath.length;
      stream.markdown(`✓ ${ticket.key}  → ${ticket.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
      transitioned++;
    } catch (err) {
      stream.markdown(`✗ ${ticket.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
      failures.push(ticket.key);
      failed++;
    }
  }

  const total = transitioned + failed + skipped;
  stream.markdown(`\n${total} tickets processed — ${transitioned} transitioned, ${failed} failed, ${skipped} skipped.`);
  if (failures.length > 0) {
    stream.markdown(`\nFailed: ${failures.join(', ')}\nIf caused by a workflow gap, run \`@jira discover workflow\` to refresh the cache.`);
  }
}

export async function handleRunCleanup(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  const { cleanupRules } = new TemplateService(workspaceRoot).loadTemplates();
  const rule: CleanupRule | null =
    cleanupRules.find((r) => r.name === intent.cleanupRuleName) ??
    cleanupRules.find((r) => r.project === intent.projectKey && r.issueType === intent.issueType) ??
    null;
  if (!rule && !intent.projectKey) {
    stream.markdown('No cleanup rule found. Use `@jira run cleanup "rule name"` or specify a project and issue type.');
    return;
  }
  const project = rule?.project ?? intent.projectKey!;
  const issueType = rule?.issueType ?? intent.issueType ?? 'Bug';
  const targetState = rule?.targetState ?? 'Done';
  const resolution = intent.resolution ?? rule?.resolution;
  const subtaskResolution = rule?.subtaskResolution ?? resolution;

  const cache = loadWorkflowCache(workspaceRoot);
  const graph = cache[project]?.[issueType]?.graph;
  if (!graph) {
    stream.markdown(`No workflow cache for **${project} / ${issueType}**. Run \`@jira discover workflow ${project} ${issueType}\` first.`);
    return;
  }
  const subGraph = cache[project]?.['Sub-task']?.graph ?? graph;

  const fixVersion = intent.fixVersion ?? null;
  let jql = `project = ${project} AND issuetype = "${issueType}" AND status != "${targetState}" AND resolution is EMPTY`;
  if (fixVersion) jql += ` AND fixVersion = "${fixVersion}"`;
  if (rule?.jql) {
    const trimmed = rule.jql.trim();
    if (/ORDER\s+BY/i.test(trimmed)) {
      stream.markdown(`_Warning: \`rule.jql\` contains ORDER BY which is not allowed — extra filter ignored._\n\n`);
    } else {
      jql += ` AND (${trimmed})`;
    }
  }

  stream.markdown(`**Search scope**\n\`${jql}\`\n\n`);
  const result = await ticketService.searchTicketsRaw(jql, 50);
  const truncated = (result.total ?? 0) > 50 || result.isLast === false;

  if (result.issues.length === 0) {
    stream.markdown('No tickets found matching the criteria.');
    return;
  }
  if (truncated) {
    const count = result.total ? `${result.total} tickets` : 'more tickets';
    stream.markdown(`_Found ${count} — showing first 50. Refine your filter if needed._\n\n`);
  } else {
    stream.markdown(`_Found **${result.issues.length}** ticket${result.issues.length === 1 ? '' : 's'} — building transition paths…_\n\n`);
  }

  const BATCH_LIMIT = 50;
  const tickets: TransitionBatchTicket[] = [];
  for (const issue of result.issues.slice(0, BATCH_LIMIT)) {
    const path = findPath(graph, issue.fields.status.name, targetState);
    if (path === null) {
      stream.markdown(`_Warning: no path found from **${issue.fields.status.name}** to **${targetState}** for ${issue.key} — skipping._\n\n`);
      continue;
    }
    tickets.push({
      key: issue.key,
      summary: issue.fields.summary,
      currentStatus: issue.fields.status.name,
      transitionPath: path,
      subtasks: [],   // filled in Phase B
    });
  }

  if (rule?.closeSubtasks && tickets.length > 0) {
    const parentKeys = tickets.map((t) => t.key);
    const subJql =
      `parent in (${parentKeys.map((k) => `"${k}"`).join(', ')}) ` +
      `AND status != "${targetState}" AND resolution is EMPTY`;
    const subResult = await ticketService.searchTicketsRaw(subJql, 250);
    for (const s of subResult.issues) {
      const parentKey = (s.fields.parent as { key: string } | undefined)?.key;
      if (!parentKey) continue;
      const parent = tickets.find((t) => t.key === parentKey);
      if (!parent) continue;
      const subPath = findPath(subGraph, s.fields.status.name, targetState);
      if (subPath === null) {
        stream.markdown(`_Warning: no path from **${s.fields.status.name}** to **${targetState}** for subtask ${s.key} — skipping. Run \`@jira discover workflow ${project} Sub-task\` if missing._\n\n`);
        continue;
      }
      parent.subtasks.push({
        key: s.key,
        summary: s.fields.summary,
        currentStatus: s.fields.status.name,
        transitionPath: subPath,
        resolution: subtaskResolution,
      });
    }
  }

  if (tickets.length === 0) {
    stream.markdown('No tickets can be transitioned — all are either already at target state or have no valid path.');
    return;
  }

  if (resolution === undefined) {
    const closedStates = new Set(['done', 'resolved', 'closed', "won't fix"]);
    if (closedStates.has(targetState.toLowerCase())) {
      const resolutions = await jiraClient.getResolutions();
      const resSession: ResolutionSelectionSession = {
        tickets,
        ruleName: rule?.name,
        targetState,
        resolutionOptions: resolutions.map((r) => r.name),
      };
      await workspaceState.update('jira.session.resolutionSelection', resSession);
      const list = resolutions.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
      stream.markdown(`Which resolution should be set when transitioning to **${targetState}**?\n\n${list}\n\nReply with the name or number, or **none** to skip setting a resolution.\n\n<!-- jira:selecting-resolution -->`);
      return;
    }
  }

  const header = `**Cleanup${rule ? `: ${rule.name}` : ''}**  ·  ${project} / ${issueType}${fixVersion ? `  ·  Fix version "${fixVersion}"` : ''}`;
  const batchSession: TransitionBatchSession = { tickets, resolution, ruleName: rule?.name };
  await streamReviewScreen(batchSession, stream, workspaceState, header);
}
