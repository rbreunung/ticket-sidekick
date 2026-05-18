# Bitbucket PR Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `@bitbucket` VS Code chat participant that reviews Bitbucket pull requests with a two-pass LLM approach, presenting findings file-by-file with numbered multi-turn follow-up support.

**Architecture:** Three-layer mirror of the existing Jira structure: `BitbucketParticipant` → `PrReviewService` → `IBitbucketClient`. Pure helpers (`parsePrUrl`, `parseDiff`, session types) live in `reviewSessionState.ts` for unit testing without VS Code. The participant orchestrates two-pass LLM calls; the service handles parallel file fetching, prompt building, and result formatting.

**Tech Stack:** TypeScript, VS Code Extension API (chat participants, secrets, workspace FS), Vitest (unit tests), Bitbucket REST API 1.0 (Data Center) / 2.0 (Cloud).

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/bitbucket/IBitbucketClient.ts` | All Bitbucket types + `IBitbucketClient` interface |
| Create | `src/bitbucket/BitbucketApiClient.ts` | Real HTTP; DC Bearer PAT + Cloud Basic email:apiToken |
| Create | `src/services/PrReviewService.ts` | Parallel file fetch, prompt builder, review formatter |
| Create | `src/participant/BitbucketParticipant.ts` | Chat handler, `check`, two-pass LLM review, follow-up session |
| Create | `src/participant/reviewSessionState.ts` | `parsePrUrl`, `parseDiff`, `resolveByNumber`, session types |
| Create | `src/test/mocks/MockBitbucketClient.ts` | `IBitbucketClient` with fixture returns + call tracking |
| Create | `src/test/fixtures/bitbucket-pr.json` | Sample `BitbucketPR` domain object |
| Create | `src/test/fixtures/bitbucket-diff.json` | Sample unified diff `{ "raw": "..." }` |
| Create | `src/test/fixtures/bitbucket-file.json` | Sample file content `{ "content": "..." }` |
| Create | `src/test/PrReviewService.test.ts` | Tests: parsePrUrl, parseDiff, resolveByNumber, service methods |
| Modify | `src/services/ConfigService.ts` | Add `getBitbucketConfig()` + `storeBitbucketToken()` |
| Modify | `src/extension.ts` | Register `@bitbucket` participant + two setup commands |
| Modify | `package.json` | New chat participant, commands, config properties |

---

## Task 1: Types and Interface (`IBitbucketClient.ts`)

**Files:**
- Create: `src/bitbucket/IBitbucketClient.ts`

No tests needed — pure type definitions.

- [ ] **Step 1: Create the file**

```typescript
// src/bitbucket/IBitbucketClient.ts

export type BitbucketAuthType = 'datacenter' | 'cloud';

export interface BitbucketUser {
  displayName: string;
  emailAddress: string;
}

export interface BitbucketPR {
  id: number;
  title: string;
  description: string;
  author: BitbucketUser;
  targetBranch: string;
  fromCommitHash: string;
}

export interface IBitbucketClient {
  getCurrentUser(): Promise<BitbucketUser>;
  getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPR>;
  getPullRequestDiff(project: string, repo: string, prId: number): Promise<string>;
  getFileContent(project: string, repo: string, path: string, commitHash: string): Promise<string>;
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bitbucket/IBitbucketClient.ts
git commit -m "feat(bitbucket): add IBitbucketClient interface and types"
```

---

## Task 2: Test Fixtures

**Files:**
- Create: `src/test/fixtures/bitbucket-pr.json`
- Create: `src/test/fixtures/bitbucket-diff.json`
- Create: `src/test/fixtures/bitbucket-file.json`

- [ ] **Step 1: Create `bitbucket-pr.json`** (matches `BitbucketPR` domain type)

```json
{
  "id": 42,
  "title": "Add OAuth login flow",
  "description": "Implements OAuth 2.0 login with Google. See VSJI-100 for requirements.",
  "author": {
    "displayName": "Jane Smith",
    "emailAddress": "jane.smith@example.com"
  },
  "targetBranch": "main",
  "fromCommitHash": "abc123def456abc123def456abc123def456abc1"
}
```

- [ ] **Step 2: Create `bitbucket-diff.json`** (raw unified diff wrapped in JSON)

```json
{
  "raw": "diff --git a/src/auth/login.ts b/src/auth/login.ts\nindex abc1234..def5678 100644\n--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -38,7 +38,12 @@\n-  const user = await db.query('SELECT * FROM users WHERE username = ' + username);\n+  const user = await db.query(`SELECT * FROM users WHERE username = ${username}`);\ndiff --git a/src/auth/tokenStore.ts b/src/auth/tokenStore.ts\nindex 111aaaa..222bbbb 100644\n--- a/src/auth/tokenStore.ts\n+++ b/src/auth/tokenStore.ts\n@@ -15,6 +15,8 @@\n+    localStorage.setItem('auth_token', token);\n"
}
```

- [ ] **Step 3: Create `bitbucket-file.json`**

```json
{
  "content": "import { db } from '../db';\nimport { Request, Response } from 'express';\n\nexport async function login(req: Request, res: Response) {\n  const { username, password } = req.body;\n  const user = await db.query('SELECT * FROM users WHERE username = ' + username);\n  if (!user) return res.status(401).send('Unauthorized');\n  const token = generateToken(user);\n  res.json({ token });\n}\n"
}
```

- [ ] **Step 4: Commit**

```bash
git add src/test/fixtures/bitbucket-pr.json src/test/fixtures/bitbucket-diff.json src/test/fixtures/bitbucket-file.json
git commit -m "feat(bitbucket): add test fixtures for PR, diff, and file content"
```

---

## Task 3: MockBitbucketClient

**Files:**
- Create: `src/test/mocks/MockBitbucketClient.ts`

- [ ] **Step 1: Create the mock**

```typescript
// src/test/mocks/MockBitbucketClient.ts
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { BitbucketPR, BitbucketUser, IBitbucketClient } from '../../bitbucket/IBitbucketClient';

function loadFixture<T>(filename: string): T {
  const p = resolve(process.cwd(), 'src/test/fixtures', filename);
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}

export class MockBitbucketClient implements IBitbucketClient {
  public getFileContentCalls: Array<{
    project: string;
    repo: string;
    path: string;
    commitHash: string;
  }> = [];

