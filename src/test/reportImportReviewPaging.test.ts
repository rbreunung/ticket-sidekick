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

import { continueAfterImportIssueType, handleImportReviewReply } from '../participant/jira/reportImportHandler';
import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { handleWaltzReviewReply } from '../participant/jira/waltzHandler';
import { buildReviewPage, CURRENT_SESSION_SCHEMA_VERSION, type ReviewSession, type AwaitIssueTypeResume, type VeracodeReviewSession, type WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { type WaltzReviewRow } from '../utils/waltzReport';
import type { JiraSearchResult } from '../jira/IJiraClient';
import { TestItem, TestRow, descriptor, mockStream, markdownText, makeMockWs, makeSession } from './helpers/reportImportHarness';

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
      sourceGroup: [{ nameVersion: `pkg-${id}:1.0.0`, maxVulnRating: 'High', remediationAction: null, instancePaths: [], vulnerabilities: [] }],
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
