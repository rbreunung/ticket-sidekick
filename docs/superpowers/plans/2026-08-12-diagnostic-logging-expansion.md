# Diagnostic Logging Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `"Ticket Sidekick"` VS Code Output Channel (`src/utils/diagLog.ts`), today used only by the Bitbucket review pipeline, to cover the whole extension — every error and every major operation/sub-step in both `@jira` and `@bitbucket` — so a user or maintainer has a persistent, readable diagnostic record instead of only the ephemeral chat transcript.

**Architecture:** `logDiag(scope, level, message, details?)` gains a `level` and centralized redaction/truncation via a new `sanitizeDetails()` helper. Files that already import `vscode` call `logDiag` directly at their catch blocks and major-operation points. The four files that are deliberately `vscode`-free to stay Vitest-testable (`TicketService`, `PrReviewService`, `JiraApiClient`, `BitbucketApiClient`) take an optional injected `onDiag` callback instead — the same shape `lmRetry.ts` already uses for its `onAttemptFailed` hook.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-diagnostic-logging-expansion-design.md`

## Global Constraints

- No new user-facing setting — logging is always-on at full detail (major ops + sub-steps + errors). Do not add a `diagnostics.logLevel` config.
- `TicketService.ts`, `PrReviewService.ts`, `JiraApiClient.ts`, `BitbucketApiClient.ts` must never gain a `vscode` import — this is exactly what keeps them loadable by Vitest. Any logging they do goes through an **optional, backward-compatible** injected `onDiag?: DiagLogger` parameter/config field, never a direct `logDiag` import.
- Every constructor/config change must be additive and optional so no existing call site or test breaks (`new TicketService(client)` must keep working with no second argument).
- `sanitizeDetails()` is applied automatically **inside** `logDiag` — no call site anywhere ever calls it directly.
- Scope strings are fixed to this list — do not invent new ones ad hoc: `jira.participant`, `jira.create`, `jira.field`, `jira.cleanup`, `jira.workflow`, `jira.email`, `jira.load`, `jira.content`, `jira.veracode`, `jira.ticketService`, `jira.apiClient`, `bitbucket.review`, `bitbucket.followup`, `bitbucket.prReviewService`, `bitbucket.apiClient`, `extension`.
- Not every `catch` gets a log line. Expected, high-frequency control flow that isn't diagnostic signal (e.g. a `.gitignore`/branch lookup on a workspace that simply doesn't have one yet) is deliberately excluded — see "Deliberately excluded" at the end of this plan.
- `npm run compile` and `npm test` must stay green after every task.
- Do not change `lmRetry.ts`'s retry behavior or existing `bitbucket.review` LLM-failure logging semantics — only add the `level` argument its 2 existing `logDiag` calls now require.

---

## Task 1: Foundational logging primitives — `diagTypes`, `logRedaction`, `diagLog`

**Files:**
- Create: `src/utils/diagTypes.ts`
- Create: `src/utils/logRedaction.ts`
- Test: `src/test/logRedaction.test.ts`
- Modify: `src/utils/diagLog.ts`
- Modify: `src/participant/BitbucketParticipant.ts:63,567`

**Interfaces:**
- Produces: `type LogLevel = 'info' | 'warn' | 'error'` and `type DiagLogger = (level: LogLevel, message: string, details?: Record<string, unknown>) => void` (`src/utils/diagTypes.ts`)
- Produces: `function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown>` (`src/utils/logRedaction.ts`)
- Produces (breaking signature change): `function logDiag(scope: string, level: LogLevel, message: string, details?: Record<string, unknown>): void` (`src/utils/diagLog.ts`)

- [ ] **Step 1: Create `src/utils/diagTypes.ts`**

```ts
/**
 * Shared logging types — deliberately free of any `vscode` import so files
 * that must stay loadable by Vitest (TicketService, PrReviewService,
 * JiraApiClient, BitbucketApiClient) can depend on them without pulling in
 * `vscode` transitively. See `diagLog.ts` for the actual sink.
 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Injected into vscode-free classes so they can emit diagnostic lines
 * without importing `diagLog.ts` directly. The real implementation is a
 * scope-bound wrapper around `logDiag`, built at the instantiation site
 * (e.g. `(level, msg, details) => logDiag('jira.ticketService', level, msg, details)`).
 */
export type DiagLogger = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;
```

- [ ] **Step 2: Write failing tests for `sanitizeDetails`**

Create `src/test/logRedaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeDetails } from '../utils/logRedaction';

describe('sanitizeDetails', () => {
  it('redacts values whose key looks like a secret', () => {
    const result = sanitizeDetails({
      token: 'abc123', authorization: 'Bearer xyz', password: 'hunter2', apiKey: 'k-1', normal: 'keep me',
    });
    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.normal).toBe('keep me');
  });

  it('does not redact keys that merely contain unrelated substrings', () => {
    const result = sanitizeDetails({ count: 5, fileName: 'report.xml' });
    expect(result.count).toBe(5);
    expect(result.fileName).toBe('report.xml');
  });

  it('truncates strings over 500 characters', () => {
    const long = 'x'.repeat(600);
    const result = sanitizeDetails({ body: long });
    expect(result.body).toBe('x'.repeat(500) + '…[truncated, 600 chars total]');
  });

  it('leaves short strings untouched', () => {
    const result = sanitizeDetails({ body: 'short text' });
    expect(result.body).toBe('short text');
  });

  it('redacts and truncates inside nested objects', () => {
    const result = sanitizeDetails({
      request: { headers: { authorization: 'Bearer xyz' }, body: 'x'.repeat(600) },
    });
    const request = result.request as Record<string, unknown>;
    const headers = request.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[REDACTED]');
    expect((request.body as string).startsWith('x'.repeat(500))).toBe(true);
  });

  it('caps arrays at 20 items with a marker for the rest', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const result = sanitizeDetails({ items: arr });
    const items = result.items as unknown[];
    expect(items).toHaveLength(21); // 20 items + marker
    expect(items[20]).toBe('…5 more');
  });

  it('caps recursion depth beyond 4 nested object levels', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const result = sanitizeDetails(deep);
    const a = result.a as Record<string, any>;
    expect(a.b.c.d.e).toBe('[MAX_DEPTH]');
  });
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npm test -- logRedaction`
Expected: FAIL — `Cannot find module '../utils/logRedaction'`

- [ ] **Step 4: Implement `src/utils/logRedaction.ts`**

```ts
/**
 * Redaction/truncation applied automatically inside `logDiag` (see
 * `diagLog.ts`) before any `details` object is written to the shared Output
 * Channel — no call site needs to remember to do this itself. Guards
 * against secrets and oversized ticket/PR/email content ending up in a
 * plain-text, on-screen log.
 */
const SENSITIVE_KEY_PATTERN = /token|auth|password|secret|credential|bearer|apikey/i;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 4;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated, ${value.length} chars total]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    const capped = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      capped.push(`…${value.length - MAX_ARRAY_LENGTH} more`);
    }
    return capped;
  }
  if (value !== null && typeof value === 'object') {
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function sanitizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = sanitizeValue(value, depth);
  }
  return result;
}

export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(details, 1);
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npm test -- logRedaction`
Expected: PASS (all 7 tests)

- [ ] **Step 6: Update `src/utils/diagLog.ts`**

Replace the full file content with:

```ts
import * as vscode from 'vscode';
import type { LogLevel } from './diagTypes';
import { sanitizeDetails } from './logRedaction';

let channel: vscode.OutputChannel | undefined;

/**
 * Lazy singleton — shared by every feature in the extension (both `@jira`
 * and `@bitbucket`), not just this one. Visible to the user via
 * `View → Output → "Ticket Sidekick"`.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Ticket Sidekick');
  }
  return channel;
}

/**
 * Append a timestamped diagnostic line. `scope` is a short dotted tag (e.g.
 * `bitbucket.review`, `jira.create`) so entries from different features
 * stay distinguishable in the one shared channel. `level` tags the line for
 * skimmability (`ERROR` lines are easy to spot). `details`, if given, is
 * redacted/truncated via `sanitizeDetails` before being written — callers
 * never need to remember to do this themselves. Any feature in either
 * participant should log through this rather than inventing its own output
 * channel or relying on the chat transcript alone — see `CLAUDE.md` →
 * "Diagnostics".
 */
