import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { callTool } from '../tools/toolDefinition';
import { confirmationWithPreview } from '../tools/jiraToolConfirmation';
import { JIRA_TOOLS } from '../tools/jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from '../tools/jiraTools/jiraAccess';
import type { IJiraClient, JiraIssue, JiraSearchResult, JiraTransition } from '../jira/IJiraClient';
import type { JiraConfig } from '../services/ConfigService';
import { RecentCallGuard } from '../tools/recentCallGuard';
import { buildJiraNotConfiguredMessage } from '../services/setupHints';
import { JiraApiError } from '../utils/apiError';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeTempDir, removeTempDirs } from './helpers/gitRepo';

// The Jira write tools, called the way the extension calls them for Copilot, with the mock Jira
// client behind them. Each call is its own tool call, as from a chat.

afterEach(() => {
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
  /** The lines the user is asked to confirm before the call runs. */
  confirm(name: string, args: Record<string, unknown>): Promise<Array<{ name: string; value: string }>>;
}

/** Calls that share one set of long-lived deps, as the tools registered by the extension do. */
async function startSession(
  client: IJiraClient,
  options: { folders?: string[]; config?: JiraConfig; timeoutMs?: number; logs?: Array<{ message: string; details?: Record<string, unknown> }> } = {},
): Promise<Session> {
  const config = options.config ?? jiraConfig();
  const deps: JiraToolDeps = {
    getJira: async (): Promise<JiraAccess> => (config.baseUrl && config.token
      ? { configured: true, config: { ...config, baseUrl: config.baseUrl, token: config.token }, client }
      : { configured: false, config }),
    workspaceFolders: () => options.folders ?? [],
    jiraTimeoutMs: options.timeoutMs,
    recentWrites: new RecentCallGuard(),
    onDiag: (_level, message, details) => options.logs?.push({ message, details }),
  };
  const toolNamed = (name: string) => {
    const tool = JIRA_TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return tool;
  };
  return {
    async call(name, args) {
      const result = await callTool(toolNamed(name), args, deps);
      return { text: result.text, isError: result.failed };
    },
    async confirm(name, args) {
      return (await confirmationWithPreview(toolNamed(name), args, deps)).lines;
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
  /** How the failing transition fails: an HTTP 502 with an HTML body, a plain error, or no answer at all. */
  failWith: 'plain' | 'http502' | 'hang' = 'plain';
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
    // Every attempt is recorded, failed ones included, so a retry would show.
    await super.executeTransition(issueKey, transitionId, fields);
    if (transitionId === this.failTransitionId) {
      if (this.failWith === 'hang') return new Promise(() => {});
      if (this.failWith === 'http502') {
        const url = `https://jira.example.com/rest/api/2/issue/${issueKey}/transitions`;
        throw new JiraApiError(`Jira API error 502 Bad Gateway at ${url}: <html>\n<body>proxy SENTINEL-BODY</body></html>`, 502, url);
      }
      throw new Error('Transition refused by a workflow validator');
    }
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

/** Never answers a field update, or refuses the first one with a server error. */
class FieldWriteClient extends MockJiraClient {
  failWith: 'hang' | 'http502' | undefined;
  override async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await super.updateIssue(issueKey, fields);
    if (this.failWith === 'hang') return new Promise(() => {});
    if (this.failWith === 'http502') {
      this.failWith = undefined;
      const url = `https://jira.example.com/rest/api/2/issue/${issueKey}`;
      throw new JiraApiError('Jira API error 502 Bad Gateway: <html>proxy page</html>', 502, url);
    }
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

  it('reports a move that stops partway as a failure, with where the ticket was last confirmed, and does not retry it', async () => {
    const client = new WorkflowClient();
    client.status = 'In Progress';
    client.failTransitionId = '31';
    client.failWith = 'http502';
    const logs: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')], logs });
    const { text, isError } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(isError).toBe(true);
    expect(text).toBe(
      'PROJ-123 moved partway: after 1 of 2 steps it was last confirmed in In Review; the step towards Done failed: '
      + 'Jira answered HTTP 502 (Bad Gateway). The move was not retried; view the ticket with jira_view_ticket before trying again.',
    );
    expect(text).not.toContain('SENTINEL-BODY');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['21', '31']);
    const logged = logs.find(l => l.message === 'jira_move_ticket: move stopped partway');
    expect(logged?.details).toMatchObject({ completedHops: 1, totalHops: 2, lastConfirmedStatus: 'In Review', targetStatus: 'Done', status: 502, timedOut: false });
  });

  it('reports a first step Jira refuses with its HTTP status only, as a failure', async () => {
    const client = new WorkflowClient();
    client.status = 'In Review';
    client.failTransitionId = '31';
    client.failWith = 'http502';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')] });
    const { text, isError } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(isError).toBe(true);
    expect(text).toBe('Could not move PROJ-123: Jira answered HTTP 502 (Bad Gateway).');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['31']);
  });

  it('warns that a first step Jira did not answer in time may still have been saved', async () => {
    const client = new WorkflowClient();
    client.status = 'In Review';
    client.failTransitionId = '31';
    client.failWith = 'hang';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')], timeoutMs: 50 });
    const { text, isError } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(isError).toBe(true);
    expect(text).toBe(
      'Could not move PROJ-123: Jira did not answer within 1 second. The change may still have been saved: '
      + 'view the ticket with jira_view_ticket before trying again.',
    );
  });

  it('warns that a later step Jira did not answer in time may still go through, and names no current status', async () => {
    const client = new WorkflowClient();
    client.status = 'In Progress';
    client.failTransitionId = '31';
    client.failWith = 'hang';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')], timeoutMs: 50 });
    const { text, isError } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(isError).toBe(true);
    expect(text).toBe(
      'PROJ-123 moved partway: after 1 of 2 steps it was last confirmed in In Review; the step towards Done got no answer '
      + 'within 1 second and may still go through. The move was not retried; view the ticket with jira_view_ticket before trying again.',
    );
    expect(text).not.toContain('is now in');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['21', '31']);
  });

  it('does not send a move again that Jira did not answer in time, when the same move comes in a second request', async () => {
    const client = new WorkflowClient();
    client.status = 'In Review';
    client.failTransitionId = '31';
    client.failWith = 'hang';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')], timeoutMs: 50 });
    await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    const second = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'done' });
    expect(second.text).toBe(
      'Skipped: PROJ-123 was moved to done within the last minute. View it with jira_view_ticket, or wait a minute to move it again.',
    );
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['31']);
  });

  it('lets a retry through after Jira refused the move', async () => {
    const client = new WorkflowClient();
    client.status = 'In Review';
    client.failTransitionId = '31';
    client.failWith = 'http502';
    const session = await startSession(client, { folders: [makeTempDir('ts-move-')] });
    await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    client.failTransitionId = undefined;
    const { text } = await session.call('jira_move_ticket', { ticketKey: 'PROJ-123', targetStatus: 'Done' });
    expect(text).toBe('PROJ-123 moved from In Review to Done (transition "Approve").');
    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['31', '31']);
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

  it('does not list a template description as applied when a description given replaced it', async () => {
    const client = new MockJiraClient();
    const folder = makeTempDir('ts-write-');
    fs.writeFileSync(path.join(folder, '.jira-templates.json'), JSON.stringify({
      templates: [{ name: 'Story', issueType: 'Story', defaultFields: { description: 'Template default text', labels: ['web'] } }],
    }));
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_create_ticket', {
      projectKey: 'PROJ', summary: 'Add SSO', templateName: 'Story', description: 'Explicit replacement',
    });
    expect(client.createIssueCalls[0].additionalFields).toEqual({ description: 'Explicit replacement', labels: ['web'] });
    expect(text).toContain('Template fields applied from "Story":\n- labels: ["web"]');
    expect(text).toContain("The description given replaced the template's description.");
    expect(text).not.toContain('Template default text');
  });

  it('creates nothing when the template names no issue type and the issue types cannot be read, and says what to give', async () => {
    const client = new MockJiraClient();
    client.getProject = async () => { throw new JiraApiError('Jira API error 503', 503, 'https://jira.example.com/rest/api/2/project/PROJ'); };
    const folder = makeTempDir('ts-write-');
    fs.writeFileSync(path.join(folder, '.jira-templates.json'), JSON.stringify({
      templates: [{ name: 'Untyped', defaultFields: { labels: ['web'] } }],
    }));
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_create_ticket', { projectKey: 'PROJ', summary: 'Add SSO', templateName: 'Untyped' });
    expect(client.createIssueCalls).toEqual([]);
    expect(text).toContain('No ticket was created');
    expect(text).toContain('again with an explicit "issueType"');
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
  it('says so when no field has the name, points at the field list, and writes nothing', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const { text } = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'Story Points', value: '5' });
    expect(text).toBe('No field named "Story Points" was found. Call jira_list_fields with the ticket key to see its fields. Nothing was changed.');
    expect(client.updateIssueCalls).toEqual([]);
  });

  it('sets a custom field by its display name or its id, shaped as the field needs it', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const byName = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'Category', value: 'Option A' });
    expect(byName.text).toContain('Set Category to Option A on PROJ-123.');
    await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'customfield_10501', value: 'Option B' });
    expect(client.updateIssueCalls).toEqual([
      { issueKey: 'PROJ-123', fields: { customfield_10501: [{ value: 'Option A' }] } },
      { issueKey: 'PROJ-123', fields: { customfield_10501: [{ value: 'Option B' }] } },
    ]);
  });

  it('adds labels to the ones a ticket has, and removes single ones, without touching the rest', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const before = ((await client.getIssue('PROJ-123')).fields.labels ?? []) as string[];
    const added = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'labels', value: 'cleanup, Urgent', operation: 'add' });
    expect(added.text).toContain('Added cleanup, Urgent to Labels on PROJ-123.');
    expect(client.updateIssueCalls[0].fields.labels).toEqual([...before, ...['cleanup', 'Urgent'].filter(v => !before.some(b => b.toLowerCase() === v.toLowerCase()))]);
    if (before.length > 0) {
      await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'labels', value: before[0], operation: 'remove' });
      expect(client.updateIssueCalls[1].fields.labels).toEqual(before.slice(1));
    }
  });

  it('refuses to add a value to a field that is not a list', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    const { text } = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'x', operation: 'add' });
    expect(text).toBe('Summary is not a list field, so a value cannot be added to it. Nothing was changed.');
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

  it('does not send a field update again that Jira did not answer in time, when the same update comes in a second request', async () => {
    const client = new FieldWriteClient();
    client.failWith = 'hang';
    const session = await startSession(client, { timeoutMs: 50 });
    const first = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SSO login' });
    expect(first.text).toContain('The change may still have been saved');
    const second = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SSO login' });
    expect(second.text).toBe('Skipped: summary on PROJ-123 was set to the same value within the last minute. Wait a minute to set it again.');
    expect(client.updateIssueCalls).toHaveLength(1);
  });

  it('lets a retry through after Jira refused the update, and writes a different value right away', async () => {
    const client = new FieldWriteClient();
    client.failWith = 'http502';
    const session = await startSession(client);
    const refused = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SSO login' });
    expect(refused.text).toBe('Could not update summary on PROJ-123: Jira answered HTTP 502 (Bad Gateway).');
    await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SSO login' });
    const other = await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'summary', value: 'Add SAML login' });
    expect(other.text).toContain('Updated summary on');
    expect(client.updateIssueCalls.map(c => c.fields.summary)).toEqual(['Add SSO login', 'Add SSO login', 'Add SAML login']);
  });
});

