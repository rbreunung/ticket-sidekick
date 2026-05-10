import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService } from '../services/TicketService';
import { extractTicketId } from '../utils/branchParser';

type Operation =
  | 'getTicket'
  | 'addComment'
  | 'updateField'
  | 'searchJql'
  | 'validateFields'
  | 'createTicket';

interface ParsedIntent {
  operation: Operation;
  ticketKey: string | null;
  projectKey: string | null;
  summary: string | null;
  issueType: string | null;
  comment: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  jql: string | null;
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"addComment"|"updateField"|"searchJql"|"validateFields"|"createTicket","ticketKey":string|null,"projectKey":string|null,"summary":string|null,"issueType":string|null,"comment":string|null,"fieldName":string|null,"fieldValue":string|null,"jql":string|null}
- getTicket: show, summarise, describe, look up a specific ticket
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update a field (priority, assignee, summary, description, labels, fix version)
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided
- validateFields: check, validate required fields on a ticket
- createTicket: create, open, add a new ticket/issue/bug/story/task

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

export function createParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
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

    // createTicket has its own resolution flow — handle before the generic ticketKey logic
    if (intent.operation === 'createTicket') {
      try {
        const projectKey = await resolveProjectKey(intent.projectKey, stream);
        if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return; }

        let summary = intent.summary;
        if (!summary) {
          summary = await vscode.window.showInputBox({
            prompt: 'Enter a summary for the new ticket',
            ignoreFocusOut: true,
          }) ?? null;
        }
        if (!summary) { stream.markdown('No summary provided — cancelled.'); return; }

        const issueType = await resolveIssueType(intent.issueType, projectKey, ticketService, stream);
        if (!issueType) { stream.markdown('No issue type selected — cancelled.'); return; }

        const result = await ticketService.createTicket(projectKey, summary, issueType);
        stream.markdown(result);
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
        stream.markdown('Which ticket are you referring to? (e.g. `@jira show me PROJ-123`)');
        return;
      }
    }

    try {
      let result: string;
      switch (intent.operation) {
        case 'getTicket':
          result = await ticketService.getTicket(ticketKey!);
          break;
        case 'addComment':
          if (!intent.comment) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          result = await ticketService.addComment(ticketKey!, intent.comment);
          break;
        case 'updateField':
          if (!intent.fieldName || !intent.fieldValue) {
            stream.markdown('Please specify both the field name and the new value.');
            return;
          }
          result = await ticketService.updateField(ticketKey!, intent.fieldName, intent.fieldValue);
          break;
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
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('jira-copilot.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
