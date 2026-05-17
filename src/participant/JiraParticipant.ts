import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService, assembleDescription, extractTextFromAdf } from '../services/TicketService';
import type { JiraComment } from '../jira/IJiraClient';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import { extractTicketId } from '../utils/branchParser';
import { type CreationSession, type ContentSession, type MoreCommentsSession, type TemplateSelectionSession, type IssueTypeSelectionSession, type TransitionBatchSession, type TransitionBatchTicket, type TransitionSubtask, type ResolutionSelectionSession, extractCreatedKeyFromConfirmation, extractLastTicketFromText, stripHiddenMarkers, serializeTurns, isConfirmation, isCancellation, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection } from './sessionState';
import { discoverWorkflow, loadWorkflowCache, saveWorkflowCache, findPath } from '../services/WorkflowService';
import type { CleanupRule } from '../templates/TemplateService';

type Operation =
  | 'getTicket'
  | 'getComments'
  | 'addComment'
  | 'updateField'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket'
  | 'discoverWorkflow'
  | 'runCleanup';

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
  description: string | null;
  comment: string | null;
  commentQuery: string | null;
  contentSource: 'literal' | 'generate' | 'history-recent' | 'history-full';
  fieldUpdates: FieldUpdate[];
  jql: string | null;
  cleanupRuleName: string | null;
  fixVersion: string | null;
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"getComments"|"addComment"|"updateField"|"searchJql"|"validateFields"|"createTicket"|"discoverWorkflow"|"runCleanup","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"assignee":string|null,"description":string|null,"comment":string|null,"commentQuery":string|null,"contentSource":"literal"|"generate"|"history-recent"|"history-full","fieldUpdates":[{"fieldName":string,"fieldValue":string}],"jql":string|null,"cleanupRuleName":string|null,"fixVersion":string|null}
- getTicket: show, summarise, describe, look up a specific ticket
- getComments: ask whether a ticket has comments, how many comments, list or read comments, or find comments about a topic; commentQuery is the topic/filter the user mentioned (e.g. "login bug", "performance") — null if they just want a general list
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update one or more fields; put each field change in fieldUpdates array; for description/comment content instructions put the instruction as fieldValue — do NOT generate the content
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided
- validateFields: check, validate required fields on a ticket
- createTicket: create, open, add a new ticket/issue/bug/story/task; description is any additional body content the user provided beyond the summary (e.g. code blocks, steps to reproduce, specifications) — null if no extra content; assignee is the person to assign the ticket to ("me"/"myself" for the current user, or a name/email) — null if not mentioned
- discoverWorkflow: discover or refresh the workflow graph for a project and issue type; projectKey and issueType are required
- runCleanup: bulk-close or bulk-transition ALL tickets of a type in a project; triggered by "close all", "run cleanup", or "close PROJECT ISSUETYPE" where PROJECT is a project key and ISSUETYPE is an issue type name (not a ticket key like PROJ-123); projectKey and issueType are extracted from the prompt; cleanupRuleName is the quoted rule name if given; fixVersion is the exact fix version string if given (must be quoted in the prompt, e.g. "Fix Version 3.2"); examples: "@jira close VSJI Bug", "@jira run cleanup 'Close released bugs'", "@jira close BILLING bugs in 'Release 3.2'"
- contentSource: how the comment or description content should be produced
  - "literal": user provided the exact text to post (e.g. "add comment: LGTM")
  - "generate": user gave an instruction to create new content with no reference to the conversation (e.g. "write a poem about Star Trek", "add a 12-line poem as comment")
  - "history-recent": user references a specific artifact from the last few messages (e.g. "add that poem", "post the result above", "add it as a comment")
  - "history-full": user wants a synthesis or summary of the broader conversation (e.g. "summarize our analysis and add as comment", "document what we found")
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
  historyContext?: string,
): Promise<string> {
  const prompt = historyContext
    ? `Conversation history:\n\n${historyContext}\n\nBased on the conversation above, ${instruction}. Produce only the final content, no preamble, no markdown code fences, no explanation.`
    : `Generate content based on this instruction: "${instruction}". Produce only the final content, no preamble, no markdown code fences, no explanation.`;
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  let content = '';
  for await (const chunk of response.text) {
    content += chunk;
  }
  return content.trim();
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

function serializeCommentsForLLM(comments: JiraComment[]): string {
  return comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = extractTextFromAdf(c.body).trim() || '_empty_';
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
    : 'Summarise each comment in one sentence. Format: **Author** (date): one-sentence summary.';
  const prompt = `Comments:\n\n${commentBlocks}\n\n${task} Produce only the final content, no preamble.`;
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
    if (session.operation === 'addComment') {
      result = await ticketService.addComment(session.ticketKey, session.currentContent);
    } else {
      result = await ticketService.updateField(session.ticketKey, 'description', session.currentContent);
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
  summary: string,
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
  if (sections.length > 0) {
    const covered = await checkSectionCoverage(description ?? '', sections, model, token);
    const answers: Record<string, string> = {};
    for (const s of covered) answers[s] = description ?? '';
    const pending = sections.filter((s) => !covered.includes(s));

    if (pending.length === 0) {
      const descriptionText = assembleDescription(sections, answers);
      resolvedFields.description = descriptionText;
      const result = await ticketService.createTicket(projectKey, summary, issueType, resolvedFields);
      stream.markdown(result);
      return extractCreatedKeyFromConfirmation(result);
    }
    const fieldNames = Object.keys(resolvedFields).filter((k) => k !== 'description').join(', ');
    stream.markdown(`_Using template **${selectedTemplate!.name}**${fieldNames ? ` — defaults: ${fieldNames}` : ''}._\n\n`);
    if (covered.length > 0) {
      stream.markdown(`_Your description already covers **${covered.join(', ')}**._\n\n`);
    }
    const newSession: CreationSession = {
      template: selectedTemplate!.name,
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
  const answered = session.allSections.length - session.pending.length;
  const isLast = session.pending.length === 1;
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
): Promise<void> {
  const session: TemplateSelectionSession = { templateNames };
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
  const result = await ticketService.createTicket(
    session.project,
    session.summary,
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
      await streamTemplateSelection(templates.map((t) => t.name), stream, workspaceState);
      return null;
    }
  }

  const intent = await parseIntent(request.prompt, request.model, token);
  const projectKey = await resolveProjectKey(intent.projectKey, stream);
  if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return null; }

  let summary = intent.summary;
  if (!summary) {
    summary = await vscode.window.showInputBox({ prompt: 'Enter a summary for the new ticket', ignoreFocusOut: true }) ?? null;
  }
  if (!summary) { stream.markdown('No summary provided — cancelled.'); return null; }

  // Resolve assignee if specified
  const extraFields: Record<string, unknown> = {};
  if (intent.assignee) {
    const resolved = await ticketService.resolveAssignee(intent.assignee);
    if (typeof resolved === 'string') { stream.markdown(resolved); return null; }
    extraFields.assignee = resolved;
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
  const graph = await discoverWorkflow(jiraClient, projectKey, issueType);
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
  stream.markdown(`Workflow discovered for **${projectKey} / ${issueType}** (${statuses.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`);
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
      apiVersion: config.apiVersion,
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v${config.apiVersion} · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(jiraClient);
    const ws = context.workspaceState;
    const lastResponse = getLastAssistantText(chatContext);

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

    // Template selection — user replied with their template choice
    if (lastResponse.includes('<!-- jira:selecting-template -->')) {
      const selSession = ws.get<TemplateSelectionSession>('jira.session.templateSelection');
      if (selSession) {
        const choice = parseTemplateSelection(request.prompt, selSession.templateNames);
        if (choice === 'invalid') {
          await streamTemplateSelection(selSession.templateNames, stream, ws);
          return;
        }
        await ws.update('jira.session.templateSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          const createdKey = await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws, choice);
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
          session.answers[justAnswered] = request.prompt;
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

    // More-comments session — user confirmed "load all"
    if (lastResponse.includes('<!-- jira:more-comments -->') && isConfirmation(request.prompt)) {
      const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
      if (session) {
        try {
          await ws.update('jira.session.moreComments', undefined);
          const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
          const synthesis = await synthesizeComments(
            serializeCommentsForLLM(comments),
            session.commentQuery,
            request.model,
            token,
          );
          stream.markdown(synthesis);
          stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->`);
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
    }

    if (/^check(\s+(config|connection|setup))?$/i.test(request.prompt.trim())) {
      try {
        const user = await jiraClient.getCurrentUser();
        stream.markdown(
          `**Jira connection OK**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl}\` |\n` +
          `| API version | v${config.apiVersion} |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Logged in as | ${user.displayName} |\n`,
        );
      } catch (err) {
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl}\` |\n` +
          `| API version | v${config.apiVersion} |\n` +
          `| Auth type | ${config.authType} |\n\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
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
    if (!ticketKey && intent.operation !== 'searchJql') {
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
        case 'getTicket':
          result = await ticketService.getTicket(ticketKey!);
          break;
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
          stream.markdown(synthesis);
          if (total > MAX_INITIAL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(`\n\n_${total - MAX_INITIAL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->`);
          } else {
            stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
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
            const historyContext = buildHistoryContext(intent.contentSource, chatContext);
            const content = await generateContent(request.prompt, request.model, token, historyContext);
            await streamContentPreview({ ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext }, stream, ws);
            return;
          }
          break;
        }
        case 'updateField': {
          if (!intent.fieldUpdates || intent.fieldUpdates.length === 0) {
            stream.markdown('Please specify a field name and value to update.');
            return;
          }
          const results: string[] = [];
          for (const { fieldName, fieldValue } of intent.fieldUpdates) {
            const isNonLiteral = intent.contentSource !== 'literal' && intent.contentSource !== undefined;
            if (fieldName.toLowerCase() === 'description' && isNonLiteral) {
              const historyContext = buildHistoryContext(intent.contentSource, chatContext);
              const content = await generateContent(fieldValue, request.model, token, historyContext);
              await streamContentPreview({ ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext }, stream, ws);
              return;
            } else {
              results.push(await ticketService.updateField(ticketKey!, fieldName, fieldValue));
            }
          }
          result = results.join('\n');
          break;
        }
        case 'searchJql':
          result = await ticketService.searchTickets(intent.jql ?? request.prompt);
          break;
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
