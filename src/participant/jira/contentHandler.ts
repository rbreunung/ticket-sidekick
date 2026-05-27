import * as vscode from 'vscode';
import type { TicketService } from '../../services/TicketService';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import type { ContentSession } from '../sessionState';
import { isCancellation, isConfirmation, serializeTurns } from '../sessionState';
import { generateContent, isLmRefusal, extractHistoryTurns } from './llmHelpers';

export const FILE_MAX_BYTES = 60_000;

export async function gatherFileContent(
  currentRefs: readonly vscode.ChatPromptReference[],
  history: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>,
): Promise<string> {
  const seen = new Set<string>();
  const sections: string[] = [];
  const decoder = new TextDecoder('utf-8');

  const readUri = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const name = uri.path.split('/').pop() ?? uri.fsPath;
      const truncated = bytes.byteLength > FILE_MAX_BYTES;
      const slice = truncated ? bytes.slice(0, FILE_MAX_BYTES) : bytes;
      const text = decoder.decode(slice) + (truncated ? '\n\n[... truncated ...]' : '');
      sections.push(`### ${name}\n\`\`\`\n${text}\n\`\`\``);
    } catch { /* skip unreadable files */ }
  };

  const processRef = async (ref: vscode.ChatPromptReference): Promise<void> => {
    if (ref.value instanceof vscode.Uri) {
      await readUri(ref.value);
    } else if (ref.value instanceof vscode.Location) {
      await readUri((ref.value as vscode.Location).uri);
    }
  };

  for (const ref of currentRefs) await processRef(ref);
  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      for (const ref of turn.references) await processRef(ref);
    }
  }

  return sections.join('\n\n');
}

export async function buildContentContext(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  ticketText: string,
  commentBlocks: string,
): Promise<string> {
  const parts: string[] = [];

  const fileContent = await gatherFileContent(request.references, chatContext.history);
  if (fileContent) parts.push(`**Attached files:**\n\n${fileContent}`);

  const historyText = serializeTurns(extractHistoryTurns(chatContext), 'full');
  if (historyText) parts.push(`**Conversation history:**\n\n${historyText}`);

  const ticketSection = commentBlocks
    ? `${ticketText}\n\n**Comments:**\n\n${commentBlocks}`
    : ticketText;
  parts.push(`**Ticket:**\n\n${ticketSection}`);

  return parts.join('\n\n---\n\n');
}

export async function streamContentPreview(session: ContentSession, stream: vscode.ChatResponseStream, workspaceState: vscode.Memento): Promise<void> {
  await workspaceState.update('jira.session.previewing', session);
  if (session.operation === 'createTicket') {
    const templateLine = session.templateName ? `  |  **Template:** ${session.templateName}` : '';
    const descSection = session.currentContent
      ? `\n\n**Description:**\n${session.currentContent}`
      : '';
    stream.markdown(
      `**Summary:** ${session.summary}\n**Type:** ${session.issueType}  |  **Project:** ${session.projectKey}${templateLine}${descSection}\n\nReply **"create it"** to create the ticket, or tell me how to adjust the description.\n\n<!-- jira:previewing -->`,
    );
    return;
  }
  const actionLabel = session.operation === 'addComment' ? 'post this comment' : 'update the description';
  stream.markdown(
    `${session.currentContent}\n\nReply **"post it"** to ${actionLabel}, or tell me how to adjust it.\n\n<!-- jira:previewing -->`,
  );
}

export async function handleContentSession(
  session: ContentSession,
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
): Promise<void> {
  if (isCancellation(prompt)) {
    await workspaceState.update('jira.session.previewing', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(prompt)) {
    await workspaceState.update('jira.session.previewing', undefined);
    if (session.operation === 'createTicket') {
      const jiraDescription = markdownToJiraWiki(session.currentContent);
      const result = await ticketService.createTicket(
        session.projectKey,
        session.summary,
        session.issueType,
        {
          ...(session.currentContent ? { description: jiraDescription } : {}),
          ...session.extraFields,
        },
      );
      stream.markdown(result);
      const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
      if (keyMatch) {
        stream.markdown(`\n\n<!-- @jira-ticket:${keyMatch[1]} -->`);
      }
      return;
    }
    let result: string;
    const jiraText = markdownToJiraWiki(session.currentContent);
    if (session.operation === 'addComment') {
      result = await ticketService.addComment(session.ticketKey, jiraText);
    } else {
      result = await ticketService.updateField(session.ticketKey, 'description', jiraText);
    }
    stream.markdown(result);
    stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->`);
    return;
  }
  // Refinement instruction
  const historyContext = session.operation !== 'createTicket' ? session.historyContext : undefined;
  const refineContext = [historyContext, `Previously generated:\n${session.currentContent}`]
    .filter(Boolean)
    .join('\n\n');
  const refined = await generateContent(prompt, model, token, refineContext);
  if (isLmRefusal(refined)) {
    stream.markdown(`_Could not refine content — the AI model declined the request. Try rephrasing your instruction._`);
    await streamContentPreview(session, stream, workspaceState);
    return;
  }
  await streamContentPreview({ ...session, currentContent: refined }, stream, workspaceState);
}
