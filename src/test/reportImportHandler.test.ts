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
}));

import * as vscode from 'vscode';
import {
  buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection,
  continueAfterImportIssueType,
  type ReportImportDescriptor, type ReportImportRow,
} from '../participant/jira/reportImportHandler';
import { handleVeracodeAwaitIssueType } from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType } from '../participant/jira/waltzHandler';
import type {
  ImportTemplateSelectionSession, ReviewSession, VeracodeTemplateSelectionSession, WaltzTemplateSelectionSession,
  AwaitIssueTypeResume,
} from '../participant/sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from '../participant/jira/ticketContext';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

interface TestItem {
  ref: string;
}

interface TestRow extends ReportImportRow {
  ref: string;
}

const descriptor: ReportImportDescriptor<TestItem, TestRow> = {
  descriptorKind: 'veracode', // arbitrary — this generic test descriptor isn't a real importer
  scope: 'jira.testImport',
  importLabel: 'Test',
  itemNoun: 'item(s)',
  filterKindLabel: 'test',
  noMatchMessage: '_No items matched your filters._',
  fileFilter: { label: 'Test', extensions: ['test'] },
  filePickerTitle: 'Select test file',
  parseAndFilter: async () => [],
  sessionKeys: {
    templateSelection: 'jira.session.testTemplateSelection',
    templateTag: '<!-- jira:test-template -->',
    review: 'jira.session.testReview',
    reviewTag: '<!-- jira:test-review -->',
  },
  searchLabelOf: item => `test-${item.ref}`,
  dedupKeyOf: item => item.ref,
  labelToDedupKey: label => (label.startsWith('test-') ? label.slice(5) : null),
  buildRowFields: item => ({ ref: item.ref, labels: [], summary: `Summary ${item.ref}`, descriptionWiki: 'desc' }),
  reviewColumns: [],
  itemRefFor: row => row.ref,
};

const mockStream = () => ({ markdown: vi.fn() });

function makeMockWs(initial: Record<string, unknown> = {}): { get: <T>(k: string, d?: T) => T | undefined; update: (k: string, v: unknown) => Promise<void>; store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string, defaultValue?: T) => (key in store ? store[key] as T : defaultValue),
    update: async (key: string, value: unknown) => { store[key] = value; },
  };
}

function makeSession(overrides: Partial<ImportTemplateSelectionSession<TestItem>> = {}): ImportTemplateSelectionSession<TestItem> {
  return {
    reportFileName: 'report.test',
    projectKey: 'PROJ',
    items: [{ ref: '1' }],
    availableTemplates: [],
    availableIssueTypes: ['Bug', 'Story'],
    schemaVersion: 1,
    ...overrides,
  };
}

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
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('1. _you will be asked to type it_');
    expect(text).not.toMatch(/1\.\s*\n/);
  });

  it('renders a real issue type unchanged', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamImportTemplateSelection(session, stream as never, ws as never, descriptor);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('1. Bug');
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
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
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

    // executeImportBatch (invoked via the review flow) creates one ticket per included row.
    const { executeImportBatch } = await import('../participant/jira/reportImportHandler');
    await executeImportBatch(reviewSession, ticketService, mockStream() as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].issueType).toBe('Spike');
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
});
