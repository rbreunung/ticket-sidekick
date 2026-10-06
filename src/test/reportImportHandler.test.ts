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
// reads the cached workflow graph — only the cache read is mocked, so each stale test controls its
// own graph while path-finding and the reachable-status lookup run for real against it.
vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import * as vscode from 'vscode';
import {
  buildImportTemplateSession, streamImportTemplateSelection, handleImportTemplateSelection,
  continueAfterImportIssueType, handleImportReviewReply, continueStaleClose,
  type ReportImportDescriptor, type ReportImportRow,
} from '../participant/jira/reportImportHandler';
import {
  handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply,
} from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import {
  buildReviewPage, CURRENT_SESSION_SCHEMA_VERSION,
  type ImportTemplateSelectionSession, type ReviewSession, type VeracodeTemplateSelectionSession,
  type WaltzTemplateSelectionSession, type AwaitIssueTypeResume, type VeracodeReviewSession, type WaltzReviewSession,
} from '../participant/sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from '../participant/jira/ticketContext';
import { loadWorkflowCache } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import { sanitizeComponentLabel, type WaltzReviewRow, type WaltzComponent, type WaltzVulnerability } from '../utils/waltzReport';
import type { JiraSearchResult, JiraIssue } from '../jira/IJiraClient';

interface TestItem {
  ref: string;
  findings?: string[];
}

interface TestRow extends ReportImportRow {
  ref: string;
  findings: string[];
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
  buildRowFields: item => ({ ref: item.ref, findings: item.findings ?? [], labels: [], summary: `Summary ${item.ref}`, descriptionWiki: 'desc' }),
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

  it('asks the dedup search for each ticket\'s resolution and creation date (U3/KTD1)', async () => {
    const spy = vi.spyOn(ticketService, 'searchTicketsRaw').mockResolvedValue({
      issues: [{ key: 'PROJ-999', fields: { labels: ['test-1'], resolution: null, created: '2026-01-01T09:00:00.000+0000', status: { name: 'Open' } } }],
      total: 1, isLast: true,
    } as unknown as JiraSearchResult);
    const ws = makeMockWs();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: '1' }], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, descriptor);

    const dedupCall = spy.mock.calls.find(([jql]) => jql.includes('labels in ('))!;
    expect(dedupCall[2]).toEqual(['resolution', 'created']);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(session.allRows.find(r => r.id === 'A1')!.existingTicketKey).toBe('PROJ-999');
  });

  it('reads every page of the dedup search, so a ticket beyond the first page still counts as already-ticketed', async () => {
    // 100 unrelated tickets fill page 1; the ticket for item 1 only appears on page 2.
    const filler = Array.from({ length: 100 }, (_, i) => ({ key: `PROJ-${i + 1}`, fields: { labels: ['unrelated'] } }));
    const spy = vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string, _max?: number, _fields?: string[], startAt?: number) => {
      if (!jql.includes('labels in (')) return { issues: [], total: 0, isLast: true } as unknown as JiraSearchResult;
      return (startAt ?? 0) === 0
        ? { issues: filler, total: 101 } as unknown as JiraSearchResult
        : { issues: [{ key: 'PROJ-500', fields: { labels: ['test-1'] } }], total: 101 } as unknown as JiraSearchResult;
    });
    const ws = makeMockWs();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: '1' }], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, descriptor);

    expect(spy.mock.calls.filter(([jql]) => jql.includes('labels in (')).map(c => c[3] ?? 0)).toEqual([0, 100]);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(session.allRows.find(r => r.id === 'A1')!.existingTicketKey).toBe('PROJ-500');
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

