import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// reads the cached workflow graph — mocked the same way cleanupHandler.test.ts mocks it, so each
// U6 test controls its own graph/path instead of touching the real on-disk cache.
vi.mock('../services/WorkflowService', () => ({
  loadWorkflowCache: vi.fn(),
  findPath: vi.fn(),
}));

import * as vscode from 'vscode';
import {
  buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection,
  continueAfterImportIssueType, handleImportReviewReply,
  type ReportImportDescriptor, type ReportImportRow,
} from '../participant/jira/reportImportHandler';
import {
  handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply,
} from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType, handleWaltzReviewReply } from '../participant/jira/waltzHandler';
import {
  buildReviewPage, CURRENT_SESSION_SCHEMA_VERSION,
  type ImportTemplateSelectionSession, type ReviewSession, type VeracodeTemplateSelectionSession,
  type WaltzTemplateSelectionSession, type AwaitIssueTypeResume, type VeracodeReviewSession, type WaltzReviewSession,
} from '../participant/sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from '../participant/jira/ticketContext';
import { loadWorkflowCache, findPath } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import type { WaltzReviewRow } from '../utils/waltzReport';
import type { JiraSearchResult, JiraIssue } from '../jira/IJiraClient';

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
    review: 'jira.session.testReview',
  },
  searchLabelOf: item => [`test-${item.ref}`],
  dedupKeyOf: item => [item.ref],
  labelToDedupKey: label => (label.startsWith('test-') ? label.slice(5) : null),
  buildRowFields: item => ({ ref: item.ref, labels: [], summary: `Summary ${item.ref}`, descriptionWiki: 'desc' }),
  reviewColumns: [],
  itemRefFor: row => row.ref,
  buildTicketFields: (row, additionalFields) => ({
    summary: row.summary,
    fields: { ...additionalFields, labels: row.labels, description: row.descriptionWiki },
  }),
};

const mockStream = () => ({ markdown: vi.fn() });

// U5: several responses now stream a trusted vscode.MarkdownString (command links) rather than a
// bare string — this file's mocked MarkdownString stores the raw text on `.value`.
function markdownText(arg: unknown): string {
  return typeof arg === 'string' ? arg : (arg as { value: string }).value;
}

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

