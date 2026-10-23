// Veracode ticket merge, close mode (duplicate-open-tickets plan, U3/U4): the whole `merge … into …` run against a
// stateful fake Jira — the confirmation, the steps in order, the link type, the comment and the close.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const workspace = vi.hoisted(() => ({ dir: undefined as string | undefined }));
const sla = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return workspace.dir ? [{ uri: { fsPath: workspace.dir } }] : undefined; },
    getConfiguration: vi.fn(() => ({ get: (key: string) => (key === 'veracode.slaDays' ? sla.value : undefined) })),
  },
  window: { showInputBox: vi.fn(), showOpenDialog: vi.fn(), showWarningMessage: vi.fn(), createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
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

vi.mock('../utils/veracodeReport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/veracodeReport')>()),
  parseVeracodeReport: vi.fn(),
}));

import { buildVeracodeTemplateSession, handleVeracodeAwaitIssueType, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { loadWorkflowCache } from '../services/WorkflowService';
import { parseVeracodeReport, type VeracodeFlaw } from '../utils/veracodeReport';
import type { VeracodeReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

function flaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
  return {
    issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
    description: 'Untrusted input reaches a query.', recommendation: null,
    module: 'app.jar', sourceFile: 'Foo.java', sourceFilePath: 'src/Foo.java',
    line: 10, scope: null, functionPrototype: null, remediationStatus: 'New',
    ...overrides,
  };
}

const GRAPH = {
  Open: [{ id: '31', name: 'Close', to: 'Closed' }],
  Closed: [] as Array<{ id: string; name: string; to: string }>,
};

let dir: string;
let reportPath: string;
let report: VeracodeFlaw[];
let client: MockJiraClient;
let ticketService: TicketService;
let tickets: Record<string, FakeTicket>;
let log: string[];
let existingLinks: Array<[string, string, string?]>;
let comments: Record<string, string[]>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmerge-'));
  workspace.dir = dir;
  reportPath = join(dir, 'r.xml');
  writeFileSync(reportPath, '<placeholder/>');
  // Flaws 101 and 102 share a file and CWE, so they fold into one row; 103 is a row of its own.
  sla.value = undefined;
  report = [flaw('101'), flaw('102', { line: 20, firstFoundDate: '2026-01-01' }), flaw('103', { sourceFile: 'Bar.java', sourceFilePath: 'src/Bar.java', cweId: '79', cweName: 'XSS' })];
  vi.mocked(parseVeracodeReport).mockReset();
  vi.mocked(parseVeracodeReport).mockImplementation((() => report) as never);
  vi.mocked(loadWorkflowCache).mockReset();
  vi.mocked(loadWorkflowCache).mockReturnValue({ PROJ: { Bug: { graph: GRAPH } } } as never);
  client = new MockJiraClient();
  ticketService = new TicketService(client);
  tickets = {
    // The row for flaws 101+102 matches both; PROJ-1 is created later, so it is the target.
    'PROJ-1': { labels: ['veracode', 'veracode-issue-101'], summary: 'Foo ticket', status: 'Open', created: '2026-05-01T09:00:00.000+0000' },
    'PROJ-2': { labels: ['veracode', 'veracode-issue-101'], summary: 'Foo older ticket', status: 'Open', created: '2026-01-01T09:00:00.000+0000' },
  };
  log = [];
  existingLinks = [];
  comments = {};
});
afterEach(() => { workspace.dir = undefined; rmSync(dir, { recursive: true, force: true }); });

function fakeJira() {
  statefulJira(client, tickets);
  const getIssue = client.getIssue;
  client.getIssue = async key => {
    const issue = await getIssue(key);
    issue.fields.issuetype = { id: '1', name: 'Bug' } as never;
    issue.fields.description = tickets[key]?.description as never;
    issue.fields.issuelinks = existingLinks.filter(([a]) => a === key).map(([, b, type], i) => ({
      id: String(i), type: { name: type ?? 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, outwardIssue: { key: b, fields: { summary: '', status: { name: 'Open' } } },
    }));
    return issue;
  };
  const updateIssue = client.updateIssue;
  client.updateIssue = async (key, fields) => { log.push(`rewrite:${key}`); return updateIssue(key, fields); };
  const addComment = client.addComment.bind(client);
  client.addComment = async (key, body) => { log.push(`comment:${key}`); (comments[key] ??= []).push(body); return addComment(key, body); };
  client.getAllComments = async key => (comments[key] ?? []).map((body, i) => ({ id: String(i), author: {} as never, body, created: '2026-10-21' }));
  const createIssueLink = client.createIssueLink.bind(client);
  client.createIssueLink = async (inward, outward, type) => { await createIssueLink(inward, outward, type); existingLinks.push([outward, inward]); log.push(`link:${outward}:${type}`); };
  client.executeTransition = async (key, id, fields) => {
    client.executeTransitionCalls.push({ issueKey: key, transitionId: id, fields });
    log.push(`close:${key}`);
    tickets[key].status = 'Closed';
    tickets[key].resolution = fields?.resolution ? { name: (fields.resolution as { name: string }).name } : null;
  };
  searchFromStore(ticketService, tickets);
}

async function importVeracode() {
  fakeJira();
  const templateSession = await buildVeracodeTemplateSession(report, 'r.xml', 'PROJ', client, report);
  templateSession.reportFilePath = reportPath;
  const ws = makeMockWs();
  await handleVeracodeAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, mockStream() as never, ws as never);
  return { ws, session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession };
}

