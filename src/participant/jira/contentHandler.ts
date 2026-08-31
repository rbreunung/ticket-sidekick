import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import type { ContentSession } from '../sessionState';
import { isCancellation, isConfirmation } from '../sessionState';
import { generateContent, isLmRefusal, buildHistoryContext } from './llmHelpers';

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
    } catch (err) {
      logDiag('jira.content', 'warn', `Could not read referenced file — ${uri.fsPath}`, {
        path: uri.fsPath, error: err instanceof Error ? err.message : String(err),
      });
    }
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
  contentSource: 'generate' | 'history-recent' | 'history-full' = 'history-full',
): Promise<string> {
  const parts: string[] = [];

  const fileContent = await gatherFileContent(request.references, chatContext.history);
  if (fileContent) parts.push(`**Attached files:**\n\n${fileContent}`);

  const historyText = buildHistoryContext(contentSource, chatContext);
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
  baseUrl?: string,
): Promise<void> {
  if (isCancellation(prompt)) {
    await workspaceState.update('jira.session.previewing', undefined);
    stream.markdown('_Cancelled._');
    return;
  }
  if (isConfirmation(prompt)) {
    await workspaceState.update('jira.session.previewing', undefined);
    if (session.operation === 'createTicket') {
      const fields: Record<string, unknown> = { ...session.extraFields };
      delete fields.description;
      if (session.currentContent) {
        fields.description = markdownToJiraWiki(session.currentContent);
      }
      const created = await ticketService.createTicket(
        session.projectKey,
        session.summary,
        session.issueType,
        fields,
        baseUrl,
      );
      // Real success point (KTD9): createTicket resolved without throwing — a walkthrough step
      // watching this must never fire on an attempted-but-failed create.
      await vscode.commands.executeCommand('setContext', 'ticketSidekick.firstTicketCreated', true);
      stream.markdown(created.message);
      stream.markdown(`\n\n<!-- @jira-ticket:${created.key} -->`);
      return;
    }
    let result: string;
    const jiraText = markdownToJiraWiki(session.currentContent);
    if (session.operation === 'addComment') {
      result = await ticketService.addComment(session.ticketKey, jiraText, baseUrl);
    } else {
      result = await ticketService.updateField(session.ticketKey, 'description', jiraText, baseUrl);
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
  const contentSource = session.operation !== 'createTicket' ? session.contentSource : undefined;
  const refined = await generateContent(prompt, model, token, refineContext, contentSource);
  if (isLmRefusal(refined)) {
    stream.markdown(`_Could not refine content — the AI model declined the request. Try rephrasing your instruction._`);
    await streamContentPreview(session, stream, workspaceState);
    return;
  }
  await streamContentPreview({ ...session, currentContent: refined }, stream, workspaceState);
}
