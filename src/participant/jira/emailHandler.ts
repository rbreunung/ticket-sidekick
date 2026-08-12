import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { parseEml, type ParsedEml } from '../../utils/emlParser';
import { htmlToMarkdown } from '../../utils/htmlToMarkdown';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { EmailContentSession } from '../sessionState';
import { isCancellation, isConfirmation, pickEmailOption, selectDefaultIssueType } from '../sessionState';

export async function handleCreateFromEmail(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  let session = ws.get<EmailContentSession>('jira.session.emailContent');

  // No session — run inline file-picker so the flow works from chat alone
  if (!session) {
    const newSession = await openEmailFilePicker(jiraClient, stream);
    if (!newSession) return;
    await streamEmailContentPreview(newSession, stream, ws);
    return;
  }

  // Session exists but issue types missing (getProject may have failed at command time) — retry
  if (!session.availableIssueTypes?.length && session.projectKey && session.projectKey !== 'UNKNOWN') {
    try {
      const project = await jiraClient.getProject(session.projectKey);
      const issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
      if (issueTypes.length > 0) {
        session = { ...session, availableIssueTypes: issueTypes, issueType: selectDefaultIssueType(issueTypes) };
      }
    } catch (err) {
      logDiag('jira.email', 'warn', `Could not refresh issue types — ${session.projectKey}`, {
        projectKey: session.projectKey, error: err instanceof Error ? err.message : String(err),
      });
      // use session as-is; simplified prompt still functional
    }
  }

  await streamEmailContentPreview(session, stream, ws);
}

export async function handleAddEmailFromChat(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  // Extract ticket key from prompt if present (e.g. "add email to PROJ-42")
  const ticketKeyMatch = request.prompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  const promptTicketKey = ticketKeyMatch?.[1]?.toUpperCase() ?? null;

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Email: ['eml'] },
    title: 'Select .eml file to import',
  });
  if (!uris || uris.length === 0) return;

  const emlPath = uris[0].fsPath;
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not read file: ${message}_`);
    return;
  }

  let parsed;
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not parse email: ${message}_`);
    return;
  }

  const markdownBody = parsed.htmlBody
    ? htmlToMarkdown(parsed.htmlBody, parsed.inlineImageMap)
    : (parsed.plainBody ?? '');

  const inlineImageMap: Record<string, string> = {};
  for (const [k, v] of parsed.inlineImageMap) {
    inlineImageMap[k] = v;
  }
  const attachments = parsed.attachments.map(a => ({
    name: a.name,
    contentType: a.contentType,
    contentBytes: a.contentBytes,
    isInline: a.isInline,
  }));

  // If a ticket key was in the prompt, show comment preview before posting
  if (promptTicketKey) {
    const quickSession: EmailContentSession = {
      emailId: 'eml-import',
      subject: parsed.subject,
      senderName: parsed.senderName,
      receivedDateTime: parsed.receivedDateTime,
      markdownBody,
      inlineImageMap,
      attachments,
      emlFilePath: emlPath,
      selectedTemplateName: null,
      projectKey: '',
      issueType: 'Story',
      additionalFields: {},
      pendingCommentTicketKey: promptTicketKey,
    };
    await streamEmailCommentPreview(quickSession, stream, ws);
    return;
  }

  // No ticket key — build full session and show preview so user can choose
  const session = await buildEmailCreateSession(parsed, emlPath, markdownBody, inlineImageMap, attachments, jiraClient);
  await streamEmailContentPreview(session, stream, ws);
}

// Builds a full EmailContentSession from already-parsed email data, loading templates and issue types.
async function buildEmailCreateSession(
  parsed: ParsedEml,
  emlPath: string,
  markdownBody: string,
  inlineImageMap: Record<string, string>,
  attachments: EmailContentSession['attachments'],
  jiraClient: IJiraClient,
): Promise<EmailContentSession> {
  const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
    } catch (err) {
      logDiag('jira.email', 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();

  let issueTypes: string[] = [];
  if (projectKey) {
    try {
      const project = await jiraClient.getProject(projectKey);
      issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
    } catch (err) {
      logDiag('jira.email', 'warn', `Could not fetch issue types — ${projectKey}`, {
        projectKey, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    emailId: 'eml-import',
    subject: parsed.subject,
    senderName: parsed.senderName,
    receivedDateTime: parsed.receivedDateTime,
    markdownBody,
    inlineImageMap,
    attachments,
    emlFilePath: emlPath,
    selectedTemplateName: null,
    projectKey: projectKey || 'UNKNOWN',
    issueType: selectDefaultIssueType(issueTypes),
    additionalFields: {},
    availableTemplates: availableTemplates.length > 0 ? availableTemplates : undefined,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : undefined,
  };
}

// Shows an .eml file picker, parses the email, and builds a full EmailContentSession.
// Returns null if the user cancelled the file picker or if read/parse failed.
async function openEmailFilePicker(
  jiraClient: IJiraClient,
  stream: vscode.ChatResponseStream,
): Promise<EmailContentSession | null> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { Email: ['eml'] },
    title: 'Select .eml file to import',
  });
  if (!uris || uris.length === 0) return null;

  const emlPath = uris[0].fsPath;
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not read file: ${message}_`);
    return null;
  }

  let parsed: ParsedEml;
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not parse email: ${message}_`);
    return null;
  }

  const markdownBody = parsed.htmlBody
    ? htmlToMarkdown(parsed.htmlBody, parsed.inlineImageMap)
    : (parsed.plainBody ?? '');

  const inlineImageMap: Record<string, string> = {};
  for (const [k, v] of parsed.inlineImageMap) {
    inlineImageMap[k] = v;
  }
  const attachments = parsed.attachments.map(a => ({
    name: a.name,
    contentType: a.contentType,
    contentBytes: a.contentBytes,
    isInline: a.isInline,
  }));

  return buildEmailCreateSession(parsed, emlPath, markdownBody, inlineImageMap, attachments, jiraClient);
}

