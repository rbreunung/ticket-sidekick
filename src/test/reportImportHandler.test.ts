import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
  },
  window: {
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(() => ({
    loadTemplates: vi.fn(),
  })),
}));

// U6: buildStaleTicketGroups (cleanupHandler.ts, called transitively via continueAfterImportIssueType)
// reads the cached workflow graph — only the cache read is mocked, so each stale test controls its
// own graph while path-finding and the reachable-status lookup run for real against it.
vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import * as vscode from 'vscode';
import { buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection, continueAfterImportIssueType } from '../participant/jira/reportImportHandler';
import { handleVeracodeAwaitIssueType } from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType } from '../participant/jira/waltzHandler';
import { type ReviewSession, type VeracodeTemplateSelectionSession, type WaltzTemplateSelectionSession, type AwaitIssueTypeResume } from '../participant/sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from '../participant/jira/ticketContext';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import { TestRow, descriptor, mockStream, markdownText, makeMockWs, makeSession } from './helpers/reportImportHarness';

describe('buildImportTemplateSession', () => {
  it('falls back to the never-guess sentinel when the issue-type fetch returns nothing', async () => {
    const client = new MockJiraClient();
    vi.spyOn(client, 'getProject').mockResolvedValueOnce({ ...(await client.getProject('PROJ')), issueTypes: [] });
    const session = await buildImportTemplateSession([{ ref: '1' }], 'report.test', 'PROJ', client, descriptor);
    expect(session.availableIssueTypes).toEqual(['']);
  });

  it('uses a real fetched issue type when available', async () => {
    const client = new MockJiraClient();
    const session = await buildImportTemplateSession([{ ref: '1' }], 'report.test', 'PROJ', client, descriptor);
    expect(session.availableIssueTypes.length).toBeGreaterThan(0);
    expect(session.availableIssueTypes).not.toContain('');
  });

  it('calls onIssueTypeFetchFailed when the project fetch throws', async () => {
    const client = new MockJiraClient();
    vi.spyOn(client, 'getProject').mockRejectedValueOnce(new Error('boom'));
    const onIssueTypeFetchFailed = vi.fn();
    const session = await buildImportTemplateSession(
      [{ ref: '1' }], 'report.test', 'PROJ', client, { ...descriptor, onIssueTypeFetchFailed },
    );
    expect(onIssueTypeFetchFailed).toHaveBeenCalledWith('boom', 'PROJ');
    expect(session.availableIssueTypes).toEqual(['']);
  });
});

describe('streamImportTemplateSelection (never-guess sentinel rendering, U3/AE2)', () => {
  it('renders a sentinel issue-type entry as "you will be asked to type it", not blank', async () => {
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamImportTemplateSelection(session, stream as never, ws as never, descriptor);
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('1. [_you will be asked to type it_](command:workbench.action.chat.open?');
    expect(text).not.toMatch(/1\.\s*\n/);
  });

  it('renders a real issue type unchanged', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamImportTemplateSelection(session, stream as never, ws as never, descriptor);
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('1. [Bug](command:workbench.action.chat.open?');
  });
});

describe('handleImportTemplateSelection (never-guess sentinel detour, R6/KTD4)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();
  });

  it('picking the sentinel entry detours to the shared chat-based ask, not an input box', async () => {
    const searchSpy = vi.spyOn(client, 'searchJql');
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    // Session was already cleared before the detour (mirrors the create-ticket/email-import pattern).
    expect(ws.store[descriptor.sessionKeys.templateSelection]).toBeUndefined();
    expect(ws.store[AWAIT_ISSUE_TYPE_SESSION_KEY]).toBeDefined();
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => {
      const arg = c[0];
      return typeof arg === 'string' ? arg : (arg as { value: string }).value;
    });
    expect(calls.some(c => c.includes('What issue type'))).toBe(true);
    expect(searchSpy).not.toHaveBeenCalled(); // dedup search hasn't run yet — only after the reply resumes
  });

  it('a real configured issue type is entirely unaffected — no detour, no input box', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug', 'Story'] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(ws.store[AWAIT_ISSUE_TYPE_SESSION_KEY]).toBeUndefined();
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Bug');
  });
});

