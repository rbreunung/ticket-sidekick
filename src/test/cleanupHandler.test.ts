import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

vi.mock('../services/WorkflowService', () => ({
  loadWorkflowCache: vi.fn(),
  findPath: vi.fn(),
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(() => ({
    loadTemplates: vi.fn(),
  })),
}));

import { streamReviewScreen, executeCleanupBatch, handleRunCleanup } from '../participant/jira/cleanupHandler';
import { loadWorkflowCache, findPath } from '../services/WorkflowService';
import { TemplateService } from '../templates/TemplateService';
import type { TransitionBatchSession, TransitionBatchTicket, TransitionSubtask } from '../participant/sessionState';
import type { ParsedIntent } from '../participant/jira/llmHelpers';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

const mockStream = () => ({ markdown: vi.fn() });
const mockWs = () => ({ get: vi.fn(), update: vi.fn() });

const dummyPath = [{ id: '1', name: 'Go', to: 'Done' }];

function makeTicket(key: string, overrides: Partial<TransitionBatchTicket> = {}): TransitionBatchTicket {
  return {
    key,
    summary: `Summary for ${key}`,
    currentStatus: 'Open',
    transitionPath: dummyPath,
    subtasks: [],
    ...overrides,
  };
}

function makeSubtask(key: string, overrides: Partial<TransitionSubtask> = {}): TransitionSubtask {
  return {
    key,
    summary: `Subtask ${key}`,
    currentStatus: 'Open',
    transitionPath: dummyPath,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// streamReviewScreen — resolution display
// ---------------------------------------------------------------------------

describe('streamReviewScreen', () => {
  it('appends parent resolution to transition arrow', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1')],
      resolution: 'Fixed',
      ruleName: undefined,
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    expect(rendered).toContain('Open → Done (Fixed)');
  });

  it('uses subtask-specific resolution in preference to session resolution', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const subtask = makeSubtask('PROJ-2', { resolution: 'Cannot Reproduce' });
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: 'Fixed',
      ruleName: undefined,
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    // Subtask should show its own resolution
    expect(rendered).toContain('PROJ-2');
    expect(rendered).toContain('Cannot Reproduce');
    // Should NOT show the session-level resolution for the subtask line
    const lines = rendered.split('\n');
    const subtaskLine = lines.find((l) => l.includes('PROJ-2'));
    expect(subtaskLine).toBeDefined();
    expect(subtaskLine).toContain('Cannot Reproduce');
    expect(subtaskLine).not.toContain('(Fixed)');
  });

  it('falls back to session resolution when subtask has no resolution', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const subtask = makeSubtask('PROJ-2'); // no resolution field
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: 'Fixed',
      ruleName: undefined,
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    const lines = rendered.split('\n');
    const subtaskLine = lines.find((l) => l.includes('PROJ-2'));
    expect(subtaskLine).toBeDefined();
    expect(subtaskLine).toContain('(Fixed)');
  });

  it('shows no resolution suffix when both session and subtask resolution are absent', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const subtask = makeSubtask('PROJ-2'); // no resolution
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: undefined,
      ruleName: undefined,
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    // Neither parent nor subtask arrow should have a parenthesised resolution suffix
    const lines = rendered.split('\n');
    const ticketLines = lines.filter((l) => l.includes('→'));
    expect(ticketLines.length).toBeGreaterThan(0);
    for (const line of ticketLines) {
      expect(line).not.toMatch(/\(.+\)$/);
    }
  });
});

// ---------------------------------------------------------------------------
// executeCleanupBatch — subtask resolution fallback
// ---------------------------------------------------------------------------

