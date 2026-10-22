import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const workspace = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return workspace.dir ? [{ uri: { fsPath: workspace.dir } }] : undefined; },
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
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: vi.fn() }); }),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

vi.mock('../utils/waltzReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/waltzReport')>()),
  parseWaltzReport: vi.fn(),
}));

import * as vscode from 'vscode';
import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import { parseWaltzReport, sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import { ACCEPTED_FILE_NAME } from '../utils/waltzAccepted';
import type { WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { buildImportTemplateSession } from '../participant/jira/reportImportHandler';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText, descriptor as genericDescriptor } from './helpers/reportImportHarness';

const comp = (nameVersion: string, rating: string, cves: Array<[string, string]>): WaltzComponent => ({
  nameVersion, maxVulnRating: rating, remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: cves.map(([cveId, overallSeverity]) => ({ cveId, cveSummary: null, overallSeverity, cvssV3Score: 7, fixedVersion: null })),
});

let dir: string;
let reportPath: string;
let report: WaltzComponent[];
let client: MockJiraClient;
let ticketService: TicketService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'refresh-'));
  workspace.dir = dir;
  reportPath = join(dir, 'r.xlsx');
  writeFileSync(reportPath, 'placeholder bytes: the parser is mocked');
  report = [];
  vi.mocked(parseWaltzReport).mockReset();
  vi.mocked(parseWaltzReport).mockImplementation((async () => report) as never);
  vi.mocked(vscode.window.showOpenDialog).mockReset();
  client = new MockJiraClient();
  ticketService = new TicketService(client);
});
afterEach(() => { workspace.dir = undefined; rmSync(dir, { recursive: true, force: true }); });

const writeList = (entries: Array<{ component: string; cve?: string; version?: string }>) =>
  writeFileSync(join(dir, ACCEPTED_FILE_NAME), JSON.stringify({ accepted: entries }));

async function importWaltz(components: WaltzComponent[], tickets: Record<string, FakeTicket> = {}) {
  report = components;
  statefulJira(client, tickets);
  searchFromStore(ticketService, tickets);
  const templateSession = await buildWaltzTemplateSession(components, 'r.xlsx', 'PROJ', client, components, reportPath);
  const ws = makeMockWs();
  await handleWaltzAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, mockStream() as never, ws as never);
  return { session: ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws };
}

const reply = async (text: string, session: WaltzReviewSession, ws: ReturnType<typeof makeMockWs>) => {
  const stream = mockStream();
  await handleWaltzReviewReply(text, session, ticketService, stream as never, ws as never);
  return { text: streamText(stream), session: ws.store['jira.session.waltzReview'] as WaltzReviewSession };
};

const newRows = (s: WaltzReviewSession) => s.allRows.filter(r => r.existingTicketKey === null);
const parseCalls = () => vi.mocked(parseWaltzReport).mock.calls.length;

describe('the review remembers its report file (KTD9)', () => {
  it('the template session of any entry point carries the path it was given', async () => {
    const withPath = await buildImportTemplateSession([{ ref: '1' }], 'f.test', 'PROJ', new MockJiraClient(), genericDescriptor, [], '/reports/f.test');
    expect(withPath.reportFilePath).toBe('/reports/f.test');
    const without = await buildImportTemplateSession([{ ref: '1' }], 'f.test', 'PROJ', new MockJiraClient(), genericDescriptor);
    expect(without.reportFilePath).toBeUndefined();
  });

  it('stores the path the import was started from', async () => {
    const { session } = await importWaltz([comp('bar:1.0', 'High', [['CVE-9', 'High']])]);
    expect(session.reportFilePath).toBe(reportPath);
    expect(session.schemaVersion).toBe(13);
  });
});

