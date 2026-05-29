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
import { buildReviewTable } from '../participant/sessionState';
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
      issueType: 'Bug',
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    // Table row should include the resolution in its own column
    expect(rendered).toContain('| Fixed |');
    // Arrow still present in the → To column area
    expect(rendered).toContain('Done');
  });

  it('uses subtask-specific resolution in preference to session resolution', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const subtask = makeSubtask('PROJ-2', { resolution: 'Cannot Reproduce' });
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: 'Fixed',
      ruleName: undefined,
      issueType: 'Bug',
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
      issueType: 'Bug',
    };

    await streamReviewScreen(session, stream as never, ws as never, '**Cleanup**');

    const rendered: string = stream.markdown.mock.calls[0][0];
    const lines = rendered.split('\n');
    const subtaskLine = lines.find((l) => l.includes('PROJ-2'));
    expect(subtaskLine).toBeDefined();
    // Resolution column falls back to session.resolution
    expect(subtaskLine).toContain('Fixed');
  });

  it('shows no resolution suffix when both session and subtask resolution are absent', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const subtask = makeSubtask('PROJ-2'); // no resolution
    const session: TransitionBatchSession = {
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
      resolution: undefined,
      ruleName: undefined,
      issueType: 'Bug',
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
      issueType: 'Bug',
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
      issueType: 'Bug',
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

  it('includes scope preview and no-tickets message in single markdown call', async () => {
    const stream = mockStream();
    const ws = mockWs();

    await handleRunCleanup(baseIntent, stream as never, client, ticketService, ws as never);

    // Both scope preview and result message should appear in the same single call
    expect(stream.markdown.mock.calls).toHaveLength(1);
    const output: string = stream.markdown.mock.calls[0][0];
    expect(output).toContain('**Search scope**');
    expect(output).toContain('No tickets found');
    // Scope preview appears before the no-tickets message
    expect(output.indexOf('**Search scope**')).toBeLessThan(output.indexOf('No tickets found'));
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

// ---------------------------------------------------------------------------
// handleRunCleanup — fixVersion JQL variants
// ---------------------------------------------------------------------------

describe('handleRunCleanup — fixVersion JQL variants', () => {
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

  const workflowGraph = { Open: [{ id: '1', name: 'Go', to: 'Done' }], Done: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);

    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules: [] }),
    }) as never);

    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: { Bug: { discovered: '2024-01-01', graph: workflowGraph } },
    });

    vi.mocked(findPath).mockReturnValue(dummyPath);
    vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({ issues: [], total: 0 });
  });

  it('emits releasedVersions() when intent.fixVersion is "released"', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, fixVersion: 'released' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('releasedVersions()');
    expect(output).not.toContain('fixVersion = "released"');
  });

  it('emits unreleasedVersions() when intent.fixVersion is "unreleased"', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, fixVersion: 'unreleased' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('unreleasedVersions()');
  });

  it('emits fixVersion ~ when the fixVersion string contains a wildcard', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, fixVersion: 'Release*' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('fixVersion ~ "Release*"');
    expect(output).not.toContain('fixVersion = "Release*"');
  });

  it('uses rule fixVersionFilter "released" when intent has no fixVersion', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{
          name: 'close-released',
          project: 'PROJ',
          issueType: 'Bug',
          targetState: 'Done',
          resolution: 'Fixed',
          fixVersionFilter: 'released',
        }],
      }),
    }) as never);

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-released', resolution: 'Fixed' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('releasedVersions()');
  });

  it('uses rule fixVersionPattern for wildcard JQL when intent has no fixVersion', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{
          name: 'close-release-pattern',
          project: 'PROJ',
          issueType: 'Bug',
          targetState: 'Done',
          resolution: 'Fixed',
          fixVersionPattern: 'Release*',
        }],
      }),
    }) as never);

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-release-pattern', resolution: 'Fixed' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('fixVersion ~ "Release*"');
  });

  it('prompt fixVersion overrides rule fixVersionFilter', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{
          name: 'close-released',
          project: 'PROJ',
          issueType: 'Bug',
          targetState: 'Done',
          resolution: 'Fixed',
          fixVersionFilter: 'released',
        }],
      }),
    }) as never);

    const stream = mockStream();
    const ws = mockWs();
    const intent = { ...baseIntent, cleanupRuleName: 'close-released', fixVersion: 'v1.2', resolution: 'Fixed' };

    await handleRunCleanup(intent, stream as never, client, ticketService, ws as never);

    const output = stream.markdown.mock.calls.map((c: [string]) => c[0]).join('\n');
    expect(output).toContain('fixVersion = "v1.2"');
    expect(output).not.toContain('releasedVersions()');
  });
});

// ---------------------------------------------------------------------------
// buildReviewTable — pure table rendering
// ---------------------------------------------------------------------------

describe('buildReviewTable', () => {
  function makeSession(overrides: Partial<TransitionBatchSession> = {}): TransitionBatchSession {
    return {
      tickets: [],
      resolution: undefined,
      ruleName: undefined,
      issueType: 'Bug',
      ...overrides,
    };
  }

  it('renders a table with Type, Key, Summary, From, → To columns', () => {
    const session = makeSession({
      tickets: [makeTicket('PROJ-1', { currentStatus: 'Open' })],
    });
    const table = buildReviewTable(session);
    expect(table).toContain('| Type |');
    expect(table).toContain('| Key |');
    expect(table).toContain('| Summary |');
    expect(table).toContain('| From |');
    expect(table).toContain('| → To |');
    expect(table).toContain('| Bug |');
    expect(table).toContain('| PROJ-1 |');
    expect(table).toContain('| Open |');
    expect(table).toContain('| Done |');
  });

  it('includes Resolution column only when session.resolution is set', () => {
    const withRes = makeSession({ tickets: [makeTicket('PROJ-1')], resolution: 'Fixed' });
    const withoutRes = makeSession({ tickets: [makeTicket('PROJ-1')], resolution: undefined });
    expect(buildReviewTable(withRes)).toContain('| Resolution |');
    expect(buildReviewTable(withoutRes)).not.toContain('| Resolution |');
  });

  it('sorts parents alphabetically by currentStatus', () => {
    const session = makeSession({
      tickets: [
        makeTicket('PROJ-2', { currentStatus: 'Review' }),
        makeTicket('PROJ-1', { currentStatus: 'Open' }),
      ],
    });
    const table = buildReviewTable(session);
    expect(table.indexOf('PROJ-1')).toBeLessThan(table.indexOf('PROJ-2'));
  });

  it('places subtasks immediately after their parent with ↳ prefix', () => {
    const subtask = makeSubtask('PROJ-1a');
    const session = makeSession({
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
    });
    const table = buildReviewTable(session);
    const parentIdx = table.indexOf('PROJ-1');
    const subtaskIdx = table.indexOf('↳ PROJ-1a');
    expect(subtaskIdx).toBeGreaterThan(parentIdx);
  });

  it('shows Sub-task in Type column for subtasks', () => {
    const subtask = makeSubtask('PROJ-1a');
    const session = makeSession({
      tickets: [makeTicket('PROJ-1', { subtasks: [subtask] })],
    });
    const table = buildReviewTable(session);
    const lines = table.split('\n');
    const subtaskLine = lines.find((l) => l.includes('PROJ-1a'));
    expect(subtaskLine).toContain('Sub-task');
  });

  it('includes footer prompt line', () => {
    const session = makeSession({ tickets: [makeTicket('PROJ-1')] });
    expect(buildReviewTable(session)).toContain('ok · (c) · key numbers to skip');
  });
});
