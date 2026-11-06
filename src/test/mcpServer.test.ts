import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalhostServer } from '../mcp/localhostServer';
import { createMcpHandler, defineTool, type McpToolDefinition } from '../mcp/mcpServer';
import { generateKey } from '../mcp/keys';

interface TestDeps { calls: string[] }

const echoTool = defineTool<TestDeps, { text: z.ZodString }>({
  name: 'test_echo',
  title: 'Echo',
  description: 'Answers with the text it was given.',
  inputSchema: { text: z.string().describe('Text to echo') },
  annotations: { readOnlyHint: true },
  handler: async ({ text }, deps) => {
    deps.calls.push(text);
    return `echo: ${text}`;
  },
});

const viewTool = defineTool<TestDeps, Record<string, never>>({
  name: 'test_with_view',
  title: 'With a view',
  description: 'Answers with text and data for its inline view.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  viewUri: 'ui://test/view.html',
  handler: async () => ({ text: 'see the view', structuredContent: { rows: 2 } }),
});

const appOnlyTool = defineTool<TestDeps, Record<string, never>>({
  name: 'test_app_only',
  title: 'App only',
  description: 'Called only by the inline view.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  visibility: ['app'],
  handler: async () => 'from the view',
});

const view = { name: 'test-view', uri: 'ui://test/view.html', title: 'Test view', html: () => '<!doctype html><p>view</p>' };

const catalog: McpToolDefinition<TestDeps>[] = [echoTool];

let server: LocalhostServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startServer(opts: { allowMcp?: () => boolean; withViews?: boolean } = {}) {
  const deps: TestDeps = { calls: [] };
  let handled = 0;
  const tools = opts.withViews ? [echoTool, viewTool, appOnlyTool] : catalog;
  const handler = createMcpHandler({ tools, views: opts.withViews ? [view] : [] }, deps, { name: 'ticket-sidekick', version: '0.0.0-test' });
  server = new LocalhostServer({
    onMcp: async (req, res) => { handled++; await handler(req, res); },
    allowMcp: opts.allowMcp,
  });
  const mcpKey = generateKey();
  const port = await server.start(mcpKey);
  return { port, url: `http://127.0.0.1:${port}/mcp`, mcpKey, deps, handled: () => handled };
}

async function connect(url: string, key: string | undefined): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

/** A raw POST with full control over the Host header, which fetch does not allow setting. */
function rawPost(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

/** A POST written straight to the socket, so a header can appear twice; resolves the status code. */
function socketPost(port: number, headerLines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'POST /mcp HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Content-Type: application/json', 'Content-Length: 2', 'Connection: close',
        ...headerLines, '', '{}',
      ].join('\r\n'));
    });
    let reply = '';
    socket.on('data', chunk => { reply += chunk.toString('latin1'); });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

