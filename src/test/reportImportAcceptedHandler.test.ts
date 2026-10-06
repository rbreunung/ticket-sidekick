import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
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
  TemplateService: vi.fn().mockImplementation(() => ({ loadTemplates: vi.fn() })),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import type { WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import { ACCEPTED_FILE_NAME } from '../utils/waltzAccepted';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

const comp = (nameVersion: string, rating: string, cves: Array<[string, string]>): WaltzComponent => ({
  nameVersion, maxVulnRating: rating, remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: cves.map(([cveId, overallSeverity]) => ({ cveId, cveSummary: null, overallSeverity, cvssV3Score: 7, fixedVersion: null })),
});

let dir: string;
let client: MockJiraClient;
let ticketService: TicketService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accepted-handler-'));
  workspace.dir = dir;
  client = new MockJiraClient();
  ticketService = new TicketService(client);
});
afterEach(() => { workspace.dir = undefined; rmSync(dir, { recursive: true, force: true }); });

const fileOn = () => join(dir, ACCEPTED_FILE_NAME);
const writeList = (entries: Array<{ component: string; cve: string; reason?: string }>) => writeFileSync(fileOn(), JSON.stringify({ accepted: entries }));
const readList = () => (JSON.parse(readFileSync(fileOn(), 'utf8')) as { accepted: Array<{ component: string; cve: string; reason?: string }> }).accepted;

async function importWaltz(components: WaltzComponent[], tickets: Record<string, FakeTicket> = {}) {
  statefulJira(client, tickets);
  searchFromStore(ticketService, tickets);
  const templateSession = await buildWaltzTemplateSession(components, 'r.xlsx', 'PROJ', client);
  const ws = makeMockWs();
  const stream = mockStream();
  const result = await handleWaltzAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, stream as never, ws as never);
  return { session: ws.store['jira.session.waltzReview'] as WaltzReviewSession | undefined, ws, stream, result };
}

const reply = async (text: string, session: WaltzReviewSession, ws: ReturnType<typeof makeMockWs>) => {
  const stream = mockStream();
  await handleWaltzReviewReply(text, session, ticketService, stream as never, ws as never);
  return { stream, text: streamText(stream), session: ws.store['jira.session.waltzReview'] as WaltzReviewSession };
};

const newRows = (s: WaltzReviewSession) => s.allRows.filter(r => r.existingTicketKey === null);

