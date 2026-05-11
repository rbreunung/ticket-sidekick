import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService, assembleDescription, wrapInAdf } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import { extractTicketId } from '../utils/branchParser';
import { type CreationSession, extractCreationSessionFromText, extractCreatedKeyFromConfirmation, extractLastTicketFromText, stripHiddenMarkers, serializeTurns } from './sessionState';

type Operation =
  | 'getTicket'
  | 'getComments'
  | 'addComment'
  | 'updateField'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket';

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
  description: string | null;
  comment: string | null;
  contentSource: 'literal' | 'generate' | 'history-recent' | 'history-full';
  fieldUpdates: FieldUpdate[];
  jql: string | null;
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"getComments"|"addComment"|"updateField"|"searchJql"|"validateFields"|"createTicket","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"description":string|null,"comment":string|null,"contentSource":"literal"|"generate"|"history-recent"|"history-full","fieldUpdates":[{"fieldName":string,"fieldValue":string}],"jql":string|null}
- getTicket: show, summarise, describe, look up a specific ticket
- getComments: ask whether a ticket has comments, how many comments, list or read comments on a ticket
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update one or more fields; put each field change in fieldUpdates array; for description/comment content instructions put the instruction as fieldValue — do NOT generate the content
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided
- validateFields: check, validate required fields on a ticket
- createTicket: create, open, add a new ticket/issue/bug/story/task; description is any additional body content the user provided beyond the summary (e.g. code blocks, steps to reproduce, specifications) — null if no extra content
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

async function previewAndConfirm(
  initial: string,
  postLabel: string,
  title: string,
  historyContext: string | undefined,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  let content = initial;
  for (;;) {
    stream.markdown(`**Preview:**\n\n${content}\n\n`);
    const choice = await vscode.window.showQuickPick([postLabel, 'Refine...', 'Cancel'], {
      title,
      ignoreFocusOut: true,
    });
    if (choice === postLabel) return content;
    if (choice !== 'Refine...') return null;
    const refinement = await vscode.window.showInputBox({
      prompt: 'How would you like to refine this?',
      placeHolder: 'e.g. make it shorter, use a more formal tone',
      ignoreFocusOut: true,
    });
    if (!refinement) return null;
    const refineContext = [historyContext, `Previously generated:\n${content}`]
      .filter(Boolean)
      .join('\n\n');
    content = await generateContent(refinement, model, token, refineContext);
  }
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

  const defaultProject = vscode.workspace.getConfiguration('jiraCopilot').get<string>('defaultProject') ?? '';
  if (defaultProject) return defaultProject;

  stream.markdown('_No project key found in your message or settings — opening input box…_\n\n');
  const entered = await vscode.window.showInputBox({
    prompt: 'Enter the Jira project key (e.g. VSJI)',
    placeHolder: 'PROJECT',
    ignoreFocusOut: true,
  });
  return entered ?? null;
}

async function resolveIssueType(
  fromIntent: string | null,
  projectKey: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  if (fromIntent) return fromIntent;

  let types: { name: string }[];
  try {
    types = await ticketService.getIssueTypes(projectKey);
  } catch {
    types = [];
  }

  if (types.length === 0) {
    stream.markdown('_Could not fetch issue types — opening input box…_\n\n');
    return vscode.window.showInputBox({
      prompt: 'Enter the issue type (e.g. Bug, Story, Task)',
      ignoreFocusOut: true,
    }).then((v) => v ?? null);
  }

  const picked = await vscode.window.showQuickPick(
    types.map((t) => t.name),
    { title: `Issue type for ${projectKey}`, ignoreFocusOut: true },
  );
  return picked ?? null;
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

function parseCreationSession(context: vscode.ChatContext): CreationSession | null {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      const result = extractCreationSessionFromText(text);
      if (result) return result;
    }
  }
  return null;
}

function streamNextSection(session: CreationSession, stream: vscode.ChatResponseStream): void {
  const next = session.pending[0];
  const isLast = session.pending.length === 1;
  stream.markdown(isLast ? `Last one:\n\n**${next}** — ` : `**${next}** — `);
  stream.markdown(`\n\n<!-- @jira-create:${JSON.stringify(session)} -->`);
}

