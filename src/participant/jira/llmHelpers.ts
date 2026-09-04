import * as vscode from 'vscode';
import { serializeTurns, stripHiddenMarkers } from '../sessionState';
import { extractJsonObject } from '../../utils/extractJsonObject';
import { turnCarriesJiraSessionKind } from './ticketContext';

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
  | 'createFromEmail'
  | 'addEmailComment'
  | 'importVeracode'
  | 'importWaltzReport'
  | 'generateTemplate';

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
  useMyTeamJql: boolean;
  targetStatus: string | null;
  bulkFieldName: string | null;
  bulkFieldValue: string | null;
  cleanupRuleName: string | null;
  fixVersion: string | null;
  resolution: string | null;
  templateName: string | null;
}

export const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"summarizeTicket"|"showComments"|"getComments"|"addComment"|"updateField"|"showFields"|"searchJql"|"validateFields"|"createTicket"|"discoverWorkflow"|"runCleanup"|"transition"|"bulkTransition"|"bulkUpdateField"|"loadTicket"|"spellCheck"|"createFromEmail"|"addEmailComment"|"importVeracode"|"importWaltzReport"|"generateTemplate","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"assignee":string|null,"components":string|null,"description":string|null,"comment":string|null,"commentQuery":string|null,"contentSource":"literal"|"generate"|"history-recent"|"history-full","fieldUpdates":[{"fieldName":string,"fieldValue":string}],"fieldName":string|null,"fieldValue":string|null,"arrayOp":"set"|"add"|"remove","scope":"single"|"bulk"|null,"jql":string|null,"filterId":string|null,"filterName":string|null,"useMyTeamJql":boolean,"targetStatus":string|null,"bulkFieldName":string|null,"bulkFieldValue":string|null,"cleanupRuleName":string|null,"fixVersion":string|null,"resolution":string|null,"templateName":string|null}
- getTicket: show, display, look up a specific ticket; returns all non-null fields, description, and one-line comment summaries
- summarizeTicket: summarise, summarize, tl;dr, give me an overview; produces a prose paragraph covering the ticket and its comments together
- showComments: show, list, display all comments in full; shows the actual comment bodies numbered; use when user wants to read the comment text rather than a summary
- getComments: ask what comments say, find or filter comments by topic; synthesises or queries comments; commentQuery is the topic/filter the user mentioned (e.g. "login bug", "performance") — null if they just want a general synthesis
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update a field on a ticket; use fieldName (human-readable field name or ID) and fieldValue (raw value string, comma-separated for arrays); arrayOp is "set" by default, "add" when the user says "add X to field", "remove" when the user says "remove X from field"; scope is "single" when an explicit ticket key is given, "bulk" when user says "for all of them"/"for these tickets", null to resolve from context; for description content instructions use contentSource instead
- showFields: list all available fields with IDs and current values; "show fields", "what fields does this ticket have", "list fields on PROJ-123"
- searchJql: find, search, list tickets; review multiple tickets against criteria; if the user provides literal JQL (contains field operators like =, !=, IN, ~) use it verbatim in jql; otherwise translate natural language to valid Jira JQL — common patterns: "my tickets"/"assigned to me"/"my open tickets" → assignee = currentUser() AND resolution is NULL ORDER BY updated DESC; "open"/"unresolved" → resolution is NULL; "in progress" → status = "In Progress"; issue type by name → issuetype = Bug; project → project = KEY; if user references a saved filter by numeric id (e.g. "filter 12345") set filterId to that id and jql to null; if user references a filter by name (e.g. "from filter 'My open bugs'") set filterName to that name and jql to null; if user mentions "my team" or "our team" set useMyTeamJql to true and put only the non-team conditions in jql (e.g. "open team bugs" → useMyTeamJql:true, jql:"issuetype = Bug AND resolution is NULL") — omit the team filter itself, that is injected from settings; useMyTeamJql defaults to false
- validateFields: check, validate required fields on a ticket
- createTicket: create, open, add a new ticket/issue/bug/story/task; description is any additional body content the user provided beyond the summary (e.g. code blocks, steps to reproduce, specifications) — null if no extra content; assignee is the person to assign the ticket to ("me"/"myself" for the current user, or a name/email) — null if not mentioned; components is a comma-separated string of component names if mentioned — null if not mentioned
- discoverWorkflow: discover or refresh the workflow graph for a project and issue type; projectKey and issueType are required
- transition: move/close/transition a single ticket to a target status; targetStatus is the destination state name; resolution is the resolution name if the user specifies one (e.g. "with resolution Not a Bug") — null otherwise; use when the user refers to one ticket (explicit key or resolved from context) — NOT when they say "them", "these tickets", "all of them"
- bulkTransition: transition/move/close/resolve "them" or "these tickets" or "all of them" to a status; only valid when a prior search result is available; targetStatus is the destination state name
- bulkUpdateField: set/update/change a field on "them" or "these tickets"; only valid when a prior search result is available; bulkFieldName is the field name the user gave, bulkFieldValue is the value string
- runCleanup: bulk-close or bulk-transition ALL tickets of a type in a project; triggered by "close all", "run cleanup", or "close PROJECT ISSUETYPE" where PROJECT is a project key and ISSUETYPE is an issue type name (not a ticket key like PROJ-123); projectKey and issueType are extracted from the prompt; cleanupRuleName is the quoted rule name if given; fixVersion is the complete string between the quotes after the word "in" — capture every word inside the quotes verbatim (e.g. in "Release 3.2" → "Release 3.2"; in "My Version has Spaces" → "My Version has Spaces"); examples: "@jira close VSJI Bug", "@jira run cleanup 'Close released bugs'", "@jira close BILLING bugs in 'Release 3.2'", "@jira run cleanup 'Close bugs' in 'My Version has Spaces'"
- loadTicket: download the full ticket context (description, all comments, attachments) into .jira-context/{key}/ in the workspace root; triggered by "load", "fetch context", "download ticket", "load context for"
- spellCheck: check and correct spelling and grammar on a ticket's description; triggered by "spell check", "fix grammar", "check spelling", "proofread"
- createFromEmail: create a Jira ticket from an email (.eml file); triggered by "create from email", "ticket from email"; only use this when the session is already loaded via command palette
- addEmailComment: import an email (.eml) from the chat without using the command palette — opens a file picker; if a ticket key is in the prompt (e.g. PROJ-42) adds the email as a comment, otherwise shows preview to create or comment; triggered by "add email", "add email to", "import email", "email to ticket", "add comment from mail", "create ticket from mail", "create from mail", "add email as comment"
- importVeracode: import a Veracode Detailed Report XML export and create Jira tickets from its flaws; triggered by "import veracode", "import veracode report", "veracode report", "create tickets from veracode", "veracode scan"; only use this when the session is already loaded via command palette, or to trigger the chat's own file picker if no command was used; projectKey is extracted from the prompt the same as for createTicket when the user names a project (e.g. "import veracode report for PROJ"), otherwise left null so the handler falls back to the default-project setting or an input box
- importWaltzReport: import a Waltz/SCA OSS report .xlsx export and create Jira tickets from its vulnerable components; triggered by "import oss report", "import waltz report", "oss report", "create tickets from oss report", "sca report"; only use this when the session is already loaded via command palette, or to trigger the chat's own file picker if no command was used; projectKey is extracted from the prompt the same as for createTicket when the user names a project (e.g. "import oss report for PROJ"), otherwise left null so the handler falls back to the default-project setting or an input box
- generateTemplate: generate/create/make a reusable template for future tickets, not a ticket itself; triggered by "generate a template", "create a template from <ticket>", "make a template for <project>"; ticketKey is the reference ticket key when the user names one to generate from (e.g. "generate a template from PROJ-123") — this is the reference-ticket path; projectKey is set instead when the user names a project with no reference ticket (e.g. "make a template for VSJI"); issueType is set only when the user explicitly names one in the same prompt (e.g. "a template for Bug tickets in VSJI") — otherwise leave it null, never guess it, the flow resolves it interactively; templateName is the quoted or otherwise clearly-named name for the new template if the user gave one (e.g. "called 'Billing Bug'") — otherwise null, the flow will ask for it
- contentSource: how the comment or description content should be produced
  - "literal": user gave the exact text to post verbatim (e.g. "add comment: LGTM")
  - "generate": self-contained instruction with no reference to prior work — purely creative or standalone (e.g. "write a poem about Star Trek", "add a 12-line poem as comment")
  - "history-recent": references a specific recent artifact (e.g. "add that patch", "post the result above", "add it as a comment")
  - "history-full": references prior investigation/findings/analysis in the conversation — use whenever the instruction mentions "the analysis", "the investigation", "the findings", "what we found/discussed/developed", "the solution", "the root cause", "the reproduction steps", or any topic implying prior investigation
  - default: "literal", except for addComment/updateField — when in doubt between generate and history-full, prefer history-full

