# Ticket Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.jira-templates.json` support so teams can define per-application ticket templates with default fields, resolved custom fields (sprint, team, user), and guided multi-turn description collection via the `@jira` chat participant.

**Architecture:** `TemplateService` reads the template file; `FieldResolver` converts `resolveFields` entries to Jira API-ready values before ticket creation; `JiraParticipant` manages a multi-turn creation session by embedding a hidden state marker in each assistant response, which subsequent turns parse from `ChatContext`.

**Tech Stack:** TypeScript, VS Code Extension API ≥1.90, Jira REST API v3, Jira Agile REST API v1, Vitest

---

## File Map

| Action | File | What changes |
|---|---|---|
| Create | `src/templates/TemplateService.ts` | Types + `.jira-templates.json` loader |
| Create | `src/templates/FieldResolver.ts` | name→ID and id→object resolution |
| Create | `src/test/TemplateService.test.ts` | Unit tests for TemplateService |
| Create | `src/test/FieldResolver.test.ts` | Unit tests for FieldResolver |
| Create | `src/test/fixtures/templates-valid/.jira-templates.json` | Valid two-template fixture |
| Create | `src/test/fixtures/templates-broken/.jira-templates.json` | Malformed JSON fixture |
| Create | `src/test/fixtures/sprint-PROJ.json` | Sprint lookup fixture |
| Create | `src/test/fixtures/team-backend.json` | Team lookup fixture |
| Create | `.jira-templates.json` | Example file committed to repo root |
| Modify | `src/jira/IJiraClient.ts` | Add `getSprintByName`, `getTeamByName`; extend `createIssue` |
| Modify | `src/jira/JiraApiClient.ts` | Implement new methods + `agileRequest`/`teamsRequest` helpers |
| Modify | `src/test/mocks/MockJiraClient.ts` | Implement new methods, track `createIssueCalls` |
| Modify | `src/services/TicketService.ts` | Export `assembleDescription` + `wrapInAdf`; extend `createTicket` |
| Modify | `src/test/TicketService.test.ts` | Tests for `assembleDescription` + extended `createTicket` |
| Modify | `src/participant/JiraParticipant.ts` | `extractCreationSessionFromText`, `handleCreateTicket`, template quick pick |

---

## Task 1: TemplateService — types and file loading

**Files:**
- Create: `src/templates/TemplateService.ts`
- Create: `src/test/TemplateService.test.ts`
- Create: `src/test/fixtures/templates-valid/.jira-templates.json`
- Create: `src/test/fixtures/templates-broken/.jira-templates.json`

- [ ] **Step 1: Create the valid template fixture**

`src/test/fixtures/templates-valid/.jira-templates.json`:
```json
{
  "templates": [
    {
      "name": "Billing App Bug",
      "defaultFields": { "priority": "High", "labels": ["billing"] },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "name": "Sprint 5" },
        "customfield_10200": { "type": "team", "name": "Backend Team" }
      },
      "descriptionSections": ["Steps to reproduce", "Expected behavior", "Actual behavior", "Environment"]
    },
    {
      "name": "Frontend Story",
      "defaultFields": { "priority": "Medium", "labels": ["frontend"] },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "id": 42 },
        "customfield_10200": [{ "type": "team", "id": "abc-team-id" }]
      },
      "descriptionSections": ["User story", "Acceptance criteria", "Design link"]
    }
  ]
}
```

- [ ] **Step 2: Create the broken template fixture**

`src/test/fixtures/templates-broken/.jira-templates.json`:
```
{ invalid json
```

- [ ] **Step 3: Write the failing tests**

