import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService, assembleDescription, resolveFieldIdFuzzy, formatIssueFields } from '../services/TicketService';
import { formatJiraBody } from '../utils/markdownFormatter';
import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import { extractTicketId } from '../utils/branchParser';
import { redactUrls, tokenStatus } from '../utils/diagUtils';
import { markdownToJiraWiki } from '../utils/markdownToJiraWiki';
import { type CreationSession, type ContentSession, type MoreCommentsSession, type TemplateSelectionSession, type IssueTypeSelectionSession, type TransitionBatchSession, type TransitionBatchTicket, type TransitionSubtask, type ResolutionSelectionSession, type CommentListSession, type FilterSelectionSession, type SearchResultSession, type BulkUpdateReviewSession, type FieldUpdatePreviewSession, type SpellCheckSession, type FieldSelectionSession, type SprintSelectionSession, extractCreatedKeyFromConfirmation, extractLastTicketFromText, stripHiddenMarkers, serializeTurns, isConfirmation, isCancellation, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection, buildCommentListSession, parseCommentIndex, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview } from './sessionState';
import { discoverWorkflow, loadWorkflowCache, saveWorkflowCache, findPath } from '../services/WorkflowService';
import type { WorkflowGraph } from '../services/WorkflowService';
import type { CleanupRule } from '../templates/TemplateService';

type Operation =
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
  | 'bulkTransition'
  | 'bulkUpdateField';

interface FieldUpdate {
  fieldName: string;
  fieldValue: string;
}

interface ParsedIntent {
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
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"summarizeTicket"|"showComments"|"getComments"|"addComment"|"updateField"|"showFields"|"searchJql"|"validateFields"|"createTicket"|"discoverWorkflow"|"runCleanup"|"bulkTransition"|"bulkUpdateField","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"assignee":string|null,"components":string|null,"description":string|null,"comment":string|null,"commentQuery":string|null,"contentSource":"literal"|"generate"|"history-recent"|"history-full","fieldUpdates":[{"fieldName":string,"fieldValue":string}],"fieldName":string|null,"fieldValue":string|null,"arrayOp":"set"|"add"|"remove","scope":"single"|"bulk"|null,"jql":string|null,"filterId":string|null,"filterName":string|null,"targetStatus":string|null,"bulkFieldName":string|null,"bulkFieldValue":string|null,"cleanupRuleName":string|null,"fixVersion":string|null}
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
- bulkTransition: transition/move/close/resolve "them" or "these tickets" or "all of them" to a status; only valid when a prior search result is available; targetStatus is the destination state name
- bulkUpdateField: set/update/change a field on "them" or "these tickets"; only valid when a prior search result is available; bulkFieldName is the field name the user gave, bulkFieldValue is the value string
- runCleanup: bulk-close or bulk-transition ALL tickets of a type in a project; triggered by "close all", "run cleanup", or "close PROJECT ISSUETYPE" where PROJECT is a project key and ISSUETYPE is an issue type name (not a ticket key like PROJ-123); projectKey and issueType are extracted from the prompt; cleanupRuleName is the quoted rule name if given; fixVersion is the exact fix version string if given (must be quoted in the prompt, e.g. "Fix Version 3.2"); examples: "@jira close VSJI Bug", "@jira run cleanup 'Close released bugs'", "@jira close BILLING bugs in 'Release 3.2'"
- contentSource: how the comment or description content should be produced
  - "literal": user provided the exact text to post (e.g. "add comment: LGTM")
  - "generate": user gave a self-contained instruction with no implicit reference to prior work (e.g. "write a poem about Star Trek", "add a 12-line poem as comment"); only use this when content is purely creative or standalone
  - "history-recent": user references a specific artifact from the last few messages (e.g. "add that patch", "post the result above", "add it as a comment")
  - "history-full": user refers to work developed in the conversation — use this whenever the instruction mentions "the analysis", "the investigation", "the findings", "what we found/discussed/developed", "the solution", "the root cause", "the reproduction steps", or any topic that implies prior investigation; when in doubt between generate and history-full, prefer history-full
  - default to "literal" for operations other than addComment and updateField

Command: `;

async function parseIntent(
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

async function generateContent(
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

function isLmRefusal(text: string): boolean {
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

function extractHistoryTurns(context: vscode.ChatContext): Array<{ role: 'user' | 'assistant'; text: string }> {
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

function buildHistoryContext(
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

const FILE_MAX_BYTES = 60_000;

async function gatherFileContent(
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

async function buildContentContext(
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

function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date}):\n${body}`;
  }).join('\n\n---\n\n');
}

async function synthesizeComments(
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

async function generateDescriptionAndCommentsSummary(
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

function getLastAssistantText(context: vscode.ChatContext): string {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      return turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
    }
  }
  return '';
}

async function streamContentPreview(session: ContentSession, stream: vscode.ChatResponseStream, workspaceState: vscode.Memento): Promise<void> {
  await workspaceState.update('jira.session.previewing', session);
  const actionLabel = session.operation === 'addComment' ? 'post this comment' : 'update the description';
  stream.markdown(
    `${session.currentContent}\n\nReply **"post it"** to ${actionLabel}, or tell me how to adjust it.\n\n<!-- jira:previewing -->`,
  );
}

