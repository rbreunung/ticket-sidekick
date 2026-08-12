import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import {
  parseVeracodeReport, filterFlaws, chunkIssueIds, buildDedupJql, extractDedupMap, buildReviewRows,
  type VeracodeFlaw,
} from '../../utils/veracodeReport';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from '../sessionState';
import {
  isCancellation, pickEmailOption, buildVeracodeReviewTable, parseVeracodeReviewInput, applyVeracodeToggle,
  extractCreatedKeyFromConfirmation,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB
const BATCH_LIMIT = 50; // matches the cleanupHandler.ts BATCH_LIMIT convention — not user-configurable

function getVeracodeConfig(): { minSeverity: number; includeStatuses: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minSeverity: cfg.get<number>('veracode.minSeverity') ?? 4,
    includeStatuses: cfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
  };
}

async function readAndFilterVeracodeFile(filePath: string): Promise<VeracodeFlaw[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error(`File exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  // parseVeracodeReport() itself also re-checks size + rejects DOCTYPE/ENTITY (defense in depth,
  // and it's the single source of truth used by the pure unit tests too).
  const flaws = parseVeracodeReport(raw);
  return filterFlaws(flaws, getVeracodeConfig());
}

// Chat-only entry point's own file picker — mirrors emailHandler.ts's openEmailFilePicker.
async function openVeracodeFilePicker(
  stream: vscode.ChatResponseStream,
): Promise<{ flaws: VeracodeFlaw[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Veracode report': ['xml'] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: 'Select Veracode Detailed Report (.xml)',
  });
  if (!uris || uris.length === 0) return null;

  try {
    const flaws = await readAndFilterVeracodeFile(uris[0].fsPath);
    return { flaws, fileName: uris[0].fsPath.split(/[\\/]/).pop() ?? uris[0].fsPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.veracode', 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
}

export async function buildVeracodeTemplateSession(
  flaws: VeracodeFlaw[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<VeracodeTemplateSelectionSession> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch (err) {
      logDiag('jira.veracode', 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();

  let issueTypes: string[] = [];
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch (err) {
    logDiag('jira.veracode', 'warn', `Could not fetch issue types — ${projectKey}, defaulting to 'Bug'`, {
      projectKey, error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    reportFileName: fileName,
    projectKey,
    flaws,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
  };
}

export async function streamVeracodeTemplateSelection(
  session: VeracodeTemplateSelectionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.veracodeTemplateSelection', session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;

  stream.markdown(
    `Found **${session.flaws.length}** flaw(s) in \`${session.reportFileName}\` matching your severity/status filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n<!-- jira:veracode-template -->`,
  );
}

// Entry point for the "importVeracode" operation. Handles both invocation paths:
//  1. Command-triggered — a VeracodeTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import veracode report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import veracode report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportVeracodeReport(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<void> {
  const existing = ws.get<VeracodeTemplateSelectionSession>('jira.session.veracodeTemplateSelection');
  if (existing) {
    await streamVeracodeTemplateSelection(existing, stream, ws);
    return;
  }

  const picked = await openVeracodeFilePicker(stream);
  if (!picked) return;
  if (picked.flaws.length === 0) {
    stream.markdown(
      'No flaws in this report matched your current filters ' +
      '(`ticketSidekick.veracode.minSeverity` / `ticketSidekick.veracode.includeRemediationStatuses`).',
    );
    return;
  }

  const projectKey = await resolveProjectKey(projectKeyHint, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildVeracodeTemplateSession(picked.flaws, picked.fileName, projectKey, jiraClient);
  await streamVeracodeTemplateSelection(session, stream, ws);
}

