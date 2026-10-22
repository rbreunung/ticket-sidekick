import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const workspace = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return workspace.dir ? [{ uri: { fsPath: workspace.dir } }] : undefined; },
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
  },
  window: { showInputBox: vi.fn(), showOpenDialog: vi.fn(), createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: () => ({ templates: [], cleanupRules: [] }) }); }),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

vi.mock('../utils/waltzReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/waltzReport')>()),
  parseWaltzReport: vi.fn(),
}));

import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import { handleImportReviewReply } from '../participant/jira/reportImportHandler';
import { loadWorkflowCache } from '../services/WorkflowService';
import { parseWaltzReport, sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import type { WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { mockStream, makeMockWs, descriptor as genericDescriptor, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

const comp = (nameVersion: string, rating = 'High'): WaltzComponent => ({
  nameVersion, maxVulnRating: rating, remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: [{ cveId: `CVE-${nameVersion.length}-1`, cveSummary: null, overallSeverity: rating, cvssV3Score: 7, fixedVersion: null }],
});
const labelsFor = (c: WaltzComponent) => ['oss-dependency', sanitizeComponentLabel(c.nameVersion)];

const GRAPH = {
  Open: [{ id: '31', name: 'Close', to: 'Closed' }],
  'In Review': [{ id: '32', name: 'Close', to: 'Closed' }],
  Closed: [] as Array<{ id: string; name: string; to: string }>,
};

let dir: string;
let reportPath: string;
let report: WaltzComponent[];
let client: MockJiraClient;
let ticketService: TicketService;
let tickets: Record<string, FakeTicket>;
let log: string[];
let existingLinks: Array<[string, string]>;
let comments: Record<string, string[]>;

const libfoo = comp('libfoo:1.0');
const libbar = comp('libbar:2.0');
const libbaz = comp('libbaz:3.0');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-'));
  workspace.dir = dir;
  reportPath = join(dir, 'r.xlsx');
  writeFileSync(reportPath, 'placeholder');
  report = [libfoo, libbar, libbaz];
  vi.mocked(parseWaltzReport).mockReset();
  vi.mocked(parseWaltzReport).mockImplementation((async () => report) as never);
  vi.mocked(loadWorkflowCache).mockReset();
  vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { graph: GRAPH } } } as never);
  client = new MockJiraClient();
  ticketService = new TicketService(client);
  tickets = {
    'PROJ-12': { labels: labelsFor(libfoo), summary: 'libfoo ticket', status: 'Open' },
    'PROJ-15': { labels: labelsFor(libbar), summary: 'libbar ticket', status: 'Open', description: 'original body' },
    'PROJ-18': { labels: labelsFor(libbaz), summary: 'libbaz ticket', status: 'Open' },
  };
  log = [];
  existingLinks = [];
  comments = {};
});
afterEach(() => { workspace.dir = undefined; rmSync(dir, { recursive: true, force: true }); });

/** Jira fake: stateful tickets plus issue type, description, links, transitions, and a call log in order. */
function fakeJira() {
  statefulJira(client, tickets);
  const getIssue = client.getIssue;
  client.getIssue = async key => {
    const issue = await getIssue(key);
    issue.fields.issuetype = { id: '1', name: 'Bug' } as never;
    issue.fields.description = tickets[key]?.description as never;
    issue.fields.issuelinks = existingLinks.filter(([a]) => a === key).map(([, b], i) => ({
      id: String(i), type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, outwardIssue: { key: b, fields: { summary: '', status: { name: 'Open' } } },
    }));
    return issue;
  };
  const updateIssue = client.updateIssue;
  client.updateIssue = async (key, fields) => {
    log.push(typeof fields.summary === 'string' && fields.summary.startsWith('[Merged into') ? `mark:${key}` : `rewrite:${key}`);
    return updateIssue(key, fields);
  };
  const addComment = client.addComment.bind(client);
  client.addComment = async (key, body) => { log.push(`comment:${key}`); (comments[key] ??= []).push(body); return addComment(key, body); };
  client.getAllComments = async key => (comments[key] ?? []).map((body, i) => ({ id: String(i), author: {} as never, body, created: '2026-10-21' }));
  const createIssueLink = client.createIssueLink.bind(client);
  client.createIssueLink = async (inward, outward, type) => { await createIssueLink(inward, outward, type); existingLinks.push([outward, inward]); log.push(`link:${outward}`); };
  client.executeTransition = async (key, id, fields) => {
    if (fields?.resolution && tickets[key].rejectResolution) throw new Error('Field "resolution" cannot be set');
    client.executeTransitionCalls.push({ issueKey: key, transitionId: id, fields });
    log.push(`close:${key}`);
    tickets[key].status = 'Closed';
    tickets[key].resolution = fields?.resolution ? { name: (fields.resolution as { name: string }).name } : null;
  };
  searchFromStore(ticketService, tickets);
}

