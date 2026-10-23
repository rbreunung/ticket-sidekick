import { describe, it, expect, vi, beforeEach } from 'vitest';

const sla = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('vscode', () => {
  class Uri {
    constructor(public fsPath = '') {}
    static file(p: string): Uri { return new Uri(p); }
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri([base.fsPath, ...parts].join('/')); }
  }
  return {
    Uri,
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: vi.fn(() => ({ get: (key: string) => (key === 'veracode.slaDays' ? sla.value : undefined) })),
      fs: { writeFile: vi.fn() },
    },
    window: {
      showInputBox: vi.fn(),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    },
    MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
  };
});

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: vi.fn() }); }),
}));
vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import * as vscode from 'vscode';
import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType, buildWaltzTemplateSession, handleWaltzReviewReply } from '../participant/jira/waltzHandler';
import { parseImportReviewReply, describeImportReplyVocabulary, buildImportOverview, buildImportScreen, VERACODE_REVIEW_COLUMNS, type AwaitIssueTypeResume, type ImportReplyContext, type VeracodeReviewSession, type WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { sanitizeComponentLabel } from '../utils/waltzReport';
import { makeComponent, makeFlaw } from './helpers/overviewFixtures';
import { makeMockWs, mockStream, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

interface JiraSide { labels: string[]; fixVersions?: string[]; duedate?: string; summary?: string; status?: string; resolution?: { name: string } | null; description?: string }

let client: MockJiraClient;
let service: TicketService;

beforeEach(() => {
  vi.clearAllMocks();
  sla.value = undefined;
  client = new MockJiraClient();
  service = new TicketService(client);
});

/** Answers the by-key search of the export from the same tickets, with their Fix Versions and Due Dates. */
function answerKeySearch(tickets: Record<string, JiraSide>) {
  const dedup = service.searchTicketsRaw.bind(service);
  vi.spyOn(service, 'searchTicketsRaw').mockImplementation(async (jql: string, ...rest) => {
    if (!jql.startsWith('key in (')) return dedup(jql, ...rest as [number]);
    const keys = jql.slice('key in ('.length, jql.indexOf(')')).split(',').map(k => k.trim());
    const issues = keys.filter(k => tickets[k]).map(k => ({
      id: k, key: k,
      fields: {
        summary: tickets[k].summary ?? `Summary ${k}`, status: { name: tickets[k].status ?? 'Open' }, labels: tickets[k].labels,
        fixVersions: (tickets[k].fixVersions ?? []).map(name => ({ name })), duedate: tickets[k].duedate,
      },
    }));
    return { issues, total: issues.length, isLast: true } as never;
  });
}

async function importVeracode(flaws: ReturnType<typeof makeFlaw>[], tickets: Record<string, FakeTicket>, ws = makeMockWs()) {
  statefulJira(client, tickets);
  searchFromStore(service, tickets);
  const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
  const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = { kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession };
  await handleVeracodeAwaitIssueType(resume, 'Bug', client, service, mockStream() as never, ws as never);
  return { session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession, ws };
}

async function importWaltz(components: ReturnType<typeof makeComponent>[], tickets: Record<string, FakeTicket>, ws = makeMockWs()) {
  statefulJira(client, tickets);
  searchFromStore(service, tickets);
  const templateSession = await buildWaltzTemplateSession(components, 'report.xlsx', 'PROJ', client);
  const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = { kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession };
  await handleWaltzAwaitIssueType(resume, 'Bug', client, service, mockStream() as never, ws as never);
  return { session: ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws };
}

describe('export reply of a report import', () => {
  it('lists a report finding with no ticket in the Not assigned table, and the tracked ticket under its Fix Version', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'ExportService.java', line: 5 })], tickets);
    expect(session.view).toBe('overview');
    answerKeySearch({ 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'], fixVersions: ['2026.11'], duedate: '2099-01-01' } });
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: '1', key: 'PROJ', name: 'P', issueTypes: [], versions: [{ id: '1', name: '2026.11', releaseDate: '2099-06-01' }] });
    const stream = mockStream();

    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    const text = streamText(stream);
    expect(text).toContain('2026.11 (releases 2099-06-01)');
    expect(text).toContain('PROJ-1');
    expect(text).toContain('Not assigned to a release');
    expect(text).toContain('in report, no ticket');
    expect(text).toContain('1 item has no ticket yet');
    expect(decodeURIComponent(text)).toContain('@jira export csv');
    expect(text).toContain('| Item | Rating | Ticket | Due | Flag | Report match |');
  });

  it('lists a finding whose only ticket is resolved as in report, no ticket, and not as that ticket', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-7': { labels: ['veracode', 'veracode-issue-101'], resolution: { name: 'Done' }, status: 'Done' } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], tickets);
    answerKeySearch({ 'PROJ-7': { labels: ['veracode', 'veracode-issue-101'], status: 'Done' } });
    const stream = mockStream();

    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    const text = streamText(stream);
    expect(text).not.toContain('PROJ-7');
    expect(text).toContain('2 items have no ticket yet');
  });

  it('marks a stale ticket and reads its detail from the ticket, since the report does not hold it', async () => {
    const { session, ws } = await importWaltz([makeComponent('guava:31.0')], {});
    session.staleTickets = {
      groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [{ key: 'PROJ-9', summary: '[OSS] log4j-core:2.17.1 — Medium', currentStatus: 'Open', transitionPath: [], subtasks: [], included: true }] }],
      ineligible: [], resolutionOptions: [],
    } as never;
    answerKeySearch({ 'PROJ-9': { labels: ['oss-dependency', sanitizeComponentLabel('log4j-core:2.17.1')], summary: '[OSS] log4j-core:2.17.1 — Medium' } });
    const stream = mockStream();

    await handleWaltzReviewReply('export', session, service, stream as never, ws as never);

    const text = streamText(stream);
    expect(text).toContain('PROJ-9');
    expect(text).toContain('stale');
    expect(text).toContain('guava:31.0');
  });

  it('saves one CSV row per Veracode finding, with report detail, on export csv', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('102', { line: 99 })], tickets);
    answerKeySearch({ 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'], fixVersions: ['2026.11'] } });
    const target = vscode.Uri.file('/out/overview.csv');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const stream = mockStream();

    await handleVeracodeReviewReply('export csv', session, service, stream as never, ws as never);

    const [uri, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0];
    expect(uri).toBe(target);
    const lines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes as Uint8Array).slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toContain('Report match');
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every(l => l.includes('PROJ-1') && l.includes(',report,'))).toBe(true);
    expect(streamText(stream)).toContain('Saved the overview to `/out/overview.csv`');
  });

  it('answers export on a group screen of a multi-group import with where it works', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], tickets);
    await handleVeracodeReviewReply('open new', session, service, mockStream() as never, ws as never);
    const stream = mockStream();

    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    expect(streamText(stream)).toContain('Export works from the overview');
    expect(vi.mocked(vscode.workspace.fs.writeFile)).not.toHaveBeenCalled();
  });

  it('works on the only screen of a single-group import', async () => {
    const { session, ws } = await importVeracode([makeFlaw('301')], {});
    expect(session.singleGroup).toBe(true);
    answerKeySearch({});
    const stream = mockStream();

    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    expect(streamText(stream)).toContain('Not assigned to a release');
  });

  it('says what went wrong and leaves the review alone when Jira cannot be read', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], tickets);
    vi.spyOn(service, 'getOverviewTicketsByKeys').mockRejectedValue(new Error('Jira is down'));
    const stream = mockStream();

    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    expect(streamText(stream)).toContain('Could not read the tickets from Jira: Jira is down');
    expect(streamText(stream)).not.toContain('Security overview');
  });

  it('changes nothing in the review: rows, outcomes and tickets stay as they were', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('102', { line: 7 })], tickets);
    answerKeySearch({ 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } });
    const before = JSON.stringify({ rows: session.allRows, outcomes: session.outcomes });

    await handleVeracodeReviewReply('export', session, service, mockStream() as never, ws as never);

    expect(JSON.stringify({ rows: session.allRows, outcomes: session.outcomes })).toBe(before);
    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.createIssueCalls).toHaveLength(0);
  });
});