describe('unaccept keeps the screens in step with the list (R14, AE5, AE6)', () => {
  const twoComponents = () => [comp('bar:1.0', 'High', [['CVE-9', 'High']]), comp('libfoo:1.0', 'High', [['CVE-1', 'High']])];

  it('AE5: with no unfinished choices the removed entry\'s component appears in New at once', async () => {
    writeList([{ component: 'libfoo', cve: 'CVE-1' }]);
    const { session, ws } = await importWaltz(twoComponents());
    expect(newRows(session).map(r => r.nameVersion)).toEqual(['bar:1.0']);

    const out = await reply('unaccept 1', session, ws);

    expect(newRows(out.session).map(r => r.nameVersion).sort()).toEqual(['bar:1.0', 'libfoo:1.0']);
    expect(out.session.outOfDate).toBeUndefined();
    expect(out.session.acceptedHidden).toBeUndefined();
    expect(out.session.reportFilePath).toBe(reportPath);
  });

  it('AE6: with an excluded New row nothing is rebuilt; the screens are marked out of date and offer the reload', async () => {
    writeList([{ component: 'libfoo', cve: 'CVE-1' }]);
    const { session, ws } = await importWaltz(twoComponents());
    await reply('1', session, ws); // exclude row 1 on the displayed page
    const before = parseCalls();

    const out = await reply('unaccept 1', ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws);

    expect(parseCalls()).toBe(before);
    expect(out.session.outOfDate).toBe(true);
    expect(newRows(out.session)).toHaveLength(1);
    expect(out.text).toMatch(/out of date/i);
    expect(out.text).toMatch(/reload(%20| )report/);
  });

  it('a single-group import with only Already-ticketed rows becomes a two-group review with an overview', async () => {
    const libfoo = comp('libfoo:1.0', 'High', [['CVE-1', 'High']]);
    writeList([{ component: 'bar', cve: 'CVE-9' }]);
    const { session, ws } = await importWaltz(
      [libfoo, comp('bar:1.0', 'High', [['CVE-9', 'High']])],
      { 'PROJ-7': { labels: ['oss-dependency', sanitizeComponentLabel(libfoo.nameVersion)] } },
    );
    expect(session.groups).toEqual(['ticketed']);
    expect(session.view).toBe('ticketed');

    const out = await reply('unaccept 1', session, ws);

    expect(out.session.groups).toEqual(['new', 'ticketed']);
    expect(out.session.singleGroup).toBe(false);
    expect(out.session.view).toBe('overview');
  });
});

describe('reload report (R13, AE6)', () => {
  const some = () => [comp('bar:1.0', 'High', [['CVE-9', 'High']])];

  it('the bare command warns and links the confirmation, and reads nothing', async () => {
    const { session, ws } = await importWaltz(some());
    const before = parseCalls();

    const out = await reply('reload report', session, ws);

    expect(parseCalls()).toBe(before);
    expect(out.text).toContain('r.xlsx');
    expect(out.text).toMatch(/reload(%20| )report(%20| )confirm/);
  });

  it('warns that unfinished choices are lost when there are some', async () => {
    const { session, ws } = await importWaltz(some());
    await reply('1', session, ws);
    const out = await reply('reload report', ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws);
    expect(out.text).toMatch(/lost/i);
  });

  it('the confirmed reload re-reads the file, keeps the outcomes and clears the out-of-date mark', async () => {
    const { session, ws } = await importWaltz(some());
    session.outcomes = { ...session.outcomes!, created: 3 };
    session.outOfDate = true;
    report = [...some(), comp('baz:2.0', 'High', [['CVE-5', 'High']])];

    const out = await reply('reload report confirm', session, ws);

    expect(newRows(out.session).map(r => r.nameVersion).sort()).toEqual(['bar:1.0', 'baz:2.0']);
    expect(out.session.outcomes!.created).toBe(3);
    expect(out.session.outOfDate).toBeUndefined();
  });

  it('clamps the New page when the rebuilt list is shorter', async () => {
    const many = Array.from({ length: 60 }, (_, i) => comp(`c${i}:1.0`, 'High', [[`CVE-${i}`, 'High']]));
    const { session, ws } = await importWaltz(many);
    const second = await reply('next', session, ws);
    expect(second.session.page).toBe(1);
    report = many.slice(0, 3);

    const out = await reply('reload report confirm', second.session, ws);

    expect(out.session.page).toBe(0);
    expect(newRows(out.session)).toHaveLength(3);
  });

  it('error path: the file is gone, so it says so, opens the picker, and a cancelled pick leaves the review unchanged', async () => {
    const { session, ws } = await importWaltz(some());
    unlinkSync(reportPath);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);

    const out = await reply('reload report confirm', session, ws);

    expect(out.text).toMatch(/no longer there|gone/i);
    expect(vscode.window.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(out.session.reportFilePath).toBe(reportPath);
    expect(newRows(out.session)).toHaveLength(1);
  });

  it('error path: a file picked in its place replaces the stored path and rebuilds', async () => {
    const { session, ws } = await importWaltz(some());
    unlinkSync(reportPath);
    const other = join(dir, 'other.xlsx');
    writeFileSync(other, 'placeholder');
    report = [comp('new:1.0', 'High', [['CVE-7', 'High']])];
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: other }] as never);

    const out = await reply('reload report confirm', session, ws);

    expect(out.session.reportFilePath).toBe(other);
    expect(newRows(out.session).map(r => r.nameVersion)).toEqual(['new:1.0']);
  });

  it('error path: a report that no longer parses is reported and the review is unchanged', async () => {
    const { session, ws } = await importWaltz(some());
    vi.mocked(parseWaltzReport).mockImplementation((async () => { throw new Error('bad workbook'); }) as never);

    const out = await reply('reload report confirm', session, ws);

    expect(out.text).toContain('bad workbook');
    expect(newRows(out.session)).toHaveLength(1);
  });
});

