# Status Transition Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `@jira` to bulk-transition tickets to a target state following auto-discovered workflow paths, with subtask handling, a chat-native review screen, and streaming execution feedback.

**Architecture:**
- `WorkflowService` — discovers workflow graph by sampling tickets, caches to `.jira-workflow-cache.json`, BFS path-finding
- `TemplateService` (extended) — reads `cleanupRules` from `.jira-templates.json`
- `TicketService` (extended) — `getOpenSubtasks`, `transitionAlongPath`
- `sessionState.ts` (extended) — `TransitionBatchSession`, `parseSkipInput`
- `JiraParticipant.ts` (extended) — three new flows: discover workflow, cleanup review, cleanup execution

**Tech Stack:** TypeScript, VS Code Extension API, Jira REST API v3

---

## File Map

**Create:**
- `src/services/WorkflowService.ts`
- `src/test/WorkflowService.test.ts`
- `src/test/fixtures/workflow-cache-VSJI.json`
- `src/test/fixtures/resolutions.json`

**Modify:**
- `src/jira/IJiraClient.ts` — add `JiraSubtask`, extend `JiraIssue.fields`, `getResolutions`, update `executeTransition`
- `src/jira/JiraApiClient.ts` — implement both
- `src/test/mocks/MockJiraClient.ts` — implement both; add subtasks to `getIssue` stub
- `src/test/fixtures/ticket-PROJ-123.json` — add `subtasks` array
- `src/templates/TemplateService.ts` — add `CleanupRule`, read `cleanupRules`
- `src/test/TemplateService.test.ts` — cleanupRules tests
- `src/services/TicketService.ts` — `getOpenSubtasks`, `transitionAlongPath`
- `src/test/TicketService.test.ts` — new cases
- `src/participant/sessionState.ts` — `TransitionBatchSession`, `parseSkipInput`
- `src/test/JiraParticipant.test.ts` — `parseSkipInput` tests
- `src/participant/JiraParticipant.ts` — discover + cleanup flows

---

## Task 1: Extend client types and API

**Files:** `src/jira/IJiraClient.ts`, `src/jira/JiraApiClient.ts`, `src/test/mocks/MockJiraClient.ts`

- [ ] **Add `JiraSubtask` and extend `JiraIssue` in `IJiraClient.ts`**

```typescript
export interface JiraSubtask {
  key: string;
  fields: { summary: string; status: { name: string } };
}
```

Add to `JiraIssue.fields` (inside the existing fields object):
```typescript
subtasks?: JiraSubtask[];
```

- [ ] **Add `getResolutions` and update `executeTransition` in `IJiraClient.ts`**

```typescript
getResolutions(): Promise<Array<{ name: string }>>;
executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void>;
```

- [ ] **Implement in `JiraApiClient.ts`**

```typescript
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
```

- [ ] **Implement in `MockJiraClient.ts`**

Update `executeTransitionCalls` to capture fields:
```typescript
public executeTransitionCalls: Array<{ issueKey: string; transitionId: string; fields?: Record<string, unknown> }> = [];

async executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
  this.executeTransitionCalls.push({ issueKey, transitionId, fields });
}

async getResolutions(): Promise<Array<{ name: string }>> {
  return loadFixture<Array<{ name: string }>>('resolutions.json');
}
```

- [ ] **Create `src/test/fixtures/resolutions.json`**

```json
[
  { "name": "Fixed" },
  { "name": "Won't Fix" },
  { "name": "Duplicate" },
  { "name": "Done" },
  { "name": "Cannot Reproduce" }
]
```

- [ ] **Add subtasks to `src/test/fixtures/ticket-PROJ-123.json`**

Inside `fields`, add:
```json
"subtasks": [
  { "key": "PROJ-124", "fields": { "summary": "Write unit tests", "status": { "name": "In Progress" } } },
  { "key": "PROJ-125", "fields": { "summary": "Code review", "status": { "name": "Done" } } }
]
```

- [ ] **Run `npm run compile && npm test` — verify all 112 tests still pass**

---

## Task 2: WorkflowService — types, cache I/O, BFS

**Files:** `src/services/WorkflowService.ts`, `src/test/fixtures/workflow-cache-VSJI.json`

