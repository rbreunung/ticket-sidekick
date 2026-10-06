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

import { continueAfterImportIssueType, handleImportReviewReply, type ReportImportDescriptor } from '../participant/jira/reportImportHandler';
import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import { type ReviewSession, type AwaitIssueTypeResume, type VeracodeReviewSession, type WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { sanitizeComponentLabel, type WaltzComponent, type WaltzVulnerability } from '../utils/waltzReport';
import { TestItem, TestRow, descriptor, mockStream, markdownText, makeMockWs, makeSession, FakeTicket, statefulJira, searchFromStore, streamText, diagLines, trackedDescriptor } from './helpers/reportImportHarness';

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
    // sanitizeCellText keeps a hyphen inside a word, so the CVE id stays readable.
    expect(call.additionalFields!.description).toContain('CVE-2019-2');
    expect(call.additionalFields!.description).not.toContain('CVE-2019-1');
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

  it('two rows that update the same ticket write one after the other, so neither overwrites the other\'s labels', async () => {
    const a = component('lib-a 1.0', 'High', ['CVE-2020-1', 'CVE-2020-2']);
    const b = component('lib-b 1.0', 'High', ['CVE-2021-1', 'CVE-2021-2']);
    const tickets: Record<string, FakeTicket> = {
      'PROJ-9': {
        labels: [sanitizeComponentLabel(a.nameVersion), sanitizeComponentLabel(b.nameVersion), 'oss-cve-cve-2020-1', 'oss-cve-cve-2021-1', 'oss-rating-high'],
      },
    };
    const { session, ws } = await importWaltz([a, b], tickets);
    expect(session.allRows.map(r => r.action)).toEqual(['update', 'update']);
    // A read that yields before answering: two parallel updates would both read the old labels.
    const read = client.getIssue.bind(client);
    client.getIssue = async (key: string) => { const issue = await read(key); await new Promise(r => setTimeout(r, 5)); return issue; };

    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(tickets['PROJ-9'].labels).toEqual(expect.arrayContaining(['oss-cve-cve-2020-2', 'oss-cve-cve-2021-2']));
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

  it('a fold of flaws with different severities shows its most severe member on the row', async () => {
    const flaws = [makeFlaw('101', { line: 1, severity: 3 }), makeFlaw('102', { line: 2, severity: 5 })];
    const { session } = await importVeracode(flaws, {});
    expect(session.allRows).toHaveLength(1);
    expect(session.allRows[0].severity).toBe(5);
    expect(session.allRows[0].issueIds).toEqual(['101', '102']);
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