describe('review fixes: a refresh never replaces a review with a partial rebuild', () => {
  const failSearch = () => vi.spyOn(ticketService, 'searchTicketsRaw').mockRejectedValue(new Error('Jira is down'));

  it('reload report leaves the review as it was when the Jira search fails', async () => {
    const libfoo = comp('libfoo:1.0', 'High', [['CVE-1', 'High']]);
    const { session, ws } = await importWaltz([libfoo], { 'PROJ-7': { labels: ['oss-dependency', sanitizeComponentLabel(libfoo.nameVersion)] } });
    expect(session.allRows.filter(r => r.existingTicketKey !== null)).toHaveLength(1);
    failSearch();

    const out = await reply('reload report confirm', session, ws);

    expect(out.text).toMatch(/left it as it was|left as it was|as it was/i);
    expect(out.session.allRows.filter(r => r.existingTicketKey !== null)).toHaveLength(1);
    expect(newRows(out.session)).toHaveLength(0);
  });

  it('unaccept marks the screens out of date, and keeps the review, when the Jira search fails', async () => {
    const libfoo = comp('libfoo:1.0', 'High', [['CVE-1', 'High']]);
    writeList([{ component: 'bar', cve: 'CVE-9' }]);
    const { session, ws } = await importWaltz(
      [libfoo, comp('bar:1.0', 'High', [['CVE-9', 'High']])],
      { 'PROJ-7': { labels: ['oss-dependency', sanitizeComponentLabel(libfoo.nameVersion)] } },
    );
    failSearch();

    const out = await reply('unaccept 1', session, ws);

    expect(out.session.outOfDate).toBe(true);
    expect(out.session.allRows.filter(r => r.existingTicketKey !== null)).toHaveLength(1);
  });
});

describe('review fixes: the report file name in the reload prompt', () => {
  // `<`, `>` and `:` cannot appear in a Windows file name, so a report with such a name cannot exist there.
  it.skipIf(process.platform === 'win32')('keeps a <command:…> autolink in the file name inert', async () => {
    const hostile = join(dir, '<command:workbench.action.chat.open>.xlsx');
    writeFileSync(hostile, 'placeholder');
    report = [comp('bar:1.0', 'High', [['CVE-9', 'High']])];
    statefulJira(client, {});
    searchFromStore(ticketService, {});
    const templateSession = await buildWaltzTemplateSession(report, 'r.xlsx', 'PROJ', client, report, hostile);
    const ws = makeMockWs();
    await handleWaltzAwaitIssueType({ kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession }, 'Bug', client, ticketService, mockStream() as never, ws as never);

    const out = await reply('reload report', ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws);

    expect(out.text).not.toMatch(/(?<!\\)<command:/);
    expect(out.text).toContain('\\<command:');
  });
});

describe('reload report reuses the descriptions already read (remediation dates, KTD1)', () => {
  const ticketed = () => {
    const lib = comp('bar:1.0', 'High', [['CVE-9', 'High']]);
    return { lib, tickets: { 'PROJ-5': { labels: ['oss-dependency', sanitizeComponentLabel(lib.nameVersion), 'oss-cve-cve-9', 'oss-rating-high'], description: 'h3. Component\nbar:1.0' } as FakeTicket } };
  };

  it('does not read a ticket again on a reload, until this session has rewritten a ticket', async () => {
    const { lib, tickets } = ticketed();
    const { session, ws } = await importWaltz([lib], tickets);
    const reads: string[] = [];
    const getIssue = client.getIssue;
    client.getIssue = async key => { reads.push(key); return getIssue.call(client, key); };
    expect(Object.keys(session.ticketDescriptions ?? {})).toEqual(['PROJ-5']);

    await reply('reload report confirm', session, ws);
    expect(reads).toEqual([]);

    const stored = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
    stored.outcomes = { ...stored.outcomes!, rewritten: 1 };
    await reply('reload report confirm', stored, ws);
    expect(reads).toEqual(['PROJ-5']);
  });
});
