import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { IJiraClient, JiraFieldMeta } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import { loadWorkflowCache, findPath } from '../../services/WorkflowService';
import { TemplateService } from '../../templates/TemplateService';
import type { CleanupRule } from '../../templates/TemplateService';
import type { TransitionBatchSession, TransitionBatchTicket, ResolutionSelectionSession } from '../sessionState';
import { buildReviewTable, parseResolutionSelection, parseSkipInput, buildChatCommandLink } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import type { ParsedIntent } from './llmHelpers';

/** Reads each configured `cleanupFields` ID off an issue's `fields` into a ticket/subtask's `.extra` bag. */
export function extractExtraFields(fields: Record<string, unknown>, fieldIds: string[]): Record<string, unknown> | undefined {
  if (fieldIds.length === 0) return undefined;
  const extra: Record<string, unknown> = {};
  for (const id of fieldIds) extra[id] = fields[id];
  return extra;
}

export async function streamReviewScreen(
  session: TransitionBatchSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
  header: string,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  await workspaceState.update('jira.session.transitionReview', session);
  const table = buildReviewTable(session, baseUrl, (fieldId) =>
    logDiag('jira.cleanup', 'warn', `Unrecognized field in cleanupFields: ${fieldId}`, { fieldId }),
  );
  stream.markdown(trustedChatMarkdown(`${header}\n\n${table}`));
  return { metadata: { jiraSession: { kinds: ['transition-review'] } } };
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
  const failures: Array<{ key: string; reason: string }> = [];

  stream.markdown(`_Running transitions…_\n\n`);

  for (const ticket of session.tickets) {
    if (skipKeys.has(ticket.key)) {
      skipped += 1 + ticket.subtasks.length;
      continue;
    }

    for (const sub of ticket.subtasks) {
      if (skipKeys.has(sub.key)) { skipped++; continue; }
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, sub.resolution ?? session.resolution);
        transitioned++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logDiag('jira.cleanup', 'warn', `Transition failed — ${sub.key}`, { issueKey: sub.key, reason });
        failures.push({ key: sub.key, reason });
        failed++;
      }
    }

    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      transitioned++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logDiag('jira.cleanup', 'warn', `Transition failed — ${ticket.key}`, { issueKey: ticket.key, reason });
      failures.push({ key: ticket.key, reason });
      failed++;
    }
  }

  const processedTotal = transitioned + failed + skipped;
  let summary = `${processedTotal} processed — **${transitioned}** transitioned, ${failed} failed, ${skipped} skipped.`;
  if (failures.length > 0) {
    summary += '\n\n' + failures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
    summary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
  }
  logDiag('jira.cleanup', failed > 0 ? 'warn' : 'info', `Cleanup batch complete — ${transitioned} transitioned, ${failed} failed, ${skipped} skipped`, {
    transitioned, failed, skipped,
  });
  stream.markdown(summary);
}