  async getCurrentUser(): Promise<BitbucketUser> {
    return { displayName: 'Jane Smith', emailAddress: 'jane.smith@example.com' };
  }

  async getPullRequest(_project: string, _repo: string, _prId: number): Promise<BitbucketPR> {
    return loadFixture<BitbucketPR>('bitbucket-pr.json');
  }

  async getPullRequestDiff(_project: string, _repo: string, _prId: number): Promise<string> {
    const fixture = loadFixture<{ raw: string }>('bitbucket-diff.json');
    return fixture.raw;
  }

  async getFileContent(
    project: string,
    repo: string,
    path: string,
    commitHash: string,
  ): Promise<string> {
    this.getFileContentCalls.push({ project, repo, path, commitHash });
    const fixture = loadFixture<{ content: string }>('bitbucket-file.json');
    return fixture.content;
  }
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/test/mocks/MockBitbucketClient.ts
git commit -m "feat(bitbucket): add MockBitbucketClient for unit tests"
```

---

## Task 4: ConfigService Extension

**Files:**
- Modify: `src/services/ConfigService.ts`

- [ ] **Step 1: Replace `ConfigService.ts` with the extended version**

```typescript
// src/services/ConfigService.ts
import * as vscode from 'vscode';
import type { BitbucketAuthType } from '../bitbucket/IBitbucketClient';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  apiVersion: 2 | 3;
  showConnectionInfo: boolean;
  requiredFields: string[];
  token: string | undefined;
}

export interface BitbucketConfig {
  baseUrl: string | undefined;
  authType: BitbucketAuthType;
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'ticket-sidekick.token';
  private static readonly BITBUCKET_TOKEN_KEY = 'ticket-sidekick.bitbucket.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('baseUrl'),
      authType: config.get<AuthType>('authType') ?? 'datacenter',
      apiVersion: config.get<2 | 3>('apiVersion') ?? 3,
      showConnectionInfo: config.get<boolean>('showConnectionInfo') ?? false,
      requiredFields: config.get<string[]>('requiredFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
    };
  }

  async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.TOKEN_KEY, token);
  }

  async getBitbucketConfig(): Promise<BitbucketConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('bitbucket.baseUrl'),
      authType: config.get<BitbucketAuthType>('bitbucket.authType') ?? 'datacenter',
      token: await this.context.secrets.get(ConfigService.BITBUCKET_TOKEN_KEY),
    };
  }

  async storeBitbucketToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.BITBUCKET_TOKEN_KEY, token);
  }
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 3: Run existing tests to confirm nothing is broken**

```bash
npm test
```
Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/ConfigService.ts
git commit -m "feat(bitbucket): add getBitbucketConfig and storeBitbucketToken to ConfigService"
```

---

## Task 5: Pure Helpers (`reviewSessionState.ts`) — TDD

**Files:**
- Create: `src/participant/reviewSessionState.ts`
- Create: `src/test/PrReviewService.test.ts` (helpers section)

- [ ] **Step 1: Write failing tests**

```typescript
// src/test/PrReviewService.test.ts
import { describe, it, expect } from 'vitest';
import { parsePrUrl, parseDiff, resolveByNumber } from '../participant/reviewSessionState';

describe('parsePrUrl', () => {
  it('parses a Data Center URL', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ authType: 'datacenter', project: 'PROJ', repo: 'myrepo', prId: 42 });
  });

  it('strips trailing path segments like /overview', () => {
    const result = parsePrUrl(
      'https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42/overview',
      'https://bitbucket.company.com',
    );
    expect(result).toEqual({ authType: 'datacenter', project: 'PROJ', repo: 'myrepo', prId: 42 });
  });

  it('parses a Bitbucket Cloud URL', () => {
    const result = parsePrUrl(
      'https://bitbucket.org/myworkspace/myrepo/pull-requests/7',
      '',
    );
    expect(result).toEqual({ authType: 'cloud', project: 'myworkspace', repo: 'myrepo', prId: 7 });
  });

  it('returns null for a non-Bitbucket URL', () => {
    expect(parsePrUrl('https://github.com/foo/bar/pull/42', '')).toBeNull();
  });

  it('returns null for a garbage string', () => {
    expect(parsePrUrl('not-a-url', '')).toBeNull();
  });
});

