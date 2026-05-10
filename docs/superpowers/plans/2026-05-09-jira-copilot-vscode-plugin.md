# Jira Copilot VS Code Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code extension that registers a `@jira` GitHub Copilot Chat participant for reading, editing, and commenting on Jira tickets (Data Center and Cloud) without leaving the editor.

**Architecture:** Three layers injected at startup — `JiraParticipant` handles chat; `TicketService` contains all business logic; `JiraApiClient` handles HTTP. `IJiraClient` is the interface between service and client, making all business logic unit-testable without a real Jira instance.

**Tech Stack:** TypeScript 5 (strict), Node 20, VS Code Extension API ≥1.90, Vitest (unit tests), @vscode/test-electron (participant integration tests), no runtime dependencies beyond Node built-ins.

---

## File Map

```text
package.json                          extension manifest + scripts
tsconfig.json                         strict TS, CommonJS output for extension host
vitest.config.ts                      Vitest config for unit tests
.gitignore
.vscodeignore
CLAUDE.md                             AI agent context document
README.md                             user-facing setup + usage guide
src/
  extension.ts                        activate(): wires all layers, registers participant + commands
  jira/
    IJiraClient.ts                    interface + all shared types (JiraIssue, JiraUser, etc.)
    JiraApiClient.ts                  implements IJiraClient; real HTTP + auth header selection
  services/
    ConfigService.ts                  reads settings + SecretStorage; VS Code-dependent
    TicketService.ts                  all business logic; depends only on IJiraClient
  participant/
    JiraParticipant.ts                chat handler; uses VS Code LM API for intent parsing
  utils/
    branchParser.ts                   pure fn: extract ticket ID from git branch name
src/test/
  branchParser.test.ts
  JiraApiClient.test.ts
  TicketService.test.ts
  fixtures/
    ticket-PROJ-123.json              realistic Jira v3 GET /issue response
    ticket-not-found.json             Jira 404 error body shape
    search-results.json               Jira POST /issue/search response (2 issues)
    transitions-PROJ-123.json         Jira GET /issue/{id}/transitions response
  mocks/
    MockJiraClient.ts                 implements IJiraClient; returns fixtures
```

---