export function logDiag(scope: string, level: LogLevel, message: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const out = getOutputChannel();
  out.appendLine(`[${timestamp}] [${level.toUpperCase()}] [${scope}] ${message}`);
  if (details) {
    out.appendLine(JSON.stringify(sanitizeDetails(details)));
  }
}
```

- [ ] **Step 7: Update the 2 existing `logDiag` call sites in `src/participant/BitbucketParticipant.ts`**

In `logLmFailure` (around line 63):

```ts
// Before
  logDiag('bitbucket.review', `LLM call failed — ${contextLabel} (attempt ${attempt})`, {

// After
  logDiag('bitbucket.review', 'error', `LLM call failed — ${contextLabel} (attempt ${attempt})`, {
```

The "model in use" log (around line 567):

```ts
// Before
      logDiag('bitbucket.review', 'model in use', {

// After
      logDiag('bitbucket.review', 'info', 'model in use', {
```

- [ ] **Step 8: Compile and test**

Run: `npm run compile`
Expected: no TypeScript errors

Run: `npm test`
Expected: all tests pass (existing suite + new `logRedaction.test.ts`)

- [ ] **Step 9: Commit**

```bash
git add src/utils/diagTypes.ts src/utils/logRedaction.ts src/utils/diagLog.ts src/participant/BitbucketParticipant.ts src/test/logRedaction.test.ts
git commit -m "feat(diag): add log level + redaction to logDiag"
```

---

## Task 2: `TicketService` — inject `onDiag`, log major ops

**Files:**
- Modify: `src/services/TicketService.ts`
- Test: `src/test/TicketService.test.ts`

**Interfaces:**
- Consumes: `DiagLogger` from `../utils/diagTypes` (Task 1)
- Produces: `TicketService` constructor becomes `constructor(private readonly client: IJiraClient, private readonly onDiag?: DiagLogger) {}` — existing single-arg construction stays valid

Deliberately **not** touched: the `catch` in `transitionAlongPath` (`src/services/TicketService.ts:414-422`) — it's a control-flow retry (drop `fields` and retry once on a resolution-field rejection) that either recovers silently or rethrows to the caller, which already has richer per-ticket context to log with (see Task 12, `cleanupHandler.ts`). Logging here too would duplicate that.

- [ ] **Step 1: Write failing tests**

Add to `src/test/TicketService.test.ts` (needs `vi` added to the existing `vitest` import on line 1):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
```

New `describe` block, appended at the end of the file:

```ts
describe('TicketService onDiag', () => {
  it('logs an info line when a ticket is created', async () => {
    const client = new MockJiraClient();
    const onDiag = vi.fn();
    const service = new TicketService(client, onDiag);

    await service.createTicket('PROJ', 'New ticket', 'Bug');

    expect(onDiag).toHaveBeenCalledWith(
      'info', expect.stringContaining('Ticket created'),
      expect.objectContaining({ projectKey: 'PROJ', issueType: 'Bug' }),
    );
  });

  it('logs an info line when a field is updated', async () => {
    const client = new MockJiraClient();
    const onDiag = vi.fn();
    const service = new TicketService(client, onDiag);

    await service.updateField('PROJ-123', 'summary', 'New summary');

    expect(onDiag).toHaveBeenCalledWith(
      'info', expect.stringContaining('Field updated'),
      expect.objectContaining({ issueKey: 'PROJ-123' }),
    );
  });

  it('logs an info line when a comment is added', async () => {
    const client = new MockJiraClient();
    const onDiag = vi.fn();
    const service = new TicketService(client, onDiag);

    await service.addComment('PROJ-123', 'a comment');

    expect(onDiag).toHaveBeenCalledWith(
      'info', expect.stringContaining('Comment added'),
      expect.objectContaining({ issueKey: 'PROJ-123' }),
    );
  });

  it('logs a warn per item when a bulk field update fails', async () => {
    const client = new MockJiraClient();
    client.updateIssue = async (key: string) => {
      if (key === 'PROJ-2') throw new Error('boom');
    };
    const onDiag = vi.fn();
    const service = new TicketService(client, onDiag);
    const progress: Array<[string, boolean]> = [];

    await service.bulkUpdateField(['PROJ-1', 'PROJ-2'], 'priority', 'High', (key, ok) => progress.push([key, ok]));

    expect(onDiag).toHaveBeenCalledWith(
      'warn', expect.stringContaining('PROJ-2'),
      expect.objectContaining({ issueKey: 'PROJ-2', fieldId: 'priority' }),
    );
  });

  it('works without onDiag (backward compatible)', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    await expect(service.createTicket('PROJ', 'New ticket', 'Bug')).resolves.toContain('Created');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- TicketService`
Expected: FAIL — `onDiag` never called (constructor doesn't accept/store it yet)

- [ ] **Step 3: Add the `onDiag` parameter**

```ts
// Before
export class TicketService {
  constructor(private readonly client: IJiraClient) {}

// After
export class TicketService {
  constructor(private readonly client: IJiraClient, private readonly onDiag?: DiagLogger) {}
```

Add the import at the top of the file (after the existing `IJiraClient` import):

```ts
import type { DiagLogger } from '../utils/diagTypes';
```

- [ ] **Step 4: Log `createTicket`**

```ts
// Before
  async createTicket(
    projectKey: string,
    summary: string,
    issueType: string,
    additionalFields?: Record<string, unknown>,
  ): Promise<string> {
    const created = await this.client.createIssue(projectKey, summary, issueType, additionalFields);
    return `Created ${created.key}: **${summary}** (${issueType} in ${projectKey})`;
  }

// After
  async createTicket(
    projectKey: string,
    summary: string,
    issueType: string,
    additionalFields?: Record<string, unknown>,
  ): Promise<string> {
    const created = await this.client.createIssue(projectKey, summary, issueType, additionalFields);
    this.onDiag?.('info', `Ticket created — ${created.key}`, { projectKey, issueType });
    return `Created ${created.key}: **${summary}** (${issueType} in ${projectKey})`;
  }
```

- [ ] **Step 5: Log `updateField`**

```ts
// Before (tail of the method, lines 293-295)
    await this.client.updateIssue(issueKey, { [jiraField]: fieldValue });
    return `Updated ${fieldName} on ${issueKey}.`;
  }

// After
    await this.client.updateIssue(issueKey, { [jiraField]: fieldValue });
    this.onDiag?.('info', `Field updated — ${issueKey} (${fieldName})`, { issueKey, fieldName });
    return `Updated ${fieldName} on ${issueKey}.`;
  }
```

- [ ] **Step 6: Log `addComment`**

```ts
// Before
  async addComment(issueKey: string, body: string): Promise<string> {
    await this.client.addComment(issueKey, body);
    return `comment added to ${issueKey}.`;
  }

// After
  async addComment(issueKey: string, body: string): Promise<string> {
    await this.client.addComment(issueKey, body);
    this.onDiag?.('info', `Comment added — ${issueKey}`, { issueKey });
    return `comment added to ${issueKey}.`;
  }
```

- [ ] **Step 7: Log `bulkUpdateField`'s per-item failure**

```ts
// Before
      try {
        await this.client.updateIssue(key, { [fieldId]: fieldValue });
        onProgress(key, true);
      } catch (err) {
        onProgress(key, false, err instanceof Error ? err.message : String(err));
      }

// After
      try {
        await this.client.updateIssue(key, { [fieldId]: fieldValue });
        onProgress(key, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onDiag?.('warn', `Bulk field update failed — ${key} (${fieldId})`, { issueKey: key, fieldId, error: message });
        onProgress(key, false, message);
      }
```

- [ ] **Step 8: Run tests, verify they pass**

Run: `npm test -- TicketService`
Expected: PASS (all tests, including the 5 new ones)

- [ ] **Step 9: Compile**

Run: `npm run compile`
Expected: no TypeScript errors

- [ ] **Step 10: Commit**

```bash
git add src/services/TicketService.ts src/test/TicketService.test.ts
git commit -m "feat(diag): log TicketService major ops via injected onDiag"
```

---

## Task 3: `PrReviewService` — inject `onDiag`, log file-fetch and comment-post outcomes

**Files:**
- Modify: `src/services/PrReviewService.ts`
- Test: `src/test/PrReviewService.test.ts`

**Interfaces:**
- Consumes: `DiagLogger` from `../utils/diagTypes` (Task 1)
- Produces: `PrReviewService` constructor becomes `constructor(private readonly client: IBitbucketClient, private readonly onDiag?: DiagLogger) {}`

- [ ] **Step 1: Write failing tests**

Add `vi` to the existing `vitest` import at the top of `src/test/PrReviewService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
```

New `describe` block, appended at the end of the file:

```ts
describe('PrReviewService onDiag', () => {
  it('logs a warn when an additional file is unavailable', async () => {
    const client = new MockBitbucketClient();
    client.getFileContent = async () => { throw new Error('Not found: /some/path'); };
    const onDiag = vi.fn();
    const service = new PrReviewService(client, onDiag);

    const result = await service.gatherFileContents('PROJ', 'repo', 'abc123', ['src/foo.ts']);

    expect(result.get('src/foo.ts')).toBe('(file not available)');
    expect(onDiag).toHaveBeenCalledWith(
      'warn', expect.stringContaining('src/foo.ts'),
      expect.objectContaining({ path: 'src/foo.ts' }),
    );
  });

  it('logs an info summary after posting comments', async () => {
    const client = new MockBitbucketClient();
    const onDiag = vi.fn();
    const service = new PrReviewService(client, onDiag);
    const finding: ReviewFinding = {
      id: 1, file: 'a.ts', line: 10, severity: 'critical', title: 'T', description: 'D', recommendation: 'R',
    };

    await service.postCommentItems('PROJ', 'repo', 42, [{ finding, text: 'comment text' }]);

    expect(onDiag).toHaveBeenCalledWith(
      'info', expect.stringContaining('PR comments posted'),
      expect.objectContaining({ project: 'PROJ', repo: 'repo', prId: 42, failedCount: 0 }),
    );
  });

  it('works without onDiag (backward compatible)', async () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const result = await service.gatherFileContents('PROJ', 'repo', 'abc123', ['src/foo.ts']);
    expect(result.get('src/foo.ts')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- PrReviewService`
Expected: FAIL — `onDiag` never called

- [ ] **Step 3: Add the `onDiag` parameter**

```ts
// Before
export class PrReviewService {
  constructor(private readonly client: IBitbucketClient) {}

// After
export class PrReviewService {
  constructor(private readonly client: IBitbucketClient, private readonly onDiag?: DiagLogger) {}
```

Add the import at the top of the file (as new line 2, after the existing `IBitbucketClient` import):

```ts
import type { DiagLogger } from '../utils/diagTypes';
```

- [ ] **Step 4: Log `gatherFileContents`'s per-file failure**

```ts
// Before
        try {
          const remote = await this.client.getFileContent(project, repo, path, commitHash);
          return [path, remote] as const;
        } catch (err) {
          if (isAuthError(err)) throw err;
          return [path, '(file not available)'] as const;
        }

// After
        try {
          const remote = await this.client.getFileContent(project, repo, path, commitHash);
          return [path, remote] as const;
        } catch (err) {
          if (isAuthError(err)) throw err;
          this.onDiag?.('warn', `Additional file unavailable — ${path}`, {
            project, repo, path, error: err instanceof Error ? err.message : String(err),
          });
          return [path, '(file not available)'] as const;
        }
```

- [ ] **Step 5: Log `postCommentItems`'s per-item failure and completion summary**

```ts
// Before
      try {
        const result = await this.client.addPrComment(project, repo, prId, text, inline);
        results.push({ finding, result });
      } catch (err) {
        results.push({ finding, result: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  }

// After
      try {
        const result = await this.client.addPrComment(project, repo, prId, text, inline);
        results.push({ finding, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onDiag?.('warn', `Comment post failed — ${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`, {
          project, repo, prId, error: message,
        });
        results.push({ finding, result: null, error: message });
      }
    }
    const failedCount = results.filter((r) => r.error !== undefined).length;
    this.onDiag?.('info', `PR comments posted — ${results.length - failedCount}/${results.length}`, { project, repo, prId, failedCount });
    return results;
  }
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm test -- PrReviewService`
Expected: PASS

- [ ] **Step 7: Compile**

Run: `npm run compile`

- [ ] **Step 8: Commit**

```bash
git add src/services/PrReviewService.ts src/test/PrReviewService.test.ts
git commit -m "feat(diag): log PrReviewService file-fetch/comment-post outcomes via injected onDiag"
```

---

## Task 4: `JiraApiClient` — inject `onDiag`, log its 3 deliberate-swallow catches

**Files:**
- Modify: `src/jira/JiraApiClient.ts`
- Test: `src/test/JiraApiClient.test.ts`

**Interfaces:**
- Consumes: `DiagLogger` from `../utils/diagTypes` (Task 1)
- Produces: `JiraApiClientConfig` gains an optional `onDiag?: DiagLogger` field

- [ ] **Step 1: Write failing tests**

Insert a new `describe` block into `src/test/JiraApiClient.test.ts` right after the existing `describe('sprint lookup auth handling', …)` block (after line 316):

```ts
  describe('onDiag logging (constructor-injected)', () => {
    it('logs a warn when getRemoteLinks 404s', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const onDiag = vi.fn();
      const client = new JiraApiClient({ ...BASE_CONFIG, onDiag });
      await client.getRemoteLinks('PROJ-1');
      expect(onDiag).toHaveBeenCalledWith(
        'warn', expect.stringContaining('PROJ-1'),
        expect.objectContaining({ issueKey: 'PROJ-1' }),
      );
    });

    it('logs a warn when a board is skipped as non-Scrum during sprint search', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
        if (url.includes('/board?')) {
          return Promise.resolve({
            ok: true, status: 200, headers: { get: () => 'application/json' },
            json: () => Promise.resolve({ values: [{ id: 10, type: 'scrum' }] }),
          });
        }
        return Promise.resolve({
          ok: false, status: 400, statusText: 'Bad Request', headers: { get: () => 'application/json' },
          text: () => Promise.resolve(''),
        });
      }));
      const onDiag = vi.fn();
      const client = new JiraApiClient({ ...BASE_CONFIG, onDiag });
      const result = await client.findSprints('PROJ', 'Everest');
      expect(result).toEqual([]);
      expect(onDiag).toHaveBeenCalledWith(
        'warn', expect.stringContaining('skipped'),
        expect.objectContaining({ boardId: 10, query: 'Everest' }),
      );
    });

    it('does not require onDiag (backward compatible)', async () => {
      vi.stubGlobal('fetch', makeFetch({}, 404));
      const client = new JiraApiClient(BASE_CONFIG);
      await expect(client.getRemoteLinks('PROJ-1')).resolves.toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- JiraApiClient`
Expected: FAIL — `onDiag` is not an accepted config field yet, and it's never called

- [ ] **Step 3: Add `onDiag` to the config and constructor**

```ts
// Before
export interface JiraApiClientConfig {
  baseUrl: string;
  authType: AuthType;
  token: string;
  sprintBoardId?: number;
}

// After
export interface JiraApiClientConfig {
  baseUrl: string;
  authType: AuthType;
  token: string;
  sprintBoardId?: number;
  onDiag?: DiagLogger;
}
```

```ts
// Before
export class JiraApiClient implements IJiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly authType: AuthType;
  private readonly sprintBoardId?: number;

  constructor(config: JiraApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
    this.sprintBoardId = config.sprintBoardId;
  }

// After
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
```

Add the import after the existing `import { ApiError, JiraApiError } from '../utils/apiError';` line:

```ts
import type { DiagLogger } from '../utils/diagTypes';
```

- [ ] **Step 4: Log the `getRemoteLinks` 404 swallow**

```ts
// Before
  async getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
    try {
      return await this.request<JiraRemoteLink[]>(`/issue/${issueKey}/remotelink`);
    } catch (err) {
      // A 404 means the issue has no remote links (or the feature is absent) — return empty.
      // Auth/server errors must surface rather than masquerade as "no links".
      if (err instanceof ApiError && err.status === 404) return [];
      throw err;
    }
  }

// After
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
```

- [ ] **Step 5: Log the non-Scrum-board skip in `getSprintByName`**

```ts
// Before
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
      }
    }

// After
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
```

- [ ] **Step 6: Log the non-Scrum-board skip in `findSprints`**

```ts
// Before
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
      }
    }

// After
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
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `npm test -- JiraApiClient`
Expected: PASS

- [ ] **Step 8: Compile**

Run: `npm run compile`

- [ ] **Step 9: Commit**

```bash
git add src/jira/JiraApiClient.ts src/test/JiraApiClient.test.ts
git commit -m "feat(diag): log JiraApiClient's non-Scrum-board/404 skips via injected onDiag"
```

---

## Task 5: `BitbucketApiClient` — inject `onDiag`, log the Cloud scope-degradation fallback

**Files:**
- Modify: `src/bitbucket/BitbucketApiClient.ts`
- Test: `src/test/BitbucketApiClient.test.ts`

**Interfaces:**
- Consumes: `DiagLogger` from `../utils/diagTypes` (Task 1)
- Produces: `BitbucketApiClientConfig` gains an optional `onDiag?: DiagLogger` field

Deliberately **not** touched: the Cloud diff `JSON.parse` fallback (`getPullRequestDiff`, around line 213). On inspection it fires whenever the Cloud diff response is already plain text (a normal, frequent shape depending on API version), not an error condition — logging it would spam the channel on ordinary Cloud reviews. This matches the "expected, high-frequency control flow" exclusion in Global Constraints.

- [ ] **Step 1: Write a failing test**

Insert a new `describe` block into `src/test/BitbucketApiClient.test.ts`, after the existing `describe('BitbucketApiError typing (#9)', …)` block (after line 31, before the `DC_CONFIG`/`CLOUD_CONFIG` declarations — or anywhere after those declarations; place it after the `CLOUD_CONFIG` definition at line 42 so `CLOUD_CONFIG` is in scope):

```ts
describe('getCurrentUser onDiag logging (Cloud, missing scope)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs a warn and degrades gracefully when the Cloud token lacks Account: Read scope', async () => {
    vi.stubGlobal('fetch', errorFetch(403));
    const onDiag = vi.fn();
    const client = new BitbucketApiClient({ ...CLOUD_CONFIG, onDiag });
    const user = await client.getCurrentUser();
    expect(user.displayName).toContain('Account: Read scope');
    expect(onDiag).toHaveBeenCalledWith(
      'warn', expect.stringContaining('scope'),
      expect.objectContaining({ error: expect.stringContaining('403') }),
    );
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- BitbucketApiClient`
Expected: FAIL — `onDiag` is not an accepted config field yet, and it's never called

- [ ] **Step 3: Add `onDiag` to the config and constructor**

```ts
// Before
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
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
  }

// After
export interface BitbucketApiClientConfig {
  baseUrl: string;
  authType: BitbucketAuthType;
  token: string;
  onDiag?: DiagLogger;
}

export class BitbucketApiClient implements IBitbucketClient {
  private readonly baseUrl: string;
  private readonly authType: BitbucketAuthType;
  private readonly authHeader: string;
  private readonly onDiag?: DiagLogger;

  constructor(config: BitbucketApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authType = config.authType;
    this.authHeader = config.authType === 'cloud'
      ? `Basic ${config.token}`
      : `Bearer ${config.token}`;
    this.onDiag = config.onDiag;
  }
```

Add the import after the existing `import { BitbucketApiError } from '../utils/apiError';` line:

```ts
import type { DiagLogger } from '../utils/diagTypes';
```

- [ ] **Step 4: Log the scope-degradation fallback in `getCurrentUser`**

```ts
// Before
  async getCurrentUser(): Promise<BitbucketUser> {
    if (this.authType === 'cloud') {
      try {
        const data = await this.cloudRequest<{ display_name: string }>('/user');
        return { displayName: data.display_name, emailAddress: '' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403') || msg.includes('scope') || msg.includes('permission')) {
          return { displayName: '(add Account: Read scope to your App Password to show your username)', emailAddress: '' };
        }
        throw err;
      }
    }
    await this.dcRequest<unknown>('/profile/recent/repos?limit=1');
    return { displayName: 'Data Center user', emailAddress: '' };
  }

// After
  async getCurrentUser(): Promise<BitbucketUser> {
    if (this.authType === 'cloud') {
      try {
        const data = await this.cloudRequest<{ display_name: string }>('/user');
        return { displayName: data.display_name, emailAddress: '' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('403') || msg.includes('scope') || msg.includes('permission')) {
          this.onDiag?.('warn', 'Bitbucket Cloud user lookup missing Account: Read scope', { error: msg });
          return { displayName: '(add Account: Read scope to your App Password to show your username)', emailAddress: '' };
        }
        throw err;
      }
    }
    await this.dcRequest<unknown>('/profile/recent/repos?limit=1');
    return { displayName: 'Data Center user', emailAddress: '' };
  }
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- BitbucketApiClient`
Expected: PASS

- [ ] **Step 6: Compile**

Run: `npm run compile`

- [ ] **Step 7: Commit**

```bash
git add src/bitbucket/BitbucketApiClient.ts src/test/BitbucketApiClient.test.ts
git commit -m "feat(diag): log BitbucketApiClient's Cloud scope-degradation fallback via injected onDiag"
```

---

## Task 6: `JiraParticipant.ts` — wire loggers into service construction, log all 17 catch sites

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

**Interfaces:**
- Consumes: `logDiag` from `../utils/diagLog` (Task 1), the `onDiag` constructor param on `TicketService` (Task 2) and config field on `JiraApiClient` (Task 4)

This file already imports `vscode`, so it calls `logDiag` directly — there is no Vitest coverage for it (per `CLAUDE.md`, participant files are e2e-only), so there's no red/green test cycle here. Verification is `npm run compile` after all edits, plus the manual smoke test in "Final Verification".

- [ ] **Step 1: Add the `logDiag` import**

Add near the top of the file, alongside the other local imports:

```ts
import { logDiag } from '../utils/diagLog';
```

- [ ] **Step 2: Wire `onDiag` into `TicketService`/`JiraApiClient` construction**

```ts
// Before (around line 70-79)
    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
      sprintBoardId: config.sprintBoardId,
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v2 · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(jiraClient);

// After
    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
      sprintBoardId: config.sprintBoardId,
      onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v2 · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(
      jiraClient,
      (level, message, details) => logDiag('jira.ticketService', level, message, details),
    );
```

- [ ] **Step 3: Log catch #1 — `check` command (lines 89-112)**

```ts
// Before
      } catch (err) {
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

// After
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', 'Jira connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n\n` +
          `Error: ${message}`,
        );
      }
```

- [ ] **Step 4: Log catches #2, #3, #4, #6, #7, #8, #9, #10, #11, #14, #15, #16 — the uniform `stream.markdown(err.message)` pattern**

These 12 sites (lines 155-159, 179-188, 207-211, 238-246, 255-271, 280-284, 339-343, 361-367, 389-412, 552-557, 561-566, 570-575) all share the exact same body shape:

```ts
        } catch (err) {
          stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
        }
```

For each of these 12 occurrences, replace with:

```ts
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
```

Since this exact 2-line body repeats 12 times across the file, edit them one at a time in file order (top to bottom) so each edit's surrounding context (the code immediately above/below, e.g. `await executeCleanupBatch(...)` vs `await handleCreateTicket(...)`) makes it unambiguous which occurrence is being changed. Use the line-number list above to navigate; do not use a blind find-and-replace-all, since some other catches in this same file (#12, #13, #17) have a different body shape and must not be touched by this step.

- [ ] **Step 5: Log catch #5 — template load fail-soft (lines 233-236)**

```ts
// Before
        if (typeSession.templateName && workspaceRoot) {
          try {
            const { templates } = new TemplateService(workspaceRoot).loadTemplates();
            selectedTemplate = templates.find((t) => t.name === typeSession.templateName) ?? null;
          } catch { /* proceed without */ }
        }

// After
        if (typeSession.templateName && workspaceRoot) {
          try {
            const { templates } = new TemplateService(workspaceRoot).loadTemplates();
            selectedTemplate = templates.find((t) => t.name === typeSession.templateName) ?? null;
          } catch (err) {
            logDiag('jira.participant', 'warn', `Could not reload template — ${typeSession.templateName}`, {
              templateName: typeSession.templateName, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
```

- [ ] **Step 6: Log catch #12 — load-skipped attachment download, per-item (lines 444-453)**

```ts
// Before
            try {
              stream.markdown(`_Downloading \`${chosen.filename}\`…_\n\n`);
              const bytes = await ticketService.downloadAttachment(chosen.content);
              await vscode.workspace.fs.createDirectory(attachmentsDir);
              await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, chosen.filename), bytes);
              lines.push(`✓ \`${chosen.filename}\` downloaded.`);
            } catch (err) {
              downloadedSet.delete(i - 1);
              lines.push(`✗ Failed to download \`${chosen.filename}\`: ${err instanceof Error ? err.message : String(err)}`);
            }

// After
            try {
              stream.markdown(`_Downloading \`${chosen.filename}\`…_\n\n`);
              const bytes = await ticketService.downloadAttachment(chosen.content);
              await vscode.workspace.fs.createDirectory(attachmentsDir);
              await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, chosen.filename), bytes);
              lines.push(`✓ \`${chosen.filename}\` downloaded.`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'warn', `Attachment download failed — ${chosen.filename}`, { fileName: chosen.filename, error: message });
              downloadedSet.delete(i - 1);
              lines.push(`✗ Failed to download \`${chosen.filename}\`: ${message}`);
            }
```

- [ ] **Step 7: Log catch #13 — intent parsing (lines 539-548)**

```ts
// Before
    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
      if (intent.operation === 'runCleanup') {
        const fv = extractFixVersionFromPrompt(request.prompt);
        if (fv) intent = { ...intent, fixVersion: fv };
      }
    } catch (err) {
      stream.markdown(`Could not understand the request: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

// After
    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
      if (intent.operation === 'runCleanup') {
        const fv = extractFixVersionFromPrompt(request.prompt);
        if (fv) intent = { ...intent, fixVersion: fv };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', 'Could not understand the request (intent parsing failed)', { error: message });
      stream.markdown(`Could not understand the request: ${message}`);
      return;
    }
```

- [ ] **Step 8: Log catch #17 — outermost switch/operation dispatch backstop (lines 609-1023)**

```ts
// Before (tail of the function)
      stream.markdown(result);
      if (ticketKey) stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }

// After
      stream.markdown(result);
      if (ticketKey) stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', message, { operation: intent.operation });
      stream.markdown(message);
    }
```

- [ ] **Step 9: Compile**

Run: `npm run compile`
Expected: no TypeScript errors

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all green (this file has no direct Vitest coverage, but confirm nothing else broke)

- [ ] **Step 11: Commit**

```bash
git add src/participant/JiraParticipant.ts
git commit -m "feat(diag): log JiraParticipant catch sites and wire onDiag into service construction"
```

---

## Task 7: `BitbucketParticipant.ts` — wire loggers into service construction, log remaining catches and sub-steps

**Files:**
- Modify: `src/participant/BitbucketParticipant.ts`

**Interfaces:**
- Consumes: `logDiag` from `../utils/diagLog` (already imported, Task 1), the `onDiag` constructor param on `PrReviewService` (Task 3) and config field on `BitbucketApiClient` (Task 5)

No Vitest coverage for this file either (imports `vscode`). Verification is `npm run compile` plus the manual smoke test in "Final Verification".

- [ ] **Step 1: Wire `onDiag` into the 4 `BitbucketApiClient`/`PrReviewService` construction sites**

Site 1 — `handleCheck` (lines 247-252):

```ts
// Before
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
    });

// After
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
      onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
    });
```

Site 2 — `postAndReport` helper (lines 328-333):

```ts
// Before
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl ?? '',
        authType: config.authType,
        token: config.token!,
      });
      const service = new PrReviewService(client);

// After
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl ?? '',
        authType: config.authType,
        token: config.token!,
        onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
      });
      const service = new PrReviewService(
        client,
        (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
      );
```

Site 3 — "add to review" intent branch (lines 418-422):

```ts
// Before
            const service = new PrReviewService(new BitbucketApiClient({
              baseUrl: config.baseUrl ?? '',
              authType: config.authType,
              token: config.token!,
            }));

// After
            const service = new PrReviewService(
              new BitbucketApiClient({
                baseUrl: config.baseUrl ?? '',
                authType: config.authType,
                token: config.token!,
                onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
              }),
              (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
            );
```

Site 4 — main new-review flow (lines 535-540):

```ts
// Before
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
    });
    const service = new PrReviewService(client);

// After
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
      onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
    });
    const service = new PrReviewService(
      client,
      (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
    );
```

- [ ] **Step 2: Log catch #1 — `handleCheck` (lines 247-273)**

```ts
// Before
  } catch (err) {
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

// After
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('bitbucket.review', 'error', 'Bitbucket connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      `Error: ${message}`,
    );
  }
```

- [ ] **Step 3: Log catch #2 — comment-preview refinement (lines 369-388)**

```ts
// Before
        } catch (err) {
          stream.markdown(
            `${friendlyLmFailureMessage('**Refinement failed:**', err)}\n\n<!-- bitbucket:comment-preview -->`,
          );
        }

// After
        } catch (err) {
          logDiag('bitbucket.followup', 'error', 'Comment refinement failed', { error: err instanceof Error ? err.message : String(err) });
          stream.markdown(
            `${friendlyLmFailureMessage('**Refinement failed:**', err)}\n\n<!-- bitbucket:comment-preview -->`,
          );
        }
```

- [ ] **Step 4: Log catch #3 — follow-up session backstop (lines 402-497)**

```ts
// Before
        } catch (err) {
          stream.markdown(
            `${friendlyLmFailureMessage('**Follow-up failed:**', err)}\n\n<!-- bitbucket:review-session -->`,
          );
          return;
        }

// After
        } catch (err) {
          logDiag('bitbucket.followup', 'error', 'Follow-up handling failed', { error: err instanceof Error ? err.message : String(err) });
          stream.markdown(
            `${friendlyLmFailureMessage('**Follow-up failed:**', err)}\n\n<!-- bitbucket:review-session -->`,
          );
          return;
        }
```

- [ ] **Step 5: Log catch #4 — outer new-review backstop (lines 823-825)**

```ts
// Before
    } catch (err) {
      stream.markdown(friendlyLmFailureMessage('**Review failed:**', err));
    }

// After
    } catch (err) {
      logDiag('bitbucket.review', 'error', 'PR review failed', { error: err instanceof Error ? err.message : String(err) });
      stream.markdown(friendlyLmFailureMessage('**Review failed:**', err));
    }
```

- [ ] **Step 6: Log catch #5 — continuation-pass fail-soft (lines 678-691)**

```ts
// Before
              } catch (err) {
                anyBatchFailed = true;
                stream.markdown(`_⚠ Continuation pass failed (batch ${i + 1}) — keeping findings from the truncated response. ${describeFailure(err)}_\n\n`);
              }

// After
              } catch (err) {
                anyBatchFailed = true;
                logDiag('bitbucket.review', 'warn', `Continuation pass failed — batch ${i + 1}`, { batch: i + 1, error: err instanceof Error ? err.message : String(err) });
                stream.markdown(`_⚠ Continuation pass failed (batch ${i + 1}) — keeping findings from the truncated response. ${describeFailure(err)}_\n\n`);
              }
```

- [ ] **Step 7: Log catch #6 — pass 2 whole-file-context fail-soft (lines 727-730)**

```ts
// Before
            } catch (err) {
              anyBatchFailed = true;
              stream.markdown(`_⚠ Pass 2 (whole-file context) failed (batch ${i + 1}) — keeping findings from the diff-only pass. ${describeFailure(err)}_\n\n`);
            }

// After
            } catch (err) {
              anyBatchFailed = true;
              logDiag('bitbucket.review', 'warn', `Pass 2 (whole-file context) failed — batch ${i + 1}`, { batch: i + 1, error: err instanceof Error ? err.message : String(err) });
              stream.markdown(`_⚠ Pass 2 (whole-file context) failed (batch ${i + 1}) — keeping findings from the diff-only pass. ${describeFailure(err)}_\n\n`);
            }
```

- [ ] **Step 8: Log the batch-start sub-step**

```ts
// Before (lines 639-640)
        const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
        const pass1Label = `pass1 batch ${i + 1}/${chunks.length}`;

// After
        const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
        const pass1Label = `pass1 batch ${i + 1}/${chunks.length}`;
        logDiag('bitbucket.review', 'info', `Batch ${i + 1}/${chunks.length} started — ${chunk.length} file(s)`, {
          batch: i + 1, totalBatches: chunks.length, fileCount: chunk.length,
        });
```

- [ ] **Step 9: Log the additional-files-fetched sub-step**

```ts
// Before (lines 702-709)
              if (toFetch.length > 0) {
                const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
                stream.markdown(`_Fetching ${toFetch.length} context file${toFetch.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
                const fetched = await service.gatherFileContents(
                  parsed.project, parsed.repo, pr.fromCommitHash, toFetch,
                );
                for (const [p, c] of fetched) fetchedFileCache.set(p, c);
              }

// After
              if (toFetch.length > 0) {
                const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
                stream.markdown(`_Fetching ${toFetch.length} context file${toFetch.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
                const fetched = await service.gatherFileContents(
                  parsed.project, parsed.repo, pr.fromCommitHash, toFetch,
                );
                for (const [p, c] of fetched) fetchedFileCache.set(p, c);
                logDiag('bitbucket.review', 'info', `Additional context files fetched — batch ${i + 1}`, {
                  batch: i + 1, requestedCount: toFetch.length, fetchedCount: fetched.size,
                });
              }
```

- [ ] **Step 10: Log the critic-drop sub-step**

```ts
// Before (lines 775-777)
          if (droppedByCritic > 0) {
            stream.markdown(`_Critic dropped ${droppedByCritic} unverified finding${droppedByCritic !== 1 ? 's' : ''} (batch ${i + 1})._\n\n`);
          }

// After
          if (droppedByCritic > 0) {
            logDiag('bitbucket.review', 'info', `Critic dropped ${droppedByCritic} unverified finding(s) — batch ${i + 1}`, { batch: i + 1, droppedByCritic });
            stream.markdown(`_Critic dropped ${droppedByCritic} unverified finding${droppedByCritic !== 1 ? 's' : ''} (batch ${i + 1})._\n\n`);
          }
```

- [ ] **Step 11: Log the review-completed major op**

```ts
// Before (lines 799-806)
      const output = service.formatReview(numbered, pr, fileDiffs.length, config.confidenceThreshold);
      if (anyBatchFailed) {
        stream.markdown(`_⚠ Some batches had failures after retrying — showing partial results. See the "Ticket Sidekick" output channel for details._\n\n`);
      }
      stream.markdown(output);
      const reviewTokenEst = Math.ceil((totalInputChars + totalOutputChars) / 4);
      stream.markdown(`\n\n_~${reviewTokenEst.toLocaleString()} estimated tokens · budget ${tokenBudget.toLocaleString()}_`);

// After
      const output = service.formatReview(numbered, pr, fileDiffs.length, config.confidenceThreshold);
      logDiag('bitbucket.review', 'info', `PR review completed — ${numbered.length} finding(s)`, {
        project: parsed.project, repo: parsed.repo, prId: parsed.prId,
        findingCount: numbered.length, fileCount: fileDiffs.length, batchCount: chunks.length, anyBatchFailed,
      });
      if (anyBatchFailed) {
        stream.markdown(`_⚠ Some batches had failures after retrying — showing partial results. See the "Ticket Sidekick" output channel for details._\n\n`);
      }
      stream.markdown(output);
      const reviewTokenEst = Math.ceil((totalInputChars + totalOutputChars) / 4);
      stream.markdown(`\n\n_~${reviewTokenEst.toLocaleString()} estimated tokens · budget ${tokenBudget.toLocaleString()}_`);
```

- [ ] **Step 12: Compile**

Run: `npm run compile`
Expected: no TypeScript errors

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: all green

- [ ] **Step 14: Commit**

```bash
git add src/participant/BitbucketParticipant.ts
git commit -m "feat(diag): log BitbucketParticipant catches and review sub-steps, wire onDiag into service construction"
```

---

## Task 8: `fieldHandler.ts`

**Files:** Modify `src/participant/jira/fieldHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the sprint-search catch (lines 47-52)**

```ts
// Before
    try {
      candidates = await ticketService.findSprints(projectKey, fieldValueRaw);
    } catch (err) {
      stream.markdown(`Could not search sprints: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

// After
    try {
      candidates = await ticketService.findSprints(projectKey, fieldValueRaw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.field', 'error', `Sprint search failed — ${projectKey}`, { projectKey, query: fieldValueRaw, error: message });
      stream.markdown(`Could not search sprints: ${message}`);
      return;
    }
```

- [ ] **Step 3: Log the field-value-build catch (lines 90-93)**

```ts
// Before
  } catch (err) {
    stream.markdown(`Could not build field value: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

// After
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.field', 'error', 'Could not build field value', { error: message });
    stream.markdown(`Could not build field value: ${message}`);
    return;
  }
```

- [ ] **Step 4: Compile**

Run: `npm run compile`

- [ ] **Step 5: Commit**

```bash
git add src/participant/jira/fieldHandler.ts
git commit -m "feat(diag): log fieldHandler catch sites"
```

---

## Task 9: `veracodeHandler.ts`

**Files:** Modify `src/participant/jira/veracodeHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the file-import catch (lines 55-61)**

```ts
// Before
  try {
    const flaws = await readAndFilterVeracodeFile(uris[0].fsPath);
    return { flaws, fileName: uris[0].fsPath.split(/[\\/]/).pop() ?? uris[0].fsPath };
  } catch (err) {
    stream.markdown(`_Could not import report: ${err instanceof Error ? err.message : String(err)}_`);
    return null;
  }

// After
  try {
    const flaws = await readAndFilterVeracodeFile(uris[0].fsPath);
    return { flaws, fileName: uris[0].fsPath.split(/[\\/]/).pop() ?? uris[0].fsPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.veracode', 'error', `Could not import report — ${uris[0].fsPath}`, { path: uris[0].fsPath, error: message });
    stream.markdown(`_Could not import report: ${message}_`);
    return null;
  }
```

- [ ] **Step 3: Log the template-load fail-soft catch (lines 73-76)**

```ts
// Before
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch { return []; }

// After
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
    } catch (err) {
      logDiag('jira.veracode', 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
```

- [ ] **Step 4: Log the issue-types fail-soft catch (lines 80-83)**

```ts
// Before
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch { /* fall through to the 'Bug' default below */ }

// After
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch (err) {
    logDiag('jira.veracode', 'warn', `Could not fetch issue types — ${projectKey}, defaulting to 'Bug'`, {
      projectKey, error: err instanceof Error ? err.message : String(err),
    });
  }
```

- [ ] **Step 5: Log the template-field-resolution catch (lines 202-214)**

```ts
// Before
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        const fullTemplate = templates.find(t => t.name === pick.name);
        if (fullTemplate) {
          const resolver = new FieldResolver(jiraClient, session.projectKey);
          additionalFields = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
        }
      } catch (err) {
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ` +
          `${err instanceof Error ? err.message : String(err)}_\n\n`,
        );
      }

// After
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        const fullTemplate = templates.find(t => t.name === pick.name);
        if (fullTemplate) {
          const resolver = new FieldResolver(jiraClient, session.projectKey);
          additionalFields = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.veracode', 'warn', `Could not resolve template fields — ${pick.name}`, { templateName: pick.name, error: message });
        stream.markdown(
          `_Warning: could not resolve template fields — proceeding without them: ` +
          `${message}_\n\n`,
        );
      }
```

- [ ] **Step 6: Log the per-row ticket-creation catch (lines 296-305)**

```ts
// Before
    try {
      const fields = { ...session.additionalFields, labels: row.labels, description: row.descriptionWiki };
      const confirmation = await ticketService.createTicket(session.projectKey, row.summary, session.issueType, fields);
      const key = extractCreatedKeyFromConfirmation(confirmation);
      stream.markdown(`✓ ${key ?? '?'} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      stream.markdown(`✗ Flaw ${row.issueId} — ${err instanceof Error ? err.message : String(err)}\n\n`);
      failed++;
    }

// After
    try {
      const fields = { ...session.additionalFields, labels: row.labels, description: row.descriptionWiki };
      const confirmation = await ticketService.createTicket(session.projectKey, row.summary, session.issueType, fields);
      const key = extractCreatedKeyFromConfirmation(confirmation);
      stream.markdown(`✓ ${key ?? '?'} — ${row.summary}\n\n`);
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.veracode', 'error', `Ticket creation failed — flaw ${row.issueId}`, { issueId: row.issueId, error: message });
      stream.markdown(`✗ Flaw ${row.issueId} — ${message}\n\n`);
      failed++;
    }
```

- [ ] **Step 7: Log the batch-completion summary**

```ts
// Before (lines 307-316, tail of executeVeracodeBatch)

  const total = session.rows.length;
  let summary =
    `${total} flaw(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (session.rows.length > BATCH_LIMIT) {
    summary += `\n\n_Batch capped at ${BATCH_LIMIT} tickets per run — re-run the import to process the remainder._`;
  }
  stream.markdown(summary);
}

// After

  const total = session.rows.length;
  let summary =
    `${total} flaw(s) reviewed — **${created}** created, ${failed} failed, ` +
    `${excludedByUser} excluded by you, ${alreadyTicketedSkipped} already ticketed (skipped).`;
  if (session.rows.length > BATCH_LIMIT) {
    summary += `\n\n_Batch capped at ${BATCH_LIMIT} tickets per run — re-run the import to process the remainder._`;
  }
  logDiag('jira.veracode', failed > 0 ? 'warn' : 'info', `Veracode import complete — ${created} created, ${failed} failed`, {
    total, created, failed, excludedByUser, alreadyTicketedSkipped,
  });
  stream.markdown(summary);
}
```

- [ ] **Step 8: Compile**

Run: `npm run compile`

- [ ] **Step 9: Commit**

```bash
git add src/participant/jira/veracodeHandler.ts
git commit -m "feat(diag): log veracodeHandler catch sites and batch-completion summary"
```

---

## Task 10: `createHandler.ts`

**Files:** Modify `src/participant/jira/createHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the section-coverage JSON-parse catch (lines 53-57)**

```ts
// Before
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }

// After
  try {
    return JSON.parse(match[0]) as string[];
  } catch (err) {
    logDiag('jira.create', 'warn', 'Could not parse section-coverage response as JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
```

- [ ] **Step 3: Log the field-resolution catch (lines 87-97)**

```ts
// Before
    try {
      resolvedFields = await resolver.resolve(selectedTemplate.defaultFields, selectedTemplate.resolveFields);
    } catch (err) {
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Field resolution error: ${err instanceof Error ? err.message : String(err)}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return null; }
      resolvedFields = {};
      selectedTemplate = null;
    }

// After
    try {
      resolvedFields = await resolver.resolve(selectedTemplate.defaultFields, selectedTemplate.resolveFields);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.create', 'error', 'Template field resolution failed', { templateName: selectedTemplate?.name, error: message });
      const pick = await vscode.window.showQuickPick(['Proceed without template', 'Cancel'], {
        title: `Field resolution error: ${message}`,
        ignoreFocusOut: true,
      });
      if (pick !== 'Proceed without template') { stream.markdown('Cancelled.'); return null; }
      resolvedFields = {};
      selectedTemplate = null;
    }
```

- [ ] **Step 4: Log the template-reload catch (lines 242-248)**

```ts
// Before
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        selectedTemplate = templates.find((t) => t.name === preselectedTemplateName) ?? null;
      } catch {
        stream.markdown('_Could not reload template — proceeding without._\n\n');
      }

// After
      try {
        const { templates } = new TemplateService(workspaceRoot).loadTemplates();
        selectedTemplate = templates.find((t) => t.name === preselectedTemplateName) ?? null;
      } catch (err) {
        logDiag('jira.create', 'warn', `Could not reload template — ${preselectedTemplateName}`, {
          templateName: preselectedTemplateName, error: err instanceof Error ? err.message : String(err),
        });
        stream.markdown('_Could not reload template — proceeding without._\n\n');
      }
```

- [ ] **Step 5: Log the initial template-load catch (lines 253-258)**

```ts
// Before
      try {
        ({ templates } = new TemplateService(workspaceRoot).loadTemplates());
      } catch (err) {
        stream.markdown(`_Template error: ${err instanceof Error ? err.message : String(err)} — proceeding without template._\n\n`);
      }

// After
      try {
        ({ templates } = new TemplateService(workspaceRoot).loadTemplates());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.create', 'warn', 'Could not load templates — proceeding without template', { error: message });
        stream.markdown(`_Template error: ${message} — proceeding without template._\n\n`);
      }
```

- [ ] **Step 6: Log the issue-types catch (lines 288-292)**

```ts
// Before
    try {
      types = await ticketService.getIssueTypes(projectKey);
    } catch {
      types = [];
    }

// After
    try {
      types = await ticketService.getIssueTypes(projectKey);
    } catch (err) {
      logDiag('jira.create', 'warn', `Could not fetch issue types — ${projectKey}`, {
        projectKey, error: err instanceof Error ? err.message : String(err),
      });
      types = [];
    }
```

- [ ] **Step 7: Compile**

Run: `npm run compile`

- [ ] **Step 8: Commit**

```bash
git add src/participant/jira/createHandler.ts
git commit -m "feat(diag): log createHandler catch sites"
```

---

## Task 11: `emailHandler.ts`

**Files:** Modify `src/participant/jira/emailHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the `getProject` retry fail-soft catch (lines 35-41)**

```ts
// Before
    try {
      const project = await jiraClient.getProject(session.projectKey);
      const issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
      if (issueTypes.length > 0) {
        session = { ...session, availableIssueTypes: issueTypes, issueType: selectDefaultIssueType(issueTypes) };
      }
    } catch { /* use session as-is; simplified prompt still functional */ }

// After
    try {
      const project = await jiraClient.getProject(session.projectKey);
      const issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
      if (issueTypes.length > 0) {
        session = { ...session, availableIssueTypes: issueTypes, issueType: selectDefaultIssueType(issueTypes) };
      }
    } catch (err) {
      logDiag('jira.email', 'warn', `Could not refresh issue types — ${session.projectKey}`, {
        projectKey: session.projectKey, error: err instanceof Error ? err.message : String(err),
      });
      // use session as-is; simplified prompt still functional
    }
```

- [ ] **Step 3: Log the `.eml` readFile catch, `handleAddEmailFromChat` (lines 69-75)**

```ts
// Before
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    stream.markdown(`_Could not read file: ${err instanceof Error ? err.message : String(err)}_`);
    return;
  }

// After
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not read file: ${message}_`);
    return;
  }
```

- [ ] **Step 4: Log the `parseEml` catch, `handleAddEmailFromChat` (lines 76-82)**

```ts
// Before
  let parsed;
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    stream.markdown(`_Could not parse email: ${err instanceof Error ? err.message : String(err)}_`);
    return;
  }

// After
  let parsed;
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not parse email: ${message}_`);
    return;
  }
```

- [ ] **Step 5: Log the template-load fail-soft catch, `buildEmailCreateSession` (lines 139-142)**

```ts
// Before
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
    } catch { return []; }

// After
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
    } catch (err) {
      logDiag('jira.email', 'warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
```

- [ ] **Step 6: Log the issue-types fail-soft catch, `buildEmailCreateSession` (lines 147-150)**

```ts
// Before
    try {
      const project = await jiraClient.getProject(projectKey);
      issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
    } catch { /* use defaults */ }

// After
    try {
      const project = await jiraClient.getProject(projectKey);
      issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
    } catch (err) {
      logDiag('jira.email', 'warn', `Could not fetch issue types — ${projectKey}`, {
        projectKey, error: err instanceof Error ? err.message : String(err),
      });
    }
```

- [ ] **Step 7: Log the readFile catch, `openEmailFilePicker` (lines 187-192)**

```ts
// Before
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    stream.markdown(`_Could not read file: ${err instanceof Error ? err.message : String(err)}_`);
    return null;
  }

// After
  try {
    buffer = await fs.promises.readFile(emlPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not read file: ${message}_`);
    return null;
  }
```

- [ ] **Step 8: Log the `parseEml` catch, `openEmailFilePicker` (lines 195-200)**

```ts
// Before
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    stream.markdown(`_Could not parse email: ${err instanceof Error ? err.message : String(err)}_`);
    return null;
  }

// After
  try {
    parsed = await parseEml(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.email', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
    stream.markdown(`_Could not parse email: ${message}_`);
    return null;
  }
```

- [ ] **Step 9: Log the template-field-resolution catch, `handleEmailContentSession` (lines 270-278)**

```ts
// Before
        try {
          const { templates } = new TemplateService(workspaceRoot).loadTemplates();
          const fullTemplate = templates.find(t => t.name === pick.name);
          if (fullTemplate) {
            const resolver = new FieldResolver(jiraClient, session.projectKey);
            const resolved = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
            additionalFields = { ...resolved, ...session.additionalFields };
          }
        } catch { /* proceed without template fields */ }

// After
        try {
          const { templates } = new TemplateService(workspaceRoot).loadTemplates();
          const fullTemplate = templates.find(t => t.name === pick.name);
          if (fullTemplate) {
            const resolver = new FieldResolver(jiraClient, session.projectKey);
            const resolved = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
            additionalFields = { ...resolved, ...session.additionalFields };
          }
        } catch (err) {
          logDiag('jira.email', 'warn', `Could not resolve template fields — ${pick.name}`, {
            templateName: pick.name, error: err instanceof Error ? err.message : String(err),
          });
          // proceed without template fields
        }
```

- [ ] **Step 10: Log the attachment-upload `.catch()`, `addEmailAsComment` (lines 329-333)**

```ts
// Before
        ticketService.uploadAttachment(ticketKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
          }),

// After
        ticketService.uploadAttachment(ticketKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { ticketKey, fileName: att.name, error: message });
            stream.markdown(`_Warning: could not upload ${att.name}: ${message}_`);
          }),
```

- [ ] **Step 11: Log the attachment-upload `.catch()`, `finishEmailTicket` (lines 426-430)**

```ts
// Before
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
          }),

// After
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes)
          .then(() => { uploaded++; })
          .catch(err => {
            const message = err instanceof Error ? err.message : String(err);
            logDiag('jira.email', 'warn', `Attachment upload failed — ${att.name}`, { issueKey, fileName: att.name, error: message });
            stream.markdown(`_Warning: could not upload ${att.name}: ${message}_`);
          }),
```

- [ ] **Step 12: Log the `.eml` deletion `.catch()` (line 441)**

```ts
// Before
      await fs.promises.unlink(session.emlFilePath).catch(() => {});

// After
      await fs.promises.unlink(session.emlFilePath).catch((err: unknown) => {
        logDiag('jira.email', 'warn', `Could not delete .eml after import — ${session.emlFilePath}`, {
          emlFilePath: session.emlFilePath, error: err instanceof Error ? err.message : String(err),
        });
      });
```

- [ ] **Step 13: Compile**

Run: `npm run compile`

- [ ] **Step 14: Commit**

```bash
git add src/participant/jira/emailHandler.ts
git commit -m "feat(diag): log emailHandler catch sites, including the .eml cleanup failure"
```

---

## Task 12: `cleanupHandler.ts`

**Files:** Modify `src/participant/jira/cleanupHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the subtask-transition catch (lines 42-48)**

```ts
// Before
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, sub.resolution ?? session.resolution);
        transitioned++;
      } catch (err) {
        failures.push({ key: sub.key, reason: err instanceof Error ? err.message : String(err) });
        failed++;
      }

// After
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, sub.resolution ?? session.resolution);
        transitioned++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logDiag('jira.cleanup', 'warn', `Transition failed — ${sub.key}`, { issueKey: sub.key, reason });
        failures.push({ key: sub.key, reason });
        failed++;
      }
```

- [ ] **Step 3: Log the parent-ticket-transition catch (lines 51-57)**

```ts
// Before
    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      transitioned++;
    } catch (err) {
      failures.push({ key: ticket.key, reason: err instanceof Error ? err.message : String(err) });
      failed++;
    }

// After
    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      transitioned++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logDiag('jira.cleanup', 'warn', `Transition failed — ${ticket.key}`, { issueKey: ticket.key, reason });
      failures.push({ key: ticket.key, reason });
      failed++;
    }
```

- [ ] **Step 4: Log the batch-completion summary**

```ts
// Before (lines 60-67, tail of executeCleanupBatch)
  const processedTotal = transitioned + failed + skipped;
  let summary = `${processedTotal} processed — **${transitioned}** transitioned, ${failed} failed, ${skipped} skipped.`;
  if (failures.length > 0) {
    summary += '\n\n' + failures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
    summary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
  }
  stream.markdown(summary);
}

