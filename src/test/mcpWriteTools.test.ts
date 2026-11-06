import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalhostServer } from '../mcp/localhostServer';
import { createMcpHandler } from '../mcp/mcpServer';
import { generateKey } from '../mcp/keys';
import { JIRA_APP_TOOLS, JIRA_TOOLS, JIRA_VIEWS } from '../mcp/jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from '../mcp/jiraTools/jiraAccess';
import type { IJiraClient, JiraIssue, JiraSearchResult, JiraTransition } from '../jira/IJiraClient';
import type { JiraConfig } from '../services/ConfigService';
import { RecentCallGuard } from '../tools/recentCallGuard';
import { buildJiraNotConfiguredMessage } from '../services/setupHints';
import { JiraApiError } from '../utils/apiError';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeTempDir, removeTempDirs } from './helpers/gitRepo';

// The Jira write tools, called through the official MCP client over a real loopback socket with
// the mock Jira client behind them. Each call is its own MCP request, as from a chat.

let server: LocalhostServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  removeTempDirs();
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

interface Session {
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** A running server whose calls share one set of long-lived deps, as the extension's server does. */
async function startSession(client: IJiraClient, options: { folders?: string[]; config?: JiraConfig; timeoutMs?: number } = {}): Promise<Session> {
  const config = options.config ?? jiraConfig();
  const deps: JiraToolDeps = {
    getJira: async (): Promise<JiraAccess> => (config.baseUrl && config.token
      ? { configured: true, config: { ...config, baseUrl: config.baseUrl, token: config.token }, client }
      : { configured: false, config }),
    workspaceFolders: () => options.folders ?? [],
    jiraTimeoutMs: options.timeoutMs,
    recentWrites: new RecentCallGuard(),
  };
  server = new LocalhostServer({
    onMcp: createMcpHandler({ tools: [...JIRA_TOOLS, ...JIRA_APP_TOOLS], views: JIRA_VIEWS }, deps, { name: 'ticket-sidekick', version: '0.0.0-test' }),
  });
  const mcpKey = generateKey();
  const port = await server.start(mcpKey);
  return {
    async call(name, args) {
      const mcp = new Client({ name: 'test', version: '0.0.0' });
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } },
      }));
      const result = await mcp.callTool({ name, arguments: args });
      await mcp.close();
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      return { text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: result.isError === true };
    },
  };
}

/**
 * A ticket PROJ-123 (a Bug) in a four-status workflow, To Do → In Progress → In Review → Done,
 * where each status offers only the next one. Discovery finds one sample ticket per status.
 */
class WorkflowClient extends MockJiraClient {
  static readonly NEXT: Record<string, JiraTransition | undefined> = {
    'To Do': { id: '11', name: 'Start', to: { name: 'In Progress' } } as JiraTransition,
    'In Progress': { id: '21', name: 'Send to review', to: { name: 'In Review' } } as JiraTransition,
    'In Review': { id: '31', name: 'Approve', to: { name: 'Done' } } as JiraTransition,
    Done: undefined,
  };
  status = 'To Do';
  failTransitionId: string | undefined;
  searches = 0;

  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await super.getIssue(issueKey);
    return { ...issue, fields: { ...issue.fields, status: { name: this.statusOf(issueKey) }, issuetype: { name: 'Bug' } } } as JiraIssue;
  }
  override async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const next = WorkflowClient.NEXT[this.statusOf(issueKey)];
    return next ? [next] : [];
  }
  override async executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    if (transitionId === this.failTransitionId) throw new Error('Transition refused by a workflow validator');
    await super.executeTransition(issueKey, transitionId, fields);
    const next = Object.values(WorkflowClient.NEXT).find(t => t?.id === transitionId);
    if (next) this.status = next.to.name;
  }
  override async getProjectStatuses(): Promise<string[]> {
    return Object.keys(WorkflowClient.NEXT);
  }
  override async searchJql(jql: string): Promise<JiraSearchResult> {
    this.searches++;
    const status = /status = "([^"]+)"/.exec(jql)?.[1];
    return { issues: status ? [{ key: `SAMPLE-${status.replace(/ /g, '_')}`, fields: {} }] : [], total: status ? 1 : 0 } as unknown as JiraSearchResult;
  }
  private statusOf(issueKey: string): string {
    return issueKey.startsWith('SAMPLE-') ? issueKey.slice('SAMPLE-'.length).replace(/_/g, ' ') : this.status;
  }
}

/** Never answers the comment write. */
class HangingCommentClient extends MockJiraClient {
  override addComment(): Promise<void> {
    return new Promise(() => {});
  }
}

