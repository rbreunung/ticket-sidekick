import type {
  IJiraClient,
  JiraIssue,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
} from './IJiraClient';

type AuthType = 'datacenter' | 'cloud';

export interface JiraApiClientConfig {
  baseUrl: string;
  authType: AuthType;
  token: string;
}

export class JiraApiClient implements IJiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: JiraApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
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
      if (response.status === 401) {
        throw new Error('Authentication failed. Check your credentials.');
      }
      if (response.status === 404) {
        throw new Error(`Not found: ${path}`);
      }
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
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
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: body }] },
          ],
        },
      }),
    });
  }

  async searchJql(jql: string, maxResults = 20): Promise<JiraSearchResult> {
    return this.request<JiraSearchResult>('/issue/search', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults,
        fields: [
          'summary', 'status', 'assignee', 'priority',
          'description', 'labels', 'fixVersions', 'reporter',
        ],
      }),
    });
  }

  async findUser(query: string): Promise<JiraUser[]> {
    return this.request<JiraUser[]>(`/user/search?query=${encodeURIComponent(query)}`);
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(
      `/issue/${issueKey}/transitions`,
    );
    return result.transitions;
  }

  async executeTransition(issueKey: string, transitionId: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }
}