describe('handleWaltzReviewReply — paging via the same shared code path as Veracode (U4/R8)', () => {
  function makeWaltzRow(id: string): WaltzReviewRow {
    return {
      id, nameVersion: `pkg-${id}:1.0.0`, maxVulnRating: 'High',
      summary: `[OSS] pkg-${id}:1.0.0 — High`, labels: ['oss-dependency'], descriptionWiki: 'x',
      sourceComponent: { nameVersion: `pkg-${id}:1.0.0`, maxVulnRating: 'High', remediationAction: null, instancePaths: [], vulnerabilities: [] },
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

// Stale-ticket review section + close (U6, reworked by the stale-ticket target pick plan),
// exercised end to end through the generic test descriptor — the shared code path both Veracode's
// and Waltz's real descriptors reuse.
describe('Stale-ticket review + close with a picked target', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  const CLOSE_KEY = 'jira.session.staleResolution';
  const bugGraph = {
    Open: [{ id: '11', name: 'Verify', to: 'Verification' }, { id: '12', name: 'Close', to: 'Done' }],
    Verification: [{ id: '21', name: 'Accept', to: 'Done' }],
    Done: [],
  };

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

  function makeStaleDescriptor(activeIds: string[] = [], kind: 'veracode' | 'waltz' = 'veracode'): ReportImportDescriptor<TestItem, TestRow> {
    const activeSet = new Set(activeIds);
    return {
      ...descriptor,
      descriptorKind: kind,
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

  function withRules(cleanupRules: unknown[]): void {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules }),
    }) as never);
  }

  // Runs an import whose only result group is Stale and returns the stored review session.
  async function importStale(
    issues: ReturnType<typeof makeStaleIssue>[],
    ws: ReturnType<typeof makeMockWs>,
    staleDescriptor = makeStaleDescriptor(),
  ): Promise<ReviewSession<TestRow>> {
    mockSearches(issues);
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    return ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
  }

  async function reply(text: string, ws: ReturnType<typeof makeMockWs>, staleDescriptor = makeStaleDescriptor()): Promise<string> {
    const stream = mockStream();
    const close = ws.store[CLOSE_KEY];
    if (close) {
      await continueStaleClose(text, close as never, stream as never, ws as never, staleDescriptor, ticketService);
    } else {
      await handleImportReviewReply(text, ws.store[descriptor.sessionKeys.review] as never, ticketService, stream as never, ws as never, staleDescriptor);
    }
    return (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
  }

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: {
        Bug: { discovered: '2024-01-01', graph: bugGraph },
        Vulnerability: { discovered: '2024-01-01', graph: { Open: [{ id: '31', name: 'Close', to: 'Done' }], Done: [] } },
      },
    });
    withRules([]);
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  });

  it('AE1: with no cleanup rule, a selected ticket can be moved to a non-final status and no resolution is asked', async () => {
    const ws = makeMockWs();
    const session = await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false); // nothing selected by default

    await reply('PROJ-1', ws);
    const pick = await reply('close tickets', ws);
    expect(pick).toContain('Where should the **1** selected stale **Bug** ticket(s) go?');
    expect(pick).toContain('Done');
    expect(pick).toContain('Verification');
    expect(client.executeTransitionCalls).toHaveLength(0); // nothing moves before the pick

    const done = await reply('Verification', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '11', fields: undefined }]);
    expect(done).toContain('**1** stale ticket(s) transitioned to **Verification**');
    expect(done).not.toContain('which resolution');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
  });

  it('AE2: picking a cleanup rule applies its target and its resolution without asking', async () => {
    withRules([{ name: 'Close released bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    await reply('PROJ-1', ws);
    const pick = await reply('close tickets', ws);
    expect(pick).toContain('Close released bugs → Done');

    const done = await reply('1', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Fixed' } } }]);
    expect(done).not.toContain('which resolution');
  });

  it('a rule with a closing target and no resolution asks for one once, then transitions with the answer', async () => {
    withRules([{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    const ask = await reply('close-bugs', ws);
    expect(ask).toContain('which resolution should be set?');
    expect(client.executeTransitionCalls).toHaveLength(0);

    await reply('Fixed', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Fixed' } } }]);
  });

  it('a plain closing status asks for a resolution; "none" (or "skip") transitions without one', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-2', 'Bug', ['2'])], ws);

    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    expect(await reply('Done', ws)).toContain('which resolution should be set?');
    await reply('none', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: undefined }]);

    await reply('PROJ-2', ws);
    await reply('close tickets', ws);
    await reply('Done', ws);
    await reply('skip', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(client.executeTransitionCalls[1].fields).toBeUndefined();
  });

  it('a stale ticket left at its default (unselected) does not transition on confirm', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    const text = await reply('post it', ws);

    expect(text).toContain('Nothing selected');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('a stale ticket with no discovered workflow renders excluded with a note and cannot be toggled in', async () => {
    const ws = makeMockWs();
    const session = await importStale([makeStaleIssue('PROJ-2', 'Task', ['2'])], ws);
    expect(session.staleTickets?.groups).toEqual([]);
    expect(session.staleTickets?.ineligible[0]).toMatchObject({ key: 'PROJ-2' });
    expect(session.staleTickets?.ineligible[0].note).toContain('@jira discover workflow PROJ Task');

    expect(await reply('PROJ-2', ws)).toContain("Didn't understand that");
  });

  it('a resolution whose name is also a cancel word is set, not treated as going back', async () => {
    vi.spyOn(client, 'getResolutions').mockResolvedValue([{ name: 'Fixed' }, { name: 'Cancelled' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    expect(await reply('Done', ws)).toContain('which resolution should be set?');

    await reply('Cancelled', ws);

    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Cancelled' } } }]);
  });

  it('at the resolution step, a cancel word that names no resolution still goes back', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    await reply('Done', ws);

    const back = await reply('stop', ws);

    expect(back).toContain('No stale tickets were transitioned');
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('AE4: "back" or a cancellation word at the target or resolution step returns to the Stale screen with nothing transitioned', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);

    await reply('close tickets', ws);
    const back = await reply('back', ws);
    expect(back).toContain('No stale tickets were transitioned');
    expect(back).toContain('### Stale');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();

    await reply('close tickets', ws);
    await reply('cancel', ws);
    expect(ws.store[CLOSE_KEY]).toBeUndefined();

    await reply('close tickets', ws);
    await reply('Done', ws);
    await reply('back', ws);
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('AE5: a selected ticket with no path to the picked status is skipped with a note; the others are transitioned', async () => {
    const ws = makeMockWs();
    await importStale([
      makeStaleIssue('PROJ-1', 'Bug', ['1']),
      makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done'),
      makeStaleIssue('PROJ-3', 'Bug', ['3'], 'Verification'),
    ], ws);
    await reply('PROJ-1 PROJ-2 PROJ-3', ws);
    await reply('close tickets', ws);

    const done = await reply('Verification', ws);

    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(done).toContain('PROJ-2 skipped — no path found from Done to Verification');
    expect(done).toContain('PROJ-3 skipped — already in Verification');
    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(after.staleTickets?.closedKeys).toEqual(['PROJ-1']);
    // Skipped tickets are deselected, so the next close doesn't just repeat the same skip.
    expect(after.staleTickets?.groups[0].tickets.filter(t => t.included).map(t => t.key)).toEqual(['PROJ-1']);
  });

  it('AE6: with Bug and Vulnerability tickets selected, one issue type is closed per run and the other stays selected', async () => {
    const ws = makeMockWs();
    await importStale([
      makeStaleIssue('PROJ-1', 'Bug', ['1']),
      makeStaleIssue('PROJ-2', 'Bug', ['2']),
      makeStaleIssue('PROJ-3', 'Vulnerability', ['3']),
    ], ws);
    await reply('PROJ-1 PROJ-2 PROJ-3', ws);

    const typeAsk = await reply('close tickets', ws);
    expect(typeAsk).toContain('Which issue type do you want to close now?');
    expect(typeAsk).toContain('Bug');
    expect(typeAsk).toContain('Vulnerability');

    const targetAsk = await reply('Bug', ws);
    expect(targetAsk).toContain('**2** selected stale **Bug**');
    expect(targetAsk).toContain('Verification'); // Bug's workflow, not Vulnerability's

    const done = await reply('Verification', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(after.view).toBe('stale');
    expect(done).toContain('### Stale');
    const vuln = after.staleTickets?.groups.find(g => g.issueType === 'Vulnerability');
    expect(vuln?.tickets[0].included).toBe(true);

    // The next close goes straight to the target pick for the one remaining issue type.
    expect(await reply('close tickets', ws)).toContain('**1** selected stale **Vulnerability**');
  });

  it('AE4: "back" at the issue-type step returns to the Stale screen', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-3', 'Vulnerability', ['3'])], ws);
    await reply('PROJ-1 PROJ-3', ws);
    await reply('close tickets', ws);

    expect(await reply('back', ws)).toContain('### Stale');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('an unrecognized reply at a step shows the same step again', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);

    const again = await reply('Archived', ws);

    expect(again).toContain("Didn't understand that");
    expect(again).toContain('Where should the **1** selected stale **Bug** ticket(s) go?');
    expect((ws.store[CLOSE_KEY] as { step: string }).step).toBe('pick-target');
  });

  it('when no rule matches and the selected tickets can reach nothing, close explains and asks nothing', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done')], ws);
    await reply('PROJ-2', ws);

    const text = await reply('close tickets', ws);

    expect(text).toContain("can't reach any status in the discovered workflow");
    expect(text).toContain('@jira discover workflow PROJ Bug');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('when every selected ticket is skipped, the run transitions nothing and says why for each', async () => {
    withRules([{ name: 'verify-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Verification' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done')], ws);
    await reply('PROJ-2', ws);
    await reply('close tickets', ws);

    const done = await reply('verify-bugs', ws);

    expect(client.executeTransitionCalls).toHaveLength(0);
    expect(done).toContain('**0** stale ticket(s) transitioned to **Verification**, 0 failed, 1 skipped.');
    expect(done).toContain('PROJ-2 skipped — no path found from Done to Verification');
  });

  it('the overview counts tickets that cannot be closed without blaming a missing cleanup rule', async () => {
    const ws = makeMockWs();
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-2', 'Task', ['2'])]);
    const stream = mockStream();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: 'n-1' }], availableIssueTypes: ['Bug'] }), client, ticketService, stream as never, ws as never, makeStaleDescriptor());

    const overview = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(overview).toContain('1 not closable (no discovered workflow)');
    expect(overview).not.toContain('cleanup rule');
  });

  it('a second "close tickets" never re-transitions a ticket that was already transitioned', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    await reply('Verification', ws);

    const text = await reply('ok', ws);

    expect(client.executeTransitionCalls).toHaveLength(1);
    expect(text).toContain('Nothing selected');
    expect(text).toContain('✓ closed');
  });

  it('R9: the close session records a Waltz import as Waltz, so the participant routes its answers back to Waltz', async () => {
    const ws = makeMockWs();
    const waltz = makeStaleDescriptor([], 'waltz');
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws, waltz);
    await reply('PROJ-1', ws, waltz);
    await reply('close tickets', ws, waltz);

    expect((ws.store[CLOSE_KEY] as { descriptorKind: string }).descriptorKind).toBe('waltz');
    await reply('Verification', ws, waltz);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
  });

  it('an answer after a newer import claimed the session key transitions nothing', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    ws.store[descriptor.sessionKeys.templateSelection] = { projectKey: 'PROJ' }; // a newer import started

    const text = await reply('Verification', ws);

    expect(text).toContain('A newer import was started');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('F1: overview → close a stale ticket → create new rows → done, each group acting only on its own rows', async () => {
    withRules([{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }]);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: 'new-1' }, { ref: 'new-2' }], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    const stream0 = mockStream();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream0 as never, ws as never, staleDescriptor);
    const first = markdownText((stream0.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(first).toContain('### Import results');
    expect(first.toLowerCase()).not.toContain('post it');

    await reply('open stale', ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    const closeText = await reply('close-bugs', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(client.createIssueCalls).toHaveLength(0); // closing touched nothing in New (R11)
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(session.view).toBe('overview');
    expect(closeText).toContain('1 closed');

    await reply('open new', ws);
    await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.executeTransitionCalls).toHaveLength(1); // creating touched nothing in Stale (R11)

    const doneText = await reply('done', ws);
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    expect(doneText.split('\n').at(-1)).toBe('Import finished — **2** created, 0 updated, 0 follow-ups, 0 re-created, 1 closed.');
  });

  it('a reply is read only against the screen showing: a row id on the Stale screen and a ticket key on the New screen are rejected (R6/AE2)', async () => {
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

// Import ticket updates parity (U5): the per-row Already-ticketed actions, run by `apply` and the
// `update tickets` / `re-create tickets` shortcuts through the shared executor.

interface FakeTicket { labels: string[]; summary?: string; resolution?: { name: string } | null; created?: string; status?: string }

/** A small stateful Jira: getIssue/updateIssue/createIssue share one ticket store. */
function statefulJira(client: MockJiraClient, tickets: Record<string, FakeTicket>) {
  client.getIssue = async (key: string) => ({
    id: '1', key, fields: { labels: tickets[key]?.labels ?? [], summary: tickets[key]?.summary ?? `Summary of ${key}` } as JiraIssue['fields'],
  });
  client.updateIssue = async (key: string, fields: Record<string, unknown>) => {
    client.updateIssueCalls.push({ issueKey: key, fields });
    if (Array.isArray(fields.labels)) tickets[key].labels = fields.labels as string[];
    if (typeof fields.summary === 'string') tickets[key].summary = fields.summary;
  };
  let next = 100;
  client.createIssue = async (projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>) => {
    client.createIssueCalls.push({ projectKey, summary, issueType, additionalFields });
    const key = `PROJ-${next++}`;
    tickets[key] = { labels: (additionalFields?.labels as string[]) ?? [], summary, resolution: null, status: 'Open' };
    return { id: key, key };
  };
}

/** Answers the dedup search from the same ticket store, so a rebuilt session sees earlier writes. */
function searchFromStore(ticketService: TicketService, tickets: Record<string, FakeTicket>) {
  return vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
    if (!jql.includes('labels in (')) return { issues: [], total: 0, isLast: true } as never;
    const issues = Object.entries(tickets)
      .filter(([, t]) => t.labels.some(l => jql.includes(`"${l}"`)))
      .map(([key, t]) => ({
        key,
        fields: {
          labels: t.labels, resolution: t.resolution ?? null, created: t.created ?? '2026-01-01T09:00:00.000+0000',
          status: { name: t.status ?? 'Open' },
        },
      }));
    return { issues, total: issues.length, isLast: true } as never;
  });
}

function streamText(stream: ReturnType<typeof mockStream>): string {
  return (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
}

function diagLines(): string[] {
  return vi.mocked(vscode.window.createOutputChannel).mock.results
    .flatMap(r => (r.value as { appendLine: ReturnType<typeof vi.fn> }).appendLine.mock.calls.map(c => String(c[0])));
}

// A generic descriptor with change tracking: findings are recorded as `test-f-<id>` labels.
const trackedDescriptor: ReportImportDescriptor<TestItem, TestRow> = {
  ...descriptor,
  changeTracking: {
    findingNoun: 'finding(s)',
    describe: (item, known) => {
      const knownIds = known.filter(l => l.startsWith('test-f-')).map(l => l.slice('test-f-'.length));
      if (knownIds.length === 0) return { kind: 'baseline' };
      const newIds = (item.findings ?? []).filter(f => !knownIds.includes(f));
      return newIds.length > 0 ? { kind: 'findings', newIds } : null;
    },
    recordLabelsOf: (row, change) => (change.kind === 'baseline' ? row.findings : change.newIds).map(f => `test-f-${f}`),
    buildUpdateComment: (_row, change) => `New findings: ${change.newIds.join(', ')}`,
    buildFollowUp: (row, change, originalKey, additionalFields) => ({
      summary: `${row.summary} (follow-up to ${originalKey})`,
      fields: { ...additionalFields, labels: [`test-${row.ref}`, ...change.newIds.map(f => `test-f-${f}`)], description: 'follow-up' },
    }),
  },
};

describe('Already-ticketed per-row actions — apply executor (U5)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function build(
    items: TestItem[],
    tickets: Record<string, FakeTicket>,
    ws = makeMockWs(),
    desc: ReportImportDescriptor<TestItem, TestRow> = trackedDescriptor,
  ): Promise<{ session: ReviewSession<TestRow>; ws: ReturnType<typeof makeMockWs> }> {
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    await continueAfterImportIssueType('Bug', null, makeSession({ items, availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, desc);
    return { session: ws.store[desc.sessionKeys.review] as ReviewSession<TestRow>, ws };
  }

  const reply = (text: string, session: ReviewSession<TestRow>, ws: ReturnType<typeof makeMockWs>, stream = mockStream(), desc = trackedDescriptor) =>
    handleImportReviewReply(text, session, ticketService, stream as never, ws as never, desc);

  it('apply runs the update, follow-up and re-create rows and leaves the leave row alone (F1)', async () => {
    const tickets: Record<string, FakeTicket> = {
      'PROJ-12': { labels: ['test-1', 'test-f-a'] }, // open, gains b -> update
      'PROJ-8': { labels: ['test-2', 'test-f-x'], resolution: { name: 'Done' }, status: 'Done' }, // resolved, gains y -> follow-up
      'PROJ-3': { labels: ['test-3', 'test-f-z'] }, // unchanged -> leave
      'PROJ-4': { labels: ['test-4', 'test-f-q'] }, // unchanged, user picks re-create
    };
    const { session, ws } = await build([
      { ref: '1', findings: ['a', 'b'] }, { ref: '2', findings: ['x', 'y'] }, { ref: '3', findings: ['z'] }, { ref: '4', findings: ['q'] },
    ], tickets);
    expect(session.allRows.map(r => r.action)).toEqual(['update', 'follow-up', 'leave', 'leave']);

    await reply('A4 re-create', session, ws);
    const stream = mockStream();
    await reply('apply', session, ws, stream);

    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-12']);
    expect(client.addCommentCalls).toEqual([{ issueKey: 'PROJ-12', body: 'New findings: b' }]);
    expect(client.createIssueCalls.map(c => c.summary)).toEqual(['Summary 2 (follow-up to PROJ-8)', 'Summary 4']);
    expect(client.createIssueLinkCalls).toEqual([{ inwardKey: 'PROJ-8', outwardKey: 'PROJ-100', typeName: 'Relates' }]);
    expect(session.outcomes).toMatchObject({ updated: 1, followedUp: 1, recreated: 1, updateFailed: 0, followUpFailed: 0, recreateFailed: 0 });
    expect(session.allRows.map(r => r.result?.status ?? null)).toEqual(['done', 'done', null, 'done']);
    expect(session.view).toBe('ticketed'); // only group -> stays on its screen
    const text = streamText(stream);
    expect(text).toContain('follow-up PROJ-100');
    expect(text).toContain('re-created as PROJ-101');
  });

  it('a second apply skips finished rows', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-12': { labels: ['test-1', 'test-f-a'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['a', 'b'] }], tickets);
    await reply('apply', session, ws);
    const stream = mockStream();
    await reply('apply', session, ws, stream);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(streamText(stream)).toContain('Nothing to apply');
    // A finished row can no longer be changed either.
    const again = mockStream();
    await reply('A1 re-create', session, ws, again);
    expect(streamText(again)).toContain("Didn't understand that");
  });

  it('an update whose target already carries every record label writes nothing, posts no comment and counts as already up to date', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-12': { labels: ['test-1', 'test-f-a'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['a', 'b'] }], tickets);
    expect(session.allRows[0].change).toEqual({ kind: 'findings', newIds: ['b'] });
    expect(session.allRows[0].action).toBe('update');
    // Someone else records finding b on the ticket between the review screen and `apply`.
    tickets['PROJ-12'].labels = ['test-1', 'test-f-a', 'test-f-b'];
    const stream = mockStream();

    await reply('apply', session, ws, stream);

    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(session.allRows[0].result).toEqual({ status: 'done', action: 'update', note: 'up-to-date' });
    const text = streamText(stream);
    expect(text).toContain('PROJ-12');
    expect(text).toContain('already up to date');
    expect(text).toContain('**0** updated, 0 follow-up(s) created, 0 re-created, 1 already up to date, 0 failed.');
    expect(session.outcomes).toMatchObject({ updated: 0, updateFailed: 0 });
  });

  it('running the same update from a second session for the same ticket posts no second comment (idempotent)', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-12': { labels: ['test-1', 'test-f-a'] } };
    // Two reviews of the same report built before either is applied — both see finding b as new.
    const first = await build([{ ref: '1', findings: ['a', 'b'] }], tickets, makeMockWs());
    const second = await build([{ ref: '1', findings: ['a', 'b'] }], tickets, makeMockWs());
    expect(second.session.allRows[0].action).toBe('update');

    await reply('apply', first.session, first.ws);
    expect(tickets['PROJ-12'].labels).toEqual(['test-1', 'test-f-a', 'test-f-b']);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.addCommentCalls).toEqual([{ issueKey: 'PROJ-12', body: 'New findings: b' }]);

    const stream = mockStream();
    await reply('apply', second.session, second.ws, stream);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(second.session.allRows[0].result).toEqual({ status: 'done', action: 'update', note: 'up-to-date' });
    expect(streamText(stream)).toContain('already up to date');
  });

  it('Covers AE3: a baseline update writes the record labels only — no comment — and the next import shows no change', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-5': { labels: ['test-1'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['a', 'b'] }], tickets);
    expect(session.allRows[0].change).toEqual({ kind: 'baseline' });
    expect(session.allRows[0].action).toBe('update');

    await reply('apply', session, ws);

    expect(client.updateIssueCalls).toEqual([{ issueKey: 'PROJ-5', fields: { labels: ['test-1', 'test-f-a', 'test-f-b'] } }]);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(session.allRows[0].result).toEqual({ status: 'done', action: 'update', note: 'baseline' });

    const rebuilt = await build([{ ref: '1', findings: ['a', 'b'] }], tickets, makeMockWs());
    expect(rebuilt.session.allRows[0].change).toBeNull();
    expect(rebuilt.session.allRows[0].action).toBe('leave');
  });

  it('Covers AE6: `A1 follow-up` on a no-change row is rejected with a message and A1 keeps leave', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-3': { labels: ['test-1', 'test-f-z'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['z'] }], tickets);
    const stream = mockStream();
    await reply('A1 follow-up', session, ws, stream);
    expect(streamText(stream)).toContain("A1 can't be set to `follow-up`");
    expect(session.allRows[0].action).toBe('leave');
  });

  it('Covers AE5: a failed link keeps the follow-up ticket, warns in chat and logs at warn', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-8': { labels: ['test-1', 'test-f-x'], resolution: { name: 'Done' } } };
    const { session, ws } = await build([{ ref: '1', findings: ['x', 'y'] }], tickets);
    client.createIssueLinkError = new Error('Issue linking is disabled');
    const stream = mockStream();

    await reply('apply', session, ws, stream);

    expect(client.createIssueCalls).toHaveLength(1);
    expect(session.allRows[0].result).toEqual({ status: 'done', action: 'follow-up', key: 'PROJ-100', linkMissing: true });
    expect(session.outcomes).toMatchObject({ followedUp: 1, followUpFailed: 0 });
    const text = streamText(stream);
    expect(text).toContain('could not be linked to PROJ-8');
    expect(text).toContain('follow-up PROJ-100 (link missing)');
    expect(diagLines().some(l => l.includes('[WARN]') && l.includes('link') && l.includes('PROJ-100'))).toBe(true);
  });

  it('one row failing does not stop the others, and a failed row keeps its action links (R16)', async () => {
    const tickets: Record<string, FakeTicket> = {
      'PROJ-8': { labels: ['test-1', 'test-f-x'], resolution: { name: 'Done' } },
      'PROJ-9': { labels: ['test-2', 'test-f-x'], resolution: { name: 'Done' } },
    };
    const { session, ws } = await build([{ ref: '1', findings: ['x', 'y'] }, { ref: '2', findings: ['x', 'y'] }], tickets);
    const create = client.createIssue.bind(client);
    client.createIssue = (async (...args: Parameters<typeof client.createIssue>) => {
      if (args[1].startsWith('Summary 1')) throw new Error('Field "priority" is required');
      return create(...args);
    }) as typeof client.createIssue;
    const stream = mockStream();

    await reply('apply', session, ws, stream);

    expect(session.allRows[0].result).toEqual({ status: 'failed', action: 'follow-up', error: 'Field "priority" is required' });
    expect(session.allRows[1].result).toMatchObject({ status: 'done', action: 'follow-up' });
    expect(session.outcomes).toMatchObject({ followedUp: 1, followUpFailed: 1 });
    const screen = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    const a1 = screen.split('\n').find(l => l.startsWith('| A1 |'))!;
    expect(a1).toContain('✗ follow-up failed');
    expect(decodeURIComponent(a1)).toContain('"@jira A1 follow-up"');
  });

  it('a comment failure after the labels were written reports "labels updated, comment failed" and counts once', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-12': { labels: ['test-1', 'test-f-a'] }, 'PROJ-13': { labels: ['test-2', 'test-f-a'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['a', 'b'] }, { ref: '2', findings: ['a', 'c'] }], tickets);
    client.addComment = async (issueKey: string, body: string) => {
      if (issueKey === 'PROJ-12') throw new Error('Comment post failed');
      client.addCommentCalls.push({ issueKey, body });
    };
    const stream = mockStream();

    await reply('apply', session, ws, stream);

    expect(client.updateIssueCalls.map(c => c.issueKey).sort()).toEqual(['PROJ-12', 'PROJ-13']);
    expect(client.addCommentCalls.map(c => c.issueKey)).toEqual(['PROJ-13']);
    const text = streamText(stream);
    expect(text).toContain('⚠');
    expect(text).toContain('labels updated but the comment could not be posted');
    expect(session.outcomes).toMatchObject({ updated: 2, updateFailed: 0 });
    expect(session.allRows[0].result).toEqual({ status: 'done', action: 'update', note: 'comment-failed' });
  });

  it('`update tickets` runs only rows set to update; `re-create tickets` only rows set to re-create (R10)', async () => {
    const tickets: Record<string, FakeTicket> = {
      'PROJ-12': { labels: ['test-1', 'test-f-a'] },
      'PROJ-13': { labels: ['test-2', 'test-f-a'] },
      'PROJ-14': { labels: ['test-3', 'test-f-a'] },
    };
    const { session, ws } = await build([
      { ref: '1', findings: ['a', 'b'] }, { ref: '2', findings: ['a', 'b'] }, { ref: '3', findings: ['a', 'b'] },
    ], tickets);
    await reply('A2 re-create', session, ws);
    await reply('A3 follow-up', session, ws);

    await reply('update tickets', session, ws);
    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-12']);
    expect(client.createIssueCalls).toHaveLength(0);

    await reply('re-create tickets', session, ws);
    expect(client.createIssueCalls.map(c => c.summary)).toEqual(['Summary 2']);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(session.allRows.find(r => r.id === 'A3')!.result).toBeUndefined(); // follow-up still pending
  });

  it('`update existing tickets` (legacy wording) still runs the update rows', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-12': { labels: ['test-1', 'test-f-a'] } };
    const { session, ws } = await build([{ ref: '1', findings: ['a', 'b'] }], tickets);
    await reply('update existing tickets', session, ws);
    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-12']);
  });

  it('60 rows set to act: the first 50 run and the reply says 10 remain (R9)', async () => {
    const tickets: Record<string, FakeTicket> = {};
    const items: TestItem[] = Array.from({ length: 60 }, (_, i) => {
      tickets[`PROJ-${1000 + i}`] = { labels: [`test-${i + 1}`] };
      return { ref: String(i + 1) };
    });
    const { session, ws } = await build(items, tickets, makeMockWs(), descriptor); // no change tracking: re-create / leave
    await reply('all re-create', session, ws, mockStream(), descriptor);
    const stream = mockStream();
    await reply('apply', session, ws, stream, descriptor);

    expect(client.createIssueCalls).toHaveLength(50);
    expect(streamText(stream)).toContain('10 remain');
    expect(session.allRows.filter(r => r.result?.status === 'done')).toHaveLength(50);

    await reply('apply', session, ws, mockStream(), descriptor);
    expect(client.createIssueCalls).toHaveLength(60);
  });

  it('an already-ticketed row\'s action survives page navigation on the New screen', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-999': { labels: ['test-1'] } };
    const items: TestItem[] = Array.from({ length: 60 }, (_, i) => ({ ref: String(i + 1) }));
    const { session, ws } = await build(items, tickets, makeMockWs(), descriptor);
    await reply('open already ticketed', session, ws, mockStream(), descriptor);
    await reply('A1 re-create', session, ws, mockStream(), descriptor);
    await reply('back', session, ws, mockStream(), descriptor);
    await reply('open new', session, ws, mockStream(), descriptor);
    await reply('next', session, ws, mockStream(), descriptor);
    expect(session.rows.find(r => r.id === 'A1')!.action).toBe('re-create');
    await reply('prev', session, ws, mockStream(), descriptor);
    expect(session.allRows.find(r => r.id === 'A1')!.action).toBe('re-create');
  });
});

