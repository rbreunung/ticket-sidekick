import { readFileSync } from 'fs';
import { resolve } from 'path';
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
} from '../../jira/IJiraClient';

export const FIXTURE_ATTACHMENT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function loadFixture<T>(filename: string): T {
  // process.cwd() is the project root when running `npm test`
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockJiraClient implements IJiraClient {
  public updateIssueCalls: Array<{ issueKey: string; fields: Record<string, unknown> }> = [];
  public addCommentCalls: Array<{ issueKey: string; body: string }> = [];
  public executeTransitionCalls: Array<{ issueKey: string; transitionId: string; fields?: Record<string, unknown> }> = [];
  public createIssueCalls: Array<{ projectKey: string; summary: string; issueType: string; additionalFields?: Record<string, unknown> }> = [];

  async getIssue(issueKey: string): Promise<JiraIssue> {
    if (issueKey === 'PROJ-404') {
      throw new Error('Not found: /issue/PROJ-404');
    }
    return loadFixture<JiraIssue>('ticket-PROJ-123.json');
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    this.updateIssueCalls.push({ issueKey, fields });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    this.addCommentCalls.push({ issueKey, body });
  }

  async searchJql(_jql: string, _maxResults?: number, _startAt?: number): Promise<JiraSearchResult> {
    return loadFixture<JiraSearchResult>('search-results.json');
  }

  async getCurrentUser(): Promise<JiraUser> {
    return loadFixture<JiraUser>('myself.json');
  }

  async findUser(query: string): Promise<JiraUser[]> {
    if (query.toLowerCase().includes('jane')) {
      return [{ accountId: 'abc123', displayName: 'Jane Doe', emailAddress: 'jane.doe@example.com' }];
    }
    return [];
  }

  async getTransitions(_issueKey: string): Promise<JiraTransition[]> {
    const fixture = loadFixture<{ transitions: JiraTransition[] }>('transitions-PROJ-123.json');
    return fixture.transitions;
  }

  async executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    this.executeTransitionCalls.push({ issueKey, transitionId, fields });
  }

  async getResolutions(): Promise<Array<{ name: string }>> {
    return loadFixture<Array<{ name: string }>>('resolutions.json');
  }

  async getProject(_projectKey: string): Promise<JiraProject> {
    return loadFixture<JiraProject>('project-PROJ.json');
  }

  async getProjectStatuses(_projectKey: string, issueType: string): Promise<string[]> {
    const data = loadFixture<JiraProjectStatus[]>('project-statuses-PROJ.json');
    const match = data.find((t) => t.name.toLowerCase() === issueType.toLowerCase());
    return match ? match.statuses.map((s) => s.name) : [];
  }

  async getSprintByName(_projectKey: string, sprintName: string): Promise<{ id: number }> {
    if (sprintName === 'Sprint 5') return loadFixture<{ id: number }>('sprint-PROJ.json');
    throw new Error(`Sprint '${sprintName}' not found in project PROJ.`);
  }

  async getTeamByName(name: string): Promise<{ id: string }> {
    if (name.toLowerCase().includes('backend')) return loadFixture<{ id: string }>('team-backend.json');
    throw new Error(`Could not resolve team '${name}' — use id instead`);
  }

  async createIssue(_projectKey: string, _summary: string, _issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue> {
    this.createIssueCalls.push({ projectKey: _projectKey, summary: _summary, issueType: _issueType, additionalFields });
    return loadFixture<JiraCreatedIssue>('created-issue.json');
  }

  async getIssueComments(issueKey: string, maxResults: number, _startAt = 0): Promise<{ comments: JiraComment[]; total: number }> {
    const issue = await this.getIssue(issueKey);
    const all = issue.fields.comment?.comments ?? [];
    const total = issue.fields.comment?.total ?? all.length;
    return { comments: all.slice(0, maxResults), total };
  }

  async getAllComments(issueKey: string): Promise<JiraComment[]> {
    const issue = await this.getIssue(issueKey);
    return issue.fields.comment?.comments ?? [];
  }

  async downloadAttachment(_contentUrl: string): Promise<Uint8Array> {
    return FIXTURE_ATTACHMENT_BYTES;
  }

  async getFilterById(id: string): Promise<JiraFilter> {
    if (id === '99999') throw new Error(`Filter ${id} not found.`);
    return loadFixture<JiraFilter>('filter-12345.json');
  }

  async searchFiltersByName(name: string): Promise<JiraFilter[]> {
    if (name === 'nonexistent-xyzzy') return [];
    return loadFixture<JiraFilter[]>('filters-by-name.json');
  }

  async getFields(): Promise<JiraFieldMeta[]> {
    return loadFixture<JiraFieldMeta[]>('fields.json');
  }

  async getEditMeta(issueKey: string): Promise<Record<string, JiraEditMetaField>> {
    if (issueKey === 'PROJ-404') throw new Error('Not found');
    return loadFixture<Record<string, JiraEditMetaField>>('editmeta-PROJ-123.json');
  }

  async findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]> {
    const all = loadFixture<JiraSprintCandidate[]>('sprints-PROJ.json');
    const lowerQuery = query.toLowerCase();
    // Return only active and future sprints whose name contains the query
    return all.filter(
      s => (s.state === 'active' || s.state === 'future') && s.name.toLowerCase().includes(lowerQuery),
    );
  }
}
