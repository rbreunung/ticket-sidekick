import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalhostServer } from '../prototype/localhostServer';
import { createMcpHandler, SHOW_TICKET_TOOL, ADD_COMMENT_TOOL, TICKET_VIEW_URI, type McpEndpointDeps } from '../prototype/mcpEndpoint';
import { generateKey } from '../prototype/keys';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

let server: LocalhostServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

interface Setup {
  url: string;
  mcpKey: string;
  jira: MockJiraClient;
  confirmCalls: string[];
}

async function startServer(opts: { configured?: boolean; approve?: boolean } = {}): Promise<Setup> {
  const jira = new MockJiraClient();
  const confirmCalls: string[] = [];
  const deps: McpEndpointDeps = {
    getJira: async () => (opts.configured === false
      ? { configured: false, message: 'Jira is not configured.' }
      : { configured: true, ticketService: new TicketService(jira), baseUrl: 'https://jira.example' }),
    confirmWrite: async preview => { confirmCalls.push(preview); return opts.approve ?? false; },
  };
  const mcpKey = generateKey();
  server = new LocalhostServer({
    onMcp: createMcpHandler(deps),
    onCanvas: async (_req, res) => { res.statusCode = 404; res.end(); },
  });
  const port = await server.start({ mcpKey, canvasKey: generateKey() });
  return { url: `http://127.0.0.1:${port}/mcp`, mcpKey, jira, confirmCalls };
}

async function connect(url: string, key: string | undefined): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

describe('prototype localhost server — MCP endpoint', () => {
  it('listens on 127.0.0.1 with a real port', async () => {
    const { url } = await startServer();
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(Number(parsed.port)).toBeGreaterThan(0);
    expect(server?.address()?.address).toBe('127.0.0.1');
  });

  it('lists both tools and loads a ticket for a client with the right key', async () => {
    const { url, mcpKey } = await startServer();
    const client = await connect(url, mcpKey);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    expect(tools).toEqual([ADD_COMMENT_TOOL, SHOW_TICKET_TOOL].sort());

    const result = await client.callTool({ name: SHOW_TICKET_TOOL, arguments: { ticketKey: 'PROJ-123' } });
    expect(textOf(result)).toContain('PROJ-123');
    await client.close();
  });

  it('points the show-ticket tool at an inline ticket view that serves HTML', async () => {
    const { url, mcpKey } = await startServer();
    const client = await connect(url, mcpKey);
    const tool = (await client.listTools()).tools.find(t => t.name === SHOW_TICKET_TOOL);
    expect((tool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri).toBe(TICKET_VIEW_URI);

    const resource = await client.readResource({ uri: TICKET_VIEW_URI });
    const first = resource.contents[0] as { mimeType?: string; text?: string };
    expect(first.mimeType).toBe('text/html;profile=mcp-app');
    expect(first.text).toContain('<html');
    await client.close();
  });

  it('writes nothing and answers "not approved" when the user declines the comment', async () => {
    const { url, mcpKey, jira, confirmCalls } = await startServer({ approve: false });
    const client = await connect(url, mcpKey);
    const result = await client.callTool({ name: ADD_COMMENT_TOOL, arguments: { ticketKey: 'PROJ-123', comment: 'Looks good' } });
    expect(textOf(result)).toMatch(/not approved/i);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]).toContain('Looks good');
    expect(jira.addCommentCalls).toEqual([]);
    await client.close();
  });

  it('adds the comment once when the user approves', async () => {
    const { url, mcpKey, jira } = await startServer({ approve: true });
    const client = await connect(url, mcpKey);
    await client.callTool({ name: ADD_COMMENT_TOOL, arguments: { ticketKey: 'PROJ-123', comment: 'Looks good' } });
    expect(jira.addCommentCalls).toEqual([{ issueKey: 'PROJ-123', body: 'Looks good' }]);
    await client.close();
  });

  it('refuses a client without the key before any Jira call', async () => {
    const { url, jira } = await startServer({ approve: true });
    await expect(connect(url, undefined)).rejects.toThrow();
    await expect(connect(url, generateKey())).rejects.toThrow();
    expect(jira.addCommentCalls).toEqual([]);
    expect(server?.stats().refused['mcp-key-invalid']).toBeGreaterThanOrEqual(2);
  });

  it('refuses an invalid ticket key without asking the user', async () => {
    const { url, mcpKey, confirmCalls } = await startServer({ approve: true });
    const client = await connect(url, mcpKey);
    const result = await client.callTool({ name: ADD_COMMENT_TOOL, arguments: { ticketKey: 'not a key', comment: 'x' } });
    expect(textOf(result)).toMatch(/not a valid ticket key/i);
    expect(confirmCalls).toEqual([]);
    await client.close();
  });

  it('answers with the not-configured message when Jira is unset', async () => {
    const { url, mcpKey } = await startServer({ configured: false });
    const client = await connect(url, mcpKey);
    const result = await client.callTool({ name: SHOW_TICKET_TOOL, arguments: { ticketKey: 'PROJ-123' } });
    expect(textOf(result)).toBe('Jira is not configured.');
    await client.close();
  });

  it('refuses MCP requests with a valid key while MCP is not allowed, before any Jira call', async () => {
    const jira = new MockJiraClient();
    const mcpKey = generateKey();
    let handled = 0;
    server = new LocalhostServer({
      onMcp: async (_req, res) => { handled++; res.end(); },
      onCanvas: async (_req, res) => { res.end(); },
      allowMcp: () => false,
    });
    const port = await server.start({ mcpKey, canvasKey: generateKey() });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${mcpKey}` } });
    expect(res.status).toBe(403);
    expect(handled).toBe(0);
    expect(jira.addCommentCalls).toEqual([]);
    expect(server.stats().refused['mcp-disabled']).toBe(1);
  });

  it('stops accepting connections after stop', async () => {
    const { url, mcpKey } = await startServer();
    await server?.stop();
    server = undefined;
    await expect(connect(url, mcpKey)).rejects.toThrow();
  });
});