async function findAlreadyTicketed(
  ticketService: TicketService,
  projectKey: string,
  issueIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunkIssueIds(issueIds)) {
    if (chunk.length === 0) continue;
    const jql = buildDedupJql(projectKey, chunk);
    const result = await ticketService.searchTicketsRaw(jql, 100);
    const found = extractDedupMap(result.issues.map(i => ({ key: i.key, labels: i.fields.labels })));
    for (const [id, key] of found) map.set(id, key);
  }
  return map;
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
  if (isCancellation(reply)) {
    await ws.update('jira.session.veracodeTemplateSelection', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    await streamVeracodeTemplateSelection(session, stream, ws);
    return;
  }
  await ws.update('jira.session.veracodeTemplateSelection', undefined);

  let additionalFields: Record<string, unknown> = {};
  let templateName: string | null = null;
  if (pick.kind === 'template') {
    templateName = pick.name;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (workspaceRoot) {
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        const fullTemplate = templates.find(t => t.name === pick.name);
        if (fullTemplate) {
          const resolver = new FieldResolver(jiraClient, session.projectKey);
          additionalFields = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.veracode', 'warn', `Could not resolve template fields — ${pick.name}`, { templateName: pick.name, error: message });
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ` +
          `${message}_\n\n`,
        );
      }
    }
  }

  stream.markdown(`_Checking for already-ticketed flaws…_\n\n`);
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];
  const dedupMap = await findAlreadyTicketed(ticketService, session.projectKey, session.flaws.map(f => f.issueId));
  const rows = buildReviewRows(session.flaws, dedupMap, templateLabels);

  const reviewSession: VeracodeReviewSession = {
    projectKey: session.projectKey,
    issueType: pick.issueType,
    templateName,
    additionalFields,
    rows,
  };
  await streamVeracodeReview(reviewSession, stream, ws, baseUrl);
}

export async function streamVeracodeReview(
  session: VeracodeReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  await ws.update('jira.session.veracodeReview', session);
  stream.markdown(`${buildVeracodeReviewTable(session.rows, baseUrl)}\n\n<!-- jira:veracode-review -->`);
}

export async function handleVeracodeReviewReply(
  reply: string,
  session: VeracodeReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  const rowIds = session.rows.map(r => r.id);
  const decision = parseVeracodeReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **ok** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n<!-- jira:veracode-review -->`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update('jira.session.veracodeReview', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyVeracodeToggle(session.rows, decision.ids);
    await streamVeracodeReview(session, stream, ws, baseUrl);
    return;
  }

  // decision.action === 'ok'
  await ws.update('jira.session.veracodeReview', undefined);
  await executeVeracodeBatch(session, ticketService, stream);
}

export async function executeVeracodeBatch(
  session: VeracodeReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const toCreate = session.rows.filter(r => r.included).slice(0, BATCH_LIMIT);
  const excludedByUser = session.rows.filter(r => !r.included && r.existingTicketKey === null).length;
  const alreadyTicketedSkipped = session.rows.filter(r => !r.included && r.existingTicketKey !== null).length;

  if (toCreate.length === 0) {
    stream.markdown('_Nothing selected — no tickets were created._');
    return;
  }

  stream.markdown(`_Creating ${toCreate.length} ticket(s)…_\n\n`);
  let created = 0;
  let failed = 0;

  for (const row of toCreate) {
    try {
      const fields = { ...session.additionalFields, labels: row.labels, description: row.descriptionWiki };
      const confirmation = await ticketService.createTicket(session.projectKey, row.summary, session.issueType, fields);
      const key = extractCreatedKeyFromConfirmation(confirmation);
      stream.markdown(`✓ ${key ?? '?'} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.veracode', 'error', `Ticket creation failed — flaw ${row.issueId}`, { issueId: row.issueId, error: message });
      stream.markdown(`✗ Flaw ${row.issueId} — ${message}\n\n`);
      failed++;
    }
  }

  const total = session.rows.length;
  let summary =
    `${total} flaw(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (session.rows.length > BATCH_LIMIT) {
    summary += `\n\n_Batch capped at ${BATCH_LIMIT} tickets per run — re-run the import to process the remainder._`;
  }
  logDiag('jira.veracode', failed > 0 ? 'warn' : 'info', `Veracode import complete — ${created} created, ${failed} failed`, {
    total, created, failed, excludedByUser, alreadyTicketedSkipped,
  });
  stream.markdown(summary);
}