## Task 1: Project Scaffold

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/extension.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "jira-copilot",
  "displayName": "Jira Copilot",
  "description": "Manage Jira tickets with GitHub Copilot Chat",
  "version": "0.0.1",
  "publisher": "your-publisher-id",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["AI"],
  "activationEvents": [],
  "main": "./out/extension.js",
  "contributes": {
    "chatParticipants": [
      {
        "id": "jira-copilot.jira",
        "name": "jira",
        "fullName": "Jira Copilot",
        "description": "Manage Jira tickets with natural language",
        "isSticky": true
      }
    ],
    "commands": [
      {
        "command": "jira-copilot.setDataCenterToken",
        "title": "Jira Copilot: Set Personal Access Token"
      },
      {
        "command": "jira-copilot.configureCloud",
        "title": "Jira Copilot: Configure Cloud Credentials"
      }
    ],
    "configuration": {
      "title": "Jira Copilot",
      "properties": {
        "jiraCopilot.baseUrl": {
          "type": "string",
          "description": "Base URL of your Jira instance (e.g. https://jira.mycompany.com)"
        },
        "jiraCopilot.authType": {
          "type": "string",
          "enum": ["datacenter", "cloud"],
          "default": "datacenter",
          "description": "Authentication mode: 'datacenter' uses Bearer PAT, 'cloud' uses Basic email:apiToken"
        },
        "jiraCopilot.requiredFields": {
          "type": "array",
          "items": { "type": "string" },
          "default": [],
          "description": "Field names that must be set for ticket validation (e.g. [\"assignee\", \"priority\"])"
        }
      }
    }
  },
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "test": "vitest run",
    "test:e2e": "node ./out/test/runTest.js",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.90.0",
    "@vscode/test-electron": "^2.4.0",
    "@vscode/vsce": "^2.26.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "CommonJS",
    "target": "ES2022",
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  },
  "include": ["src"],
  "exclude": ["src/test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```text
node_modules/
out/
*.vsix
.env
.superpowers/
```

- [ ] **Step 5: Create `.vscodeignore`**

```text
src/
src/test/
node_modules/
.vscode-test/
**/*.ts
tsconfig.json
vitest.config.ts
.gitignore
```

- [ ] **Step 6: Create skeleton `src/extension.ts`**

```typescript
import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // Wired in Task 8
}

export function deactivate(): void {}
```

- [ ] **Step 7: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 8: Verify TypeScript compiles**

```bash
npm run compile
```

Expected: `out/extension.js` created, exit code 0.

- [ ] **Step 9: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore .vscodeignore src/extension.ts
git commit -m "feat: project scaffold"
```

---

## Task 2: IJiraClient Interface + Shared Types

**Files:**

- Create: `src/jira/IJiraClient.ts`

- [ ] **Step 1: Create `src/jira/IJiraClient.ts`**

```typescript
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
```

- [ ] **Step 2: Verify compile**

```bash
npm run compile
```

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/jira/IJiraClient.ts
git commit -m "feat: IJiraClient interface and shared Jira types"
```

---

## Task 3: Test Fixtures + MockJiraClient

**Files:**

- Create: `src/test/fixtures/ticket-PROJ-123.json`
- Create: `src/test/fixtures/ticket-not-found.json`
- Create: `src/test/fixtures/search-results.json`
- Create: `src/test/fixtures/transitions-PROJ-123.json`
- Create: `src/test/mocks/MockJiraClient.ts`

- [ ] **Step 1: Create `src/test/fixtures/ticket-PROJ-123.json`**

```json
{
  "id": "10001",
  "key": "PROJ-123",
  "fields": {
    "summary": "Implement user authentication",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "We need OAuth2 authentication for the mobile app." }]
        }
      ]
    },
    "status": { "name": "In Progress" },
    "assignee": {
      "accountId": "abc123",
      "displayName": "Jane Doe",
      "emailAddress": "jane.doe@example.com"
    },
    "reporter": {
      "accountId": "def456",
      "displayName": "John Smith",
      "emailAddress": "john.smith@example.com"
    },
    "priority": { "name": "High" },
    "labels": ["auth", "security"],
    "fixVersions": [{ "name": "v1.0" }]
  }
}
```

- [ ] **Step 2: Create `src/test/fixtures/ticket-not-found.json`**

```json
{
  "errorMessages": ["Issue does not exist or you do not have permission to see it."],
  "errors": {}
}
```

- [ ] **Step 3: Create `src/test/fixtures/search-results.json`**

```json
{
  "total": 2,
  "maxResults": 20,
  "issues": [
    {
      "id": "10001",
      "key": "PROJ-123",
      "fields": {
        "summary": "Implement user authentication",
        "description": null,
        "status": { "name": "In Progress" },
        "assignee": { "accountId": "abc123", "displayName": "Jane Doe" },
        "reporter": { "accountId": "def456", "displayName": "John Smith" },
        "priority": { "name": "High" },
        "labels": ["auth"],
        "fixVersions": []
      }
    },
    {
      "id": "10002",
      "key": "PROJ-124",
      "fields": {
        "summary": "Add password reset flow",
        "description": null,
        "status": { "name": "To Do" },
        "assignee": null,
        "reporter": { "accountId": "def456", "displayName": "John Smith" },
        "priority": { "name": "Medium" },
        "labels": [],
        "fixVersions": [{ "name": "v1.0" }]
      }
    }
  ]
}
```

- [ ] **Step 4: Create `src/test/fixtures/transitions-PROJ-123.json`**

```json
{
  "transitions": [
    { "id": "11", "name": "To Do", "to": { "name": "To Do" } },
    { "id": "21", "name": "In Progress", "to": { "name": "In Progress" } },
    { "id": "31", "name": "In Review", "to": { "name": "In Review" } },
    { "id": "41", "name": "Done", "to": { "name": "Done" } }
  ]
}
```

- [ ] **Step 5: Create `src/test/mocks/MockJiraClient.ts`**

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
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
```

- [ ] **Step 6: Commit**

```bash
git add src/test/
git commit -m "feat: test fixtures and MockJiraClient"
```

---

## Task 4: Branch Parser

**Files:**

- Create: `src/utils/branchParser.ts`
- Create: `src/test/branchParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/branchParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractTicketId } from '../utils/branchParser';

describe('extractTicketId', () => {
  it('extracts ticket ID from standard feature branch', () => {
    expect(extractTicketId('feature/PROJ-123-add-login')).toBe('PROJ-123');
  });

  it('extracts ticket ID from branch with no prefix', () => {
    expect(extractTicketId('PROJ-456-fix-bug')).toBe('PROJ-456');
  });

  it('extracts ticket ID with multi-char project key', () => {
    expect(extractTicketId('bugfix/MYPROJECT-99-some-fix')).toBe('MYPROJECT-99');
  });

  it('returns null for main branch', () => {
    expect(extractTicketId('main')).toBeNull();
  });

  it('returns null for develop branch', () => {
    expect(extractTicketId('develop')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractTicketId('')).toBeNull();
  });

  it('extracts first ticket ID when multiple are present', () => {
    expect(extractTicketId('PROJ-123-relates-to-PROJ-456')).toBe('PROJ-123');
  });

  it('returns null when project key is lowercase', () => {
    expect(extractTicketId('feature/proj-123-fix')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../utils/branchParser'`

- [ ] **Step 3: Implement `src/utils/branchParser.ts`**

```typescript
const TICKET_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

export function extractTicketId(branchName: string): string | null {
  const match = branchName.match(TICKET_ID_PATTERN);
  return match ? match[0] : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/branchParser.ts src/test/branchParser.test.ts
git commit -m "feat: branch parser utility with tests"
```

---

## Task 5: JiraApiClient

**Files:**

- Create: `src/jira/JiraApiClient.ts`
- Create: `src/test/JiraApiClient.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/JiraApiClient.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JiraApiClient } from '../jira/JiraApiClient';
import type { JiraIssue } from '../jira/IJiraClient';

const BASE_CONFIG = {
  baseUrl: 'https://jira.example.com',
  authType: 'datacenter' as const,
  token: 'my-pat-token',
};

function makeFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'OK',
    json: () => Promise.resolve(body),
  });
}

describe('JiraApiClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('auth headers', () => {
    it('sends Bearer header for datacenter auth', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-123', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.getIssue('PROJ-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/3/issue/PROJ-123',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer my-pat-token' }),
        }),
      );
    });

    it('sends Basic header for cloud auth', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-123', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, authType: 'cloud' });
      await client.getIssue('PROJ-123');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Basic my-pat-token' }),
        }),
      );
    });
  });

  describe('error handling', () => {
    it('throws auth error on 401', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 401));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-123')).rejects.toThrow('Authentication failed');
    });

    it('throws not found error on 404', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getIssue('PROJ-999')).rejects.toThrow('Not found');
    });
  });

  describe('URL construction', () => {
    it('removes trailing slash from baseUrl', async () => {
      const mockFetch = makeFetch({ id: '1', key: 'PROJ-1', fields: {} });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient({ ...BASE_CONFIG, baseUrl: 'https://jira.example.com/' });
      await client.getIssue('PROJ-1');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jira.example.com/rest/api/3/issue/PROJ-1',
        expect.anything(),
      );
    });
  });

  describe('addComment', () => {
    it('posts comment body in ADF format', async () => {
      const mockFetch = makeFetch({}, 201);
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      await client.addComment('PROJ-123', 'Looks good!');
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.body.type).toBe('doc');
      expect(body.body.content[0].content[0].text).toBe('Looks good!');
    });
  });

  describe('searchJql', () => {
    it('posts JQL and returns issues', async () => {
      const mockFetch = makeFetch({ issues: [], total: 0, maxResults: 20 });
      vi.stubGlobal('fetch', mockFetch);
      const client = new JiraApiClient(BASE_CONFIG);
      const result = await client.searchJql('project = PROJ');
      expect(result.total).toBe(0);
      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(body.jql).toBe('project = PROJ');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../jira/JiraApiClient'`

- [ ] **Step 3: Implement `src/jira/JiraApiClient.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass (8 branchParser + 7 JiraApiClient = 15 total).

- [ ] **Step 5: Commit**

```bash
git add src/jira/JiraApiClient.ts src/test/JiraApiClient.test.ts
git commit -m "feat: JiraApiClient with auth modes and error handling"
```

---

## Task 6: ConfigService

**Files:**

- Create: `src/services/ConfigService.ts`

Note: ConfigService wraps VS Code APIs (SecretStorage, workspace config) and is not unit-tested here. It is exercised by the participant integration tests in Task 8.

- [ ] **Step 1: Create `src/services/ConfigService.ts`**

```typescript
import * as vscode from 'vscode';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  requiredFields: string[];
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'jira-copilot.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('jiraCopilot');
    return {
      baseUrl: config.get<string>('baseUrl'),
      authType: config.get<AuthType>('authType') ?? 'datacenter',
      requiredFields: config.get<string[]>('requiredFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
    };
  }

  async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.TOKEN_KEY, token);
  }
}
```

- [ ] **Step 2: Verify compile**

```bash
npm run compile
```

Expected: exit code 0.

- [ ] **Step 3: Commit**

```bash
git add src/services/ConfigService.ts
git commit -m "feat: ConfigService reads settings and SecretStorage"
```

---

## Task 7: TicketService

**Files:**

- Create: `src/services/TicketService.ts`
- Create: `src/test/TicketService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/test/TicketService.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

describe('TicketService', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  describe('getTicket', () => {
    it('returns formatted markdown with ticket details', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('Implement user authentication');
      expect(result).toContain('Jane Doe');
      expect(result).toContain('High');
      expect(result).toContain('In Progress');
    });

    it('includes description text extracted from ADF', async () => {
      const result = await service.getTicket('PROJ-123');
      expect(result).toContain('OAuth2 authentication');
    });

    it('propagates not-found error for unknown ticket', async () => {
      await expect(service.getTicket('PROJ-404')).rejects.toThrow('Not found');
    });
  });

  describe('addComment', () => {
    it('calls client with correct ticket key and body', async () => {
      await service.addComment('PROJ-123', 'Ready for review');
      expect(client.addCommentCalls).toHaveLength(1);
      expect(client.addCommentCalls[0]).toEqual({ issueKey: 'PROJ-123', body: 'Ready for review' });
    });

    it('returns confirmation message', async () => {
      const result = await service.addComment('PROJ-123', 'done');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('comment');
    });
  });

  describe('updateField', () => {
    it('updates priority with correct Jira field format', async () => {
      await service.updateField('PROJ-123', 'priority', 'High');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ priority: { name: 'High' } });
    });

    it('updates summary as plain string', async () => {
      await service.updateField('PROJ-123', 'summary', 'New title');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ summary: 'New title' });
    });

    it('updates description wrapped in ADF', async () => {
      await service.updateField('PROJ-123', 'description', 'New desc');
      const fields = client.updateIssueCalls[0]?.fields;
      expect((fields?.description as { type: string }).type).toBe('doc');
    });

    it('updates assignee by resolving user first', async () => {
      await service.updateField('PROJ-123', 'assignee', 'jane');
      expect(client.updateIssueCalls[0]?.fields).toEqual({ assignee: { accountId: 'abc123' } });
    });

    it('returns error message for unsupported field', async () => {
      const result = await service.updateField('PROJ-123', 'storypoints', '5');
      expect(result).toContain('not supported');
    });

    it('returns error message when assignee user not found', async () => {
      const result = await service.updateField('PROJ-123', 'assignee', 'nobody-unknown');
      expect(result).toContain('No user found');
    });
  });

  describe('searchTickets', () => {
    it('returns formatted summary table', async () => {
      const result = await service.searchTickets('project = PROJ');
      expect(result).toContain('PROJ-123');
      expect(result).toContain('PROJ-124');
    });

    it('returns no-results message when empty', async () => {
      client.searchJql = async () => ({ issues: [], total: 0, maxResults: 20 });
      const result = await service.searchTickets('project = EMPTY');
      expect(result).toContain('No tickets found');
    });
  });

  describe('validateRequiredFields', () => {
    it('returns all-set message when all fields are present', async () => {
      const result = await service.validateRequiredFields('PROJ-123', ['summary', 'assignee', 'priority']);
      expect(result).toContain('All required fields are set');
    });

    it('reports missing fields', async () => {
      const result = await service.validateRequiredFields('PROJ-123', ['summary', 'fixVersions', 'nonexistent']);
      expect(result).toContain('nonexistent');
    });

    it('returns config guidance when no required fields configured', async () => {
      const result = await service.validateRequiredFields('PROJ-123', []);
      expect(result).toContain('jiraCopilot.requiredFields');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '../../services/TicketService'`

- [ ] **Step 3: Implement `src/services/TicketService.ts`**

```typescript
import type { IJiraClient, JiraIssue } from '../jira/IJiraClient';

const SUPPORTED_FIELDS: Record<string, string> = {
  summary: 'summary',
  description: 'description',
  priority: 'priority',
  assignee: 'assignee',
  labels: 'labels',
  'fix version': 'fixVersions',
  fixversions: 'fixVersions',
};

function extractTextFromAdf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractTextFromAdf).join(' ');
  return '';
}

function wrapInAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function formatIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const description = f.description
    ? extractTextFromAdf(f.description).trim() || '_No description_'
    : '_No description_';
  const assignee = f.assignee ? f.assignee.displayName : '_Unassigned_';
  const priority = f.priority ? f.priority.name : '_None_';
  const labels = f.labels.length > 0 ? f.labels.join(', ') : '_None_';
  const fixVersions = f.fixVersions.length > 0
    ? f.fixVersions.map((v) => v.name).join(', ')
    : '_None_';
  return [
    `## ${issue.key}: ${f.summary}`,
    `**Status:** ${f.status.name}`,
    `**Assignee:** ${assignee}`,
    `**Reporter:** ${f.reporter ? f.reporter.displayName : '_Unknown_'}`,
    `**Priority:** ${priority}`,
    `**Labels:** ${labels}`,
    `**Fix Versions:** ${fixVersions}`,
    '',
    '**Description:**',
    description,
  ].join('\n');
}

export class TicketService {
  constructor(private readonly client: IJiraClient) {}

  async getTicket(issueKey: string): Promise<string> {
    const issue = await this.client.getIssue(issueKey);
    return formatIssue(issue);
  }

  async addComment(issueKey: string, body: string): Promise<string> {
    await this.client.addComment(issueKey, body);
    return `Comment added to ${issueKey}.`;
  }

  async updateField(issueKey: string, fieldName: string, value: string): Promise<string> {
    const jiraField = SUPPORTED_FIELDS[fieldName.toLowerCase()];
    if (!jiraField) {
      const supported = Object.keys(SUPPORTED_FIELDS)
        .filter((k) => !k.includes('fix'))
        .concat(['fix version'])
        .join(', ');
      return `Field "${fieldName}" is not supported. Supported fields: ${supported}.`;
    }

    let fieldValue: unknown;
    if (jiraField === 'priority') {
      fieldValue = { name: value };
    } else if (jiraField === 'assignee') {
      const users = await this.client.findUser(value);
      if (users.length === 0) return `No user found matching "${value}".`;
      if (users.length > 1) {
        return `Multiple users found: ${users.map((u) => u.displayName).join(', ')}. Please be more specific.`;
      }
      fieldValue = { accountId: users[0].accountId };
    } else if (jiraField === 'description') {
      fieldValue = wrapInAdf(value);
    } else if (jiraField === 'labels') {
      fieldValue = value.split(',').map((l) => l.trim());
    } else if (jiraField === 'fixVersions') {
      fieldValue = [{ name: value }];
    } else {
      fieldValue = value;
    }

    await this.client.updateIssue(issueKey, { [jiraField]: fieldValue });
    return `Updated ${fieldName} on ${issueKey}.`;
  }

  async searchTickets(jql: string): Promise<string> {
    const result = await this.client.searchJql(jql);
    if (result.issues.length === 0) return 'No tickets found.';
    const rows = result.issues.map((issue) => {
      const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
      return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status.name} | ${assignee} |`;
    });
    return [
      `Found ${result.total} ticket(s):`,
      '',
      '| Key | Summary | Status | Assignee |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
  }

  async validateRequiredFields(issueKey: string, requiredFields: string[]): Promise<string> {
    if (requiredFields.length === 0) {
      return 'No required fields configured. Add field names to `jiraCopilot.requiredFields` in settings.';
    }
    const issue = await this.client.getIssue(issueKey);
    const missing = requiredFields.filter((field) => {
      const value = issue.fields[field];
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      );
    });
    if (missing.length === 0) return `All required fields are set on ${issueKey}.`;
    return `${issueKey} is missing required fields: ${missing.join(', ')}.`;
  }
}
```

- [ ] **Step 4: Run all tests to verify they pass**

```bash
npm test
```

Expected: all tests pass (8 + 7 + 16 = 31 total).

- [ ] **Step 5: Commit**

```bash
git add src/services/TicketService.ts src/test/TicketService.test.ts
git commit -m "feat: TicketService with all Phase 1 operations and tests"
```

---

## Task 8: JiraParticipant + Extension Wiring

**Files:**

- Create: `src/participant/JiraParticipant.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Create `src/participant/JiraParticipant.ts`**

```typescript
import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService } from '../services/TicketService';
import { extractTicketId } from '../utils/branchParser';
import { execSync } from 'child_process';

type Operation =
  | 'getTicket'
  | 'addComment'
  | 'updateField'
  | 'searchJql'
  | 'validateFields';

interface ParsedIntent {
  operation: Operation;
  ticketKey: string | null;
  comment: string | null;
  fieldName: string | null;
  fieldValue: string | null;
  jql: string | null;
}

const INTENT_PROMPT = `Parse this Jira command and respond with ONLY a JSON object. No markdown, no explanation.
Schema: {"operation":"getTicket"|"addComment"|"updateField"|"searchJql"|"validateFields","ticketKey":string|null,"comment":string|null,"fieldName":string|null,"fieldValue":string|null,"jql":string|null}
- getTicket: show, summarise, describe, look up a specific ticket
- addComment: add, post, write a comment on a ticket
- updateField: set, change, update a field (priority, assignee, summary, description, labels, fix version)
- searchJql: find, search, list tickets; review multiple tickets against criteria; use literal JQL if provided
- validateFields: check, validate required fields on a ticket

Command: `;

async function parseIntent(
  prompt: string,
  token: vscode.CancellationToken,
): Promise<ParsedIntent> {
  const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  const model = models[0];
  if (!model) {
    throw new Error('No language model available. Ensure GitHub Copilot is installed and signed in.');
  }
  const message = vscode.LanguageModelChatMessage.User(INTENT_PROMPT + JSON.stringify(prompt));
  const response = await model.sendRequest([message], {}, token);
  let json = '';
  for await (const chunk of response.text) {
    json += chunk;
  }
  const cleaned = json.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned) as ParsedIntent;
}

function resolveTicketFromBranch(): string | null {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    return extractTicketId(branch);
  } catch {
    return null;
  }
}

export function createParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const config = await configService.getConfig();

    if (!config.baseUrl) {
      stream.markdown(
        '⚠️ **Jira base URL not configured.**\n\nAdd `jiraCopilot.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`).',
      );
      return;
    }

    if (!config.token) {
      const command =
        config.authType === 'cloud'
          ? 'Jira Copilot: Configure Cloud Credentials'
          : 'Jira Copilot: Set Personal Access Token';
      stream.markdown(
        `⚠️ **Jira credentials not configured.**\n\nRun the command \`${command}\` from the Command Palette.`,
      );
      return;
    }

    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
    });
    const ticketService = new TicketService(jiraClient);

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, token);
    } catch (err) {
      stream.markdown(`❌ Could not understand the request: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let ticketKey = intent.ticketKey;
    if (!ticketKey && intent.operation !== 'searchJql') {
      ticketKey = resolveTicketFromBranch();
      if (ticketKey) {
        stream.markdown(`_Using ticket **${ticketKey}** from current branch._\n\n`);
      } else {
        stream.markdown('Which ticket are you referring to? (e.g. `@jira show me PROJ-123`)');
        return;
      }
    }

    try {
      let result: string;
      switch (intent.operation) {
        case 'getTicket':
          result = await ticketService.getTicket(ticketKey!);
          break;
        case 'addComment':
          if (!intent.comment) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          result = await ticketService.addComment(ticketKey!, intent.comment);
          break;
        case 'updateField':
          if (!intent.fieldName || !intent.fieldValue) {
            stream.markdown('Please specify both the field name and the new value.');
            return;
          }
          result = await ticketService.updateField(ticketKey!, intent.fieldName, intent.fieldValue);
          break;
        case 'searchJql':
          result = await ticketService.searchTickets(intent.jql ?? request.prompt);
          break;
        case 'validateFields':
          result = await ticketService.validateRequiredFields(ticketKey!, config.requiredFields);
          break;
        default:
          result = 'Unrecognised operation.';
      }
      stream.markdown(result);
    } catch (err) {
      stream.markdown(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('jira-copilot.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
```

- [ ] **Step 2: Replace `src/extension.ts` with the complete version**

```typescript
import * as vscode from 'vscode';
import { ConfigService } from './services/ConfigService';
import { createParticipant } from './participant/JiraParticipant';

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('jira-copilot.setDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeToken(token);
        vscode.window.showInformationMessage('Jira Copilot: Personal Access Token saved.');
      }
    }),

    vscode.commands.registerCommand('jira-copilot.configureCloud', async () => {
      const email = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian account email',
        ignoreFocusOut: true,
      });
      if (!email) return;
      const apiToken = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian API token (from id.atlassian.com)',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiToken) {
        const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
        await configService.storeToken(encoded);
        vscode.window.showInformationMessage('Jira Copilot: Cloud credentials saved.');
      }
    }),
  );

  createParticipant(context, configService);
}

export function deactivate(): void {}
```

- [ ] **Step 3: Verify compile**

```bash
npm run compile
```

Expected: exit code 0.

- [ ] **Step 4: Run all unit tests**

```bash
npm test
```

Expected: 31 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/participant/JiraParticipant.ts src/extension.ts
git commit -m "feat: JiraParticipant chat handler and extension entry point"
```

---

## Task 9: Documentation

**Files:**

- Create: `CLAUDE.md`
- Create: `README.md`

- [ ] **Step 1: Create `CLAUDE.md`**

````markdown
# Jira Copilot — Agent Context

## What this is

A VS Code extension that exposes a `@jira` GitHub Copilot Chat participant. Users manage Jira tickets (read, edit fields, comment, search) in natural language without leaving VS Code.

## Architecture (three layers — never skip)

```text
JiraParticipant → TicketService → IJiraClient (interface)
                                       ↓
                               JiraApiClient (production HTTP)
                               MockJiraClient (test fixture returns)
```

**Rule:** `TicketService` imports `IJiraClient` only — never `JiraApiClient` directly. This is the test seam that makes all business logic testable without a real Jira instance.

## Key files

| File | Responsibility |
| --- | --- |
| `src/jira/IJiraClient.ts` | All shared types + IJiraClient interface |
| `src/jira/JiraApiClient.ts` | Real HTTP; builds auth header from authType |
| `src/services/TicketService.ts` | All business logic; depends on IJiraClient |
| `src/services/ConfigService.ts` | VS Code settings + SecretStorage |
| `src/participant/JiraParticipant.ts` | Chat handler + intent parsing via VS Code LM API |
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron participant tests (requires VS Code)
```

## Adding a new Jira operation

1. Add method to `IJiraClient` interface
2. Implement in `JiraApiClient` (real HTTP)
3. Implement in `MockJiraClient` (fixture return)
4. Add a fixture file to `src/test/fixtures/` matching real Jira v3 API shape
5. Implement in `TicketService` (business logic)
6. Write tests in `TicketService.test.ts` first, then implement
7. Add intent routing in `JiraParticipant.ts`

## Jira API

- Base path: `<baseUrl>/rest/api/3/`
- Data Center auth: `Authorization: Bearer <PAT>`
- Cloud auth: `Authorization: Basic base64(email:apiToken)`
- Description fields use Atlassian Document Format (ADF) — wrap plain text with `wrapInAdf()` in TicketService

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Credentials

Always stored in `vscode.ExtensionContext.secrets` (VS Code SecretStorage, OS-encrypted).
Never in `settings.json`. Key: `jira-copilot.token`.
````

- [ ] **Step 2: Create `README.md`**

````markdown
# Jira Copilot

Manage Jira tickets with GitHub Copilot Chat — without leaving VS Code.

## Prerequisites

- VS Code 1.90 or later
- GitHub Copilot extension installed and signed in
- Jira 10 Data Center **or** any Jira Cloud instance

## Setup

### 1. Set the Jira base URL

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and add:

```json
"jiraCopilot.baseUrl": "https://jira.mycompany.com"
```

For Jira Cloud: `"https://your-org.atlassian.net"`

### 2. Set your auth type (Cloud only)

```json
"jiraCopilot.authType": "cloud"
```

Omit this setting for Data Center (default).

### 3. Store your credentials

**Data Center:** Open the Command Palette (`Ctrl+Shift+P`) → `Jira Copilot: Set Personal Access Token`

**Cloud:** Open the Command Palette → `Jira Copilot: Configure Cloud Credentials`
(You will need your Atlassian email and an API token from id.atlassian.com)

## Usage

Open GitHub Copilot Chat and use `@jira`:

| What you type | What happens |
| --- | --- |
| `@jira show me PROJ-123` | Displays ticket details |
| `@jira summarise this ticket` | Shows current branch ticket |
| `@jira set priority to High` | Updates priority on current branch ticket |
| `@jira assign this to jane.doe` | Assigns ticket (searches by name) |
| `@jira comment that the fix is in PR #42` | Adds a comment |
| `@jira find open bugs assigned to me` | Runs JQL search |
| `@jira check required fields on PROJ-123` | Validates required fields |

### Ticket detection

If you don't name a ticket, the plugin reads your current git branch. A branch named `feature/PROJ-123-my-work` will automatically use `PROJ-123`.

### Optional: required fields

```json
"jiraCopilot.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

## Getting a free Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `jiraCopilot.baseUrl` to `https://<you>.atlassian.net` and `jiraCopilot.authType` to `"cloud"`
4. Run `Jira Copilot: Configure Cloud Credentials`
````

- [ ] **Step 3: Final compile + test run**

```bash
npm run compile && npm test
```

Expected: compile succeeds, 31 tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: CLAUDE.md agent context and user README"
```

---

## Verification Checklist

Before declaring the MVP complete, verify each item manually:

- [ ] `npm run compile` exits with no errors
- [ ] `npm test` passes all 28 unit tests
- [ ] `Jira Copilot: Set Personal Access Token` appears in the Command Palette
- [ ] `Jira Copilot: Configure Cloud Credentials` appears in the Command Palette
- [ ] With a real or Cloud Jira: `@jira show me PROJ-123` returns formatted ticket output
- [ ] `@jira summarise this ticket` on a feature branch uses the ticket ID from the branch name
- [ ] `@jira summarise this ticket` on `main` responds asking which ticket
- [ ] Missing baseUrl or credentials produces a clear setup message (not a stack trace)
- [ ] `authType: "cloud"` sends `Basic` header; default `"datacenter"` sends `Bearer` header (verified by JiraApiClient unit tests)
