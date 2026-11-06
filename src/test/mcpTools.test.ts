import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalhostServer } from '../mcp/localhostServer';
import { createMcpHandler, type ToolCallOutcome } from '../mcp/mcpServer';
import { generateKey } from '../mcp/keys';
import {
  JIRA_TOOLS, CHECK_CONNECTION_TOOL, VIEW_TICKET_TOOL, FIND_TICKETS_TOOL, LIST_MY_FILTERS_TOOL, WORKFLOW_TOOL, LIST_TEMPLATES_TOOL,
} from '../mcp/jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from '../mcp/jiraTools/jiraAccess';
import type { IJiraClient, JiraComment, JiraFilter, JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { JiraConfig } from '../services/ConfigService';
import { JiraApiError } from '../utils/apiError';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeRepoOnBranch, makeTempDir, removeTempDirs } from './helpers/gitRepo';
import * as fs from 'fs';
import * as path from 'path';

// Each Jira tool is called through the official MCP client over a real loopback socket, with the
// mock Jira client behind it.

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

function accessFor(config: JiraConfig, client: IJiraClient): JiraAccess {
  return config.baseUrl && config.token
    ? { configured: true, config: { ...config, baseUrl: config.baseUrl, token: config.token }, client }
    : { configured: false, config };
}

interface Logged { level: string; message: string; details?: Record<string, unknown> }

interface CallOptions {
  config?: JiraConfig;
  client?: IJiraClient;
  folders?: string[];
  timeoutMs?: number;
  logs?: Logged[];
  outcomes?: ToolCallOutcome[];
}

async function callTool(name: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<string> {
  const config = options.config ?? jiraConfig();
  const client = options.client ?? new MockJiraClient();
  const deps: JiraToolDeps = {
    getJira: async () => accessFor(config, client),
    workspaceFolders: () => options.folders ?? [],
    jiraTimeoutMs: options.timeoutMs,
    onDiag: (level, message, details) => options.logs?.push({ level, message, details }),
  };
  server = new LocalhostServer({
    onMcp: createMcpHandler(JIRA_TOOLS, deps, { name: 'ticket-sidekick', version: '0.0.0-test' }, {
      onToolCall: outcome => options.outcomes?.push(outcome),
    }),
  });
  const mcpKey = generateKey();
  const port = await server.start(mcpKey);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } },
  }));
  const result = await mcp.callTool({ name, arguments: args });
  await mcp.close();
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function comment(n: number): JiraComment {
  const day = String(1 + (n % 28)).padStart(2, '0');
  const month = String(1 + Math.floor(n / 28)).padStart(2, '0');
  return {
    id: String(n),
    author: { accountId: `u${n}`, displayName: `Author ${n}` },
    body: `Comment number ${n}`,
    created: `2024-${month}-${day}T09:00:00.000+0000`,
  } as JiraComment;
}

/** The fixture ticket with `count` comments, oldest first as Jira lists them. */
class ManyCommentsClient extends MockJiraClient {
  constructor(private readonly count: number) { super(); }
  override async getAllComments(): Promise<JiraComment[]> {
    return Array.from({ length: this.count }, (_, i) => comment(i + 1));
  }
}

interface SearchCall { jql: string; maxResults?: number; startAt?: number; extraFields?: string[]; pageToken?: string }

/** Records every search; `result` replaces the fixture answer when set. */
class RecordingSearchClient extends MockJiraClient {
  searches: SearchCall[] = [];
  constructor(private readonly result?: JiraSearchResult) { super(); }
  override async searchJql(jql: string, maxResults?: number, startAt?: number, extraFields?: string[], pageToken?: string): Promise<JiraSearchResult> {
    this.searches.push({ jql, maxResults, startAt, extraFields, pageToken });
    return this.result ?? super.searchJql(jql, maxResults, startAt, extraFields, pageToken);
  }
}

describe('Jira tool catalog', () => {
  it('marks every tool that only reads Jira as read-only', () => {
    expect(CHECK_CONNECTION_TOOL).toBe('jira_check_connection');
    expect(VIEW_TICKET_TOOL).toBe('jira_view_ticket');
    for (const tool of JIRA_TOOLS) expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true });
  });
});