`src/test/TemplateService.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { TemplateService } from '../templates/TemplateService';

const VALID_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-valid');
const BROKEN_ROOT = resolve(process.cwd(), 'src/test/fixtures/templates-broken');

describe('TemplateService', () => {
  it('returns both templates from a valid file', () => {
    const service = new TemplateService(VALID_ROOT);
    const templates = service.loadTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('Billing App Bug');
    expect(templates[1].name).toBe('Frontend Story');
  });

  it('returns defaultFields from template', () => {
    const templates = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].defaultFields).toEqual({ priority: 'High', labels: ['billing'] });
  });

  it('returns descriptionSections from template', () => {
    const templates = new TemplateService(VALID_ROOT).loadTemplates();
    expect(templates[0].descriptionSections).toEqual([
      'Steps to reproduce', 'Expected behavior', 'Actual behavior', 'Environment',
    ]);
  });

  it('returns empty array when file is absent', () => {
    const service = new TemplateService('/nonexistent/path');
    expect(service.loadTemplates()).toEqual([]);
  });

  it('throws with clear message for invalid JSON', () => {
    const service = new TemplateService(BROKEN_ROOT);
    expect(() => service.loadTemplates()).toThrow('Could not parse .jira-templates.json');
  });
});
```

- [ ] **Step 4: Run tests to confirm they fail**

```
npm test -- --reporter=verbose 2>&1 | grep -A3 "TemplateService"
```
Expected: FAIL — `Cannot find module '../templates/TemplateService'`

- [ ] **Step 5: Implement TemplateService**

`src/templates/TemplateService.ts`:
```typescript
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ResolveSpec {
  type: 'sprint' | 'team' | 'user';
  name?: string;
  id?: string | number;
}

export interface JiraTemplate {
  name: string;
  defaultFields: Record<string, unknown>;
  resolveFields: Record<string, ResolveSpec | ResolveSpec[]>;
  descriptionSections: string[];
}

export class TemplateService {
  constructor(private readonly workspaceRoot: string) {}

  loadTemplates(): JiraTemplate[] {
    const filePath = join(this.workspaceRoot, '.jira-templates.json');
    if (!existsSync(filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Could not read .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: { templates: JiraTemplate[] };
    try {
      parsed = JSON.parse(raw) as { templates: JiraTemplate[] };
    } catch (err) {
      throw new Error(`Could not parse .jira-templates.json: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed.templates ?? [];
  }
}
```

- [ ] **Step 6: Run tests — all TemplateService tests must pass**

```
npm test
```
Expected: all tests pass (existing 37 + 5 new = 42)

- [ ] **Step 7: Commit**

```
git add src/templates/TemplateService.ts src/test/TemplateService.test.ts src/test/fixtures/templates-valid src/test/fixtures/templates-broken
git commit -m "feat: TemplateService reads .jira-templates.json"
```

---

## Task 2: Extend IJiraClient and MockJiraClient

**Files:**
- Modify: `src/jira/IJiraClient.ts`
- Modify: `src/test/mocks/MockJiraClient.ts`
- Create: `src/test/fixtures/sprint-PROJ.json`
- Create: `src/test/fixtures/team-backend.json`

- [ ] **Step 1: Create fixtures**

`src/test/fixtures/sprint-PROJ.json`:
```json
{ "id": 42 }
```

`src/test/fixtures/team-backend.json`:
```json
{ "id": "backend-team-id" }
```

- [ ] **Step 2: Extend IJiraClient interface**

In `src/jira/IJiraClient.ts`, replace the `createIssue` line and add two new methods:
```typescript
export interface IJiraClient {
  getIssue(issueKey: string): Promise<JiraIssue>;
  updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
  addComment(issueKey: string, body: string): Promise<void>;
  searchJql(jql: string, maxResults?: number): Promise<JiraSearchResult>;
  findUser(query: string): Promise<JiraUser[]>;
  getCurrentUser(): Promise<JiraUser>;
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  executeTransition(issueKey: string, transitionId: string): Promise<void>;
  getProject(projectKey: string): Promise<JiraProject>;
  getSprintByName(projectKey: string, sprintName: string): Promise<{ id: number }>;
  getTeamByName(name: string): Promise<{ id: string }>;
  createIssue(projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue>;
}
```

- [ ] **Step 3: Update MockJiraClient to implement the new interface**

Replace the entire `src/test/mocks/MockJiraClient.ts`:
```typescript
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  IJiraClient,
  JiraCreatedIssue,
  JiraIssue,
  JiraProject,
  JiraSearchResult,
  JiraTransition,
  JiraUser,
} from '../../jira/IJiraClient';

