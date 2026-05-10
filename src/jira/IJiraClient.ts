export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown; // Jira v3 uses Atlassian Document Format (ADF)
    status: { name: string };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    priority: { name: string } | null;
    labels: string[];
    fixVersions: { name: string }[];
    [key: string]: unknown;
  };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

export interface IJiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  searchJql(jql: string, maxResults?: number): Promise<JiraSearchResult>;
  findUser(query: string): Promise<JiraUser[]>;
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  executeTransition(issueKey: string, transitionId: string): Promise<void>;
}