// After
  const processedTotal = transitioned + failed + skipped;
  let summary = `${processedTotal} processed — **${transitioned}** transitioned, ${failed} failed, ${skipped} skipped.`;
  if (failures.length > 0) {
    summary += '\n\n' + failures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
    summary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
  }
  logDiag('jira.cleanup', failed > 0 ? 'warn' : 'info', `Cleanup batch complete — ${transitioned} transitioned, ${failed} failed, ${skipped} skipped`, {
    transitioned, failed, skipped,
  });
  stream.markdown(summary);
}
```

- [ ] **Step 5: Compile**

Run: `npm run compile`

- [ ] **Step 6: Commit**

```bash
git add src/participant/jira/cleanupHandler.ts
git commit -m "feat(diag): log cleanupHandler per-item failures and batch summary"
```

---

## Task 13: `loadHandler.ts`

**Files:** Modify `src/participant/jira/loadHandler.ts`

Deliberately **not** touched: the inner `.gitignore` read catch (`catch { /* file absent */ }`, line 156) — a missing `.gitignore` is the normal case for a fresh workspace, not a failure worth logging.

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the attachment-download catch (lines 93-100)**

```ts
// Before
      try {
        const bytes = await ticketService.downloadAttachment(att.content);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, att.filename), bytes);
        downloaded.add(att.filename);
      } catch (err) {
        downloadErrors.push(`${att.filename}: ${err instanceof Error ? err.message : String(err)}`);
        skippedUrls.set(att.filename, att.content);
      }

