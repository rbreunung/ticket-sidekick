import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { EmailContentSession } from '../sessionState';
import { isCancellation, isConfirmation, pickEmailOption } from '../sessionState';

export async function handleCreateFromEmail(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  _jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  const session = ws.get<EmailContentSession>('jira.session.emailContent');
  if (!session) {
    stream.markdown(
      'No email loaded. Use **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)** to import an email first.',
    );
    return;
  }
  await streamEmailContentPreview(session, stream, ws);
}

export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  jiraClient: IJiraClient,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
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
        } catch { /* proceed without template fields */ }
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
  stream.markdown(`_Reply with a number, **post it** to create as **${session.issueType}**, or **(c)** to cancel._`);
  await streamEmailContentPreview(session, stream, ws);
}

async function streamEmailContentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
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

  const prompt = hasOptions
    ? `${optionsList}Reply with a number to select, **post it** to create as **${session.issueType}**, or **(c)** to cancel.`
    : `Reply **post it** to create the Jira ticket in **${session.projectKey}** as **${session.issueType}**, or **(c)** to cancel.`;

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

async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  let jiraWiki = markdownToJiraWiki(session.markdownBody);
  jiraWiki = jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');

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

  const toUpload = session.attachments.filter(a => !a.isInline);
  if (issueKey && toUpload.length > 0) {
    let uploaded = 0;
    await Promise.all(
      toUpload.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
          }),
      ),
    );
    stream.markdown(`\n\nUploaded ${uploaded} of ${toUpload.length} attachment(s).\n\n<!-- @jira-ticket:${issueKey} -->`);
  } else if (issueKey) {
    stream.markdown(`\n\n<!-- @jira-ticket:${issueKey} -->`);
  }

  if (issueKey && session.emlFilePath) {
    const deleteAfter = vscode.workspace.getConfiguration('ticketSidekick').get<boolean>('email.deleteEmlAfterImport', false);
    if (deleteAfter) {
      await fs.promises.unlink(session.emlFilePath).catch(() => {});
    }
  }
}
