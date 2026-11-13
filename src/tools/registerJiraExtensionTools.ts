import * as vscode from 'vscode';
import { JIRA_TOOLS } from '../mcp/jiraTools/catalog';
import type { JiraToolDeps } from '../mcp/jiraTools/jiraAccess';
import { logDiag } from '../utils/diagLog';
import { confirmationFor, EXTENSION_TOOLS_CONTEXT, needsConfirmation, resolveToolsFrom, runExtensionTool, TOOLS_FROM_SETTING, type ToolsFrom } from './jiraExtensionTools';

// Registers the Jira tools with VS Code as language model tools. They are always registered, as
// VS Code expects of every tool package.json declares, and shown to Copilot only while the
// `ticketSidekick.jira.toolsFrom` setting is `extension`, so the same tool is never offered twice.

export function toolsFrom(): ToolsFrom {
  return resolveToolsFrom(vscode.workspace.getConfiguration('ticketSidekick').get<unknown>(TOOLS_FROM_SETTING));
}

export function registerJiraExtensionTools(context: vscode.ExtensionContext, deps: JiraToolDeps): void {
  const applyContext = () => {
    void vscode.commands.executeCommand('setContext', EXTENSION_TOOLS_CONTEXT, toolsFrom() === 'extension');
  };
  applyContext();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(`ticketSidekick.${TOOLS_FROM_SETTING}`)) applyContext();
  }));

  for (const tool of JIRA_TOOLS) {
    context.subscriptions.push(vscode.lm.registerTool(tool.name, {
      prepareInvocation: options => {
        if (!needsConfirmation(tool)) return { invocationMessage: tool.title };
        const { title, lines } = confirmationFor(tool, options.input);
        // Plain text parts, so nothing in a value is read as Markdown or as a link.
        const message = new vscode.MarkdownString();
        for (const line of lines) {
          message.appendMarkdown(`**${line.name}**\n\n`);
          message.appendCodeblock(line.value, 'text');
        }
        return { invocationMessage: tool.title, confirmationMessages: { title, message } };
      },
      invoke: async options => {
        let text: string;
        try {
          text = await runExtensionTool(tool, options.input, deps);
          logDiag('tools.jira', 'info', `${tool.name}: ok`);
        } catch (err) {
          logDiag('tools.jira', 'error', `${tool.name}: failed`, { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
      },
    }));
  }
}