// After
      try {
        const bytes = await ticketService.downloadAttachment(att.content);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, att.filename), bytes);
        downloaded.add(att.filename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.load', 'warn', `Attachment download failed — ${att.filename}`, { fileName: att.filename, error: message });
        downloadErrors.push(`${att.filename}: ${message}`);
        skippedUrls.set(att.filename, att.content);
      }
```

- [ ] **Step 3: Log the `ticket.md`/`comments.md` write catch (lines 143-147)**

```ts
// Before
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(contextDir, name), enc.encode(content));
    } catch (err) {
      writeErrors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }

// After
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(contextDir, name), enc.encode(content));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.load', 'warn', `Could not write ${name}`, { fileName: name, error: message });
      writeErrors.push(`${name}: ${message}`);
    }
```

- [ ] **Step 4: Log the `.gitignore`-update outer catch (lines 150-164)**

```ts
// Before
  // Update .gitignore
  try {
    let existing = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsRoot, '.gitignore'));
      existing = new TextDecoder().decode(bytes);
    } catch { /* file absent */ }
    if (!existing.split('\n').some(line => line.trim() === '.jira-context/')) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(wsRoot, '.gitignore'),
        enc.encode(existing + prefix + '.jira-context/\n'),
      );
    }
  } catch { /* non-fatal */ }