async function handleContentSession(
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
  const refineContext = [session.historyContext, `Previously generated:\n${session.currentContent}`]
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

async function checkSectionCoverage(
  prompt: string,
  sections: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string[]> {
  const message = vscode.LanguageModelChatMessage.User(
    `Does this text address any of these sections? Reply with ONLY a JSON array of section names that are clearly covered.\nSections: ${JSON.stringify(sections)}\nText: ${JSON.stringify(prompt)}`,
  );
  const response = await model.sendRequest([message], {}, token);
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}

function resolveTicketFromBranch(): string | null {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    return extractTicketId(branch);
  } catch {
    return null;
  }
}

async function resolveProjectKey(
  fromIntent: string | null,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  if (fromIntent) return fromIntent;

  const defaultProject = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  if (defaultProject) return defaultProject;

  stream.markdown('_No project key found in your message or settings — opening input box…_\n\n');
  const entered = await vscode.window.showInputBox({
    prompt: 'Enter the Jira project key (e.g. VSJI)',
    placeHolder: 'PROJECT',
    ignoreFocusOut: true,
  });
  return entered ?? null;
}

async function streamIssueTypeSelection(
  session: IssueTypeSelectionSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
): Promise<void> {
  await workspaceState.update('jira.session.typeSelection', session);
  const list = session.issueTypes.map((t, i) => `${i + 1}. ${t}`).join('\n');
  stream.markdown(`Which issue type?\n\n${list}\n\nReply with the name or number, or **(c)** to cancel.\n\n<!-- jira:selecting-type -->`);
}

async function continueAfterIssueType(
  projectKey: string,
  summary: string | null,
  issueType: string,
  description: string | null,
  selectedTemplate: JiraTemplate | null,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
  extraFields?: Record<string, unknown>,
): Promise<string | null> {
  let resolvedFields: Record<string, unknown> = {};
  if (selectedTemplate) {
    const resolver = new FieldResolver(jiraClient, projectKey);
    try {
      resolvedFields = await resolver.resolve(selectedTemplate.defaultFields, selectedTemplate.resolveFields);
    } catch (err) {
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Field resolution error: ${err instanceof Error ? err.message : String(err)}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return null; }
      resolvedFields = {};
      selectedTemplate = null;
    }
  }

  if (extraFields) Object.assign(resolvedFields, extraFields);

  const sections = selectedTemplate?.descriptionSections ?? [];

  // Fast path: summary known, no sections → create directly
  if (summary !== null && sections.length === 0) {
    if (description) resolvedFields.description = description;
    const result = await ticketService.createTicket(
      projectKey,
      summary,
      issueType,
      Object.keys(resolvedFields).length > 0 ? resolvedFields : undefined,
    );
    stream.markdown(result);
    return extractCreatedKeyFromConfirmation(result);
  }

  // Build the pending section list, checking description coverage only when summary is known
  const covered = summary !== null && description
    ? await checkSectionCoverage(description, sections, model, token)
    : [];
  const answers: Record<string, string> = {};
  for (const s of covered) answers[s] = description ?? '';
  const pendingRealSections = sections.filter((s) => !covered.includes(s));

  // Fast path: all sections covered, summary known → create directly
  if (summary !== null && pendingRealSections.length === 0) {
    const descriptionText = assembleDescription(sections, answers);
    resolvedFields.description = descriptionText;
    const result = await ticketService.createTicket(projectKey, summary, issueType, resolvedFields);
    stream.markdown(result);
    return extractCreatedKeyFromConfirmation(result);
  }

  if (selectedTemplate && pendingRealSections.length > 0) {
    const fieldNames = Object.keys(resolvedFields).filter((k) => k !== 'description').join(', ');
    stream.markdown(`_Using template **${selectedTemplate.name}**${fieldNames ? ` — defaults: ${fieldNames}` : ''}._\n\n`);
    if (covered.length > 0) {
      stream.markdown(`_Your description already covers **${covered.join(', ')}**._\n\n`);
    }
  }

  const pending = [
    ...(summary === null ? ['__summary__'] : []),
    ...pendingRealSections,
  ];

  const newSession: CreationSession = {
    template: selectedTemplate?.name ?? '',
    project: projectKey,
    summary,
    issueType,
    allSections: sections,
    pending,
    answers,
    fields: resolvedFields,
  };
  await streamNextSection(newSession, stream, workspaceState);
  return null;
}

function parseLastTicketFromContext(context: vscode.ChatContext): string | null {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      const key = extractLastTicketFromText(text);
      if (key) return key;
    }
  }
  return null;
}

async function streamNextSection(session: CreationSession, stream: vscode.ChatResponseStream, workspaceState: vscode.Memento): Promise<void> {
  await workspaceState.update('jira.session.creating', session);
  const next = session.pending[0];

  if (next === '__summary__') {
    stream.markdown(`What should the **summary** be?\n\nReply with the ticket summary to continue.\n\n<!-- jira:creating -->`);
    return;
  }

  const pendingRealSections = session.pending.filter((s) => s !== '__summary__');
  const answered = session.allSections.length - pendingRealSections.length;
  const isLast = pendingRealSections.length === 1;
  const header = isLast
    ? `Last section — **${next}**`
    : `Section ${answered + 1} of ${session.allSections.length} — **${next}**`;
  const cta = isLast
    ? 'Reply with your content to finish the ticket.'
    : 'Reply with your content and I\'ll ask for the next section.';
  stream.markdown(`${header}\n\n${cta}\n\n<!-- jira:creating -->`);
}

async function streamTemplateSelection(
  templateNames: string[],
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
  originalPrompt: string,
): Promise<void> {
  const session: TemplateSelectionSession = { templateNames, originalPrompt };
  await workspaceState.update('jira.session.templateSelection', session);
  const list = templateNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
  stream.markdown(`Which template would you like to use?\n\n${list}\n\nReply with the name or number, **(n)** for no template, or **(c)** to cancel.\n\n<!-- jira:selecting-template -->`);
}

async function finishTicketCreation(
  session: CreationSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  const descriptionText = assembleDescription(session.allSections, session.answers);
  const additionalFields: Record<string, unknown> = {
    ...session.fields,
    description: descriptionText,
  };
  // session.summary is guaranteed non-null here: __summary__ is always answered
  // before pending becomes empty, so finishTicketCreation is only reached after it.
  const result = await ticketService.createTicket(
    session.project,
    session.summary!,
    session.issueType,
    additionalFields,
  );
  stream.markdown(result);
  return extractCreatedKeyFromConfirmation(result);
}

async function handleCreateTicket(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
  preselectedTemplateName?: string | null,
  originalPrompt?: string,
): Promise<string | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let selectedTemplate: JiraTemplate | null = null;

  if (preselectedTemplateName !== undefined) {
    // Returning from a template selection turn — reload the chosen template by name
    if (preselectedTemplateName !== null && workspaceRoot) {
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        selectedTemplate = templates.find((t) => t.name === preselectedTemplateName) ?? null;
      } catch {
        stream.markdown('_Could not reload template — proceeding without._\n\n');
      }
    }
  } else {
    // Fresh call — offer templates in chat if any exist
    let templates: JiraTemplate[] = [];
    if (workspaceRoot) {
      try {
        ({ templates } = new TemplateService(workspaceRoot).loadTemplates());
      } catch (err) {
        stream.markdown(`_Template error: ${err instanceof Error ? err.message : String(err)} — proceeding without template._\n\n`);
      }
    }
    if (templates.length > 0) {
      await streamTemplateSelection(templates.map((t) => t.name), stream, workspaceState, request.prompt);
      return null;
    }
  }

  // Use the original prompt (saved before template selection) so that intent fields
  // like summary and assignee are extracted from what the user actually typed, not
  // from the template-choice reply ("1", "RMW Bug", etc.).
  const intent = await parseIntent(originalPrompt ?? request.prompt, request.model, token);
  const projectKey = await resolveProjectKey(intent.projectKey, stream);
  if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return null; }

  const summary = intent.summary;

  // Resolve assignee if specified
  const extraFields: Record<string, unknown> = {};
  if (intent.assignee) {
    const resolved = await ticketService.resolveAssignee(intent.assignee);
    if (typeof resolved === 'string') { stream.markdown(resolved); return null; }
    extraFields.assignee = resolved;
  }
  if (intent.components) {
    extraFields.components = intent.components.split(',').map((c) => ({ name: c.trim() }));
  }

  const resolvedType = selectedTemplate?.issueType ?? intent.issueType;
  if (!resolvedType) {
    let types: { name: string }[];
    try {
      types = await ticketService.getIssueTypes(projectKey);
    } catch {
      types = [];
    }
    if (types.length === 0) {
      stream.markdown('_Could not fetch issue types — opening input box…_\n\n');
      const entered = await vscode.window.showInputBox({ prompt: 'Enter the issue type (e.g. Bug, Story, Task)', ignoreFocusOut: true }) ?? null;
      if (!entered) { stream.markdown('No issue type provided — cancelled.'); return null; }
      return continueAfterIssueType(projectKey, summary, entered, intent.description, selectedTemplate, request.model, stream, token, jiraClient, ticketService, workspaceState, extraFields);
    }
    const typeSession: IssueTypeSelectionSession = {
      issueTypes: types.map((t) => t.name),
      project: projectKey,
      summary,
      templateName: selectedTemplate?.name ?? null,
      description: intent.description,
      extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
    await streamIssueTypeSelection(typeSession, stream, workspaceState);
    return null;
  }

  return continueAfterIssueType(projectKey, summary, resolvedType, intent.description, selectedTemplate, request.model, stream, token, jiraClient, ticketService, workspaceState, extraFields);
}

