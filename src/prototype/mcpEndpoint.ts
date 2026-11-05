import type * as http from 'http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { TicketService } from '../services/TicketService';
import { buildTicketViewHtml } from './ticketView';

// The prototype's MCP endpoint: one read tool (with an inline ticket view as an MCP App) and one
// write tool. Each HTTP request gets a fresh, stateless MCP server, since every request carries the
// bearer key anyway and nothing has to survive between requests. Jira access arrives injected, so
// this module stays free of `vscode` and is tested against the mock client.

export const SHOW_TICKET_TOOL = 'ticket_sidekick_show_ticket';
export const ADD_COMMENT_TOOL = 'ticket_sidekick_add_comment';
export const TICKET_VIEW_URI = 'ui://ticket-sidekick/ticket-view.html';
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export type JiraAccess =
  | { configured: true; ticketService: TicketService; baseUrl: string }
  | { configured: false; message: string };

export interface McpEndpointDeps {
  getJira(): Promise<JiraAccess>;
  /** Shows the preview to the user and resolves true only on explicit approval. */
  confirmWrite(preview: string): Promise<boolean>;
  onError?(message: string): void;
}

const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function buildCommentPreview(ticketKey: string, comment: string): string {
  return `Add this comment to ${ticketKey}:\n\n${comment}`;
}

export function buildMcpServer(deps: McpEndpointDeps): McpServer {
  const server = new McpServer({ name: 'ticket-sidekick-prototype', version: '0.0.1' });

  server.registerResource(
    'ticket-view',
    TICKET_VIEW_URI,
    { title: 'Ticket view', mimeType: MCP_APP_MIME_TYPE },
    async () => ({ contents: [{ uri: TICKET_VIEW_URI, mimeType: MCP_APP_MIME_TYPE, text: buildTicketViewHtml() }] }),
  );

  server.registerTool(
    SHOW_TICKET_TOOL,
    {
      title: 'Show a Jira ticket',
      description: 'Loads one Jira ticket by key (for example PROJ-123) and shows its fields. Read-only.',
      inputSchema: { ticketKey: z.string().describe('Jira issue key, for example PROJ-123') },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TICKET_VIEW_URI } },
    },
    async ({ ticketKey }) => {
      const key = ticketKey.trim();
      if (!TICKET_KEY.test(key)) return text(`"${key}" is not a valid ticket key.`);
      const jira = await deps.getJira();
      if (!jira.configured) return text(jira.message);
      try {
        const [markdown, issue] = await Promise.all([
          jira.ticketService.getTicket(key, undefined, undefined, undefined, jira.baseUrl),
          jira.ticketService.getIssue(key),
        ]);
        const status = (issue.fields as { status?: { name?: string } }).status?.name ?? '';
        return {
          ...text(markdown),
          structuredContent: { key: issue.key, summary: issue.fields.summary, status, url: `${jira.baseUrl}/browse/${issue.key}` },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.(`show ticket failed: ${message}`);
        return text(`Could not load ${key}: ${message}`);
      }
    },
  );

  server.registerTool(
    ADD_COMMENT_TOOL,
    {
      title: 'Add a comment to a Jira ticket',
      description: 'Adds a comment to one Jira ticket. Ticket Sidekick asks the user to approve the exact text first.',
      inputSchema: {
        ticketKey: z.string().describe('Jira issue key, for example PROJ-123'),
        comment: z.string().describe('Comment text in Jira wiki markup'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async ({ ticketKey, comment }) => {
      const key = ticketKey.trim();
      const body = comment.trim();
      if (!TICKET_KEY.test(key)) return text(`"${key}" is not a valid ticket key.`);
      if (!body) return text('Comment text is required.');
      const jira = await deps.getJira();
      if (!jira.configured) return text(jira.message);
      const approved = await deps.confirmWrite(buildCommentPreview(key, body));
      if (!approved) return text(`Not approved: no comment was added to ${key}.`);
      try {
        return text(await jira.ticketService.addComment(key, body, jira.baseUrl));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.onError?.(`add comment failed: ${message}`);
        return text(`Could not add the comment to ${key}: ${message}`);
      }
    },
  );

  return server;
}

/** An HTTP handler for the `/mcp` route: one stateless MCP server and transport per request. */
export function createMcpHandler(deps: McpEndpointDeps): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