describe('export preview ends the turn', () => {
  it('leaves the preview as the last thing on screen on the overview, with a way back, and keeps the session', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], tickets);
    answerKeySearch({ 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } });
    const stream = mockStream();

    const result = await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    const text = decodeURIComponent(streamText(stream));
    expect(text).toContain('Not assigned to a release');
    expect(text).not.toContain('### Import results');
    expect(text).toContain('Back to overview');
    expect(result).toMatchObject({ metadata: { jiraSession: { kinds: ['veracode-review'] } } });
    expect(ws.store['jira.session.veracodeReview']).toBeDefined();
  });

  it('does not print the Already-ticketed screen again when it is the only screen, and reads the next reply against it', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } };
    const { session, ws } = await importVeracode([makeFlaw('101')], tickets);
    expect(session.singleGroup).toBe(true);
    expect(session.view).toBe('ticketed');
    answerKeySearch({ 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } });
    const stream = mockStream();

    const result = await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    const text = decodeURIComponent(streamText(stream));
    expect(text).not.toContain('### Already ticketed');
    expect(text).toContain('Done');
    expect(result).toMatchObject({ metadata: { jiraSession: { kinds: ['veracode-review'] } } });

    const next = mockStream();
    await handleVeracodeReviewReply('all leave', session, service, next as never, ws as never);
    expect(streamText(next)).toContain('### Already ticketed');
  });

  it('keeps the session and shows the way on when Jira cannot be read', async () => {
    const { session, ws } = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } });
    vi.spyOn(service, 'getOverviewTicketsByKeys').mockRejectedValue(new Error('Jira is down'));
    const stream = mockStream();

    const result = await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);

    expect(decodeURIComponent(streamText(stream))).toContain('Back to overview');
    expect(result).toMatchObject({ metadata: { jiraSession: { kinds: ['veracode-review'] } } });
  });
});