- [ ] **Create `src/services/WorkflowService.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IJiraClient } from '../jira/IJiraClient';

export interface CachedTransition {
  id: string;
  name: string;
  to: string;
}

export type WorkflowGraph = Record<string, CachedTransition[]>;

export interface WorkflowCache {
  [project: string]: {
    [issueType: string]: {
      discovered: string;
      graph: WorkflowGraph;
    };
  };
}

export function loadWorkflowCache(workspaceRoot: string): WorkflowCache {
  const path = join(workspaceRoot, '.jira-workflow-cache.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WorkflowCache;
  } catch {
    return {};
  }
}

export function saveWorkflowCache(workspaceRoot: string, cache: WorkflowCache): void {
  const path = join(workspaceRoot, '.jira-workflow-cache.json');
  writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8');
}

export function findPath(graph: WorkflowGraph, from: string, to: string): CachedTransition[] | null {
  if (from === to) return [];
  const queue: Array<{ state: string; path: CachedTransition[] }> = [{ state: from, path: [] }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { state, path } = queue.shift()!;
    if (visited.has(state)) continue;
    visited.add(state);
    for (const t of graph[state] ?? []) {
      const newPath = [...path, t];
      if (t.to === to) return newPath;
      queue.push({ state: t.to, path: newPath });
    }
  }
  return null;
}

export async function discoverWorkflow(
  client: IJiraClient,
  projectKey: string,
  issueType: string,
): Promise<WorkflowGraph> {
  const result = await client.searchJql(
    `project = ${projectKey} AND issuetype = "${issueType}"`,
    50,
  );
  const representativeByStatus = new Map<string, string>();
  for (const issue of result.issues) {
    const status = issue.fields.status.name;
    if (!representativeByStatus.has(status)) {
      representativeByStatus.set(status, issue.key);
    }
  }
  const graph: WorkflowGraph = {};
  for (const [status, issueKey] of representativeByStatus) {
    const transitions = await client.getTransitions(issueKey);
    graph[status] = transitions.map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
  }
  return graph;
}
```

- [ ] **Create `src/test/fixtures/workflow-cache-VSJI.json`**

```json
{
  "VSJI": {
    "Bug": {
      "discovered": "2026-05-11",
      "graph": {
        "Open": [
          { "id": "11", "name": "Start Progress", "to": "In Progress" }
        ],
        "In Progress": [
          { "id": "21", "name": "Submit for Review", "to": "In Review" },
          { "id": "31", "name": "Done", "to": "Done" }
        ],
        "In Review": [
          { "id": "41", "name": "Approve", "to": "Done" },
          { "id": "42", "name": "Send Back", "to": "In Progress" }
        ],
        "Blocked": [
          { "id": "51", "name": "Unblock", "to": "In Progress" }
        ]
      }
    }
  }
}
```

- [ ] **Run `npm run compile` — no errors**

---

## Task 3: WorkflowService tests

**Files:** `src/test/WorkflowService.test.ts`

- [ ] **Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { findPath, loadWorkflowCache, discoverWorkflow } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';

const FIXTURE_ROOT = resolve(process.cwd(), 'src/test/fixtures');

const graph = {
  'Open':        [{ id: '11', name: 'Start Progress', to: 'In Progress' }],
  'In Progress': [{ id: '21', name: 'Submit for Review', to: 'In Review' },
                  { id: '31', name: 'Done', to: 'Done' }],
  'In Review':   [{ id: '41', name: 'Approve', to: 'Done' }],
  'Blocked':     [{ id: '51', name: 'Unblock', to: 'In Progress' }],
};

describe('findPath', () => {
  it('finds a direct path', () => {
    const path = findPath(graph, 'In Review', 'Done');
    expect(path).toHaveLength(1);
    expect(path![0].name).toBe('Approve');
  });

  it('finds a multi-hop path', () => {
    const path = findPath(graph, 'Open', 'Done');
    expect(path).toHaveLength(3);
    expect(path!.map((t) => t.to)).toEqual(['In Progress', 'In Review', 'Done']);
  });

  it('finds shortest path when multiple routes exist', () => {
    const path = findPath(graph, 'In Progress', 'Done');
    expect(path).toHaveLength(1);
    expect(path![0].name).toBe('Done');
  });

  it('returns null when no path exists', () => {
    expect(findPath(graph, 'Done', 'Open')).toBeNull();
  });

  it('returns empty array when already at target', () => {
    expect(findPath(graph, 'Done', 'Done')).toEqual([]);
  });
});