// After
  // Update .gitignore
  try {
    let existing = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(wsRoot, '.gitignore'));
      existing = new TextDecoder().decode(bytes);
    } catch { /* file absent — not logged, this is the normal case for a fresh workspace */ }
    if (!existing.split('\n').some(line => line.trim() === '.jira-context/')) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(wsRoot, '.gitignore'),
        enc.encode(existing + prefix + '.jira-context/\n'),
      );
    }
  } catch (err) {
    logDiag('jira.load', 'warn', 'Could not update .gitignore', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
```

- [ ] **Step 5: Compile**

Run: `npm run compile`

- [ ] **Step 6: Commit**

```bash
git add src/participant/jira/loadHandler.ts
git commit -m "feat(diag): log loadHandler catch sites (attachment download, file write, gitignore update)"
```

---

## Task 14: `contentHandler.ts`

**Files:** Modify `src/participant/jira/contentHandler.ts`

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the unreadable-file catch (lines 22-29)**

```ts
// Before
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const name = uri.path.split('/').pop() ?? uri.fsPath;
      const truncated = bytes.byteLength > FILE_MAX_BYTES;
      const slice = truncated ? bytes.slice(0, FILE_MAX_BYTES) : bytes;
      const text = decoder.decode(slice) + (truncated ? '\n\n[... truncated ...]' : '');
      sections.push(`### ${name}\n\`\`\`\n${text}\n\`\`\``);
    } catch { /* skip unreadable files */ }

// After
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const name = uri.path.split('/').pop() ?? uri.fsPath;
      const truncated = bytes.byteLength > FILE_MAX_BYTES;
      const slice = truncated ? bytes.slice(0, FILE_MAX_BYTES) : bytes;
      const text = decoder.decode(slice) + (truncated ? '\n\n[... truncated ...]' : '');
      sections.push(`### ${name}\n\`\`\`\n${text}\n\`\`\``);
    } catch (err) {
      logDiag('jira.content', 'warn', `Could not read referenced file — ${uri.fsPath}`, {
        path: uri.fsPath, error: err instanceof Error ? err.message : String(err),
      });
    }
