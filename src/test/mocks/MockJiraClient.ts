import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  IJiraClient,
  JiraIssue,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
} from '../../jira/IJiraClient';

function loadFixture<T>(filename: string): T {
  // process.cwd() is the project root when running `npm test`
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockJiraClient implements IJiraClient {
  public updateIssueCalls: Array<{ issueKey: string; fields: Record<string, unknown> }> = [];
  public addCommentCalls: Array<{ issueKey: string; body: string }> = [];
  public executeTransitionCalls: Array<{ issueKey: string; transitionId: string }> = [];

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

  async searchJql(_jql: string, _maxResults?: number): Promise<JiraSearchResult> {
    return loadFixture<JiraSearchResult>('search-results.json');
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

  async executeTransition(issueKey: string, transitionId: string): Promise<void> {
    this.executeTransitionCalls.push({ issueKey, transitionId });
  }
}
