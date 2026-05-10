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
  | 'validateFields';

interface ParsedIntent {
  operation: Operation;
  ticketKey: string | null;
  comment: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  jql: string | null;
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"addComment"|"updateField"|"searchJql"|"validateFields","ticketKey":string|null,"comment":string|null,"fieldName":string|null,"fieldValue":string|null,"jql":string|null}
- getTicket: show, summarise, describe, look up a specific ticket
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update a field (priority, assignee, summary, description, labels, fix version)
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided
- validateFields: check, validate required fields on a ticket

Command: `;

async function parseIntent(
  prompt: string,
  token: vscode.CancellationToken,
): Promise<ParsedIntent> {
  const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  const model = models[0];
  if (!model) {
    throw new Error('No language model available. Ensure GitHub Copilot is installed and signed in.');
  }
  const message = vscode.LanguageModelChatMessage.User(INTENT_PROMPT + JSON.stringify(prompt));
  const response = await model.sendRequest([message], {}, token);
  let json = '';
  for await (const chunk of response.text) {
    json += chunk;
  }
  const cleaned = json.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned) as ParsedIntent;
}

function resolveTicketFromBranch(): string | null {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    return extractTicketId(branch);
  } catch {
    return null;
  }
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
      intent = await parseIntent(request.prompt, token);
    } catch (err) {
      stream.markdown(`Could not understand the request: ${err instanceof Error ? err.message : String(err)}`);
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