function loadFixture<T>(filename: string): T {
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockJiraClient implements IJiraClient {
  public updateIssueCalls: Array<{ issueKey: string; fields: Record<string, unknown> }> = [];
  public addCommentCalls: Array<{ issueKey: string; body: string }> = [];
  public executeTransitionCalls: Array<{ issueKey: string; transitionId: string }> = [];
  public createIssueCalls: Array<{ projectKey: string; summary: string; issueType: string; additionalFields?: Record<string, unknown> }> = [];

  async getIssue(issueKey: string): Promise<JiraIssue> {
    if (issueKey === 'PROJ-404') throw new Error('Not found: /issue/PROJ-404');
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

  async executeTransition(issueKey: string, transitionId: string): Promise<void> {
    this.executeTransitionCalls.push({ issueKey, transitionId });
  }

  async getProject(_projectKey: string): Promise<JiraProject> {
    return loadFixture<JiraProject>('project-PROJ.json');
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
}
```

- [ ] **Step 4: Verify TypeScript compiles with no errors**

```
npm run compile
```
Expected: exits 0 with no errors

- [ ] **Step 5: Run tests — all existing tests still pass**

```
npm test
```
Expected: 42 tests pass

- [ ] **Step 6: Commit**

```
git add src/jira/IJiraClient.ts src/test/mocks/MockJiraClient.ts src/test/fixtures/sprint-PROJ.json src/test/fixtures/team-backend.json
git commit -m "feat: extend IJiraClient with getSprintByName, getTeamByName, additionalFields"
```

---

## Task 3: JiraApiClient — implement new methods

**Files:**
- Modify: `src/jira/JiraApiClient.ts`

No new unit tests — `JiraApiClient` makes real HTTP calls and is verified by the TypeScript compiler and e2e tests.

- [ ] **Step 1: Store authType and add agileRequest + teamsRequest helpers**

In `src/jira/JiraApiClient.ts`, replace the class definition with:
```typescript
import type {
  IJiraClient,
  JiraCreatedIssue,
  JiraIssue,
  JiraProject,
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
  private readonly authType: AuthType;

  constructor(config: JiraApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
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
      if (response.status === 401) throw new Error('Authentication failed. Check your credentials.');
      if (response.status === 404) throw new Error(`Not found: ${path}`);
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
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
    if (!response.ok) throw new Error(`Jira Agile API error: ${response.status} ${response.statusText}`);
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
    if (!response.ok) throw new Error(`Jira Teams API error: ${response.status} ${response.statusText}`);
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
          content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
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
        fields: ['summary', 'status', 'assignee', 'priority', 'description', 'labels', 'fixVersions', 'reporter'],
      }),
    });
  }

  async findUser(query: string): Promise<JiraUser[]> {
    return this.request<JiraUser[]>(`/user/search?query=${encodeURIComponent(query)}`);
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request<{ transitions: JiraTransition[] }>(`/issue/${issueKey}/transitions`);
    return result.transitions;
  }

  async executeTransition(issueKey: string, transitionId: string): Promise<void> {
    await this.request<void>(`/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```
npm run compile
```
Expected: exits 0 with no errors

- [ ] **Step 3: Run tests — all pass**

```
npm test
```
Expected: 42 tests pass

- [ ] **Step 4: Commit**

```
git add src/jira/JiraApiClient.ts
git commit -m "feat: JiraApiClient getSprintByName, getTeamByName, createIssue additionalFields"
```

---

## Task 4: FieldResolver — resolve specs to Jira field values

**Files:**
- Create: `src/templates/FieldResolver.ts`
- Create: `src/test/FieldResolver.test.ts`

- [ ] **Step 1: Write failing tests**

`src/test/FieldResolver.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { FieldResolver } from '../templates/FieldResolver';
import { MockJiraClient } from './mocks/MockJiraClient';

describe('FieldResolver', () => {
  let client: MockJiraClient;
  let resolver: FieldResolver;

  beforeEach(() => {
    client = new MockJiraClient();
    resolver = new FieldResolver(client, 'PROJ');
  });

  it('passes defaultFields through unchanged', async () => {
    const result = await resolver.resolve({ priority: 'High', labels: ['billing'] }, {});
    expect(result).toEqual({ priority: 'High', labels: ['billing'] });
  });

  it('resolves sprint id directly without API call', async () => {
    const result = await resolver.resolve({}, { customfield_10020: { type: 'sprint', id: 42 } });
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('resolves sprint by name via API', async () => {
    const result = await resolver.resolve({}, { customfield_10020: { type: 'sprint', name: 'Sprint 5' } });
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('resolves team id directly without API call', async () => {
    const result = await resolver.resolve({}, { customfield_10200: { type: 'team', id: 'abc-team-id' } });
    expect(result.customfield_10200).toEqual({ id: 'abc-team-id' });
  });

  it('resolves team by name via API', async () => {
    const result = await resolver.resolve({}, { customfield_10200: { type: 'team', name: 'Backend Team' } });
    expect(result.customfield_10200).toEqual({ id: 'backend-team-id' });
  });

  it('resolves user by name via findUser', async () => {
    const result = await resolver.resolve({}, { customfield_10300: { type: 'user', name: 'jane' } });
    expect(result.customfield_10300).toEqual({ accountId: 'abc123' });
  });

  it('resolves array of specs into an array of values', async () => {
    const result = await resolver.resolve({}, {
      customfield_10200: [{ type: 'team', id: 'team-1' }, { type: 'team', id: 'team-2' }],
    });
    expect(result.customfield_10200).toEqual([{ id: 'team-1' }, { id: 'team-2' }]);
  });

  it('id takes precedence over name when both provided', async () => {
    const result = await resolver.resolve({}, {
      customfield_10020: { type: 'sprint', id: 99, name: 'Sprint 5' },
    });
    expect(result.customfield_10020).toEqual({ id: 99 });
  });

  it('merges defaultFields and resolveFields in result', async () => {
    const result = await resolver.resolve(
      { priority: 'High' },
      { customfield_10020: { type: 'sprint', id: 42 } },
    );
    expect(result.priority).toBe('High');
    expect(result.customfield_10020).toEqual({ id: 42 });
  });

  it('throws for unknown resolve type', async () => {
    await expect(
      resolver.resolve({}, { customfield_10999: { type: 'unknown' as 'sprint', name: 'x' } }),
    ).rejects.toThrow('Unknown resolve type');
  });

  it('throws when user not found', async () => {
    await expect(
      resolver.resolve({}, { customfield_10300: { type: 'user', name: 'nobody' } }),
    ).rejects.toThrow('No user found');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test
```
Expected: FAIL — `Cannot find module '../templates/FieldResolver'`

- [ ] **Step 3: Implement FieldResolver**

`src/templates/FieldResolver.ts`:
```typescript
import type { IJiraClient } from '../jira/IJiraClient';
import type { ResolveSpec } from './TemplateService';

export class FieldResolver {
  constructor(
    private readonly client: IJiraClient,
    private readonly projectKey: string,
  ) {}

  async resolve(
    defaultFields: Record<string, unknown>,
    resolveFields: Record<string, ResolveSpec | ResolveSpec[]>,
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = { ...defaultFields };
    for (const [fieldId, spec] of Object.entries(resolveFields)) {
      if (Array.isArray(spec)) {
        result[fieldId] = await Promise.all(spec.map((s) => this.resolveOne(s)));
      } else {
        result[fieldId] = await this.resolveOne(spec);
      }
    }
    return result;
  }

  private async resolveOne(spec: ResolveSpec): Promise<unknown> {
    if (spec.id !== undefined) return { id: spec.id };
    if (!spec.name) throw new Error(`ResolveSpec must have either 'name' or 'id'`);
    switch (spec.type) {
      case 'sprint':
        return this.client.getSprintByName(this.projectKey, spec.name);
      case 'team':
        return this.client.getTeamByName(spec.name);
      case 'user': {
        const users = await this.client.findUser(spec.name);
        if (users.length === 0) throw new Error(`No user found matching "${spec.name}"`);
        return { accountId: users[0].accountId };
      }
      default:
        throw new Error(`Unknown resolve type: ${String((spec as ResolveSpec).type)}`);
    }
  }
}
```

- [ ] **Step 4: Run tests — all pass**

```
npm test
```
Expected: 42 + 11 = 53 tests pass

- [ ] **Step 5: Commit**

```
git add src/templates/FieldResolver.ts src/test/FieldResolver.test.ts
git commit -m "feat: FieldResolver resolves sprint/team/user specs to Jira field values"
```

---

## Task 5: TicketService — assembleDescription and createTicket with additionalFields

**Files:**
- Modify: `src/services/TicketService.ts`
- Modify: `src/test/TicketService.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/test/TicketService.test.ts` (inside the outer `describe('TicketService', ...)` block, after the existing `createTicket` describe):

```typescript
  describe('assembleDescription', () => {
    it('formats sections in template order regardless of collection order', () => {
      const result = assembleDescription(
        ['Steps to reproduce', 'Expected behavior', 'Actual behavior'],
        {
          'Actual behavior': 'Got 404',
          'Steps to reproduce': 'Click login',
          'Expected behavior': 'Go to dashboard',
        },
      );
      expect(result).toBe(
        '**Steps to reproduce**\nClick login\n\n**Expected behavior**\nGo to dashboard\n\n**Actual behavior**\nGot 404',
      );
    });

    it('skips sections not yet present in answers', () => {
      const result = assembleDescription(
        ['Steps to reproduce', 'Expected behavior'],
        { 'Steps to reproduce': 'Click login' },
      );
      expect(result).toBe('**Steps to reproduce**\nClick login');
    });
  });

  describe('createTicket with additionalFields', () => {
    it('passes additionalFields to createIssue', async () => {
      await service.createTicket('PROJ', 'Login bug', 'Bug', { priority: 'High' });
      expect(client.createIssueCalls[0].additionalFields).toEqual({ priority: 'High' });
    });

    it('works without additionalFields', async () => {
      await service.createTicket('PROJ', 'Login bug', 'Bug');
      expect(client.createIssueCalls[0].additionalFields).toBeUndefined();
    });
  });
```

Also add the import at the top of the test file:
```typescript
import { TicketService, assembleDescription } from '../services/TicketService';
```
(replace the existing `import { TicketService }` line)

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test
```
Expected: FAIL — `assembleDescription is not exported` and `createIssueCalls` related failures

- [ ] **Step 3: Update TicketService**

In `src/services/TicketService.ts`:

Export `wrapInAdf` (change `function` to `export function`):
```typescript
export function wrapInAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}
```

Add `assembleDescription` as a new exported function after `wrapInAdf`:
```typescript
export function assembleDescription(sections: string[], answers: Record<string, string>): string {
  return sections
    .filter((s) => s in answers)
    .map((s) => `**${s}**\n${answers[s]}`)
    .join('\n\n');
}
```

Update `createTicket` signature and body:
```typescript
async createTicket(
  projectKey: string,
  summary: string,
  issueType: string,
  additionalFields?: Record<string, unknown>,
): Promise<string> {
  const created = await this.client.createIssue(projectKey, summary, issueType, additionalFields);
  return `Created ${created.key}: **${summary}** (${issueType} in ${projectKey})`;
}
```

- [ ] **Step 4: Run tests — all pass**

```
npm test
```
Expected: 53 + 4 = 57 tests pass

- [ ] **Step 5: Commit**

```
git add src/services/TicketService.ts src/test/TicketService.test.ts
git commit -m "feat: export assembleDescription and wrapInAdf; createTicket accepts additionalFields"
```

---

## Task 6: JiraParticipant — session state extraction (unit-testable)

**Files:**
- Modify: `src/participant/JiraParticipant.ts`
- Modify: `src/test/TicketService.test.ts` (add `extractCreationSessionFromText` tests — no VS Code dependency)

The state marker is a hidden HTML comment embedded at the end of each assistant response during a multi-turn creation. This task extracts and exports the pure parsing function so it can be tested in Vitest without the VS Code process.

- [ ] **Step 1: Write failing tests**

Create `src/test/JiraParticipant.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { extractCreationSessionFromText } from '../participant/JiraParticipant';

describe('extractCreationSessionFromText', () => {
  const validSession = {
    template: 'Billing App Bug',
    project: 'BILLING',
    summary: 'Login bug',
    issueType: 'Bug',
    allSections: ['Steps to reproduce', 'Expected behavior'],
    pending: ['Expected behavior'],
    answers: { 'Steps to reproduce': 'Click login' },
    fields: { priority: 'High' },
  };

  it('extracts session from a response containing the marker', () => {
    const text = `Got it.\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->`;
    const result = extractCreationSessionFromText(text);
    expect(result?.template).toBe('Billing App Bug');
    expect(result?.pending).toEqual(['Expected behavior']);
    expect(result?.answers['Steps to reproduce']).toBe('Click login');
  });

  it('returns null when no marker is present', () => {
    expect(extractCreationSessionFromText('some response with no marker')).toBeNull();
  });

  it('returns null for a marker with malformed JSON', () => {
    expect(extractCreationSessionFromText('<!-- @jira-create:invalid json -->')).toBeNull();
  });

  it('extracts session from text with content before and after marker', () => {
    const text = `**Steps to reproduce** — describe steps\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->\n\nExtra text`;
    const result = extractCreationSessionFromText(text);
    expect(result?.project).toBe('BILLING');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test
```
Expected: FAIL — `extractCreationSessionFromText is not exported`

- [ ] **Step 3: Add CreationSession interface and extractCreationSessionFromText to JiraParticipant**

Add to `src/participant/JiraParticipant.ts` after the existing imports (before `type Operation`):

```typescript
export interface CreationSession {
  template: string;
  project: string;
  summary: string;
  issueType: string;
  allSections: string[];
  pending: string[];
  answers: Record<string, string>;
  fields: Record<string, unknown>;
}

export function extractCreationSessionFromText(text: string): CreationSession | null {
  const match = text.match(/<!--\s*@jira-create:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as CreationSession;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests — all pass**

```
npm test
```
Expected: 57 + 4 = 61 tests pass

- [ ] **Step 5: Commit**

```
git add src/participant/JiraParticipant.ts src/test/JiraParticipant.test.ts
git commit -m "feat: CreationSession type and extractCreationSessionFromText"
```

---

## Task 7: JiraParticipant — full multi-turn creation flow

**Files:**
- Modify: `src/participant/JiraParticipant.ts`
- Create: `.jira-templates.json` (example file at repo root)

This task wires everything together: template quick pick, section coverage check, multi-turn collection, and ticket creation with resolved fields.

- [ ] **Step 1: Add new imports to JiraParticipant.ts**

Replace the existing import block at the top of `src/participant/JiraParticipant.ts`:
```typescript
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import type { JiraConfig } from '../services/ConfigService';
import { TicketService, assembleDescription, wrapInAdf } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import { extractTicketId } from '../utils/branchParser';
```

- [ ] **Step 2: Add parseCreationSession (uses VS Code ChatContext)**

Add after `extractCreationSessionFromText` in `src/participant/JiraParticipant.ts`:
```typescript
function parseCreationSession(context: vscode.ChatContext): CreationSession | null {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      const result = extractCreationSessionFromText(text);
      if (result) return result;
    }
  }
  return null;
}
```

- [ ] **Step 3: Add checkSectionCoverage LM helper**

Add after `generateContent` in `src/participant/JiraParticipant.ts`:
```typescript
async function checkSectionCoverage(
  prompt: string,
  sections: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string[]> {
  const message = vscode.LanguageModelChatMessage.User(
    `Does this text address any of these sections? Reply with ONLY a JSON array of section names that are clearly covered.\nSections: ${JSON.stringify(sections)}\nText: ${JSON.stringify(prompt)}`,
  );
  const response = await model.sendRequest([message], {}, token);
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Add streamNextSection and finishTicketCreation helpers**

Add after `checkSectionCoverage`:
```typescript
function streamNextSection(session: CreationSession, stream: vscode.ChatResponseStream): void {
  const next = session.pending[0];
  const isLast = session.pending.length === 1;
  stream.markdown(isLast ? `Last one:\n\n**${next}** — ` : `**${next}** — `);
  stream.markdown(`\n\n<!-- @jira-create:${JSON.stringify(session)} -->`);
}

async function finishTicketCreation(
  session: CreationSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  const descriptionText = assembleDescription(session.allSections, session.answers);
  const additionalFields: Record<string, unknown> = {
    ...session.fields,
    description: wrapInAdf(descriptionText),
  };
  const result = await ticketService.createTicket(
    session.project,
    session.summary,
    session.issueType,
    additionalFields,
  );
  stream.markdown(result);
}
```

- [ ] **Step 5: Add handleCreateTicket**

Add after `finishTicketCreation`:
```typescript
async function handleCreateTicket(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  config: JiraConfig,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
): Promise<void> {
  // --- Continuing an in-progress session ---
  const session = parseCreationSession(context);
  if (session) {
    const justAnswered = session.pending[0];
    session.answers[justAnswered] = request.prompt;
    session.pending = session.pending.slice(1);
    if (session.pending.length === 0) {
      await finishTicketCreation(session, ticketService, stream);
    } else {
      streamNextSection(session, stream);
    }
    return;
  }

  // --- Fresh start: load templates ---
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let templates: JiraTemplate[] = [];
  if (workspaceRoot) {
    try {
      templates = new TemplateService(workspaceRoot).loadTemplates();
    } catch (err) {
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Template error: ${err instanceof Error ? err.message : String(err)}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return; }
    }
  }

  let selectedTemplate: JiraTemplate | null = null;
  if (templates.length > 0) {
    const items = [...templates.map((t) => t.name), 'Proceed without template'];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select a ticket template',
      ignoreFocusOut: true,
    });
    if (!picked) { stream.markdown('Cancelled.'); return; }
    if (picked !== 'Proceed without template') {
      selectedTemplate = templates.find((t) => t.name === picked) ?? null;
    }
  }

  // Resolve project, summary, issueType
  const intent = await parseIntent(request.prompt, request.model, token);
  const projectKey = await resolveProjectKey(intent.projectKey, stream);
  if (!projectKey) { stream.markdown('No project key provided — cancelled.'); return; }

  let summary = intent.summary;
  if (!summary) {
    summary = await vscode.window.showInputBox({ prompt: 'Enter a summary for the new ticket', ignoreFocusOut: true }) ?? null;
  }
  if (!summary) { stream.markdown('No summary provided — cancelled.'); return; }

  const issueType = await resolveIssueType(intent.issueType, projectKey, ticketService, stream);
  if (!issueType) { stream.markdown('No issue type selected — cancelled.'); return; }

  // Resolve template fields
  let resolvedFields: Record<string, unknown> = {};
  if (selectedTemplate) {
    const resolver = new FieldResolver(jiraClient, projectKey);
    try {
      resolvedFields = await resolver.resolve(selectedTemplate.defaultFields, selectedTemplate.resolveFields);
    } catch (err) {
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Field resolution error: ${err instanceof Error ? err.message : String(err)}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return; }
      resolvedFields = {};
      selectedTemplate = null;
    }
  }

  // Check which description sections the user's prompt already covers
  if (selectedTemplate && selectedTemplate.descriptionSections.length > 0) {
    const covered = await checkSectionCoverage(
      request.prompt,
      selectedTemplate.descriptionSections,
      request.model,
      token,
    );
    const answers: Record<string, string> = {};
    for (const s of covered) answers[s] = request.prompt;
    const pending = selectedTemplate.descriptionSections.filter((s) => !covered.includes(s));

    if (pending.length === 0) {
      const descriptionText = assembleDescription(selectedTemplate.descriptionSections, answers);
      resolvedFields.description = wrapInAdf(descriptionText);
      const result = await ticketService.createTicket(projectKey, summary, issueType, resolvedFields);
      stream.markdown(result);
    } else {
      const fieldNames = Object.keys(resolvedFields).join(', ');
      stream.markdown(`_Using template **${selectedTemplate.name}**${fieldNames ? ` — defaults: ${fieldNames}` : ''}._\n\n`);
      if (covered.length > 0) {
        stream.markdown(`_Your description already covers **${covered.join(', ')}**._\n\n`);
      }
      const newSession: CreationSession = {
        template: selectedTemplate.name,
        project: projectKey,
        summary,
        issueType,
        allSections: selectedTemplate.descriptionSections,
        pending,
        answers,
        fields: resolvedFields,
      };
      streamNextSection(newSession, stream);
    }
  } else {
    // No template or no sections — create directly
    const result = await ticketService.createTicket(
      projectKey,
      summary,
      issueType,
      Object.keys(resolvedFields).length > 0 ? resolvedFields : undefined,
    );
    stream.markdown(result);
  }
}
```

- [ ] **Step 6: Replace the createTicket case in the handler switch with handleCreateTicket**

In `createParticipant`, update the handler. First, pass `jiraClient` to `handleCreateTicket` — it's already available in scope. Replace the existing `if (intent.operation === 'createTicket')` block:

```typescript
    if (intent.operation === 'createTicket') {
      try {
        await handleCreateTicket(request, _chatContext, stream, token, config, jiraClient, ticketService);
      } catch (err) {
        stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
```

The existing handler parameter is named `_chatContext` (unused). Rename it to `chatContext` so it can be passed to `handleCreateTicket`. Change:

```typescript
// before
_chatContext: vscode.ChatContext,

// after
chatContext: vscode.ChatContext,
```

Then pass `chatContext` as the second argument to `handleCreateTicket`.

- [ ] **Step 7: Verify TypeScript compiles**

```
npm run compile
```
Expected: exits 0 with no errors

- [ ] **Step 8: Run tests — all pass**

```
npm test
```
Expected: 61 tests pass

- [ ] **Step 9: Create the example .jira-templates.json at repo root**

`.jira-templates.json`:
```json
{
  "templates": [
    {
      "name": "Billing App Bug",
      "defaultFields": {
        "priority": "High",
        "labels": ["billing"]
      },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "name": "Sprint 5" },
        "customfield_10200": { "type": "team", "name": "Backend Team" }
      },
      "descriptionSections": [
        "Steps to reproduce",
        "Expected behavior",
        "Actual behavior",
        "Environment"
      ]
    },
    {
      "name": "Frontend Story",
      "defaultFields": {
        "priority": "Medium",
        "labels": ["frontend"]
      },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "id": 42 },
        "customfield_10200": [{ "type": "team", "id": "abc-team-id" }]
      },
      "descriptionSections": [
        "User story",
        "Acceptance criteria",
        "Design link"
      ]
    }
  ]
}
```

- [ ] **Step 10: Commit**

```
git add src/participant/JiraParticipant.ts .jira-templates.json
git commit -m "feat: multi-turn template-driven ticket creation with field resolution"
```

---

## Verification

After all tasks, reload the extension development host (`F5` → new VS Code window) and test:

1. `@jira create a bug — login button causes 404` → quick pick appears with template names + "Proceed without template"
2. Select "Billing App Bug" → extension asks first missing section
3. Answer each section → ticket created with template fields applied
4. `@jira create a ticket` → "Proceed without template" → existing flow unchanged
5. Break `.jira-templates.json` (invalid JSON) → error message + "Proceed without template / Cancel" quick pick
