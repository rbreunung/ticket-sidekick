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
  type ReportImportDescriptor, type ReportImportRow,
} from '../participant/jira/reportImportHandler';
import type { ImportTemplateSelectionSession, ReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

interface TestItem {
  ref: string;
}

interface TestRow extends ReportImportRow {
  ref: string;
}

const descriptor: ReportImportDescriptor<TestItem, TestRow> = {
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

describe('handleImportTemplateSelection (never-guess sentinel detour, U3)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockReset();
  });

  it('picking the sentinel entry opens the input box before any dedup search; a typed value becomes the batch issueType', async () => {
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Spike');
    const searchSpy = vi.spyOn(client, 'searchJql');
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);

    expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
    // Session was already cleared before the detour (mirrors the create-ticket/email-import pattern).
    expect(ws.store[descriptor.sessionKeys.templateSelection]).toBeUndefined();
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Spike');
    expect(searchSpy).toHaveBeenCalled(); // dedup search still ran, after the detour resolved
  });

  it('a cancelled/empty input box aborts before any dedup search or ticket creation', async () => {
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const searchSpy = vi.spyOn(client, 'searchJql');
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);

    expect(searchSpy).not.toHaveBeenCalled();
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('No issue type provided'))).toBe(true);
  });

  it('a real configured issue type is entirely unaffected — no input box shown', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug', 'Story'] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);

    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.issueType).toBe('Bug');
  });

  it('the resolved (typed) issue type flows all the way into created tickets, never the sentinel', async () => {
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Spike');
    const session = makeSession({ availableIssueTypes: [''] });
    const stream = mockStream();
    const ws = makeMockWs();

    await handleImportTemplateSelection('1', session, client, ticketService, stream as never, ws as never, descriptor);
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    // executeImportBatch (invoked via the review flow) creates one ticket per included row.
    const { executeImportBatch } = await import('../participant/jira/reportImportHandler');
    await executeImportBatch(reviewSession, ticketService, mockStream() as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].issueType).toBe('Spike');
  });
});