describe('jira_check_connection', () => {
  it('reports the base URL, auth type, token presence and the signed-in user', async () => {
    const text = await callTool(CHECK_CONNECTION_TOOL);

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
    const text = await callTool(CHECK_CONNECTION_TOOL, {}, { config: jiraConfig({ token: undefined }) });

    expect(text).toBe('Jira credentials not configured. Run "Ticket Sidekick: Set Jira Personal Access Token" from the Command Palette.');
  });

  it('answers with a malformed base URL with the configuration problem', async () => {
    const text = await callTool(CHECK_CONNECTION_TOOL, {}, { config: jiraConfig({ baseUrl: 'jira.example.com' }) });

    expect(text).toBe(
      '**Jira configuration problem**\n\n' +
      'Base URL "jira.example.com" is not a valid URL. Use a full URL like https://jira.mycompany.com.',
    );
  });

  it('tells the agent only the status of a failed check; the full error goes to the log', async () => {
    const client = new MockJiraClient();
    const body = '<html><body>Corporate proxy: upstream unavailable</body></html>';
    client.getCurrentUser = async () => {
      throw new JiraApiError(`Jira API error 502 Bad Gateway at https://jira.example.com/rest/api/2/myself — ${body}`, 502, 'https://jira.example.com/rest/api/2/myself', body);
    };
    const logs: Logged[] = [];

    const text = await callTool(CHECK_CONNECTION_TOOL, {}, { client, logs });

    expect(text).toContain('**Jira connection failed**');
    expect(text).toContain('| Base URL | `https://jira.example.com` |');
    expect(text).toContain('HTTP 502 (Bad Gateway)');
    expect(text).not.toContain('proxy');
    expect(JSON.stringify(logs)).toContain('Corporate proxy: upstream unavailable');
  });
});

describe('jira_view_ticket', () => {
  it('returns the fields, the description, the comments and the attachments with name, size and type', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' });

    expect(text).toContain('## [PROJ-123](https://jira.example.com/browse/PROJ-123): Implement user authentication');
    expect(text).toContain('| **Status** | In Progress |');
    expect(text).toContain('We need OAuth2 authentication for the mobile app.');
    expect(text).toContain('## Comments (1, newest first)');
    expect(text).toContain('**1. John Smith** (2024-02-01)\n\nPlease add unit tests for the token refresh flow.');
    expect(text).toContain(
      '## Attachments (3)\n\n'
      + '- screenshot.png — 234 KB (image/png)\n'
      + '- error.log — 45 KB (text/plain)\n'
      + '- heap-dump.bin — 50.0 MB (application/octet-stream)',
    );
  });

  it('follows the display settings for the fields', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, {
      config: jiraConfig({ hiddenDisplayFields: ['priority'], additionalDisplayFields: ['customfield_10500'] }),
    });

    expect(text).not.toContain('| **Priority** |');
    expect(text).toMatch(/\| \*\*[^|]+\*\* \| _Not set_ \|/);
  });

  it('shows all comments newest first', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client: new ManyCommentsClient(3) });

    expect(text.indexOf('Comment number 3')).toBeLessThan(text.indexOf('Comment number 2'));
    expect(text.indexOf('Comment number 2')).toBeLessThan(text.indexOf('Comment number 1'));
    expect(text).not.toContain('older comment');
  });

  it('with 150 comments shows the newest 100 and says 50 older ones were left out', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client: new ManyCommentsClient(150) });

    expect(text).toContain('## Comments (150, newest first)');
    expect(text).toContain('**1. Author 150**');
    expect(text).toContain('**100. Author 51**');
    expect(text).not.toContain('Author 50**');
    expect(text).toContain('_50 older comments left out; only the newest 100 are shown._');
  });

  it('without a key takes PROJ-123 from the branch feature/PROJ-123-login and names folder and branch', async () => {
    const repo = makeRepoOnBranch('feature/PROJ-123-login');
    const client = new MockJiraClient();
    const asked: string[] = [];
    const getIssue = client.getIssue.bind(client);
    client.getIssue = async (key: string) => { asked.push(key); return getIssue(key); };

    const text = await callTool(VIEW_TICKET_TOOL, {}, { client, folders: [repo] });

    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['PROJ-123']));
    expect(text.split('\n')[0]).toBe(`_Ticket key PROJ-123 taken from the git branch \`feature/PROJ-123-login\` of the workspace folder \`${repo}\`._`);
    expect(text).toContain('Implement user authentication');
  });

  it('without a key on main says the branch holds no key', async () => {
    const repo = makeRepoOnBranch('main');

    const text = await callTool(VIEW_TICKET_TOOL, {}, { folders: [repo] });

    expect(text).toBe(
      `No ticket key was given, and the git branch \`main\` of the workspace folder \`${repo}\` holds no ticket key. `
      + 'Call jira_view_ticket again with a ticket key, e.g. PROJ-123.',
    );
  });

  it('without a key and without a workspace folder says so', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, {});

    expect(text).toContain('no workspace folder is open');
  });

  it('answers with the setup hint when Jira is not configured', async () => {
    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { config: jiraConfig({ token: undefined }) });

    expect(text).toBe('Jira credentials not configured. Run "Ticket Sidekick: Set Jira Personal Access Token" from the Command Palette.');
  });

  it('answers a Jira 502 with an HTML proxy page with "HTTP 502" and a short reason, and logs the full text', async () => {
    const client = new MockJiraClient();
    const page = '<html><head><title>502</title></head><body><h1>Proxy error</h1><p>The upstream server sent an invalid response.</p></body></html>';
    client.getIssue = async () => {
      throw new JiraApiError(`Jira API error 502 Bad Gateway at https://jira.example.com/rest/api/2/issue/PROJ-123 — ${page}`, 502, 'https://jira.example.com/rest/api/2/issue/PROJ-123', page);
    };
    const logs: Logged[] = [];
    const outcomes: ToolCallOutcome[] = [];

    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, logs, outcomes });

    expect(text).toBe('Could not read PROJ-123: Jira answered HTTP 502 (Bad Gateway).');
    expect(outcomes).toEqual([{ tool: VIEW_TICKET_TOOL, ok: false, error: 'HTTP 502' }]);
    expect(logs.some(l => l.level === 'error' && JSON.stringify(l.details).includes('Proxy error'))).toBe(true);
  });

  it('ends the call with a timeout answer when Jira does not answer in time', async () => {
    const client = new MockJiraClient();
    client.getIssue = () => new Promise<JiraIssue>(() => undefined);

    const outcomes: ToolCallOutcome[] = [];

    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, timeoutMs: 50, outcomes });

    expect(outcomes).toEqual([{ tool: VIEW_TICKET_TOOL, ok: false, error: 'timeout' }]);

    expect(text).toBe('Could not read PROJ-123: Jira did not respond within 1 second. Try again later, or check the connection with jira_check_connection.');
  });
});