describe('executeCleanupBatch', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('passes sub.resolution to transitionAlongPath when defined', async () => {
    const spy = vi.spyOn(ticketService, 'transitionAlongPath').mockResolvedValue(undefined);
    const subtask = makeSubtask('PROJ-2', { resolution: 'Cannot Reproduce' });
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: 'Fixed',
      ruleName: undefined,
    };
    const stream = mockStream();

    await executeCleanupBatch(session, new Set(), ticketService, stream as never);

    // The call for PROJ-2 should pass subtask's own resolution
    const subCall = spy.mock.calls.find(([key]) => key === 'PROJ-2');
    expect(subCall).toBeDefined();
    expect(subCall![2]).toBe('Cannot Reproduce');
    // Parent always uses session.resolution unchanged
    const parentCall = spy.mock.calls.find(([key]) => key === 'PROJ-1');
    expect(parentCall).toBeDefined();
    expect(parentCall![2]).toBe('Fixed');
  });

  it('falls back to session.resolution when sub.resolution is undefined', async () => {
    const spy = vi.spyOn(ticketService, 'transitionAlongPath').mockResolvedValue(undefined);
    const subtask = makeSubtask('PROJ-2'); // resolution undefined
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: 'Fixed',
      ruleName: undefined,
    };
    const stream = mockStream();

    await executeCleanupBatch(session, new Set(), ticketService, stream as never);

    const subCall = spy.mock.calls.find(([key]) => key === 'PROJ-2');
    expect(subCall).toBeDefined();
    expect(subCall![2]).toBe('Fixed');
    // Parent also uses session.resolution
    const parentCall = spy.mock.calls.find(([key]) => key === 'PROJ-1');
    expect(parentCall).toBeDefined();
    expect(parentCall![2]).toBe('Fixed');
  });
});

// ---------------------------------------------------------------------------
// handleRunCleanup — JQL construction and behaviour
// ---------------------------------------------------------------------------

