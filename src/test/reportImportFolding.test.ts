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

import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import { buildChatCommandLink, type AwaitIssueTypeResume, type VeracodeReviewSession, type WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { sanitizeComponentLabel, type WaltzComponent, type WaltzVulnerability } from '../utils/waltzReport';
import { mockStream, markdownText, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

describe('Merge and unmerge through the real descriptors (finding folding, U4)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'SQL Injection', cweId: '89', cweName: null,
      description: 'Untrusted input reaches a query.', recommendation: null,
      module: 'app.jar', sourceFile: `File${issueId}.java`, sourceFilePath: 'src/main/java/',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }
  // Different file and CWE per flaw, so each stays its own New row under the automatic fold.
  const distinct = (id: number) => makeFlaw(String(id), { sourceFile: `Distinct${id}.java`, cweId: String(1000 + id) });

  let client: MockJiraClient;
  let ticketService: TicketService;
  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  async function importVeracode(flaws: VeracodeFlaw[], ws = makeMockWs()) {
    const tickets: Record<string, FakeTicket> = {};
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
    const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
      kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
    };
    await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);
    return { session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession, ws, tickets };
  }

  const reply = (text: string, session: VeracodeReviewSession, ws: ReturnType<typeof makeMockWs>, stream = mockStream()) =>
    handleVeracodeReviewReply(text, session, ticketService, stream as never, ws as never);

  const sqlA = () => makeFlaw('1', { sourceFile: 'A.java', cweId: '89', categoryName: 'SQL Injection' });
  const xssB = () => makeFlaw('2', { sourceFile: 'B.java', cweId: '79', categoryName: 'Cross-Site Scripting' });

  it('AE3: merge 1 2 combines two New rows into one row with a count-based title that names both CWEs and the extra file', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), makeFlaw('3', { sourceFile: 'C.java', cweId: '22' })]);
    expect(session.rows.filter(r => r.existingTicketKey === null)).toHaveLength(3);

    await reply('merge 1 2', session, ws);

    const fresh = session.rows.filter(r => r.existingTicketKey === null);
    expect(fresh.map(r => r.id)).toEqual(['1', '3']);
    expect(fresh[0].memberIds).toEqual(['1', '2']);
    expect(fresh[0].issueIds).toEqual(['1', '2']);
    expect(fresh[0].summary).toBe('A.java +1 file - 2 findings: SQL Injection, Cross-Site Scripting');
    expect(session.allRows).toHaveLength(3); // the originals stay in allRows (page-local merge)
  });

  it('a merged row whose ticket creation fails stays merged, so a retry creates one ticket, not one per member', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), makeFlaw('3', { sourceFile: 'C.java', cweId: '22' })]);
    await reply('merge 1 2', session, ws);
    const create = client.createIssue.bind(client);
    let fail = true;
    client.createIssue = async (...args: Parameters<typeof create>) => {
      if (fail && args[1].includes('2 findings')) throw new Error('boom');
      return create(...args);
    };

    await reply('create tickets', session, ws);
    const fresh = session.rows.filter(r => r.existingTicketKey === null);
    expect(fresh.map(r => r.id)).toEqual(['1']);
    expect(fresh[0].memberIds).toEqual(['1', '2']);
    expect(fresh[0].included).toBe(true);

    fail = false;
    client.createIssueCalls.length = 0;
    await reply('create tickets', session, ws);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].summary).toContain('2 findings');
  });

  it('the created count counts tickets, not the findings merged into them', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB()]);
    await reply('merge 1 2', session, ws);

    const stream = mockStream();
    await reply('create tickets', session, ws, stream);

    expect(streamText(stream)).toContain('**1** created');
  });

  it('creating the merged row makes one ticket carrying every member and removes all members from allRows', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), makeFlaw('3', { sourceFile: 'C.java', cweId: '22' })]);
    await reply('merge 1 2', session, ws);

    await reply('create tickets', session, ws);

    expect(client.createIssueCalls).toHaveLength(2); // the merged row and row 3
    const merged = client.createIssueCalls[0];
    expect(merged.summary).toBe('A.java +1 file - 2 findings: SQL Injection, Cross-Site Scripting');
    expect(merged.additionalFields!.labels).toEqual(expect.arrayContaining(['veracode', 'veracode-issue-1', 'veracode-issue-2', 'cwe-89', 'cwe-79']));
    expect(String(merged.additionalFields!.description)).toContain('This ticket folds 2 Veracode findings.');
    expect(session.allRows.filter(r => r.existingTicketKey === null)).toHaveLength(0);
  });

  it('a merged row that was excluded creates nothing and leaves both members excluded in allRows', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), makeFlaw('3', { sourceFile: 'C.java', cweId: '22' })]);
    await reply('merge 1 2', session, ws);
    await reply('1', session, ws); // toggle the merged row off

    await reply('create tickets', session, ws);

    expect(client.createIssueCalls).toHaveLength(1); // only row 3
    const left = session.allRows.filter(r => r.existingTicketKey === null);
    expect(left.map(r => r.id)).toEqual(['1', '2']);
    expect(left.every(r => r.included === false)).toBe(true);
  });

  it('a failed create leaves the member rows in allRows, so the refreshed page shows them separately again', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB()]);
    await reply('merge 1 2', session, ws);
    client.createIssue = async () => { throw new Error('boom'); };

    await reply('create tickets', session, ws);

    const left = session.allRows.filter(r => r.existingTicketKey === null);
    expect(left.map(r => r.id)).toEqual(['1', '2']);
    expect(left.every(r => r.memberIds === undefined)).toBe(true);
  });

  it('unmerge restores the original rows', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB()]);
    await reply('merge 1 2', session, ws);
    await reply('unmerge 1', session, ws);

    const fresh = session.rows.filter(r => r.existingTicketKey === null);
    expect(fresh.map(r => r.id)).toEqual(['1', '2']);
    expect(fresh.every(r => r.memberIds === undefined)).toBe(true);
  });

  it('moving to another page and back discards a merge (page-local)', async () => {
    const { session, ws } = await importVeracode(Array.from({ length: 60 }, (_, i) => distinct(i + 1)));
    await reply('merge 1 2', session, ws);
    expect(session.rows.filter(r => r.existingTicketKey === null).length).toBe(49);

    await reply('next', session, ws);
    await reply('prev', session, ws);

    const fresh = session.rows.filter(r => r.existingTicketKey === null);
    expect(fresh).toHaveLength(50);
    expect(fresh.every(r => r.memberIds === undefined)).toBe(true);
  });

  it('AE4: an id from another page is not merged and the reply says which row it could not use', async () => {
    const { session, ws } = await importVeracode(Array.from({ length: 60 }, (_, i) => distinct(i + 1)));
    const stream = mockStream();

    await reply('merge 3,55', session, ws, stream);

    expect(session.rows.filter(r => r.existingTicketKey === null)).toHaveLength(50);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map(c => markdownText(c[0])).join('\n');
    expect(text).toContain('Row 55');
  });

  it('AE5: merging Waltz components gives one row with the merged title, every component label and one rating label', async () => {
    const vuln = (cveId: string): WaltzVulnerability => ({ cveId, cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null });
    const comp = (nameVersion: string, rating: string): WaltzComponent => ({
      nameVersion, maxVulnRating: rating, remediationAction: 'Remediate', instancePaths: ['app.jar'], vulnerabilities: [vuln(`CVE-2099-${nameVersion.length}`)],
    });
    const tickets: Record<string, FakeTicket> = {};
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    const templateSession = await buildWaltzTemplateSession(
      [comp('netty-codec:4.1.100', 'High'), comp('netty-handler:4.1.100', 'High'), comp('netty-buffer:4.1.94', 'Medium')], 'r.xlsx', 'PROJ', client);
    const ws = makeMockWs();
    await handleWaltzAwaitIssueType({
      kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
    }, 'Bug', client, ticketService, mockStream() as never, ws as never);
    const session = ws.store['jira.session.waltzReview'] as WaltzReviewSession;

    await handleWaltzReviewReply('merge 1 2 3', session, ticketService, mockStream() as never, ws as never);
    await handleWaltzReviewReply('create tickets', session, ticketService, mockStream() as never, ws as never);

    expect(client.createIssueCalls).toHaveLength(1);
    const call = client.createIssueCalls[0];
    expect(call.summary).toBe('[OSS] netty-codec:4.1.100 +2 components — High');
    const labels = call.additionalFields!.labels as string[];
    expect(labels).toEqual(expect.arrayContaining([
      'oss-dependency', sanitizeComponentLabel('netty-codec:4.1.100'), sanitizeComponentLabel('netty-handler:4.1.100'), sanitizeComponentLabel('netty-buffer:4.1.94'),
    ]));
    expect(labels.filter(l => l.startsWith('oss-rating-'))).toEqual(['oss-rating-high']);
  });
});

