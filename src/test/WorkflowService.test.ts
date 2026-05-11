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
  it('builds graph from ticket samples', async () => {
    const client = new MockJiraClient();
    const result = await discoverWorkflow(client, 'PROJ', 'Bug');
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