async function handleDiscoverWorkflow(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: JiraApiClient,
): Promise<void> {
  const projectKey = intent.projectKey;
  const issueType = intent.issueType;
  if (!projectKey || !issueType) {
    stream.markdown('Please specify a project and issue type, e.g. `@jira discover workflow VSJI Bug`.');
    return;
  }
  stream.markdown(`_Discovering workflow for **${projectKey}** / **${issueType}**…_\n\n`);
  const { graph, skippedStatuses } = await discoverWorkflow(jiraClient, projectKey, issueType);
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    stream.markdown(`No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`);
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const cache = loadWorkflowCache(workspaceRoot);
  if (!cache[projectKey]) cache[projectKey] = {};
  cache[projectKey][issueType] = { discovered: new Date().toISOString().slice(0, 10), graph };
  saveWorkflowCache(workspaceRoot, cache);

  const lines = statuses.map((s) => {
    const targets = graph[s].map((t) => `${t.name} → **${t.to}**`).join(', ');
    return `**${s}**: ${targets}`;
  });
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${statuses.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  if (skippedStatuses.length > 0) {
    summary += `\n\n⚠️ **${skippedStatuses.length} status(es) had no open tickets and were not sampled:** ${skippedStatuses.join(', ')}. Re-run discovery once tickets exist in those states.`;
  }
  stream.markdown(summary);
}

async function streamReviewScreen(
  session: TransitionBatchSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
  header: string,
): Promise<void> {
  await workspaceState.update('jira.session.transitionReview', session);
  const lines: string[] = [header, ''];
  for (const t of session.tickets) {
    const finalState = t.transitionPath.at(-1)?.to ?? '?';
    lines.push(`**${t.key}**  ${t.summary}  ·  _${t.currentStatus} → ${finalState}_`);
    for (const s of t.subtasks) {
      const sFinal = s.transitionPath.at(-1)?.to ?? '?';
      lines.push(`  **${s.key}**  ${s.summary}  ·  _${s.currentStatus} → ${sFinal}_`);
    }
  }
  lines.push('', 'ok · (c) · key numbers to skip (e.g. 11 14)');
  stream.markdown(lines.join('\n') + '\n\n<!-- jira:transition-review -->');
}

async function executeCleanupBatch(
  session: TransitionBatchSession,
  skipKeys: Set<string>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let transitioned = 0;
  let failed = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const ticket of session.tickets) {
    if (skipKeys.has(ticket.key)) {
      skipped += 1 + ticket.subtasks.length;
      continue;
    }

    for (const sub of ticket.subtasks) {
      if (skipKeys.has(sub.key)) { skipped++; continue; }
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, session.resolution);
        const hops = sub.transitionPath.length;
        stream.markdown(`✓ ${sub.key}  → ${sub.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
        transitioned++;
      } catch (err) {
        stream.markdown(`✗ ${sub.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
        failures.push(sub.key);
        failed++;
      }
    }

    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      const hops = ticket.transitionPath.length;
      stream.markdown(`✓ ${ticket.key}  → ${ticket.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
      transitioned++;
    } catch (err) {
      stream.markdown(`✗ ${ticket.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
      failures.push(ticket.key);
      failed++;
    }
  }

  const total = transitioned + failed + skipped;
  stream.markdown(`\n${total} tickets processed — ${transitioned} transitioned, ${failed} failed, ${skipped} skipped.`);
  if (failures.length > 0) {
    stream.markdown(`\nFailed: ${failures.join(', ')}\nIf caused by a workflow gap, run \`@jira discover workflow\` to refresh the cache.`);
  }
}

async function handleRunCleanup(
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  const { cleanupRules } = new TemplateService(workspaceRoot).loadTemplates();
  const rule: CleanupRule | null =
    cleanupRules.find((r) => r.name === intent.cleanupRuleName) ??
    cleanupRules.find((r) => r.project === intent.projectKey && r.issueType === intent.issueType) ??
    null;
  if (!rule && !intent.projectKey) {
    stream.markdown('No cleanup rule found. Use `@jira run cleanup "rule name"` or specify a project and issue type.');
    return;
  }
  const project = rule?.project ?? intent.projectKey!;
  const issueType = rule?.issueType ?? intent.issueType ?? 'Bug';
  const targetState = rule?.targetState ?? 'Done';
  const resolution = rule?.resolution;

  const cache = loadWorkflowCache(workspaceRoot);
  const graph = cache[project]?.[issueType]?.graph;
  if (!graph) {
    stream.markdown(`No workflow cache for **${project} / ${issueType}**. Run \`@jira discover workflow ${project} ${issueType}\` first.`);
    return;
  }

  const fixVersion = intent.fixVersion ?? null;
  let jql = `project = ${project} AND issuetype = "${issueType}" AND status != "${targetState}"`;
  if (fixVersion) jql += ` AND fixVersion = "${fixVersion}"`;

  stream.markdown(`_Searching for tickets…_\n\n`);
  const result = await ticketService.searchTicketsRaw(jql, 50);

  if (result.issues.length === 0) {
    stream.markdown('No tickets found matching the criteria.');
    return;
  }
  if ((result.total ?? 0) > 50 || result.isLast === false) {
    const count = result.total ? `${result.total} tickets` : 'more tickets';
    stream.markdown(`_Found ${count} — showing first 50. Refine your filter if needed._\n\n`);
  }

  const BATCH_LIMIT = 50;
  const tickets: TransitionBatchTicket[] = [];
  for (const issue of result.issues.slice(0, BATCH_LIMIT)) {
    const path = findPath(graph, issue.fields.status.name, targetState);
    if (path === null) {
      stream.markdown(`_Warning: no path found from **${issue.fields.status.name}** to **${targetState}** for ${issue.key} — skipping._\n\n`);
      continue;
    }
    const openSubtasks = rule?.closeSubtasks
      ? await ticketService.getOpenSubtasks(issue.key)
      : [];
    const subtasks: TransitionSubtask[] = [];
    for (const s of openSubtasks) {
      const subPath = findPath(graph, s.currentStatus, targetState);
      if (subPath === null) {
        stream.markdown(`_Warning: no path found from **${s.currentStatus}** to **${targetState}** for subtask ${s.key} — skipping._\n\n`);
        continue;
      }
      subtasks.push({ ...s, transitionPath: subPath });
    }
    tickets.push({
      key: issue.key,
      summary: issue.fields.summary,
      currentStatus: issue.fields.status.name,
      transitionPath: path,
      subtasks,
    });
  }

  if (tickets.length === 0) {
    stream.markdown('No tickets can be transitioned — all are either already at target state or have no valid path.');
    return;
  }

  if (resolution === undefined) {
    const closedStates = new Set(['done', 'resolved', 'closed', "won't fix"]);
    if (closedStates.has(targetState.toLowerCase())) {
      const resolutions = await jiraClient.getResolutions();
      const resSession: ResolutionSelectionSession = {
        tickets,
        ruleName: rule?.name,
        targetState,
        resolutionOptions: resolutions.map((r) => r.name),
      };
      await workspaceState.update('jira.session.resolutionSelection', resSession);
      const list = resolutions.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
      stream.markdown(`Which resolution should be set when transitioning to **${targetState}**?\n\n${list}\n\nReply with the name or number, or **none** to skip setting a resolution.\n\n<!-- jira:selecting-resolution -->`);
      return;
    }
  }

  const header = `**Cleanup${rule ? `: ${rule.name}` : ''}**  ·  ${project} / ${issueType}${fixVersion ? `  ·  Fix version "${fixVersion}"` : ''}`;
  const batchSession: TransitionBatchSession = { tickets, resolution, ruleName: rule?.name };
  await streamReviewScreen(batchSession, stream, workspaceState, header);
}

async function spellCheckValue(
  text: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string | null> {
  const prompt = `Check this text for spelling and grammar errors:\n\n"${text}"\n\nIf there are no errors, reply with exactly: UNCHANGED\nIf there are errors, reply with ONLY the corrected text, no explanation.`;
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const trimmed = raw.trim();
  if (/^unchanged$/i.test(trimmed)) return null;
  return trimmed || null;
}

async function streamFieldUpdatePreview(
  session: FieldUpdatePreviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update('jira.session.fieldUpdatePreview', session);
  const scope = session.ticketKeys.length === 1
    ? session.ticketKeys[0]
    : `${session.ticketKeys.length} tickets`;
  const displayValue = typeof session.fieldValue === 'string'
    ? session.fieldValue
    : JSON.stringify(session.fieldValue);
  stream.markdown(
    `**Preview: set ${session.fieldName}**\n\n` +
    `Setting **${session.fieldName}** (\`${session.fieldId}\`) to \`${displayValue}\` on ${scope}.\n\n` +
    `Reply **ok** to apply, or **(c)** to cancel.\n\n<!-- jira:field-update-preview -->`,
  );
}

async function continueSetField(
  ticketKeys: string[],
  field: JiraFieldMeta,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  spellCheckEnabled: boolean,
): Promise<void> {
  const sampleKey = ticketKeys[0];
  const isSprintField = Boolean(field.schema.custom?.includes('gh-sprint'));
  const isArray = field.schema.type === 'array';

  if (isSprintField) {
    const projectKey = sampleKey.split('-')[0];
    let candidates: JiraSprintCandidate[];
    try {
      candidates = await ticketService.findSprints(projectKey, fieldValueRaw);
    } catch (err) {
      stream.markdown(`Could not search sprints: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (candidates.length === 0) {
      stream.markdown(`No active or future sprint matching "${fieldValueRaw}" in project ${projectKey}.`);
      return;
    }
    if (candidates.length === 1) {
      await streamFieldUpdatePreview({
        ticketKeys, fieldId: field.id, fieldName: field.name,
        fieldValue: [{ id: candidates[0].id }], isArray: true, arrayOp: 'set',
      }, stream, ws);
      return;
    }
    const previewPlaceholder: FieldUpdatePreviewSession = {
      ticketKeys, fieldId: field.id, fieldName: field.name,
      fieldValue: null, isArray: true, arrayOp: 'set',
    };
    const sprintSession: SprintSelectionSession = {
      candidates,
      pending: { kind: 'field-update', session: previewPlaceholder },
    };
    await ws.update('jira.session.sprintSelection', sprintSession);
    const list = candidates.map((s, i) => `${i + 1}. ${s.name} (${s.state})`).join('\n');
    stream.markdown(`Multiple sprints match "${fieldValueRaw}":\n\n${list}\n\nWhich one? Reply with a number, or **(c)** to cancel.\n\n<!-- jira:sprint-selection -->`);
    return;
  }

  let fieldValue: unknown;
  try {
    if (isArray) {
      const rawValues = fieldValueRaw.split(',').map(v => v.trim()).filter(Boolean);
      let currentValue: unknown = null;
      if (arrayOp !== 'set') {
        currentValue = await ticketService.getRawField(sampleKey, field.id);
      }
      fieldValue = await ticketService.buildArrayValue(field.id, sampleKey, rawValues, arrayOp, currentValue);
    } else {
      fieldValue = await ticketService.buildFieldValue(field.id, sampleKey, fieldValueRaw);
    }
  } catch (err) {
    stream.markdown(`Could not build field value: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Spell-check string fields
  if (spellCheckEnabled && !isArray && field.schema.type === 'string' && typeof fieldValue === 'string' && fieldValue.trim().length > 0) {
    const corrected = await spellCheckValue(fieldValue, model, token);
    if (corrected && corrected !== fieldValue) {
      const basePending: FieldUpdatePreviewSession = {
        ticketKeys, fieldId: field.id, fieldName: field.name,
        fieldValue, isArray, arrayOp,
      };
      const spellSession: SpellCheckSession = {
        original: fieldValue,
        corrected,
        pending: { ...basePending, fieldValue: corrected },
      };
      await ws.update('jira.session.spellCheck', spellSession);
      stream.markdown(
        `Possible spelling or grammar issue detected:\n\n` +
        `**Original:** ${fieldValue}\n\n` +
        `**Corrected:** ${corrected}\n\n` +
        `Reply **ok** to use the corrected version, **keep** to use the original as-is, or **(c)** to cancel.\n\n<!-- jira:spell-check -->`,
      );
      return;
    }
  }

  await streamFieldUpdatePreview({
    ticketKeys, fieldId: field.id, fieldName: field.name,
    fieldValue, isArray, arrayOp,
  }, stream, ws);
}

async function handleSetField(
  ticketKeys: string[],
  fieldNameRaw: string,
  fieldValueRaw: string,
  arrayOp: 'set' | 'add' | 'remove',
  fieldMeta: JiraFieldMeta[],
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  spellCheckEnabled: boolean,
): Promise<void> {
  const navigable = fieldMeta.filter(f => f.navigable === true);
  const resolution = resolveFieldIdFuzzy(fieldNameRaw, navigable);

  if (resolution.kind === 'none') {
    stream.markdown(`No field matching "${fieldNameRaw}" found. Use \`@jira show fields on ${ticketKeys[0]}\` to see available fields.`);
    return;
  }

  if (resolution.kind === 'candidates') {
    const selSession: FieldSelectionSession = {
      candidates: resolution.fields,
      pending: { fieldValue: fieldValueRaw, arrayOp, ticketKeys },
    };
    await ws.update('jira.session.fieldSelection', selSession);
    const list = resolution.fields.map((f, i) => `${i + 1}. ${f.name} (\`${f.id}\`)`).join('\n');
    stream.markdown(`Multiple fields match "${fieldNameRaw}":\n\n${list}\n\nWhich one? Reply with a number, or **(c)** to cancel.\n\n<!-- jira:selecting-field -->`);
    return;
  }

  await continueSetField(
    ticketKeys, resolution.field, fieldValueRaw, arrayOp,
    ticketService, stream, ws, model, token, spellCheckEnabled,
  );
}

export function createJiraParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const config = await configService.getConfig();

    if (!config.baseUrl) {
      stream.markdown(
        '**Jira base URL not configured.**\n\nAdd `ticketSidekick.jira.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`).',
      );
      return;
    }

    if (!config.token) {
      const command =
        config.authType === 'cloud'
          ? 'Ticket Sidekick: Configure Cloud Credentials'
          : 'Ticket Sidekick: Set Personal Access Token';
      stream.markdown(
        `**Jira credentials not configured.**\n\nRun the command \`${command}\` from the Command Palette.`,
      );
      return;
    }

    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v2 · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(jiraClient);
    const ws = context.workspaceState;
    const lastResponse = getLastAssistantText(chatContext);

    if (/^check(\s+(config|connection|setup))?$/i.test(request.prompt.trim())) {
      try {
        const user = await jiraClient.getCurrentUser();
        stream.markdown(
          `**Jira connection OK**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${redactUrls(config.baseUrl ?? '')}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n` +
          `| Logged in as | ${user.displayName} |\n`,
        );
      } catch (err) {
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${redactUrls(config.baseUrl ?? '')}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n\n` +
          `Error: ${redactUrls(err instanceof Error ? err.message : String(err))}`,
        );
      }
      return;
    }

    // Resolution selection — user replied with a resolution choice before the review screen
    if (lastResponse.includes('<!-- jira:selecting-resolution -->')) {
      const selSession = ws.get<ResolutionSelectionSession>('jira.session.resolutionSelection');
      if (selSession) {
        const choice = parseResolutionSelection(request.prompt, selSession.resolutionOptions);
        if (choice === 'invalid') {
          const list = selSession.resolutionOptions.map((r, i) => `${i + 1}. ${r}`).join('\n');
          stream.markdown(`Please choose a resolution:\n\n${list}\n\nReply with name or number, or **none** to skip.\n\n<!-- jira:selecting-resolution -->`);
          return;
        }
        await ws.update('jira.session.resolutionSelection', undefined);
        const batchSession: TransitionBatchSession = {
          tickets: selSession.tickets,
          resolution: choice ?? undefined,
          ruleName: selSession.ruleName,
        };
        const header = `**Cleanup${selSession.ruleName ? `: ${selSession.ruleName}` : ''}**`;
        await streamReviewScreen(batchSession, stream, ws, header);
        return;
      }
    }

    // Transition review — user replied ok/cancel/skip keys
    if (lastResponse.includes('<!-- jira:transition-review -->')) {
      const session = ws.get<TransitionBatchSession>('jira.session.transitionReview');
      if (session) {
        const result = parseSkipInput(request.prompt, session.tickets);
        if (result.action === 'invalid') {
          const header = `**Cleanup${session.ruleName ? `: ${session.ruleName}` : ''}**`;
          await streamReviewScreen(session, stream, ws, header);
          return;
        }
        await ws.update('jira.session.transitionReview', undefined);
        if (result.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        const skipKeys = new Set<string>(result.action === 'skip' ? result.keys : []);
        try {
          await executeCleanupBatch(session, skipKeys, ticketService, stream);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Filter selection — user replied with their filter choice
    if (lastResponse.includes('<!-- jira:selecting-filter -->')) {
      const selSession = ws.get<FilterSelectionSession>('jira.session.filterSelection');
      if (selSession) {
        const choice = parseFilterSelection(request.prompt, selSession.filters);
        if (choice === 'invalid') {
          const list = selSession.filters.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
          stream.markdown(`Please choose a filter:\n\n${list}\n\nReply with the number or name, or **(c)** to cancel.\n\n<!-- jira:selecting-filter -->`);
          return;
        }
        await ws.update('jira.session.filterSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          const raw = await ticketService.searchTicketsRaw(choice.jql);
          if (raw.issues.length > 0) {
            await ws.update('jira.session.searchResult', { ticketKeys: raw.issues.map(i => i.key), jql: choice.jql } as SearchResultSession);
          }
          const result = await ticketService.searchTickets(choice.jql);
          stream.markdown(`_Using filter: **${choice.name}**_\n\n${result}`);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Template selection — user replied with their template choice
    if (lastResponse.includes('<!-- jira:selecting-template -->')) {
      const selSession = ws.get<TemplateSelectionSession>('jira.session.templateSelection');
      if (selSession) {
        const choice = parseTemplateSelection(request.prompt, selSession.templateNames);
        if (choice === 'invalid') {
          await streamTemplateSelection(selSession.templateNames, stream, ws, selSession.originalPrompt);
          return;
        }
        await ws.update('jira.session.templateSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          const createdKey = await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws, choice, selSession.originalPrompt);
          if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Issue type selection — user replied with their type choice
    if (lastResponse.includes('<!-- jira:selecting-type -->')) {
      const typeSession = ws.get<IssueTypeSelectionSession>('jira.session.typeSelection');
      if (typeSession) {
        const choice = parseIssueTypeSelection(request.prompt, typeSession.issueTypes);
        if (choice === 'invalid') {
          await streamIssueTypeSelection(typeSession, stream, ws);
          return;
        }
        await ws.update('jira.session.typeSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        let selectedTemplate: JiraTemplate | null = null;
        if (typeSession.templateName && workspaceRoot) {
          try {
            const { templates } = new TemplateService(workspaceRoot).loadTemplates();
            selectedTemplate = templates.find((t) => t.name === typeSession.templateName) ?? null;
          } catch { /* proceed without */ }
        }
        try {
          const createdKey = await continueAfterIssueType(
            typeSession.project, typeSession.summary, choice, typeSession.description,
            selectedTemplate, request.model, stream, token, jiraClient, ticketService, ws,
            typeSession.extraFields,
          );
          if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Creation session continuation — user answered a section prompt
    if (lastResponse.includes('<!-- jira:creating -->')) {
      const session = ws.get<CreationSession>('jira.session.creating');
      if (session) {
        try {
          const justAnswered = session.pending[0];
          if (justAnswered === '__summary__') {
            session.summary = request.prompt;
          } else {
            session.answers[justAnswered] = request.prompt;
          }
          session.pending = session.pending.slice(1);
          if (session.pending.length === 0) {
            await ws.update('jira.session.creating', undefined);
            const createdKey = await finishTicketCreation(session, ticketService, stream);
            if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
          } else {
            await streamNextSection(session, stream, ws);
          }
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Content session — comment/description preview awaiting confirm/refine
    if (lastResponse.includes('<!-- jira:previewing -->')) {
      const session = ws.get<ContentSession>('jira.session.previewing');
      if (session) {
        try {
          await handleContentSession(session, request.prompt, request.model, token, stream, ticketService, ws);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Sprint selection — user replied with their sprint choice
    if (lastResponse.includes('<!-- jira:sprint-selection -->')) {
      const sprintSession = ws.get<SprintSelectionSession>('jira.session.sprintSelection');
      if (sprintSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.sprintSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        if (isNaN(idx) || idx < 1 || idx > sprintSession.candidates.length) {
          const list = sprintSession.candidates.map((s, i) => `${i + 1}. ${s.name} (${s.state})`).join('\n');
          stream.markdown(`Please reply with a number (1–${sprintSession.candidates.length}):\n\n${list}\n\n<!-- jira:sprint-selection -->`);
          return;
        }
        await ws.update('jira.session.sprintSelection', undefined);
        const chosen = sprintSession.candidates[idx - 1];
        if (sprintSession.pending.kind === 'field-update') {
          const preview: FieldUpdatePreviewSession = {
            ...sprintSession.pending.session,
            fieldValue: [{ id: chosen.id }],
          };
          await streamFieldUpdatePreview(preview, stream, ws);
        }
        return;
      }
    }

    // Field selection — user replied with their field choice
    if (lastResponse.includes('<!-- jira:selecting-field -->')) {
      const fieldSelSession = ws.get<FieldSelectionSession>('jira.session.fieldSelection');
      if (fieldSelSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.fieldSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        const chosen = (!isNaN(idx) && idx >= 1 && idx <= fieldSelSession.candidates.length)
          ? fieldSelSession.candidates[idx - 1]
          : fieldSelSession.candidates.find(f => f.name.toLowerCase() === trimmed.toLowerCase());
        if (!chosen) {
          const list = fieldSelSession.candidates.map((f, i) => `${i + 1}. ${f.name} (\`${f.id}\`)`).join('\n');
          stream.markdown(`Please reply with a number:\n\n${list}\n\n<!-- jira:selecting-field -->`);
          return;
        }
        await ws.update('jira.session.fieldSelection', undefined);
        const { fieldValue, arrayOp, ticketKeys } = fieldSelSession.pending;
        try {
          await continueSetField(ticketKeys, chosen, fieldValue, arrayOp, ticketService, stream, ws, request.model, token, config.spellCheck);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Field update preview — user replied ok / cancel
    if (lastResponse.includes('<!-- jira:field-update-preview -->')) {
      const previewSession = ws.get<FieldUpdatePreviewSession>('jira.session.fieldUpdatePreview');
      if (previewSession) {
        if (isCancellation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        if (isConfirmation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          const toUpdate = previewSession.ticketKeys;
          if (toUpdate.length === 1) {
            try {
              await jiraClient.updateIssue(toUpdate[0], { [previewSession.fieldId]: previewSession.fieldValue });
              stream.markdown(`Updated **${previewSession.fieldName}** on ${toUpdate[0]}.`);
              stream.markdown(`\n\n<!-- @jira-ticket:${toUpdate[0]} -->`);
            } catch (err) {
              stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            let passed = 0, failed = 0;
            await ticketService.bulkUpdateField(toUpdate, previewSession.fieldId, previewSession.fieldValue, (key, ok, err) => {
              if (ok) { stream.markdown(`✓ ${key}\n\n`); passed++; }
              else { stream.markdown(`✗ ${key}: ${err}\n\n`); failed++; }
            });
            stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
          }
          return;
        }
        // Not ok or cancel — re-present
        stream.markdown(`Please reply **ok** to apply, or **(c)** to cancel.\n\n<!-- jira:field-update-preview -->`);
        await ws.update('jira.session.fieldUpdatePreview', previewSession);
        return;
      }
    }

    // Spell-check session — user chose corrected / original / cancel
    if (lastResponse.includes('<!-- jira:spell-check -->')) {
      const spellSession = ws.get<SpellCheckSession>('jira.session.spellCheck');
      if (spellSession) {
        if (isCancellation(request.prompt)) {
          await ws.update('jira.session.spellCheck', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        await ws.update('jira.session.spellCheck', undefined);
        const keepNorm = request.prompt.trim().toLowerCase();
        const keepOriginal = ['k', 'keep', 'keep original', 'original', 'no'].includes(keepNorm);
        const preview: FieldUpdatePreviewSession = keepOriginal
          ? { ...spellSession.pending, fieldValue: spellSession.original }
          : spellSession.pending;
        try {
          await streamFieldUpdatePreview(preview, stream, ws);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // More-comments session — user confirmed "load all"
    if (lastResponse.includes('<!-- jira:more-comments -->') && isConfirmation(request.prompt)) {
      const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
      if (session) {
        try {
          await ws.update('jira.session.moreComments', undefined);
          const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
          if (session.displayMode === 'full') {
            await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            stream.markdown(formatCommentsInFull(comments));
            stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->\n\n<!-- jira:comment-list -->`);
          } else {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              session.commentQuery,
              request.model,
              token,
            );
            if (!session.commentQuery) {
              await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            }
            stream.markdown(synthesis);
            const listTag = session.commentQuery ? '' : '\n\n<!-- jira:comment-list -->';
            stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->${listTag}`);
          }
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    // Bulk update review — user replied ok / skip keys / cancel
    if (lastResponse.includes('<!-- jira:bulk-update-review -->')) {
      const bulkSession = ws.get<BulkUpdateReviewSession>('jira.session.bulkUpdateReview');
      if (bulkSession) {
        const decision = parseBulkUpdateReview(request.prompt);
        if (decision.action === 'invalid') {
          stream.markdown(`Didn't understand that. Reply **ok** to apply, **(c)** to cancel, or \`skip KEY1 KEY2\` to skip specific tickets.\n\n<!-- jira:bulk-update-review -->`);
          return;
        }
        await ws.update('jira.session.bulkUpdateReview', undefined);
        if (decision.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        const skipSet = new Set(decision.skip);
        const toUpdate = bulkSession.ticketKeys.filter(k => !skipSet.has(k));
        stream.markdown(`Updating **${bulkSession.fieldName}** on ${toUpdate.length} ticket(s)…\n\n`);
        let passed = 0;
        let failed = 0;
        await ticketService.bulkUpdateField(toUpdate, bulkSession.fieldId, bulkSession.fieldValue, (key, ok, err) => {
          if (ok) { stream.markdown(`✓ ${key}\n\n`); passed++; }
          else { stream.markdown(`✗ ${key}: ${err}\n\n`); failed++; }
        });
        stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
        return;
      }
    }

    // Comment list — user replied with a comment number to view in full
    if (lastResponse.includes('<!-- jira:comment-list -->')) {
      const commentSession = ws.get<CommentListSession>('jira.session.commentList');
      if (commentSession) {
        const index = parseCommentIndex(request.prompt, commentSession.comments.length);
        if (index !== 'invalid') {
          const entry = commentSession.comments[index - 1];
          stream.markdown(`**Comment ${index}** — ${entry.author} (${entry.date})\n\n${entry.bodyMarkdown}`);
          stream.markdown(`\n\n<!-- @jira-ticket:${commentSession.ticketKey} -->\n\n<!-- jira:comment-list -->`);
          return;
        }
        // Not a comment index — fall through to intent parse
      }
    }

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
    } catch (err) {
      stream.markdown(`Could not understand the request: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // createTicket has its own multi-turn flow
    if (intent.operation === 'createTicket') {
      try {
        const createdKey = await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws);
        if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
      } catch (err) {
        stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (intent.operation === 'discoverWorkflow') {
      try {
        await handleDiscoverWorkflow(intent, stream, jiraClient);
      } catch (err) {
        stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (intent.operation === 'runCleanup') {
      try {
        await handleRunCleanup(intent, stream, jiraClient, ticketService, ws);
      } catch (err) {
        stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    let ticketKey = intent.ticketKey;
    if (!ticketKey && intent.operation !== 'searchJql' && intent.operation !== 'bulkTransition' && intent.operation !== 'bulkUpdateField') {
      ticketKey = resolveTicketFromBranch();
      if (ticketKey) {
        stream.markdown(`_Using ticket **${ticketKey}** from current branch._\n\n`);
      } else {
        ticketKey = parseLastTicketFromContext(chatContext);
        if (ticketKey) {
          stream.markdown(`_Using last referenced ticket **${ticketKey}**._\n\n`);
        } else {
          stream.markdown('Which ticket are you referring to? (e.g. `@jira show me PROJ-123`)');
          return;
        }
      }
    }

    try {
      let result: string;
      switch (intent.operation) {
        case 'getTicket': {
          const fieldMeta = await ticketService.getFieldMeta();
          const alwaysShowIds = new Set<string>(config.additionalDisplayFields);
          const hiddenIds = new Set<string>(config.hiddenDisplayFields);
          const base = await ticketService.getTicket(ticketKey!, fieldMeta, alwaysShowIds, hiddenIds);
          const MAX_SHOW = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW);
          if (comments.length > 0) {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              null,
              request.model,
              token,
            );
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
            stream.markdown(base + '\n\n**Comments:**\n\n' + synthesis);
            if (total > MAX_SHOW) {
              const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null };
              await ws.update('jira.session.moreComments', moreSession);
              stream.markdown(`\n\n_${total - MAX_SHOW} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->\n\n<!-- jira:comment-list -->`);
            } else {
              stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:comment-list -->`);
            }
            return;
          }
          result = base;
          break;
        }
        case 'summarizeTicket': {
          const summaryFieldMeta = await ticketService.getFieldMeta();
          const summaryAlwaysShow = new Set<string>(config.additionalDisplayFields);
          const summaryHidden = new Set<string>(config.hiddenDisplayFields);
          const fullTicket = await ticketService.getTicket(ticketKey!, summaryFieldMeta, summaryAlwaysShow, summaryHidden);
          // Title + table before the first ## section heading
          const sectionStart = fullTicket.indexOf('\n\n## ');
          const fieldsHeader = sectionStart >= 0 ? fullTicket.slice(0, sectionStart) : fullTicket;
          const descriptionText = sectionStart >= 0 ? fullTicket.slice(sectionStart + 2) : '';
          const { comments: summaryComments } = await ticketService.getIssueComments(ticketKey!, 20);
          const commentBlocks = summaryComments.length > 0 ? serializeCommentsForLLM(summaryComments) : null;
          const synthesis = await generateDescriptionAndCommentsSummary(descriptionText, commentBlocks, request.model, token);
          stream.markdown(fieldsHeader + '\n\n**Overview:**\n\n' + synthesis);
          stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
          return;
        }
        case 'showComments': {
          const MAX_SHOW_FULL = 20;
          const { comments: fullComments, total: fullTotal } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW_FULL);
          if (fullComments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, fullComments));
          stream.markdown(`## Comments (${fullTotal})\n\n` + formatCommentsInFull(fullComments));
          if (fullTotal > MAX_SHOW_FULL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null, displayMode: 'full' };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(`\n\n_${fullTotal - MAX_SHOW_FULL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->\n\n<!-- jira:comment-list -->`);
          } else {
            stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:comment-list -->`);
          }
          return;
        }
        case 'getComments': {
          const MAX_INITIAL = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_INITIAL);
          if (comments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          const synthesis = await synthesizeComments(
            serializeCommentsForLLM(comments),
            intent.commentQuery,
            request.model,
            token,
          );
          const hasQuery = Boolean(intent.commentQuery);
          if (!hasQuery) {
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
          }
          stream.markdown(synthesis);
          const listTag = hasQuery ? '' : '\n\n<!-- jira:comment-list -->';
          if (total > MAX_INITIAL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(`\n\n_${total - MAX_INITIAL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->${listTag}`);
          } else {
            stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->${listTag}`);
          }
          return;
        }
        case 'addComment': {
          const isLiteral = intent.contentSource === 'literal' || intent.contentSource === undefined;
          if (!intent.comment && isLiteral) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          if (isLiteral) {
            result = await ticketService.addComment(ticketKey!, intent.comment!);
          } else {
            const ticketText = await ticketService.getTicket(ticketKey!);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 50);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';
            const context = await buildContentContext(request, chatContext, ticketText, commentBlocks);
            const content = await generateContent(request.prompt, request.model, token, context);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate comment content — the AI model declined the request. Try rephrasing your instruction or use \`@jira add comment to ${ticketKey}\` with explicit text._`);
              return;
            }
            await streamContentPreview({ ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context }, stream, ws);
            return;
          }
          break;
        }
        case 'updateField': {
          const fieldNameRaw = intent.fieldName ?? intent.fieldUpdates?.[0]?.fieldName;
          const fieldValueRaw = intent.fieldValue ?? intent.fieldUpdates?.[0]?.fieldValue ?? '';
          if (!fieldNameRaw) {
            stream.markdown('Please specify a field name and value to update.');
            return;
          }
          // Description with non-literal content → ContentSession
          const isNonLiteral = intent.contentSource !== 'literal' && intent.contentSource !== undefined;
          if (fieldNameRaw.toLowerCase() === 'description' && isNonLiteral) {
            const descFieldMeta = await ticketService.getFieldMeta();
            const descAlwaysShow = new Set<string>(config.additionalDisplayFields);
            const descHidden = new Set<string>(config.hiddenDisplayFields);
            const ticketText = await ticketService.getTicket(ticketKey!, descFieldMeta, descAlwaysShow, descHidden);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 20);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';
            const contentCtx = await buildContentContext(request, chatContext, ticketText, commentBlocks);
            const content = await generateContent(fieldValueRaw, request.model, token, contentCtx);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate description content — the AI model declined the request. Try rephrasing your instruction._`);
              return;
            }
            await streamContentPreview({ ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx }, stream, ws);
            return;
          }
          // All other fields → fuzzy match + preview flow
          const setFieldMeta = await ticketService.getFieldMeta();
          const setTicketKeys = intent.scope === 'bulk'
            ? (ws.get<SearchResultSession>('jira.session.searchResult')?.ticketKeys ?? [ticketKey!])
            : [ticketKey!];
          await handleSetField(
            setTicketKeys, fieldNameRaw, fieldValueRaw, intent.arrayOp ?? 'set',
            setFieldMeta, ticketService, stream, ws, request.model, token, config.spellCheck,
          );
          return;
        }
        case 'showFields': {
          const showFieldMeta = await ticketService.getFieldMeta();
          result = await ticketService.showFields(ticketKey!, showFieldMeta);
          break;
        }
        case 'searchJql': {
          let resolvedJql: string;
          let jqlLabel = '';
          if (intent.filterId) {
            const filter = await ticketService.getFilterById(intent.filterId);
            resolvedJql = filter.jql;
            jqlLabel = `_Using filter: **${filter.name}**_\n\n`;
          } else if (intent.filterName) {
            const filters = await ticketService.searchFiltersByName(intent.filterName);
            if (filters.length === 0) {
              result = `No saved filters found matching "${intent.filterName}".`;
              break;
            } else if (filters.length === 1) {
              resolvedJql = filters[0].jql;
              jqlLabel = `_Using filter: **${filters[0].name}**_\n\n`;
            } else {
              const session: FilterSelectionSession = { filters, originalPrompt: request.prompt };
              await ws.update('jira.session.filterSelection', session);
              const list = filters.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
              stream.markdown(`Multiple filters match "${intent.filterName}":\n\n${list}\n\nWhich one? Reply with the number or name, or **(c)** to cancel.\n\n<!-- jira:selecting-filter -->`);
              return;
            }
          } else {
            resolvedJql = intent.jql ?? request.prompt;
          }
          const raw = await ticketService.searchTicketsRaw(resolvedJql);
          if (raw.issues.length > 0) {
            const searchSession: SearchResultSession = { ticketKeys: raw.issues.map(i => i.key), jql: resolvedJql };
            await ws.update('jira.session.searchResult', searchSession);
          }
          result = jqlLabel + await ticketService.searchTickets(resolvedJql);
          break;
        }
        case 'bulkTransition': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.targetStatus) {
            result = 'Please specify a target status (e.g. "transition them to Done").';
            break;
          }
          const targetStatus = intent.targetStatus;
          stream.markdown(`_Building transition paths…_\n\n`);
          const tickets: TransitionBatchTicket[] = [];
          for (const key of searchSession.ticketKeys) {
            const issue = await jiraClient.getIssue(key);
            const transitions = await jiraClient.getTransitions(key);
            // Build a single-level graph from the ticket's current available transitions
            const graph: WorkflowGraph = {
              [issue.fields.status.name]: transitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
            };
            const currentStatus = issue.fields.status.name;
            const path = findPath(graph, currentStatus, targetStatus);
            if (path === null) {
              stream.markdown(`_Warning: no direct transition from **${currentStatus}** to **${targetStatus}** for ${key} — skipping. Use a workflow cache for multi-hop paths._\n\n`);
              continue;
            }
            const subtasks: TransitionSubtask[] = [];
            for (const s of (issue.fields.subtasks ?? [])) {
              const subTransitions = await jiraClient.getTransitions(s.key);
              const subGraph: WorkflowGraph = {
                [s.fields.status.name]: subTransitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
              };
              const subPath = findPath(subGraph, s.fields.status.name, targetStatus);
              if (subPath) subtasks.push({ key: s.key, summary: s.fields.summary, currentStatus: s.fields.status.name, transitionPath: subPath });
            }
            tickets.push({ key, summary: issue.fields.summary, currentStatus, transitionPath: path, subtasks });
          }
          if (tickets.length === 0) {
            result = `No tickets could be transitioned to **${targetStatus}** — all were either already there or have no direct path.`;
            break;
          }
          const CLOSED_STATES = new Set(['done', 'closed', 'resolved', 'cancelled', 'canceled']);
          if (CLOSED_STATES.has(targetStatus.toLowerCase())) {
            const resolutions = await jiraClient.getResolutions();
            if (resolutions.length > 0) {
              const resSession: ResolutionSelectionSession = {
                resolutionOptions: resolutions.map(r => r.name),
                tickets,
                ruleName: undefined,
                targetState: targetStatus,
              };
              await ws.update('jira.session.resolutionSelection', resSession);
              const list = resolutions.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
              stream.markdown(`Which resolution should be set when transitioning to **${targetStatus}**?\n\n${list}\n\nReply with the name or number, or **none** to skip setting a resolution.\n\n<!-- jira:selecting-resolution -->`);
              return;
            }
          }
          const batchSession: TransitionBatchSession = { tickets, resolution: undefined, ruleName: undefined };
          await streamReviewScreen(batchSession, stream, ws, `**Bulk transition → ${targetStatus}**`);
          return;
        }
        case 'bulkUpdateField': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.bulkFieldName || intent.bulkFieldValue === null) {
            result = 'Please specify both a field name and a value (e.g. "set Team Names to ASL Cary").';
            break;
          }
          const fieldId = await ticketService.resolveFieldId(intent.bulkFieldName);
          const fieldValue = await ticketService.buildFieldValue(fieldId, searchSession.ticketKeys[0], intent.bulkFieldValue!);
          const issues = await Promise.all(searchSession.ticketKeys.map(k => jiraClient.getIssue(k)));
          const rows = issues.map(issue => {
            const current = issue.fields[fieldId];
            const display = current ? JSON.stringify(current) : '—';
            return `| ${issue.key} | ${issue.fields.summary} | ${display} |`;
          });
          const bulkSession: BulkUpdateReviewSession = {
            ticketKeys: searchSession.ticketKeys,
            fieldId,
            fieldName: intent.bulkFieldName,
            fieldValue,
            arrayOp: 'set',
          };
          await ws.update('jira.session.bulkUpdateReview', bulkSession);
          stream.markdown(
            `**Bulk update: ${intent.bulkFieldName} → ${intent.bulkFieldValue}**\n` +
            `(${searchSession.ticketKeys.length} tickets)\n\n` +
            `| Key | Summary | Current value |\n| --- | --- | --- |\n` +
            rows.join('\n') +
            `\n\nReply **ok** to apply, **(c)** to cancel, or list keys to skip (e.g. \`skip PROJ-2\`).\n\n<!-- jira:bulk-update-review -->`
          );
          return;
        }
        case 'validateFields':
          result = await ticketService.validateRequiredFields(ticketKey!, config.requiredFields);
          break;
        default:
          result = 'Unrecognised operation.';
      }
      stream.markdown(result);
      if (ticketKey) stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
