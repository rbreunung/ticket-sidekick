import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

vi.mock('../services/WorkflowService', () => ({
  loadWorkflowCache: vi.fn(),
  findPath: vi.fn(),
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(function () { return ({
    loadTemplates: vi.fn(),
  }); }),
}));

import { streamReviewScreen, executeCleanupBatch, handleRunCleanup, buildStaleTicketGroups, transitionTickets } from '../participant/jira/cleanupHandler';
import { loadWorkflowCache, findPath } from '../services/WorkflowService';
import { TemplateService } from '../templates/TemplateService';
import type { TransitionBatchTicket, TransitionSubtask } from '../participant/sessionState';
import { buildReviewTable } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

const mockStream = () => ({ markdown: vi.fn() });
const mockWs = () => ({ get: vi.fn(), update: vi.fn() });

// streamReviewScreen now streams a trusted vscode.MarkdownString (its footer contains command
// links, U5) rather than a bare string — this file's mocked MarkdownString stores the raw text on
// `.value`, so callers reading the streamed output as a plain string go through this helper.
function markdownText(arg: unknown): string {
  return typeof arg === 'string' ? arg : (arg as { value: string }).value;
}

const dummyPath = [{ id: '1', name: 'Go', to: 'Done' }];

function makeTicket(key: string, overrides: Partial<TransitionBatchTicket> = {}): TransitionBatchTicket {
  return {
    key,
    summary: `Summary for ${key}`,
    currentStatus: 'Open',
    transitionPath: dummyPath,
    subtasks: [],
    included: true,
    ...overrides,
  };
}

