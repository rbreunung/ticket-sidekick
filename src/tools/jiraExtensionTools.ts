import { z } from 'zod';
import { ToolFailure, type McpToolDefinition } from '../mcp/mcpServer';

// The Jira tools as VS Code language model tools ("extension tools"), for machines where the
// organisation does not allow the extension's MCP server. They are the same tool definitions the
// MCP server offers, with the same names, inputs and answers; only the way Copilot reaches them
// differs. This module stays free of `vscode`: it validates the input, runs the tool and words the
// confirmation, and `registerJiraExtensionTools.ts` hands that to VS Code.

/** The setting that chooses how Copilot reaches the Jira tools. */
export const TOOLS_FROM_SETTING = 'jira.toolsFrom';
export type ToolsFrom = 'mcp' | 'extension';

/** The setting's value, `mcp` unless it is exactly `extension`. */
export function resolveToolsFrom(value: unknown): ToolsFrom {
  return value === 'extension' ? 'extension' : 'mcp';
}

/** The context key the tools' `when` clause reads. */
export const EXTENSION_TOOLS_CONTEXT = 'ticketSidekick.jiraExtensionTools';

const MAX_VALUE_CHARS = 1500;

/**
 * Runs a tool with the input Copilot gave. Input that does not fit the tool's schema is answered
 * with what is wrong, and a failure the tool words itself is answered with its text, so the model
 * gets the same answers as over MCP.
 */
export async function runExtensionTool<Deps>(tool: McpToolDefinition<Deps>, input: unknown, deps: Deps): Promise<string> {
  const parsed = z.object(tool.inputSchema).safeParse(input ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
    return `The input for ${tool.name} is not valid: ${problems}`;
  }
  try {
    return await tool.handler(parsed.data, deps);
  } catch (err) {
    if (err instanceof ToolFailure) return err.answer;
    throw err;
  }
}

/** Whether Copilot has to ask before the tool runs: every tool that is not read-only. */
export function needsConfirmation(tool: McpToolDefinition<unknown>): boolean {
  return tool.annotations.readOnlyHint !== true;
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * What the user is asked before a tool that changes something runs: the tool's title and every
 * input value, so the exact text that will be written is on screen. The values are returned
 * apart from the wording, so the caller can show them as plain text.
 */
export function confirmationFor(tool: McpToolDefinition<unknown>, input: unknown): { title: string; lines: Array<{ name: string; value: string }> } {
  const entries = typeof input === 'object' && input !== null ? Object.entries(input as Record<string, unknown>) : [];
  return {
    title: `${tool.title}?`,
    lines: entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => ({ name, value: shown(value) })),
  };
}
