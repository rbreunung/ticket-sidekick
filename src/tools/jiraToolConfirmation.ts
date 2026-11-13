import type { ToolDefinition } from './toolDefinition';

// What the user is asked before a Jira tool that changes something runs. Free of `vscode`, so the
// wording is tested as plain data; `registerJiraTools.ts` hands it to VS Code.

const MAX_VALUE_CHARS = 1500;

/** Whether Copilot has to ask before the tool runs: every tool that is not read-only. */
export function needsConfirmation(tool: ToolDefinition<unknown>): boolean {
  return tool.annotations.readOnlyHint !== true;
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/**
 * The tool's title and every input value, so the exact text that will be written is on screen.
 * The values are returned apart from the wording, so the caller can show them as plain text.
 */
export function confirmationFor(tool: ToolDefinition<unknown>, input: unknown): { title: string; lines: Array<{ name: string; value: string }> } {
  const entries = typeof input === 'object' && input !== null ? Object.entries(input as Record<string, unknown>) : [];
  return {
    title: `${tool.title}?`,
    lines: entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => ({ name, value: shown(value) })),
  };
}