function makeSubtask(key: string, overrides: Partial<TransitionSubtask> = {}): TransitionSubtask {
  return {
    key,
    summary: `Subtask ${key}`,
    currentStatus: 'Open',
    transitionPath: dummyPath,
    included: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// streamReviewScreen — resolution display
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// executeCleanupBatch — subtask resolution fallback
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// handleRunCleanup — JQL construction and behaviour
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildStaleTicketGroups / transitionTickets (U6)
// ---------------------------------------------------------------------------

describe('buildStaleTicketGroups', () => {
  let client: MockJiraClient;
  const bugGraph = { Open: [{ id: '1', name: 'Go', to: 'Done' }], Done: [] };

  function makeDetails(entries: Array<[string, string, string, string]>): Map<string, { summary: string; currentStatus: string; issueType: string }> {
    // [key, summary, currentStatus, issueType][]
    return new Map(entries.map(([key, summary, currentStatus, issueType]) => [key, { summary, currentStatus, issueType }]));
  }

  function withRules(cleanupRules: unknown[]): void {
    vi.mocked(TemplateService).mockImplementation(function () { return ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules }),
    }) as never; });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { discovered: '2024-01-01', graph: bugGraph } } });
  });

  it('AE1: a ticket with no matching cleanup rule is still selectable when its workflow is discovered (R10)', async () => {
    withRules([]);
    const details = makeDetails([['PROJ-1', 'Old finding', 'Open', 'Bug']]);

    const result = await buildStaleTicketGroups([{ key: 'PROJ-1', ids: ['1'] }], details, 'PROJ', client, '/workspace');

    expect(result.ineligible).toEqual([]);
    expect(result.groups).toEqual([{
      issueType: 'Bug', rules: [], graph: bugGraph,
      tickets: [{ key: 'PROJ-1', summary: 'Old finding', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false }],
    }]);
  });

  it('stores every matching cleanup rule for the group, not only the first', async () => {
    withRules([
      { name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' },
      { name: 'verify-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Verification' },
      { name: 'other-project', project: 'OTHER', issueType: 'Bug', targetState: 'Done' },
    ]);
    const details = makeDetails([['PROJ-1', 'Old finding', 'Open', 'Bug']]);

    const result = await buildStaleTicketGroups([{ key: 'PROJ-1', ids: ['1'] }], details, 'PROJ', client, '/workspace');

    expect(result.groups[0].rules).toEqual([
      { name: 'close-bugs', targetState: 'Done', resolution: 'Fixed' },
      { name: 'verify-bugs', targetState: 'Verification', resolution: undefined },
    ]);
  });

  it('a ticket whose project+issue type has no discovered workflow is ineligible with the discover hint', async () => {
    withRules([{ name: 'close-tasks', project: 'PROJ', issueType: 'Task', targetState: 'Done' }]);
    const details = makeDetails([['PROJ-2', 'Task finding', 'Open', 'Task']]);

    const result = await buildStaleTicketGroups([{ key: 'PROJ-2', ids: ['2'] }], details, 'PROJ', client, '/workspace');

    expect(result.groups).toEqual([]);
    expect(result.ineligible).toEqual([
      { key: 'PROJ-2', summary: 'Task finding', currentStatus: 'Open', note: expect.stringContaining('/ts-jira workflow') },
    ]);
  });

  it('a ticket whose issue type is unknown stays ineligible', async () => {
    withRules([]);

    const result = await buildStaleTicketGroups([{ key: 'PROJ-3', ids: ['3'] }], new Map(), 'PROJ', client, '/workspace');

    expect(result.ineligible[0]).toMatchObject({ key: 'PROJ-3', note: expect.stringContaining('issue type') });
  });

  it('groups matches by issue type — two issue types produce two separate groups', async () => {
    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: {
        Bug: { discovered: '2024-01-01', graph: bugGraph },
        Task: { discovered: '2024-01-01', graph: bugGraph },
      },
    });
    withRules([]);
    const details = makeDetails([['PROJ-1', 'Bug finding', 'Open', 'Bug'], ['PROJ-2', 'Task finding', 'Open', 'Task']]);

    const result = await buildStaleTicketGroups(
      [{ key: 'PROJ-1', ids: ['1'] }, { key: 'PROJ-2', ids: ['2'] }], details, 'PROJ', client, '/workspace',
    );

    expect(result.groups.map(g => g.issueType).sort()).toEqual(['Bug', 'Task']);
  });

  it('fetches the resolution names once and stores them', async () => {
    withRules([]);
    const spy = vi.spyOn(client, 'getResolutions').mockResolvedValue([{ name: 'Fixed' }, { name: "Won't Do" }]);
    const details = makeDetails([['PROJ-1', 'a', 'Open', 'Bug'], ['PROJ-2', 'b', 'Open', 'Bug']]);

    const result = await buildStaleTicketGroups(
      [{ key: 'PROJ-1', ids: ['1'] }, { key: 'PROJ-2', ids: ['2'] }], details, 'PROJ', client, '/workspace',
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.resolutionOptions).toEqual(['Fixed', "Won't Do"]);
  });

  it('a resolutions fetch that fails still produces the groups, with no resolutions', async () => {
    withRules([]);
    vi.spyOn(client, 'getResolutions').mockRejectedValue(new Error('503 Service Unavailable'));
    const details = makeDetails([['PROJ-1', 'a', 'Open', 'Bug']]);

    const result = await buildStaleTicketGroups([{ key: 'PROJ-1', ids: ['1'] }], details, 'PROJ', client, '/workspace');

    expect(result.groups).toHaveLength(1);
    expect(result.resolutionOptions).toEqual([]);
  });

  it('does not fetch resolutions when no group is eligible', async () => {
    withRules([]);
    const spy = vi.spyOn(client, 'getResolutions');
    const details = makeDetails([['PROJ-2', 'Task finding', 'Open', 'Task']]);

    await buildStaleTicketGroups([{ key: 'PROJ-2', ids: ['2'] }], details, 'PROJ', client, '/workspace');

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('transitionTickets', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('transitions only included tickets, with the given default resolution on the final hop', async () => {
    const tickets = [makeTicket('PROJ-1', { included: true }), makeTicket('PROJ-2', { included: false })];

    const result = await transitionTickets(tickets, ticketService, 'Fixed');

    expect(result).toMatchObject({ transitioned: 1, failed: 0, skipped: 1 });
    expect(client.executeTransitionCalls).toHaveLength(1);
    expect(client.executeTransitionCalls[0]).toMatchObject({ issueKey: 'PROJ-1', fields: { resolution: { name: 'Fixed' } } });
  });

  it('collects a per-ticket failure instead of throwing, and keeps processing the rest', async () => {
    vi.spyOn(ticketService, 'transitionAlongPath').mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const tickets = [makeTicket('PROJ-1', { included: true }), makeTicket('PROJ-2', { included: true })];

    const result = await transitionTickets(tickets, ticketService, undefined);

    expect(result.transitioned).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0].key).toBe('PROJ-1');
  });
});

// ---------------------------------------------------------------------------
// handleRunCleanup — fixVersion JQL variants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildReviewTable — pure table rendering
// ---------------------------------------------------------------------------