const reply = async (text: string, ws: ReturnType<typeof makeMockWs>) => {
  const stream = mockStream();
  const session = ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
  await handleVeracodeReviewReply(text, session, ticketService, stream as never, ws as never);
  return { text: streamText(stream), session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession };
};

describe('the Ticket cell on a Veracode row with two open tickets', () => {
  it('Covers AE2: names the other open ticket and offers merge', async () => {
    const { ws } = await importVeracode();
    const out = await reply('open already ticketed', ws);
    expect(out.text).toContain('PROJ-1 · also open: PROJ-2');
    expect(out.text).toContain('merge');
  });

  it('Covers AE1: shows no extra ticket once the other one is closed', async () => {
    tickets['PROJ-2'].resolution = { name: 'Done' };
    tickets['PROJ-2'].status = 'Closed';
    const { ws } = await importVeracode();
    const out = await reply('open already ticketed', ws);
    expect(out.text).not.toContain('also open');
  });
});

describe('the confirmation', () => {
  it('Covers AE3: says nothing moves, shows both tickets and writes nothing', async () => {
    const { ws } = await importVeracode();
    const out = await reply('merge PROJ-2 into PROJ-1', ws);
    expect(out.text).toContain('PROJ-1');
    expect(out.text).toContain('PROJ-2');
    expect(out.text).toMatch(/stays as it is/);
    expect(log).toEqual([]);
  });

  it('Covers AE4: names the flaws that would move', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
    const { ws } = await importVeracode();
    const out = await reply('merge PROJ-2 into PROJ-1', ws);
    expect(out.text).toMatch(/also records 1 flaw \(102\)/);
    expect(log).toEqual([]);
  });

  it('Covers AE5: names a flaw the report no longer lists as not moved', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-999'];
    const { ws } = await importVeracode();
    const out = await reply('merge PROJ-2 into PROJ-1', ws);
    expect(out.text).toMatch(/999 is no longer in the report/);
  });

  it('warns that a rebuild will stop showing a flaw the kept ticket records but the report no longer lists', async () => {
    tickets['PROJ-1'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-998'];
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
    const { ws } = await importVeracode();
    const out = await reply('merge PROJ-2 into PROJ-1', ws);
    expect(out.text).toMatch(/stop showing 998/);
  });
});

