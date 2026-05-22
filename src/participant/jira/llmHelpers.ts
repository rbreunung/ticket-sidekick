import * as vscode from 'vscode';
import { serializeTurns, stripHiddenMarkers } from '../sessionState';

export type Operation =
  | 'getTicket'
  | 'summarizeTicket'
  | 'showComments'
  | 'getComments'
  | 'addComment'
  | 'updateField'
  | 'showFields'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket'
  | 'discoverWorkflow'
  | 'runCleanup'
  | 'transition'
  | 'bulkTransition'
  | 'bulkUpdateField'
  | 'loadTicket'
  | 'spellCheck'
  | 'createFromEmail';

export interface FieldUpdate {
  fieldName: string;
  fieldValue: string;
}

export interface ParsedIntent {
  operation: Operation;
  ticketKey: string | null;
  projectKey: string | null;
  summary: string | null;
  issueType: string | null;
  assignee: string | null;
  components: string | null;
  description: string | null;
  comment: string | null;
  commentQuery: string | null;
  contentSource: 'literal' | 'generate' | 'history-recent' | 'history-full';
  fieldUpdates: FieldUpdate[];
  fieldName: string | null;
  fieldValue: string | null;
  arrayOp: 'set' | 'add' | 'remove';
  scope: 'single' | 'bulk' | null;
  jql: string | null;
  filterId: string | null;
  filterName: string | null;
  targetStatus: string | null;
  bulkFieldName: string | null;
  bulkFieldValue: string | null;
  cleanupRuleName: string | null;
  fixVersion: string | null;
  resolution: string | null;
}

export const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"summarizeTicket"|"showComments"|"getComments"|"addComment"|"updateField"|"showFields"|"searchJql"|"validateFields"|"createTicket"|"discoverWorkflow"|"runCleanup"|"transition"|"bulkTransition"|"bulkUpdateField"|"loadTicket"|"spellCheck"|"createFromEmail","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"assignee":string|null,"components":string|null,"description":string|null,"comment":string|null,"commentQuery":string|null,"contentSource":"literal"|"generate"|"history-recent"|"history-full","fieldUpdates":[{"fieldName":string,"fieldValue":string}],"fieldName":string|null,"fieldValue":string|null,"arrayOp":"set"|"add"|"remove","scope":"single"|"bulk"|null,"jql":string|null,"filterId":string|null,"filterName":string|null,"targetStatus":string|null,"bulkFieldName":string|null,"bulkFieldValue":string|null,"cleanupRuleName":string|null,"fixVersion":string|null,"resolution":string|null}
- getTicket: show, display, look up a specific ticket; returns all non-null fields, description, and one-line comment summaries
- summarizeTicket: summarise, summarize, tl;dr, give me an overview; produces a prose paragraph covering the ticket and its comments together
- showComments: show, list, display all comments in full; shows the actual comment bodies numbered; use when user wants to read the comment text rather than a summary
- getComments: ask what comments say, find or filter comments by topic; synthesises or queries comments; commentQuery is the topic/filter the user mentioned (e.g. "login bug", "performance") — null if they just want a general synthesis
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update a field on a ticket; use fieldName (human-readable field name or ID) and fieldValue (raw value string, comma-separated for arrays); arrayOp is "set" by default, "add" when the user says "add X to field", "remove" when the user says "remove X from field"; scope is "single" when an explicit ticket key is given, "bulk" when user says "for all of them"/"for these tickets", null to resolve from context; for description content instructions use contentSource instead
- showFields: list all available fields with IDs and current values; "show fields", "what fields does this ticket have", "list fields on PROJ-123"
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided; if user references a saved filter by numeric id (e.g. "filter 12345") set filterId to that id and jql to null; if user references a filter by name (e.g. "from filter 'My open bugs'") set filterName to that name and jql to null
- validateFields: check, validate required fields on a ticket
- createTicket: create, open, add a new ticket/issue/bug/story/task; description is any additional body content the user provided beyond the summary (e.g. code blocks, steps to reproduce, specifications) — null if no extra content; assignee is the person to assign the ticket to ("me"/"myself" for the current user, or a name/email) — null if not mentioned; components is a comma-separated string of component names if mentioned — null if not mentioned
- discoverWorkflow: discover or refresh the workflow graph for a project and issue type; projectKey and issueType are required
- transition: move/close/transition a single ticket to a target status; targetStatus is the destination state name; resolution is the resolution name if the user specifies one (e.g. "with resolution Not a Bug") — null otherwise; use when the user refers to one ticket (explicit key or resolved from context) — NOT when they say "them", "these tickets", "all of them"
- bulkTransition: transition/move/close/resolve "them" or "these tickets" or "all of them" to a status; only valid when a prior search result is available; targetStatus is the destination state name
- bulkUpdateField: set/update/change a field on "them" or "these tickets"; only valid when a prior search result is available; bulkFieldName is the field name the user gave, bulkFieldValue is the value string
- runCleanup: bulk-close or bulk-transition ALL tickets of a type in a project; triggered by "close all", "run cleanup", or "close PROJECT ISSUETYPE" where PROJECT is a project key and ISSUETYPE is an issue type name (not a ticket key like PROJ-123); projectKey and issueType are extracted from the prompt; cleanupRuleName is the quoted rule name if given; fixVersion is the exact fix version string if given (must be quoted in the prompt, e.g. "Fix Version 3.2"); examples: "@jira close VSJI Bug", "@jira run cleanup 'Close released bugs'", "@jira close BILLING bugs in 'Release 3.2'"
- loadTicket: download the full ticket context (description, all comments, attachments) into .jira-context/{key}/ in the workspace root; triggered by "load", "fetch context", "download ticket", "load context for"
- spellCheck: check and correct spelling and grammar on a ticket's description; triggered by "spell check", "fix grammar", "check spelling", "proofread"
- createFromEmail: create a Jira ticket from an Outlook email; triggered by "create from email", "ticket from email", "import email", "email to ticket"
- contentSource: how the comment or description content should be produced
  - "literal": user provided the exact text to post (e.g. "add comment: LGTM")
  - "generate": user gave a self-contained instruction with no implicit reference to prior work (e.g. "write a poem about Star Trek", "add a 12-line poem as comment"); only use this when content is purely creative or standalone
  - "history-recent": user references a specific artifact from the last few messages (e.g. "add that patch", "post the result above", "add it as a comment")
  - "history-full": user refers to work developed in the conversation — use this whenever the instruction mentions "the analysis", "the investigation", "the findings", "what we found/discussed/developed", "the solution", "the root cause", "the reproduction steps", or any topic that implies prior investigation; when in doubt between generate and history-full, prefer history-full
  - default to "literal" for operations other than addComment and updateField