describe('Waltz per-row actions through the real descriptor (U5)', () => {
  const vuln = (cveId: string, overallSeverity = 'High'): WaltzVulnerability => ({
    cveId, cveSummary: `Summary of ${cveId}`, overallSeverity, cvssV3Score: 7.5, fixedVersion: '9.9.9',
  });
  const component = (nameVersion: string, maxVulnRating: string, cves: string[]): WaltzComponent => ({
    nameVersion, maxVulnRating, remediationAction: 'Remediate', instancePaths: ['app.jar'], vulnerabilities: cves.map(c => vuln(c, maxVulnRating)),
  });

  let client: MockJiraClient;
  let ticketService: TicketService;
  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function importWaltz(components: WaltzComponent[], tickets: Record<string, FakeTicket>, ws = makeMockWs()) {
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    const templateSession = await buildWaltzTemplateSession(components, 'report.xlsx', 'PROJ', client);
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
    };
    await handleWaltzAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);
    return { session: ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws };
  }

  it('Covers AE1: open ticket with new CVEs → update, resolved ticket with a new CVE → follow-up, unchanged → leave', async () => {
    const log4j = component('log4j-core 2.14.1', 'High', ['CVE-2021-1', 'CVE-2021-2', 'CVE-2021-3']);
    const jackson = component('jackson-databind 2.9', 'High', ['CVE-2019-1', 'CVE-2019-2']);
    const text = component('commons-text 1.9', 'High', ['CVE-2022-1']);
    const tickets: Record<string, FakeTicket> = {
      'PROJ-12': { labels: [sanitizeComponentLabel(log4j.nameVersion), 'oss-cve-cve-2021-1', 'oss-rating-high'], status: 'In Progress' },
      'PROJ-8': { labels: [sanitizeComponentLabel(jackson.nameVersion), 'oss-cve-cve-2019-1', 'oss-rating-high'], resolution: { name: 'Done' }, status: 'Done' },
      'PROJ-3': { labels: [sanitizeComponentLabel(text.nameVersion), 'oss-cve-cve-2022-1', 'oss-rating-high'] },
    };
    const { session } = await importWaltz([log4j, jackson, text], tickets);
    expect(session.allRows.map(r => r.action)).toEqual(['update', 'follow-up', 'leave']);
  });

  it('the follow-up carries the component label, only the new CVE labels, the current rating label and a "(follow-up to PROJ-8)" summary, linked to PROJ-8', async () => {
    const jackson = component('jackson-databind 2.9', 'High', ['CVE-2019-1', 'CVE-2019-2']);
    const compLabel = sanitizeComponentLabel(jackson.nameVersion);
    const tickets: Record<string, FakeTicket> = {
      'PROJ-8': { labels: ['oss-dependency', compLabel, 'oss-cve-cve-2019-1', 'oss-rating-high'], resolution: { name: 'Done' }, status: 'Done' },
    };
    const { session, ws } = await importWaltz([jackson], tickets);

    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(client.createIssueCalls).toHaveLength(1);
    const call = client.createIssueCalls[0];
    expect(call.summary).toBe('[OSS] jackson-databind 2.9 — High (follow-up to PROJ-8)');
    expect([...(call.additionalFields!.labels as string[])].sort()).toEqual(['oss-cve-cve-2019-2', 'oss-dependency', compLabel, 'oss-rating-high'].sort());
    // sanitizeCellText strips '-' (a Jira strikethrough trigger) from report values.
    expect(call.additionalFields!.description).toContain('CVE20192');
    expect(call.additionalFields!.description).not.toContain('CVE20191');
    expect(client.createIssueLinkCalls).toEqual([{ inwardKey: 'PROJ-8', outwardKey: 'PROJ-100', typeName: 'Relates' }]);
  });

  it('Covers AE4: a rating rise rewrites the summary in the update and posts one comment; exactly one rating label remains', async () => {
    const log4j = component('log4j-core 2.14.1', 'Critical', ['CVE-2021-1']);
    const tickets: Record<string, FakeTicket> = {
      'PROJ-12': { labels: ['oss-dependency', sanitizeComponentLabel(log4j.nameVersion), 'oss-cve-cve-2021-1', 'oss-rating-high'], summary: '[OSS] log4j-core 2.14.1 — High' },
    };
    const { session, ws } = await importWaltz([log4j], tickets);
    expect(session.allRows[0].action).toBe('update');

    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.summary).toBe('[OSS] log4j-core 2.14.1 — Critical');
    expect(tickets['PROJ-12'].labels.filter(l => l.startsWith('oss-rating-'))).toEqual(['oss-rating-critical']);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).toContain('High → Critical');
    expect(client.addCommentCalls[0].body).not.toContain('summary was not changed');
  });

  it('Covers AE4: a renamed summary is left alone and the comment says so', async () => {
    const log4j = component('log4j-core 2.14.1', 'Critical', ['CVE-2021-1']);
    const tickets: Record<string, FakeTicket> = {
      'PROJ-12': { labels: [sanitizeComponentLabel(log4j.nameVersion), 'oss-cve-cve-2021-1', 'oss-rating-high'], summary: 'log4j upgrade' },
    };
    const { session, ws } = await importWaltz([log4j], tickets);

    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls[0].fields.summary).toBeUndefined();
    expect(tickets['PROJ-12'].summary).toBe('log4j upgrade');
    expect(client.addCommentCalls[0].body).toContain('summary was not changed');
  });

  it('Covers AE3 for Waltz: a pre-feature ticket records its CVEs and rating on apply, with no comment', async () => {
    const lib = component('lib 1.0', 'High', ['CVE-2020-1']);
    const tickets: Record<string, FakeTicket> = { 'PROJ-5': { labels: ['oss-dependency', sanitizeComponentLabel(lib.nameVersion)] } };
    const { session, ws } = await importWaltz([lib], tickets);
    expect(session.allRows[0].change).toEqual({ kind: 'baseline' });

    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(tickets['PROJ-5'].labels).toEqual(expect.arrayContaining(['oss-cve-cve-2020-1', 'oss-rating-high']));
    expect(client.addCommentCalls).toHaveLength(0);
    const rebuilt = await importWaltz([lib], tickets, makeMockWs());
    expect(rebuilt.session.allRows[0].change).toBeNull();
  });

  it('`update tickets` with no row set to update writes nothing', async () => {
    const lib = component('lib 1.0', 'High', ['CVE-2020-1']);
    const tickets: Record<string, FakeTicket> = { 'PROJ-5': { labels: [sanitizeComponentLabel(lib.nameVersion), 'oss-cve-cve-2020-1', 'oss-rating-high'] } };
    const { session, ws } = await importWaltz([lib], tickets);
    const stream = mockStream();
    await handleWaltzReviewReply('update tickets', session, ticketService, stream as never, ws as never);
    expect(client.updateIssueCalls).toHaveLength(0);
    expect(streamText(stream)).toContain('Nothing to apply');
  });
});