async function importWaltz(options: { withPath?: boolean } = {}) {
  fakeJira();
  const templateSession = await buildWaltzTemplateSession(report, 'r.xlsx', 'PROJ', client, report, options.withPath === false ? undefined : reportPath);
  const ws = makeMockWs();
  await handleWaltzAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, mockStream() as never, ws as never);
  return { ws, session: ws.store['jira.session.waltzReview'] as WaltzReviewSession };
}

const reply = async (text: string, ws: ReturnType<typeof makeMockWs>) => {
  const stream = mockStream();
  const session = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
  await handleWaltzReviewReply(text, session, ticketService, stream as never, ws as never);
  return { text: streamText(stream), session: ws.store['jira.session.waltzReview'] as WaltzReviewSession };
};

const rowFor = (s: WaltzReviewSession, key: string) => s.allRows.find(r => r.existingTicketKey === key)!;
const writes = () => log.filter(l => !l.startsWith('close:')).length + client.executeTransitionCalls.length;

describe('the confirmation (R3, R4, R9, R10)', () => {
  it('shows both tickets and the plan, links the confirmation, and writes nothing', async () => {
    const { ws } = await importWaltz();
    const out = await reply('merge A2 into A1', ws);
    expect(log).toEqual([]);
    expect(out.text).toContain('PROJ-12');
    expect(out.text).toContain('PROJ-15');
    expect(out.text).toMatch(/merge(%20| )PROJ-15(%20| )into(%20| )PROJ-12(%20| )confirm/i);
    expect(out.text).toMatch(/nothing is written until/i);
  });

  it('defuses a Markdown link in a ticket summary read from Jira', async () => {
    tickets['PROJ-15'].summary = 'click [here](http://evil.example)';
    const { ws } = await importWaltz();
    const out = await reply('merge A2 into A1', ws);
    expect(out.text).not.toContain('](http://evil.example)');
  });

  it('refuses a reply naming the same ticket on both sides, writing nothing', async () => {
    const { ws } = await importWaltz();
    const out = await reply('merge PROJ-12 into A1', ws);
    expect(out.text).toMatch(/both sides/);
    expect(log).toEqual([]);
  });

  it('warns about a resolved survivor, a ticket no import created, and a resolved source', async () => {
    tickets['PROJ-12'].resolution = { name: 'Fixed' };
    tickets['PROJ-15'].labels = ['unrelated'];
    tickets['PROJ-18'].resolution = { name: 'Done' };
    tickets['PROJ-18'].status = 'Closed';
    const { ws } = await importWaltz();
    const out = await reply('merge PROJ-15 PROJ-18 into PROJ-12', ws);
    expect(out.text).toMatch(/PROJ-12 is resolved/);
    expect(out.text).toMatch(/PROJ-15 was not created by an import/);
    expect(out.text).toMatch(/PROJ-18 is already resolved/);
  });

  it('names the Relates fallback and the resolution pick before the click', async () => {
    const { ws } = await importWaltz();
    client.getIssueLinkTypes = async () => [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }];
    client.getResolutions = async () => [{ name: 'Fixed' }, { name: 'Done' }];
    const out = await reply('merge A2 into A1', ws);
    expect(out.text).toMatch(/no Duplicate link type.*Relates/i);
    expect(out.text).toMatch(/no Duplicate resolution.*pick/i);
  });
});

