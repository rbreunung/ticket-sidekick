import type * as http from 'http';
import type { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Builds the MCP server from a catalog of tool definitions. Each HTTP request gets a fresh,
// stateless MCP server, since every request carries the bearer key anyway and nothing has to
// survive between requests. Handlers receive their long-lived dependencies (Jira access and the
// like) from outside, so this module stays free of `vscode` and is tested over a real socket.

/**
 * How the harness treats a tool before it runs: read-only tools may run without asking, while
 * destructive ones are approved by the user first. A tool that is neither (for example one that
 * only writes local files) carries no hint.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** A tool's answer: Markdown text for the agent, plus optional data for an inline view (MCP App). */
export interface ToolAnswer {
  text: string;
  structuredContent?: Record<string, unknown>;
}

/** Who may call a tool: the model, an inline view the server's tools render, or both. */
export type ToolVisibility = 'model' | 'app';

export interface McpToolDefinition<Deps, Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: McpToolAnnotations;
  /** The inline view (an MCP App resource URI) shown with the tool's results. */
  viewUri?: string;
  /**
   * Who may call the tool; the model only, unless the tool says otherwise. A view may call any
   * tool visible to apps without an approval prompt, so a tool must opt in to being called by one.
   */
  visibility?: readonly ToolVisibility[];
  /** Answers with Markdown text; a failure the user should see is answered as text too, not thrown. */
  handler(args: z.objectOutputType<Shape, z.ZodTypeAny>, deps: Deps): Promise<string | ToolAnswer>;
}

/** An inline view the server serves as an MCP App resource. */
export interface McpViewResource {
  name: string;
  uri: string;
  title: string;
  /** The view's HTML page. */
  html(): string;
}

/** The MIME type VS Code reads as an MCP App view. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Types a tool against its own input schema and returns it in the shape a catalog holds. */
export function defineTool<Deps, Shape extends z.ZodRawShape>(tool: McpToolDefinition<Deps, Shape>): McpToolDefinition<Deps> {
  return tool as unknown as McpToolDefinition<Deps>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * How one tool call ended, without its arguments or result: a handler that answered with text is
 * `ok`; one that threw is `failed`, labelled with the HTTP status the error carries (a Jira or
 * Bitbucket API error) or else its error class.
 */
export type ToolCallOutcome = { tool: string; ok: true } | { tool: string; ok: false; error: string };

export interface McpHandlerHooks {
  onToolCall?(outcome: ToolCallOutcome): void;
}

/**
 * Thrown by a handler whose call failed but which still has an answer for the agent: the server
 * sends `answer` as the tool result, marked as an error, and records the call as failed under
 * `label` (for example `HTTP 502` or `timeout`).
 */
export class ToolFailure extends Error {
  constructor(readonly answer: string, readonly label: string) {
    super(answer);
    this.name = 'ToolFailure';
  }
}

export function toolErrorLabel(err: unknown): string {
  if (err instanceof ToolFailure) return err.label;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

/** What the server offers: its tools and the inline views they point at. */
export interface McpCatalog<Deps> {
  tools: readonly McpToolDefinition<Deps>[];
  views?: readonly McpViewResource[];
}

function toolMeta(tool: McpToolDefinition<unknown>): Record<string, unknown> {
  const ui: Record<string, unknown> = { visibility: [...(tool.visibility ?? ['model'])] };
  if (tool.viewUri) ui.resourceUri = tool.viewUri;
  return { ui };
}

export function buildMcpServer<Deps>(
  catalog: McpCatalog<Deps>,
  deps: Deps,
  info: McpServerInfo,
  hooks: McpHandlerHooks = {},
): McpServer {
  const server = new McpServer(info);
  for (const view of catalog.views ?? []) {
    server.registerResource(view.name, view.uri, { title: view.title, mimeType: MCP_APP_MIME_TYPE }, async () => ({
      contents: [{ uri: view.uri, mimeType: MCP_APP_MIME_TYPE, text: view.html() }],
    }));
  }
  for (const tool of catalog.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: toolMeta(tool as McpToolDefinition<unknown>),
      },
      async (args: z.objectOutputType<z.ZodRawShape, z.ZodTypeAny>) => {
        let answer: string | ToolAnswer;
        try {
          answer = await tool.handler(args, deps);
        } catch (err) {
          hooks.onToolCall?.({ tool: tool.name, ok: false, error: toolErrorLabel(err) });
          if (err instanceof ToolFailure) return { content: [{ type: 'text' as const, text: err.answer }], isError: true };
          throw err;
        }
        hooks.onToolCall?.({ tool: tool.name, ok: true });
        if (typeof answer === 'string') return { content: [{ type: 'text' as const, text: answer }] };
        return {
          content: [{ type: 'text' as const, text: answer.text }],
          ...(answer.structuredContent ? { structuredContent: answer.structuredContent } : {}),
        };
      },
    );
  }
  return server;
}

/** An HTTP handler for the `/mcp` route: one stateless MCP server and transport per request. */
export function createMcpHandler<Deps>(
  catalog: McpCatalog<Deps>,
  deps: Deps,
  info: McpServerInfo,
  hooks: McpHandlerHooks = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const server = buildMcpServer(catalog, deps, info, hooks);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