describe('Veracode per-row actions through the real descriptor (U5)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
      description: 'Untrusted input reaches a query.', recommendation: null,
      module: 'app.jar', sourceFile: 'App.java', sourceFilePath: 'src/main/java/App.java',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }

  let client: MockJiraClient;
  let ticketService: TicketService;
  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function importVeracode(flaws: VeracodeFlaw[], tickets: Record<string, FakeTicket>, ws = makeMockWs()) {
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
    };
    await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);
    return { session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession, ws };
  }

  it('update adds only the new flaw label and a comment about the new flaw only', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('102')], tickets);
    expect(session.allRows[0].action).toBe('update');

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls[0].fields.labels).toEqual(['veracode', 'veracode-issue-101', 'veracode-issue-102']);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).toContain('Issue 102');
    expect(client.addCommentCalls[0].body).not.toContain('Issue 101');
    expect(client.createIssueCalls).toHaveLength(0);
  });

  it('a crafted flaw description cannot survive into the posted comment as Jira markup', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-6': { labels: ['veracode-issue-600'] } };
    const evil = makeFlaw('601', { description: 'Injected !http://evil.example/t.gif! description' });
    const { session, ws } = await importVeracode([makeFlaw('600'), evil], tickets);

    await handleVeracodeReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(client.addCommentCalls[0].body).not.toContain('!http://evil.example/t.gif!');
  });

  it('AE4 (overview hub): update touches only the tickets missing a finding and creates nothing', async () => {
    // One CWE per line, so the three line groups stay three groups under file + CWE folding too.
    const flaws = [
      makeFlaw('101', { line: 10, cweId: '89' }), makeFlaw('102', { line: 10, cweId: '89' }),
      makeFlaw('201', { line: 20, cweId: '79' }), makeFlaw('202', { line: 20, cweId: '79' }),
      makeFlaw('301', { line: 30, cweId: '22' }),
    ];
    const tickets: Record<string, FakeTicket> = {
      'PROJ-1': { labels: ['veracode-issue-101'] }, 'PROJ-2': { labels: ['veracode-issue-201'] }, 'PROJ-3': { labels: ['veracode-issue-301'] },
    };
    const { session, ws } = await importVeracode(flaws, tickets);
    expect(session.view).toBe('ticketed');

    await handleVeracodeReviewReply('update tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls.map(c => c.issueKey).sort()).toEqual(['PROJ-1', 'PROJ-2']);
    expect(client.createIssueCalls).toHaveLength(0);
    expect(session.outcomes?.updated).toBe(2);
  });

  it('AE8: ten same-file, same-CWE flaws with one already ticketed form one Already-ticketed row proposing update, and none in New', async () => {
    const flaws = Array.from({ length: 10 }, (_, i) => makeFlaw(String(101 + i), { line: i + 1, cweId: '89' }));
    const tickets: Record<string, FakeTicket> = { 'PROJ-50': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session } = await importVeracode(flaws, tickets);

    expect(session.allRows).toHaveLength(1);
    const [row] = session.allRows;
    expect(row.existingTicketKey).toBe('PROJ-50');
    expect(row.action).toBe('update');
    expect(row.change).toMatchObject({ kind: 'findings' });
    expect((row.change as { newIds: string[] }).newIds).toHaveLength(9);
    expect(session.allRows.filter(r => r.existingTicketKey === null)).toHaveLength(0);
  });

  it('a follow-up covers only the new flaws: its labels, summary and description', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-8': { labels: ['veracode', 'veracode-issue-101', 'cwe-89'], resolution: { name: 'Done' }, status: 'Done' } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('102', { cweId: '79' })], tickets);
    expect(session.allRows[0].action).toBe('follow-up');

    await handleVeracodeReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    const call = client.createIssueCalls[0];
    expect(call.summary).toMatch(/^102 .*\(follow-up to PROJ-8\)$/);
    expect([...(call.additionalFields!.labels as string[])].sort()).toEqual(['cwe-79', 'veracode', 'veracode-issue-102']);
    expect(call.additionalFields!.description).toContain('Issue 102');
    expect(call.additionalFields!.description).not.toContain('Issue 101');
    expect(client.createIssueLinkCalls).toEqual([{ inwardKey: 'PROJ-8', outwardKey: 'PROJ-100', typeName: 'Relates' }]);
  });
});
