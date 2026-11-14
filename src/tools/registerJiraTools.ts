import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import type { ConfigService } from '../services/ConfigService';
import { logDiag } from '../utils/diagLog';
import { registerBoards, type RegisteredBoards } from '../boards/registerBoards';
import { JIRA_TOOLS } from './jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from './jiraTools/jiraAccess';
import { confirmationWithPreview, needsConfirmation } from './jiraToolConfirmation';
import { RecentCallGuard } from './recentCallGuard';
import { callTool } from './toolDefinition';
import { walkthroughStepDoneBy } from './walkthroughProgress';

// Registers the Jira tool catalog with VS Code as language model tools ("extension tools") and the
// boards they open. This is the one way Copilot reaches the Jira tools: there is no MCP server and
// no setting that chooses a route. Jira configuration is no start condition; the tools read it at
// every call and answer with the setup hint while it is missing.

async function getJira(configService: ConfigService): Promise<JiraAccess> {
  const config = await configService.getConfig();
  if (!configService.isConfigured(config)) return { configured: false, config };
  const client = new JiraApiClient({
    baseUrl: config.baseUrl,
    authType: config.authType,
    token: config.token,
    sprintBoardId: config.sprintBoardId,
    onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
  });
  return { configured: true, config, client };
}

export function registerJiraTools(context: vscode.ExtensionContext, configService: ConfigService): RegisteredBoards {
  const boards = registerBoards(context, () => getJira(configService));

  const deps: JiraToolDeps = {
    getJira: () => getJira(configService),
    // Only folders on this computer's disk: git, the template file and the workflow cache are read there.
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
    recentWrites: new RecentCallGuard(),
    openBoard: (kind, input) => boards.panels.open(kind, input),
    onDiag: (level, message, details) => logDiag('tools.jira', level, message, details),
  };

  for (const tool of JIRA_TOOLS) {
    context.subscriptions.push(vscode.lm.registerTool(tool.name, {
      prepareInvocation: async options => {
        if (!needsConfirmation(tool)) return { invocationMessage: tool.title };
        const { title, lines } = await confirmationWithPreview(tool, options.input, deps);
        // Plain text parts, so nothing in a value is read as Markdown or as a link.
        const message = new vscode.MarkdownString();
        for (const line of lines) {
          message.appendMarkdown(`**${line.name}**\n\n`);
          message.appendCodeblock(line.value, 'text');
        }
        return { invocationMessage: tool.title, confirmationMessages: { title, message } };
      },
      invoke: async options => {
        try {
          const result = await callTool(tool, options.input, deps);
          logDiag('tools.jira', result.failed ? 'warn' : 'info', `${tool.name}: ${result.failed ? `failed (${result.error})` : 'ok'}`);
          const step = walkthroughStepDoneBy(tool.name, result.failed);
          if (step) void vscode.commands.executeCommand('setContext', step, true);
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
        } catch (err) {
          logDiag('tools.jira', 'error', `${tool.name}: failed`, { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      },
    }));
  }
  return boards;
}