export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  jiraClient: IJiraClient,
): Promise<void> {
  // Pending comment confirmation flow — user is reviewing before posting
  if (session.pendingCommentTicketKey) {
    if (isCancellation(reply)) {
      await ws.update('jira.session.emailContent', undefined);
      stream.markdown('_Cancelled._');
      return;
    }
    if (isConfirmation(reply)) {
      await ws.update('jira.session.emailContent', undefined);
      await addEmailAsComment(session.pendingCommentTicketKey, session, ticketService, stream);
      return;
    }
    const pendingKeyMatch = reply.trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
    if (pendingKeyMatch) {
      await streamEmailCommentPreview({ ...session, pendingCommentTicketKey: pendingKeyMatch[1].toUpperCase() }, stream, ws);
      return;
    }
    await streamEmailCommentPreview(session, stream, ws);
    return;
  }

  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }

  // Ticket key reply → show comment preview before posting
  const ticketKeyMatch = reply.trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
  if (ticketKeyMatch) {
    await streamEmailCommentPreview({ ...session, pendingCommentTicketKey: ticketKeyMatch[1].toUpperCase() }, stream, ws);
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates ?? [], session.availableIssueTypes ?? []);
  if (pick) {
    await ws.update('jira.session.emailContent', undefined);
    let additionalFields = session.additionalFields;
    if (pick.kind === 'template') {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      if (workspaceRoot) {
        try {
          const { templates } = new TemplateService(workspaceRoot).loadTemplates();
          const fullTemplate = templates.find(t => t.name === pick.name);
          if (fullTemplate) {
            const resolver = new FieldResolver(jiraClient, session.projectKey);
            const resolved = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
            additionalFields = { ...resolved, ...session.additionalFields };
          }
        } catch (err) {
          logDiag('jira.email', 'warn', `Could not resolve template fields — ${pick.name}`, {
            templateName: pick.name, error: err instanceof Error ? err.message : String(err),
          });
          // proceed without template fields
        }
      }
    }
    const overrides = pick.kind === 'template'
      ? { issueType: pick.issueType, selectedTemplateName: pick.name, additionalFields }
      : { issueType: pick.issueType };
    await finishEmailTicket({ ...session, ...overrides }, ticketService, stream);
    return;
  }

  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await finishEmailTicket(session, ticketService, stream);
    return;
  }
  stream.markdown(`_Reply with a number, a ticket key (e.g. \`PROJ-42\`), **post it** to create as **${session.issueType}**, or **(c)** to cancel._`);
  await streamEmailContentPreview(session, stream, ws);
}

// Pure helper — converts markdown email body to Jira Wiki markup with inline-image placeholders resolved
export function buildEmailJiraWiki(markdownBody: string): string {
  let jiraWiki = markdownToJiraWiki(markdownBody);
  jiraWiki = jiraWiki.replace(/\n{3,}/g, '\n\n');
  return jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');
}

// Pure helper — builds the From/Date comment header
export function buildEmailCommentHeader(senderName?: string, receivedDateTime?: string): string {
  const parts: string[] = [];
  if (senderName) parts.push(`*From:* ${senderName}`);
  if (receivedDateTime) parts.push(`*Date:* ${receivedDateTime.slice(0, 10)}`);
  return parts.length > 0 ? parts.join('  ·  ') + '\n\n' : '';
}

