import type {
  IJiraClient,
  JiraComment,
  JiraCreatedIssue,
  JiraCreateMetaField,
  JiraEditMetaField,
  JiraFieldMeta,
  JiraFilter,
  JiraIssue,
  JiraProject,
  JiraProjectStatus,
  JiraRemoteLink,
  JiraSearchResult,
  JiraSprintCandidate,
  JiraTransition,
  JiraUser,
} from './IJiraClient';
import { fetchWithRetry } from '../utils/fetchWithRetry';
import { ApiError, JiraApiError } from '../utils/apiError';
import type { DiagLogger } from '../utils/diagTypes';

export { JiraApiError } from '../utils/apiError';

type AuthType = 'datacenter' | 'cloud';

// A failed authentication should never be swallowed as "no data" — surface it so the user
// fixes their credentials instead of seeing silently empty results.
function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

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

/**
 * Build a safe multipart `Content-Disposition` value for a file part.
 *
 * Attachment filenames can originate from received emails (untrusted). Interpolating them
 * raw allows a `"` to break the header or CR/LF to inject extra headers. We emit a
 * sanitized ASCII `filename="…"` fallback (control chars and quotes/backslashes removed,
 * non-ASCII degraded) plus an RFC 5987 `filename*=UTF-8''…` carrying the real (percent-
 * encoded) name so Unicode filenames still round-trip.
 */