```

- [ ] **Step 3: Compile**

Run: `npm run compile`

- [ ] **Step 4: Commit**

```bash
git add src/participant/jira/contentHandler.ts
git commit -m "feat(diag): log contentHandler's unreadable-file catch"
```

---

## Task 15: `workflowHandler.ts`

**Files:** Modify `src/participant/jira/workflowHandler.ts`

This file has no `catch` blocks — only the "workflow discovered" major-op log is being added.

- [ ] **Step 1: Add the import** (as new line 2, after `import * as vscode from 'vscode';`)

```ts
import { logDiag } from '../../utils/diagLog';
```

- [ ] **Step 2: Log the workflow-discovered major op**

```ts
// Before (tail of handleDiscoverWorkflow)
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${lines.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  const trulySkipped = skippedStatuses.filter(s => !preserved.includes(s));
  if (preserved.length > 0) {
    summary += `\n\n_${preserved.length} status(es) had no tickets and kept cached transitions: ${preserved.join(', ')}._`;
  }
  if (trulySkipped.length > 0) {
    summary += `\n\n⚠️ **${trulySkipped.length} status(es) had no tickets and no cached transitions:** ${trulySkipped.join(', ')}. Re-run discovery once tickets exist in those states.`;
  }
  stream.markdown(summary);
}

