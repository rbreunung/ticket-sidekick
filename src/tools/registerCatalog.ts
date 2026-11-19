import * as vscode from 'vscode';
import { logDiag } from '../utils/diagLog';
import { confirmationWithPreview, needsConfirmation } from './jiraToolConfirmation';
import { callTool, type ToolCallResult, type ToolDefinition } from './toolDefinition';

// Registers the tools of one catalog with VS Code as language model tools ("extension tools"). A
// tool that is not read-only shows a confirmation with every value it will write, plus what its
// preview works out; the result is the tool's text, and every call is logged under `scope`.

export function registerCatalog<Deps>(
  context: vscode.ExtensionContext,
  tools: readonly ToolDefinition<Deps>[],
  deps: Deps,
  scope: string,
  onResult?: (tool: ToolDefinition<Deps>, result: ToolCallResult) => void,
): void {
  for (const tool of tools) {
    context.subscriptions.push(vscode.lm.registerTool(tool.name, {
      prepareInvocation: async options => {
        if (!needsConfirmation(tool as ToolDefinition<unknown>)) return { invocationMessage: tool.title };
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
          logDiag(scope, result.failed ? 'warn' : 'info', `${tool.name}: ${result.failed ? `failed (${result.error})` : 'ok'}`);
          onResult?.(tool, result);
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
        } catch (err) {
          logDiag(scope, 'error', `${tool.name}: failed`, { error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      },
    }));
  }
}
