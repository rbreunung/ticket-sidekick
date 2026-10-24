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
import { CURRENT_SESSION_SCHEMA_VERSION, type WaltzReviewSession } from '../participant/sessionState';
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


const lib = comp('bar:1.0', 'High', [['CVE-9', 'High']]);
const barLabels = ['oss-dependency', sanitizeComponentLabel(lib.nameVersion), 'oss-cve-cve-9', 'oss-rating-high'];
const ticketedTickets = (): Record<string, FakeTicket> => ({ 'PROJ-5': { labels: barLabels, summary: '[OSS] bar:1.0 — High', status: 'In Progress' } });
const fresh = comp('newlib:2.0', 'High', [['CVE-1', 'High']]);

describe('search reply (import ticket search, U4)', () => {
  it('Covers AE1: lists the matching ticket with its A id and leaves the session untouched', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open already ticketed', session, ws);
    const stored = JSON.stringify(opened.session);

    const out = await reply('search bar', opened.session, ws);

    expect(out.text).toContain('PROJ-5');
    expect(out.text).toContain('A1');
    expect(out.text).toContain('In Progress');
    expect(out.text).toContain('bar:1.0 — High');
    expect(JSON.stringify(out.session)).toBe(stored);
  });

  it('ends with a Show link, and with the merge hint on the New screen', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);

    const out = await reply('search bar', opened.session, ws);

    const text = decodeURIComponent(out.text);
    expect(text).toMatch(/\[Show\]\(command:[^)]*@jira show/);
    expect(text).toContain('merge 1 2 into A3');
    expect(out.session.view).toBe('new');
  });

  it('Covers AE3: says nothing matched and keeps the screen', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);

    const out = await reply('search zzz', opened.session, ws);

    expect(out.text).toMatch(/No open tickets/);
    expect(out.session.view).toBe('new');
    expect(out.session.rows).toEqual(opened.session.rows);
  });

  it('tells a session saved by an older version to reload the report', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);
    delete opened.session.ticketInfo;
    const out = await reply('search bar', opened.session, ws);
    expect(out.text).toContain('reload report');
  });

  it('on the overview, points to the screens that have search', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const out = await reply('search bar', session, ws);
    expect(out.text).toMatch(/New and Already ticketed/);
  });

  it('does not list a ticket the review knows only as resolved', async () => {
    const tickets = ticketedTickets();
    tickets['PROJ-5'].resolution = { name: 'Done' };
    const { session, ws } = await importWaltz([lib], tickets);
    const out = await reply('search bar', session, ws);
    expect(out.text).toMatch(/No open tickets/);
  });
});

describe('show reply (import ticket search, U4)', () => {
  it('Covers AE5: prints the screen the session is on again, with the page and row state intact', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);
    const excluded = await reply('1', opened.session, ws);
    const searched = await reply('search bar', excluded.session, ws);

    const shown = await reply('show', searched.session, ws);

    expect(shown.session.view).toBe('new');
    expect(shown.session.rows).toEqual(excluded.session.rows);
    expect(shown.text).toContain('newlib:2.0');
  });
});

describe('merge … into <ticket> on the New screen (import ticket search, U4)', () => {
  it('Covers AE4: an A id from the search results opens the add prompt for that row\'s ticket', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);

    const out = await reply('merge 1 into A1', opened.session, ws);

    const text = decodeURIComponent(out.text);
    expect(text).toContain('PROJ-5');
    expect(text).toMatch(/as comment/i);
    expect(text).toMatch(/as rewrite/i);
  });

  it('writes nothing until a link is chosen', async () => {
    const { session, ws } = await importWaltz([lib, fresh], ticketedTickets());
    const opened = await reply('open new', session, ws);
    const writes = client.updateIssueCalls.length;

    await reply('merge 1 into A1', opened.session, ws);

    expect(client.updateIssueCalls).toHaveLength(writes);
  });
});
