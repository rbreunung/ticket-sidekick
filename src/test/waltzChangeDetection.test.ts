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
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: vi.fn(() => ({ templates: [], cleanupRules: [] })) }); }),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import { handleWaltzAwaitIssueType, handleWaltzReviewReply, handleWaltzStaleClose, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import { loadWorkflowCache } from '../services/WorkflowService';
import { continueAfterImportIssueType } from '../participant/jira/reportImportHandler';
import type { WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { buildGroupDescriptionWiki, buildGroupLabels, sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import type { RemediationDates } from '../utils/waltzDates';
import {
  mockStream, makeMockWs, makeSession, FakeTicket, statefulJira, searchFromStore, streamText, trackedDescriptor,
} from './helpers/reportImportHarness';

const comp = (nameVersion: string, dates: Partial<RemediationDates> = {}, cve = 'CVE-2099-0001'): WaltzComponent => ({
  nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: [{ cveId: cve, cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null }],
  remediation: { policyDate: null, plannedDate: null, planDeadline: null, planStatus: null, reportDate: '2026-10-22', ...dates },
});

/** A ticket as an earlier import left it: component and record labels, and the description it wrote. */
const ticketFor = (group: WaltzComponent[], over: Partial<FakeTicket> = {}): FakeTicket => ({
  labels: buildGroupLabels(group), summary: '[OSS] ticket', description: buildGroupDescriptionWiki(group), status: 'Open', ...over,
});

let client: MockJiraClient;
let ticketService: TicketService;
let tickets: Record<string, FakeTicket>;
let reads: string[];
let staleSearch: ((jql: string) => unknown) | undefined;

beforeEach(() => {
  client = new MockJiraClient();
  ticketService = new TicketService(client);
  tickets = {};
  reads = [];
  staleSearch = undefined;
});

async function importWaltz(report: WaltzComponent[], rawItems: WaltzComponent[] = report, failRead: string[] = []) {
  statefulJira(client, tickets);
  const getIssue = client.getIssue;
  client.getIssue = async key => {
    reads.push(key);
    if (failRead.includes(key)) throw new Error('Forbidden');
    const issue = await getIssue(key);
    issue.fields.description = tickets[key]?.description as never;
    return issue;
  };
  const search = searchFromStore(ticketService, tickets);
  const dedupSearch = search.getMockImplementation()!;
  search.mockImplementation(async (jql, ...rest) => (staleSearch?.(jql) ?? dedupSearch(jql, ...rest)) as never);
  const templateSession = await buildWaltzTemplateSession(report, 'r.xlsx', 'PROJ', client, rawItems);
  const ws = makeMockWs();
  const stream = mockStream();
  await handleWaltzAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, stream as never, ws as never);
  return { ws, stream, session: ws.store['jira.session.waltzReview'] as WaltzReviewSession };
}

async function reply(text: string, ws: ReturnType<typeof makeMockWs>) {
  const stream = mockStream();
  const session = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
  await handleWaltzReviewReply(text, session, ticketService, stream as never, ws as never);
  return streamText(stream);
}

const rowFor = (session: WaltzReviewSession, key: string, name?: string) =>
  session.allRows.find(r => r.existingTicketKey === key && (name === undefined || r.nameVersion.startsWith(name)))!;

describe('refreshing a ticket from a newer report (F1)', () => {
  it('AE7: an open ticket from before the feature, whose component now has dates, defaults to rewrite, which adds the dates and the Due Date; a later import then shows no change', async () => {
    const undated = comp('example-lib:1.2.3');
    const dated = comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2026-12-15' });
    tickets['PROJ-5'] = ticketFor([undated], { description: 'h3. Max Vuln Rating\nHigh\n\nh3. Component\nexample-lib:1.2.3' });
    const { session, ws } = await importWaltz([dated]);

    const row = rowFor(session, 'PROJ-5');
    expect(row.change).toMatchObject({ kind: 'findings', newIds: [], dates: [{ date: 'policy', from: null, to: '2026-11-30' }, { date: 'planned', from: null, to: '2026-12-15' }] });
    expect(row.allowedActions).toEqual(['rewrite', 'leave']);
    expect(row.action).toBe('rewrite');

    await reply('apply', ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-12-15');
    expect(String(client.updateIssueCalls[0].fields.description)).toContain('2026-12-15');

    const again = await importWaltz([dated]);
    expect(rowFor(again.session, 'PROJ-5').change).toBeNull();
    expect(rowFor(again.session, 'PROJ-5').action).toBe('leave');
  });

  it('AE8: shows the recorded and the reported planned date, and the rewrite sets the new Due Date', async () => {
    const recorded = comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2026-12-15' });
    const reported = comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2027-01-31' });
    tickets['PROJ-5'] = ticketFor([recorded]);
    const { session, ws } = await importWaltz([reported]);

    expect(rowFor(session, 'PROJ-5').change).toMatchObject({ dates: [{ date: 'planned', from: '2026-12-15', to: '2027-01-31' }] });
    expect(rowFor(session, 'PROJ-5').action).toBe('rewrite');

    await reply('apply', ws);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2027-01-31');
  });

  it('AE12: a resolved ticket from before the feature, for a component still in the report with dates, defaults to new ticket and still offers rewrite and leave', async () => {
    const undated = comp('example-lib:1.2.3');
    const dated = comp('example-lib:1.2.3', { policyDate: '2026-11-30' });
    tickets['PROJ-5'] = ticketFor([undated], { resolution: { name: 'Fixed' }, status: 'Done', description: 'h3. Component\nexample-lib:1.2.3' });
    const { session } = await importWaltz([dated]);

    const row = rowFor(session, 'PROJ-5');
    expect(row.change).toMatchObject({ kind: 'findings', dates: [{ date: 'policy', from: null, to: '2026-11-30' }] });
    expect(row.action).toBe('follow-up');
    expect(row.allowedActions).toEqual(['rewrite', 'leave', 'follow-up']);
  });

  it('a ticket whose dates already match, and a component without dates on a ticket without dates, stay on leave', async () => {
    const a = comp('example-a:1.0.0', { policyDate: '2026-11-30' });
    const b = comp('example-b:1.0.0');
    tickets['PROJ-1'] = ticketFor([a]);
    tickets['PROJ-2'] = ticketFor([b]);
    const { session } = await importWaltz([a, b]);
    expect(session.allRows.map(r => r.action)).toEqual(['leave', 'leave']);
  });

  it('AE13: when only one member of a folded ticket changed, all its rows default to rewrite and one apply writes the ticket once', async () => {
    const [a, b, c] = ['example-a:1.0.0', 'example-b:2.0.0', 'example-c:3.0.0'].map(n => comp(n, { policyDate: '2026-11-30' }));
    tickets['PROJ-1'] = ticketFor([a, b, c], { labels: [...buildGroupLabels([a, b, c])] });
    const newA = comp('example-a:1.0.0', { policyDate: '2026-11-30' }, 'CVE-2099-0777');
    const { session, ws } = await importWaltz([newA, b, c]);

    expect(session.allRows.map(r => r.action)).toEqual(['rewrite', 'rewrite', 'rewrite']);
    expect(session.allRows.map(r => r.defaultAction)).toEqual(['rewrite', 'rewrite', 'rewrite']);

    await reply('apply', ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.addCommentCalls).toHaveLength(1);
  });
});

describe('a member that left a folded ticket (AE9, KTD10)', () => {
  const a = comp('example-a:1.0.0', { plannedDate: '2026-10-30' });
  const b = comp('example-b:2.0.0', { policyDate: '2026-12-31' });
  const c = comp('example-c:3.0.0', { policyDate: '2026-11-30' });

  it('marks the remaining rows as a change, rewrites the ticket without the member, removes its label and takes the earliest date of the rest', async () => {
    tickets['PROJ-1'] = ticketFor([a, b, c]);
    const { session, ws } = await importWaltz([b, c]);

    expect(session.allRows.map(r => r.change)).toEqual([
      { kind: 'findings', newIds: [], droppedMembers: 1 },
      { kind: 'findings', newIds: [], droppedMembers: 1 },
    ]);
    expect(session.allRows.map(r => r.action)).toEqual(['rewrite', 'rewrite']);

    await reply('apply', ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    const written = client.updateIssueCalls[0].fields;
    expect(written.duedate).toBe('2026-11-30');
    expect(String(written.description)).not.toContain('example-a:1.0.0');
    expect(tickets['PROJ-1'].labels).not.toContain(sanitizeComponentLabel(a.nameVersion));
    expect(tickets['PROJ-1'].labels).toEqual(expect.arrayContaining([sanitizeComponentLabel(b.nameVersion), sanitizeComponentLabel(c.nameVersion)]));

    const again = await importWaltz([b, c]);
    expect(again.session.allRows.map(r => r.change)).toEqual([null, null]);
  });

  it('does not count a member that is only filtered out of the rows but still in the report, and keeps its label on a rewrite', async () => {
    tickets['PROJ-1'] = ticketFor([a, b, c]);
    const { session, ws } = await importWaltz([b, c], [a, b, c]);

    expect(session.allRows.map(r => r.change)).toEqual([null, null]);
    expect(session.allRows.map(r => r.action)).toEqual(['leave', 'leave']);

    await reply('all rewrite', ws);
    await reply('apply', ws);
    expect(tickets['PROJ-1'].labels).toContain(sanitizeComponentLabel(a.nameVersion));
  });
});

describe('reading the tickets\' descriptions (KTD1)', () => {
  it('reads each distinct target ticket once, however many rows point to it', async () => {
    const [a, b, c] = ['example-a:1.0.0', 'example-b:2.0.0', 'example-c:3.0.0'].map(n => comp(n));
    tickets['PROJ-1'] = ticketFor([a, b]);
    tickets['PROJ-2'] = ticketFor([c]);
    await importWaltz([a, b, c]);
    expect(reads.sort()).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('reads nothing for a report whose components have no tickets', async () => {
    await importWaltz([comp('example-a:1.0.0')]);
    expect(reads).toEqual([]);
  });

  it('a ticket that cannot be read is not compared, the others are, and the review says so', async () => {
    const a = comp('example-a:1.0.0', { policyDate: '2026-11-30' });
    const b = comp('example-b:2.0.0', { policyDate: '2026-11-30' });
    tickets['PROJ-1'] = ticketFor([comp('example-a:1.0.0')]);
    tickets['PROJ-2'] = ticketFor([comp('example-b:2.0.0')]);
    const { session, stream } = await importWaltz([a, b], [a, b], ['PROJ-1']);

    const unreadable = session.allRows.find(r => r.existingTicketKey === 'PROJ-1')!;
    const readable = session.allRows.find(r => r.existingTicketKey === 'PROJ-2')!;
    expect(unreadable.change ?? null).toBeNull();
    expect(readable.change).toMatchObject({ kind: 'findings', dates: [{ date: 'policy', from: null, to: '2026-11-30' }] });
    expect(streamText(stream)).toMatch(/could not read 1 ticket/i);
  });

  it('is not done for an importer without its own action policy', async () => {
    const store: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['test-1'] } };
    statefulJira(client, store);
    const getIssue = vi.fn(client.getIssue.bind(client));
    client.getIssue = getIssue;
    searchFromStore(ticketService, store);
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: '1' }] }), client, ticketService, mockStream() as never, makeMockWs() as never, trackedDescriptor);
    expect(getIssue).not.toHaveBeenCalled();
  });
});

