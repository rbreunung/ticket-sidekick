import type {
  IJiraClient,
  JiraComment,
  JiraCreatedIssue,
  JiraEditMetaField,
  JiraFieldMeta,
  JiraFilter,
  JiraIssue,
  JiraProject,
  JiraProjectStatus,
  JiraSearchResult,
  JiraSprintCandidate,
  JiraTransition,
  JiraUser,
} from './IJiraClient';

type AuthType = 'datacenter' | 'cloud';

async function assertJsonContentType(response: Response): Promise<void> {
  const ct = response.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    const snippet = await response.text().then(t => t.slice(0, 120)).catch(() => '');
    throw new Error(
      `Jira API returned HTML instead of JSON (HTTP ${response.status}). ` +
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

  private async requestV3<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
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

  async uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/2/issue/${issueKey}/attachments`;
    const buffer = Buffer.from(contentBytes, 'base64');
    const boundary = `----boundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'X-Atlassian-Token': 'nocheck',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Attachment upload failed (${response.status}): ${text}`);
    }
  }

  async searchJql(jql: string, maxResults = 20, startAt?: number): Promise<JiraSearchResult> {
    const fields = ['summary', 'status', 'assignee', 'priority', 'labels', 'fixVersions', 'reporter', 'subtasks'];
    let qs = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&${fields.map(f => `fields=${f}`).join('&')}`;
    if (startAt !== undefined) qs += `&startAt=${startAt}`;
    // Cloud removed /rest/api/2/search (410); must use /rest/api/3/search/jql
    if (this.authType === 'cloud') {
      return this.requestV3<JiraSearchResult>(`/search/jql?${qs}`);
    }
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

  async getProjectStatuses(projectKey: string, issueType: string): Promise<string[]> {
    const data = await this.request<JiraProjectStatus[]>(`/project/${projectKey}/statuses`);
    const match = data.find((t) => t.name.toLowerCase() === issueType.toLowerCase());
    return match ? match.statuses.map((s) => s.name) : [];
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

  async getIssueComments(issueKey: string, maxResults: number, startAt = 0): Promise<{ comments: JiraComment[]; total: number }> {
    const data = await this.request<{ comments: JiraComment[]; total: number }>(
      `/issue/${issueKey}/comment?maxResults=${maxResults}&startAt=${startAt}&orderBy=created`,
    );
    return { comments: data.comments, total: data.total };
  }

  async getAllComments(issueKey: string): Promise<JiraComment[]> {
    const all: JiraComment[] = [];
    let startAt = 0;
    while (true) {
      const { comments, total } = await this.getIssueComments(issueKey, 100, startAt);
      all.push(...comments);
      if (all.length >= total) break;
      startAt += comments.length;
    }
    return all;
  }

  async downloadAttachment(content: string): Promise<Uint8Array> {
    const response = await fetch(content, {
      headers: { Authorization: this.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Failed to download attachment: HTTP ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
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

  async getFilterById(id: string): Promise<JiraFilter> {
    return this.request<JiraFilter>(`/filter/${encodeURIComponent(id)}`);
  }

  async searchFiltersByName(name: string): Promise<JiraFilter[]> {
    const data = await this.request<{ values: JiraFilter[] }>(
      `/filter/search?filterName=${encodeURIComponent(name)}&expand=jql&maxResults=10`,
    );
    return data.values;
  }

  async getFields(): Promise<JiraFieldMeta[]> {
    return this.request<JiraFieldMeta[]>('/field');
  }

  async getEditMeta(issueKey: string): Promise<Record<string, JiraEditMetaField>> {
    const data = await this.request<{ fields: Record<string, JiraEditMetaField> }>(
      `/issue/${encodeURIComponent(issueKey)}/editmeta`,
    );
    return data.fields;
  }

  async findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]> {
    const boards = await this.agileRequest<{ values: Array<{ id: number }> }>(
      `/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
    );
    const results: JiraSprintCandidate[] = [];
    const seen = new Set<number>();
    const lowerQuery = query.toLowerCase();
    for (const board of boards.values) {
      const sprints = await this.agileRequest<{ values: Array<{ id: number; name: string; state: string }> }>(
        `/board/${board.id}/sprint?state=active,future`,
      );
      for (const s of sprints.values) {
        if (!seen.has(s.id) && s.name.toLowerCase().includes(lowerQuery)) {
          seen.add(s.id);
          results.push({ id: s.id, name: s.name, state: s.state });
        }
      }
    }
    return results;
  }
}
