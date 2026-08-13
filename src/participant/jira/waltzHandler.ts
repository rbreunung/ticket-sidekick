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
  parseWaltzReport, filterComponents, chunkComponentLabels, buildDedupJql, extractDedupMap, buildReviewRows,
  sanitizeComponentLabel, BATCH_LIMIT, MAX_REPORT_BYTES, type WaltzComponent,
} from '../../utils/waltzReport';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from '../sessionState';
import {
  isCancellation, pickEmailOption, buildWaltzReviewTable, parseWaltzReviewInput, applyWaltzToggle,
  extractCreatedKeyFromConfirmation,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';

function getWaltzConfig(): { minVulnRating: string; includeRemediationActions: string[] } {
  const cfg = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    minVulnRating: cfg.get<string>('waltz.minVulnRating') ?? 'High',
    includeRemediationActions: cfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
  };
}

async function readAndFilterWaltzFile(filePath: string): Promise<WaltzComponent[]> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_REPORT_BYTES) {
    throw new Error(`File exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  const buffer = await fs.promises.readFile(filePath);
  // parseWaltzReport() itself also re-checks size (single source of truth used by the pure unit tests too).
  const components = await parseWaltzReport(buffer);
  return filterComponents(components, getWaltzConfig());
}

// Chat-only entry point's own file picker — mirrors veracodeHandler.ts's openVeracodeFilePicker.
async function openWaltzFilePicker(
  stream: vscode.ChatResponseStream,
): Promise<{ components: WaltzComponent[]; fileName: string } | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'OSS report': ['xlsx'] },
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
    title: 'Select OSS Report (.xlsx)',
  });
  if (!uris || uris.length === 0) return null;

  try {
    const components = await readAndFilterWaltzFile(uris[0].fsPath);
    return { components, fileName: path.basename(uris[0].fsPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.waltz', 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
}

export async function buildWaltzTemplateSession(
  components: WaltzComponent[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
): Promise<WaltzTemplateSelectionSession> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch (err) {
      logDiag('jira.waltz', 'warn', 'Could not load templates — proceeding without', {
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
    logDiag('jira.waltz', 'warn', `Could not fetch issue types — ${projectKey}, defaulting to 'Bug'`, {
      projectKey, error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    reportFileName: fileName,
    projectKey,
    components,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
  };
}

export async function streamWaltzTemplateSelection(
  session: WaltzTemplateSelectionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.waltzTemplateSelection', session);
  const { availableTemplates: templates, availableIssueTypes: issueTypes } = session;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  const offset = templates.length;
  optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;

  stream.markdown(
    `Found **${session.components.length}** component(s) in \`${session.reportFileName}\` matching your rating/remediation filters ` +
    `for project **${session.projectKey}**.\n\n${optionsList}` +
    `Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n<!-- jira:waltz-template -->`,
  );
}

// Entry point for the "importWaltzReport" operation. Handles both invocation paths:
//  1. Command-triggered — a WaltzTemplateSelectionSession is already in workspaceState (built by extension.ts).
//  2. Chat-only ("@jira import oss report" with no prior command) — opens its own file picker.
// projectKeyHint comes from the LLM-parsed intent.projectKey (e.g. "@jira import oss report for PROJ");
// resolveProjectKey() falls back to the defaultProject setting, then an input box, when it's null.
export async function handleImportWaltzReport(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  ws: vscode.Memento,
  projectKeyHint: string | null = null,
): Promise<void> {
  const existing = ws.get<WaltzTemplateSelectionSession>('jira.session.waltzTemplateSelection');
  if (existing) {
    await streamWaltzTemplateSelection(existing, stream, ws);
    return;
  }

  const picked = await openWaltzFilePicker(stream);
  if (!picked) return;
  if (picked.components.length === 0) {
    stream.markdown(
      'No components in this report matched your current filters ' +
      '(`ticketSidekick.waltz.minVulnRating` / `ticketSidekick.waltz.includeRemediationActions`).',
    );
    return;
  }

  const projectKey = await resolveProjectKey(projectKeyHint, stream);
  if (!projectKey) {
    stream.markdown('_No project key provided — cancelled._');
    return;
  }

  const session = await buildWaltzTemplateSession(picked.components, picked.fileName, projectKey, jiraClient);
  await streamWaltzTemplateSelection(session, stream, ws);
}