describe('the date cell of an Already-ticketed change row', () => {
  it('shows the recorded and reported date side by side', async () => {
    const recorded = comp('example-lib:1.2.3', { plannedDate: '2026-12-15' });
    const reported = comp('example-lib:1.2.3', { plannedDate: '2027-01-31' });
    tickets['PROJ-5'] = ticketFor([recorded]);
    const { stream } = await importWaltz([reported]);
    expect(streamText(stream)).toContain('planned 2026-12-15→2027-01-31');
  });
});

describe('what a rewrite says about the dates (KTD11, U6)', () => {
  it('AE8: the comment names each changed date and the Due Date set, and the result line says it replaces a hand-edited date', async () => {
    const recorded = comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2026-12-15' });
    const reported = comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2027-01-31' });
    tickets['PROJ-5'] = ticketFor([recorded]);
    const { ws } = await importWaltz([reported]);

    const text = await reply('apply', ws);

    expect(client.updateIssueCalls[0].fields.duedate).toBe('2027-01-31');
    const comment = client.addCommentCalls[0].body;
    expect(comment).toContain('example-lib:1.2.3');
    expect(comment).toContain('planned 2026-12-15 → 2027-01-31');
    expect(comment).toContain('Due Date');
    expect(comment).toContain('2027-01-31');
    expect(text).toMatch(/Due Date set to 2027-01-31 from the report/);
    expect(text).toMatch(/replaces any date edited by hand/i);
  });

  it('AE9: a rewrite after a member left names the dropped label and sets the Due Date from the members that remain', async () => {
    const a = comp('example-a:1.0.0', { plannedDate: '2026-10-30' });
    const b = comp('example-b:2.0.0', { policyDate: '2026-12-31' });
    const c = comp('example-c:3.0.0', { policyDate: '2026-11-30' });
    tickets['PROJ-1'] = ticketFor([a, b, c]);
    const { ws } = await importWaltz([b, c]);

    await reply('apply', ws);

    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-30');
    expect(client.addCommentCalls[0].body).toContain(sanitizeComponentLabel(a.nameVersion));
  });

  it('a rewrite that changed no date writes no date lines into the comment and no notice into the result', async () => {
    const same = comp('example-lib:1.2.3');
    tickets['PROJ-5'] = ticketFor([same], { labels: ['oss-dependency', sanitizeComponentLabel(same.nameVersion)] });
    const { ws } = await importWaltz([same]);

    const text = await reply('apply', ws);

    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).not.toContain('Remediation dates changed');
    expect(client.addCommentCalls[0].body).not.toContain('Due Date');
    expect(text).not.toMatch(/Due Date/);
  });

  it('add … as rewrite states the Due Date it set in the comment and the result line', async () => {
    tickets['PROJ-5'] = { labels: ['oss-rating-medium'], summary: 'Hand made' };
    const { ws } = await importWaltz([comp('example-a:1.0.0', { plannedDate: '2026-12-15' })]);

    const text = await reply('add 1 to PROJ-5 as rewrite', ws);

    expect(client.addCommentCalls[0].body).toContain('2026-12-15');
    expect(text).toMatch(/Due Date set to 2026-12-15 from the report/);
  });

  it('add … as comment sets no Due Date and says nothing about one', async () => {
    tickets['PROJ-5'] = { labels: ['oss-rating-medium'], summary: 'Hand made' };
    const { ws } = await importWaltz([comp('example-a:1.0.0', { plannedDate: '2026-12-15' })]);

    const text = await reply('add 1 to PROJ-5 as comment', ws);

    expect(client.updateIssueCalls.every(c => !('duedate' in c.fields))).toBe(true);
    expect(text).not.toMatch(/Due Date set/);
  });

  it('writes a component name from the report into the comment as inert text', async () => {
    const recorded = { ...comp('evil|name [x](http://evil.example)', { policyDate: '2026-11-30' }) };
    const reported = { ...recorded, remediation: { ...recorded.remediation!, policyDate: '2027-01-01' } };
    tickets['PROJ-5'] = ticketFor([recorded]);
    const { ws } = await importWaltz([reported]);

    await reply('apply', ws);

    expect(client.addCommentCalls[0].body).not.toContain('](http://evil.example)');
  });

  it('AE11: closing an open ticket from the Stale screen touches no Due Date and adds no date text to the close', async () => {
    vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { discovered: '2024-01-01', graph: { Open: [{ id: '31', name: 'Close', to: 'Done' }], Done: [] } } } } as never);
    const gone = comp('example-gone:1.0.0', { policyDate: '2026-11-30' });
    tickets['PROJ-7'] = ticketFor([gone]);
    staleSearch = jql => (jql.includes('resolution is EMPTY') && jql.includes('labels = "oss-dependency"')
      ? { issues: [{ key: 'PROJ-7', fields: { summary: 'gone', status: { name: 'Open' }, issuetype: { name: 'Bug' }, labels: tickets['PROJ-7'].labels } }], total: 1, isLast: true }
      : undefined);
    const { ws } = await importWaltz([comp('example-other:1.0.0')]);
    const issueGet = client.getIssue;
    client.getIssue = async key => { const i = await issueGet(key); i.fields.issuetype = { id: '1', name: 'Bug' } as never; return i; };
    const stored = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
    expect(stored.staleTickets?.groups.flatMap(g => g.tickets.map(t => t.key)) ?? []).toContain('PROJ-7');

    await reply('open stale', ws);
    await reply('PROJ-7', ws);
    await reply('close tickets', ws);
    for (let step = 0; step < 3 && ws.store['jira.session.staleResolution']; step++) {
      await handleWaltzStaleClose(step === 0 ? 'Done' : 'none', ws.store['jira.session.staleResolution'] as never, ticketService, mockStream() as never, ws as never);
    }

    expect(client.executeTransitionCalls.length).toBeGreaterThan(0);
    expect(client.updateIssueCalls.every(c => !('duedate' in c.fields))).toBe(true);
    expect(client.addCommentCalls.every(c => !/Due Date|Remediation dates/.test(c.body))).toBe(true);
  });
});