/** Refuses the comment write with a server error. */
class FailingCommentClient extends MockJiraClient {
  failures = 1;
  override async addComment(issueKey: string, body: string): Promise<void> {
    if (this.failures-- > 0) {
      const url = `https://jira.example.com/rest/api/2/issue/${issueKey}/comment`;
      throw new JiraApiError('Jira API error 502 Bad Gateway: <html>proxy page</html>', 502, url);
    }
    return super.addComment(issueKey, body);
  }
}

function workspaceWithTemplates(): string {
  const folder = makeTempDir('ts-write-');
  fs.writeFileSync(path.join(folder, '.jira-templates.json'), JSON.stringify({
    templates: [{ name: 'Bug Report', issueType: 'Bug', defaultFields: { priority: { name: 'High' }, labels: ['billing'] } }],
  }));
  return folder;
}

describe('move ticket', () => {
  it('discovers the workflow when nothing is cached and moves through every step, naming each one', async () => {
    const client = new WorkflowClient();
    client.status = 'In Progress';
    const folder = makeTempDir('ts-move-');
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(text).toContain('PROJ-123 moved from In Progress to Done in 2 steps: Send to review → Approve.');
    expect(text).toContain('The workflow was discovered from Jira');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['21', '31']);
    expect(fs.existsSync(path.join(folder, '.jira-workflow-cache.json'))).toBe(true);
  });

  it('moves directly without discovery when one transition reaches the status', async () => {
    const client = new WorkflowClient();
    client.status = 'In Review';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')] });
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'done' });
    expect(text).toBe('PROJ-123 moved from In Review to Done (transition "Approve").');
    expect(client.searches).toBe(0);
  });

  it('discovers once when the cached workflow has no path to the target', async () => {
    const client = new WorkflowClient();
    client.status = 'To Do';
    const folder = makeTempDir('ts-move-');
    // A cache that only knows the first step, so it has no path to Done.
    fs.writeFileSync(path.join(folder, '.jira-workflow-cache.json'), JSON.stringify({
      PROJ: { Bug: { discovered: '2026-01-01', graph: { 'To Do': [{ id: '11', name: 'Start', to: 'In Progress' }] } } },
    }));
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(text).toContain('PROJ-123 moved from To Do to Done in 3 steps: Start → Send to review → Approve.');
    expect(client.searches).toBe(4);
  });

  it('reports a move that stops partway with the status it landed in, and does not retry it', async () => {
    const client = new WorkflowClient();
    client.status = 'In Progress';
    client.failTransitionId = '31';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')] });
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(text).toContain('PROJ-123 moved partway: it is now in In Review, after 1 of 2 steps');
    expect(text).toContain('The move was not retried');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['21']);
  });

  it('says so when the target cannot be reached even after discovery', async () => {
    const client = new WorkflowClient();
    client.status = 'Done';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')] });
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'To Do' });
    expect(text).toBe('PROJ-123 cannot be moved from Done to the target status: no path was found even in the workflow discovered from Jira just now.');
    expect(client.executeTransitionCalls).toEqual([]);
  });
});

describe('create ticket', () => {
  it('without a template or issue type lists the issue types and creates nothing', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const { text } = await session.call('jira_create_ticket', { projectKey: 'PROJ', summary: 'Login fails' });
    expect(text).toContain('No ticket was created');
    expect(text).toContain('Bug');
    expect(text).toContain('jira_create_ticket');
    expect(text).not.toContain('Subtask');
    expect(client.createIssueCalls).toEqual([]);
  });

  it('with a template applies its issue type and fields, converts the description and lists the fields it set', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client, { folders: [workspaceWithTemplates()] });
    const { text } = await session.call('jira_create_ticket', {
      projectKey: 'PROJ', summary: 'Login fails', templateName: 'Bug Report', description: '## Steps\n\n- open the login page',
    });
    expect(client.createIssueCalls).toHaveLength(1);
    const created = client.createIssueCalls[0];
    expect(created.issueType).toBe('Bug');
    expect(created.additionalFields).toEqual({ priority: { name: 'High' }, labels: ['billing'], description: 'h2. Steps\n\n* open the login page' });
    expect(text).toContain('Created');
    expect(text).toContain('Template fields applied from "Bug Report":\n- priority: {"name":"High"}\n- labels: ["billing"]');
  });

  it('skips the same ticket requested again in a separate request within a minute', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    await session.call('jira_create_ticket', { projectKey: 'PROJ', summary: 'Login fails', issueType: 'Bug' });
    const { text } = await session.call('jira_create_ticket', { projectKey: 'PROJ', summary: 'Login fails', issueType: 'Bug' });
    expect(text).toContain('Skipped: the same ticket was created in PROJ within the last minute');
    expect(client.createIssueCalls).toHaveLength(1);
  });
});

