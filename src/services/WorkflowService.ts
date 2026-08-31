import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IJiraClient } from '../jira/IJiraClient';
import type { TicketService } from './TicketService';

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

export function preserveSkippedStatuses(
  newGraph: WorkflowGraph,
  skippedStatuses: string[],
  oldGraph: WorkflowGraph,
): string[] {
  const preserved: string[] = [];
  for (const status of skippedStatuses) {
    if (oldGraph[status]) {
      newGraph[status] = oldGraph[status];
      preserved.push(status);
    }
  }
  return preserved;
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
): Promise<{ graph: WorkflowGraph; skippedStatuses: string[] }> {
  const statusNames = await client.getProjectStatuses(projectKey, issueType);

  const searches = await Promise.all(
    statusNames.map((status) =>
      client.searchJql(
        `project = ${projectKey} AND issuetype = "${issueType}" AND status = "${status}" ORDER BY updated DESC`,
        1,
      ),
    ),
  );

  const representativeByStatus = new Map<string, string>();
  const skippedStatuses: string[] = [];
  for (let i = 0; i < statusNames.length; i++) {
    const issue = searches[i].issues[0];
    if (issue) {
      representativeByStatus.set(statusNames[i], issue.key);
    } else {
      skippedStatuses.push(statusNames[i]);
    }
  }

  const entries = Array.from(representativeByStatus.entries());
  const transitionResults = await Promise.all(
    entries.map(([, issueKey]) => client.getTransitions(issueKey)),
  );

  const graph: WorkflowGraph = {};
  for (let i = 0; i < entries.length; i++) {
    const [status] = entries[i];
    graph[status] = transitionResults[i].map((t) => ({ id: t.id, name: t.name, to: t.to.name }));
  }
  return { graph, skippedStatuses };
}

/** Outcome of `resolveAndApplyTransition` — a discriminated result so each caller (chat markdown
 * vs. a Language Model tool's plain text) can format its own message without duplicating the
 * resolution algorithm itself (R3: one implementation, reused everywhere). */
export type TransitionResolution =
  | { kind: 'alreadyThere'; currentStatus: string }
  | { kind: 'direct'; toStatus: string }
  | { kind: 'multiHop'; toStatus: string; hops: number }
  | { kind: 'unavailable'; currentStatus: string; available: string[]; projectKey: string; issueType: string; hasCache: boolean };

/**
 * Resolves and applies a Jira ticket transition to `targetStatus`: already-there short-circuit,
 * then a direct transition if one exists, then a cached multi-hop workflow path
 * (`loadWorkflowCache`/`findPath`) as a fallback. Shared by `@jira`'s chat `'transition'`
 * operation and the `jira_transitionTicket` Language Model tool — previously each reimplemented
 * this same lookup independently.
 */
export async function resolveAndApplyTransition(
  jiraClient: IJiraClient,
  ticketService: TicketService,
  workspaceRoot: string,
  ticketKey: string,
  targetStatus: string,
  resolution?: string,
): Promise<TransitionResolution> {
  const issue = await jiraClient.getIssue(ticketKey);
  const currentStatus = issue.fields.status.name;
  if (currentStatus.toLowerCase() === targetStatus.toLowerCase()) {
    return { kind: 'alreadyThere', currentStatus };
  }

  const transitions = await jiraClient.getTransitions(ticketKey);
  const direct = transitions.find((t) => t.to.name.toLowerCase() === targetStatus.toLowerCase());
  if (direct) {
    await ticketService.transitionAlongPath(ticketKey, [{ id: direct.id, name: direct.name, to: direct.to.name }], resolution);
    return { kind: 'direct', toStatus: direct.to.name };
  }

  const projectKey = ticketKey.split('-')[0];
  const issueType = (issue.fields.issuetype as { name?: string } | undefined)?.name ?? '';
  const graph = loadWorkflowCache(workspaceRoot)[projectKey]?.[issueType]?.graph;
  if (graph) {
    const path = findPath(graph, currentStatus, targetStatus);
    if (path && path.length > 0) {
      await ticketService.transitionAlongPath(ticketKey, path, resolution);
      return { kind: 'multiHop', toStatus: targetStatus, hops: path.length };
    }
  }

  return {
    kind: 'unavailable',
    currentStatus,
    available: transitions.map((t) => t.to.name),
    projectKey,
    issueType,
    hasCache: !!graph,
  };
}

export interface WorkflowDiscoveryResult {
  graph: WorkflowGraph;
  skippedStatuses: string[];
  /** Statuses with no representative ticket this run whose transitions were carried over from
   * a prior cache entry (see `preserveSkippedStatuses`). Empty when nothing was cached yet, or
   * when discovery found no tickets at all (the cache is left untouched in that case). */
  preserved: string[];
}

/**
 * Samples a project/issue type's workflow (`discoverWorkflow`) and — when at least one status
 * was found — merges it into `.jira-workflow-cache.json`, preserving prior transitions for any
 * status this run didn't sample. Shared by `@jira`'s chat `'discoverWorkflow'` operation
 * (`src/participant/jira/workflowHandler.ts`) and the `jira_discoverWorkflow` Language Model
 * tool (`src/tools/jiraTools.ts`) — previously each reimplemented this same cache read/merge/
 * write sequence independently (R3).
 */
export async function discoverAndCacheWorkflow(
  jiraClient: IJiraClient,
  workspaceRoot: string,
  projectKey: string,
  issueType: string,
): Promise<WorkflowDiscoveryResult> {
  const { graph, skippedStatuses } = await discoverWorkflow(jiraClient, projectKey, issueType);
  if (Object.keys(graph).length === 0) {
    return { graph, skippedStatuses, preserved: [] };
  }

  const cache = loadWorkflowCache(workspaceRoot);
  if (!cache[projectKey]) cache[projectKey] = {};
  const oldGraph = cache[projectKey][issueType]?.graph ?? {};
  const preserved = preserveSkippedStatuses(graph, skippedStatuses, oldGraph);
  cache[projectKey][issueType] = { discovered: new Date().toISOString().slice(0, 10), graph };
  saveWorkflowCache(workspaceRoot, cache);

  return { graph, skippedStatuses, preserved };
}