describe('running a merge (R5-R8, AE1)', () => {
  it('AE1: rewrites the survivor from both, links, marks the source, asks the target, closes with Duplicate — in that order', async () => {
    const { ws } = await importWaltz();
    const asked = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');
    expect(asked.text).toMatch(/status/i);

    const done = await reply('1', ws);

    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12', 'link:PROJ-15', 'mark:PROJ-15', 'close:PROJ-15']);
    expect(tickets['PROJ-12'].labels).toEqual(expect.arrayContaining([...labelsFor(libfoo), ...labelsFor(libbar)]));
    expect(tickets["PROJ-12"].summary).toMatch(/\+1 component/);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).toContain('PROJ-15');
    expect(client.createIssueLinkCalls).toEqual([{ inwardKey: 'PROJ-12', outwardKey: 'PROJ-15', typeName: 'Duplicate' }]);
    expect(tickets['PROJ-15'].summary).toBe('[Merged into PROJ-12] libbar ticket');
    expect(tickets['PROJ-15'].description).toMatch(/^\{panel:title=Merged into PROJ-12\}[\s\S]*original body$/);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-15', transitionId: '31', fields: { resolution: { name: 'Duplicate' } } }]);
    expect(done.session.mergeRun).toBeUndefined();
    expect(done.text).toMatch(/PROJ-15/);
  });

  it('merges several sources into one survivor with one rewrite and one comment', async () => {
    const { ws } = await importWaltz();
    await reply('merge A2 A3 into A1 confirm'.replace('A2 A3 into A1', 'PROJ-15 PROJ-18 into PROJ-12'), ws);
    await reply('1', ws);
    expect(log.filter(l => l === 'rewrite:PROJ-12')).toHaveLength(1);
    expect(log.filter(l => l === 'comment:PROJ-12')).toHaveLength(1);
    expect(log.filter(l => l.startsWith('close:')).sort()).toEqual(['close:PROJ-15', 'close:PROJ-18']);
  });

  it('marks the source rows merged, counts them, and leaves later imports with the survivor as the target', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const out = await reply('1', ws);
    // no pending choices and a stored report path: the review rebuilt itself from Jira
    expect(out.session.outOfDate).toBeUndefined();
    expect(rowFor(out.session, 'PROJ-12')).toBeDefined();
    expect(out.session.allRows.filter(r => r.existingTicketKey !== null).every(r => r.existingTicketKey === 'PROJ-12' || r.existingTicketKey === 'PROJ-18')).toBe(true);
    expect(out.session.outcomes?.merged).toBe(1);
  });

  it('marks the screens out of date instead of rebuilding when the user has changed an Already-ticketed action', async () => {
    const { ws } = await importWaltz();
    await reply('A3 leave', ws);
    const before = vi.mocked(parseWaltzReport).mock.calls.length;
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const out = await reply('1', ws);
    expect(vi.mocked(parseWaltzReport).mock.calls.length).toBe(before);
    expect(out.session.outOfDate).toBe(true);
    expect(out.session.outcomes?.merged).toBe(1);
  });

  it('shows merged rows in place when the review cannot rebuild (no stored report)', async () => {
    const { ws } = await importWaltz({ withPath: false });
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const out = await reply('1', ws);
    expect(rowFor(out.session, 'PROJ-15').result).toEqual({ status: 'done', action: 'merge', into: 'PROJ-12' });
    expect(out.session.outcomes?.merged).toBe(1);
  });
});

describe('failures (R11, AE2)', () => {
  it('AE2: a failed link stops the run, reports every ticket and offers retry or ignore', async () => {
    const { ws } = await importWaltz();
    client.createIssueLinkError = new Error('Issue linking is disabled');
    const out = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(out.session.mergeRun?.awaiting).toBe('decision');
    expect(out.text).toContain('PROJ-12');
    expect(out.text).toContain('PROJ-15');
    expect(out.text).toContain('Issue linking is disabled');
    expect(out.text).toMatch(/retry/i);
    expect(out.text).toMatch(/ignore/i);
    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12']);
  });

  it('retry runs the failed step again and does not repeat the finished ones', async () => {
    const { ws } = await importWaltz();
    client.createIssueLinkError = new Error('Issue linking is disabled');
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    client.createIssueLinkError = null;

    await reply('retry', ws);
    await reply('1', ws);

    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12', 'link:PROJ-15', 'mark:PROJ-15', 'close:PROJ-15']);
  });

  it('ignore skips the failed step, runs the rest, and the final report lists the missing link', async () => {
    const { ws } = await importWaltz();
    client.createIssueLinkError = new Error('Issue linking is disabled');
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);

    await reply('ignore', ws);
    const done = await reply('1', ws);

    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12', 'mark:PROJ-15', 'close:PROJ-15']);
    expect(done.text).toMatch(/link/i);
    expect(done.text).toMatch(/PROJ-15/);
    expect(done.session.mergeRun).toBeUndefined();
  });

  it('a link that already exists is not created again', async () => {
    existingLinks = [['PROJ-15', 'PROJ-12']];
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    await reply('1', ws);
    expect(client.createIssueLinkCalls).toEqual([]);
    expect(log).toContain('close:PROJ-15');
  });

  it('a survivor that cannot be read fails the first step without writing anything', async () => {
    const { ws } = await importWaltz();
    const getIssue = client.getIssue;
    client.getIssue = async key => { if (key === 'PROJ-12') throw new Error('Not found: PROJ-12'); return getIssue(key); };
    const out = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(out.session.mergeRun?.awaiting).toBe('decision');
    expect(writes()).toBe(0);
  });
});