describe('jira_find_tickets', () => {
  it('runs JQL and shows the tickets in the configured columns', async () => {
    const client = new RecordingSearchClient();

    const text = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ' }, { client, config: jiraConfig({ searchFields: ['priority'] }) });

    expect(client.searches.map(s => s.jql)).toEqual(['project = PROJ']);
    expect(client.searches[0].extraFields).toEqual(['priority']);
    expect(text).toContain('Found 2 ticket(s):');
    expect(text).toContain(
      '| Key | Summary | Status | Assignee | Priority |\n'
      + '| --- | --- | --- | --- | --- |\n'
      + '| PROJ-123 | Implement user authentication | In Progress | Jane Doe | High |\n'
      + '| PROJ-124 | Add password reset flow | To Do | Unassigned | Medium |',
    );
    expect(text).not.toContain('@jira');
  });

  it('resolves a filter name to its JQL and narrows it by sprint', async () => {
    const client = new RecordingSearchClient();
    client.searchFiltersByName = async (): Promise<JiraFilter[]> =>
      [{ id: '10002', name: 'Team open bugs', jql: 'project = PROJ AND issuetype = Bug AND status != Done' }];

    const text = await callTool(FIND_TICKETS_TOOL, { filter: 'Team open bugs', sprint: 'Sprint 42' }, { client });

    expect(client.searches.map(s => s.jql)).toEqual(['(project = PROJ AND issuetype = Bug AND status != Done) AND (Sprint = "Sprint 42")']);
    expect(text).toContain('_Using filter: **Team open bugs**_');
    expect(text).toContain('PROJ-123');
  });

  it('narrows a saved filter by the team JQL and keeps its ordering', async () => {
    const client = new RecordingSearchClient();

    await callTool(FIND_TICKETS_TOOL, { filter: '12345', myTeam: true }, {
      client, config: jiraConfig({ myTeamJql: 'project = PROJ AND component = Backend' }),
    });

    expect(client.searches.map(s => s.jql)).toEqual([
      '(project = PROJ AND component = Backend) AND (assignee = currentUser() AND issuetype = Bug AND status != Done) ORDER BY created DESC',
    ]);
  });

  it('lists the candidates when a filter name matches more than one filter', async () => {
    const client = new RecordingSearchClient();

    const text = await callTool(FIND_TICKETS_TOOL, { filter: 'open bugs' }, { client });

    expect(client.searches).toEqual([]);
    expect(text).toContain('**My open bugs** (id: 10001)');
    expect(text).toContain('**Team open bugs** (id: 10002)');
  });

  it('refuses a call that gives both JQL and a filter', async () => {
    const client = new RecordingSearchClient();

    const text = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ', filter: 'My open bugs' }, { client });

    expect(client.searches).toEqual([]);
    expect(text).toBe('Give either jql or filter, not both. To narrow a saved filter, use fixVersion, sprint, assignee or myTeam.');
  });

  it('refuses a call that gives neither JQL nor a filter', async () => {
    const text = await callTool(FIND_TICKETS_TOOL, { myTeam: true });

    expect(text).toBe(`Give either jql or filter. Call ${LIST_MY_FILTERS_TOOL} to see your saved filters.`);
  });

  it('pages through a long Data Center result by offset', async () => {
    const issues = (await new MockJiraClient().searchJql('x')).issues;
    const client = new RecordingSearchClient({ issues, total: 120 });

    const first = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ' }, { client });
    const second = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ', page: '50' }, { client });

    expect(first).toContain('More tickets match: call jira_find_tickets again with the same query and page "2".');
    expect(second).toContain('More tickets match: call jira_find_tickets again with the same query and page "52".');
    expect(client.searches.map(s => s.startAt)).toEqual([undefined, 50]);
  });

  it('pages through a Cloud result by the page token Jira returns', async () => {
    const issues = (await new MockJiraClient().searchJql('x')).issues;
    const client = new RecordingSearchClient({ issues, nextPageToken: 'tok-2', isLast: false });

    const first = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ' }, { client, config: jiraConfig({ authType: 'cloud' }) });
    await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ', page: 'tok-2' }, { client, config: jiraConfig({ authType: 'cloud' }) });

    expect(first).toContain('page "tok-2"');
    expect(client.searches.map(s => s.pageToken)).toEqual([undefined, 'tok-2']);
  });

  it('answers with the setup hint when Jira is not configured', async () => {
    const text = await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ' }, { config: jiraConfig({ token: undefined }) });

    expect(text).toBe('Jira credentials not configured. Run "Ticket Sidekick: Set Jira Personal Access Token" from the Command Palette.');
  });

  it('tells the agent the my-team setting and saved filters apply', () => {
    const description = JIRA_TOOLS.find(t => t.name === FIND_TICKETS_TOOL)?.description ?? '';

    expect(description).toContain('ticketSidekick.jira.myTeamJql');
    expect(description).toContain(LIST_MY_FILTERS_TOOL);
  });
});

