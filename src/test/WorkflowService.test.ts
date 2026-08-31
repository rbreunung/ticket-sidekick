import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findPath, loadWorkflowCache, discoverWorkflow, preserveSkippedStatuses, resolveAndApplyTransition, discoverAndCacheWorkflow, saveWorkflowCache } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService, PartialTransitionError } from '../services/TicketService';

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

describe('preserveSkippedStatuses', () => {
  const oldTransitions = [{ id: '99', name: 'Close', to: 'Closed' }];

  it('copies transitions from oldGraph for each skipped status', () => {
    const newGraph = { 'Open': [{ id: '1', name: 'Start', to: 'In Progress' }] };
    const oldGraph = { 'Closed': oldTransitions };
    const preserved = preserveSkippedStatuses(newGraph, ['Closed'], oldGraph);
    expect(preserved).toEqual(['Closed']);
    expect(newGraph['Closed']).toBe(oldTransitions);
  });

  it('does not add a skipped status that has no entry in oldGraph', () => {
    const newGraph = { 'Open': [{ id: '1', name: 'Start', to: 'In Progress' }] };
    const preserved = preserveSkippedStatuses(newGraph, ['Ghost'], {});
    expect(preserved).toEqual([]);
    expect(newGraph['Ghost']).toBeUndefined();
  });

  it('returns empty array when skippedStatuses is empty', () => {
    const newGraph = { 'Open': [{ id: '1', name: 'Start', to: 'In Progress' }] };
    const preserved = preserveSkippedStatuses(newGraph, [], { 'Closed': oldTransitions });
    expect(preserved).toEqual([]);
  });

  it('preserves multiple skipped statuses present in oldGraph', () => {
    const newGraph = {};
    const oldGraph = {
      'Closed': oldTransitions,
      'Cancelled': [{ id: '88', name: 'Cancel', to: 'Cancelled' }],
    };
    const preserved = preserveSkippedStatuses(newGraph, ['Closed', 'Cancelled', 'Ghost'], oldGraph);
    expect(preserved).toEqual(['Closed', 'Cancelled']);
    expect(Object.keys(newGraph)).toHaveLength(2);
  });
});