async function findAlreadyTicketed(
  ticketService: TicketService,
  projectKey: string,
  components: WaltzComponent[],
): Promise<Map<string, string>> {
  const labels = components.map(c => sanitizeComponentLabel(c.nameVersion));
  const map = new Map<string, string>();
  for (const chunk of chunkComponentLabels(labels)) {
    if (chunk.length === 0) continue;
    try {
      const jql = buildDedupJql(projectKey, chunk);
      const result = await ticketService.searchTicketsRaw(jql, 100);
      const found = extractDedupMap(result.issues.map(i => ({ key: i.key, fields: { labels: i.fields.labels } })));
      for (const [label, key] of found) map.set(label, key);
    } catch (err) {
      // One chunk failing (auth hiccup, transient network error) must not discard dedup matches
      // already found by earlier successful chunks — a caller-level catch-and-reset here would
      // silently re-treat those already-ticketed components as new, creating duplicate tickets.
      // Partial dedup coverage beats none.
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.waltz', 'warn', 'Dedup search chunk failed — continuing with partial results', {
        projectKey, chunkSize: chunk.length, error: message,
      });
    }
  }
  return map;
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
  if (isCancellation(reply)) {
    await ws.update('jira.session.waltzTemplateSelection', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates, session.availableIssueTypes);
  if (!pick) {
    stream.markdown(`Didn't understand that reply.\n\n`);
    await streamWaltzTemplateSelection(session, stream, ws);
    return;
  }
  await ws.update('jira.session.waltzTemplateSelection', undefined);

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
        } else {
          // The template was renamed or removed from .jira-templates.json between the list being
          // shown and this reply — additionalFields would otherwise silently stay {} with no signal,
          // unlike the thrown-error path right below, which does warn.
          logDiag('jira.waltz', 'warn', `Template no longer found — proceeding without it — ${pick.name}`, { templateName: pick.name });
          stream.markdown(
            `_Warning: template "${pick.name}" is no longer available — proceeding without its default fields._\n\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.waltz', 'warn', `Could not resolve template fields — ${pick.name}`, { templateName: pick.name, error: message });
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ${message}_\n\n`,
        );
      }
    }
  }

  stream.markdown(`_Checking for already-ticketed components…_\n\n`);
  const templateLabels = Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];

  // The template session was already cleared above, so a failure here must degrade gracefully
  // (mirroring the template-field-resolution step above it) rather than throw with nothing left
  // to resume from.
  let dedupMap: Map<string, string>;
  try {
    dedupMap = await findAlreadyTicketed(ticketService, session.projectKey, session.components);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.waltz', 'warn', 'Could not check for already-ticketed components — proceeding without dedup', {
      projectKey: session.projectKey, error: message,
    });
    stream.markdown(`_Warning: could not check for already-ticketed components — proceeding without dedup: ${message}_\n\n`);
    dedupMap = new Map();
  }

  // Cap "new" (not-yet-ticketed) components at BATCH_LIMIT *before* building full review rows —
  // buildReviewRows()/buildDescriptionWiki() does real work per row (sorting, Markdown-table
  // rendering, a full markdownToJiraWiki() pass), so filtering after the fact would build and then
  // discard that work for every excess "new" component on a report larger than one run's worth.
  // Already-ticketed rows are never capped. Re-running the import after this batch completes
  // surfaces the next BATCH_LIMIT new candidates for free, since the ones just created are now
  // dedup-matched.
  const componentsToBuild: WaltzComponent[] = [];
  let totalNewMatched = 0;
  let newSeen = 0;
  for (const component of session.components) {
    if (dedupMap.has(sanitizeComponentLabel(component.nameVersion))) {
      componentsToBuild.push(component); // already-ticketed — always included, never capped
      continue;
    }
    totalNewMatched++;
    if (newSeen < BATCH_LIMIT) {
      componentsToBuild.push(component);
      newSeen++;
    }
  }
  const rows = buildReviewRows(componentsToBuild, dedupMap, templateLabels);

  const reviewSession: WaltzReviewSession = {
    projectKey: session.projectKey,
    issueType: pick.issueType,
    templateName,
    additionalFields,
    rows,
    totalNewMatched,
  };
  await streamWaltzReview(reviewSession, stream, ws, baseUrl);
}

export async function streamWaltzReview(
  session: WaltzReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  await ws.update('jira.session.waltzReview', session);
  stream.markdown(`${buildWaltzReviewTable(session.rows, baseUrl, session.totalNewMatched)}\n\n<!-- jira:waltz-review -->`);
}

export async function handleWaltzReviewReply(
  reply: string,
  session: WaltzReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  const rowIds = session.rows.map(r => r.id);
  const decision = parseWaltzReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **ok** to proceed, **(c)** to cancel, ` +
      `or a list of ids to toggle (e.g. \`2 4\` or \`A1\`).\n\n<!-- jira:waltz-review -->`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update('jira.session.waltzReview', undefined);
    stream.markdown('_Cancelled — no tickets were created._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyWaltzToggle(session.rows, decision.ids);
    await streamWaltzReview(session, stream, ws, baseUrl);
    return;
  }

  // decision.action === 'ok'
  await ws.update('jira.session.waltzReview', undefined);
  await executeWaltzBatch(session, ticketService, stream, baseUrl);
}

export async function executeWaltzBatch(
  session: WaltzReviewSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): Promise<void> {
  const includedRows = session.rows.filter(r => r.included);
  const toCreate = includedRows.slice(0, BATCH_LIMIT);
  // "New" rows are already pre-capped at BATCH_LIMIT before the session is built (see
  // handleWaltzTemplateSelection), but a user can still toggle extra already-ticketed rows back to
  // "re-create", pushing the included count past the cap at execution time — droppedOverCap reflects
  // that real slicing outcome directly, rather than re-deriving it from a signal (rows.length or
  // totalNewMatched) that doesn't actually track whether *this* slice dropped anything.
  const droppedOverCap = includedRows.length - toCreate.length;
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
      const keyRef = key && baseUrl ? `[${key}](${baseUrl}/browse/${key})` : (key ?? '?');
      stream.markdown(`✓ ${keyRef} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.waltz', 'error', `Ticket creation failed — ${row.nameVersion}`, { nameVersion: row.nameVersion, error: message });
      stream.markdown(`✗ ${row.nameVersion} — ${message}\n\n`);
      failed++;
    }
  }

  const total = session.rows.length;
  let summary =
    `${total} component(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (droppedOverCap > 0) {
    summary += `\n\n_${droppedOverCap} included component(s) were not created — capped at ${BATCH_LIMIT} tickets per run. ` +
      `Re-run the import to process the remainder (already-created tickets are automatically skipped)._`;
  }
  logDiag('jira.waltz', failed > 0 ? 'warn' : 'info', `Waltz OSS import complete — ${created} created, ${failed} failed`, {
    total, created, failed, excludedByUser, alreadyTicketedSkipped,
  });
  stream.markdown(summary);
}