describe('jira_list_my_filters', () => {
  it('lists favourite and owned filters once each', async () => {
    const text = await callTool(LIST_MY_FILTERS_TOOL);

    expect(text).toBe(
      'Your filters:\n\n'
      + '- **My open bugs** (id: 10001)\n'
      + '- **Sprint Backlog** (id: 10003)\n'
      + '- **My Created Tickets** (id: 10004)',
    );
  });
});

/** The fixture ticket as a Bug, so its workflow can be looked up. */
class BugTicketClient extends MockJiraClient {
  statusLookups = 0;
  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await super.getIssue(issueKey);
    return { ...issue, fields: { ...issue.fields, issuetype: { name: 'Bug' } } };
  }
  override async getProjectStatuses(projectKey: string, issueType: string): Promise<string[]> {
    this.statusLookups++;
    return super.getProjectStatuses(projectKey, issueType);
  }
}

function writeWorkflowCache(folder: string, graph: Record<string, Array<{ id: string; name: string; to: string }>>): void {
  fs.writeFileSync(path.join(folder, '.jira-workflow-cache.json'), JSON.stringify({ PROJ: { Bug: { discovered: '2026-05-11', graph } } }));
}

function readWorkflowCache(folder: string): { PROJ: { Bug: { discovered: string; graph: Record<string, unknown[]> } } } {
  return JSON.parse(fs.readFileSync(path.join(folder, '.jira-workflow-cache.json'), 'utf-8'));
}