describe('export link on the review screens', () => {
  it('is on the overview of a Veracode import and on the only screen of a single-group one', async () => {
    const multi = await importVeracode([makeFlaw('101'), makeFlaw('201', { sourceFile: 'Other.java', line: 5 })], { 'PROJ-1': { labels: ['veracode', 'veracode-issue-101'] } });
    const overview = mockStream();
    await handleVeracodeReviewReply('open new', multi.session, service, mockStream() as never, multi.ws as never);
    await handleVeracodeReviewReply('back', multi.session, service, overview as never, multi.ws as never);
    expect(decodeURIComponent(streamText(overview))).toMatch(/\[Export\]\(command:[^)]*@jira export/);

    const group = mockStream();
    await handleVeracodeReviewReply('open new', multi.session, service, group as never, multi.ws as never);
    expect(decodeURIComponent(streamText(group))).not.toContain('Export');

    const single = await importVeracode([makeFlaw('301')], {});
    const screen = mockStream();
    await handleVeracodeReviewReply('include all', single.session, service, screen as never, single.ws as never);
    expect(decodeURIComponent(streamText(screen))).toMatch(/\[Export\]\(command:[^)]*@jira export/);
  });

  it('is on the Already-ticketed screen of a Waltz import that has only that screen', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-1': { labels: ['oss-dependency', sanitizeComponentLabel('guava:31.0')] } };
    const { session, ws } = await importWaltz([makeComponent('guava:31.0')], tickets);
    expect(session.view).toBe('ticketed');
    const stream = mockStream();

    await handleWaltzReviewReply('all leave', session, service, stream as never, ws as never);

    const text = decodeURIComponent(streamText(stream));
    expect(text).toMatch(/\[Export\]\(command:[^)]*@jira export/);
    expect(describeImportReplyVocabulary('ticketed', { singleGroup: true, groups: ['ticketed'], newRowIds: [], ticketedRows: [], canExport: true })).toContain('`export`');
  });

  it('is not offered by an import without export (email)', async () => {
    const { session } = await importVeracode([makeFlaw('301')], {});
    expect(buildImportOverview(session, { itemNoun: 'email(s)' })).not.toContain('Export');
    expect(buildImportScreen(session, VERACODE_REVIEW_COLUMNS, { itemNoun: 'email(s)' })).not.toContain('Export');
    expect(describeImportReplyVocabulary('new', { singleGroup: true, groups: ['new'], newRowIds: [], ticketedRows: [] })).not.toContain('export');
  });
});