describe('localhost MCP server', () => {
  it('listens on 127.0.0.1 with a non-zero port', async () => {
    const { port } = await startServer();
    expect(port).toBeGreaterThan(0);
    expect(server?.address()?.address).toBe('127.0.0.1');
    expect(server?.isRunning()).toBe(true);
  });

  it('lists the catalog tool with its annotations and calls it through the official MCP client', async () => {
    const { url, mcpKey, deps } = await startServer();
    const client = await connect(url, mcpKey);

    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(['test_echo']);
    expect(tools[0]).toMatchObject({ title: 'Echo', description: 'Answers with the text it was given.', annotations: { readOnlyHint: true } });

    const result = await client.callTool({ name: 'test_echo', arguments: { text: 'hello' } });
    expect(textOf(result)).toBe('echo: hello');
    expect(deps.calls).toEqual(['hello']);
    expect(server?.stats().allowed.mcp).toBeGreaterThan(0);
    await client.close();
  });

  it('refuses a client without the key, or with a wrong key, with 401 before any handler runs', async () => {
    const { port, url, mcpKey, deps, handled } = await startServer();
    expect(await rawPost(port, { host: `127.0.0.1:${port}`, 'content-type': 'application/json' })).toBe(401);
    await expect(connect(url, generateKey())).rejects.toThrow();
    expect(handled()).toBe(0);
    expect(deps.calls).toEqual([]);
    expect(server?.stats().refused['mcp-key-invalid']).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(server?.stats())).not.toContain(mcpKey);
  });

  it('refuses the right key sent with a lowercase bearer scheme with 401', async () => {
    const { port, mcpKey, handled } = await startServer();
    expect(await rawPost(port, { host: `127.0.0.1:${port}`, authorization: `bearer ${mcpKey}`, 'content-type': 'application/json' })).toBe(401);
    expect(handled()).toBe(0);
  });

  it('with two Authorization headers only the first counts', async () => {
    const { port, mcpKey, handled } = await startServer();
    expect(await socketPost(port, [`Authorization: Bearer ${generateKey()}`, `Authorization: Bearer ${mcpKey}`])).toBe(401);
    expect(handled()).toBe(0);
    expect(await socketPost(port, [`Authorization: Bearer ${mcpKey}`, `Authorization: Bearer ${generateKey()}`])).not.toBe(401);
    expect(handled()).toBe(1);
  });

  it('refuses Host localhost:<port> with 403 even with the right key', async () => {
    const { port, mcpKey, handled } = await startServer();
    const status = await rawPost(port, { host: `localhost:${port}`, authorization: `Bearer ${mcpKey}`, 'content-type': 'application/json' });
    expect(status).toBe(403);
    expect(handled()).toBe(0);
    expect(server?.stats().refused['host-mismatch']).toBe(1);
  });

  it('refuses a foreign Origin with 403 even with the right key', async () => {
    const { port, mcpKey, handled } = await startServer();
    const status = await rawPost(port, {
      host: `127.0.0.1:${port}`, origin: 'https://evil.example', authorization: `Bearer ${mcpKey}`, 'content-type': 'application/json',
    });
    expect(status).toBe(403);
    expect(handled()).toBe(0);
    expect(server?.stats().recentOrigins).toContain('https://evil.example');
  });

  it('refuses a valid request with 403 while MCP is not allowed, and counts it as mcp-disabled', async () => {
    const { port, mcpKey, handled } = await startServer({ allowMcp: () => false });
    const status = await rawPost(port, { host: `127.0.0.1:${port}`, authorization: `Bearer ${mcpKey}`, 'content-type': 'application/json' });
    expect(status).toBe(403);
    expect(handled()).toBe(0);
    expect(server?.stats().refused['mcp-disabled']).toBe(1);
  });

  it('asks the allow gate on every request, so allowing it again takes effect at once', async () => {
    let allowed = false;
    const { url, mcpKey } = await startServer({ allowMcp: () => allowed });
    await expect(connect(url, mcpKey)).rejects.toThrow();
    allowed = true;
    const client = await connect(url, mcpKey);
    expect((await client.listTools()).tools).toHaveLength(1);
    await client.close();
  });

  it('stops accepting connections after stop', async () => {
    const { url, mcpKey } = await startServer();
    await server?.stop();
    expect(server?.isRunning()).toBe(false);
    server = undefined;
    await expect(connect(url, mcpKey)).rejects.toThrow();
  });

  it('marks a tool model-only unless it opts in to views, and links a tool to its inline view', async () => {
    const { url, mcpKey } = await startServer({ withViews: true });
    const client = await connect(url, mcpKey);
    const tools = (await client.listTools()).tools;
    const meta = (name: string) => tools.find(t => t.name === name)?._meta;
    expect(meta('test_echo')).toEqual({ ui: { visibility: ['model'] } });
    expect(meta('test_with_view')).toEqual({ ui: { visibility: ['model'], resourceUri: 'ui://test/view.html' } });
    expect(meta('test_app_only')).toEqual({ ui: { visibility: ['app'] } });
    await client.close();
  });

  it('answers with structured data for the view next to the text', async () => {
    const { url, mcpKey } = await startServer({ withViews: true });
    const client = await connect(url, mcpKey);
    const result = await client.callTool({ name: 'test_with_view', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'see the view' }]);
    expect(result.structuredContent).toEqual({ rows: 2 });
    await client.close();
  });

  it('serves an inline view as an MCP App resource', async () => {
    const { url, mcpKey } = await startServer({ withViews: true });
    const client = await connect(url, mcpKey);
    const read = await client.readResource({ uri: 'ui://test/view.html' });
    expect(read.contents).toEqual([{ uri: 'ui://test/view.html', mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><p>view</p>' }]);
    await client.close();
  });
});
