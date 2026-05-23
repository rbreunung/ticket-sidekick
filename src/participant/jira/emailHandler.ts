import * as vscode from 'vscode';
import { OutlookApiClient } from '../../outlook/OutlookApiClient';
import { createOutlookTokenProvider } from '../../outlook/tokenProviders';
import { OutlookService } from '../../services/OutlookService';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import type { FolderSelectionSession, EmailSelectionSession, EmailContentSession } from '../sessionState';
import { isCancellation, isConfirmation } from '../sessionState';

export async function handleCreateFromEmail(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  _jiraClient: IJiraClient,
  _ticketService: TicketService,
  configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  const outlookConfig = await configService.getOutlookConfig();
  const tokenProvider = createOutlookTokenProvider(configService.getOutlookAuthProvider(), configService);
  const outlookService = new OutlookService(new OutlookApiClient(tokenProvider));

  if (!outlookConfig.folderId) {
    let folders: Array<{ id: string; displayName: string; unreadItemCount: number }>;
    try {
      folders = await outlookService.getFolders();
    } catch (err) {
      stream.markdown(`**Could not list Outlook folders:** ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const list = folders.map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`).join('\n');
    const session: FolderSelectionSession = { folders };
    await ws.update('jira.session.folderSelection', session);
    stream.markdown(`Which folder should I list emails from?\n\n${list}\n\nReply with a number to select, or **(c)** to cancel.\n\n<!-- jira:folder-selection -->`);
    return;
  }

  let emails: Array<{ id: string; subject: string; receivedDateTime: string; senderName: string }>;
  try {
    emails = await outlookService.getEmails(outlookConfig.folderId, outlookConfig.emailListSize);
  } catch (err) {
    stream.markdown(`**Could not list emails:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (emails.length === 0) {
    stream.markdown('No emails found in the configured folder.');
    return;
  }
  const list = emails.map((e, i) => `${i + 1}. [${e.receivedDateTime.slice(0, 10)}] ${e.subject} (${e.senderName})`).join('\n');
  const session: EmailSelectionSession = { folderId: outlookConfig.folderId, emails };
  await ws.update('jira.session.emailSelection', session);
  stream.markdown(`${list}\n\nReply with a number to select an email, or **(c)** to cancel.\n\n<!-- jira:email-selection -->`);
}

export async function handleFolderSelection(
  reply: string,
  session: FolderSelectionSession,
  configService: ConfigService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.folderSelection', undefined);
  if (isCancellation(reply)) { stream.markdown('_Cancelled._'); return; }
  const n = parseInt(reply.trim(), 10);
  if (isNaN(n) || n < 1 || n > session.folders.length) {
    await ws.update('jira.session.folderSelection', session);
    const list = session.folders.map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`).join('\n');
    stream.markdown(`Please reply with a number between 1 and ${session.folders.length}, or **(c)** to cancel.\n\n${list}\n\n<!-- jira:folder-selection -->`);
    return;
  }
  const chosen = session.folders[n - 1];
  await configService.saveOutlookFolderId(chosen.id);
  const outlookConfig = await configService.getOutlookConfig();
  const tokenProvider = createOutlookTokenProvider(configService.getOutlookAuthProvider(), configService);
  const outlookService = new OutlookService(new OutlookApiClient(tokenProvider));
  const emails = await outlookService.getEmails(chosen.id, outlookConfig.emailListSize);
  const emailList = emails.map((e, i) => `${i + 1}. [${e.receivedDateTime.slice(0, 10)}] ${e.subject} (${e.senderName})`).join('\n');
  const emailSession: EmailSelectionSession = { folderId: chosen.id, emails };
  await ws.update('jira.session.emailSelection', emailSession);
  stream.markdown(`Folder set to **${chosen.displayName}**.\n\n${emailList}\n\nReply with a number to select an email, or **(c)** to cancel.\n\n<!-- jira:email-selection -->`);
}

export async function handleEmailSelection(
  reply: string,
  session: EmailSelectionSession,
  stream: vscode.ChatResponseStream,
  configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.emailSelection', undefined);
  if (isCancellation(reply)) { stream.markdown('_Cancelled._'); return; }
  const n = parseInt(reply.trim(), 10);
  if (isNaN(n) || n < 1 || n > session.emails.length) {
    await ws.update('jira.session.emailSelection', session);
    const list = session.emails.map((e, i) => `${i + 1}. [${e.receivedDateTime.slice(0, 10)}] ${e.subject} (${e.senderName})`).join('\n');
    stream.markdown(`Please reply with a number between 1 and ${session.emails.length}, or **(c)** to cancel.\n\n${list}\n\n<!-- jira:email-selection -->`);
    return;
  }
  const chosen = session.emails[n - 1];

  const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  if (!projectKey) {
    stream.markdown('**No default project configured.** Set `ticketSidekick.jira.defaultProject` in VS Code settings and try again.');
    return;
  }

  stream.markdown(`_Fetching email…_`);
  const tokenProvider = createOutlookTokenProvider(configService.getOutlookAuthProvider(), configService);
  const outlookService = new OutlookService(new OutlookApiClient(tokenProvider));
  const { subject, markdownBody, inlineImageMap, attachments } = await outlookService.fetchEmailForTicket(chosen.id);

  const contentSession: EmailContentSession = {
    emailId: chosen.id, subject, markdownBody, inlineImageMap, attachments,
    selectedTemplateName: null, projectKey, issueType: 'Task', additionalFields: {},
  };
  await streamEmailContentPreview(contentSession, stream, ws);
}

export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await finishEmailTicket(session, ticketService, stream);
    return;
  }
  stream.markdown(`_Reply **post it** to create the ticket or **(c)** to cancel._`);
  await streamEmailContentPreview(session, stream, ws);
}

async function streamEmailContentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  stream.markdown(
    `**Subject (summary):** ${session.subject}\n\n` +
    `**Description preview:**\n\n${session.markdownBody}\n\n` +
    `Reply **post it** to create the Jira ticket in **${session.projectKey}**, or **(c)** to cancel.\n\n<!-- jira:email-content -->`,
  );
}

async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  let jiraWiki = markdownToJiraWiki(session.markdownBody);
  jiraWiki = jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');

  const result = await ticketService.createTicket(
    session.projectKey, session.subject, session.issueType,
    { ...session.additionalFields, description: jiraWiki },
  );
  stream.markdown(result);

  const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
  const issueKey = keyMatch?.[1];
  if (issueKey && session.attachments.length > 0) {
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes).catch(err => {
          stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
        }),
      ),
    );
    stream.markdown(`\n\nUploaded ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${issueKey} -->`);
  } else if (issueKey) {
    stream.markdown(`\n\n<!-- @jira-ticket:${issueKey} -->`);
  }
}