// After
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${lines.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  const trulySkipped = skippedStatuses.filter(s => !preserved.includes(s));
  if (preserved.length > 0) {
    summary += `\n\n_${preserved.length} status(es) had no tickets and kept cached transitions: ${preserved.join(', ')}._`;
  }
  if (trulySkipped.length > 0) {
    summary += `\n\n⚠️ **${trulySkipped.length} status(es) had no tickets and no cached transitions:** ${trulySkipped.join(', ')}. Re-run discovery once tickets exist in those states.`;
  }
  logDiag('jira.workflow', 'info', `Workflow discovered — ${projectKey}/${issueType}`, {
    projectKey, issueType, statusCount: lines.length, preservedCount: preserved.length, trulySkippedCount: trulySkipped.length,
  });
  stream.markdown(summary);
}
```

- [ ] **Step 3: Compile**

Run: `npm run compile`

- [ ] **Step 4: Commit**

```bash
git add src/participant/jira/workflowHandler.ts
git commit -m "feat(diag): log workflow-discovered major op"
```

---

## Task 16: `extension.ts`

**Files:** Modify `src/extension.ts`

- [ ] **Step 1: Add the import** (alongside the other local imports near the top of the file)

```ts
import { logDiag } from './utils/diagLog';
```

- [ ] **Step 2: Wire `onDiag` into the 2 `JiraApiClient` construction sites**

`importEml` command (around line 118):

```ts
// Before
const jiraClient = new JiraApiClient({ baseUrl: config.baseUrl, authType: config.authType, token: config.token });