describe('Add rows to an existing ticket through the real descriptors (finding folding, U5)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'SQL Injection', cweId: '89', cweName: null,
      description: 'Untrusted input reaches a query.', recommendation: null,
      module: 'app.jar', sourceFile: `File${issueId}.java`, sourceFilePath: 'src/main/java/',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }
  const sqlA = () => makeFlaw('1', { sourceFile: 'A.java', cweId: '89', categoryName: 'SQL Injection' });
  const xssB = () => makeFlaw('2', { sourceFile: 'B.java', cweId: '79', categoryName: 'Cross-Site Scripting' });
  const third = () => makeFlaw('3', { sourceFile: 'C.java', cweId: '22', categoryName: 'Path Traversal' });

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

  const text = (stream: ReturnType<typeof mockStream>) =>
    (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map(c => markdownText(c[0])).join('\n');

  const reply = async (replyText: string, session: VeracodeReviewSession, ws: ReturnType<typeof makeMockWs>) => {
    const stream = mockStream();
    await handleVeracodeReviewReply(replyText, session, ticketService, stream as never, ws as never);
    return stream;
  };

  const handMade = (): Record<string, FakeTicket> => ({ 'PROJ-123': { labels: ['security'], summary: 'Hand made', status: 'Open' } });
  const newRows = (s: VeracodeReviewSession) => s.allRows.filter(r => r.existingTicketKey === null).map(r => r.id);

  it('a bare add shows the ticket, the overwrite warning and both links, and writes nothing', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB()], handMade());

    const stream = await reply('add 1,2 to proj-123', session, ws);

    const shown = text(stream);
    expect(shown).toContain('PROJ-123');
    expect(shown).toContain('Hand made');
    expect(shown).toContain(buildChatCommandLink('Comment', '@jira', 'add 1,2 to PROJ-123 as comment'));
    expect(shown).toContain(buildChatCommandLink('Rewrite', '@jira', 'add 1,2 to PROJ-123 as rewrite'));
    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(newRows(session)).toEqual(['1', '2']);
  });

  it('adding rows from a long New list keeps the other pages reachable', async () => {
    const flaws = Array.from({ length: 60 }, (_, i) => makeFlaw(String(i + 1), { sourceFile: `F${i + 1}.java`, cweId: String(3000 + i) }));
    const { session, ws } = await importVeracode(flaws, handMade());
    expect(session.rows.filter(r => r.existingTicketKey === null)).toHaveLength(50);

    await reply('add 1,2 to PROJ-123 as comment', session, ws);

    // The two added rows left; rows 51 and 52 slid onto the first page.
    expect(session.rows.filter(r => r.existingTicketKey === null)).toHaveLength(50);
    expect(newRows(session)).toHaveLength(58);
    await reply('next', session, ws);
    expect(session.rows.filter(r => r.existingTicketKey === null)).toHaveLength(8);
  });

  it('as rewrite marks the unfinished rows already pointing at that ticket as done, so apply cannot write them again', async () => {
    const tickets: Record<string, FakeTicket> = {
      'PROJ-123': { labels: ['veracode', 'veracode-issue-9'], summary: 'Old', status: 'Open' },
    };
    const known = makeFlaw('9', { sourceFile: 'Z.java', cweId: '1' });
    const { session, ws } = await importVeracode([known, sqlA()], tickets);
    expect(session.allRows.filter(r => r.existingTicketKey === 'PROJ-123')).toHaveLength(1);

    await reply('open new', session, ws);
    await reply('add 1 to PROJ-123 as rewrite', session, ws);
    const ticketed = session.allRows.filter(r => r.existingTicketKey === 'PROJ-123');
    expect(ticketed.every(r => r.result?.status === 'done' && r.result.action === 'rewrite')).toBe(true);
    client.updateIssueCalls.length = 0;
    await reply('back', session, ws);
    await reply('apply', session, ws);
    expect(client.updateIssueCalls).toHaveLength(0);
  });

  it('AE6: as comment adds the record labels and one comment listing both findings, leaving summary and description alone', async () => {
    const tickets = handMade();
    const { session, ws } = await importVeracode([sqlA(), xssB(), third()], tickets);

    await reply('add 1,2 to PROJ-123 as comment', session, ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    const write = client.updateIssueCalls[0];
    expect(write.issueKey).toBe('PROJ-123');
    expect(write.fields.labels).toEqual(expect.arrayContaining(['security', 'veracode', 'veracode-issue-1', 'veracode-issue-2', 'cwe-89', 'cwe-79']));
    expect(write.fields).not.toHaveProperty('summary');
    expect(write.fields).not.toHaveProperty('description');
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-123');
    expect(client.addCommentCalls[0].body).toContain('A.java:42');
    expect(client.addCommentCalls[0].body).toContain('B.java:42');
    expect(tickets['PROJ-123'].summary).toBe('Hand made');
  });

  it('rows not named stay in New and no ticket other than the target is written (R17)', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), third()], handMade());

    await reply('add 1 to PROJ-123 as comment', session, ws);

    expect(newRows(session)).toEqual(['2', '3']);
    expect(client.updateIssueCalls.every(c => c.issueKey === 'PROJ-123')).toBe(true);
    expect(client.createIssueCalls).toHaveLength(0);
    expect(session.outcomes?.added).toBe(1);
  });

  it('AE7: as rewrite regenerates summary and description, keeps recorded labels, and the comment names a dropped finding', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-123': { labels: ['veracode', 'veracode-issue-9001'], summary: 'Old title', status: 'Open' } };
    const { session, ws } = await importVeracode([sqlA(), xssB()], tickets);

    const prompt = await reply('add 1 to PROJ-123', session, ws);
    expect(text(prompt)).toContain('9001');
    expect(client.updateIssueCalls).toHaveLength(0);

    await reply('add 1 to PROJ-123 as rewrite', session, ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    const write = client.updateIssueCalls[0].fields;
    expect(write.summary).toBe('1 - A.java:42 - SQL Injection');
    expect(String(write.description)).toContain('Issue 1');
    expect(write.labels).toEqual(expect.arrayContaining(['veracode', 'veracode-issue-9001', 'veracode-issue-1']));
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).toContain('No longer in the description');
    expect(client.addCommentCalls[0].body).toContain('9001');
  });

  it('a key that does not resolve shows an error, writes nothing and leaves the rows in New', async () => {
    const { session, ws } = await importVeracode([sqlA()], handMade());
    client.getIssue = async () => { throw new Error('Issue does not exist'); };

    const stream = await reply('add 1 to PROJ-404 as comment', session, ws);

    expect(text(stream)).toContain('PROJ-404');
    expect(text(stream)).toContain('Issue does not exist');
    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(newRows(session)).toEqual(['1']);
  });

  it('a resolved target shows a warning and still offers both links', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-9': { labels: [], summary: 'Done work', status: 'Done', resolution: { name: 'Fixed' } } };
    const { session, ws } = await importVeracode([sqlA()], tickets);

    const stream = await reply('add 1 to PROJ-9', session, ws);

    expect(text(stream)).toContain('resolved');
    expect(text(stream)).toContain(buildChatCommandLink('Comment', '@jira', 'add 1 to PROJ-9 as comment'));
    expect(text(stream)).toContain(buildChatCommandLink('Rewrite', '@jira', 'add 1 to PROJ-9 as rewrite'));
  });

  it('a ticket summary that looks like a chat command link is neutralized in the prompt', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-9': { labels: [], summary: '[click](command:workbench.action.chat.open)' } };
    const { session, ws } = await importVeracode([sqlA()], tickets);

    const stream = await reply('add 1 to PROJ-9', session, ws);

    expect(text(stream)).not.toContain('[click](command:');
  });

  it('a comment failure after a successful rewrite reports it and the rows still leave New', async () => {
    const { session, ws } = await importVeracode([sqlA()], handMade());
    client.addComment = async () => { throw new Error('comment blocked'); };

    const stream = await reply('add 1 to PROJ-123 as rewrite', session, ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(text(stream)).toContain('comment failed');
    expect(newRows(session)).toEqual([]);
  });

  it('a failed write posts no comment and keeps the rows in New', async () => {
    const { session, ws } = await importVeracode([sqlA()], handMade());
    client.updateIssue = async () => { throw new Error('forbidden'); };

    const stream = await reply('add 1 to PROJ-123 as rewrite', session, ws);

    expect(client.addCommentCalls).toHaveLength(0);
    expect(text(stream)).toContain('forbidden');
    expect(newRows(session)).toEqual(['1']);
    expect(session.outcomes?.addFailed).toBe(1);
  });

  it('an id that is not a New row on the page is rejected and nothing is fetched or written', async () => {
    const { session, ws } = await importVeracode([sqlA()], handMade());
    const spy = vi.spyOn(client, 'getIssue');

    await reply('add 5 to PROJ-123 as comment', session, ws);

    expect(spy).not.toHaveBeenCalled();
    expect(client.updateIssueCalls).toHaveLength(0);
  });

  it('adding a merged row records every member and lists all of them in the comment', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), third()], handMade());
    await reply('merge 1 2', session, ws);

    await reply('add 1 to PROJ-123 as comment', session, ws);

    expect(client.updateIssueCalls[0].fields.labels).toEqual(expect.arrayContaining(['veracode-issue-1', 'veracode-issue-2']));
    expect(client.addCommentCalls[0].body).toContain('These 2 Veracode findings were added to this ticket.');
    expect(newRows(session)).toEqual(['3']);
  });

  describe('Waltz rating label', () => {
    const vuln = (cveId: string): WaltzVulnerability => ({ cveId, cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null });
    const comp = (nameVersion: string, rating: string): WaltzComponent => ({
      nameVersion, maxVulnRating: rating, remediationAction: 'Remediate', instancePaths: ['app.jar'], vulnerabilities: [vuln('CVE-2099-1')],
    });

    async function importWaltz(tickets: Record<string, FakeTicket>) {
      statefulJira(client, tickets);
      searchFromStore(ticketService, tickets);
      const templateSession = await buildWaltzTemplateSession([comp('netty-codec:4.1.100', 'High')], 'r.xlsx', 'PROJ', client);
      const ws = makeMockWs();
      await handleWaltzAwaitIssueType({
        kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
      }, 'Bug', client, ticketService, mockStream() as never, ws as never);
      return { session: ws.store['jira.session.waltzReview'] as WaltzReviewSession, ws };
    }

    it('Comment adds component and CVE labels but leaves an existing rating label alone', async () => {
      const { session, ws } = await importWaltz({ 'PROJ-5': { labels: ['oss-rating-medium'], summary: 'Hand made' } });

      await handleWaltzReviewReply('add 1 to PROJ-5 as comment', session, ticketService, mockStream() as never, ws as never);

      const labels = client.updateIssueCalls[0].fields.labels as string[];
      expect(labels).toEqual(expect.arrayContaining(['oss-rating-medium', 'oss-dependency', sanitizeComponentLabel('netty-codec:4.1.100'), 'oss-cve-cve-2099-1']));
      expect(labels).not.toContain('oss-rating-high');
    });

    it('Rewrite replaces the rating label with the highest rating of what it rebuilt', async () => {
      const { session, ws } = await importWaltz({ 'PROJ-5': { labels: ['oss-rating-medium'], summary: 'Hand made' } });

      await handleWaltzReviewReply('add 1 to PROJ-5 as rewrite', session, ticketService, mockStream() as never, ws as never);

      const labels = client.updateIssueCalls[0].fields.labels as string[];
      expect(labels).toContain('oss-rating-high');
      expect(labels).not.toContain('oss-rating-medium');
      expect(client.updateIssueCalls[0].fields.summary).toBe('[OSS] netty-codec:4.1.100 — High');
    });
  });
});