async function finishTicketCreation(
  session: CreationSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  const descriptionText = assembleDescription(session.allSections, session.answers);
  const additionalFields: Record<string, unknown> = {
    ...session.fields,
    description: wrapInAdf(descriptionText),
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
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
): Promise<string | null> {
  // --- Continuing an in-progress session ---
  const session = parseCreationSession(context);
  if (session) {
    const justAnswered = session.pending[0];
    session.answers[justAnswered] = request.prompt;
    session.pending = session.pending.slice(1);
    if (session.pending.length === 0) {
      return finishTicketCreation(session, ticketService, stream);
    } else {
      streamNextSection(session, stream);
      return null;
    }
  }

  // --- Fresh start: load templates ---
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let templates: JiraTemplate[] = [];
  if (workspaceRoot) {
    try {
      templates = new TemplateService(workspaceRoot).loadTemplates();
    } catch (err) {
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Template error: ${err instanceof Error ? err.message : String(err)}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return null; }
    }
  }

  let selectedTemplate: JiraTemplate | null = null;
  if (templates.length > 0) {
    const items = [...templates.map((t) => t.name), 'Proceed without template'];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select a ticket template',
      ignoreFocusOut: true,
    });
    if (!picked) { stream.markdown('Cancelled.'); return null; }
    if (picked !== 'Proceed without template') {
      selectedTemplate = templates.find((t) => t.name === picked) ?? null;
    }
  }

  // Resolve project, summary, issueType
  const intent = await parseIntent(request.prompt, request.model, token);
  const projectKey = await resolveProjectKey(intent.projectKey, stream);
  if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return null; }

  let summary = intent.summary;
  if (!summary) {
    summary = await vscode.window.showInputBox({ prompt: 'Enter a summary for the new ticket', ignoreFocusOut: true }) ?? null;
  }
  if (!summary) { stream.markdown('No summary provided — cancelled.'); return null; }

  const issueType = await resolveIssueType(intent.issueType, projectKey, ticketService, stream);
  if (!issueType) { stream.markdown('No issue type selected — cancelled.'); return null; }

  // Resolve template fields
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

  // Check which description sections the user's prompt already covers
  if (selectedTemplate && selectedTemplate.descriptionSections.length > 0) {
    const covered = await checkSectionCoverage(
      request.prompt,
      selectedTemplate.descriptionSections,
      request.model,
      token,
    );
    const answers: Record<string, string> = {};
    for (const s of covered) answers[s] = request.prompt;
    const pending = selectedTemplate.descriptionSections.filter((s) => !covered.includes(s));

    if (pending.length === 0) {
      const descriptionText = assembleDescription(selectedTemplate.descriptionSections, answers);
      resolvedFields.description = wrapInAdf(descriptionText);
      const result = await ticketService.createTicket(projectKey, summary, issueType, resolvedFields);
      stream.markdown(result);
      return extractCreatedKeyFromConfirmation(result);
    } else {
      const fieldNames = Object.keys(resolvedFields).filter((k) => k !== 'description').join(', ');
      stream.markdown(`_Using template **${selectedTemplate.name}**${fieldNames ? ` — defaults: ${fieldNames}` : ''}._\n\n`);
      if (covered.length > 0) {
        stream.markdown(`_Your description already covers **${covered.join(', ')}**._\n\n`);
      }
      const newSession: CreationSession = {
        template: selectedTemplate.name,
        project: projectKey,
        summary,
        issueType,
        allSections: selectedTemplate.descriptionSections,
        pending,
        answers,
        fields: resolvedFields,
      };
      streamNextSection(newSession, stream);
      return null;
    }
  } else {
    // No template or no sections — create directly
    if (intent.description) {
      resolvedFields.description = wrapInAdf(intent.description);
    }
    const result = await ticketService.createTicket(
      projectKey,
      summary,
      issueType,
      Object.keys(resolvedFields).length > 0 ? resolvedFields : undefined,
    );
    stream.markdown(result);
    return extractCreatedKeyFromConfirmation(result);
  }
}

export function createParticipant(
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
        '**Jira base URL not configured.**\n\nAdd `jiraCopilot.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`).',
      );
      return;
    }

    if (!config.token) {
      const command =
        config.authType === 'cloud'
          ? 'Jira Copilot: Configure Cloud Credentials'
          : 'Jira Copilot: Set Personal Access Token';
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
    const ticketService = new TicketService(jiraClient);

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
    } catch (err) {
      stream.markdown(`Could not understand the request: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // createTicket has its own multi-turn flow — handle before the generic ticketKey logic
    if (intent.operation === 'createTicket') {
      try {
        const createdKey = await handleCreateTicket(request, chatContext, stream, token, jiraClient, ticketService);
        if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
      } catch (err) {
        stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Also handle in-progress creation sessions (user answered a section question)
    const session = parseCreationSession(chatContext);
    if (session) {
      try {
        const createdKey = await handleCreateTicket(request, chatContext, stream, token, jiraClient, ticketService);
        if (createdKey) stream.markdown(`\n\n<!-- @jira-ticket:${createdKey} -->`);
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
        case 'getComments':
          result = await ticketService.getComments(ticketKey!);
          break;
        case 'addComment': {
          const isLiteral = intent.contentSource === 'literal' || intent.contentSource === undefined;
          if (!intent.comment && isLiteral) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          let commentBody: string;
          if (isLiteral) {
            commentBody = intent.comment!;
          } else {
            const historyContext = buildHistoryContext(intent.contentSource, chatContext);
            const initial = await generateContent(request.prompt, request.model, token, historyContext);
            const confirmed = await previewAndConfirm(
              initial, 'Post comment', `Add this comment to ${ticketKey}?`,
              historyContext, request.model, token, stream,
            );
            if (!confirmed) { stream.markdown('_Cancelled._'); return; }
            commentBody = confirmed;
          }
          result = await ticketService.addComment(ticketKey!, commentBody);
          break;
        }
        case 'updateField': {
          if (!intent.fieldUpdates || intent.fieldUpdates.length === 0) {
            stream.markdown('Please specify a field name and value to update.');
            return;
          }
          const results: string[] = [];
          for (const { fieldName, fieldValue } of intent.fieldUpdates) {
            if (fieldName.toLowerCase() === 'description') {
              const historyContext = buildHistoryContext(intent.contentSource, chatContext);
              const generated = await generateContent(fieldValue, request.model, token, historyContext);
              if (intent.contentSource !== 'literal' && intent.contentSource !== undefined) {
                const confirmed = await previewAndConfirm(
                  generated, 'Update description', `Update description on ${ticketKey}?`,
                  historyContext, request.model, token, stream,
                );
                if (!confirmed) { stream.markdown('_Cancelled._'); return; }
                results.push(await ticketService.updateField(ticketKey!, fieldName, confirmed));
              } else {
                results.push(await ticketService.updateField(ticketKey!, fieldName, generated));
              }
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

  const participant = vscode.chat.createChatParticipant('jira-copilot.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