export function buildFileContentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[\x00-\x1f\x7f]/g, '') // control chars incl. CR/LF
    .replace(/["\\]/g, '')           // quote/backslash would break the quoted-string
    .replace(/[^\x20-\x7e]/g, '_');  // degrade remaining non-ASCII
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `form-data; name="file"; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Maximum attachment size we will attempt to upload (the whole file is held in memory). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Throw a clear, actionable error when a base64 attachment would exceed the size limit —
 * computed from the base64 length (no allocation) so a huge file fails fast instead of
 * triggering an opaque buffer-allocation error during the multipart build.
 */
export function assertAttachmentWithinLimit(
  filename: string,
  contentBytes: string,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): void {
  const estimatedBytes = Math.floor((contentBytes.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new JiraApiError(
      `Attachment "${filename}" is ~${mb(estimatedBytes)} MB, exceeding the ${mb(maxBytes)} MB upload limit.`,
      413,
      'attachment',
    );
  }
}

export interface JiraApiClientConfig {
  baseUrl: string;
  authType: AuthType;
  token: string;
  sprintBoardId?: number;
  onDiag?: DiagLogger;
}

export class JiraApiClient implements IJiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly authType: AuthType;
  private readonly sprintBoardId?: number;
  private readonly onDiag?: DiagLogger;

  constructor(config: JiraApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
    this.sprintBoardId = config.sprintBoardId;
    this.onDiag = config.onDiag;
  }

  // Descriptions and comments always use REST API v2 (plain text / Jira wiki markup).
  // For Cloud-only fields that require v3 ADF, use requestV3() when needed.
  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2${path}`;
    const response = await fetchWithRetry(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      if (response.status === 401) throw new JiraApiError(`Authentication failed at ${url}. Check your credentials.`, 401, url);
      if (response.status === 404) throw new JiraApiError(`Not found: ${url}`, 404, url);
      const body = await response.text().catch(() => '');
      throw new JiraApiError(`Jira API error ${response.status} ${response.statusText} at ${url}${body ? ` — ${body}` : ''}`, response.status, url, body);
    }
    if (response.status === 204) return undefined as T;
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  private async agileRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/agile/1.0${path}`;
    const response = await fetchWithRetry(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new JiraApiError(`Jira Agile API error ${response.status} ${response.statusText} at ${url}`, response.status, url);
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  private async requestV3<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const response = await fetchWithRetry(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      if (response.status === 401) throw new JiraApiError(`Authentication failed at ${url}. Check your credentials.`, 401, url);
      if (response.status === 404) throw new JiraApiError(`Not found: ${url}`, 404, url);
      const body = await response.text().catch(() => '');
      throw new JiraApiError(`Jira API error ${response.status} ${response.statusText} at ${url}${body ? ` — ${body}` : ''}`, response.status, url, body);
    }
    if (response.status === 204) return undefined as T;
    await assertJsonContentType(response);
    return response.json() as Promise<T>;
  }

  private async teamsRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/teams/1.0${path}`;
    const response = await fetchWithRetry(url, {
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new JiraApiError(`Jira Teams API error ${response.status} ${response.statusText} at ${url}`, response.status, url);
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
    assertAttachmentWithinLimit(filename, contentBytes);
    const url = `${this.baseUrl}/rest/api/2/issue/${issueKey}/attachments`;
    const buffer = Buffer.from(contentBytes, 'base64');
    const boundary = `----boundary${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: ${buildFileContentDisposition(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await fetchWithRetry(url, {
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
      throw new JiraApiError(`Attachment upload failed (${response.status}): ${text}`, response.status, url, text);
    }
  }

  async searchJql(jql: string, maxResults = 20, startAt?: number, extraFields: string[] = []): Promise<JiraSearchResult> {
    const baseFields = ['summary', 'status', 'assignee', 'priority', 'labels', 'fixVersions', 'reporter', 'subtasks', 'parent'];
    const fields = [...baseFields, ...extraFields.filter(f => !baseFields.includes(f))];
    let qs = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&${fields.map(f => `fields=${encodeURIComponent(f)}`).join('&')}`;
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
    const boardIds = this.sprintBoardId
      ? [this.sprintBoardId]
      : await this.getSprintBoardIds(projectKey);
    for (const boardId of boardIds) {
      try {
        const sprints = await this.agileRequest<{ values: Array<{ id: number; name: string }> }>(
          `/board/${boardId}/sprint?state=active,future`,
        );
        const match = sprints.values.find((s) => s.name === sprintName);
        if (match) return { id: match.id };
      } catch (err) {
        // Kanban (and other non-Scrum) boards reject sprint queries — skip them. But an
        // auth failure must surface rather than silently yield no sprints.
        if (isAuthError(err)) throw err;
        this.onDiag?.('warn', `Board ${boardId} skipped (non-Scrum) while resolving sprint "${sprintName}"`, { boardId, sprintName });
      }
    }
    throw new Error(`Sprint '${sprintName}' not found in project ${projectKey}.`);
  }

  private async getSprintBoardIds(projectKey: string): Promise<number[]> {
    const boards = await this.agileRequest<{ values: Array<{ id: number; type: string }> }>(
      `/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
    );
    return boards.values.filter(b => b.type === 'scrum').map(b => b.id);
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
    const pageSize = 100;
    const all: JiraComment[] = [];
    let startAt = 0;
    // Hard cap as a backstop: an empty page should already break the loop, but this
    // guarantees termination for any other non-advancing server response.
    const maxIterations = 1000;
    for (let i = 0; i < maxIterations; i++) {
      const { comments, total } = await this.getIssueComments(issueKey, pageSize, startAt);
      all.push(...comments);
      // Stop when we've collected everything, or a page came back empty (which would
      // otherwise leave startAt unchanged and spin forever).
      if (comments.length === 0 || all.length >= total) break;
      startAt += comments.length;
    }
    return all;
  }

  async downloadAttachment(content: string): Promise<Uint8Array> {
    const response = await fetchWithRetry(content, {
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

  async getRequiredFields(projectKey: string, issueType: string): Promise<JiraCreateMetaField[]> {
    type CreateMetaField = { required: boolean; name: string; schema: { type: string; items?: string; custom?: string } };
    type CreateMetaResponse = {
      projects: Array<{
        key: string;
        issuetypes: Array<{ name: string; fields: Record<string, CreateMetaField> }>;
      }>;
    };
    const qs = `projectKeys=${encodeURIComponent(projectKey)}&issuetypeNames=${encodeURIComponent(issueType)}&expand=projects.issuetypes.fields`;
    const data = await this.request<CreateMetaResponse>(`/issue/createmeta?${qs}`);
    const project = data.projects.find((p) => p.key === projectKey);
    const issueTypeMeta = project?.issuetypes.find((it) => it.name.toLowerCase() === issueType.toLowerCase());
    if (!issueTypeMeta) return [];
    return Object.entries(issueTypeMeta.fields)
      .filter(([, field]) => field.required)
      .map(([id, field]) => ({ id, name: field.name, schema: field.schema }));
  }

  async getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
    try {
      return await this.request<JiraRemoteLink[]>(`/issue/${issueKey}/remotelink`);
    } catch (err) {
      // A 404 means the issue has no remote links (or the feature is absent) — return empty.
      // Auth/server errors must surface rather than masquerade as "no links".
      if (err instanceof ApiError && err.status === 404) {
        this.onDiag?.('warn', `No remote links — ${issueKey} (404)`, { issueKey });
        return [];
      }
      throw err;
    }
  }

  async findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]> {
    const boardIds = this.sprintBoardId
      ? [this.sprintBoardId]
      : await this.getSprintBoardIds(projectKey);
    const results: JiraSprintCandidate[] = [];
    const seen = new Set<number>();
    const lowerQuery = query.toLowerCase();
    for (const boardId of boardIds) {
      try {
        const sprints = await this.agileRequest<{ values: Array<{ id: number; name: string; state: string }> }>(
          `/board/${boardId}/sprint?state=active,future`,
        );
        for (const s of sprints.values) {
          if (!seen.has(s.id) && s.name.toLowerCase().includes(lowerQuery)) {
            seen.add(s.id);
            results.push({ id: s.id, name: s.name, state: s.state });
          }
        }
      } catch (err) {
        // Kanban (and other non-Scrum) boards reject sprint queries — skip them. But an
        // auth failure must surface rather than silently yield no sprints.
        if (isAuthError(err)) throw err;
        this.onDiag?.('warn', `Board ${boardId} skipped (non-Scrum) while searching sprints for "${query}"`, { boardId, query });
      }
    }
    return results;
  }
}