describe('the close (R7, R9, AE3)', () => {
  it('AE3: without a Duplicate resolution the pick appears after the target, and none closes without one', async () => {
    const { ws } = await importWaltz();
    client.getResolutions = async () => [{ name: 'Fixed' }, { name: 'Done' }];
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const asked = await reply('1', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('resolution');
    expect(asked.text).toMatch(/resolution/i);

    await reply('none', ws);

    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-15', transitionId: '31', fields: undefined }]);
  });

  it('a link-type read that fails still tries a Duplicate link', async () => {
    const { ws } = await importWaltz();
    client.getIssueLinkTypes = async () => { throw new Error('403'); };
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(client.createIssueLinkCalls[0].typeName).toBe('Duplicate');
  });

  it('falls back to a Relates link when the project has no Duplicate link type', async () => {
    const { ws } = await importWaltz();
    client.getIssueLinkTypes = async () => [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }];
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(client.createIssueLinkCalls[0].typeName).toBe('Relates');
  });

  it('an already-resolved source is rewritten and linked but not closed, and no target is asked for it', async () => {
    tickets['PROJ-15'].resolution = { name: 'Done' };
    tickets['PROJ-15'].status = 'Closed';
    const { ws } = await importWaltz();
    const out = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(out.session.mergeRun).toBeUndefined();
    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12', 'link:PROJ-15', 'mark:PROJ-15']);
  });

  it('a source with no discovered workflow is reported as not closed, with the discover hint', async () => {
    vi.mocked(loadWorkflowCache).mockReturnValue({} as never);
    const { ws } = await importWaltz();
    const out = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(out.text).toMatch(/discover workflow/);
    expect(log).toEqual(['rewrite:PROJ-12', 'comment:PROJ-12', 'link:PROJ-15', 'mark:PROJ-15']);
    expect(out.session.outcomes?.mergeFailed).toBe(1);
    // a cancelled ticket still open must not become the target of a rebuilt review
    expect(out.session.outOfDate).toBe(true);
  });

  it('back at the target question stops before any close and keeps the finished steps', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const out = await reply('back', ws);
    expect(client.executeTransitionCalls).toEqual([]);
    expect(out.session.mergeRun).toBeUndefined();
    expect(log).toContain('mark:PROJ-15');
  });

  it('names a ticket Jira closed without the Duplicate resolution, and offers no retry for it', async () => {
    tickets['PROJ-15'].rejectResolution = true;
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const out = await reply('1', ws);
    expect(tickets['PROJ-15'].resolution).toBeNull();
    expect(out.text).toMatch(/closed without (the )?(resolution )?Duplicate/i);
    expect(out.session.mergeRun).toBeUndefined();
  });

  it('asks one target per issue type', async () => {
    const { ws } = await importWaltz();
    const getIssue = client.getIssue;
    client.getIssue = async key => { const i = await getIssue(key); if (key === 'PROJ-18') i.fields.issuetype = { id: '2', name: 'Task' } as never; return i; };
    vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { graph: GRAPH }, Task: { graph: GRAPH } } } as never);
    const first = await reply('merge PROJ-15 PROJ-18 into PROJ-12 confirm', ws);
    expect(first.session.mergeRun?.awaiting).toBe('target');
    const second = await reply('1', ws);
    expect(second.session.mergeRun?.awaiting).toBe('target');
    await reply('1', ws);
    expect(log.filter(l => l.startsWith('close:')).sort()).toEqual(['close:PROJ-15', 'close:PROJ-18']);
  });
});

