import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalhostServer } from '../mcp/localhostServer';
import { createMcpHandler } from '../mcp/mcpServer';
import { generateKey } from '../mcp/keys';
import { JIRA_TOOLS, CHECK_CONNECTION_TOOL } from '../mcp/jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from '../mcp/jiraTools/jiraAccess';
import type { JiraConfig } from '../services/ConfigService';
import { MockJiraClient } from './mocks/MockJiraClient';

// Each Jira tool is called through the official MCP client over a real loopback socket, with the
// mock Jira client behind it.

let server: LocalhostServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

function jiraConfig(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return {
    baseUrl: 'https://jira.example.com',
    authType: 'datacenter',
    showConnectionInfo: false,
    requiredFields: [],
    additionalDisplayFields: [],
    hiddenDisplayFields: [],
    searchFields: [],
    cleanupFields: [],
    token: 'secret-token',
    ...overrides,
  };
}

function accessFor(config: JiraConfig): JiraAccess {
  return config.baseUrl && config.token
    ? { configured: true, config: { ...config, baseUrl: config.baseUrl, token: config.token }, client: new MockJiraClient() }
    : { configured: false, config };
}

async function callTool(name: string, config: JiraConfig, args: Record<string, unknown> = {}): Promise<string> {
  const deps: JiraToolDeps = { getJira: async () => accessFor(config) };
  server = new LocalhostServer({ onMcp: createMcpHandler(JIRA_TOOLS, deps, { name: 'ticket-sidekick', version: '0.0.0-test' }) });
  const mcpKey = generateKey();
  const port = await server.start(mcpKey);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } },
  }));
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

describe('Jira tool catalog', () => {
  it('holds the check connection tool, marked read-only', () => {
    expect(JIRA_TOOLS.map(t => t.name)).toEqual([CHECK_CONNECTION_TOOL]);
    expect(CHECK_CONNECTION_TOOL).toBe('jira_check_connection');
    expect(JIRA_TOOLS[0].annotations).toEqual({ readOnlyHint: true });
  });
});

describe('jira_check_connection', () => {
  it('reports the base URL, auth type, token presence and the signed-in user', async () => {
    const text = await callTool(CHECK_CONNECTION_TOOL, jiraConfig());

    expect(text).toBe(
      '**Jira connection OK**\n\n' +
      '| Setting | Value |\n' +
      '|---|---|\n' +
      '| Base URL | `https://jira.example.com` |\n' +
      '| API version | v2 |\n' +
      '| Auth type | datacenter |\n' +
      '| Token | present (12 chars) |\n' +
      '| Logged in as | Current User |\n',
    );
    expect(text).not.toContain('secret-token');
  });

  it('answers without a token with the setup hint naming the missing token', async () => {
    const text = await callTool(CHECK_CONNECTION_TOOL, jiraConfig({ token: undefined }));

    expect(text).toBe('Jira credentials not configured. Run "Ticket Sidekick: Set Jira Personal Access Token" from the Command Palette.');
  });

  it('answers with a malformed base URL with the configuration problem', async () => {
    const text = await callTool(CHECK_CONNECTION_TOOL, jiraConfig({ baseUrl: 'jira.example.com' }));

    expect(text).toBe(
      '**Jira configuration problem**\n\n' +
      'Base URL "jira.example.com" is not a valid URL. Use a full URL like https://jira.mycompany.com.',
    );
  });
});