// U4: the pageable review session's "New" section — paging navigation, page-local toggle reset,
// and confirming only the currently-visible page. Exercised through the generic test descriptor
// (the shared code path both Veracode and Waltz's real descriptors reuse via handleImportReviewReply).
describe('handleImportReviewReply — paging (U4/R6-R8)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function buildBigReviewSession(count: number, ws: ReturnType<typeof makeMockWs>): Promise<ReviewSession<TestRow>> {
    const items: TestItem[] = Array.from({ length: count }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, descriptor);
    return ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
  }

  it('builds every matched item into allRows (unpaged) and shows only the first 50 as the initial page', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);
    expect(session.allRows).toHaveLength(120);
    expect(session.rows).toHaveLength(50);
    expect(session.page).toBe(0);
    expect(session.rows.map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
  });

  it('renders "Page 1 of 3" on the initial review screen', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);
    const stream = mockStream();
    // "page 1" re-renders the already-current page — a valid page-nav reply, not a toggle/invalid
    // one — so this exercises exactly what the initial render itself produced.
    await handleImportReviewReply('page 1', session, ticketService, stream as never, ws as never, descriptor);
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('Page 1 of 3');
  });

  it('"page <n>" navigates to the requested page and re-renders that page\'s rows', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);
    const stream = mockStream();

    await handleImportReviewReply('page 2', session, ticketService, stream as never, ws as never, descriptor);

    expect(session.page).toBe(1);
    expect(session.rows).toHaveLength(50);
    expect(session.rows[0].id).toBe('51');
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('Page 2 of 3');
  });

  it('"next"/"prev" navigate correctly at the first, a middle, and the last page, clamping past either end', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);

    await handleImportReviewReply('next', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(1); // middle page

    await handleImportReviewReply('next', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(2); // last page (20 rows)
    expect(session.rows).toHaveLength(20);

    await handleImportReviewReply('next', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(2); // clamped — "next" past the last page is a no-op

    await handleImportReviewReply('prev', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(1);

    await handleImportReviewReply('prev', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(0); // first page

    await handleImportReviewReply('prev', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(0); // clamped — "prev" before the first page is a no-op
  });

  it('a bare numeric reply toggles the row only when it is on the currently visible page', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);
    // Currently on page 1 (rows '1'..'50'); '75' lives on page 2 — off-page.
    const stream = mockStream();

    const result = await handleImportReviewReply('75', session, ticketService, stream as never, ws as never, descriptor);

    expect(result).toBeDefined();
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain("Didn't understand that");
    // Confirm row '75' was never toggled — still default-included in allRows.
    expect(session.allRows.find(r => r.id === '75')!.included).toBe(true);
  });

  it('a bare numeric reply toggles the row normally when it IS on the currently visible page', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);

    await handleImportReviewReply('25', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(session.rows.find(r => r.id === '25')!.included).toBe(false);
  });

  it('paging to a page and confirming creates only that page\'s included rows, discarding any earlier page\'s toggles', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);

    // Exclude row '10' on page 1, then navigate away — R7 says this toggle does not survive.
    await handleImportReviewReply('10', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === '10')!.included).toBe(false);
    await handleImportReviewReply('next', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.page).toBe(1);

    // Exclude row '55' on page 2 (the page we're about to confirm from).
    await handleImportReviewReply('55', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === '55')!.included).toBe(false);

    await handleImportReviewReply('post it', session, ticketService, mockStream() as never, ws as never, descriptor);

    // Page 2 has 50 rows, one excluded ('55') -> 49 created.
    expect(client.createIssueCalls).toHaveLength(49);
    expect(client.createIssueCalls.some(c => c.summary === 'Summary 55')).toBe(false); // excluded on the confirmed page
    expect(client.createIssueCalls.some(c => c.summary === 'Summary 51')).toBe(true); // included, on the confirmed page
    expect(client.createIssueCalls.some(c => c.summary === 'Summary 10')).toBe(false); // page 1 was never confirmed this run
  });

  it('going back to a previously-visited page shows every row included again, even one excluded before navigating away', async () => {
    const ws = makeMockWs();
    const session = await buildBigReviewSession(120, ws);

    await handleImportReviewReply('10', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === '10')!.included).toBe(false);
    await handleImportReviewReply('next', session, ticketService, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('prev', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(session.page).toBe(0);
    expect(session.rows.find(r => r.id === '10')!.included).toBe(true); // reset to default
  });

  it('an "already ticketed" row\'s toggle persists across page navigation, unlike a "new" row\'s', async () => {
    const client2 = new MockJiraClient();
    const ticketService2 = new TicketService(client2);
    vi.spyOn(ticketService2, 'searchTicketsRaw').mockResolvedValue({
      issues: [{ key: 'PROJ-999', fields: { labels: ['test-1'] } }],
      total: 1, isLast: true,
    } as unknown as JiraSearchResult);
    const items: TestItem[] = Array.from({ length: 60 }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    await continueAfterImportIssueType('Bug', null, templateSession, client2, ticketService2, mockStream() as never, ws as never, descriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    // Row '1' is already-ticketed (dedup-matched) — its id is 'A1', on the Already-ticketed screen.
    expect(session.view).toBe('overview');
    expect(session.rows.find(r => r.existingTicketKey !== null)!.id).toBe('A1');
    await handleImportReviewReply('open already ticketed', session, ticketService2, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('A1', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // toggled on (force re-create)

    await handleImportReviewReply('back', session, ticketService2, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('open new', session, ticketService2, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('next', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // survives the page change

    await handleImportReviewReply('prev', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // still survives
  });
});

describe('handleImportReviewReply — bulk include/exclude (toggle-all)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('"exclude all" sets every New row on the current page to excluded, leaving other pages untouched', async () => {
    const ws = makeMockWs();
    const items: TestItem[] = Array.from({ length: 60 }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, descriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('exclude all', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(session.rows.every(r => !r.included)).toBe(true);
    // Off-page row is unaffected — bulk set is page-local, matching a per-row New toggle (R3).
    expect(session.allRows.find(r => r.id === '51')!.included).toBe(true);
  });

  it('"include all" sets every New row on the current page to included', async () => {
    const ws = makeMockWs();
    const items: TestItem[] = Array.from({ length: 5 }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, descriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('3', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === '3')!.included).toBe(false);

    await handleImportReviewReply('include all', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(session.rows.every(r => r.included)).toBe(true);
  });

  it('"exclude all" leaves an already-ticketed row untouched (R4)', async () => {
    vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({
      issues: [{ key: 'PROJ-999', fields: { labels: ['test-1'] } }],
      total: 1, isLast: true,
    } as unknown as JiraSearchResult);
    const items: TestItem[] = Array.from({ length: 3 }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, descriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(session.rows.find(r => r.existingTicketKey !== null)!.id).toBe('A1');

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('exclude all', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(session.rows.filter(r => r.existingTicketKey === null).every(r => !r.included)).toBe(true);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(false); // already-ticketed default, untouched
  });

  it('re-renders the review screen after a bulk action, reflecting the updated count', async () => {
    const ws = makeMockWs();
    const items: TestItem[] = Array.from({ length: 3 }, (_, i) => ({ ref: String(i + 1) }));
    const templateSession = makeSession({ items, availableIssueTypes: ['Bug'] });
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, descriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    const stream = mockStream();

    await handleImportReviewReply('exclude all', session, ticketService, stream as never, ws as never, descriptor);

    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('**0** ticket(s) will be created.');
  });
});

describe('Veracode review rows — lazy description build (U4/R6-R7)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
      description: 'Untrusted input reaches a query.', recommendation: 'Use parameterized queries.',
      module: 'app.jar', sourceFile: 'App.java', sourceFilePath: 'src/main/java/App.java',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }

  it('keeps the raw flaw group on the row instead of a pre-built description, and builds the real description only at creation time', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    // Two distinct file:line locations -> two singleton groups (no folding).
    const flaws = [makeFlaw('101'), makeFlaw('102', { sourceFile: 'Other.java', line: 7 })];
    const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
    const ws = makeMockWs();

    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
    };
    await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);

    const reviewSession = ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
    expect(reviewSession.allRows).toHaveLength(2);
    // Lazy build (U4/R6-R7): the row carries the raw group, not a pre-built description string.
    expect(reviewSession.allRows[0]).toHaveProperty('sourceGroup');
    expect((reviewSession.allRows[0] as { descriptionWiki?: unknown }).descriptionWiki).toBeUndefined();
    expect(reviewSession.allRows[0].sourceGroup[0].issueId).toBe('101');

    await handleVeracodeReviewReply('post it', reviewSession, ticketService, mockStream() as never, ws as never);

    expect(client.createIssueCalls).toHaveLength(2);
    for (const call of client.createIssueCalls) {
      // The just-in-time build reached Jira: real content built from the flaw's own fields, not an
      // empty/placeholder string.
      expect(call.additionalFields?.description).toEqual(expect.stringContaining('Severity'));
    }
  });
});

// U3/R13: "update existing tickets" bulk action — a distinct reply keyword that walks every
// Already-ticketed row (from allRows, not the currently-paged rows) and, for each with a flaw id
// not yet reflected on its ticket's labels, adds the missing veracode-issue-<id> label(s) + a
// summarizing comment via the real Veracode descriptor (veracodeHandler.ts).
describe('"update existing tickets" bulk action (U3/R13)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
      description: 'Untrusted input reaches a query.', recommendation: null,
      module: 'app.jar', sourceFile: 'App.java', sourceFilePath: 'src/main/java/App.java',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }

  function makeRow(id: string, ticketKey: string | null, group: VeracodeFlaw[]): VeracodeReviewRow {
    const first = group[0];
    return {
      id, issueIds: group.map(f => f.issueId), severity: first.severity, severityLabelText: 'High',
      cweId: first.cweId, summary: `Summary ${id}`, labels: [], sourceGroup: group,
      existingTicketKey: ticketKey, included: ticketKey === null,
      // Every already-ticketed test row carries a finding its ticket may lack (KTD5) — the update
      // action itself decides, via addMissingLabels, whether anything is actually missing.
      ...(ticketKey !== null ? { hasUnsyncedFindings: true } : {}),
    };
  }

  function makeIssue(key: string, labels: string[]): JiraIssue {
    return { id: '1', key, fields: { labels } as JiraIssue['fields'] };
  }

  function makeReviewSession(allRows: VeracodeReviewRow[], rows: VeracodeReviewRow[] = allRows): import('../participant/sessionState').VeracodeReviewSession {
    return {
      projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
      allRows, rows, page: 0, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
  }

  // A stateful label store, updated by updateIssue, so getIssue reflects a prior write — needed
  // for the idempotency test to see the *result* of the first run on the second run.
  function wireStatefulLabels(client: MockJiraClient, initial: Record<string, string[]>) {
    const labelsByKey: Record<string, string[]> = { ...initial };
    client.getIssue = async (key: string) => makeIssue(key, labelsByKey[key] ?? []);
    client.updateIssue = async (key: string, fields: Record<string, unknown>) => {
      client.updateIssueCalls.push({ issueKey: key, fields });
      if (Array.isArray(fields.labels)) labelsByKey[key] = fields.labels as string[];
    };
    return labelsByKey;
  }

  it("adds a missing flaw id's label and posts a summarizing comment for a row with a new finding", async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-1': ['veracode', 'veracode-issue-101'] });
    const ticketService = new TicketService(client);
    const group = [makeFlaw('101'), makeFlaw('102')];
    const session = makeReviewSession([makeRow('A1', 'PROJ-1', group)]);
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.labels).toEqual(['veracode', 'veracode-issue-101', 'veracode-issue-102']);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-1');
    expect(client.addCommentCalls[0].body).toContain('Issue 102');
    // Only the newly-added flaw is summarized, not the whole group.
    expect(client.addCommentCalls[0].body).not.toContain('Issue 101');
  });

  it('running the action twice against an unchanged ticket posts no second comment and leaves labels unchanged (idempotency)', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-1': ['veracode', 'veracode-issue-101'] });
    const ticketService = new TicketService(client);
    const group = [makeFlaw('101'), makeFlaw('102')];
    const session = makeReviewSession([makeRow('A1', 'PROJ-1', group)]);
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);
    const persisted = ws.store['jira.session.veracodeReview'] as import('../participant/sessionState').VeracodeReviewSession;
    await handleVeracodeReviewReply('update tickets', persisted, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.addCommentCalls).toHaveLength(1);
  });

  it('skips a row entirely — no label write, no comment — once its ticket already carries every id its group covers', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-2': ['veracode-issue-201', 'veracode-issue-202'] });
    const ticketService = new TicketService(client);
    const group = [makeFlaw('201'), makeFlaw('202')];
    const session = makeReviewSession([makeRow('A1', 'PROJ-2', group)]);
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.addCommentCalls).toHaveLength(0);
  });

  it('a per-row failure (comment post fails) is reported without aborting the rest of the batch, and the already-committed label write is not reported as a total failure', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-3': [], 'PROJ-4': [] });
    client.addComment = async (issueKey: string, body: string) => {
      if (issueKey === 'PROJ-3') throw new Error('Comment post failed');
      client.addCommentCalls.push({ issueKey, body });
    };
    const ticketService = new TicketService(client);
    const session = makeReviewSession([
      makeRow('A1', 'PROJ-3', [makeFlaw('301')]),
      makeRow('A2', 'PROJ-4', [makeFlaw('401')]),
    ]);
    const stream = mockStream();
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, stream as never, ws as never);

    // PROJ-4 still got its label + comment despite PROJ-3's failure.
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-4');
    // Code-review fix: addMissingLabels() already committed PROJ-3's label write before addComment()
    // failed — that write is not undone, and the failure is reported distinctly (⚠, not ✗) so the
    // response doesn't read as if nothing happened to PROJ-3.
    expect(client.updateIssueCalls.map(c => c.issueKey)).toContain('PROJ-3');
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('⚠');
    expect(text).not.toContain('✗');
    expect(text).toContain('PROJ-3');
    expect(text).toContain('label-only (comment failed)');
  });

  it('processes every already-ticketed row in allRows, not just the currently-visible page\'s rows', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-5': [] });
    const ticketService = new TicketService(client);
    const row = makeRow('A1', 'PROJ-5', [makeFlaw('501')]);
    // `rows` (the visible page) does NOT include the already-ticketed row — simulates it having
    // scrolled off whichever page is currently shown; `allRows` (the full candidate set) does.
    const session = makeReviewSession([row], []);
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-5');
  });

  it('a crafted flaw description containing a Jira-native markup trigger cannot survive into the posted comment body', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-6': [] });
    const ticketService = new TicketService(client);
    const evilFlaw = makeFlaw('601', { description: 'Injected !http://evil.example/t.gif! description' });
    const session = makeReviewSession([makeRow('A1', 'PROJ-6', [evilFlaw])]);
    const ws = makeMockWs();

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.addCommentCalls[0].body).not.toContain('!http://evil.example/t.gif!');
    expect(client.addCommentCalls[0].body).not.toMatch(/!/);
  });

  it('re-rendering the review after the action shows "✓ synced" for the updated row and keeps the session alive (no "post it" required)', async () => {
    const client = new MockJiraClient();
    wireStatefulLabels(client, { 'PROJ-7': [] });
    const ticketService = new TicketService(client);
    const session = makeReviewSession([makeRow('A1', 'PROJ-7', [makeFlaw('701')])]);
    const ws = makeMockWs();
    const stream = mockStream();

    await handleVeracodeReviewReply('update tickets', session, ticketService, stream as never, ws as never);

    // The review session is still parked (not cleared) — this action doesn't require/imply "post it".
    expect(ws.store['jira.session.veracodeReview']).toBeDefined();
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('✓ synced');
  });
});