describe('Rewrite on the Already-ticketed screen through the real descriptors (finding folding, U6)', () => {
  function makeFlaw(issueId: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
    return {
      issueId, severity: 4, categoryName: 'SQL Injection', cweId: '89', cweName: null,
      description: 'Untrusted input reaches a query.', recommendation: null,
      module: 'app.jar', sourceFile: `File${issueId}.java`, sourceFilePath: 'src/main/java/',
      line: 42, scope: null, functionPrototype: null, remediationStatus: 'New',
      ...overrides,
    };
  }
  const sqlA = () => makeFlaw('1', { sourceFile: 'A.java', cweId: '89', categoryName: 'SQL Injection' });
  const xssB = () => makeFlaw('2', { sourceFile: 'B.java', cweId: '79', categoryName: 'Cross-Site Scripting' });
  const pathC = () => makeFlaw('3', { sourceFile: 'C.java', cweId: '22', categoryName: 'Path Traversal' });

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
  const text = (stream: ReturnType<typeof mockStream>) =>
    (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map(c => markdownText(c[0])).join('\n');
  const reply = async (replyText: string, session: VeracodeReviewSession, ws: ReturnType<typeof makeMockWs>) => {
    const stream = mockStream();
    await handleVeracodeReviewReply(replyText, session, ticketService, stream as never, ws as never);
    return stream;
  };
  const merged = (): Record<string, FakeTicket> => ({
    'PROJ-123': { labels: ['veracode', 'veracode-issue-1', 'veracode-issue-2', 'veracode-issue-3'], summary: 'Merged by hand', status: 'Open' },
  });

  it('every Already-ticketed row offers rewrite, and it is not the default', async () => {
    const { session } = await importVeracode([sqlA(), xssB(), pathC()], merged());
    expect(session.allRows).toHaveLength(3);
    for (const row of session.allRows) {
      expect(row.allowedActions).toContain('rewrite');
      expect(row.action).toBe('leave');
    }
  });

  it('AE9: rewrite on only some rows of one ticket stops the whole apply, writes nothing and names the rows left out', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), pathC()], merged());
    await reply('A1 rewrite', session, ws);
    await reply('A3 rewrite', session, ws);

    const stream = await reply('apply', session, ws);

    expect(client.updateIssueCalls).toHaveLength(0);
    expect(client.addCommentCalls).toHaveLength(0);
    const shown = text(stream);
    expect(shown).toContain('PROJ-123');
    expect(shown).toContain('A2');
    expect(shown.toLowerCase()).toContain('all');
    expect(session.allRows.every(r => r.result === undefined)).toBe(true);
  });

  it('all rewrite rebuilds the ticket once from every row that points to it and records the result on each row', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), pathC()], merged());
    await reply('all rewrite', session, ws);

    await reply('apply', session, ws);

    expect(client.updateIssueCalls).toHaveLength(1);
    const write = client.updateIssueCalls[0];
    expect(write.issueKey).toBe('PROJ-123');
    expect(String(write.fields.summary)).toBe('A.java +2 files - 3 findings: SQL Injection, Cross-Site Scripting, Path Traversal');
    expect(String(write.fields.description)).toContain('This ticket folds 3 Veracode findings.');
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].body).toContain('no findings were added');
    expect(session.allRows.every(r => r.result?.status === 'done' && r.result.action === 'rewrite')).toBe(true);
    expect(session.outcomes?.rewritten).toBe(1);
  });

  it('the traceability comment lists only the findings the ticket did not record yet', async () => {
    // Flaws 1 and 3 share a file and CWE, so they are one row; only flaw 1 is recorded on PROJ-123.
    const tickets: Record<string, FakeTicket> = { 'PROJ-123': { labels: ['veracode', 'veracode-issue-1', 'veracode-issue-2'], summary: 'Old', status: 'Open' } };
    const flaws = [sqlA(), xssB(), makeFlaw('3', { sourceFile: 'A.java', cweId: '89', line: 77 })];
    const { session, ws } = await importVeracode(flaws, tickets);
    await reply('all rewrite', session, ws);

    await reply('apply', session, ws);

    expect(client.addCommentCalls).toHaveLength(1);
    const body = client.addCommentCalls[0].body;
    expect(body).toContain('|3|');
    expect(body).not.toContain('|1|');
    expect(client.updateIssueCalls[0].fields.labels).toEqual(expect.arrayContaining(['veracode-issue-3']));
  });

  it('rows of one ticket are never split by the per-reply cap: the second ticket waits for the next apply', async () => {
    const flaws = Array.from({ length: 60 }, (_, i) => makeFlaw(String(i + 1), { sourceFile: `F${i + 1}.java`, cweId: String(2000 + i) }));
    const tickets: Record<string, FakeTicket> = {
      'PROJ-1': { labels: ['veracode', ...flaws.slice(0, 30).map(f => `veracode-issue-${f.issueId}`)], summary: 'First', status: 'Open', created: '2026-01-01T09:00:00.000+0000' },
      'PROJ-2': { labels: ['veracode', ...flaws.slice(30).map(f => `veracode-issue-${f.issueId}`)], summary: 'Second', status: 'Open', created: '2026-01-02T09:00:00.000+0000' },
    };
    const { session, ws } = await importVeracode(flaws, tickets);
    await reply('all rewrite', session, ws);

    const first = await reply('apply', session, ws);
    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(text(first)).toContain('30 remain');

    await reply('apply', session, ws);
    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('a single ticket whose rewrite covers more rows than the per-reply cap still runs whole', async () => {
    const flaws = Array.from({ length: 55 }, (_, i) => makeFlaw(String(i + 1), { sourceFile: `F${i + 1}.java`, cweId: String(2000 + i) }));
    const tickets: Record<string, FakeTicket> = {
      'PROJ-1': { labels: ['veracode', ...flaws.map(f => `veracode-issue-${f.issueId}`)], summary: 'Everything', status: 'Open', created: '2026-01-01T09:00:00.000+0000' },
    };
    const { session, ws } = await importVeracode(flaws, tickets);
    await reply('all rewrite', session, ws);

    const stream = await reply('apply', session, ws);

    expect(client.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(session.allRows.filter(r => r.existingTicketKey !== null).every(r => r.result?.status === 'done')).toBe(true);
    expect(text(stream)).not.toContain('remain');
  });

  it('a row already finished by update is outside the all-or-none set, and its findings still go into the rewrite', async () => {
    const tickets: Record<string, FakeTicket> = { 'PROJ-123': { labels: ['veracode', 'veracode-issue-1', 'veracode-issue-2'], summary: 'Old', status: 'Open' } };
    const flaws = [sqlA(), xssB(), makeFlaw('3', { sourceFile: 'A.java', cweId: '89', line: 77 })];
    const { session, ws } = await importVeracode(flaws, tickets);
    expect(session.allRows.find(r => r.id === 'A1')?.action).toBe('update');
    await reply('update tickets', session, ws);
    expect(session.allRows.find(r => r.id === 'A1')?.result?.status).toBe('done');
    client.updateIssueCalls.length = 0;
    client.addCommentCalls.length = 0;

    await reply('A2 rewrite', session, ws);
    const stream = await reply('apply', session, ws);

    expect(text(stream)).not.toContain('must cover');
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(String(client.updateIssueCalls[0].fields.description)).toContain('Issue 3');
  });

  it('a failed rewrite is recorded on its rows, posts no comment and can be retried', async () => {
    const { session, ws } = await importVeracode([sqlA(), xssB(), pathC()], merged());
    await reply('all rewrite', session, ws);
    client.updateIssue = async () => { throw new Error('forbidden'); };

    await reply('apply', session, ws);

    expect(client.addCommentCalls).toHaveLength(0);
    expect(session.allRows.every(r => r.result?.status === 'failed')).toBe(true);
    expect(session.outcomes?.rewriteFailed).toBe(1);
  });

  it('Waltz: rewriting a ticket two components were merged into rebuilds it with the merged title and both labels', async () => {
    const vuln = (cveId: string): WaltzVulnerability => ({ cveId, cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null });
    const comp = (nameVersion: string): WaltzComponent => ({
      nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['app.jar'], vulnerabilities: [vuln('CVE-2099-1')],
    });
    const a = comp('netty-codec:4.1.100');
    const b = comp('netty-handler:4.1.100');
    const tickets: Record<string, FakeTicket> = {
      'PROJ-7': { labels: ['oss-dependency', sanitizeComponentLabel(a.nameVersion), sanitizeComponentLabel(b.nameVersion), 'oss-cve-cve-2099-1', 'oss-rating-high'], summary: 'Merged', status: 'Open' },
    };
    statefulJira(client, tickets);
    searchFromStore(ticketService, tickets);
    const templateSession = await buildWaltzTemplateSession([a, b], 'r.xlsx', 'PROJ', client);
    const ws = makeMockWs();
    await handleWaltzAwaitIssueType({
      kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
    }, 'Bug', client, ticketService, mockStream() as never, ws as never);
    const session = ws.store['jira.session.waltzReview'] as WaltzReviewSession;

    await handleWaltzReviewReply('all rewrite', session, ticketService, mockStream() as never, ws as never);
    await handleWaltzReviewReply('apply', session, ticketService, mockStream() as never, ws as never);

    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.summary).toBe('[OSS] netty-codec:4.1.100 +1 component — High');
    expect(String(client.updateIssueCalls[0].fields.description)).toContain('This ticket folds 2 components');
  });
});