Command: `;

// U4/R5: slash-command → forced-operation map. Each command still routes through the
// existing NL-intent-parsed pipeline (parseIntent still extracts ticketKey, fieldName,
// targetStatus, jql, comment text, …) — only the operation itself is pre-decided here,
// removing the LLM's classification step as the one source of routing ambiguity a
// deliberate `/command` shouldn't be subject to. `check` isn't in this map: it bypasses
// parseIntent entirely via its own regex special-case in JiraParticipant.ts.
export const COMMAND_OPERATIONS: Partial<Record<string, Operation>> = {
  create: 'createTicket',
  view: 'getTicket',
  comment: 'addComment',
  field: 'updateField',
  move: 'transition',
  search: 'searchJql',
  load: 'loadTicket',
};

export function mapCommandToOperation(command: string | undefined): Operation | undefined {
  return command ? COMMAND_OPERATIONS[command] : undefined;
}

// Onboarding walkthrough buttons (R1/R5) open chat pre-filled with literal placeholder tokens
// like `<PROJECT>`/`<ISSUE_TYPE>`/`<TYPE>`/`<SUMMARY>` that the user is meant to replace before
// sending. If sent unedited, a resolved field carrying one of these tokens must be treated the
// same as "missing" rather than reaching an LLM intent parse or a real API call — this is the
// one shared predicate every such call site guards with (KTD1), instead of duplicating the regex.
export function looksLikeUnfilledPlaceholder(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^<[A-Z][A-Z0-9_]*>$/.test(value);
}

export function extractFixVersionFromPrompt(prompt: string): string | null {
  const quoted = prompt.match(/\bin\s+["']([^"']+)["']/i);
  if (quoted) return quoted[1];
  const keyword = prompt.match(/\bin\s+(released|unreleased)\b/i);
  if (keyword) return keyword[1].toLowerCase();
  return null;
}

async function sendAndCollect(
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
  return JSON.parse(jsonText) as ParsedIntent;
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
      // Skip session-management responses — they are noise, not findings. Metadata-based (R1/R3):
      // these turns carry no visible `<!-- jira:TAG -->` marker to text-match against any more.
      if (turnCarriesJiraSessionKind(turn, 'previewing')) return [];
      if (turnCarriesJiraSessionKind(turn, 'load-skipped')) return [];
      const raw = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      const text = stripHiddenMarkers(raw);
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
  const roleText = query
    ? 'You are a Jira comment analyst. Your task is to find and quote comments relevant to the user\'s query.'
    : 'You are a Jira comment analyst. Your task is to produce concise numbered summaries of each comment.';
  const roleAck = query
    ? 'Understood. I find and quote comments relevant to the user\'s query.'
    : 'Understood. I produce concise numbered summaries of each comment.';
  const task = query
    ? `Find and quote comments relevant to: "${query}". Note the author and date for each relevant comment.`
    : 'Summarise each comment in one sentence. Number each one. Format: N. **Author** (date): one-sentence summary.';
  const taskPrompt = `Comments:\n\n${commentBlocks}\n\n${task} Produce only the final content, no preamble.\n\nBase your response ONLY on the comments provided above. Do not add information not present in the source.`;
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
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
  const roleText = 'You are a technical scribe. Your task is to write a single prose paragraph summarizing a Jira ticket\'s description and comments.';
  const roleAck = 'Understood. I write a single prose paragraph summarizing the ticket\'s description and comments.';
  const taskPrompt = `${parts}\n\nWrite a concise prose paragraph summarising the above. No preamble, no headings, no bullet points.\n\nBase your summary ONLY on the description and comments provided above. Do not add information not present in the source.`;
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text.trim();
}

export interface SpellCheckResult {
  correctedText: string;
  changeSummary: string | null;
}

export async function spellCheckValue(
  text: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<SpellCheckResult | null> {
  const roleText = 'You are a copy editor. Your task is to find and correct spelling and grammar errors in text.';
  const roleAck = 'Understood. I identify and fix spelling and grammar errors.';
  const taskPrompt =
    `Check this text for spelling and grammar errors:\n\n${text}\n\n` +
    'If there are no errors, reply with exactly: UNCHANGED\n' +
    'If there are errors, reply with the corrected text, then a line containing only "---", ' +
    'then a short bullet list (max 5 bullets) of what you changed and why. No other explanation.';
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const trimmed = raw.trim();
  if (!trimmed || /^unchanged$/i.test(trimmed)) return null;
  const separator = trimmed.match(/\n-{3,}\n/);
  if (!separator) return { correctedText: trimmed, changeSummary: null };
  const splitAt = separator.index ?? trimmed.length;
  const correctedText = trimmed.slice(0, splitAt).trim();
  const changeSummary = trimmed.slice(splitAt + separator[0].length).trim() || null;
  return correctedText ? { correctedText, changeSummary } : null;
}

export function isPointerPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  // "post it", "copy it/this/that" — these almost exclusively mean "post the content verbatim"
  if (/\b(post|copy)\s+(it|this|that)\b/.test(lower)) return true;
  // "add/post/use/take it/this/that AS A COMMENT" — requires explicit "as a comment" qualifier
  if (/\b(add|post|use|take)\s+(it|this|that)\s+as\s+(a\s+)?comment\b/.test(lower)) return true;
  return false;
}

export function extractLastAssistantText(context: vscode.ChatContext): string {
  const turns = extractHistoryTurns(context);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') return turns[i].text;
  }
  return '';
}