describe('handleRunCleanup', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  const baseIntent: ParsedIntent = {
    operation: 'runCleanup',
    ticketKey: null,
    projectKey: 'PROJ',
    summary: null,
    issueType: 'Bug',
    assignee: null,
    components: null,
    description: null,
    comment: null,
    commentQuery: null,
    contentSource: 'literal',
    fieldUpdates: [],
    fieldName: null,
    fieldValue: null,
    arrayOp: 'set',
    scope: null,
    jql: null,
    filterId: null,
    filterName: null,
    targetStatus: null,
    bulkFieldName: null,
    bulkFieldValue: null,
    cleanupRuleName: null,
    fixVersion: null,
    resolution: null,
  };

  const workflowGraph = {
    Open: [{ id: '1', name: 'Go', to: 'Done' }],
    Done: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);

    // Default: no cleanup rules, has workflow cache
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [],
      }),
    }) as never);

    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: {
        Bug: {
          discovered: '2024-01-01',
          graph: workflowGraph,
        },
      },
    });

    vi.mocked(findPath).mockReturnValue(dummyPath);

    // Default: no results
    vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({ issues: [], total: 0 });
  });

  it('includes AND resolution is EMPTY in the JQL', async () => {
    const stream = mockStream();
    const ws = mockWs();

    await handleRunCleanup(baseIntent, stream as never, client, ticketService, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(allMarkdown).toContain('resolution is EMPTY');
  });

  it('ignores rule.jql and warns when it contains ORDER BY', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          {
            name: 'close-bugs',
            project: 'PROJ',
            issueType: 'Bug',
            targetState: 'Done',
            jql: 'priority = High ORDER BY created DESC',
          },
        ],
      }),
    }) as never);

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-bugs' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(allMarkdown).toContain('ORDER BY');
    expect(allMarkdown).toContain('extra filter ignored');
    expect(allMarkdown).not.toContain('AND (priority = High');
  });

  it('appends rule.jql as AND (...) to the base query', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          {
            name: 'close-bugs',
            project: 'PROJ',
            issueType: 'Bug',
            targetState: 'Done',
            jql: 'priority = High',
          },
        ],
      }),
    }) as never);

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-bugs' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(allMarkdown).toContain('AND (priority = High)');
  });

  it('streams scope preview before the search', async () => {
    const stream = mockStream();
    const ws = mockWs();

    await handleRunCleanup(baseIntent, stream as never, client, ticketService, ws as never);

    // The scope preview should be streamed (i.e. markdown called with the jql block)
    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(allMarkdown).toContain('**Search scope**');

    // Scope preview must come BEFORE the "no tickets" message or results message
    const calls = stream.markdown.mock.calls.map((c: [string]) => c[0]);
    const scopeIndex = calls.findIndex((s) => s.includes('**Search scope**'));
    const noTicketsIndex = calls.findIndex((s) => s.includes('No tickets found'));
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(noTicketsIndex);
  });

  it('skips resolution dialog when intent.resolution is set', async () => {
    // With a closed targetState and intent.resolution set, no resolution dialog should appear
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          {
            name: 'close-bugs',
            project: 'PROJ',
            issueType: 'Bug',
            targetState: 'Done',
            // no resolution in rule — would normally trigger dialog
          },
        ],
      }),
    }) as never);

    // Return a ticket so we proceed past the "no tickets found" check
    vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({
      issues: [
        {
          id: '1',
          key: 'PROJ-1',
          fields: {
            summary: 'Fix login',
            status: { name: 'Open' },
            assignee: null,
            reporter: null,
            priority: null,
            labels: [],
            fixVersions: [],
            comment: null,
            description: null,
          },
        },
      ],
      total: 1,
    });

    const stream = mockStream();
    const ws = mockWs();
    const intent = {
      ...baseIntent,
      cleanupRuleName: 'close-bugs',
      resolution: 'Fixed', // provided explicitly
    };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    // Resolution dialog contains the "<!-- jira:selecting-resolution -->" marker
    expect(allMarkdown).not.toContain('<!-- jira:selecting-resolution -->');
    // The review screen should have been shown instead
    expect(allMarkdown).toContain('<!-- jira:transition-review -->');
  });

  it('attaches subtasks to their parent in the review screen when closeSubtasks is true', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          {
            name: 'close-bugs',
            project: 'PROJ',
            issueType: 'Bug',
            targetState: 'Done',
            resolution: 'Fixed',
            closeSubtasks: true,
          },
        ],
      }),
    }) as never);

    const parentIssue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Parent ticket', status: { name: 'Open' },
        assignee: null, reporter: null, priority: null,
        labels: [], fixVersions: [], comment: null, description: null,
      },
    };
    const subtaskIssue = {
      id: '2', key: 'PROJ-1a',
      fields: {
        summary: 'Child subtask', status: { name: 'Open' },
        assignee: null, reporter: null, priority: null,
        labels: [], fixVersions: [], comment: null, description: null,
        parent: { key: 'PROJ-1' },
      },
    };

    const spy = vi.spyOn(ticketService, 'searchTicketsRaw');
    spy.mockResolvedValueOnce({ issues: [parentIssue], total: 1 });   // parent fetch
    spy.mockResolvedValueOnce({ issues: [subtaskIssue], total: 1 });  // subtask fetch

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-bugs', resolution: 'Fixed' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    // Both parent and subtask should appear in the review screen
    expect(allMarkdown).toContain('PROJ-1');
    expect(allMarkdown).toContain('PROJ-1a');
    expect(allMarkdown).toContain('Child subtask');
    expect(allMarkdown).toContain('<!-- jira:transition-review -->');
  });

  it('uses subtaskTargetState for the subtask JQL and path when set', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          {
            name: 'close-bugs',
            project: 'PROJ',
            issueType: 'Bug',
            targetState: 'Done',
            resolution: 'Fixed',
            closeSubtasks: true,
            subtaskTargetState: 'Closed',
          },
        ],
      }),
    }) as never);

    const parentIssue = {
      id: '1', key: 'PROJ-1',
      fields: {
        summary: 'Parent ticket', status: { name: 'Open' },
        assignee: null, reporter: null, priority: null,
        labels: [], fixVersions: [], comment: null, description: null,
      },
    };
    const subtaskIssue = {
      id: '2', key: 'PROJ-1a',
      fields: {
        summary: 'Child subtask', status: { name: 'Open' },
        assignee: null, reporter: null, priority: null,
        labels: [], fixVersions: [], comment: null, description: null,
        parent: { key: 'PROJ-1' },
      },
    };

    const spy = vi.spyOn(ticketService, 'searchTicketsRaw');
    spy.mockResolvedValueOnce({ issues: [parentIssue], total: 1 });
    spy.mockResolvedValueOnce({ issues: [subtaskIssue], total: 1 });

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-bugs', resolution: 'Fixed' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    // Subtask JQL must use subtaskTargetState, not targetState
    const subtaskCall = spy.mock.calls[1][0] as string;
    expect(subtaskCall).toContain('status != "Closed"');
    expect(subtaskCall).not.toContain('status != "Done"');

    // Subtask should still appear in the review screen
    const allMarkdown = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(allMarkdown).toContain('PROJ-1a');
  });
});
