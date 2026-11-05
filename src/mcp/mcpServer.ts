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

export interface McpToolDefinition<Deps, Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: McpToolAnnotations;
  /** Answers with Markdown text; a failure the user should see is answered as text too, not thrown. */
  handler(args: z.objectOutputType<Shape, z.ZodTypeAny>, deps: Deps): Promise<string>;
}

/** Types a tool against its own input schema and returns it in the shape a catalog holds. */
export function defineTool<Deps, Shape extends z.ZodRawShape>(tool: McpToolDefinition<Deps, Shape>): McpToolDefinition<Deps> {
  return tool as unknown as McpToolDefinition<Deps>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export function buildMcpServer<Deps>(tools: readonly McpToolDefinition<Deps>[], deps: Deps, info: McpServerInfo): McpServer {
  const server = new McpServer(info);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: z.objectOutputType<z.ZodRawShape, z.ZodTypeAny>) => ({
        content: [{ type: 'text' as const, text: await tool.handler(args, deps) }],
      }),
    );
  }
  return server;
}

/** An HTTP handler for the `/mcp` route: one stateless MCP server and transport per request. */
export function createMcpHandler<Deps>(
  tools: readonly McpToolDefinition<Deps>[],
  deps: Deps,
  info: McpServerInfo,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const server = buildMcpServer(tools, deps, info);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