describe('export reply vocabulary', () => {
  const ctx = (over: Partial<ImportReplyContext> = {}): ImportReplyContext => ({ singleGroup: false, groups: ['new', 'ticketed'], newRowIds: [], ticketedRows: [], ...over });

  it('is understood on the overview only where the importer supports it', () => {
    expect(parseImportReviewReply('overview', 'export', ctx({ canExport: true }))).toEqual({ kind: 'export', csv: false });
    expect(parseImportReviewReply('overview', 'Export CSV', ctx({ canExport: true }))).toEqual({ kind: 'export', csv: true });
    expect(parseImportReviewReply('overview', 'export', ctx())).toEqual({ kind: 'invalid' });
  });

  it('is rejected on a group screen of a multi-group import and accepted on a single-group one', () => {
    for (const view of ['new', 'ticketed', 'stale'] as const) {
      expect(parseImportReviewReply(view, 'export', ctx({ canExport: true }))).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('overview') });
      expect(parseImportReviewReply(view, 'export', ctx({ canExport: true, singleGroup: true }))).toEqual({ kind: 'export', csv: false });
    }
  });
});

describe('export reply: the Due Date of a Veracode item with no ticket yet (SLA due dates, U5)', () => {
  // A report-only row has no Fix Version, so it can be overdue but never due before its release.
  const exportText = async (flaws: ReturnType<typeof makeFlaw>[]) => {
    const { session, ws } = await importVeracode(flaws, {});
    answerKeySearch({});
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: '1', key: 'PROJ', name: 'P', issueTypes: [], versions: [] });
    const stream = mockStream();
    await handleVeracodeReviewReply('export', session, service, stream as never, ws as never);
    return streamText(stream);
  };
  const flawFoundOn = (date: string | null, severity = 4) => makeFlaw('101', { severity, firstFoundDate: date });

  it('AE11: shows the policy due date and the overdue flag for an item whose date is already past, and no due-before-release flag', async () => {
    sla.value = { High: 28 };
    const text = await exportText([flawFoundOn('2020-01-01')]);
    expect(text).toContain('2020-01-29');
    expect(text).toContain('⚠ overdue');
    expect(text).not.toContain('⚠ due before release');
  });

  it('shows the date without a flag when it is still in the future', async () => {
    sla.value = { High: 28 };
    const text = await exportText([flawFoundOn('2099-01-01')]);
    expect(text).toContain('2099-01-29');
    expect(text).not.toContain('⚠');
  });

  it('shows a dash for an item whose severity is at 0, and when the setting is absent', async () => {
    sla.value = { High: 0 };
    expect(await exportText([flawFoundOn('2020-01-01')])).not.toContain('2020-01');
    sla.value = undefined;
    expect(await exportText([flawFoundOn('2020-01-01')])).not.toContain('2020-01');
  });

  it('writes the policy due date of a report-only item into the CSV\'s due-date column', async () => {
    sla.value = { High: 28 };
    const { session, ws } = await importVeracode([makeFlaw('101', { severity: 4, firstFoundDate: '2020-01-01' })], {});
    answerKeySearch({});
    vi.spyOn(client, 'getProject').mockResolvedValue({ id: '1', key: 'PROJ', name: 'P', issueTypes: [], versions: [] });
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/out/overview.csv'));

    await handleVeracodeReviewReply('export csv', session, service, mockStream() as never, ws as never);

    const [, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0];
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes as Uint8Array);
    expect(csv).toContain('2020-01-29');
  });
});
