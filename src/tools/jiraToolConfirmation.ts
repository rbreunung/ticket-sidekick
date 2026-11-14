import { z } from 'zod';
import type { ConfirmationLine, ToolDefinition } from './toolDefinition';

// What the user is asked before a Jira tool that changes something runs. Free of `vscode`, so the
// wording is tested as plain data; `registerJiraTools.ts` hands it to VS Code.

const MAX_VALUE_CHARS = 1500;
/**
 * A previewed value, such as a whole corrected description, is what the user approves, so it is
 * cut only far beyond any ticket description, never at the input-value limit.
 */
const MAX_PREVIEW_CHARS = 60_000;

/** Whether Copilot has to ask before the tool runs: every tool that is not read-only. */
export function needsConfirmation(tool: ToolDefinition<unknown>): boolean {
  return tool.annotations.readOnlyHint !== true;
}

function shown(value: unknown, max = MAX_VALUE_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The tool's title and every input value, so the exact text that will be written is on screen.
 * The values are returned apart from the wording, so the caller can show them as plain text.
 */
export function confirmationFor(tool: ToolDefinition<unknown>, input: unknown): { title: string; lines: ConfirmationLine[] } {
  const entries = typeof input === 'object' && input !== null ? Object.entries(input as Record<string, unknown>) : [];
  return {
    title: `${tool.title}?`,
    lines: entries.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => ({ name, value: shown(value) })),
  };
}

/**
 * {@link confirmationFor}, followed by what the tool's preview worked out it will write. A preview
 * that fails adds one line with the reason, so the user is still asked; input that does not fit
 * the tool is not previewed, since the call will be refused anyway.
 */
export async function confirmationWithPreview<Deps>(
  tool: ToolDefinition<Deps>,
  input: unknown,
  deps: Deps,
): Promise<{ title: string; lines: ConfirmationLine[] }> {
  const asked = confirmationFor(tool as ToolDefinition<unknown>, input);
  if (!tool.preview) return asked;
  const parsed = z.object(tool.inputSchema).safeParse(input ?? {});
  if (!parsed.success) return asked;
  try {
    const extra = await tool.preview(parsed.data, deps);
    return { ...asked, lines: [...asked.lines, ...extra.map(line => ({ name: line.name, value: shown(line.value, MAX_PREVIEW_CHARS) }))] };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...asked, lines: [...asked.lines, { name: 'Preview', value: `Could not preview what will be written: ${reason}` }] };
  }
}