describe('parseDiff', () => {
  it('parses a single-file diff', () => {
    const raw = [
      'diff --git a/src/login.ts b/src/login.ts',
      '--- a/src/login.ts',
      '+++ b/src/login.ts',
      '@@ -1,3 +1,4 @@',
      ' line',
      '+added',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/login.ts');
    expect(result[0].diff).toContain('+added');
  });

  it('parses a multi-file diff', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const result = parseDiff(raw);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('returns empty array for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('resolveByNumber', () => {
  const findings = [
    { id: 1, file: 'a.ts', severity: 'critical' as const, title: 'SQL injection', description: '', recommendation: '' },
    { id: 2, file: 'b.ts', severity: 'warning' as const, title: 'localStorage risk', description: '', recommendation: '' },
  ];

  it('resolves #N at start of message', () => {
    expect(resolveByNumber('#1 can this be downgraded?', findings)?.id).toBe(1);
  });

  it('resolves #N mid-message', () => {
    expect(resolveByNumber('tell me more about #2 please', findings)?.id).toBe(2);
  });

  it('returns null when no #N pattern', () => {
    expect(resolveByNumber('explain the localStorage issue', findings)).toBeNull();
  });

  it('returns null for out-of-range number', () => {
    expect(resolveByNumber('#99', findings)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|Cannot find)"
```
Expected: failures about missing module `../participant/reviewSessionState`.

- [ ] **Step 3: Implement `reviewSessionState.ts`**

```typescript
// src/participant/reviewSessionState.ts
import type { BitbucketAuthType } from '../bitbucket/IBitbucketClient';

export interface ParsedPrUrl {
  authType: BitbucketAuthType;
  project: string;
  repo: string;
  prId: number;
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface ReviewFinding {
  id: number;
  file: string;
  line?: number;
  severity: 'critical' | 'warning' | 'suggestion';
  title: string;
  description: string;
  recommendation: string;
}

export interface ReviewSession {
  prTitle: string;
  prUrl: string;
  findings: ReviewFinding[];
}

export function parsePrUrl(url: string, baseUrl: string): ParsedPrUrl | null {
  try {
    const u = new URL(url);

    if (u.hostname === 'bitbucket.org') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
      if (!m) return null;
      return { authType: 'cloud', project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
    }

    const m = u.pathname.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
    if (!m) return null;
    return { authType: 'datacenter', project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
  } catch {
    return null;
  }
}

export function parseDiff(raw: string): FileDiff[] {
  const results: FileDiff[] = [];
  const parts = raw.split(/(?=^diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const pathMatch = part.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    results.push({ path: pathMatch[1].trim(), diff: part.trim() });
  }
  return results;
}

export function resolveByNumber(message: string, findings: ReviewFinding[]): ReviewFinding | null {
  const m = message.match(/#(\d+)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return findings.find((f) => f.id === id) ?? null;
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|parsePrUrl|parseDiff|resolveByNumber)"
```
Expected: all 9 helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/participant/reviewSessionState.ts src/test/PrReviewService.test.ts
git commit -m "feat(bitbucket): add reviewSessionState helpers with tests (parsePrUrl, parseDiff, resolveByNumber)"
```

---

## Task 6: `PrReviewService` — TDD

**Files:**
- Create: `src/services/PrReviewService.ts`
- Modify: `src/test/PrReviewService.test.ts` (add service tests)

- [ ] **Step 1: Append service tests to `PrReviewService.test.ts`**

Add these imports and describe blocks at the **end** of the existing test file:

```typescript
import { PrReviewService } from '../services/PrReviewService';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';
import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import type { ReviewFinding } from '../participant/reviewSessionState';

const SAMPLE_PR: BitbucketPR = {
  id: 42,
  title: 'Add OAuth login flow',
  description: 'Implements OAuth 2.0 login.',
  author: { displayName: 'Jane Smith', emailAddress: 'jane@example.com' },
  targetBranch: 'main',
  fromCommitHash: 'abc123',
};

describe('PrReviewService', () => {
  describe('gatherFileContents', () => {
    it('fetches from Bitbucket API when local file returns null', async () => {
      const client = new MockBitbucketClient();
      const service = new PrReviewService(client);

      const contents = await service.gatherFileContents(
        'PROJ', 'myrepo', 'abc123', ['src/login.ts'],
        async () => null,
      );

      expect(contents.get('src/login.ts')).toBeDefined();
      expect(client.getFileContentCalls).toHaveLength(1);
      expect(client.getFileContentCalls[0].path).toBe('src/login.ts');
    });

    it('prefers local workspace content over Bitbucket API', async () => {
      const client = new MockBitbucketClient();
      const service = new PrReviewService(client);

      const contents = await service.gatherFileContents(
        'PROJ', 'myrepo', 'abc123', ['src/login.ts'],
        async () => 'local file content',
      );

      expect(contents.get('src/login.ts')).toBe('local file content');
      expect(client.getFileContentCalls).toHaveLength(0);
    });

    it('fetches multiple files in parallel and returns all', async () => {
      const client = new MockBitbucketClient();
      const service = new PrReviewService(client);

      const contents = await service.gatherFileContents(
        'PROJ', 'myrepo', 'abc123',
        ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        async () => null,
      );

      expect(contents.size).toBe(3);
      expect(client.getFileContentCalls).toHaveLength(3);
    });
  });

  describe('buildPrompt', () => {
    it('includes file sections with diff and full content', () => {
      const service = new PrReviewService(new MockBitbucketClient());
      const fileDiffs = [{ path: 'src/login.ts', diff: '+added line' }];
      const fileContents = new Map([['src/login.ts', 'full file content']]);

      const prompt = service.buildPrompt(SAMPLE_PR, fileDiffs, fileContents);

      expect(prompt).toContain('### File: src/login.ts');
      expect(prompt).toContain('+added line');
      expect(prompt).toContain('full file content');
      expect(prompt).toContain('Add OAuth login flow (#42)');
      expect(prompt).toContain('Jane Smith');
    });
  });

  describe('formatReview', () => {
    it('groups findings by file with severity emoji and numbered references', () => {
      const findings: ReviewFinding[] = [
        { id: 1, file: 'src/login.ts', line: 42, severity: 'critical', title: 'SQL injection', description: 'Raw input in query', recommendation: 'Use parameterized queries' },
        { id: 2, file: 'src/tokenStore.ts', severity: 'warning', title: 'localStorage risk', description: 'Token exposed to JS', recommendation: 'Use httpOnly cookie' },
      ];
      const service = new PrReviewService(new MockBitbucketClient());
      const output = service.formatReview(findings, SAMPLE_PR, 2);

      expect(output).toContain('## PR #42');
      expect(output).toContain('Jane Smith');
      expect(output).toContain('**#1**');
      expect(output).toContain('🔴');
      expect(output).toContain('`L42`');
      expect(output).toContain('**📄 src/login.ts**');
      expect(output).toContain('**📄 src/tokenStore.ts**');
      expect(output).toContain('<!-- bitbucket:review-session -->');
    });

    it('shows clean message when no issues found', () => {
      const service = new PrReviewService(new MockBitbucketClient());
      const output = service.formatReview([], SAMPLE_PR, 1);

      expect(output).toContain('No issues found');
      expect(output).toContain('<!-- bitbucket:review-session -->');
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|Cannot find)"
```
Expected: failures about missing module `../services/PrReviewService`.

- [ ] **Step 3: Implement `PrReviewService.ts`**

```typescript
// src/services/PrReviewService.ts
import type { BitbucketPR, IBitbucketClient } from '../bitbucket/IBitbucketClient';
import type { FileDiff, ReviewFinding } from '../participant/reviewSessionState';

const REVIEW_PROMPT_PREAMBLE = `You are a senior software engineer conducting a thorough pull request review. Analyze the code changes for:
1. Security vulnerabilities (SQL injection, XSS, auth flaws, secret exposure, path traversal, IDOR, etc.)
2. Best practice violations (error handling, naming, SOLID principles, missing validation, etc.)
3. Logic errors and bugs

For each issue found, return a finding. Only report issues you are confident about.

Also list any additional files (not in the diff) whose full content would significantly improve your analysis. Keep this list short (max 5).

Respond with ONLY a JSON object — no markdown fences, no explanation:
{
  "findings": [
    {
      "file": "src/path/to/file.ts",
      "line": 42,
      "severity": "critical",
      "title": "Short title under 10 words",
      "description": "What the problem is and why it matters",
      "recommendation": "Concrete fix"
    }
  ],
  "additionalFilesNeeded": ["src/path/to/other.ts"]
}

severity must be exactly "critical", "warning", or "suggestion".
line is optional — omit if the issue spans the whole file.

---

`;

const SEVERITY_EMOJI: Record<ReviewFinding['severity'], string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
};

export class PrReviewService {
  constructor(private readonly client: IBitbucketClient) {}

  async gatherFileContents(
    project: string,
    repo: string,
    commitHash: string,
    paths: string[],
    readLocalFile: (path: string) => Promise<string | null>,
  ): Promise<Map<string, string>> {
    const entries = await Promise.all(
      paths.map(async (path) => {
        const local = await readLocalFile(path);
        if (local !== null) return [path, local] as const;
        try {
          const remote = await this.client.getFileContent(project, repo, path, commitHash);
          return [path, remote] as const;
        } catch {
          return [path, ''] as const;
        }
      }),
    );
    return new Map(entries.filter(([, content]) => content !== ''));
  }

  buildPrompt(pr: BitbucketPR, fileDiffs: FileDiff[], fileContents: Map<string, string>): string {
    const fileBlocks = fileDiffs.map((fd) => {
      const content = fileContents.get(fd.path) ?? '_not available_';
      return [
        `### File: ${fd.path}`,
        '',
        '**Diff:**',
        '```',
        fd.diff,
        '```',
        '',
        '**Full content:**',
        '```',
        content,
        '```',
      ].join('\n');
    });

    return (
      REVIEW_PROMPT_PREAMBLE +
      `PR: ${pr.title} (#${pr.id})\n` +
      `Author: ${pr.author.displayName} → ${pr.targetBranch}\n` +
      `Description: ${pr.description || '(none)'}\n\n` +
      `---\n\n` +
      fileBlocks.join('\n\n---\n\n')
    );
  }

  formatReview(findings: ReviewFinding[], pr: BitbucketPR, fileCount: number): string {
    const counts = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      suggestion: findings.filter((f) => f.severity === 'suggestion').length,
    };

    const summary = [
      counts.critical > 0 ? `${counts.critical} 🔴 critical` : '',
      counts.warning > 0 ? `${counts.warning} 🟡 warning` : '',
      counts.suggestion > 0 ? `${counts.suggestion} 🔵 suggestion` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const byFile = new Map<string, ReviewFinding[]>();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file)!.push(f);
    }

    const fileBlocks = [...byFile.entries()].map(([file, fileFindings]) => {
      const lines = fileFindings.map((f) => {
        const loc = f.line !== undefined ? `\`L${f.line}\` ` : '';
        return `**#${f.id}** ${SEVERITY_EMOJI[f.severity]} ${loc}${f.title}\n→ ${f.recommendation}`;
      });
      return `**📄 ${file}**\n${lines.join('\n')}`;
    });

    const followUp =
      findings.length > 0
        ? `\n\n---\n\n_Reply **#${findings[0].id}** or describe a finding to ask a follow-up._`
        : '';

    return [
      `## PR #${pr.id} — ${pr.title}`,
      `_by ${pr.author.displayName} → ${pr.targetBranch} · ${fileCount} file${fileCount !== 1 ? 's' : ''} changed_`,
      '',
      summary || '_No issues found — this PR looks clean._',
      '',
      '---',
      '',
      findings.length > 0 ? fileBlocks.join('\n\n---\n\n') : '',
      followUp,
      '',
      '<!-- bitbucket:review-session -->',
    ]
      .join('\n')
      .trimEnd() + '\n';
  }
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```
Expected: all tests pass, including the 7 new service tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/PrReviewService.ts src/test/PrReviewService.test.ts
git commit -m "feat(bitbucket): add PrReviewService with TDD (gatherFileContents, buildPrompt, formatReview)"
```

---

## Task 7: `BitbucketApiClient` — Real HTTP

**Files:**
- Create: `src/bitbucket/BitbucketApiClient.ts`

No separate unit test file — thin HTTP wrapper; `MockBitbucketClient` provides the test seam for all dependent services.

- [ ] **Step 1: Create the client**

```typescript
// src/bitbucket/BitbucketApiClient.ts
import type { BitbucketAuthType, BitbucketPR, BitbucketUser, IBitbucketClient } from './IBitbucketClient';

export interface BitbucketApiClientConfig {
  baseUrl: string;
  authType: BitbucketAuthType;
  token: string;
}

export class BitbucketApiClient implements IBitbucketClient {
  private readonly baseUrl: string;
  private readonly authType: BitbucketAuthType;
  private readonly authHeader: string;

  constructor(config: BitbucketApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader =
      config.authType === 'cloud' ? `Basic ${config.token}` : `Bearer ${config.token}`;
  }

  private async dcRequest<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(`Authentication failed at ${url}. Check your Bitbucket Data Center PAT.`);
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      const body = await response.text().catch(() => '');
      throw new Error(
        `Bitbucket API error ${response.status} at ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    return response.json() as Promise<T>;
  }

  private async dcRequestText(path: string): Promise<string> {
    const url = `${this.baseUrl}/rest/api/1.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'text/plain' },
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(`Authentication failed at ${url}. Check your Bitbucket Data Center PAT.`);
      throw new Error(`Bitbucket API error ${response.status} at ${url}`);
    }
    return response.text();
  }

  private async cloudRequest<T>(path: string): Promise<T> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json' },
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          `Authentication failed. Check your Atlassian API token at https://id.atlassian.com/manage-profile/security/api-tokens`,
        );
      if (response.status === 404) throw new Error(`Not found: ${url}`);
      const body = await response.text().catch(() => '');
      throw new Error(
        `Bitbucket Cloud API error ${response.status} at ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      );
    }
    return response.json() as Promise<T>;
  }

  private async cloudRequestText(path: string): Promise<string> {
    const url = `https://api.bitbucket.org/2.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader },
    });
    if (!response.ok)
      throw new Error(`Bitbucket Cloud API error ${response.status} at ${url}`);
    return response.text();
  }

  async getCurrentUser(): Promise<BitbucketUser> {
    if (this.authType === 'cloud') {
      const data = await this.cloudRequest<{ display_name: string }>('/user');
      return { displayName: data.display_name, emailAddress: '' };
    }
    // Data Center: verify auth by hitting an authenticated endpoint
    await this.dcRequest<unknown>('/profile/recent/repos?limit=1');
    return { displayName: 'Data Center user', emailAddress: '' };
  }

  async getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPR> {
    if (this.authType === 'cloud') {
      const data = await this.cloudRequest<{
        id: number;
        title: string;
        description: string;
        author: { display_name: string };
        destination: { branch: { name: string } };
        source: { commit: { hash: string } };
      }>(`/repositories/${project}/${repo}/pullrequests/${prId}`);
      return {
        id: data.id,
        title: data.title,
        description: data.description ?? '',
        author: { displayName: data.author.display_name, emailAddress: '' },
        targetBranch: data.destination.branch.name,
        fromCommitHash: data.source.commit.hash,
      };
    }
    const data = await this.dcRequest<{
      id: number;
      title: string;
      description: string;
      author: { user: { displayName: string; emailAddress: string } };
      toRef: { displayId: string };
      fromRef: { latestCommit: string };
    }>(`/projects/${project}/repos/${repo}/pull-requests/${prId}`);
    return {
      id: data.id,
      title: data.title,
      description: data.description ?? '',
      author: {
        displayName: data.author.user.displayName,
        emailAddress: data.author.user.emailAddress,
      },
      targetBranch: data.toRef.displayId,
      fromCommitHash: data.fromRef.latestCommit,
    };
  }

  async getPullRequestDiff(project: string, repo: string, prId: number): Promise<string> {
    if (this.authType === 'cloud') {
      return this.cloudRequestText(`/repositories/${project}/${repo}/pullrequests/${prId}/diff`);
    }
    return this.dcRequestText(`/projects/${project}/repos/${repo}/pull-requests/${prId}/diff`);
  }

  async getFileContent(
    project: string,
    repo: string,
    path: string,
    commitHash: string,
  ): Promise<string> {
    if (this.authType === 'cloud') {
      return this.cloudRequestText(`/repositories/${project}/${repo}/src/${commitHash}/${path}`);
    }
    const data = await this.dcRequest<{ lines: Array<{ text: string }> }>(
      `/projects/${project}/repos/${repo}/browse/${path}?at=${commitHash}`,
    );
    return data.lines.map((l) => l.text).join('\n');
  }
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: all tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/bitbucket/BitbucketApiClient.ts
git commit -m "feat(bitbucket): add BitbucketApiClient with Data Center and Cloud support"
```

---

## Task 8: `BitbucketParticipant` — Chat Handler

**Files:**
- Create: `src/participant/BitbucketParticipant.ts`

- [ ] **Step 1: Create the participant**

```typescript
// src/participant/BitbucketParticipant.ts
import * as vscode from 'vscode';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import { ConfigService } from '../services/ConfigService';
import { PrReviewService } from '../services/PrReviewService';
import type { ReviewFinding, ReviewSession } from './reviewSessionState';
import { parseDiff, parsePrUrl, resolveByNumber } from './reviewSessionState';

function getLastAssistantText(chatContext: vscode.ChatContext): string {
  for (let i = chatContext.history.length - 1; i >= 0; i--) {
    const item = chatContext.history[i];
    if (item instanceof vscode.ChatResponseTurn) {
      return item.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
    }
  }
  return '';
}

async function callReviewLLM(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<{ findings: Omit<ReviewFinding, 'id'>[]; additionalFilesNeeded: string[] }> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let raw = '';
  for await (const chunk of response.text) {
    raw += chunk;
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`LLM returned no valid JSON. Response preview: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]) as {
    findings?: Omit<ReviewFinding, 'id'>[];
    additionalFilesNeeded?: string[];
  };
  return {
    findings: parsed.findings ?? [],
    additionalFilesNeeded: parsed.additionalFilesNeeded ?? [],
  };
}

async function readWorkspaceFile(path: string): Promise<string | null> {
  const files = await vscode.workspace.findFiles(`**/${path}`, '**/node_modules/**', 1);
  if (files.length === 0) return null;
  const bytes = await vscode.workspace.fs.readFile(files[0]);
  return Buffer.from(bytes).toString('utf-8');
}

export function createBitbucketParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const ws = context.workspaceState;
    const prompt = request.prompt.trim();

    // ── 1. @bitbucket check ───────────────────────────────────────────────
    if (prompt.toLowerCase().startsWith('check')) {
      const config = await configService.getBitbucketConfig();
      if (!config.baseUrl || !config.token) {
        stream.markdown(
          '**Bitbucket not configured.**\n\n' +
            'Set `ticketSidekick.bitbucket.baseUrl` in settings and run ' +
            '**Ticket Sidekick: Set Bitbucket PAT** from the Command Palette.',
        );
        return;
      }
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl,
        authType: config.authType,
        token: config.token,
      });
      try {
        const user = await client.getCurrentUser();
        stream.markdown(
          '**Bitbucket connection OK**\n\n' +
            `| Setting | Value |\n|---|---|\n` +
            `| Base URL | \`${config.baseUrl}\` |\n` +
            `| Auth type | ${config.authType} |\n` +
            `| User | ${user.displayName} |\n`,
        );
      } catch (err) {
        stream.markdown(
          '**Bitbucket connection failed**\n\n' +
            `| Setting | Value |\n|---|---|\n` +
            `| Base URL | \`${config.baseUrl}\` |\n` +
            `| Auth type | ${config.authType} |\n\n` +
            `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // ── 2. Follow-up on an existing review session ────────────────────────
    const lastResponse = getLastAssistantText(chatContext);
    if (lastResponse.includes('<!-- bitbucket:review-session -->')) {
      const session = ws.get<ReviewSession>('bitbucket.session.review');
      if (session) {
        if (prompt.toLowerCase() === 'done' || prompt.toLowerCase() === 'cancel') {
          await ws.update('bitbucket.session.review', undefined);
          stream.markdown('_Review session cleared._');
          return;
        }

        const finding = resolveByNumber(prompt, session.findings) ?? undefined;
        const followUpPrompt = [
          'A developer asked a follow-up question about a specific code review finding.',
          '',
          `PR: ${session.prTitle}`,
          '',
          finding
            ? [
                'Finding:',
                `File: ${finding.file}${finding.line !== undefined ? `, Line: ${finding.line}` : ''}`,
                `Severity: ${finding.severity}`,
                `Title: ${finding.title}`,
                `Description: ${finding.description}`,
                `Recommendation: ${finding.recommendation}`,
              ].join('\n')
            : `All findings:\n${session.findings.map((f) => `#${f.id} [${f.severity}] ${f.file}: ${f.title}`).join('\n')}`,
          '',
          `Question: ${prompt}`,
          '',
          'Provide a thorough response. Address whether assumptions are valid, conditions for risk acceptance, and concrete code examples where applicable.',
        ].join('\n');

        if (finding) {
          stream.markdown(`**Re: #${finding.id} — ${finding.title}**\n\n`);
        }
        const response = await request.model.sendRequest(
          [vscode.LanguageModelChatMessage.User(followUpPrompt)],
          {},
          token,
        );
        for await (const chunk of response.text) {
          stream.markdown(chunk);
        }
        stream.markdown('\n\n<!-- bitbucket:review-session -->');
        return;
      }
    }

    // ── 3. New PR review — look for a PR URL in the prompt ────────────────
    const urlMatch = prompt.match(/https?:\/\/\S+\/pull-requests\/\d+[^\s]*/);
    if (!urlMatch) {
      stream.markdown(
        'Point me at a PR to review:\n\n' +
          '```\n@bitbucket https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42\n```\n\n' +
          'Or run `@bitbucket check` to verify your connection.',
      );
      return;
    }

    const config = await configService.getBitbucketConfig();
    if (!config.baseUrl || !config.token) {
      stream.markdown(
        '**Bitbucket not configured.**\n\n' +
          'Set `ticketSidekick.bitbucket.baseUrl` in settings and run ' +
          '**Ticket Sidekick: Set Bitbucket PAT** from the Command Palette.',
      );
      return;
    }

    const parsed = parsePrUrl(urlMatch[0], config.baseUrl);
    if (!parsed) {
      stream.markdown(
        `Could not parse PR URL: \`${urlMatch[0]}\`\n\n` +
          'Expected formats:\n' +
          '- Data Center: `https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42`\n' +
          '- Cloud: `https://bitbucket.org/workspace/myrepo/pull-requests/42`',
      );
      return;
    }

    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
    });
    const service = new PrReviewService(client);

    try {
      stream.markdown('_Fetching PR metadata…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);
      const rawDiff = await client.getPullRequestDiff(parsed.project, parsed.repo, parsed.prId);
      const fileDiffs = parseDiff(rawDiff);

      stream.markdown(
        `_Gathering context for ${fileDiffs.length} file${fileDiffs.length !== 1 ? 's' : ''}…_\n\n`,
      );
      const fileContents = await service.gatherFileContents(
        parsed.project,
        parsed.repo,
        pr.fromCommitHash,
        fileDiffs.map((f) => f.path),
        readWorkspaceFile,
      );

      stream.markdown('_Running first-pass analysis…_\n\n');
      const pass1 = await callReviewLLM(
        service.buildPrompt(pr, fileDiffs, fileContents),
        request.model,
        token,
      );

      let findings = pass1.findings;

      if (pass1.additionalFilesNeeded.length > 0) {
        const toFetch = pass1.additionalFilesNeeded.slice(0, 5);
        stream.markdown(
          `_Fetching ${toFetch.length} additional context file${toFetch.length !== 1 ? 's' : ''}…_\n\n`,
        );
        const extra = await service.gatherFileContents(
          parsed.project,
          parsed.repo,
          pr.fromCommitHash,
          toFetch,
          readWorkspaceFile,
        );
        const allContents = new Map([...fileContents, ...extra]);
        stream.markdown('_Running second-pass analysis with full context…_\n\n');
        const pass2 = await callReviewLLM(
          service.buildPrompt(pr, fileDiffs, allContents),
          request.model,
          token,
        );
        findings = pass2.findings;
      }

      const numbered: ReviewFinding[] = findings.map((f, i) => ({ ...f, id: i + 1 }));
      const output = service.formatReview(numbered, pr, fileDiffs.length);
      stream.markdown(output);

      await ws.update('bitbucket.session.review', {
        prTitle: pr.title,
        prUrl: urlMatch[0],
        findings: numbered,
      } satisfies ReviewSession);
    } catch (err) {
      stream.markdown(
        `**Review failed:** ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.bitbucket', handler);
  participant.isSticky = true;
  context.subscriptions.push(participant);
  return participant;
}
```

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/participant/BitbucketParticipant.ts
git commit -m "feat(bitbucket): add BitbucketParticipant with two-pass review and follow-up session"
```

---

## Task 9: Registration (`extension.ts` + `package.json`)

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Replace `extension.ts`**

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { ConfigService } from './services/ConfigService';
import { createParticipant } from './participant/JiraParticipant';
import { createBitbucketParticipant } from './participant/BitbucketParticipant';

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('ticket-sidekick.setDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Personal Access Token saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureCloud', async () => {
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
        vscode.window.showInformationMessage('Ticket Sidekick: Cloud credentials saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.setBitbucketDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket Data Center Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeBitbucketToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Bitbucket PAT saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureBitbucketCloud', async () => {
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
        await configService.storeBitbucketToken(encoded);
        vscode.window.showInformationMessage(
          'Ticket Sidekick: Bitbucket Cloud credentials saved.',
        );
      }
    }),
  );

  createParticipant(context, configService);
  createBitbucketParticipant(context, configService);
}

export function deactivate(): void {}
```

- [ ] **Step 2: Add Bitbucket participant to `package.json` `contributes.chatParticipants`**

In the `chatParticipants` array, add after the existing jira object:
```json
{
  "id": "ticket-sidekick.bitbucket",
  "name": "bitbucket",
  "fullName": "Ticket Sidekick — Bitbucket",
  "description": "Review Bitbucket pull requests with natural language",
  "isSticky": true
}
```

- [ ] **Step 3: Add Bitbucket commands to `package.json` `contributes.commands`**

In the `commands` array, add after the existing `configureCloud` command:
```json
{
  "command": "ticket-sidekick.setBitbucketDataCenterToken",
  "title": "Ticket Sidekick: Set Bitbucket Personal Access Token"
},
{
  "command": "ticket-sidekick.configureBitbucketCloud",
  "title": "Ticket Sidekick: Configure Bitbucket Cloud Credentials"
}
```

- [ ] **Step 4: Add Bitbucket config properties to `package.json` `contributes.configuration.properties`**

Add after the `ticketSidekick.showConnectionInfo` property:
```json
"ticketSidekick.bitbucket.baseUrl": {
  "type": "string",
  "description": "Base URL of your Bitbucket Data Center instance (e.g. https://bitbucket.mycompany.com). Leave empty for Bitbucket Cloud."
},
"ticketSidekick.bitbucket.authType": {
  "type": "string",
  "enum": ["datacenter", "cloud"],
  "default": "datacenter",
  "description": "Bitbucket authentication mode: 'datacenter' uses Bearer PAT, 'cloud' uses Basic email:apiToken (Atlassian API token)"
}
```

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: no errors.

- [ ] **Step 6: Run all tests**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(bitbucket): register @bitbucket participant and setup commands"
```

---

## Verification

### Automated

```bash
npm run compile   # TypeScript clean — no errors
npm test          # All Vitest unit tests green
```

### Manual (requires VS Code + a Bitbucket instance)

1. Open VS Code, open GitHub Copilot Chat
2. Type `@bitbucket check` before configuring → expect "not configured" guidance message
3. Run **Ticket Sidekick: Set Bitbucket PAT** from Command Palette → paste a valid Data Center PAT
4. Set `ticketSidekick.bitbucket.baseUrl` in VS Code settings
5. Type `@bitbucket check` → expect connection banner with auth type and "Data Center user"
6. Type `@bitbucket check` with a wrong token → expect error message with URL shown
7. Paste a Data Center PR URL ending with `/overview` → expect file-by-file review streaming with numbered findings and severity badges
8. Reply `#2 can this be downgraded if we're on an internal network?` → expect detailed elaboration on finding #2 with `Re: #2 — ...` header
9. Reply `explain the SQL injection issue` (natural language, no `#`) → LLM matches finding and elaborates
10. Paste a new PR URL → previous session cleared, new review starts
11. (Cloud) Run **Ticket Sidekick: Configure Bitbucket Cloud Credentials**, set `bitbucket.authType` to `cloud`, paste a `bitbucket.org` PR URL → review runs against Cloud API
