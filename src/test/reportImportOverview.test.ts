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
import { type ReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { JiraSearchResult } from '../jira/IJiraClient';
import { TestItem, TestRow, descriptor, mockStream, markdownText, makeMockWs, makeSession } from './helpers/reportImportHarness';

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
