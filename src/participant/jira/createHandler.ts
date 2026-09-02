import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { IJiraClient } from '../../jira/IJiraClient';
import { TicketService, assembleDescription } from '../../services/TicketService';
import { TemplateService } from '../../templates/TemplateService';
import type { JiraTemplate } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { ContentSession, CreationSession, CreateSelectionSession } from '../sessionState';
import { NO_ISSUE_TYPE, resolveTemplateIssueType, formatIssueTypeOptionLabel } from '../sessionState';
import { streamContentPreview } from './contentHandler';
import { parseIntent, looksLikeUnfilledPlaceholder } from './llmHelpers';
import { resolveProjectKey, resolveIssueTypeOrPrompt } from './ticketContext';

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
  } catch (err) {
    logDiag('jira.create', 'warn', 'Could not parse section-coverage response as JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
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
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.create', 'error', 'Template field resolution failed', { templateName: selectedTemplate?.name, error: message });
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Field resolution error: ${message}`,
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

export async function streamCreateSelection(
  session: CreateSelectionSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
): Promise<void> {
  await workspaceState.update('jira.session.creatingSelection', session);
  let optionsList = '';
  if (session.templates.length > 0) {
    optionsList += `**Templates:**\n${session.templates.map((t, i) => `${i + 1}. ${t.name} _(${formatIssueTypeOptionLabel(t.issueType)})_`).join('\n')}\n\n`;
  }
  if (session.issueTypes.length > 0) {
    const offset = session.templates.length;
    optionsList += `**Issue types (no template):**\n${session.issueTypes.map((t, i) => `${offset + i + 1}. ${formatIssueTypeOptionLabel(t)}`).join('\n')}\n\n`;
  }
  stream.markdown(`${optionsList}Reply with a number to select a template or issue type, or **(c)** to cancel.\n\n<!-- jira:selecting-create-option -->`);
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
): Promise<string | null> {
  // Project key is resolved first — issue types are project-scoped, so the combined list can't
  // be built without it (R4).
  const intent = await parseIntent(request.prompt, request.model, token);
  // R5: the walkthrough's direct-create button opens chat with unsent literal
  // `<TYPE> in <PROJECT>: <SUMMARY>` placeholders. Null out an unedited token right after the
  // intent parse so it flows into the existing "missing" paths (project input box, ask-for-summary)
  // instead of resolveProjectKey treating it as a real hint or it becoming the ticket's summary.
  // intent.issueType is never read in this function — the template/issue-type selection screen
  // below (streamCreateSelection) always shows regardless of what was parsed, so it needs no guard.
  if (looksLikeUnfilledPlaceholder(intent.projectKey)) intent.projectKey = null;
  if (looksLikeUnfilledPlaceholder(intent.summary)) intent.summary = null;
  const projectKey = await resolveProjectKey(intent.projectKey, stream);
  if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return null; }

  const extraFields: Record<string, unknown> = {};
  if (intent.assignee) {
    const resolved = await ticketService.resolveAssignee(intent.assignee);
    if (typeof resolved === 'string') { stream.markdown(resolved); return null; }
    extraFields.assignee = resolved;
  }
  if (intent.components) {
    extraFields.components = intent.components.split(',').map((c) => ({ name: c.trim() }));
  }

  // Issue types are always fetched up front, even when a template's own issue type would
  // otherwise have made the fetch unnecessary (R3).
  let issueTypes: string[] = [];
  try {
    const types = await ticketService.getIssueTypes(projectKey);
    issueTypes = types.map((t) => t.name);
  } catch (err) {
    logDiag('jira.create', 'warn', `Could not fetch issue types — ${projectKey}`, {
      projectKey, error: err instanceof Error ? err.message : String(err),
    });
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let templates: JiraTemplate[] = [];
  if (workspaceRoot) {
    try {
      ({ templates } = new TemplateService(workspaceRoot).loadTemplates());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.create', 'warn', 'Could not load templates — proceeding without template', { error: message });
      stream.markdown(`_Template error: ${message} — proceeding without template._\n\n`);
    }
  }

  if (templates.length === 0 && issueTypes.length === 0) {
    // Nothing to list — fall back to a chat-based ask (R6/KTD4).
    const entered = await resolveIssueTypeOrPrompt(NO_ISSUE_TYPE, {
      kind: 'create', projectKey, summary: intent.summary, description: intent.description,
      extraFields, pickedTemplateName: null,
    }, stream, workspaceState);
    if (entered === null) return null;
    return continueAfterIssueType(projectKey, intent.summary, entered, intent.description, null, request.model, stream, token, jiraClient, ticketService, workspaceState, extraFields);
  }

  // '' is a sentinel meaning "no resolvable issue type" — never a real Jira issue type name.
  // Picking a template or entry carrying it opens the shared chat-based ask (R6) instead of
  // guessing (see the routing block in JiraParticipant.ts). This covers both a template with no explicit
  // issueType when nothing was fetched to fall back to, and — when templates exist but the
  // issue-type fetch failed entirely — a standalone "type it yourself" entry, so there's always
  // a way to create a ticket without one of the listed templates (R6's intent extended to this
  // partial-failure case, not just the fully-empty one above).
  const session: CreateSelectionSession = {
    templates: templates.map((t) => ({ name: t.name, issueType: resolveTemplateIssueType(t.issueType, issueTypes) })),
    issueTypes: issueTypes.length > 0 ? issueTypes : [NO_ISSUE_TYPE],
    projectKey,
    summary: intent.summary,
    description: intent.description,
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    originalPrompt: request.prompt,
  };
  await streamCreateSelection(session, stream, workspaceState);
  return null;
}