describe('jira_workflow', () => {
  const cachedGraph = {
    'In Progress': [{ id: '21', name: 'Submit for Review', to: 'In Review' }],
    'In Review': [{ id: '41', name: 'Approve', to: 'Done' }, { id: '42', name: 'Send Back', to: 'In Progress' }],
  };

  it("lists the statuses reachable from the ticket's status in the cached workflow", async () => {
    const folder = makeTempDir();
    writeWorkflowCache(folder, cachedGraph);
    const client = new BugTicketClient();

    const text = await callTool(WORKFLOW_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    expect(client.statusLookups).toBe(0);
    expect(text).toBe(
      '**PROJ-123** (Bug) is in **In Progress**. Statuses it can reach, from the workflow cached on 2026-05-11:\n\n'
      + '- **In Review**: Submit for Review\n'
      + '- **Done**: Submit for Review → Approve\n\n'
      + 'Call jira_workflow again with refresh: true if the workflow has changed since.',
    );
  });

  it('discovers and caches the workflow when none is cached', async () => {
    const folder = makeTempDir();
    const client = new BugTicketClient();

    const text = await callTool(WORKFLOW_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    expect(client.statusLookups).toBe(1);
    expect(text).toContain('from the workflow discovered just now and saved to `.jira-workflow-cache.json`:');
    expect(text).toContain('- **To Do**: To Do');
    expect(text).toContain('- **In Review**: In Review');
    expect(text).toContain('- **Done**: Done');
    expect(Object.keys(readWorkflowCache(folder).PROJ.Bug.graph)).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
  });

  it('rediscovers and rewrites the cache on refresh', async () => {
    const folder = makeTempDir();
    writeWorkflowCache(folder, cachedGraph);
    const client = new BugTicketClient();

    const text = await callTool(WORKFLOW_TOOL, { ticketKey: 'PROJ-123', refresh: true }, { client, folders: [folder] });

    expect(client.statusLookups).toBe(1);
    const cache = readWorkflowCache(folder);
    expect(cache.PROJ.Bug.discovered).not.toBe('2026-05-11');
    expect(cache.PROJ.Bug.graph['In Progress']).toHaveLength(4);
    expect(text).toContain('- **To Do**: To Do');
  });

  it('says where the cache lives when no workspace folder is open', async () => {
    const text = await callTool(WORKFLOW_TOOL, { ticketKey: 'PROJ-123' }, { client: new BugTicketClient() });

    expect(text).toBe('No workspace folder is open: the workflow is cached in `.jira-workflow-cache.json` in the first workspace folder.');
  });
});

describe('jira_list_templates', () => {
  it('lists the workspace templates with the fields each one sets', async () => {
    const text = await callTool(LIST_TEMPLATES_TOOL, {}, { folders: [path.resolve('src/test/fixtures/templates-valid')] });

    expect(text).toBe(
      'Available templates:\n\n'
      + '- **Billing App Bug** (Bug)\n'
      + '  - priority: High\n'
      + '  - labels: billing\n'
      + '  - customfield_10020: sprint "Sprint 5", looked up when the ticket is created\n'
      + '  - customfield_10200: team "Backend Team", looked up when the ticket is created\n'
      + '  - Description sections: Steps to reproduce, Expected behavior, Actual behavior, Environment\n'
      + '- **Frontend Story** (issue type not set on the template)\n'
      + '  - priority: Medium\n'
      + '  - labels: frontend\n'
      + '  - customfield_10020: sprint id 42\n'
      + '  - customfield_10200: team id abc-team-id\n'
      + '  - Description sections: User story, Acceptance criteria, Design link',
    );
  });

  it('gives the no-templates answer when the workspace has no template file', async () => {
    const text = await callTool(LIST_TEMPLATES_TOOL, {}, { folders: [makeTempDir()] });

    expect(text).toBe('No templates found. Create a `.jira-templates.json` file in the workspace root to define reusable ticket templates.');
  });
});