describe('building the New rows with an accepted list (R3, R4, R8, R9)', () => {
  it('keeps a partly accepted component with only its open CVE, rated by it (AE1)', async () => {
    writeList([{ component: 'netty-codec', cve: 'CVE-2099-1' }]);
    const { session } = await importWaltz([comp('netty-codec:4.1.100', 'Critical', [['CVE-2099-1', 'Critical'], ['CVE-2099-2', 'High']])]);
    const rows = newRows(session!);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceGroup[0].vulnerabilities.map(v => v.cveId)).toEqual(['CVE-2099-2']);
    expect(rows[0].maxVulnRating).toBe('High');
    expect(rows[0].labels).toContain('oss-cve-cve-2099-2');
    expect(rows[0].labels).not.toContain('oss-cve-cve-2099-1');
    expect(session!.acceptedHidden).toEqual({ cves: 1, belowFloor: 0 });
  });

  it('shows the hidden count on the New screen of a single-group import', async () => {
    writeList([{ component: 'netty-codec', cve: 'CVE-2099-1' }]);
    const { stream } = await importWaltz([
      comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High']]),
      comp('other:1.0', 'High', [['CVE-2099-9', 'High']]),
    ]);
    expect(streamText(stream)).toContain('1 accepted CVE hidden');
  });

  it('says everything is accepted when nothing is left to review, and keeps no review open (AE2)', async () => {
    writeList([{ component: 'netty-codec', cve: 'CVE-2099-1' }]);
    const { session, stream } = await importWaltz([comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High']])]);
    expect(session).toBeUndefined();
    expect(streamText(stream)).toContain('Nothing is left to import');
    expect(streamText(stream)).toContain('1 accepted CVE');
  });

  it('hides a component whose open CVEs fall below the rating floor and reports it apart (AE5)', async () => {
    writeList([{ component: 'libfoo', cve: 'CVE-2099-1' }]);
    const { session } = await importWaltz([
      comp('libfoo:1.0', 'High', [['CVE-2099-1', 'High'], ['CVE-2099-2', 'Low']]),
      comp('other:1.0', 'High', [['CVE-2099-9', 'High']]),
    ]);
    expect(newRows(session!).map(r => r.nameVersion)).toEqual(['other:1.0']);
    expect(session!.acceptedHidden).toEqual({ cves: 1, belowFloor: 1 });
  });

  it('leaves an already-ticketed component with its full CVE list (R8)', async () => {
    writeList([{ component: 'netty-codec', cve: 'CVE-2099-1' }]);
    const netty = comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High'], ['CVE-2099-2', 'High']]);
    const { session } = await importWaltz([netty], { 'PROJ-7': { labels: ['oss-dependency', sanitizeComponentLabel(netty.nameVersion)] } });
    const ticketed = session!.allRows.filter(r => r.existingTicketKey !== null);
    expect(ticketed).toHaveLength(1);
    expect(ticketed[0].sourceGroup[0].vulnerabilities.map(v => v.cveId)).toEqual(['CVE-2099-1', 'CVE-2099-2']);
    expect(session!.acceptedHidden).toBeUndefined();
  });

  it('hides nothing and warns when the file is not valid JSON', async () => {
    writeFileSync(fileOn(), '{ "accepted": [');
    const { session, stream } = await importWaltz([comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High']])]);
    expect(newRows(session!)).toHaveLength(1);
    expect(streamText(stream)).toContain(ACCEPTED_FILE_NAME);
    expect(streamText(stream)).toMatch(/not valid JSON/);
  });

  it('hides nothing when no workspace folder is open', async () => {
    workspace.dir = undefined;
    const { session } = await importWaltz([comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High']])]);
    expect(newRows(session!)).toHaveLength(1);
  });
});

describe('accept on the New screen (R5, R7)', () => {
  const report = () => [
    comp('a:1.0', 'High', [['CVE-2099-1', 'High']]),
    comp('b:1.0', 'High', [['CVE-2099-2', 'High'], ['CVE-2099-3', 'High']]),
    comp('c:1.0', 'High', [['CVE-2099-4', 'High']]),
  ];

  it('writes one entry per CVE of the row, with the reason, and removes the row', async () => {
    const { session, ws } = await importWaltz(report());
    const after = await reply('accept 2 because not reachable behind the proxy', session!, ws);
    expect(readList()).toEqual([
      { component: 'b', cve: 'CVE-2099-2', reason: 'not reachable behind the proxy' },
      { component: 'b', cve: 'CVE-2099-3', reason: 'not reachable behind the proxy' },
    ]);
    expect(newRows(after.session).map(r => r.nameVersion)).toEqual(['a:1.0', 'c:1.0']);
    expect(after.session.rows.filter(r => r.existingTicketKey === null).map(r => r.id)).toEqual(['1', '3']);
    expect(after.session.acceptedHidden).toEqual({ cves: 2, belowFloor: 0 });
    expect(after.text).toContain('2 accepted CVEs hidden');
  });

  it('accepting a merged row writes the CVEs of every member (AE4)', async () => {
    const { session, ws } = await importWaltz(report());
    const merged = await reply('merge 1 2', session!, ws);
    await reply('accept 1', merged.session, ws);
    expect(readList().map(e => `${e.component}:${e.cve}`)).toEqual(['a:CVE-2099-1', 'b:CVE-2099-2', 'b:CVE-2099-3']);
    expect(newRows(ws.store['jira.session.waltzReview'] as WaltzReviewSession).map(r => r.nameVersion)).toEqual(['c:1.0']);
  });

  it('narrows a merged row that was not part of the accept, keeping its id and merge', async () => {
    const { session, ws } = await importWaltz([
      comp('b:1.0', 'High', [['CVE-2099-2', 'High']]),
      comp('b:2.0', 'High', [['CVE-2099-2', 'High'], ['CVE-2099-5', 'High']]),
      comp('c:1.0', 'High', [['CVE-2099-4', 'High']]),
    ]);
    const merged = await reply('merge 2 3', session!, ws);
    const after = await reply('accept 1', merged.session, ws);
    const mergedRow = after.session.rows.find(r => r.memberIds !== undefined)!;
    expect(mergedRow.id).toBe('2');
    expect(mergedRow.memberIds).toEqual(['2', '3']);
    expect(mergedRow.sourceGroup.map(c => `${c.nameVersion}=${c.vulnerabilities.map(v => v.cveId).join(',')}`)).toEqual(['b:2.0=CVE-2099-5', 'c:1.0=CVE-2099-4']);
    expect(mergedRow.included).toBe(true);
  });

  it('drops a kept merged row whose members are all accepted away as a side effect', async () => {
    const { session, ws } = await importWaltz([
      comp('x:1.0', 'High', [['CVE-2099-1', 'High']]),
      comp('x:2.0', 'High', [['CVE-2099-1', 'High']]),
      comp('x:3.0', 'High', [['CVE-2099-1', 'High']]),
    ]);
    const merged = await reply('merge 2 3', session!, ws);
    const after = await reply('accept 1', merged.session, ws);
    expect(newRows(after.session)).toEqual([]);
    expect(after.session.rows.filter(r => r.existingTicketKey === null)).toEqual([]);
    expect(after.text).toContain('No new component');
  });

  it('falls a kept merged row back to its remaining originals when one member is accepted away', async () => {
    const { session, ws } = await importWaltz([
      comp('x:1.0', 'High', [['CVE-2099-1', 'High']]),
      comp('x:2.0', 'High', [['CVE-2099-1', 'High']]),
      comp('y:1.0', 'High', [['CVE-2099-7', 'High']]),
    ]);
    const merged = await reply('merge 2 3', session!, ws);
    const after = await reply('accept 1', merged.session, ws);
    const rows = after.session.rows.filter(r => r.existingTicketKey === null);
    expect(rows.map(r => ({ id: r.id, name: r.nameVersion, merged: r.memberIds !== undefined }))).toEqual([{ id: '3', name: 'y:1.0', merged: false }]);
  });

  it('refuses to accept over a file that is not valid JSON and leaves the session as it was', async () => {
    const { session, ws } = await importWaltz(report());
    writeFileSync(fileOn(), '{ nope');
    const after = await reply('accept 1', session!, ws);
    expect(after.text).toMatch(/not valid JSON/);
    expect(readFileSync(fileOn(), 'utf8')).toBe('{ nope');
    expect(newRows(after.session)).toHaveLength(3);
  });

  it('says so when no workspace folder is open, and writes nothing', async () => {
    const { session, ws } = await importWaltz(report());
    workspace.dir = undefined;
    const after = await reply('accept 1', session!, ws);
    expect(after.text).toMatch(/workspace/i);
    expect(newRows(after.session)).toHaveLength(3);
    expect(existsSync(fileOn())).toBe(false);
  });
});

describe('listing and removing accepted entries (R7)', () => {
  it('lists the entries with their reasons', async () => {
    writeList([{ component: 'netty-codec', cve: 'CVE-2099-1', reason: 'not reachable' }]);
    const { session, ws } = await importWaltz([
      comp('netty-codec:4.1.100', 'High', [['CVE-2099-1', 'High']]),
      comp('other:1.0', 'High', [['CVE-2099-9', 'High']]),
    ]);
    const after = await reply('accepted', session!, ws);
    expect(after.text).toContain('netty-codec');
    expect(after.text).toContain('not reachable');
  });

  it('removes an entry by number and says the finding is back on the next import', async () => {
    writeList([{ component: 'a', cve: 'CVE-1' }, { component: 'b', cve: 'CVE-2' }]);
    const { session, ws } = await importWaltz([comp('other:1.0', 'High', [['CVE-2099-9', 'High']])]);
    const after = await reply('unaccept 1', session!, ws);
    expect(readList()).toEqual([{ component: 'b', cve: 'CVE-2' }]);
    expect(after.text).toMatch(/next import/i);
  });

  it('reports an entry number that is not on the list', async () => {
    writeList([{ component: 'a', cve: 'CVE-1' }]);
    const { session, ws } = await importWaltz([comp('other:1.0', 'High', [['CVE-2099-9', 'High']])]);
    const after = await reply('unaccept 5', session!, ws);
    expect(after.text).toMatch(/no entry 5/i);
    expect(readList()).toHaveLength(1);
  });
});
