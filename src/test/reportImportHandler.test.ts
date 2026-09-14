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
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import type { WaltzReviewRow } from '../utils/waltzReport';
import type { JiraSearchResult } from '../jira/IJiraClient';

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

    // executeImportBatch (invoked via the review flow) creates one ticket per included row.
    const { executeImportBatch } = await import('../participant/jira/reportImportHandler');
    await executeImportBatch(reviewSession, ticketService, mockStream() as never, descriptor);

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

    // Row '1' is already-ticketed (dedup-matched) — its id is 'A1', shown on every page.
    expect(session.rows.find(r => r.existingTicketKey !== null)!.id).toBe('A1');
    await handleImportReviewReply('A1', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // toggled on (force re-create)

    await handleImportReviewReply('next', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // survives the page change

    await handleImportReviewReply('prev', session, ticketService2, mockStream() as never, ws as never, descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.included).toBe(true); // still survives
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
