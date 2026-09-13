export interface JiraSubtask {
  key: string;
  fields: { summary: string; status: { name: string } };
}

export interface JiraIssueLink {
  id: string;
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
  outwardIssue?: { key: string; fields: { summary: string; status: { name: string } } };
}

export interface JiraRemoteLink {
  id: number;
  object: { url: string; title: string };
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

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;     // bytes
  content: string;  // full URL for authenticated download; matches Jira API v2 field name
  created: string;  // ISO 8601; used to resolve same-filename duplicates (KTD5/KTD7)
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown; // v3: Atlassian Document Format (ADF) object; v2: plain string
    status: { name: string };
    // U5: requested unconditionally by `searchJql`'s `baseFields` so a search-result session can
    // record each ticket's issue type without a second fetch (used for R8's sprint-refine-chip
    // eligibility check). Optional since older fixtures/tests predate this field.
    issuetype?: { name: string };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    priority: { name: string } | null;
    labels: string[];
    fixVersions: { name: string }[];
    comment: { comments: JiraComment[]; total: number } | null;
    subtasks?: JiraSubtask[];
    attachment?: JiraAttachment[];
    issuelinks?: JiraIssueLink[];
    resolution?: { name: string } | null;
    parent?: { key: string };
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
  // Populated only when `getTransitions` requests `?expand=transitions.fields` — absent (or with
  // no `resolution` key) means "not required", matching today's implicit pre-expansion behavior.
  fields?: { resolution?: { required: boolean; allowedValues: { name: string }[] } };
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraProjectVersion {
  id: string;
  name: string;
  released?: boolean;
  archived?: boolean;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  issueTypes: JiraIssueType[];
  // U4: the real `GET /project/{key}` v2 response already includes this array; only the type was
  // missing. Optional since MockJiraClient's fixture-backed callers never set it, and older
  // fixtures/tests are unaffected.
  versions?: JiraProjectVersion[];
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

/** Which of the two `getMyFilters()` sources failed to fetch — used to tell the caller which
 * half of the combined list (if any) is missing rather than silently returning a partial list. */
export type JiraFilterSource = 'favourites' | 'owned';

export interface JiraMyFiltersResult {
  filters: JiraFilter[];
  failedSources: JiraFilterSource[];
}

export interface JiraEditMetaField {
  schema: { type: string; items?: string };
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
}

export interface IJiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  searchJql(jql: string, maxResults?: number, startAt?: number, extraFields?: string[]): Promise<JiraSearchResult>;
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
  getIssueComments(issueKey: string, maxResults: number, startAt?: number): Promise<{ comments: JiraComment[]; total: number }>;
  getAllComments(issueKey: string): Promise<JiraComment[]>;
  downloadAttachment(content: string): Promise<Uint8Array>;
  getFilterById(id: string): Promise<JiraFilter>;
  searchFiltersByName(name: string): Promise<JiraFilter[]>;
  getFields(): Promise<JiraFieldMeta[]>;
  getEditMeta(issueKey: string): Promise<Record<string, JiraEditMetaField>>;
  getRequiredFields(projectKey: string, issueType: string, issueTypeId?: string): Promise<JiraFieldMeta[]>;
  findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]>;
  uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void>;
  getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]>;
  /** Favourite filters plus filters owned by the current user, deduped by `id`. Each source is
   * fetched independently — one failing does not suppress the other's result; `failedSources`
   * names which source(s) failed (empty when both succeed). */
  getMyFilters(): Promise<JiraMyFiltersResult>;
  /** The single active sprint on a Scrum board, or `null` when there are zero or more than one
   * (never guesses which one). Tolerates a non-Scrum board by returning `null`. */
  getActiveSprintForBoard(boardId: number): Promise<{ id: number; name: string } | null>;
}
