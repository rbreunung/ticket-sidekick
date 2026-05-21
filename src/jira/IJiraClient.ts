export interface JiraSubtask {
  key: string;
  fields: { summary: string; status: { name: string } };
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: unknown;
  created: string;
}

export interface JiraUser {
  accountId?: string;  // Cloud only; absent on Data Center
  name?: string;       // Data Center username; absent on Cloud
  displayName: string;
  emailAddress?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown; // v3: Atlassian Document Format (ADF) object; v2: plain string
    status: { name: string };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    priority: { name: string } | null;
    labels: string[];
    fixVersions: { name: string }[];
    comment: { comments: JiraComment[]; total: number } | null;
    subtasks?: JiraSubtask[];
    [key: string]: unknown;
  };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total?: number;
  maxResults?: number;
  isLast?: boolean;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  issueTypes: JiraIssueType[];
}

export interface JiraCreatedIssue {
  id: string;
  key: string;
}

export interface JiraProjectStatus {
  name: string;
  subtask: boolean;
  statuses: Array<{ id: string; name: string }>;
}

export interface JiraFilter {
  id: string;
  name: string;
  jql: string;
}

export interface JiraFieldMeta {
  id: string;
  name: string;
  navigable?: boolean;
  schema: { type: string; items?: string; custom?: string };
}

export interface JiraSprintCandidate {
  id: number;
  name: string;
  state: string;
}

export interface JiraEditMetaField {
  schema: { type: string; items?: string };
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
}

export interface IJiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  searchJql(jql: string, maxResults?: number, startAt?: number): Promise<JiraSearchResult>;
  findUser(query: string): Promise<JiraUser[]>;
  getCurrentUser(): Promise<JiraUser>;
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void>;
  getResolutions(): Promise<Array<{ name: string }>>;
  getProject(projectKey: string): Promise<JiraProject>;
  getProjectStatuses(projectKey: string, issueType: string): Promise<string[]>;
  getSprintByName(projectKey: string, sprintName: string): Promise<{ id: number }>;
  getTeamByName(name: string): Promise<{ id: string }>;
  createIssue(projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue>;
  getIssueComments(issueKey: string, maxResults: number): Promise<{ comments: JiraComment[]; total: number }>;
  getFilterById(id: string): Promise<JiraFilter>;
  searchFiltersByName(name: string): Promise<JiraFilter[]>;
  getFields(): Promise<JiraFieldMeta[]>;
  getEditMeta(issueKey: string): Promise<Record<string, JiraEditMetaField>>;
  findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]>;
}