describe('continueAfterImportIssueType (R6/KTD4 resume continuation)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('a typed reply resumes into the review flow, running the dedup search', async () => {
    const searchSpy = vi.spyOn(client, 'searchJql');
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await continueAfterImportIssueType('Spike', null, session, client, ticketService, stream as never, ws as never, descriptor);

    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Spike');
    expect(searchSpy).toHaveBeenCalled();
  });

  it('the resolved (typed) issue type flows all the way into created tickets, never the sentinel', async () => {
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await continueAfterImportIssueType('Spike', null, session, client, ticketService, stream as never, ws as never, descriptor);
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    // createNewRows (the New screen's "create tickets" action) creates one ticket per included row.
    const { createNewRows } = await import('../participant/jira/reportImportHandler');
    await createNewRows(reviewSession, ticketService, mockStream() as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].issueType).toBe('Spike');
  });

  it('a picked template name resolves and merges its default fields into the batch (R6/KTD4 re-derivation)', async () => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [{ name: 'Security Template', issueType: 'Bug', defaultFields: { priority: 'High' } }],
        cleanupRules: [],
      }),
    }) as unknown as InstanceType<typeof TemplateService>);
    try {
      const session = makeSession({ availableIssueTypes: [''] });
      const stream = mockStream();
      const ws = makeMockWs();

      await continueAfterImportIssueType('Spike', 'Security Template', session, client, ticketService, stream as never, ws as never, descriptor);

      const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
      expect(reviewSession.templateName).toBe('Security Template');
      expect(reviewSession.additionalFields).toEqual({ priority: 'High' });
    } finally {
      (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    }
  });
});

describe('handleVeracodeAwaitIssueType (R6/KTD4 resume, supersession guard)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  function makeVeracodeSession(overrides: Partial<VeracodeTemplateSelectionSession> = {}): VeracodeTemplateSelectionSession {
    return {
      reportFileName: 'report.xml', projectKey: 'PROJ', items: [], availableTemplates: [],
      availableIssueTypes: [''], schemaVersion: 1, ...overrides,
    };
  }

  function makeResume(session: VeracodeTemplateSelectionSession): Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> {
    return { kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session };
  }

  it('aborts instead of creating a batch when a newer import session was written while the ask was open', async () => {
    const ws = makeMockWs();
    // Simulate a second, independent import starting and claiming the session key while this
    // flow's chat-based ask was still open (across the turn boundary the detour introduces).
    ws.store['jira.session.veracodeTemplateSelection'] = makeVeracodeSession({ reportFileName: 'other-report.xml' });
    const searchSpy = vi.spyOn(client, 'searchJql');
    const stream = mockStream();

    await handleVeracodeAwaitIssueType(makeResume(makeVeracodeSession()), 'Spike', client, ticketService, stream as never, ws as never);

    expect(searchSpy).not.toHaveBeenCalled();
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('newer import was started'))).toBe(true);
    // The second flow's session must survive untouched — this abort must not clear it.
    expect(ws.store['jira.session.veracodeTemplateSelection']).toBeDefined();
  });

  it('resumes normally into the review flow when not superseded', async () => {
    const ws = makeMockWs();
    const stream = mockStream();

    await handleVeracodeAwaitIssueType(makeResume(makeVeracodeSession()), 'Spike', client, ticketService, stream as never, ws as never);

    const reviewSession = ws.store['jira.session.veracodeReview'] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Spike');
  });
});

describe('handleWaltzAwaitIssueType (R6/KTD4 resume, same mechanism as Veracode)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  function makeWaltzSession(overrides: Partial<WaltzTemplateSelectionSession> = {}): WaltzTemplateSelectionSession {
    return {
      reportFileName: 'report.xlsx', projectKey: 'PROJ', items: [], availableTemplates: [],
      availableIssueTypes: [''], schemaVersion: 1, ...overrides,
    };
  }

  it('resumes normally into the review flow when not superseded', async () => {
    const ws = makeMockWs();
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: makeWaltzSession(),
    };

    await handleWaltzAwaitIssueType(resume, 'Task', client, ticketService, mockStream() as never, ws as never);

    const reviewSession = ws.store['jira.session.waltzReview'] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Task');
  });

  it('aborts instead of creating a batch when a newer import session was written while the ask was open', async () => {
    const ws = makeMockWs();
    // Simulate a second, independent import starting and claiming the session key while this
    // flow's chat-based ask was still open (across the turn boundary the detour introduces).
    ws.store['jira.session.waltzTemplateSelection'] = makeWaltzSession({ reportFileName: 'other-report.xlsx' });
    const searchSpy = vi.spyOn(client, 'searchJql');
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: makeWaltzSession(),
    };
    const stream = mockStream();

    await handleWaltzAwaitIssueType(resume, 'Task', client, ticketService, stream as never, ws as never);

    expect(searchSpy).not.toHaveBeenCalled();
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('newer import was started'))).toBe(true);
    // The second flow's session must survive untouched — this abort must not clear it.
    expect(ws.store['jira.session.waltzTemplateSelection']).toBeDefined();
  });
});
