import { describe, it, expect, afterEach } from 'vitest';
import { callTool as runTool } from '../tools/toolDefinition';
import { RecentCallGuard } from '../tools/recentCallGuard';
import {
  JIRA_TOOLS, CHECK_CONNECTION_TOOL, VIEW_TICKET_TOOL, FIND_TICKETS_TOOL, LIST_MY_FILTERS_TOOL, WORKFLOW_TOOL, LIST_TEMPLATES_TOOL,
  LOAD_TICKET_TOOL,
} from '../tools/jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from '../tools/jiraTools/jiraAccess';
import type { IJiraClient, JiraAttachment, JiraComment, JiraFilter, JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { JiraConfig } from '../services/ConfigService';
import { JiraApiError } from '../utils/apiError';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeRepoOnBranch, makeTempDir, removeTempDirs } from './helpers/gitRepo';
import * as fs from 'fs';
import * as path from 'path';

// Each Jira tool is called the way the extension calls it for Copilot: input checked against the
// tool's schema, then the handler, with the mock Jira client behind it.

/** How a call ended, as the extension logs it. */
type ToolCallOutcome = { tool: string; ok: true } | { tool: string; ok: false; error: string };

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
  downloadTimeoutMs?: number;
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
    jiraDownloadTimeoutMs: options.downloadTimeoutMs,
    recentWrites: new RecentCallGuard(),
    onDiag: (level, message, details) => options.logs?.push({ level, message, details }),
  };
  const tool = JIRA_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  const result = await runTool(tool, args, deps);
  options.outcomes?.push(result.failed ? { tool: name, ok: false, error: result.error ?? '' } : { tool: name, ok: true });
  return result.text;
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

/** Jira answers 404 for every ticket. */
class NotFoundClient extends MockJiraClient {
  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const url = `https://jira.example.com/rest/api/2/issue/${issueKey}`;
    throw new JiraApiError(`Jira API error 404 Not Found at ${url}`, 404, url);
  }
}

