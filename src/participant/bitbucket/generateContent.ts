import * as vscode from 'vscode';

// The one free-text model call `@bitbucket` makes outside its review pipeline: a Jira comment or
// description text from an instruction and optional context.

export async function generateContent(
  instruction: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  context?: string,
  contentSource?: 'generate' | 'history-recent' | 'history-full',
): Promise<string> {
  const isHistoryBased = contentSource === 'history-recent' || contentSource === 'history-full';
  const roleText = isHistoryBased
    ? 'You are a technical scribe for a software development team. Your task is to synthesize findings from a conversation into a concise Jira comment.'
    : 'You are a Jira assistant. Your task is to write Jira comment and description text. Content may include prose summaries, code snippets, patches, or any technical material appropriate for a Jira comment.';
  const roleAckText = isHistoryBased
    ? 'Understood. I synthesize conversation findings into concise Jira comments.'
    : 'Understood. I write Jira comment and description text, including any technical content such as code or patches.';
  const roleSetup = vscode.LanguageModelChatMessage.User(roleText);
  const roleAck = vscode.LanguageModelChatMessage.Assistant(roleAckText);
  let task: string;
  if (context) {
    const groundingNote = isHistoryBased
      ? '\n\nUse the CONVERSATION HISTORY as your primary source. The ticket text is reference context only — do not simply rephrase findings already stated in the ticket or its existing comments. Do not add information not present in the provided sources.'
      : '';
    task = `Available context:\n\n${context}${groundingNote}\n\nUsing the context above, write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`;
  } else {
    task = `Write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`;
  }
  const response = await model.sendRequest(
    [roleSetup, roleAck, vscode.LanguageModelChatMessage.User(task)],
    {},
    token,
  );
  let content = '';
  for await (const chunk of response.text) {
    content += chunk;
  }
  return content.trim();
}