// After
const jiraClient = new JiraApiClient({
  baseUrl: config.baseUrl,
  authType: config.authType,
  token: config.token,
  onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
});
```

`importVeracodeReport` command (around line 238) — apply the identical change.

- [ ] **Step 3: Log the `.eml` readFile catch (lines 91-97)**

```ts
// Before
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(emlPath);
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

// After
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(emlPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
        return;
      }
```

- [ ] **Step 4: Log the `.eml` parse catch (lines 99-105)**

```ts
// Before
      let parsed: ParsedEml;
      try {
        parsed = await parseEml(buffer);
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse email: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

// After
      let parsed: ParsedEml;
      try {
        parsed = await parseEml(buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse email: ${message}`);
        return;
      }
```

- [ ] **Step 5: Log the template-load fail-soft catch, `importEml` (lines 121-127)**

```ts
// Before
      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
        } catch { return []; }
      })();

// After
      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();
```

- [ ] **Step 6: Log the issue-types `.catch()`, `importEml` (lines 129-136)**

```ts
// Before
      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Story'. ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as string[];
        });

// After
      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Story'. ${message}`,
          );
          return [] as string[];
        });
```

- [ ] **Step 7: Log the Veracode report stat/read catch (lines 187-198)**

```ts
// Before
      let raw: string;
      try {
        const stat = await fs.promises.stat(reportPath);
        if (stat.size > MAX_REPORT_BYTES) {
          vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
          return;
        }
        raw = await fs.promises.readFile(reportPath, 'utf-8');
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

// After
      let raw: string;
      try {
        const stat = await fs.promises.stat(reportPath);
        if (stat.size > MAX_REPORT_BYTES) {
          vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
          return;
        }
        raw = await fs.promises.readFile(reportPath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not read Veracode report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
        return;
      }
```

- [ ] **Step 8: Log the Veracode report parse catch (lines 201-211)**

```ts
// Before
      const veracodeCfg = vscode.workspace.getConfiguration('ticketSidekick');
      let flaws;
      try {
        const allFlaws = parseVeracodeReport(raw);
        flaws = filterFlaws(allFlaws, {
          minSeverity: veracodeCfg.get<number>('veracode.minSeverity') ?? 4,
          includeStatuses: veracodeCfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse Veracode report: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

// After
      const veracodeCfg = vscode.workspace.getConfiguration('ticketSidekick');
      let flaws;
      try {
        const allFlaws = parseVeracodeReport(raw);
        flaws = filterFlaws(allFlaws, {
          minSeverity: veracodeCfg.get<number>('veracode.minSeverity') ?? 4,
          includeStatuses: veracodeCfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not parse Veracode report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse Veracode report: ${message}`);
        return;
      }
```

- [ ] **Step 9: Log the template-load fail-soft catch, Veracode import (lines 241-247)**

```ts
// Before
      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
        } catch { return []; }
      })();

// After
      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();
```

- [ ] **Step 10: Log the issue-types `.catch()`, Veracode import (lines 249-256)**

```ts
// Before
      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Bug'. ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as string[];
        });

// After
      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Bug'. ${message}`,
          );
          return [] as string[];
        });
```

- [ ] **Step 11: Compile**

Run: `npm run compile`

- [ ] **Step 12: Run the full test suite**

Run: `npm test`
Expected: all green

- [ ] **Step 13: Commit**

```bash
git add src/extension.ts
git commit -m "feat(diag): log extension.ts catch sites, wire onDiag into JiraApiClient construction"
```

---

## Task 17: `CLAUDE.md` documentation

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1: Add table rows for the 2 new files**

In the "Key files" table, immediately before the existing `diagLog.ts` row, add:

```markdown
| `src/utils/diagTypes.ts` | `LogLevel` (`'info' \| 'warn' \| 'error'`) and `DiagLogger` types — no `vscode` import, so `TicketService`/`PrReviewService`/`JiraApiClient`/`BitbucketApiClient` can depend on them without pulling in `vscode` transitively |
| `src/utils/logRedaction.ts` | `sanitizeDetails()` — recursively redacts values whose key looks like a secret and truncates long strings before a `logDiag` details object is written to the Output Channel. Applied automatically inside `logDiag`; no call site invokes it directly |
```

- [ ] **Step 2: Update the existing `diagLog.ts` row**

```markdown
// Before
| `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` VS Code Output Channel singleton (`getOutputChannel()`) and `logDiag(scope, message, details?)` — the place for diagnostic detail beyond the chat transcript. Used by the Bitbucket review pipeline today; new features in either participant should log through it too |

// After
| `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` VS Code Output Channel singleton (`getOutputChannel()`) and `logDiag(scope, level, message, details?)` — the place for diagnostic detail beyond the chat transcript. `level` (`'info' \| 'warn' \| 'error'`) tags each line for skimmability; `details` is redacted/truncated via `logRedaction.ts` automatically. Used throughout both `@jira` and `@bitbucket` |
```

- [ ] **Step 3: Update the "Diagnostics" section**

```markdown
// Before
## Diagnostics

A shared VS Code Output Channel named `"Ticket Sidekick"` (`View → Output`,
via `getOutputChannel()`/`logDiag()` in `src/utils/diagLog.ts`) is the place
for anything a user or a future debugging session needs beyond the chat
transcript — model identity, retry attempts, raw API errors. It's used today
by the Bitbucket review pipeline's LLM retry logic (`src/utils/lmRetry.ts`,
wired into `BitbucketParticipant.ts`). **New features in either participant
should log through `logDiag()` too**, rather than inventing separate
console/output-channel logging.

// After
## Diagnostics

A shared VS Code Output Channel named `"Ticket Sidekick"` (`View → Output`,
via `getOutputChannel()`/`logDiag(scope, level, message, details?)` in
`src/utils/diagLog.ts`) is the place for anything a user or a future
debugging session needs beyond the chat transcript — model identity, retry
attempts, raw API errors, and major operations (ticket created, PR review
completed, cleanup batch run) across both `@jira` and `@bitbucket`. `level`
is `'info' | 'warn' | 'error'`; `details`, when given, is automatically
redacted/truncated by `src/utils/logRedaction.ts` before being written, so
call sites never need to sanitize their own data.

Files that already import `vscode` (both participant files, `extension.ts`,
all of `src/participant/jira/*Handler.ts`) call `logDiag` directly. The four
files that must stay `vscode`-free to remain loadable by Vitest
(`TicketService`, `PrReviewService`, `JiraApiClient`, `BitbucketApiClient`)
take an optional injected `onDiag?: DiagLogger` (constructor param on the
services, config field on the API clients) instead — the caller binds it to
a scope-tagged `logDiag` call at construction time, e.g.
`new TicketService(client, (level, msg, details) => logDiag('jira.ticketService', level, msg, details))`.
This mirrors the `onAttemptFailed` hook `src/utils/lmRetry.ts` already used
for the same reason. **New features in either participant should log
through `logDiag()`/`onDiag` too**, rather than inventing separate
console/output-channel logging.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document diagLog's level param, redaction, and the onDiag injection pattern"
```

---

## Deliberately excluded (no task — noted for spec-coverage completeness)

- **`src/participant/jira/ticketContext.ts`** — its only `catch` (`resolveTicketFromBranch`, silently returning `null` when `git branch --show-current` fails) is the normal outcome for any workspace that isn't a git repo, which happens on essentially every invocation for such a user. Logging it would spam the channel with an expected condition, not a diagnostic signal.
- **`src/services/ConfigService.ts`** — contains no `try`/`catch` at all (every method is a straight-line `async` read), and `getConfig()`/`getBitbucketConfig()` are re-read on every single participant invocation per existing design (no caching) — logging a line on every read would be pure noise for zero diagnostic value. No changes needed here.
- **`src/bitbucket/BitbucketApiClient.ts`'s Cloud diff `JSON.parse` fallback** (`getPullRequestDiff`) — see the note in Task 5. It fires on a normal, frequent response shape, not an error.
- **`src/services/TicketService.ts`'s `transitionAlongPath` catch** — see the note in Task 2. It's a control-flow retry; the richer-context caller (`cleanupHandler.ts`, Task 12) logs the real outcome.
- **`src/participant/reviewSessionState.ts`'s internal parsing fallbacks** (partial-JSON streaming retries) — expected, high-frequency control flow, not diagnostic signal. Out of scope for this pass.

---

## Final Verification

1. Run `npm run compile` — TypeScript type check passes with no errors.
2. Run `npm test` — full Vitest suite green, including all new tests added in Tasks 1-5.
3. Manual smoke test in a VS Code Extension Development Host (`F5`, or `npm run test:e2e` if convenient):
   - Configure Jira with a deliberately wrong token, run `@jira check` → confirm a `[ERROR] [jira.participant]` line with the failure detail appears in **View → Output → "Ticket Sidekick"**.
   - Configure Jira correctly, run `@jira create` and finish creating a ticket → confirm a `[INFO] [jira.ticketService] Ticket created — KEY-123` line appears.
   - Run `@bitbucket review <a real PR URL>` → confirm `[INFO] [bitbucket.review]` lines appear for "model in use", each batch start, and "PR review completed", and that no raw token/secret or oversized diff/description text appears anywhere in the output (only short, redacted/truncated summaries).
4. Confirm the Output Channel content is legible: timestamps, `[LEVEL]` tags, and scopes are all present and correctly formatted on every line written during the smoke test.
