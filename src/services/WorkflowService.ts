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