export async function addEmailAsComment(
  ticketKey: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const jiraWiki = buildEmailJiraWiki(session.markdownBody);
  const header = buildEmailCommentHeader(session.senderName, session.receivedDateTime);
  const commentBody = `${header}${jiraWiki}`;

  await ticketService.addComment(ticketKey, commentBody);
  stream.markdown(`Added comment to **${ticketKey}**.`);

  if (session.attachments.length > 0) {
    let uploaded = 0;
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(ticketKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { ticketKey, fileName: att.name, error: message });
            stream.markdown(`_Warning: could not upload ${att.name}: ${message}_`);
          }),
      ),
    );
    stream.markdown(`Uploaded ${uploaded} of ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${ticketKey} -->`);
  } else {
    stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
  }
}

export async function streamEmailCommentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  const key = session.pendingCommentTicketKey!;

  const headerLines: string[] = [];
  if (session.senderName || session.receivedDateTime) {
    const fromPart = session.senderName ? `**From:** ${session.senderName}` : '';
    const datePart = session.receivedDateTime ? `**Date:** ${session.receivedDateTime.slice(0, 10)}` : '';
    if (fromPart && datePart) headerLines.push(`${fromPart} · ${datePart}`);
    else headerLines.push(fromPart || datePart);
  }
  headerLines.push(`**Subject:** ${session.subject}`);
  const nonInlineAttachments = session.attachments.filter(a => !a.isInline);
  if (nonInlineAttachments.length > 0) {
    headerLines.push(`**Attachments:** ${nonInlineAttachments.map(a => a.name).join(', ')}`);
  }

  stream.markdown(
    `${headerLines.join('\n')}\n\n` +
    `**Comment preview:**\n\n${session.markdownBody}\n\n` +
    `Reply **post it** to add as comment to **${key}**, or **(c)** to cancel.\n\n<!-- jira:email-content -->`,
  );
}

export async function streamEmailContentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  const templates = session.availableTemplates ?? [];
  const issueTypes = session.availableIssueTypes ?? [];
  const hasOptions = templates.length > 0 || issueTypes.length > 0;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  if (issueTypes.length > 0) {
    const offset = templates.length;
    optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;
  }

  const commentHint = '\n\nOr reply with a ticket key (e.g. `PROJ-42`) to add this email as a comment to an existing ticket.';
  const prompt = hasOptions
    ? `${optionsList}Reply with a number to select, **post it** to create as **${session.issueType}**, or **(c)** to cancel.${commentHint}`
    : `Reply **post it** to create the Jira ticket in **${session.projectKey}** as **${session.issueType}**, or **(c)** to cancel.${commentHint}`;

  const headerLines: string[] = [];
  if (session.senderName || session.receivedDateTime) {
    const fromPart = session.senderName ? `**From:** ${session.senderName}` : '';
    const datePart = session.receivedDateTime ? `**Date:** ${session.receivedDateTime.slice(0, 10)}` : '';
    if (fromPart && datePart) headerLines.push(`${fromPart} · ${datePart}`);
    else headerLines.push(fromPart || datePart);
  }
  headerLines.push(`**Subject:** ${session.subject}`);
  const nonInlineAttachments = session.attachments.filter(a => !a.isInline);
  if (nonInlineAttachments.length > 0) {
    headerLines.push(`**Attachments:** ${nonInlineAttachments.map(a => a.name).join(', ')}`);
  }

  stream.markdown(
    `${headerLines.join('\n')}\n\n` +
    `**Description preview:**\n\n${session.markdownBody}\n\n` +
    `${prompt}\n\n<!-- jira:email-content -->`,
  );
}

export async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  const jiraWiki = buildEmailJiraWiki(session.markdownBody);

  const result = await ticketService.createTicket(
    session.projectKey, session.subject, session.issueType,
    { ...session.additionalFields, description: jiraWiki },
  );

  const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
  const issueKey = keyMatch?.[1];
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';
  const linkMsg = issueKey && baseUrl
    ? `Ticket **[${issueKey}](${baseUrl}/browse/${issueKey})** created.`
    : result;
  stream.markdown(linkMsg);

  // Upload all attachments — inline images are referenced in the description and must exist as attachments
  if (issueKey && session.attachments.length > 0) {
    let uploaded = 0;
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { issueKey, fileName: att.name, error: message });
            stream.markdown(`_Warning: could not upload ${att.name}: ${message}_`);
          }),
      ),
    );
    stream.markdown(`\n\nUploaded ${uploaded} of ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${issueKey} -->`);
  } else if (issueKey) {
    stream.markdown(`\n\n<!-- @jira-ticket:${issueKey} -->`);
  }

  if (issueKey && session.emlFilePath) {
    const deleteAfter = vscode.workspace.getConfiguration('ticketSidekick').get<boolean>('email.deleteEmlAfterImport', false);
    if (deleteAfter) {
      await fs.promises.unlink(session.emlFilePath).catch((err: unknown) => {
        logDiag('jira.email', 'warn', `Could not delete .eml after import — ${session.emlFilePath}`, {
          emlFilePath: session.emlFilePath, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}
