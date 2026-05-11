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