describe('handleWaltzReviewReply — paging via the same shared code path as Veracode (U4/R8)', () => {
  function makeWaltzRow(id: string): WaltzReviewRow {
    return {
      id, nameVersion: `pkg-${id}:1.0.0`, maxVulnRating: 'High',
      summary: `[OSS] pkg-${id}:1.0.0 — High`, labels: ['oss-dependency'], descriptionWiki: 'x',
      existingTicketKey: null, included: true,
    };
  }

  it('pages a 70-row "New" section into 2 pages and navigates with next/prev, identically to Veracode', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    const allRows: WaltzReviewRow[] = Array.from({ length: 70 }, (_, i) => makeWaltzRow(String(i + 1)));
    const initial = buildReviewPage(allRows, 0);
    const session: WaltzReviewSession = {
      projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
      allRows, rows: initial.rows, page: initial.page, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    const ws = makeMockWs();

    expect(session.rows).toHaveLength(50);

    const stream = mockStream();
    await handleWaltzReviewReply('next', session, ticketService, stream as never, ws as never);

    expect(session.page).toBe(1);
    expect(session.rows).toHaveLength(20);
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain('Page 2 of 2');
  });
});

// U6: Stale-ticket review section + transition, exercised end to end through the generic test
// descriptor (the shared code path both Veracode's and Waltz's real descriptors reuse).
describe('Stale-ticket review + transition (U6)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  const dummyPath = [{ id: '1', name: 'Go', to: 'Done' }];

  // The test descriptor's own marker scheme: a batch's marker label is 'test-marker'; a candidate's
  // own id rides on a 'test-id-<id>' label (mirrors veracodeLabelToIssueId/waltzLabelToDedupKey's
  // shape without pulling in either importer's real regex).
  function makeStaleIssue(key: string, issueType: string, ids: string[], status = 'Open') {
    return {
      key,
      fields: {
        summary: `Summary for ${key}`,
        status: { name: status },
        issuetype: { name: issueType },
        labels: ['test-marker', ...ids.map(id => `test-id-${id}`)],
      },
    };
  }

  function makeStaleDescriptor(activeIds: string[] = []): ReportImportDescriptor<TestItem, TestRow> {
    const activeSet = new Set(activeIds);
    return {
      ...descriptor,
      stale: {
        markerLabel: 'test-marker',
        labelToDedupKey: (label) => {
          const m = label.match(/^test-id-(.+)$/);
          return m ? m[1] : null;
        },
        buildActivePredicate: () => (id: string) => activeSet.has(id),
      },
    };
  }

  // Routes ticketService.searchTicketsRaw by JQL shape: the dedup search ("labels in (...)") always
  // comes back empty (these tests focus on the stale section, not dedup) and the stale search
  // ("labels = \"test-marker\"") returns whatever candidates the test supplies.
  function mockSearches(staleIssues: ReturnType<typeof makeStaleIssue>[] = []): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
      if (jql.includes('labels in (')) return { issues: [], total: 0 };
      if (jql.includes('labels = "test-marker"')) return { issues: staleIssues as never, total: staleIssues.length, isLast: true };
      return { issues: [], total: 0 };
    });
  }

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: {
        Bug: { discovered: '2024-01-01', graph: { Open: [{ id: '1', name: 'Go', to: 'Done' }], Done: [] } },
        Task: { discovered: '2024-01-01', graph: { Open: [{ id: '1', name: 'Go', to: 'Done' }], Done: [] } },
      },
    });
    vi.mocked(findPath).mockReturnValue(dummyPath);
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  });

  it("a stale ticket toggled included transitions to its rule's target state with its rule's resolution on confirm", async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, makeStaleDescriptor());
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.staleTickets?.groups[0].tickets[0].included).toBe(false); // R3 default

    await handleImportReviewReply('PROJ-1', reviewSession, ticketService, mockStream() as never, ws as never, makeStaleDescriptor());
    expect(reviewSession.staleTickets?.groups[0].tickets[0].included).toBe(true);

    await handleImportReviewReply('post it', reviewSession, ticketService, mockStream() as never, ws as never, makeStaleDescriptor());

    expect(client.executeTransitionCalls).toHaveLength(1);
    expect(client.executeTransitionCalls[0]).toMatchObject({ issueKey: 'PROJ-1', fields: { resolution: { name: 'Fixed' } } });
  });

  it('a stale ticket left at its default (unselected) does not transition on confirm', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, makeStaleDescriptor());
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('post it', reviewSession, ticketService, mockStream() as never, ws as never, makeStaleDescriptor());

    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('a stale ticket with no matching cleanupRules entry renders excluded with a note and cannot be toggled in', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules: [] }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-2', 'Bug', ['2'])]);
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(reviewSession.staleTickets?.groups).toEqual([]);
    expect(reviewSession.staleTickets?.ineligible[0]).toMatchObject({ key: 'PROJ-2' });
    expect(reviewSession.staleTickets?.ineligible[0].note).toContain('no cleanup rule configured');

    const stream = mockStream();
    await handleImportReviewReply('PROJ-2', reviewSession, ticketService, stream as never, ws as never, staleDescriptor);
    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(text).toContain("Didn't understand that");
  });

  it('asks the resolution question only after "close tickets", once per selected group, never up front (R9/AE3)', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [
          { name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' },
          { name: 'close-tasks', project: 'PROJ', issueType: 'Task', targetState: 'Done' },
        ],
      }),
    }) as never);
    mockSearches([
      makeStaleIssue('PROJ-1', 'Bug', ['1']),
      makeStaleIssue('PROJ-2', 'Bug', ['2']),
      makeStaleIssue('PROJ-3', 'Task', ['3']),
      makeStaleIssue('PROJ-4', 'Task', ['4']),
    ]);
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    // The import opens straight on the Stale screen (its only group) — no question asked yet.
    const stream1 = mockStream();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream1 as never, ws as never, staleDescriptor);
    const text1 = markdownText((stream1.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(text1).toContain('### Stale');
    expect(text1).not.toContain('which resolution');
    expect(ws.store['jira.session.staleResolution']).toBeUndefined();
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    // Select one Bug and one Task ticket, then close: one question per group with a selection.
    await handleImportReviewReply('PROJ-1', reviewSession, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('PROJ-3', reviewSession, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const stream2 = mockStream();
    await handleImportReviewReply('close tickets', reviewSession, ticketService, stream2 as never, ws as never, staleDescriptor);
    expect(markdownText((stream2.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('**1** stale **Bug**');
    expect(client.executeTransitionCalls).toHaveLength(0); // nothing transitions before the answers

    const { continueAfterStaleResolution } = await import('../participant/jira/reportImportHandler');
    const ask1 = ws.store['jira.session.staleResolution'] as never as { pendingGroups: unknown[] };
    expect(ask1.pendingGroups).toHaveLength(2);
    const stream3 = mockStream();
    await continueAfterStaleResolution('Fixed', ask1 as never, stream3 as never, ws as never, staleDescriptor, ticketService);
    expect(markdownText((stream3.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('**1** stale **Task**');

    const ask2 = ws.store['jira.session.staleResolution'] as never;
    await continueAfterStaleResolution("Won't Fix", ask2, mockStream() as never, ws as never, staleDescriptor, ticketService);

    expect(client.executeTransitionCalls.map(c => c.issueKey).sort()).toEqual(['PROJ-1', 'PROJ-3']);
    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(after.staleTickets?.groups.find(g => g.issueType === 'Bug')?.resolution).toBe('Fixed');
    expect(after.staleTickets?.groups.find(g => g.issueType === 'Task')?.resolution).toBe("Won't Fix");
    expect(after.staleTickets?.closedKeys?.sort()).toEqual(['PROJ-1', 'PROJ-3']);
    expect(after.outcomes?.closed).toBe(2);

    // A later close of the other Bug ticket is not asked again — the Bug group was answered.
    await handleImportReviewReply('PROJ-2', after, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('close tickets', after, ticketService, mockStream() as never, ws as never, staleDescriptor);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toContain('PROJ-2');
  });

  it('"back" or "cancel" on the resolution question returns to the Stale screen without closing anything; "skip" still means no resolution', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [], cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    const { continueAfterStaleResolution } = await import('../participant/jira/reportImportHandler');

    // Select the ticket, close, then back out of the resolution question.
    await handleImportReviewReply('PROJ-1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const fresh = session;
    await handleImportReviewReply('close tickets', fresh, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const stream = mockStream();
    await continueAfterStaleResolution('back', ws.store['jira.session.staleResolution'] as never, stream as never, ws as never, staleDescriptor, ticketService);
    expect(client.executeTransitionCalls).toHaveLength(0);
    expect(ws.store['jira.session.staleResolution']).toBeUndefined();
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('### Stale');

    await handleImportReviewReply('close tickets', ws.store[descriptor.sessionKeys.review] as never, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await continueAfterStaleResolution('cancel', ws.store['jira.session.staleResolution'] as never, mockStream() as never, ws as never, staleDescriptor, ticketService);
    expect(client.executeTransitionCalls).toHaveLength(0);

    await handleImportReviewReply('close tickets', ws.store[descriptor.sessionKeys.review] as never, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await continueAfterStaleResolution('skip', ws.store['jira.session.staleResolution'] as never, mockStream() as never, ws as never, staleDescriptor, ticketService);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(client.executeTransitionCalls[0].fields).toBeUndefined();
  });

  it('a group answered "none" transitions without a resolution and is never asked again', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [], cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-2', 'Bug', ['2'])]);
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('PROJ-1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('close tickets', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const { continueAfterStaleResolution } = await import('../participant/jira/reportImportHandler');
    await continueAfterStaleResolution('none', ws.store['jira.session.staleResolution'] as never, mockStream() as never, ws as never, staleDescriptor, ticketService);
    expect(client.executeTransitionCalls).toHaveLength(1);
    expect(client.executeTransitionCalls[0].fields).toBeUndefined();

    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    await handleImportReviewReply('PROJ-2', after, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const stream = mockStream();
    await handleImportReviewReply('close tickets', after, ticketService, stream as never, ws as never, staleDescriptor);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).not.toContain('which resolution');
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('a second "close tickets" never re-transitions a ticket that is already closed', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [], cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('PROJ-1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('close tickets', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const stream = mockStream();
    await handleImportReviewReply('ok', session, ticketService, stream as never, ws as never, staleDescriptor);

    expect(client.executeTransitionCalls).toHaveLength(1);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('Nothing selected');
    expect(text).toContain('✓ closed');
  });

  it('F1: overview → close a stale ticket → create new rows → done, each group acting only on its own rows', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: 'new-1' }, { ref: 'new-2' }], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    const stream0 = mockStream();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream0 as never, ws as never, staleDescriptor);
    const first = markdownText((stream0.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(first).toContain('### Import results');
    expect(first.toLowerCase()).not.toContain('post it');
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('open stale', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('PROJ-1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const streamClose = mockStream();
    await handleImportReviewReply('close tickets', session, ticketService, streamClose as never, ws as never, staleDescriptor);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(client.createIssueCalls).toHaveLength(0); // closing touched nothing in New (R11)
    expect(session.view).toBe('overview');
    expect(markdownText((streamClose.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('1 closed');

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('create tickets', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.executeTransitionCalls).toHaveLength(1); // creating touched nothing in Stale (R11)

    const streamDone = mockStream();
    await handleImportReviewReply('done', session, ticketService, streamDone as never, ws as never, staleDescriptor);
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    expect(markdownText((streamDone.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]))
      .toBe('Import finished — **2** created, 0 re-created, 0 updated, 1 closed.');
  });

  it('a reply is read only against the screen showing: a row id on the Stale screen and a ticket key on the New screen are rejected (R6/AE2)', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({
        templates: [],
        cleanupRules: [{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
      }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-123', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: '2' }], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const streamNew = mockStream();
    await handleImportReviewReply('PROJ-123', session, ticketService, streamNew as never, ws as never, staleDescriptor);
    expect(markdownText((streamNew.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false);

    await handleImportReviewReply('back', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('open stale', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const streamStale = mockStream();
    await handleImportReviewReply('1', session, ticketService, streamStale as never, ws as never, staleDescriptor);
    expect(markdownText((streamStale.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    expect(session.rows.find(r => r.id === '1')!.included).toBe(true); // untouched

    // A mixed reply is rejected whole rather than half-applied.
    await handleImportReviewReply('PROJ-123 1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false);
  });

  // Code-review fix regression test: the truncation-coverage warning used to be nested inside
  // `stale.length > 0`, so it silently never rendered when a truncated search's checked candidates
  // all turned out non-stale — defeating KTD10's "must not silently lose coverage" guarantee.
  it('the truncation-coverage warning renders even when none of the checked candidates turned out stale', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules: [] }),
    }) as never);
    vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
      if (jql.includes('labels in (')) return { issues: [], total: 0 };
      if (jql.includes('labels = "test-marker"')) {
        // The one checked candidate is still active (not stale), but the search itself hit the cap.
        return { issues: [makeStaleIssue('PROJ-1', 'Bug', ['1'])], total: 200, isLast: false };
      }
      return { issues: [], total: 0 };
    });
    const staleDescriptor = makeStaleDescriptor(['1']); // '1' active -> PROJ-1 is not stale
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream as never, ws as never, staleDescriptor);

    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('Checked the first');
    expect(text).toContain('200');
  });

  // Code-review fix regression test: buildStaleTicketGroups() (and the synchronous
  // TemplateService.loadTemplates() it calls internally) had no guard, unlike the dedup-search
  // block right above it — a throw here used to propagate out and discard the whole in-progress
  // review instead of degrading gracefully.
  it('a failure inside buildStaleTicketGroups (e.g. a malformed templates file) degrades gracefully instead of discarding the whole review', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockImplementation(() => { throw new Error('Malformed .jira-templates.json'); }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: '2' }], availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream as never, ws as never, staleDescriptor);

    // The review session survived and was rendered/persisted — not discarded by the throw.
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow> | undefined;
    expect(reviewSession).toBeDefined();
    expect(reviewSession!.staleTickets).toBeUndefined();

    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('could not check for stale tickets');
  });
});

// Overview hub (docs/plans/2026-09-23-1400-feat-report-import-overview-hub-plan.md): each group's
// action runs on its own and returns to the overview; nothing else in the session is touched.
describe('Overview hub — per-group actions (R7, R8, R10, R13, R15, R16)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function buildSession(count: number, ws: ReturnType<typeof makeMockWs>, ticketedRefs: string[] = []): Promise<ReviewSession<TestRow>> {
    if (ticketedRefs.length > 0) {
      vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({
        issues: ticketedRefs.map((ref, i) => ({ key: `PROJ-${900 + i}`, fields: { labels: [`test-${ref}`] } })),
        total: ticketedRefs.length, isLast: true,
      } as unknown as JiraSearchResult);
    }
    const items: TestItem[] = Array.from({ length: count }, (_, i) => ({ ref: String(i + 1) }));
    await continueAfterImportIssueType('Bug', null, makeSession({ items, availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, descriptor);
    return ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
  }

  it('AE5: creating page 1 of 62 new rows creates 50, the overview reads "50 created · 12 left", and New then shows the other 12', async () => {
    const ws = makeMockWs();
    const session = await buildSession(63, ws, ['63']); // 62 new + 1 already ticketed -> overview
    expect(session.view).toBe('overview');

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, descriptor);
    const stream = mockStream();
    await handleImportReviewReply('create tickets', session, ticketService, stream as never, ws as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(50);
    expect(session.view).toBe('overview');
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('50 created · 12 left');

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, descriptor);
    const fresh = session.rows.filter(r => r.existingTicketKey === null);
    expect(fresh).toHaveLength(12);
    expect(fresh[0].ref).toBe('51');
  });

  it('a repeated "create tickets" never re-creates rows already created', async () => {
    const ws = makeMockWs();
    const session = await buildSession(3, ws); // New only -> single group, stays on New
    await handleImportReviewReply('create tickets', session, ticketService, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('create tickets', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(client.createIssueCalls).toHaveLength(3);
    expect(session.view).toBe('new');
  });

  it('a row excluded before "create tickets" stays in the New table, still excluded, and is not counted afterwards', async () => {
    const ws = makeMockWs();
    const session = await buildSession(4, ws);
    await handleImportReviewReply('3', session, ticketService, mockStream() as never, ws as never, descriptor);
    const stream = mockStream();
    await handleImportReviewReply('ok', session, ticketService, stream as never, ws as never, descriptor);

    expect(client.createIssueCalls.map(c => c.summary)).toEqual(['Summary 1', 'Summary 2', 'Summary 4']);
    expect(session.rows.map(r => [r.id, r.included])).toEqual([['3', false]]);
    const screen = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(screen).toContain('**0** ticket(s) will be created.');

    await handleImportReviewReply('create tickets', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(client.createIssueCalls).toHaveLength(3); // the excluded row was not created by a second confirm
  });

  it('a per-row creation failure is reported with ✗ and the row stays in the New table, still included', async () => {
    const ws = makeMockWs();
    const session = await buildSession(2, ws);
    const original = client.createIssue.bind(client);
    client.createIssue = (async (...args: Parameters<typeof client.createIssue>) => {
      if (args[1] === 'Summary 2') throw new Error('Field "priority" is required');
      return original(...args);
    }) as typeof client.createIssue;
    const stream = mockStream();

    await handleImportReviewReply('create tickets', session, ticketService, stream as never, ws as never, descriptor);

    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('✗ 2');
    expect(session.rows.map(r => [r.id, r.included])).toEqual([['2', true]]);
    expect(session.outcomes).toMatchObject({ created: 1, createFailed: 1 });
  });

  it('"re-create tickets" creates one ticket per toggled already-ticketed row, marks it, and never repeats it', async () => {
    const ws = makeMockWs();
    const session = await buildSession(3, ws, ['1', '2']); // A1, A2 + one new row
    await handleImportReviewReply('open already ticketed', session, ticketService, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('A2', session, ticketService, mockStream() as never, ws as never, descriptor);
    await handleImportReviewReply('re-create tickets', session, ticketService, mockStream() as never, ws as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].summary).toBe('Summary 2');
    const a2 = session.allRows.find(r => r.id === 'A2')!;
    expect(a2.recreatedKey).toBeDefined();
    expect(session.view).toBe('overview');

    await handleImportReviewReply('open already ticketed', session, ticketService, mockStream() as never, ws as never, descriptor);
    const stream = mockStream();
    await handleImportReviewReply('A2', session, ticketService, stream as never, ws as never, descriptor);
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    await handleImportReviewReply('re-create tickets', session, ticketService, mockStream() as never, ws as never, descriptor);
    expect(client.createIssueCalls).toHaveLength(1);
  });

  it('"re-create tickets" then "update tickets" on the same row never updates the ticket that was just replaced', async () => {
    const ws = makeMockWs();
    const session = await buildSession(3, ws, ['1', '2']);
    session.allRows = session.allRows.map(r => (r.existingTicketKey ? { ...r, hasUnsyncedFindings: true } : r));
    const updateDescriptor: ReportImportDescriptor<TestItem, TestRow> = {
      ...descriptor,
      updateExisting: { idsOf: row => [row.ref], labelOf: id => `test-${id}`, buildCommentWiki: () => 'c' },
    };
    const addMissing = vi.spyOn(ticketService, 'addMissingLabels').mockResolvedValue(['x']);
    vi.spyOn(ticketService, 'addComment').mockResolvedValue(undefined as never);

    await handleImportReviewReply('open already ticketed', session, ticketService, mockStream() as never, ws as never, updateDescriptor);
    await handleImportReviewReply('A2', session, ticketService, mockStream() as never, ws as never, updateDescriptor);
    await handleImportReviewReply('re-create tickets', session, ticketService, mockStream() as never, ws as never, updateDescriptor);
    await handleImportReviewReply('open already ticketed', session, ticketService, mockStream() as never, ws as never, updateDescriptor);
    await handleImportReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never, updateDescriptor);

    expect(addMissing.mock.calls.map(c => c[0])).toEqual(['PROJ-900']); // A1 only; A2 (PROJ-901) was re-created
  });

  it('an import whose only rows are already ticketed opens straight into that screen with "Done" (R4)', async () => {
    const ws = makeMockWs();
    const stream = mockStream();
    vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({
      issues: [{ key: 'PROJ-900', fields: { labels: ['test-1'] } }], total: 1, isLast: true,
    } as unknown as JiraSearchResult);
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: '1' }], availableIssueTypes: ['Bug'] }), client, ticketService, stream as never, ws as never, descriptor);

    const text = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(text).toContain('### Already ticketed');
    expect(text).not.toContain('### Import results');
    expect(text).not.toContain('Back to overview');
  });

  it('a reply after a newer import claimed the session key is ignored and the old review is closed', async () => {
    const ws = makeMockWs();
    const session = await buildSession(2, ws);
    ws.store[descriptor.sessionKeys.templateSelection] = { projectKey: 'PROJ' }; // a newer import started
    const stream = mockStream();

    await handleImportReviewReply('create tickets', session, ticketService, stream as never, ws as never, descriptor);

    expect(client.createIssueCalls).toHaveLength(0);
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('A newer import was started');
  });

  it('cancelling on the overview ends the import with the same summary as "done"', async () => {
    const ws = makeMockWs();
    const session = await buildSession(2, ws, ['1']);
    expect(session.view).toBe('overview');
    const stream = mockStream();
    await handleImportReviewReply('cancel', session, ticketService, stream as never, ws as never, descriptor);
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('Import finished — **0** created');
  });
});

describe('Overview hub — Veracode "update tickets" vs Waltz (AE4, R16)', () => {
  function makeFlaw(issueId: string, line: number): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
      description: 'd', recommendation: null, module: 'app.jar', sourceFile: 'App.java',
      sourceFilePath: 'src/main/java/App.java', line, scope: null, functionPrototype: null, remediationStatus: 'New',
    };
  }

  it('AE4: "update tickets" touches only the tickets missing a finding and creates nothing', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    // Three already-ticketed lines; lines 10 and 20 each gained a second flaw since their ticket.
    const flaws = [makeFlaw('101', 10), makeFlaw('102', 10), makeFlaw('201', 20), makeFlaw('202', 20), makeFlaw('301', 30)];
    vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => (jql.includes('labels in (')
      ? {
        issues: [
          { key: 'PROJ-1', fields: { labels: ['veracode-issue-101'] } },
          { key: 'PROJ-2', fields: { labels: ['veracode-issue-201'] } },
          { key: 'PROJ-3', fields: { labels: ['veracode-issue-301'] } },
        ], total: 3, isLast: true,
      }
      : { issues: [], total: 0, isLast: true }) as never);
    const labelsByKey: Record<string, string[]> = { 'PROJ-1': ['veracode-issue-101'], 'PROJ-2': ['veracode-issue-201'], 'PROJ-3': ['veracode-issue-301'] };
    client.getIssue = async (key: string) => ({ id: '1', key, fields: { labels: labelsByKey[key] } as JiraIssue['fields'] });
    const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
    const ws = makeMockWs();
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
    };
    await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);
    const session = ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
    expect(session.view).toBe('ticketed');

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls.map(c => c.issueKey).sort()).toEqual(['PROJ-1', 'PROJ-2']);
    expect(client.createIssueCalls).toHaveLength(0);
    expect(session.outcomes?.updated).toBe(2);
  });

  it('Waltz rejects "update tickets" on its Already-ticketed screen (no update action)', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    const row: WaltzReviewRow = {
      id: 'A1', nameVersion: 'pkg:1.0.0', maxVulnRating: 'High', summary: 's', labels: [], descriptionWiki: 'x',
      existingTicketKey: 'PROJ-1', included: false, hasUnsyncedFindings: true,
    };
    const session: WaltzReviewSession = {
      projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
      allRows: [row], rows: [row], page: 0, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    const stream = mockStream();
    await handleWaltzReviewReply('update tickets', session, ticketService, stream as never, makeMockWs() as never);
    expect(markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    expect(client.updateIssueCalls).toHaveLength(0);
  });
});