Command: `;

export async function parseIntent(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<ParsedIntent> {
  const message = vscode.LanguageModelChatMessage.User(INTENT_PROMPT + JSON.stringify(prompt));
  const response = await model.sendRequest([message], {}, token);
  let raw = '';
  for await (const chunk of response.text) {
    raw += chunk;
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Model did not return a JSON object. Response: ${raw.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]) as ParsedIntent;
}

export async function generateContent(
  instruction: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  context?: string,
): Promise<string> {
  const roleSetup = vscode.LanguageModelChatMessage.User(
    'You are a Jira assistant. Your task is to write Jira comment and description text. ' +
    'Content may include prose summaries, code snippets, patches, or any technical material appropriate for a Jira comment.',
  );
  const roleAck = vscode.LanguageModelChatMessage.Assistant(
    'Understood. I write Jira comment and description text, including any technical content such as code or patches.',
  );
  const task = context
    ? `Available context:\n\n${context}\n\nUsing the context above, write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`
    : `Write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`;
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

export function isLmRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return text.length < 300 && (
    lower.includes("can't assist") ||
    lower.includes("cannot assist") ||
    lower.includes("unable to assist") ||
    lower.includes("not able to assist") ||
    lower.includes("i'm unable to help") ||
    lower.includes("i cannot help with") ||
    lower.includes("can't help with that") ||
    lower.includes("i'm not able to help")
  );
}

export function extractHistoryTurns(context: vscode.ChatContext): Array<{ role: 'user' | 'assistant'; text: string }> {
  type Turn = { role: 'user' | 'assistant'; text: string };
  return context.history.flatMap<Turn>((turn) => {
    if (turn instanceof vscode.ChatRequestTurn) {
      return [{ role: 'user', text: turn.prompt }];
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = stripHiddenMarkers(
        turn.response
          .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
          .join(''),
      );
      return text ? [{ role: 'assistant', text }] : [];
    }
    return [];
  });
}

export function buildHistoryContext(
  contentSource: ParsedIntent['contentSource'],
  context: vscode.ChatContext,
): string | undefined {
  if (contentSource === 'history-recent') {
    return serializeTurns(extractHistoryTurns(context), 'recent');
  }
  if (contentSource === 'history-full') {
    return serializeTurns(extractHistoryTurns(context), 'full');
  }
  return undefined;
}

export async function synthesizeComments(
  commentBlocks: string,
  query: string | null,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const task = query
    ? `Find and quote comments relevant to: "${query}". Note the author and date for each relevant comment.`
    : 'Summarise each comment in one sentence. Number each one. Format: N. **Author** (date): one-sentence summary.';
  const prompt = `Comments:\n\n${commentBlocks}\n\n${task} Produce only the final content, no preamble.`;
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text.trim();
}

export async function generateDescriptionAndCommentsSummary(
  descriptionText: string,
  commentBlocks: string | null,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const parts = [
    descriptionText ? `Description:\n${descriptionText}` : null,
    commentBlocks ? `Comments:\n\n${commentBlocks}` : null,
  ].filter(Boolean).join('\n\n');
  if (!parts) return '_No description or comments._';
  const prompt = `${parts}\n\nWrite a concise prose paragraph summarising the above. No preamble, no headings, no bullet points.`;
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text.trim();
}

export async function spellCheckValue(
  text: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string | null> {
  const prompt = `Check this text for spelling and grammar errors:\n\n${text}\n\nIf there are no errors, reply with exactly: UNCHANGED\nIf there are errors, reply with ONLY the corrected text, no explanation.`;
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const trimmed = raw.trim();
  if (/^unchanged$/i.test(trimmed)) return null;
  return trimmed || null;
}