describe('running the merge', () => {
  it('Covers AE3: with nothing to move, links as Duplicate, comments on the source and closes it — the kept ticket is untouched', async () => {
    const { ws } = await importVeracode();
    const asked = await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');

    const done = await reply('1', ws);

    expect(log).toEqual(['link:PROJ-2:Duplicate', 'comment:PROJ-2', 'close:PROJ-2']);
    expect(client.updateIssueCalls).toEqual([]);
    expect(client.createIssueLinkCalls).toEqual([{ inwardKey: 'PROJ-1', outwardKey: 'PROJ-2', typeName: 'Duplicate' }]);
    expect(comments['PROJ-2'][0]).toContain('h4. Merged into PROJ-1');
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-2', transitionId: '31', fields: { resolution: { name: 'Duplicate' } } }]);
    expect(tickets['PROJ-2'].summary).toBe('Foo older ticket');
    expect(done.session.mergeRun).toBeUndefined();
  });

  it('Covers AE4: with flaws to move, rebuilds the kept ticket first, links as Relates, then comments and closes', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    await reply('1', ws);

    expect(log).toEqual(['rewrite:PROJ-1', 'link:PROJ-2:Relates', 'comment:PROJ-2', 'close:PROJ-2']);
    expect(tickets['PROJ-1'].labels).toEqual(expect.arrayContaining(['veracode-issue-101', 'veracode-issue-102']));
    expect(tickets['PROJ-2'].summary).toBe('Foo older ticket');
  });

  it('Covers AE5: does not move a flaw the report no longer lists, and names it in the comment', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-999'];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    await reply('1', ws);

    expect(log).toEqual(['link:PROJ-2:Duplicate', 'comment:PROJ-2', 'close:PROJ-2']);
    expect(comments['PROJ-2'][0]).toContain('Not copied (no longer in the report): 999.');
    expect(tickets['PROJ-1'].labels).not.toContain('veracode-issue-999');
  });

  describe('Due Date on the kept ticket (SLA policy: High = 28 days)', () => {
    beforeEach(() => {
      sla.value = { 'Very High': 7, High: 28, Medium: 90, Low: 180 };
      tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
    });

    it('keeps an earlier Due Date when the moved flaw is due later', async () => {
      tickets['PROJ-1'].duedate = '2026-01-10';
      const { ws } = await importVeracode();
      await reply('merge PROJ-2 into PROJ-1 confirm', ws);
      await reply('1', ws);
      const rewrite = client.updateIssueCalls.find(c => c.issueKey === 'PROJ-1');
      expect(rewrite).toBeDefined();
      expect(rewrite!.fields).not.toHaveProperty('duedate');
    });

    it('moves the Due Date earlier when the moved flaw is due sooner (first found 2026-01-01 + 28 days)', async () => {
      tickets['PROJ-1'].duedate = '2027-01-31';
      const { ws } = await importVeracode();
      await reply('merge PROJ-2 into PROJ-1 confirm', ws);
      await reply('1', ws);
      expect(client.updateIssueCalls.find(c => c.issueKey === 'PROJ-1')!.fields.duedate).toBe('2026-01-29');
    });
  });

  it('marks the source row merged and counts the merge', async () => {
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    const out = await reply('1', ws);
    expect(out.session.outcomes?.merged).toBe(1);
    expect(out.text).toContain('PROJ-2');
  });

  it('a comment that fails stops the run with retry and ignore; retry repeats only that step', async () => {
    const { ws } = await importVeracode();
    const addComment = client.addComment.bind(client);
    client.addComment = async () => { throw new Error('Comment refused'); };
    const failed = await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    expect(failed.session.mergeRun?.awaiting).toBe('decision');
    expect(failed.text).toContain('Comment refused');
    expect(log).toEqual(['link:PROJ-2:Duplicate']);

    client.addComment = addComment;
    await reply('retry', ws);
    await reply('1', ws);
    expect(log).toEqual(['link:PROJ-2:Duplicate', 'comment:PROJ-2', 'close:PROJ-2']);
  });

  it('a replayed confirmation neither links nor comments twice', async () => {
    existingLinks = [['PROJ-2', 'PROJ-1']];
    comments['PROJ-2'] = ['h4. Merged into PROJ-1\nThis ticket was closed and merged into PROJ-1. Its items are tracked there.'];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    await reply('1', ws);
    expect(client.createIssueLinkCalls).toEqual([]);
    expect(log).toEqual(['close:PROJ-2']);
  });

  it('a replay does not add a second link of another type when the two tickets are already linked', async () => {
    existingLinks = [['PROJ-2', 'PROJ-1', 'Relates']];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    await reply('1', ws);
    expect(client.createIssueLinkCalls).toEqual([]);
    expect(log).toEqual(['comment:PROJ-2', 'close:PROJ-2']);
  });

  it('a confirm link clicked again while the merge waits is not read as a new merge', async () => {
    const { ws } = await importVeracode();
    const asked = await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');
    const writesBefore = [...log];

    const again = await reply('merge PROJ-2 into PROJ-1 confirm', ws);

    expect(again.text).toMatch(/Didn't understand/);
    expect(again.session.mergeRun?.awaiting).toBe('target');
    expect(log).toEqual(writesBefore);
  });

  it('without a Duplicate link type, links as Relates and says so', async () => {
    client.getIssueLinkTypes = async () => [{ name: 'Relates', inward: 'relates to', outward: 'relates to' }];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    const out = await reply('1', ws);
    expect(log[0]).toBe('link:PROJ-2:Relates');
    expect(out.text).toMatch(/linked as Relates \(no Duplicate link type\)/);
  });
});