describe('resolveAndApplyTransition', () => {
  // Fixture ticket PROJ-123 is "In Progress" with direct transitions to To Do/In Progress/In
  // Review/Done (transitions-PROJ-123.json) and no issuetype field (issueType resolves to '').
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('reports already-there without calling getTransitions or applying anything', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);

    const result = await resolveAndApplyTransition(client, service, '/nonexistent', 'PROJ-123', 'In Progress');

    expect(result).toEqual({ kind: 'alreadyThere', currentStatus: 'In Progress' });
    expect(client.executeTransitionCalls).toEqual([]);
  });

  it('applies a direct transition and reports the resolved status', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);

    const result = await resolveAndApplyTransition(client, service, '/nonexistent', 'PROJ-123', 'done');

    expect(result).toEqual({ kind: 'direct', toStatus: 'Done' });
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-123', transitionId: '41', fields: undefined }]);
  });

  it('falls back to a cached multi-hop path when no direct transition exists', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    saveWorkflowCache(tmpDir, {
      PROJ: {
        '': {
          discovered: '2020-01-01',
          graph: {
            'In Progress': [{ id: '31', name: 'Review', to: 'In Review' }],
            'In Review': [{ id: '99', name: 'Close', to: 'Closed' }],
          },
        },
      },
    });
    const client = new MockJiraClient();
    const service = new TicketService(client);

    const result = await resolveAndApplyTransition(client, service, tmpDir, 'PROJ-123', 'Closed');

    expect(result).toEqual({ kind: 'multiHop', toStatus: 'Closed', hops: 2 });
    expect(client.executeTransitionCalls).toEqual([
      { issueKey: 'PROJ-123', transitionId: '31', fields: undefined },
      { issueKey: 'PROJ-123', transitionId: '99', fields: undefined },
    ]);
  });

  it('reports a partial failure — with how far it got — when a multi-hop transition fails after the first hop', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    saveWorkflowCache(tmpDir, {
      PROJ: {
        '': {
          discovered: '2020-01-01',
          graph: {
            'In Progress': [{ id: '31', name: 'Review', to: 'In Review' }],
            'In Review': [{ id: '99', name: 'Close', to: 'Closed' }],
          },
        },
      },
    });
    const client = new MockJiraClient();
    let calls = 0;
    client.executeTransition = async (issueKey, transitionId) => {
      calls++;
      client.executeTransitionCalls.push({ issueKey, transitionId });
      if (calls === 2) throw new Error('Jira 500: internal error');
    };
    const service = new TicketService(client);

    const result = await resolveAndApplyTransition(client, service, tmpDir, 'PROJ-123', 'Closed');

    expect(result).toEqual({
      kind: 'partialFailure',
      completedHops: 1,
      totalHops: 2,
      landedStatus: 'In Review',
      targetStatus: 'Closed',
      error: expect.stringContaining('Jira 500: internal error'),
    });
    // Both hops were attempted (the second failed) — the ticket really did move to "In Review".
    expect(client.executeTransitionCalls).toHaveLength(2);
  });

  it('does not report a partial failure when the very first hop fails — nothing changed, so it throws normally', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    saveWorkflowCache(tmpDir, {
      PROJ: {
        '': {
          discovered: '2020-01-01',
          graph: {
            'In Progress': [{ id: '31', name: 'Review', to: 'In Review' }],
            'In Review': [{ id: '99', name: 'Close', to: 'Closed' }],
          },
        },
      },
    });
    const client = new MockJiraClient();
    client.executeTransition = async () => { throw new Error('Jira 403: forbidden'); };
    const service = new TicketService(client);

    await expect(resolveAndApplyTransition(client, service, tmpDir, 'PROJ-123', 'Closed'))
      .rejects.toThrow(PartialTransitionError);
  });

  it('reports unavailable with the real transition list when no direct or cached path exists', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);

    const result = await resolveAndApplyTransition(client, service, '/nonexistent', 'PROJ-123', 'Nonexistent Status');

    expect(result).toEqual({
      kind: 'unavailable',
      currentStatus: 'In Progress',
      available: ['To Do', 'In Progress', 'In Review', 'Done'],
      projectKey: 'PROJ',
      issueType: '',
      hasCache: false,
    });
    expect(client.executeTransitionCalls).toEqual([]);
  });
});

describe('discoverAndCacheWorkflow', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('does not touch the cache when discovery finds no statuses', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    const client = new MockJiraClient();
    client.getProjectStatuses = async () => [];

    const result = await discoverAndCacheWorkflow(client, tmpDir, 'PROJ', 'Unknown');

    expect(result).toEqual({ graph: {}, skippedStatuses: [], preserved: [] });
    expect(loadWorkflowCache(tmpDir)).toEqual({});
  });

  it('caches a freshly discovered graph and reports no preserved statuses on first discovery', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    const client = new MockJiraClient();

    const result = await discoverAndCacheWorkflow(client, tmpDir, 'PROJ', 'Bug');

    expect(Object.keys(result.graph)).toHaveLength(4);
    expect(result.preserved).toEqual([]);
    expect(loadWorkflowCache(tmpDir).PROJ.Bug.graph).toEqual(result.graph);
  });

  it('preserves a prior cache entry for a status this run could not sample', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ticket-sidekick-workflow-'));
    const staleTransitions = [{ id: '9', name: 'Reopen', to: 'In Progress' }];
    saveWorkflowCache(tmpDir, { PROJ: { Bug: { discovered: '2020-01-01', graph: { 'Done': staleTransitions } } } });
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

    const result = await discoverAndCacheWorkflow(client, tmpDir, 'PROJ', 'Bug');

    expect(result.skippedStatuses).toContain('Done');
    expect(result.preserved).toEqual(['Done']);
    expect(result.graph['Done']).toEqual(staleTransitions);
    expect(loadWorkflowCache(tmpDir).PROJ.Bug.graph['Done']).toEqual(staleTransitions);
  });
});