/** PROJ-123 with a wiki description, the way Jira Data Center and Cloud return it over API v2. */
class DescriptionClient extends FieldWriteClient {
  constructor(public description: unknown) {
    super();
  }
  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await super.getIssue(issueKey);
    return { ...issue, fields: { ...issue.fields, description: this.description } } as JiraIssue;
  }
}

const WIKI = 'h2. Steps\n{color:red}Urgent{color}\n|Open the page|Form is shwon|\n{code}\nString recieved;\n{code}\nAsk [~jdoe].';

describe('correct description', () => {
  it('writes only the approved corrections and keeps the rest of the description as it is', async () => {
    const client = new DescriptionClient(WIKI);
    const session = await startSession(client);
    const { text } = await session.call('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] });
    expect(client.updateIssueCalls).toEqual([{ issueKey: 'PROJ-123', fields: { description: WIKI.replace('shwon', 'shown') } }]);
    expect(text).toBe('Corrected the description of PROJ-123: 1 correction.\n\n1. shwon → shown');
  });

  it('writes nothing when a correction does not fit, and names it with the reason', async () => {
    const client = new DescriptionClient(WIKI);
    const session = await startSession(client);
    const { text } = await session.call('jira_correct_description', {
      ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }, { before: 'recieved', after: 'received' }],
    });
    expect(client.updateIssueCalls).toEqual([]);
    expect(text).toContain('Nothing was changed on PROJ-123');
    expect(text).toContain('2. "recieved": the text is inside code');
    expect(text).not.toContain('1. "shwon"');
  });

  it('writes nothing to a ticket without a description', async () => {
    const client = new DescriptionClient(null);
    const session = await startSession(client);
    const { text } = await session.call('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'a', after: 'b' }] });
    expect(text).toBe('PROJ-123 has no description. Nothing was changed.');
    expect(client.updateIssueCalls).toEqual([]);
  });

  it('skips the same corrections sent again within a minute', async () => {
    const client = new DescriptionClient(WIKI);
    const session = await startSession(client);
    const args = { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] };
    await session.call('jira_correct_description', args);
    const second = await session.call('jira_correct_description', args);
    expect(second.text).toBe('Skipped: the same corrections were written to PROJ-123 within the last minute.');
    expect(client.updateIssueCalls).toHaveLength(1);
  });

  it('warns that a write Jira did not answer in time may still have been saved', async () => {
    const client = new DescriptionClient(WIKI);
    client.failWith = 'hang';
    const session = await startSession(client, { timeoutMs: 50 });
    const { text } = await session.call('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] });
    expect(text).toContain('The change may still have been saved');
  });

  it('refuses a description stored as rich text instead of wiki text, and writes nothing', async () => {
    const client = new DescriptionClient({ type: 'doc', version: 1, content: [] });
    const session = await startSession(client);
    const { text } = await session.call('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'a', after: 'b' }] });
    expect(text).toBe('The description of PROJ-123 is not stored as wiki text, so it cannot be corrected here. Nothing was changed.');
    expect(client.updateIssueCalls).toEqual([]);
  });

  it('shows the whole resulting description, also when it is long', async () => {
    const long = `${'Plain text. '.repeat(400)}The form is shwon.`;
    const session = await startSession(new DescriptionClient(long));
    const asked = await session.confirm('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] });
    expect(asked.at(-1)).toEqual({ name: 'Resulting description', value: long.replace('shwon', 'shown') });
  });

  it('does not ask Jira for a ticket key that is not one, and says the call will be refused', async () => {
    const client = new DescriptionClient(WIKI);
    let reads = 0;
    const original = client.getIssue.bind(client);
    client.getIssue = async key => { reads++; return original(key); };
    const session = await startSession(client);
    const asked = await session.confirm('jira_correct_description', { ticketKey: '../../rest/api/2/myself', corrections: [{ before: 'a', after: 'b' }] });
    expect(asked.at(-1)).toEqual({ name: 'Will be refused', value: '"../../rest/api/2/myself" is not a valid ticket key.' });
    expect(reads).toBe(0);
  });

  it('still asks, with the reason, when Jira does not answer the preview in time', async () => {
    const client = new DescriptionClient(WIKI);
    client.getIssue = () => new Promise(() => {});
    const session = await startSession(client, { timeoutMs: 50 });
    const asked = await session.confirm('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] });
    expect(asked.at(-1)?.name).toBe('Preview');
    expect(asked.at(-1)?.value).toMatch(/^Could not preview what will be written: /);
  });

  it('shows the resulting description before it writes, or that the call will be refused', async () => {
    const session = await startSession(new DescriptionClient(WIKI));
    const ok = await session.confirm('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'shwon', after: 'shown' }] });
    expect(ok.at(-1)).toEqual({ name: 'Resulting description', value: WIKI.replace('shwon', 'shown') });
    const refused = await session.confirm('jira_correct_description', { ticketKey: 'PROJ-123', corrections: [{ before: 'Steps', after: 'x' }, { before: 'nowhere', after: 'x' }] });
    expect(refused.at(-1)).toEqual({ name: 'Will be refused', value: '2. "nowhere": the text is not in the description (any more)' });
  });
});

/** PROJ-123 as a Bug with priority High and labels auth and security. */
class TemplateSourceClient extends MockJiraClient {
  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await super.getIssue(issueKey);
    return { ...issue, fields: { ...issue.fields, issuetype: { name: 'Bug' } } } as JiraIssue;
  }
}

const templatesIn = (folder: string) => JSON.parse(fs.readFileSync(path.join(folder, '.jira-templates.json'), 'utf-8'));

describe('create template', () => {
  it("saves the ticket's issue type and template fields, keeps the other templates, and ends with how to use it", async () => {
    const folder = workspaceWithTemplates();
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(templatesIn(folder).templates).toEqual([
      { name: 'Bug Report', issueType: 'Bug', defaultFields: { priority: { name: 'High' }, labels: ['billing'] } },
      { name: 'Auth bug', issueType: 'Bug', defaultFields: { priority: { name: 'High' }, labels: ['auth', 'security'] } },
    ]);
    expect(text).toContain('Saved the template "Auth bug" (Bug) from PROJ-123 to .jira-templates.json.');
    expect(text.split('\n').at(-1)).toBe('To create a ticket from it: /ts-jira-create <what the ticket is about> using the template "Auth bug"');
  });

  it('saves under the next free number when the name is taken, and replaces nothing', async () => {
    const folder = workspaceWithTemplates();
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    const asked = await session.confirm('jira_create_template', { ticketKey: 'PROJ-123', name: 'Bug Report' });
    expect(asked).toContainEqual({ name: 'Saved as', value: 'Bug Report (2) (the name "Bug Report" is taken)' });
    await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Bug Report' });
    expect(templatesIn(folder).templates.map((t: { name: string }) => t.name)).toEqual(['Bug Report', 'Bug Report (2)']);
    expect(templatesIn(folder).templates[0].defaultFields.labels).toEqual(['billing']);
  });

  it('shows every field and value it will save before it saves', async () => {
    const session = await startSession(new TemplateSourceClient(), { folders: [workspaceWithTemplates()] });
    const asked = await session.confirm('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(asked).toEqual([
      { name: 'ticketKey', value: 'PROJ-123' },
      { name: 'name', value: 'Auth bug' },
      { name: 'Saved as', value: 'Auth bug' },
      { name: 'Issue type', value: 'Bug' },
      { name: 'Fields', value: 'priority: High\nlabels: auth, security' },
    ]);
  });

  it('leaves out a field the display settings hide', async () => {
    const folder = workspaceWithTemplates();
    const session = await startSession(new TemplateSourceClient(), { folders: [folder], config: jiraConfig({ hiddenDisplayFields: ['labels'] }) });
    await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(templatesIn(folder).templates[1].defaultFields).toEqual({ priority: { name: 'High' } });
  });

  it('creates .jira-templates.json when the workspace has none', async () => {
    const folder = makeTempDir('ts-template-');
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(templatesIn(folder)).toEqual({
      templates: [{ name: 'Auth bug', issueType: 'Bug', defaultFields: { priority: { name: 'High' }, labels: ['auth', 'security'] } }],
      cleanupRules: [],
    });
  });

  it('never writes over a .jira-templates.json it cannot read, and says why', async () => {
    const folder = makeTempDir('ts-template-');
    fs.writeFileSync(path.join(folder, '.jira-templates.json'), '{ not json');
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(fs.readFileSync(path.join(folder, '.jira-templates.json'), 'utf-8')).toBe('{ not json');
    expect(text).toMatch(/^Could not parse \.jira-templates\.json: .*Nothing was saved\.$/s);
  });

  it('saves nothing without a name, and says to ask for one', async () => {
    const folder = workspaceWithTemplates();
    const before = fs.readFileSync(path.join(folder, '.jira-templates.json'), 'utf-8');
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: '   ' });
    expect(text).toBe('A template name is required. Ask the user for one. Nothing was saved.');
    expect(fs.readFileSync(path.join(folder, '.jira-templates.json'), 'utf-8')).toBe(before);
  });

  it('saves nothing when no workspace folder is open', async () => {
    const session = await startSession(new TemplateSourceClient(), { folders: [] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(text).toBe('No workspace folder is open — templates are saved to .jira-templates.json in the workspace root. Nothing was saved.');
  });

  it('saves nothing for a ticket whose issue type cannot be read', async () => {
    const folder = workspaceWithTemplates();
    const session = await startSession(new MockJiraClient(), { folders: [folder] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(text).toBe('Could not read the issue type of PROJ-123. Nothing was saved.');
    expect(templatesIn(folder).templates).toHaveLength(1);
  });

  it('never replaces a template saved under the same name while the call was running', async () => {
    const folder = workspaceWithTemplates();
    const client = new TemplateSourceClient();
    const original = client.getFields.bind(client);
    // Someone saves "Auth bug" after the name was found free and before the template is written.
    client.getFields = async () => {
      const file = templatesIn(folder);
      file.templates.push({ name: 'Auth bug', issueType: 'Story', defaultFields: {} });
      fs.writeFileSync(path.join(folder, '.jira-templates.json'), JSON.stringify(file));
      return original();
    };
    const session = await startSession(client, { folders: [folder] });
    const { text } = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(text).toBe('A template named "Auth bug" was saved meanwhile. Call again to save under the next free name. Nothing was saved.');
    expect(templatesIn(folder).templates.find((t: { name: string }) => t.name === 'Auth bug').issueType).toBe('Story');
  });

  it('says before saving that a call without a name or with an invalid key will be refused', async () => {
    const session = await startSession(new TemplateSourceClient(), { folders: [workspaceWithTemplates()] });
    expect((await session.confirm('jira_create_template', { ticketKey: 'PROJ-123', name: '' })).at(-1))
      .toEqual({ name: 'Will be refused', value: 'A template name is required.' });
    expect((await session.confirm('jira_create_template', { ticketKey: '../x', name: 'x' })).at(-1)?.name).toBe('Will be refused');
  });

  it('saves the same template once when the call comes again within a minute', async () => {
    const folder = workspaceWithTemplates();
    const session = await startSession(new TemplateSourceClient(), { folders: [folder] });
    await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    const second = await session.call('jira_create_template', { ticketKey: 'PROJ-123', name: 'Auth bug' });
    expect(second.text).toBe('Skipped: a template "Auth bug" from PROJ-123 was saved within the last minute.');
    expect(templatesIn(folder).templates).toHaveLength(2);
  });
});

describe('Jira wiki triggers in Markdown text', () => {
  const hostile = '## Steps\n\n- open !https://evil.example/x.png! and {html}<b>x</b>{html}\n- {color:red}hi{color}\n\n**bold**';
  const expectNeutralized = (wiki: unknown) => {
    expect(wiki).toContain('h2. Steps');
    expect(wiki).toContain('*bold*');
    expect(wiki).not.toMatch(/![^\s!]+!/);
    expect(wiki).not.toMatch(/\{(html|color)/);
  };

  it('are neutralized in a created ticket, a comment and an updated description, keeping the Markdown formatting', async () => {
    const client = new MockJiraClient();
    const session = await startSession(client);
    await session.call('jira_create_ticket', { projectKey: 'PROJ', summary: 'Login fails', issueType: 'Bug', description: hostile });
    await session.call('jira_add_comment', { ticketKey: 'PROJ-123', comment: hostile });
    await session.call('jira_update_field', { ticketKey: 'PROJ-123', fieldName: 'description', value: hostile });

    expectNeutralized(client.createIssueCalls[0].additionalFields?.description);
    expectNeutralized(client.addCommentCalls[0].body);
    expectNeutralized(client.updateIssueCalls[0].fields.description);
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

  it('refuses a file in a workspace that is itself a dotfolder, lies under one, or is reached through a link into one', async () => {
    const client = new MockJiraClient();
    const base = makeTempDir('ts-upload-');
    const dotRoot = path.join(base, '.aws');
    const underDot = path.join(base, '.config', 'project');
    fs.mkdirSync(underDot, { recursive: true });
    fs.mkdirSync(dotRoot);
    fs.writeFileSync(path.join(dotRoot, 'credentials'), 'synthetic');
    fs.writeFileSync(path.join(underDot, 'notes.txt'), 'synthetic');
    const linkedRoot = path.join(base, 'project-link');
    fs.symlinkSync(underDot, linkedRoot, 'junction');
    const session = await startSession(client, { folders: [dotRoot, underDot, linkedRoot] });

    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: path.join(dotRoot, 'credentials') })).text)
      .toContain('dotfile or dotfolder');
    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: path.join(underDot, 'notes.txt') })).text)
      .toContain('dotfile or dotfolder');
    expect((await session.call('jira_upload_attachment', { ticketKey: 'PROJ-123', filePath: path.join(linkedRoot, 'notes.txt') })).text)
      .toContain('dotfile or dotfolder');
    expect(client.uploadAttachmentCalls).toEqual([]);
  });
});