describe('when a step does not take effect', () => {
  beforeEach(() => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
  });

  it('Covers AE4: ignoring a failed rebuild of the kept ticket does not link, comment on or close a source whose flaws never moved', async () => {
    const { ws } = await importVeracode();
    client.updateIssue = async () => { throw new Error('Field refused'); };
    const failed = await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    expect(failed.session.mergeRun?.awaiting).toBe('decision');

    const done = await reply('ignore', ws);

    expect(log).toEqual([]);
    expect(client.executeTransitionCalls).toEqual([]);
    expect(done.session.mergeRun).toBeUndefined();
    expect(done.session.outcomes?.merged).toBe(0);
    expect(done.session.outcomes?.mergeFailed).toBe(1);
    expect(done.text).toMatch(/Still missing/);
    expect(done.text).toContain('PROJ-2');
    expect(done.session.allRows.every(r => r.result?.status !== 'done' || r.result.action !== 'merge')).toBe(true);
  });

  it('still closes a source that has nothing to move when the rebuild is ignored', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101'];
    tickets['PROJ-4'] = { labels: ['veracode', 'veracode-issue-101', 'veracode-issue-102'], summary: 'Foo oldest', status: 'Open', created: '2025-12-01T09:00:00.000+0000' };
    const { ws } = await importVeracode();
    client.updateIssue = async () => { throw new Error('Field refused'); };
    await reply('merge PROJ-2 PROJ-4 into PROJ-1 confirm', ws);
    await reply('ignore', ws);
    await reply('1', ws);
    expect(log).toEqual(['link:PROJ-2:Duplicate', 'comment:PROJ-2', 'close:PROJ-2']);
  });

  it('Stopping at the status question leaves the source open, and its comment does not claim it is closed', async () => {
    const { ws } = await importVeracode();
    const asked = await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    expect(asked.session.mergeRun?.awaiting).toBe('target');

    const stopped = await reply('cancel', ws);

    expect(log).toEqual(['rewrite:PROJ-1', 'link:PROJ-2:Relates', 'comment:PROJ-2']);
    expect(comments['PROJ-2'][0]).not.toMatch(/closed/i);
    expect(stopped.session.outcomes?.merged).toBe(0);
    expect(tickets['PROJ-2'].status).toBe('Open');
  });
});

describe('items the report still lists but the kept ticket is not rebuilt from', () => {
  beforeEach(() => {
    // Flaw 103 is on the source and on a newer third ticket, so its row targets PROJ-3, not PROJ-1 or PROJ-2.
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-103'];
    tickets['PROJ-3'] = { labels: ['veracode', 'veracode-issue-103'], summary: 'Bar ticket', status: 'Open', created: '2026-06-01T09:00:00.000+0000' };
  });

  it('Covers AE5: the confirmation and the comment say the flaw is still in the report, and it is not moved', async () => {
    const { ws } = await importVeracode();
    const prompt = await reply('merge PROJ-2 into PROJ-1', ws);
    expect(prompt.text).toMatch(/103 is still in the report but not part of PROJ-1's rows/);
    expect(prompt.text).not.toMatch(/no longer in the report/);

    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    await reply('1', ws);

    expect(comments['PROJ-2'][0]).toContain("Not copied (still in the report, but not part of PROJ-1's rows): 103.");
    expect(tickets['PROJ-1'].labels).not.toContain('veracode-issue-103');
  });
});

describe('several sources and link-type fallbacks', () => {
  it('Covers AE3/AE4: one rebuild, Duplicate for the source with nothing to move and Relates for the one with flaws to move', async () => {
    tickets['PROJ-4'] = { labels: ['veracode', 'veracode-issue-101', 'veracode-issue-102'], summary: 'Foo oldest', status: 'Open', created: '2025-12-01T09:00:00.000+0000' };
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 PROJ-4 into PROJ-1 confirm', ws);
    await reply('1', ws);

    expect(log).toEqual([
      'rewrite:PROJ-1', 'link:PROJ-2:Duplicate', 'comment:PROJ-2', 'link:PROJ-4:Relates', 'comment:PROJ-4', 'close:PROJ-2', 'close:PROJ-4',
    ]);
  });

  it('with flaws to move but no Relates link type, links as Duplicate and says so', async () => {
    tickets['PROJ-2'].labels = ['veracode', 'veracode-issue-101', 'veracode-issue-102'];
    client.getIssueLinkTypes = async () => [{ name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }];
    const { ws } = await importVeracode();
    await reply('merge PROJ-2 into PROJ-1 confirm', ws);
    const out = await reply('1', ws);
    expect(log).toContain('link:PROJ-2:Duplicate');
    expect(out.text).toMatch(/linked as Duplicate \(no Relates link type\)/);
  });
});

describe('where merge works on Veracode', () => {
  it('the New screen answers the ticket form of merge with a pointer to the overview', async () => {
    tickets = {};
    const { ws, session } = await importVeracode();
    expect(session.allRows.every(r => r.existingTicketKey === null)).toBe(true);

    const merge = await reply('merge PROJ-2 into PROJ-1', ws);

    expect(merge.text).toMatch(/overview or the Already ticketed screen/);
    expect(log).toEqual([]);
  });

  it('reload report is offered, because merge is on', async () => {
    const { ws } = await importVeracode();
    const out = await reply('back', ws);
    expect(out.text.toLowerCase()).toContain('reload report');
  });
});