export async function handleRunCleanup(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
  baseUrl?: string,
  cleanupFields: string[] = [],
  cleanupFieldMeta: JiraFieldMeta[] = [],
): Promise<vscode.ChatResult | void> {
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

  const cache = loadWorkflowCache(workspaceRoot);
  const graph = cache[project]?.[issueType]?.graph;
  if (!graph) {
    stream.markdown(`No workflow cache for **${project} / ${issueType}**. Run \`@jira discover workflow ${project} ${issueType}\` first.`);
    return;
  }
  const subGraph = cache[project]?.['Sub-task']?.graph ?? graph;

  const fixVersion: string | null =
    intent.fixVersion ?? rule?.fixVersionFilter ?? rule?.fixVersionPattern ?? null;
  let jql = `project = ${project} AND issuetype = "${issueType}" AND status != "${targetState}" AND resolution is EMPTY`;
  if (fixVersion === 'released') {
    jql += ` AND fixVersion in releasedVersions()`;
  } else if (fixVersion === 'unreleased') {
    jql += ` AND fixVersion in unreleasedVersions()`;
  } else if (fixVersion?.includes('*')) {
    jql += ` AND fixVersion ~ "${fixVersion}"`;
  } else if (fixVersion) {
    jql += ` AND fixVersion = "${fixVersion}"`;
  }

  const scopeLine = (q: string) =>
    baseUrl
      ? `**Search scope** [View in Jira](${baseUrl}/issues/?jql=${encodeURIComponent(q)})\n\n`
      : `**Search scope**\n\`${q}\`\n\n`;

  const buffer: string[] = [];
  buffer.push(scopeLine(jql));

  if (rule?.jql) {
    const trimmed = rule.jql.trim();
    if (/ORDER\s+BY/i.test(trimmed)) {
      buffer.push(`_Warning: \`rule.jql\` contains ORDER BY which is not allowed — extra filter ignored._\n\n`);
    } else {
      jql += ` AND (${trimmed})`;
      buffer[0] = scopeLine(jql);
    }
  }

  const result = await ticketService.searchTicketsRaw(jql, 50, cleanupFields);
  const truncated = (result.total ?? 0) > 50 || result.isLast === false;

  if (result.issues.length === 0) {
    stream.markdown(buffer.join('') + 'No tickets found matching the criteria.');
    return;
  }
  if (truncated) {
    const count = result.total ? `${result.total} tickets` : 'more tickets';
    buffer.push(`_Found ${count} — showing first 50. Refine your filter if needed._\n\n`);
  } else {
    buffer.push(`_Found **${result.issues.length}** ticket${result.issues.length === 1 ? '' : 's'} — building transition paths…_\n\n`);
  }

  const BATCH_LIMIT = 50;
  const tickets: TransitionBatchTicket[] = [];
  for (const issue of result.issues.slice(0, BATCH_LIMIT)) {
    const path = findPath(graph, issue.fields.status.name, targetState);
    if (path === null) {
      buffer.push(`_Warning: no path found from **${issue.fields.status.name}** to **${targetState}** for ${issue.key} — skipping._\n\n`);
      continue;
    }
    tickets.push({
      key: issue.key,
      summary: issue.fields.summary,
      currentStatus: issue.fields.status.name,
      transitionPath: path,
      subtasks: [],
      extra: extractExtraFields(issue.fields, cleanupFields),
    });
  }

  if (rule?.closeSubtasks && tickets.length > 0) {
    const subtaskResolution = rule.subtaskResolution ?? resolution;
    const subTargetState = rule.subtaskTargetState ?? targetState;
    const parentKeys = tickets.map((t) => t.key);
    const subJql =
      `parent in (${parentKeys.map((k) => `"${k}"`).join(', ')}) ` +
      `AND status != "${subTargetState}" AND resolution is EMPTY`;
    const subResult = await ticketService.searchTicketsRaw(subJql, 250, cleanupFields);
    for (const s of subResult.issues) {
      const parentKey = s.fields.parent?.key;
      if (!parentKey) continue;
      const parent = tickets.find((t) => t.key === parentKey);
      if (!parent) continue;
      const subPath = findPath(subGraph, s.fields.status.name, subTargetState);
      if (subPath === null) {
        buffer.push(`_Warning: no path from **${s.fields.status.name}** to **${subTargetState}** for subtask ${s.key} — skipping. Run \`@jira discover workflow ${project} Sub-task\` if missing._\n\n`);
        continue;
      }
      parent.subtasks.push({
        key: s.key,
        summary: s.fields.summary,
        currentStatus: s.fields.status.name,
        transitionPath: subPath,
        resolution: subtaskResolution,
        extra: extractExtraFields(s.fields, cleanupFields),
      });
    }
  }

  if (tickets.length === 0) {
    stream.markdown(buffer.join('') + 'No tickets can be transitioned — all are either already at target state or have no valid path.');
    return;
  }

  if (resolution === undefined) {
    const closedStates = new Set(['done', 'resolved', 'closed', "won't fix"]);
    if (closedStates.has(targetState.toLowerCase())) {
      const resolutions = await jiraClient.getResolutions();
      const resSession: ResolutionSelectionSession = {
        tickets,
        ruleName: rule?.name,
        issueType,
        targetState,
        resolutionOptions: resolutions.map((r) => r.name),
        fieldIds: cleanupFields,
        fieldMeta: cleanupFieldMeta,
      };
      await workspaceState.update('jira.session.resolutionSelection', resSession);
      const list = resolutions.map((r, i) => `${i + 1}. ${buildChatCommandLink(r.name, '@jira', String(i + 1))}`).join('\n');
      stream.markdown(trustedChatMarkdown(
        `Which resolution should be set when transitioning to **${targetState}**?\n\n${list}\n\n` +
        `Reply with the name or number, or ${buildChatCommandLink('None', '@jira', 'none')} to skip setting a resolution.`,
      ));
      return { metadata: { jiraSession: { kinds: ['resolution-selection'] } } };
    }
  }

  const fvLabel =
    fixVersion === 'released' ? 'released versions' :
    fixVersion === 'unreleased' ? 'unreleased versions' :
    fixVersion?.includes('*') ? `Fix version ~ "${fixVersion}"` :
    fixVersion ? `Fix version "${fixVersion}"` : null;
  const header = `**Cleanup${rule ? `: ${rule.name}` : ''}**  ·  ${project} / ${issueType}${fvLabel ? `  ·  ${fvLabel}` : ''}`;
  const batchSession: TransitionBatchSession = {
    tickets, resolution, ruleName: rule?.name, issueType,
    fieldIds: cleanupFields, fieldMeta: cleanupFieldMeta,
  };
  await workspaceState.update('jira.session.transitionReview', batchSession);
  const table = buildReviewTable(batchSession, baseUrl, (fieldId) =>
    logDiag('jira.cleanup', 'warn', `Unrecognized field in cleanupFields: ${fieldId}`, { fieldId }),
  );
  stream.markdown(`${buffer.join('')}${header}\n\n${table}`);
  return { metadata: { jiraSession: { kinds: ['transition-review'] } } };
}