describe('the field tools', () => {
  it('lists every field of a ticket with its id and current value', async () => {
    const session = await startSession(new MockJiraClient());
    const { text } = await session.call('jira_list_fields', { ticketKey: 'PROJ-123' });
    expect(text).toContain('`customfield_10501`');
    expect(text).toContain('| Summary | `summary` |');
  });

  it('lists the fields an issue type can take on create, required ones first', async () => {
    const session = await startSession(new MockJiraClient());
    const { text } = await session.call('jira_list_fields', { projectKey: 'proj', issueType: 'Bug' });
    expect(text).toContain('Fields of Bug in PROJ (4):');
    const rows = text.split('\n').filter(line => line.startsWith('| ') && line.includes('`'));
    expect(rows).toEqual([
      '| Summary | `summary` | yes |',
      '| Team | `customfield_10500` | yes |',
      '| Description | `description` | no |',
      '| Labels | `labels` | no |',
    ]);
  });

  it('names the issue types of the project when the type has no fields', async () => {
    const session = await startSession(new MockJiraClient());
    const { text } = await session.call('jira_list_fields', { projectKey: 'PROJ', issueType: 'Unknown' });
    expect(text).toContain('No fields found for issue type "Unknown" in PROJ. Issue types you can create there:');
  });

  it('asks for a ticket, or a project with an issue type', async () => {
    const session = await startSession(new MockJiraClient());
    expect((await session.call('jira_list_fields', { projectKey: 'PROJ' })).text).toBe('Give a ticketKey, or a projectKey together with an issueType.');
  });

  it('names the required fields a ticket leaves empty, and says when none are configured', async () => {
    const withRequired = await startSession(new MockJiraClient(), { config: { ...jiraConfig(), requiredFields: ['summary', 'customfield_99999'] } });
    expect((await withRequired.call('jira_check_required_fields', { ticketKey: 'PROJ-123' })).text).toBe('PROJ-123 is missing required fields: customfield_99999.');
    const none = await startSession(new MockJiraClient(), { config: { ...jiraConfig(), requiredFields: [] } });
    expect((await none.call('jira_check_required_fields', { ticketKey: 'PROJ-123' })).text).toContain('No required fields configured.');
  });
});
