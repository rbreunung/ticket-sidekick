import { z } from 'zod';

// What a tool is: a name, a description, an input schema and a handler that answers with text.
// The Jira tool catalog (`jiraTools/`) is built from these definitions and registered with VS Code
// as language model tools ("extension tools"). Handlers receive their long-lived dependencies
// (Jira access and the like) from outside, so this module and the catalog stay free of `vscode`.

/**
 * How Copilot treats a tool before it runs: a read-only tool runs without asking, every other
 * tool is confirmed by the user first. `destructiveHint` marks the ones that change Jira.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ToolDefinition<Deps, Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  /** Answers with Markdown text; a failure the user should see is answered as text too, not thrown. */
  handler(args: z.infer<z.ZodObject<Shape>>, deps: Deps): Promise<string>;
}

/** Types a tool against its own input schema and returns it in the shape a catalog holds. */
export function defineTool<Deps, Shape extends z.ZodRawShape>(tool: ToolDefinition<Deps, Shape>): ToolDefinition<Deps> {
  return tool as unknown as ToolDefinition<Deps>;
}

/**
 * Thrown by a handler whose call failed but which still has an answer for the agent: `answer` is
 * given as the tool's result and the call is recorded as failed under `label` (for example
 * `HTTP 502` or `timeout`).
 */
export class ToolFailure extends Error {
  constructor(readonly answer: string, readonly label: string) {
    super(answer);
    this.name = 'ToolFailure';
  }
}

/** A short label for a failed call: the HTTP status an API error carries, else the error class. */
export function toolErrorLabel(err: unknown): string {
  if (err instanceof ToolFailure) return err.label;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

/** How one tool call ended. `failed` means the tool's own answer says the call did not work. */
export interface ToolCallResult {
  text: string;
  failed: boolean;
  /** Set when the call failed: the label the failure is logged under. */
  error?: string;
}

/**
 * Runs a tool with the input Copilot gave. Input that does not fit the tool's schema is answered
 * with what is wrong, and a failure the tool words itself is answered with its text. Any other
 * error is thrown to the caller.
 */
export async function callTool<Deps>(tool: ToolDefinition<Deps>, input: unknown, deps: Deps): Promise<ToolCallResult> {
  const parsed = z.object(tool.inputSchema).safeParse(input ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
    return { text: `The input for ${tool.name} is not valid: ${problems}`, failed: true, error: 'invalid input' };
  }
  try {
    return { text: await tool.handler(parsed.data, deps), failed: false };
  } catch (err) {
    if (err instanceof ToolFailure) return { text: err.answer, failed: true, error: err.label };
    throw err;
  }
}