describe('add comment', () => {
  it('sends a Markdown heading, list and table to Jira as wiki markup', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const comment = '## Findings\n\n- first point\n- second point\n\n| Step | Result |\n| --- | --- |\n| login | fails |';
    await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment });
    const body = client.addCommentCalls[0].body;
    expect(body).toContain('h2. Findings');
    expect(body).toContain('* first point');
    expect(body).toContain('||Step||Result||');
    expect(body).toContain('|login|fails|');
  });

  it('skips an identical comment sent in a second, separate request within a minute', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    const { text } = await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    expect(text).toContain('Skipped: the same comment was added to PROJ-123 within the last minute');
    expect(client.addCommentCalls).toHaveLength(1);
  });

  it('lets a retry through after a comment Jira refused, and answers with the status only', async () => {
    const client = new FailingCommentClient();
    const session = await startSession(client);
    const first = await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    expect(first.isError).toBe(true);
    expect(first.text).toBe('Could not add a comment to PROJ-123: Jira answered HTTP 502 (Bad Gateway).');
    await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    expect(client.addCommentCalls).toHaveLength(1);
  });

  it('warns that a comment Jira did not answer in time may still have been saved, and does not post it again', async () => {
    const client = new HangingCommentClient();
    const session = await startSession(client, { timeoutMs: 50 });
    const first = await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    expect(first.isError).toBe(true);
    expect(first.text).toBe(
      'Could not add a comment to PROJ-123: Jira did not answer within 1 second. The change may still have been saved: '
      + 'view the ticket with jira_view_ticket before trying again.',
    );
    const second = await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Fixed in build 42.' });
    expect(second.text).toContain('Skipped');
  });

  it('answers with the setup hint when Jira is not configured', async () => {
    const session = await startSession(new MockJiraClient(), { config: jiraConfig({ token: undefined }) });
    const { text } = await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: 'Hello' });
    expect(text).toBe(buildJiraNotConfiguredMessage(jiraConfig({ token: undefined })));
  });
});

describe('update field', () => {
  it('refuses an unsupported field with the supported list and writes nothing', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const { text } = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'Story Points', value: '5' });
    expect(text).toContain('Field "Story Points" is not supported. Supported fields:');
    expect(client.updateIssueCalls).toEqual([]);
  });

  it('reports the value the field had before a successful update', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const { text } = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SSO login' });
    expect(client.updateIssueCalls).toEqual([{ issueKey: 'PROJ-123', fields: { summary: 'Add SSO login' } }]);
    expect(text).toContain('Updated summary on');
    expect(text).toContain('Previous value:\n\nImplement user authentication');
  });

  it('converts a Markdown description to wiki markup', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'description', value: '## Goal\n\n- one' });
    expect(client.updateIssueCalls[0].fields).toEqual({ description: 'h2. Goal\n\n* one' });
  });
});

describe('upload attachment', () => {
  it('accepts a file inside a workspace folder wherever that folder is', async () => {
    const client = new MockJiraClient();
    const folder = makeTempDir('ts-upload-');
    fs.writeFileSync(path.join(folder, 'report.txt'), 'results');
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: 'report.txt' });
    expect(text).toBe('Uploaded "report.txt" to PROJ-123.');
    expect(client.uploadAttachmentCalls).toEqual([{ issueKey: 'PROJ-123', filename: 'report.txt', contentType: 'text/plain' }]);
  });

  it('refuses a file outside every workspace folder, under a dotfolder, behind a symlink pointing out, or over 25 MB', async () => {
    const client = new MockJiraClient();
    const folder = makeTempDir('ts-upload-');
    const outside = makeTempDir('ts-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.mkdirSync(path.join(folder, '.config'));
    fs.writeFileSync(path.join(folder, '.config', 'token.txt'), 'token');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(folder, 'link.txt'));
    fs.writeFileSync(path.join(folder, 'big.bin'), Buffer.alloc(25 * 1024 * 1024 + 1));
    const session = await startSession(client, { folders: [folder] });

    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: path.join(outside, 'secret.txt') })).text)
      .toContain('is outside the open workspace folders');
    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: '.config/token.txt' })).text)
      .toContain('dotfile or dotfolder');
    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: 'link.txt' })).text)
      .toContain('is outside the open workspace folders');
    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: 'big.bin' })).text)
      .toContain('over the 25 MB limit');
    expect(client.uploadAttachmentCalls).toEqual([]);
  });
});
