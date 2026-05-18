import type {
  IJiraClient,
  JiraComment,
  JiraCreatedIssue,
  JiraIssue,
  JiraProject,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
} from './IJiraClient';

type AuthType = 'datacenter' | 'cloud';

async function assertJsonContentType(response: Response): Promise<void> {
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    const snippet = await response.text().then(t => t.slice(0, 120)).catch(() => '');
    throw new Error(
      `Jira API returned HTML instead of JSON. ` +
      `Check that 'ticketSidekick.jira.baseUrl' points to the Jira root ` +
      `(e.g. https://server.com/jira — not just https://server.com). ` +
      `A proxy or redirect may also be intercepting the request.\n` +
      `Response preview: ${snippet}`,
    );
  }
}

export interface JiraApiClientConfig {
  baseUrl: string;
  authType: AuthType;
  token: string;
}

export class JiraApiClient implements IJiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly authType: AuthType;

  constructor(config: JiraApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
  }

  // Descriptions and comments always use REST API v2 (plain text / Jira wiki markup).
  // For Cloud-only fields that require v3 ADF, use requestV3() when needed.
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error(`Authentication failed at ${url}. Check your credentials.`);
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      const body = await response.text().catch(() => '');
      throw new Error(`Jira API error ${response.status} ${response.statusText} at ${url}${body ? ` — ${body}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  private async agileRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/agile/1.0${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`Jira Agile API error ${response.status} ${response.statusText} at ${url}`);
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  private async teamsRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/teams/1.0${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`Jira Teams API error ${response.status} ${response.statusText} at ${url}`);
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(`/issue/${issueKey}`);
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.request<void>(`/issue/${issueKey}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  async searchJql(jql: string, maxResults = 20): Promise<JiraSearchResult> {
    const fields = ['summary', 'status', 'assignee', 'priority', 'labels', 'fixVersions', 'reporter', 'subtasks'];
    const qs = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&${fields.map(f => `fields=${f}`).join('&')}`;
    return this.request<JiraSearchResult>(`/search?${qs}`);
  }

  async findUser(query: string): Promise<JiraUser[]> {
    return this.request<JiraUser[]>(`/user/search?query=${encodeURIComponent(query)}`);
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(`/issue/${issueKey}/transitions`);
    return result.transitions;
  }

  async executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    const body: Record<string, unknown> = { transition: { id: transitionId } };
    if (fields) body.fields = fields;
    await this.request<void>(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getResolutions(): Promise<Array<{ name: string }>> {
    return this.request<Array<{ name: string }>>('/resolution');
  }

  async getCurrentUser(): Promise<JiraUser> {
    return this.request<JiraUser>('/myself');
  }

  async getProject(projectKey: string): Promise<JiraProject> {
    return this.request<JiraProject>(`/project/${projectKey}`);
  }

  async getSprintByName(projectKey: string, sprintName: string): Promise<{ id: number }> {
    const boards = await this.agileRequest<{ values: Array<{ id: number }> }>(
      `/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
    );
    for (const board of boards.values) {
      const sprints = await this.agileRequest<{ values: Array<{ id: number; name: string }> }>(
        `/board/${board.id}/sprint?state=active,future`,
      );
      const match = sprints.values.find((s) => s.name === sprintName);
      if (match) return { id: match.id };
    }
    throw new Error(`Sprint '${sprintName}' not found in project ${projectKey}.`);
  }

  async getTeamByName(name: string): Promise<{ id: string }> {
    if (this.authType !== 'datacenter') {
      throw new Error(`Could not resolve team '${name}' — use id instead`);
    }
    const result = await this.teamsRequest<{ values: Array<{ id: string; displayName: string }> }>(
      `/teams/find?query=${encodeURIComponent(name)}`,
    );
    const match = result.values?.find((t) => t.displayName.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`Could not resolve team '${name}' — use id instead`);
    return { id: match.id };
  }

  async getIssueComments(issueKey: string, maxResults: number): Promise<{ comments: JiraComment[]; total: number }> {
    const data = await this.request<{ comments: JiraComment[]; total: number }>(
      `/issue/${issueKey}/comment?maxResults=${maxResults}&orderBy=-created`,
    );
    // API returns newest-first; reverse to chronological order for context
    return { comments: [...data.comments].reverse(), total: data.total };
  }

  async createIssue(
    projectKey: string,
    summary: string,
    issueType: string,
    additionalFields?: Record<string, unknown>,
  ): Promise<JiraCreatedIssue> {
    return this.request<JiraCreatedIssue>('/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
          ...additionalFields,
        },
      }),
    });
  }
}
