import { describe, it, expect } from 'vitest';
import { findPath, loadWorkflowCache, discoverWorkflow } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';

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
    expect(path).toHaveLength(2);
    expect(path!.map((t) => t.to)).toEqual(['In Progress', 'Done']);
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
  it('discovers all statuses declared by the project schema', async () => {
    const client = new MockJiraClient();
    const { graph } = await discoverWorkflow(client, 'PROJ', 'Bug');
    // fixture declares 4 statuses for Bug
    expect(Object.keys(graph)).toHaveLength(4);
    expect(Object.keys(graph)).toContain('To Do');
    expect(Object.keys(graph)).toContain('In Progress');
    expect(Object.keys(graph)).toContain('In Review');
    expect(Object.keys(graph)).toContain('Done');
  });

  it('each status node has transitions with id, name, to', async () => {
    const client = new MockJiraClient();
    const { graph } = await discoverWorkflow(client, 'PROJ', 'Bug');
    for (const transitions of Object.values(graph)) {
      expect(transitions.length).toBeGreaterThan(0);
      expect(transitions[0]).toHaveProperty('id');
      expect(transitions[0]).toHaveProperty('name');
      expect(transitions[0]).toHaveProperty('to');
    }
  });

  it('reports skipped statuses that have no representative ticket', async () => {
    const client = new MockJiraClient();
    client.searchJql = async (jql) => {
      if (jql.includes('"In Progress"')) {
        return {
          issues: [{ id: '1', key: 'PROJ-1', fields: { summary: 'x', description: null, status: { name: 'In Progress' }, assignee: null, reporter: null, priority: null, labels: [], fixVersions: [], comment: null } }],
          total: 1,
        };
      }
      return { issues: [], total: 0 };
    };
    const { graph, skippedStatuses } = await discoverWorkflow(client, 'PROJ', 'Bug');
    expect(Object.keys(graph)).toEqual(['In Progress']);
    expect(skippedStatuses).toContain('To Do');
    expect(skippedStatuses).toContain('Done');
  });

  it('returns empty graph when no statuses found for issue type', async () => {
    const client = new MockJiraClient();
    client.getProjectStatuses = async () => [];
    const { graph, skippedStatuses } = await discoverWorkflow(client, 'PROJ', 'Unknown');
    expect(graph).toEqual({});
    expect(skippedStatuses).toEqual([]);
  });
});
