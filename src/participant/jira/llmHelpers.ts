import * as vscode from 'vscode';
import { extractJsonObject } from '../../utils/extractJsonObject';

/** What `@jira` can still do: the report imports. Anything else is `other` and gets the imports-only notice. */
export type Operation =
  | 'createFromEmail'
  | 'addEmailComment'
  | 'importVeracode'
  | 'importWaltzReport'
  | 'other';

export interface ParsedIntent {
  operation: Operation;
  projectKey: string | null;
}

export const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"createFromEmail"|"addEmailComment"|"importVeracode"|"importWaltzReport"|"other","projectKey":string|null}
- createFromEmail: create a Jira ticket from an email (.eml file); triggered by "create from email", "ticket from email"
- addEmailComment: import an email (.eml) from the chat; if a ticket key is in the prompt (e.g. PROJ-42) adds the email as a comment, otherwise shows a preview to create or comment; triggered by "add email", "add email to", "import email", "email to ticket", "add comment from mail", "create ticket from mail", "create from mail"
- importVeracode: import a Veracode Detailed Report XML export and create Jira tickets from its flaws; triggered by "import veracode", "veracode report", "create tickets from veracode", "veracode scan"; projectKey is the project key if one is named
- importWaltzReport: import a Waltz/SCA OSS report .xlsx export and create Jira tickets from its vulnerable components; triggered by "import oss report", "import waltz report", "oss report", "sca report"; projectKey is the project key if one is named
- other: anything else, e.g. showing, creating, commenting on, moving or searching tickets, cleanup, workflows or reports

Command: `;

export async function sendAndCollect(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<string> {
  const response = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text;
}

const RETRY_ON_BAD_JSON = 'Your last reply was not a valid JSON object. Reply again with ONLY the JSON object, no other text.';

export async function parseIntent(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<ParsedIntent> {
  const roleSetup = vscode.LanguageModelChatMessage.User(
    'You are a Jira intent parser. Your task is to analyze user commands and produce structured intent as a JSON object matching the schema below.',
  );
  const roleAck = vscode.LanguageModelChatMessage.Assistant(
    'Understood. I parse Jira commands into structured JSON.',
  );
  const task = vscode.LanguageModelChatMessage.User(INTENT_PROMPT + JSON.stringify(prompt));
  const messages = [roleSetup, roleAck, task];
  let raw = await sendAndCollect(model, messages, token);
  let jsonText = extractJsonObject(raw);
  if (!jsonText) {
    // One retry: feed the unparseable reply back and ask again, before giving up.
    messages.push(
      vscode.LanguageModelChatMessage.Assistant(raw),
      vscode.LanguageModelChatMessage.User(RETRY_ON_BAD_JSON),
    );
    raw = await sendAndCollect(model, messages, token);
    jsonText = extractJsonObject(raw);
  }
  if (!jsonText) throw new Error(`Model did not return a JSON object. Response: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(jsonText) as Partial<ParsedIntent>;
  const operations: readonly Operation[] = ['createFromEmail', 'addEmailComment', 'importVeracode', 'importWaltzReport'];
  return {
    operation: operations.includes(parsed.operation as Operation) ? parsed.operation as Operation : 'other',
    projectKey: typeof parsed.projectKey === 'string' ? parsed.projectKey : null,
  };
}

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
