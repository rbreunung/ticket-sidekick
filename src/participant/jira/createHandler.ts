import * as vscode from 'vscode';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TicketService, assembleDescription } from '../../services/TicketService';
import { TemplateService } from '../../templates/TemplateService';
import type { JiraTemplate } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { ContentSession, CreationSession, IssueTypeSelectionSession, TemplateSelectionSession } from '../sessionState';
import { streamContentPreview } from './contentHandler';
import { parseIntent } from './llmHelpers';
import { resolveProjectKey } from './ticketContext';

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

async function checkSectionCoverage(
  prompt: string,
  sections: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string[]> {
  const roleSetup = vscode.LanguageModelChatMessage.User(
    'You are a content coverage analyst. Your task is to determine which template sections are addressed by the given text.',
  );
  const roleAck = vscode.LanguageModelChatMessage.Assistant(
    'Understood. I identify which sections are covered.',
  );
  const task = vscode.LanguageModelChatMessage.User(
    `Does this text address any of these sections? Reply with ONLY a JSON array of section names that are clearly covered.\nSections: ${JSON.stringify(sections)}\nText: ${JSON.stringify(prompt)}`,
  );
  const messages = [roleSetup, roleAck, task];
  let raw = await sendAndCollect(model, messages, token);
  let match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    // One retry: feed the unparseable reply back and ask again, before giving up.
    messages.push(
      vscode.LanguageModelChatMessage.Assistant(raw),
      vscode.LanguageModelChatMessage.User(
        'Your last reply was not a valid JSON array. Reply again with ONLY the JSON array, no other text.',
      ),
    );
    raw = await sendAndCollect(model, messages, token);
    match = raw.match(/\[[\s\S]*\]/);
  }
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}

export async function streamIssueTypeSelection(
  session: IssueTypeSelectionSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
): Promise<void> {
  await workspaceState.update('jira.session.typeSelection', session);
  const list = session.issueTypes.map((t, i) => `${i + 1}. ${t}`).join('\n');
  stream.markdown(`Which issue type?\n\n${list}\n\nReply with the name or number, or **(c)** to cancel.\n\n<!-- jira:selecting-type -->`);
}

export async function continueAfterIssueType(
  projectKey: string,
  summary: string | null,
  issueType: string,
  description: string | null,
  selectedTemplate: JiraTemplate | null,
  model: vscode.LanguageModelChat,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: IJiraClient,
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

  // Fast path: summary known, no sections → show content preview
  if (summary !== null && sections.length === 0) {
    const contentSession: ContentSession = {
      operation: 'createTicket',
      projectKey,
      summary,
      issueType,
      templateName: selectedTemplate?.name ?? null,
      extraFields: resolvedFields,
      currentContent: description ?? '',
    };
    await streamContentPreview(contentSession, stream, workspaceState);
    return null;
  }

  // Build the pending section list, checking description coverage only when summary is known
  const covered = summary !== null && description
    ? await checkSectionCoverage(description, sections, model, token)
    : [];
  const answers: Record<string, string> = {};
  for (const s of covered) answers[s] = description ?? '';
  const pendingRealSections = sections.filter((s) => !covered.includes(s));

  // Fast path: all sections covered, summary known → show content preview
  if (summary !== null && pendingRealSections.length === 0) {
    const descriptionText = assembleDescription(sections, answers);
    const contentSession: ContentSession = {
      operation: 'createTicket',
      projectKey,
      summary,
      issueType,
      templateName: selectedTemplate?.name ?? null,
      extraFields: resolvedFields,
      currentContent: descriptionText,
    };
    await streamContentPreview(contentSession, stream, workspaceState);
    return null;
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

export async function streamNextSection(session: CreationSession, stream: vscode.ChatResponseStream, workspaceState: vscode.Memento): Promise<void> {
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

export async function streamTemplateSelection(
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

export async function finishTicketCreation(
  session: CreationSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
): Promise<null> {
  if (!session.summary) {
    stream.markdown('_Cannot create ticket: no summary was provided._');
    return null;
  }
  const descriptionText = assembleDescription(session.allSections, session.answers);
  const contentSession: ContentSession = {
    operation: 'createTicket',
    projectKey: session.project,
    summary: session.summary,
    issueType: session.issueType,
    templateName: session.template || null,
    extraFields: { ...session.fields },
    currentContent: descriptionText,
  };
  await streamContentPreview(contentSession, stream, workspaceState);
  return null;
}

export async function handleCreateTicket(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: IJiraClient,
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