describe('loadWorkflowCache', () => {
  it('returns empty object when file absent', () => {
    expect(loadWorkflowCache('/nonexistent')).toEqual({});
  });
});

describe('discoverWorkflow', () => {
  it('builds graph from ticket samples', async () => {
    const client = new MockJiraClient();
    const result = await discoverWorkflow(client, 'PROJ', 'Bug');
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Run `npm test` — new tests pass**

---

## Task 4: CleanupRule in TemplateService

**Files:** `src/templates/TemplateService.ts`, `src/test/TemplateService.test.ts`, `src/test/fixtures/templates-valid/.jira-templates.json`

- [ ] **Add `CleanupRule` interface and extend `loadTemplates` in `TemplateService.ts`**

```typescript
export interface CleanupRule {
  name: string;
  project: string;
  issueType: string;
  targetState: string;
  resolution?: string;
  closeSubtasks?: boolean;
}
```

Change return type of `loadTemplates`:
```typescript
loadTemplates(): { templates: JiraTemplate[]; cleanupRules: CleanupRule[] } {
  // ...
  const data = JSON.parse(raw) as { templates?: JiraTemplate[]; cleanupRules?: CleanupRule[] };
  return {
    templates: data.templates ?? [],
    cleanupRules: data.cleanupRules ?? [],
  };
}
```

Update all callers in `JiraParticipant.ts` — they use `new TemplateService(root).loadTemplates()` and access `.templates` directly; change to destructure:
```typescript
const { templates } = new TemplateService(workspaceRoot).loadTemplates();
```

- [ ] **Add `cleanupRules` to `src/test/fixtures/templates-valid/.jira-templates.json`**

```json
{
  "templates": [ ... ],
  "cleanupRules": [
    {
      "name": "Close released bugs",
      "project": "PROJ",
      "issueType": "Bug",
      "targetState": "Done",
      "resolution": "Fixed",
      "closeSubtasks": true
    }
  ]
}
```

- [ ] **Add tests to `TemplateService.test.ts`**

```typescript
it('returns cleanupRules from config', () => {
  const { cleanupRules } = new TemplateService(VALID_ROOT).loadTemplates();
  expect(cleanupRules).toHaveLength(1);
  expect(cleanupRules[0].name).toBe('Close released bugs');
  expect(cleanupRules[0].resolution).toBe('Fixed');
});

it('returns empty cleanupRules when absent', () => {
  const { cleanupRules } = new TemplateService('/nonexistent').loadTemplates();
  expect(cleanupRules).toEqual([]);
});
```

- [ ] **Run `npm run compile && npm test` — all pass**

---

## Task 5: TicketService — getOpenSubtasks and transitionAlongPath

**Files:** `src/services/TicketService.ts`, `src/test/TicketService.test.ts`

- [ ] **Add to `TicketService.ts`**

```typescript
async getOpenSubtasks(issueKey: string): Promise<Array<{ key: string; summary: string; currentStatus: string }>> {
  const issue = await this.client.getIssue(issueKey);
  return (issue.fields.subtasks ?? [])
    .filter((s) => s.fields.status.name !== 'Done')
    .map((s) => ({ key: s.key, summary: s.fields.summary, currentStatus: s.fields.status.name }));
}

async transitionAlongPath(
  issueKey: string,
  path: Array<{ id: string; name: string; to: string }>,
  resolution?: string,
): Promise<void> {
  for (const step of path) {
    const fields: Record<string, unknown> = {};
    if (resolution && step.to === path.at(-1)!.to) fields.resolution = { name: resolution };
    await this.client.executeTransition(issueKey, step.id, Object.keys(fields).length > 0 ? fields : undefined);
  }
}
```

Note: resolution is only sent on the final transition step (the one that reaches the target state).

- [ ] **Write tests in `TicketService.test.ts`**

```typescript
describe('getOpenSubtasks', () => {
  it('returns only non-Done subtasks', async () => {
    const subtasks = await service.getOpenSubtasks('PROJ-123');
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0].key).toBe('PROJ-124');
    expect(subtasks[0].currentStatus).toBe('In Progress');
  });
});

describe('transitionAlongPath', () => {
  it('calls executeTransition for each step', async () => {
    const path = [
      { id: '21', name: 'Submit for Review', to: 'In Review' },
      { id: '41', name: 'Approve', to: 'Done' },
    ];
    await service.transitionAlongPath('PROJ-123', path, 'Fixed');
    expect(client.executeTransitionCalls).toHaveLength(2);
    expect(client.executeTransitionCalls[0].fields).toBeUndefined();
    expect(client.executeTransitionCalls[1].fields).toEqual({ resolution: { name: 'Fixed' } });
  });

  it('works without resolution', async () => {
    const path = [{ id: '21', name: 'Submit for Review', to: 'In Review' }];
    await service.transitionAlongPath('PROJ-123', path);
    expect(client.executeTransitionCalls[0].fields).toBeUndefined();
  });
});
```

- [ ] **Run `npm run compile && npm test` — all pass**

---

## Task 6: sessionState — TransitionBatchSession and parseSkipInput

**Files:** `src/participant/sessionState.ts`, `src/test/JiraParticipant.test.ts`

- [ ] **Add to `sessionState.ts`**

```typescript
export interface TransitionSubtask {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
}

export interface TransitionBatchTicket {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  subtasks: TransitionSubtask[];
}

export interface TransitionBatchSession {
  tickets: TransitionBatchTicket[];
  resolution: string | undefined;
  ruleName: string | undefined;
}

export type SkipParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'skip'; keys: string[] }
  | { action: 'invalid' };

export function parseSkipInput(reply: string, tickets: TransitionBatchTicket[]): SkipParseResult {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'ok') return { action: 'ok' };
  if (normalized === 'c' || normalized === 'cancel') return { action: 'cancel' };

  const parts = normalized.split(/\s+/).filter(Boolean);
  const allKeys = new Map<string, string>(); // numeric suffix → full key
  for (const t of tickets) {
    allKeys.set(t.key.split('-')[1], t.key);
    for (const s of t.subtasks) allKeys.set(s.key.split('-')[1], s.key);
  }

  const mentioned = new Set<string>();
  for (const p of parts) {
    const key = allKeys.get(p);
    if (key) mentioned.add(key);
  }
  if (mentioned.size === 0) return { action: 'invalid' };

  // Cascade: subtask mentioned → also skip parent; parent mentioned → also skip all subtasks
  const expanded = new Set(mentioned);
  for (const t of tickets) {
    if (mentioned.has(t.key)) {
      for (const s of t.subtasks) expanded.add(s.key);
    }
    for (const s of t.subtasks) {
      if (mentioned.has(s.key)) expanded.add(t.key);
    }
  }
  return { action: 'skip', keys: [...expanded] };
}
```

- [ ] **Add tests to `JiraParticipant.test.ts`**

```typescript
import { ..., parseSkipInput } from '../participant/sessionState';

describe('parseSkipInput', () => {
  const tickets = [
    {
      key: 'PROJ-10', summary: 'Login bug', currentStatus: 'In Review',
      transitionPath: [{ id: '41', name: 'Approve', to: 'Done' }],
      subtasks: [
        { key: 'PROJ-11', summary: 'Write tests', currentStatus: 'In Progress', transitionPath: [] },
        { key: 'PROJ-12', summary: 'Code review', currentStatus: 'Open', transitionPath: [] },
      ],
    },
    {
      key: 'PROJ-14', summary: 'Dark mode', currentStatus: 'Blocked',
      transitionPath: [], subtasks: [],
    },
  ];

  it('returns ok for "ok"', () => {
    expect(parseSkipInput('ok', tickets)).toEqual({ action: 'ok' });
  });

  it('returns cancel for "c" and "cancel"', () => {
    expect(parseSkipInput('c', tickets)).toEqual({ action: 'cancel' });
    expect(parseSkipInput('cancel', tickets)).toEqual({ action: 'cancel' });
  });

  it('skipping a subtask also skips the parent', () => {
    const result = parseSkipInput('11', tickets);
    expect(result).toMatchObject({ action: 'skip' });
    expect((result as { action: 'skip'; keys: string[] }).keys).toContain('PROJ-11');
    expect((result as { action: 'skip'; keys: string[] }).keys).toContain('PROJ-10');
  });

  it('skipping a parent also skips all its subtasks', () => {
    const result = parseSkipInput('10', tickets);
    expect(result).toMatchObject({ action: 'skip' });
    const keys = (result as { action: 'skip'; keys: string[] }).keys;
    expect(keys).toContain('PROJ-10');
    expect(keys).toContain('PROJ-11');
    expect(keys).toContain('PROJ-12');
  });

  it('skips multiple groups', () => {
    const result = parseSkipInput('11 14', tickets);
    const keys = (result as { action: 'skip'; keys: string[] }).keys;
    expect(keys).toContain('PROJ-11');
    expect(keys).toContain('PROJ-10');
    expect(keys).toContain('PROJ-14');
  });

  it('returns invalid for unrecognised input', () => {
    expect(parseSkipInput('something', tickets)).toEqual({ action: 'invalid' });
    expect(parseSkipInput('', tickets)).toEqual({ action: 'invalid' });
  });

  it('trims whitespace', () => {
    expect(parseSkipInput('  ok  ', tickets)).toEqual({ action: 'ok' });
  });
});
```

- [ ] **Run `npm run compile && npm test` — all pass**

---

## Task 7: JiraParticipant — discover workflow command

**Files:** `src/participant/JiraParticipant.ts`

- [ ] **Add `discoverWorkflow` to the `Operation` union type**

```typescript
type Operation = ... | 'discoverWorkflow' | 'runCleanup';
```

- [ ] **Add `cleanupRuleName` and `fixVersion` to `ParsedIntent`**

```typescript
interface ParsedIntent {
  ...
  cleanupRuleName: string | null;
  fixVersion: string | null;
}
```

- [ ] **Update `INTENT_PROMPT` schema and instructions**

Add to schema: `"cleanupRuleName":string|null,"fixVersion":string|null`

Add to instructions:
```
- discoverWorkflow: discover or refresh the workflow graph for a project and issue type; projectKey and issueType are required
- runCleanup: bulk-transition tickets using a named cleanup rule or ad-hoc criteria; cleanupRuleName is the quoted rule name if given; fixVersion is the exact fix version name if given (must be quoted in the prompt)
```

- [ ] **Add `discoverWorkflow` handler function**

```typescript
async function handleDiscoverWorkflow(
  request: vscode.ChatRequest,
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  jiraClient: JiraApiClient,
): Promise<void> {
  const projectKey = intent.projectKey;
  const issueType = intent.issueType;
  if (!projectKey || !issueType) {
    stream.markdown('Please specify a project and issue type, e.g. `@jira discover workflow VSJI Bug`.');
    return;
  }
  stream.markdown(`_Discovering workflow for **${projectKey}** / **${issueType}**…_\n\n`);
  const graph = await discoverWorkflow(jiraClient, projectKey, issueType);
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    stream.markdown(`No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`);
    return;
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const cache = loadWorkflowCache(workspaceRoot);
  cache[projectKey] ??= {};
  cache[projectKey][issueType] = { discovered: new Date().toISOString().slice(0, 10), graph };
  saveWorkflowCache(workspaceRoot, cache);

  // Stream a human-readable summary
  const lines = statuses.map((s) => {
    const targets = graph[s].map((t) => `${t.name} → **${t.to}**`).join(', ');
    return `**${s}**: ${targets}`;
  });
  stream.markdown(`Workflow discovered for **${projectKey} / ${issueType}** (${statuses.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`);
}
```

- [ ] **Wire into the main handler switch**

```typescript
case 'discoverWorkflow':
  await handleDiscoverWorkflow(request, intent, stream, jiraClient);
  return;
```

Import `discoverWorkflow`, `loadWorkflowCache`, `saveWorkflowCache` from `WorkflowService`.

- [ ] **Run `npm run compile` — no errors**

---

## Task 8: JiraParticipant — cleanup review screen

**Files:** `src/participant/JiraParticipant.ts`

This task builds the `TransitionBatchSession`, streams the review screen, and stores it. Execution happens in Task 9.

- [ ] **Add `streamReviewScreen` helper**

```typescript
async function streamReviewScreen(
  session: TransitionBatchSession,
  stream: vscode.ChatResponseStream,
  workspaceState: vscode.Memento,
  header: string,
): Promise<void> {
  await workspaceState.update('jira.session.transitionReview', session);
  const lines: string[] = [header, ''];
  for (const t of session.tickets) {
    const finalState = t.transitionPath.at(-1)?.to ?? '?';
    lines.push(`**${t.key}**  ${t.summary}  ·  _${t.currentStatus} → ${finalState}_`);
    for (const s of t.subtasks) {
      const sFinal = s.transitionPath.at(-1)?.to ?? '?';
      lines.push(`  **${s.key}**  ${s.summary}  ·  _${s.currentStatus} → ${sFinal}_`);
    }
  }
  lines.push('', 'ok · (c) · key numbers to skip (e.g. 11 14)');
  stream.markdown(lines.join('\n') + '\n\n<!-- jira:transition-review -->');
}
```

- [ ] **Add `handleRunCleanup` function**

```typescript
async function handleRunCleanup(
  request: vscode.ChatRequest,
  intent: ParsedIntent,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  jiraClient: JiraApiClient,
  ticketService: TicketService,
  workspaceState: vscode.Memento,
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // Load cleanup rule
  const { cleanupRules } = new TemplateService(workspaceRoot).loadTemplates();
  const rule = cleanupRules.find((r) => r.name === intent.cleanupRuleName) ?? null;
  if (!rule && !intent.projectKey) {
    stream.markdown('No cleanup rule found. Use `@jira run cleanup "rule name"` or specify a project and issue type.');
    return;
  }
  const project = rule?.project ?? intent.projectKey!;
  const issueType = rule?.issueType ?? intent.issueType ?? 'Bug';
  const targetState = rule?.targetState ?? 'Done';
  const resolution = rule?.resolution;

  // Load workflow cache
  const cache = loadWorkflowCache(workspaceRoot);
  const graph = cache[project]?.[issueType]?.graph;
  if (!graph) {
    stream.markdown(`No workflow cache for **${project} / ${issueType}**. Run \`@jira discover workflow ${project} ${issueType}\` first.`);
    return;
  }

  // Build JQL
  const fixVersion = intent.fixVersion ?? null;
  let jql = `project = ${project} AND issuetype = "${issueType}" AND status != "${targetState}"`;
  if (fixVersion) jql += ` AND fixVersion = "${fixVersion}"`;

  // Search
  stream.markdown(`_Searching for tickets…_\n\n`);
  const result = await ticketService.searchTicketsRaw(jql, 50);
  // Note: add searchTicketsRaw(jql, maxResults): Promise<JiraSearchResult> to TicketService
  // that returns the raw result (not formatted markdown).

  if (result.issues.length === 0) {
    stream.markdown('No tickets found matching the criteria.');
    return;
  }
  if (result.total > 50) {
    stream.markdown(`_Found ${result.total} tickets — showing first 50. Refine your filter if needed._\n\n`);
  }

  // Build batch
  const BATCH_LIMIT = 50;
  const tickets: TransitionBatchTicket[] = [];
  for (const issue of result.issues.slice(0, BATCH_LIMIT)) {
    const path = findPath(graph, issue.fields.status.name, targetState);
    if (path === null) {
      stream.markdown(`_Warning: no path found from **${issue.fields.status.name}** to **${targetState}** for ${issue.key} — skipping._\n\n`);
      continue;
    }
    const openSubtasks = rule?.closeSubtasks
      ? await ticketService.getOpenSubtasks(issue.key)
      : [];
    const subtasks: TransitionSubtask[] = [];
    for (const s of openSubtasks) {
      const subPath = findPath(graph, s.currentStatus, targetState) ?? [];
      subtasks.push({ ...s, transitionPath: subPath });
    }
    tickets.push({
      key: issue.key,
      summary: issue.fields.summary,
      currentStatus: issue.fields.status.name,
      transitionPath: path,
      subtasks,
    });
  }

  if (tickets.length === 0) {
    stream.markdown('No tickets can be transitioned — all are either already at target state or have no valid path.');
    return;
  }

  // Resolution fallback: if not configured, ask in chat
  if (resolution === undefined) {
    // Check if any ticket's final transition likely needs a resolution (heuristic: target is Done/Resolved/Closed)
    const closedStates = new Set(['done', 'resolved', 'closed', 'won\'t fix']);
    if (closedStates.has(targetState.toLowerCase())) {
      const resolutions = await jiraClient.getResolutions();
      await workspaceState.update('jira.session.resolutionSelection', {
        tickets,
        ruleName: rule?.name,
        targetState,
        resolutionOptions: resolutions.map((r) => r.name),
      });
      const list = resolutions.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
      stream.markdown(`Which resolution should be set when transitioning to **${targetState}**?\n\n${list}\n\nReply with the name or number, or **none** to skip setting a resolution.\n\n<!-- jira:selecting-resolution -->`);
      return;
    }
  }

  const header = `**Cleanup${rule ? `: ${rule.name}` : ''}**  ·  ${project} / ${issueType}${fixVersion ? `  ·  Fix version "${fixVersion}"` : ''}`;
  const session: TransitionBatchSession = { tickets, resolution, ruleName: rule?.name };
  await streamReviewScreen(session, stream, workspaceState, header);
}
```

- [ ] **Add `searchTicketsRaw` to `TicketService`**

```typescript
async searchTicketsRaw(jql: string, maxResults = 50): Promise<JiraSearchResult> {
  return this.client.searchJql(jql, maxResults);
}
```

`JiraSearchResult` is already exported from `IJiraClient` — import it in TicketService.

- [ ] **Add session state key to CLAUDE.md session table**

| `TransitionBatchSession` | `jira.session.transitionReview` | `<!-- jira:transition-review -->` |

- [ ] **Wire `runCleanup` into handler**

```typescript
case 'runCleanup':
  await handleRunCleanup(request, intent, stream, token, jiraClient, ticketService, ws);
  return;
```

- [ ] **Run `npm run compile` — no errors**

---

## Task 9: JiraParticipant — resolution selection and cleanup execution

**Files:** `src/participant/sessionState.ts`, `src/participant/JiraParticipant.ts`

- [ ] **Add `ResolutionSelectionSession` to `sessionState.ts`**

```typescript
export interface ResolutionSelectionSession {
  tickets: TransitionBatchTicket[];
  ruleName: string | undefined;
  targetState: string;
  resolutionOptions: string[];
}

export function parseResolutionSelection(reply: string, options: string[]): string | null | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'skip') return null;
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) return options[num - 1];
  const match = options.find((o) => o.toLowerCase() === normalized);
  return match ?? 'invalid';
}
```

- [ ] **Add resolution selection handler in `JiraParticipant.ts`**

In the handler, after the template selection block and before issue type selection, add:

```typescript
if (lastResponse.includes('<!-- jira:selecting-resolution -->')) {
  const selSession = ws.get<ResolutionSelectionSession>('jira.session.resolutionSelection');
  if (selSession) {
    const choice = parseResolutionSelection(request.prompt, selSession.resolutionOptions);
    if (choice === 'invalid') {
      // Re-present the list
      const list = selSession.resolutionOptions.map((r, i) => `${i + 1}. ${r}`).join('\n');
      stream.markdown(`Please choose a resolution:\n\n${list}\n\nReply with name or number, or **none** to skip.\n\n<!-- jira:selecting-resolution -->`);
      return;
    }
    await ws.update('jira.session.resolutionSelection', undefined);
    const session: TransitionBatchSession = {
      tickets: selSession.tickets,
      resolution: choice ?? undefined,
      ruleName: selSession.ruleName,
    };
    const header = `**Cleanup${selSession.ruleName ? `: ${selSession.ruleName}` : ''}**`;
    await streamReviewScreen(session, stream, ws, header);
    return;
  }
}
```

- [ ] **Add `executeCleanupBatch` function**

```typescript
async function executeCleanupBatch(
  session: TransitionBatchSession,
  skipKeys: Set<string>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
): Promise<void> {
  let transitioned = 0;
  let failed = 0;
  const skipped = skipKeys.size;
  const failures: string[] = [];

  for (const ticket of session.tickets) {
    if (skipKeys.has(ticket.key)) continue;

    // Subtasks first
    for (const sub of ticket.subtasks) {
      if (skipKeys.has(sub.key)) continue;
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, session.resolution);
        const hops = sub.transitionPath.length;
        stream.markdown(`✓ ${sub.key}  → ${sub.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
        transitioned++;
      } catch (err) {
        stream.markdown(`✗ ${sub.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
        failures.push(sub.key);
        failed++;
      }
    }

    // Then parent
    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, session.resolution);
      const hops = ticket.transitionPath.length;
      stream.markdown(`✓ ${ticket.key}  → ${ticket.transitionPath.at(-1)?.to ?? '?'}${hops > 1 ? ` (${hops} hops)` : ''}\n`);
      transitioned++;
    } catch (err) {
      stream.markdown(`✗ ${ticket.key}  → failed: ${err instanceof Error ? err.message : String(err)}\n`);
      failures.push(ticket.key);
      failed++;
    }
  }

  // Summary
  const total = transitioned + failed + skipped;
  stream.markdown(`\n${total} tickets processed — ${transitioned} transitioned, ${failed} failed, ${skipped} skipped.`);
  if (failures.length > 0) {
    stream.markdown(`\nFailed: ${failures.join(', ')}\nIf caused by a workflow gap, run \`@jira discover workflow\` to refresh the cache.`);
  }
}
```

- [ ] **Add transition review session handler in main handler**

Detection order: after resolution selection, before issue type selection.

```typescript
if (lastResponse.includes('<!-- jira:transition-review -->')) {
  const session = ws.get<TransitionBatchSession>('jira.session.transitionReview');
  if (session) {
    const result = parseSkipInput(request.prompt, session.tickets);
    if (result.action === 'invalid') {
      // Re-present
      const header = `**Cleanup${session.ruleName ? `: ${session.ruleName}` : ''}**`;
      await streamReviewScreen(session, stream, ws, header);
      return;
    }
    await ws.update('jira.session.transitionReview', undefined);
    if (result.action === 'cancel') {
      stream.markdown('_Cancelled — no tickets were changed._');
      return;
    }
    const skipKeys = new Set<string>(result.action === 'skip' ? result.keys : []);
    try {
      await executeCleanupBatch(session, skipKeys, ticketService, stream);
    } catch (err) {
      stream.markdown(`${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
}
```

- [ ] **Run `npm run compile && npm test` — all pass**

---

## Task 10: Update CLAUDE.md

- [ ] **Add to session state table**

```markdown
| `ResolutionSelectionSession` | `jira.session.resolutionSelection` | `<!-- jira:selecting-resolution -->` |
| `TransitionBatchSession`     | `jira.session.transitionReview`    | `<!-- jira:transition-review -->`    |
```

- [ ] **Add workflow discovery and cleanup sections**

```markdown
## Workflow discovery

`@jira discover workflow VSJI Bug` samples tickets across all statuses, calls
`getTransitions` on a representative per status, and builds a directed graph.
Saved to `.jira-workflow-cache.json` at the workspace root. Re-run any time the
workflow changes.

`WorkflowService.findPath(graph, from, to)` uses BFS to find the shortest
sequence of transitions from the current status to the target state.

## Bulk cleanup

`cleanupRules` in `.jira-templates.json` define named rules:

- `project`, `issueType`, `targetState` — required
- `resolution` — optional; if omitted and target is a closed state, asked in chat once before the review screen
- `closeSubtasks` — if true, open subtasks appear in the review and are transitioned before their parent

Trigger: `@jira run cleanup "rule name"` or ad-hoc `@jira close VSJI bugs in "Fix Version 3.2"`.

Review screen shows all tickets with their subtasks and proposed transitions.
User replies: **ok**, **(c)** to cancel the run, or key numbers to skip (cascading:
subtask skip → parent skipped; parent skip → all subtasks skipped).

Execution streams one line per ticket (subtasks first), then a summary.
Failures are collected and reported at the end — the batch continues on failure.
```

- [ ] **Update detection order**

```
resolution selection → transition review → template selection → issue type selection → creation → content → more-comments → intent parse
```

- [ ] **Commit**

```bash
git add -A
git commit -m "feat: bulk status transition cleanup with workflow discovery"
```

---

## Verification checklist

Before considering the feature complete:

- `@jira discover workflow VSJI Bug` runs without error, writes `.jira-workflow-cache.json`
- `@jira run cleanup "Close released bugs"` shows the review screen with correct ticket tree
- `ok` transitions all tickets, streaming ✓/✗ per ticket
- `c` cancels with no API calls
- `11 14` in skip input skips the right groups (check cascading)
- A ticket with no path in the graph is warned and skipped, not crashing
- Resolution is set only on the final transition step
- Subtasks are transitioned before their parent
- Batch > 50 shows the size warning
- `npm run compile && npm test` green