describe('where the reply is not offered (R16)', () => {
  it('an importer without the capability does not read merge … into … and calls Jira for nothing', async () => {
    fakeJira();
    const ws = makeMockWs();
    const session = {
      projectKey: 'PROJ', issueType: 'Task', templateName: null, additionalFields: {}, allRows: [], rows: [], page: 0, schemaVersion: 12,
    } as never;
    const stream = mockStream();
    await handleImportReviewReply('merge A1 into A2', session, ticketService, stream as never, ws as never, genericDescriptor);
    expect(streamText(stream)).toMatch(/Didn't understand/);
    expect(log).toEqual([]);
  });
});

describe('review fixes: replay, retry, chaining and target names', () => {
  it('a replayed confirmation neither links nor comments a second time', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    await reply('1', ws);
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);

    expect(log.filter(l => l === 'comment:PROJ-12')).toHaveLength(1);
    expect(client.createIssueLinkCalls).toHaveLength(1);
  });

  it('retry after a close that failed part-way plans from the ticket\'s current status', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const transition = client.executeTransition;
    client.executeTransition = async (key, id, fields) => {
      if (id === '31') { tickets[key].status = 'In Review'; throw new Error('transition 2 failed'); }
      return transition(key, id, fields);
    };
    const failed = await reply('1', ws);
    expect(failed.session.mergeRun?.awaiting).toBe('decision');
    expect(failed.text).toContain('PROJ-15');

    const asked = await reply('retry', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');
    await reply('1', ws);

    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['32']);
    expect(tickets['PROJ-15'].status).toBe('Closed');
  });

  it('ignore after a failed close lists the close as missing and counts the source as not merged', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    client.executeTransition = async () => { throw new Error('workflow refused'); };
    await reply('1', ws);
    const done = await reply('ignore', ws);
    expect(done.text).toMatch(/Still missing/);
    expect(done.text).toContain('PROJ-15');
    expect(done.session.outcomes?.mergeFailed).toBe(1);
    expect(done.session.outOfDate).toBe(true);
  });

  it('a second merge into the same survivor keeps the first source\'s components when the screens were not rebuilt', async () => {
    const { ws } = await importWaltz();
    await reply('A3 leave', ws); // a changed choice, so the screens are marked out of date instead of rebuilt
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    const first = await reply('1', ws);
    expect(first.session.outOfDate).toBe(true);

    await reply('merge PROJ-18 into PROJ-12 confirm', ws);
    await reply('1', ws);

    expect(tickets['PROJ-12'].description).toContain('libbar:2.0');
    expect(tickets['PROJ-12'].description).toContain('libbaz:3.0');
  });

  it('a workflow status named Cancelled is picked as a status, not read as cancelling the question', async () => {
    vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { graph: { Open: [{ id: '41', name: 'Cancel', to: 'Cancelled' }], Cancelled: [] } } } } as never);
    const { ws } = await importWaltz();
    const asked = await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');

    await reply('Cancelled', ws);

    expect(client.executeTransitionCalls.map(c => c.transitionId)).toEqual(['41']);
  });
});

describe('the survivor\'s Due Date (remediation dates, U3)', () => {
  const dated = (c: WaltzComponent, policyDate: string | null, plannedDate: string | null = null): WaltzComponent => ({
    ...c, remediation: { policyDate, plannedDate, planDeadline: null, planStatus: null, reportDate: '2026-10-22' },
  });

  it('is the earliest date over the combined group, and the source ticket\'s own Due Date is left alone', async () => {
    report = [dated(libfoo, '2026-12-31'), dated(libbar, '2026-11-30', '2026-12-15'), libbaz];
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    await reply('1', ws);

    const survivorWrite = client.updateIssueCalls.find(c => c.issueKey === 'PROJ-12')!;
    expect(survivorWrite.fields.duedate).toBe('2026-12-15');
    expect(client.updateIssueCalls.filter(c => c.issueKey === 'PROJ-15').every(c => !('duedate' in c.fields))).toBe(true);
  });

  it('sends no Due Date when no member has a date', async () => {
    const { ws } = await importWaltz();
    await reply('merge PROJ-15 into PROJ-12 confirm', ws);
    await reply('1', ws);
    expect(client.updateIssueCalls.every(c => !('duedate' in c.fields))).toBe(true);
  });
});