describe('Jira tool catalog', () => {
  it('marks every tool that only reads Jira as read-only', () => {
    expect(CHECK_CONNECTION_TOOL).toBe('jira_check_connection');
    expect(VIEW_TICKET_TOOL).toBe('jira_view_ticket');
    const reads = [CHECK_CONNECTION_TOOL, VIEW_TICKET_TOOL, FIND_TICKETS_TOOL, LIST_MY_FILTERS_TOOL, WORKFLOW_TOOL, LIST_TEMPLATES_TOOL];
    for (const name of reads) expect(JIRA_TOOLS.find(t => t.name === name)?.annotations, name).toEqual({ readOnlyHint: true });
  });

  it('marks every tool that writes to Jira as destructive and never as read-only, so the harness always asks first', () => {
    const writes = JIRA_TOOLS.filter(t => !t.annotations.readOnlyHint && t.name !== LOAD_TICKET_TOOL);
    expect(writes.map(t => t.name).sort()).toEqual(
      ['jira_add_comment', 'jira_create_ticket', 'jira_move_ticket', 'jira_update_field', 'jira_upload_attachment'],
    );
    for (const tool of writes) expect(tool.annotations, tool.name).toEqual({ destructiveHint: true });
  });

  it('marks load ticket neither read-only nor destructive, since it writes only local files', () => {
    expect(LOAD_TICKET_TOOL).toBe('jira_load_ticket');
    expect(JIRA_TOOLS.find(t => t.name === LOAD_TICKET_TOOL)?.annotations).toEqual({});
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

  it('ends with the timeout answer when Jira does not answer the signed-in user request in time', async () => {
    const client = new MockJiraClient();
    client.getCurrentUser = () => new Promise(() => undefined);

    const text = await callTool(CHECK_CONNECTION_TOOL, {}, { client, timeoutMs: 50 });

    expect(text).toBe('Could not check the Jira connection: Jira did not respond within 1 second. Try again later, or check the connection with jira_check_connection.');
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

  it('refuses the ticket key ../evil without asking Jira', async () => {
    const client = new MockJiraClient();
    const asked: string[] = [];
    client.getIssue = async (key: string) => { asked.push(key); throw new Error('must not be called'); };

    const text = await callTool(VIEW_TICKET_TOOL, { ticketKey: '../evil' }, { client });

    expect(text).toBe('"../evil" is not a valid ticket key.');
    expect(asked).toEqual([]);
  });

  it('names the branch and folder when the key taken from the branch release/UTF-8-fix is not found', async () => {
    const repo = makeRepoOnBranch('release/UTF-8-fix');

    const text = await callTool(VIEW_TICKET_TOOL, {}, { client: new NotFoundClient(), folders: [repo] });

    expect(text).toBe(
      `Could not read UTF-8 (taken from the git branch release/UTF-8-fix of the folder "${repo}"): `
      + 'Jira answered HTTP 404 (not found, or no permission to see it).',
    );
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

  it('narrows a sort-only saved filter by the team JQL, with the team JQL as the whole condition', async () => {
    const client = new RecordingSearchClient();
    client.getFilterById = async (): Promise<JiraFilter> => ({ id: '10005', name: 'Newest first', jql: 'ORDER BY created DESC' });

    await callTool(FIND_TICKETS_TOOL, { filter: '10005', myTeam: true }, {
      client, config: jiraConfig({ myTeamJql: 'project = PROJ AND component = Backend' }),
    });

    expect(client.searches.map(s => s.jql)).toEqual(['project = PROJ AND component = Backend ORDER BY created DESC']);
  });

  it('narrows a sort-only JQL by the assignee, with the assignee as the whole condition', async () => {
    const client = new RecordingSearchClient();

    await callTool(FIND_TICKETS_TOOL, { jql: 'ORDER BY created DESC', assignee: 'me' }, { client });

    expect(client.searches.map(s => s.jql)).toEqual(['assignee = currentUser() ORDER BY created DESC']);
  });

  it('does not take ORDER BY inside a quoted value for the sort clause when narrowing', async () => {
    const client = new RecordingSearchClient();

    await callTool(FIND_TICKETS_TOOL, { jql: 'project = PROJ AND summary ~ "slow ORDER BY query"', assignee: 'me' }, { client });
    await callTool(FIND_TICKETS_TOOL, {
      jql: `project = PROJ AND summary ~ 'say \\'ORDER BY x\\' twice' ORDER BY created DESC`, assignee: 'me',
    }, { client });
    client.getFilterById = async (): Promise<JiraFilter> => ({ id: '10006', name: 'Slow', jql: 'summary ~ "slow ORDER BY query" ORDER BY key' });
    await callTool(FIND_TICKETS_TOOL, { filter: '10006', myTeam: true }, {
      client, config: jiraConfig({ myTeamJql: 'project = PROJ' }),
    });

    expect(client.searches.map(s => s.jql)).toEqual([
      '(project = PROJ AND summary ~ "slow ORDER BY query") AND (assignee = currentUser())',
      `(project = PROJ AND summary ~ 'say \\'ORDER BY x\\' twice') AND (assignee = currentUser()) ORDER BY created DESC`,
      '(project = PROJ) AND (summary ~ "slow ORDER BY query") ORDER BY key',
    ]);
  });

  it('passes a sort-only JQL without narrowing through unchanged', async () => {
    const client = new RecordingSearchClient();

    await callTool(FIND_TICKETS_TOOL, { jql: 'ORDER BY updated DESC' }, { client });

    expect(client.searches.map(s => s.jql)).toEqual(['ORDER BY updated DESC']);
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

  it('refuses the ticket key ../evil and writes no cache', async () => {
    const folder = makeTempDir();
    const client = new BugTicketClient();

    const text = await callTool(WORKFLOW_TOOL, { ticketKey: '../evil' }, { client, folders: [folder] });

    expect(text).toBe('"../evil" is not a valid ticket key.');
    expect(client.statusLookups).toBe(0);
    expect(filesUnder(folder)).toEqual([]);
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

function attachment(id: string, filename: string, mimeType: string, size: number): JiraAttachment {
  return { id, filename, mimeType, size, content: `https://jira.example.com/secure/attachment/${id}`, created: `2024-01-01T00:00:0${id.length % 10}.000+0000` };
}

/**
 * The fixture ticket with its attachments replaced; each download returns the attachment's id.
 * `delays` makes a download take that many milliseconds, or never finish with `'never'`.
 */
class AttachmentsClient extends MockJiraClient {
  constructor(
    private readonly attachments: JiraAttachment[],
    private readonly failing: string[] = [],
    private readonly delays: Record<string, number | 'never'> = {},
  ) { super(); }
  override async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await super.getIssue(issueKey);
    return { ...issue, fields: { ...issue.fields, attachment: this.attachments } };
  }
  override async downloadAttachment(contentUrl: string): Promise<Uint8Array> {
    const id = contentUrl.split('/').pop() ?? '';
    const delay = this.delays[id];
    if (delay === 'never') return new Promise<Uint8Array>(() => undefined);
    if (delay !== undefined) await new Promise(resolve => setTimeout(resolve, delay));
    if (this.failing.includes(id)) throw new Error('HTTP 500');
    return new TextEncoder().encode(`content of ${id}`);
  }
}

/** Every file under `dir`, relative to it, with `/` separators. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

describe('jira_load_ticket', () => {
  it('without a list writes the ticket files and the eligible attachments, and lists the binary one as skipped', async () => {
    const folder = makeTempDir();
    const ctx = path.join(folder, '.jira-context', 'PROJ-123');

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { folders: [folder] });

    expect(filesUnder(folder)).toEqual([
      '.gitignore',
      '.jira-context/PROJ-123/attachments/error.log',
      '.jira-context/PROJ-123/attachments/screenshot.png',
      '.jira-context/PROJ-123/comments.md',
      '.jira-context/PROJ-123/ticket.md',
    ]);
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf-8')).toBe('.jira-context/\n');
    expect(fs.readFileSync(path.join(ctx, 'ticket.md'), 'utf-8')).toContain('# PROJ-123: Implement user authentication');
    expect(text).toContain(`- \`${path.join(ctx, 'ticket.md')}\``);
    expect(text).toContain(`- \`${path.join(ctx, 'comments.md')}\``);
    expect(text).toContain(`- \`${path.join(ctx, 'attachments', 'screenshot.png')}\``);
    expect(text).toContain(`- \`${path.join(ctx, 'attachments', 'error.log')}\``);
    expect(text).toContain('Attachments not downloaded, which can still be fetched:\n1. heap-dump.bin (50.0 MB): unknown binary format');
    expect(text).toContain('call jira_load_ticket with ticketKey "PROJ-123" and attachments set to the chosen names');
    expect(text).not.toContain('jira_downloadAttachment');
  });

  it('with a list also writes the named attachment the default filter skips', async () => {
    const folder = makeTempDir();

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123', attachments: ['heap-dump.bin'] }, { folders: [folder] });

    expect(filesUnder(path.join(folder, '.jira-context', 'PROJ-123'))).toEqual([
      'attachments/error.log',
      'attachments/heap-dump.bin',
      'attachments/screenshot.png',
      'comments.md',
      'ticket.md',
    ]);
    expect(text).toContain(`- \`${path.join(folder, '.jira-context', 'PROJ-123', 'attachments', 'heap-dump.bin')}\``);
    expect(text).not.toContain('not downloaded');
  });

  it('reports a named attachment the ticket does not have and still loads the rest', async () => {
    const folder = makeTempDir();

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123', attachments: ['design.pdf'] }, { folders: [folder] });

    expect(text).toContain('PROJ-123 has no attachment named `design.pdf`. Its attachments are: screenshot.png, error.log, heap-dump.bin.');
    expect(fs.existsSync(path.join(folder, '.jira-context', 'PROJ-123', 'ticket.md'))).toBe(true);
    expect(fs.existsSync(path.join(folder, '.jira-context', 'PROJ-123', 'attachments', 'error.log'))).toBe(true);
  });

  it('reports an attachment over the size limit and does not write it, even when it is named', async () => {
    const folder = makeTempDir();
    const client = new AttachmentsClient([
      attachment('a1', 'notes.txt', 'text/plain', 1024),
      attachment('a2', 'huge.zip', 'application/zip', 150 * 1024 * 1024),
    ]);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123', attachments: ['huge.zip'] }, { client, folders: [folder] });

    expect(fs.existsSync(path.join(folder, '.jira-context', 'PROJ-123', 'attachments', 'huge.zip'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.jira-context', 'PROJ-123', 'attachments', 'notes.txt'))).toBe(true);
    expect(text).toContain('Not downloadable:\n- huge.zip (150.0 MB): over 100 MB size limit');
    expect(text).not.toContain('can still be fetched');
  });

  it('skips attachments with unsafe filenames and writes nothing outside the attachments folder', async () => {
    const folder = makeTempDir();
    const client = new AttachmentsClient([
      attachment('a1', '../../evil.txt', 'text/plain', 10),
      attachment('a2', '..\\..\\evil.txt', 'text/plain', 10),
      attachment('a3', 'notes.txt', 'text/plain', 10),
    ]);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123', attachments: ['../../evil.txt'] }, { client, folders: [folder] });

    expect(filesUnder(folder)).toEqual([
      '.gitignore',
      '.jira-context/PROJ-123/attachments/notes.txt',
      '.jira-context/PROJ-123/comments.md',
      '.jira-context/PROJ-123/ticket.md',
    ]);
    expect(fs.readdirSync(path.dirname(folder)).filter(name => name.includes('evil'))).toEqual([]);
    expect(text).toContain('- ../../evil.txt (0 KB): unsafe filename');
    expect(text).toContain('- ..\\..\\evil.txt (0 KB): unsafe filename');
    // An unsafe name cannot be fetched, so it is never offered.
    expect(text).not.toContain('can still be fetched');
    expect(text).not.toContain('ask which to download');
  });

  it('numbers only the fetchable attachments when an unsafe one is skipped with them', async () => {
    const folder = makeTempDir();
    const client = new AttachmentsClient([
      attachment('a1', '../../evil.txt', 'text/plain', 10),
      attachment('a2', 'dump.bin', 'application/octet-stream', 10),
    ]);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    expect(text).toContain('Attachments not downloaded, which can still be fetched:\n1. dump.bin (0 KB): unknown binary format\n');
    expect(text).toContain('Not downloadable:\n- ../../evil.txt (0 KB): unsafe filename');
  });

  it('numbers the fetchable skipped attachments, lists the others apart, and tells the agent to let the user pick', async () => {
    const folder = makeTempDir();
    const client = new AttachmentsClient([
      attachment('a1', 'design.dat', 'application/octet-stream', 2 * 1024 * 1024),
      attachment('a2', 'dump.log', 'text/plain', 10),
      attachment('a3', 'huge.iso', 'application/octet-stream', 300 * 1024 * 1024),
      attachment('a4', '../../evil.txt', 'text/plain', 10),
    ], ['a2']);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    expect(text).toContain([
      'Attachments not downloaded, which can still be fetched:',
      '1. design.dat (2.0 MB): unknown binary format',
      '2. dump.log (0 KB): download failed',
      '',
      'Not downloadable:',
      '- huge.iso (300.0 MB): over 100 MB size limit',
      '- ../../evil.txt (0 KB): unsafe filename',
      '',
      'Show the user the numbered list above exactly as written, after your answer, and ask which to download: '
        + 'numbers such as "1, 2", or "all". When they answer, call jira_load_ticket with ticketKey "PROJ-123" and attachments '
        + "set to the chosen names. Do not download them without asking, unless the user's request already named them.",
    ].join('\n'));
  });

  it('names no tool outside the catalog, whatever the reasons for skipping', async () => {
    const folder = makeTempDir();
    const client = new AttachmentsClient([
      attachment('a1', 'dump.bin', 'application/octet-stream', 10),
      attachment('a2', 'notes.txt', 'text/plain', 10),
      { ...attachment('a3', 'notes.txt', 'text/plain', 10), created: '2025-01-01T00:00:00.000+0000' },
      attachment('a4', 'huge.zip', 'application/zip', 150 * 1024 * 1024),
      attachment('a5', '../evil.txt', 'text/plain', 10),
      attachment('a6', 'broken.log', 'text/plain', 10),
    ], ['a6']);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    expect(text).toContain('1. dump.bin (0 KB): unknown binary format\n2. broken.log (0 KB): download failed');
    expect(text).toContain('- notes.txt (0 KB): duplicate filename; only the newest attachment with this name is downloaded');
    const named = text.match(/\bjira_[A-Za-z_]+/g) ?? [];
    const catalog = new Set(JIRA_TOOLS.map(t => t.name));
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(catalog.has(name), name).toBe(true);
  });

  it('without a key loads the ticket named in the branch and names folder and branch', async () => {
    const repo = makeRepoOnBranch('feature/PROJ-123-login');

    const text = await callTool(LOAD_TICKET_TOOL, {}, { folders: [repo] });

    expect(text.split('\n')[0]).toBe(`_Ticket key PROJ-123 taken from the git branch \`feature/PROJ-123-login\` of the workspace folder \`${repo}\`._`);
    expect(fs.existsSync(path.join(repo, '.jira-context', 'PROJ-123', 'ticket.md'))).toBe(true);
  });

  it('lists an attachment that does not finish downloading in time as download failed and writes everything else', async () => {
    const folder = makeTempDir();
    const ctx = path.join(folder, '.jira-context', 'PROJ-123');
    // logs.zip takes longer than a Jira read may take, but less than a download may take.
    const client = new AttachmentsClient([
      attachment('a1', 'notes.txt', 'text/plain', 10),
      attachment('a2', 'logs.zip', 'application/zip', 10),
      attachment('a3', 'stuck.log', 'text/plain', 10),
    ], [], { a2: 100, a3: 'never' });
    const logs: Logged[] = [];

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder], timeoutMs: 50, downloadTimeoutMs: 300, logs });

    expect(filesUnder(ctx)).toEqual(['attachments/logs.zip', 'attachments/notes.txt', 'comments.md', 'ticket.md']);
    expect(text).toContain(`- \`${path.join(ctx, 'ticket.md')}\``);
    expect(text).toContain(`- \`${path.join(ctx, 'attachments', 'logs.zip')}\``);
    expect(text).toContain('1. stuck.log (0 KB): download failed');
    expect(text).toContain('call jira_load_ticket with ticketKey "PROJ-123" and attachments set to the chosen names');
    expect(text).not.toContain('did not respond');
    expect(logs.some(l => l.message.includes('stuck.log') && JSON.stringify(l.details).includes('did not respond'))).toBe(true);
  });

  it('ends with the timeout answer when the field metadata read hangs, and writes nothing', async () => {
    const folder = makeTempDir();
    const client = new MockJiraClient();
    client.getFields = () => new Promise(() => undefined);
    const logs: Logged[] = [];

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder], timeoutMs: 50, logs });

    expect(text).toBe('Could not load PROJ-123: Jira did not respond within 1 second. Try again later, or check the connection with jira_check_connection.');
    expect(filesUnder(folder)).toEqual([]);
    expect(logs.some(l => l.level === 'error' && l.message.includes('did not respond'))).toBe(true);
  });

  it('describes only its own ticket.md as the ticket, not an attachment named ticket.md', async () => {
    const folder = makeTempDir();
    const ctx = path.join(folder, '.jira-context', 'PROJ-123');
    const client = new AttachmentsClient([attachment('a1', 'ticket.md', 'text/markdown', 10)]);

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client, folders: [folder] });

    const lines = text.split('\n');
    expect(lines).toContain(`- \`${path.join(ctx, 'ticket.md')}\`: fields, description, web links, attachment list`);
    expect(lines).toContain(`- \`${path.join(ctx, 'attachments', 'ticket.md')}\``);
  });

  it('refuses the ticket key ../evil and writes nothing anywhere', async () => {
    const folder = makeTempDir();
    const parent = path.dirname(folder);
    const before = fs.readdirSync(parent).filter(name => name.includes('evil') || name === '.jira-context');

    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: '../evil' }, { folders: [folder] });

    expect(text).toBe('"../evil" is not a valid ticket key.');
    expect(filesUnder(folder)).toEqual([]);
    expect(fs.readdirSync(parent).filter(name => name.includes('evil') || name === '.jira-context')).toEqual(before);
  });

  it('names the ticket key in a failure for an explicit key', async () => {
    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { client: new NotFoundClient(), folders: [makeTempDir()] });

    expect(text).toBe('Could not load PROJ-123: Jira answered HTTP 404 (not found, or no permission to see it).');
  });

  it('names the branch and folder when the key taken from the branch release/UTF-8-fix is not found', async () => {
    const repo = makeRepoOnBranch('release/UTF-8-fix');

    const text = await callTool(LOAD_TICKET_TOOL, {}, { client: new NotFoundClient(), folders: [repo] });

    expect(text).toBe(
      `Could not load UTF-8 (taken from the git branch release/UTF-8-fix of the folder "${repo}"): `
      + 'Jira answered HTTP 404 (not found, or no permission to see it).',
    );
    expect(fs.existsSync(path.join(repo, '.jira-context'))).toBe(false);
  });

  it('without a workspace folder says so and writes nothing', async () => {
    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' });

    expect(text).toBe('No workspace folder is open: the ticket is loaded into `.jira-context/<KEY>/` in the first workspace folder.');
  });

  it('answers with the setup hint when Jira is not configured', async () => {
    const text = await callTool(LOAD_TICKET_TOOL, { ticketKey: 'PROJ-123' }, { config: jiraConfig({ token: undefined }), folders: [makeTempDir()] });

    expect(text).toBe('Jira credentials not configured. Run "Ticket Sidekick: Set Jira Personal Access Token" from the Command Palette.');
  });
});
