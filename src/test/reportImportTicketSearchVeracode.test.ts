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
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: vi.fn() }); }),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import { handleImportReviewReply } from '../participant/jira/reportImportHandler';
import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { type AwaitIssueTypeResume, type VeracodeReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { descriptor as genericDescriptor, mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

// Import ticket search on a Veracode review (the Waltz path is covered in reportImportTicketSearch.test.ts) and the
// email-style importer (no dedup) that must not get the new replies.

const flaw = (issueId: string, sourceFile: string, overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw => ({
  issueId, severity: 4, categoryName: 'Category', cweId: '89', cweName: 'SQL Injection',
  description: 'Untrusted input reaches a query.', recommendation: null,
  module: 'app.jar', sourceFile, sourceFilePath: `src/main/java/${sourceFile}`,
  line: Number(issueId), scope: null, functionPrototype: null, remediationStatus: 'New',
  ...overrides,
});

let client: MockJiraClient;
let ticketService: TicketService;
beforeEach(() => {
  client = new MockJiraClient();
  ticketService = new TicketService(client);
});

async function importVeracode(flaws: VeracodeFlaw[], tickets: Record<string, FakeTicket>) {
  const ws = makeMockWs();
  statefulJira(client, tickets);
  searchFromStore(ticketService, tickets);
  const templateSession = await buildVeracodeTemplateSession(flaws, 'report.xml', 'PROJ', client);
  const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
    kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
  };
  await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, mockStream() as never, ws as never);
  return { session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession, ws };
}

async function reply(text: string, session: VeracodeReviewSession, ws: ReturnType<typeof makeMockWs>) {
  const stream = mockStream();
  await handleVeracodeReviewReply(text, session, ticketService, stream as never, ws as never);
  return { text: streamText(stream), session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession };
}

const ticketed: Record<string, FakeTicket> = {
  'PROJ-7': { labels: ['veracode', 'veracode-issue-101', 'cwe-89'], summary: 'OrderRepository.java - SQL Injection', status: 'Open' },
};
const flaws = () => [flaw('101', 'OrderRepository.java'), flaw('201', 'Billing.java', { cweId: '79', cweName: 'XSS' })];

describe('search on a Veracode review (import ticket search)', () => {
  it('finds a class name inside a ticket summary and shows its A id', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open already ticketed', session, ws);

    const out = await reply('search repository', opened.session, ws);

    expect(out.text).toContain('PROJ-7');
    expect(out.text).toContain('A1');
    expect(out.text).toContain('OrderRepository.java - SQL Injection');
    expect(out.session.view).toBe('ticketed');
  });

  it('keeps the session as it was', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const before = JSON.stringify(opened.session);

    const out = await reply('search repository', opened.session, ws);

    expect(JSON.stringify(out.session)).toBe(before);
  });

  it('does not list a resolved ticket', async () => {
    const tickets = { 'PROJ-7': { ...ticketed['PROJ-7'], resolution: { name: 'Done' } } };
    const { session, ws } = await importVeracode(flaws(), tickets);
    const opened = await reply('open new', session, ws);
    const out = await reply('search repository', opened.session, ws);
    expect(out.text).toMatch(/No open tickets/);
  });

  it('a hostile ticket summary leaves no clickable command link in the results', async () => {
    const cmd = 'command:workbench.action.chat.open?%7B%22query%22%3A%22%40jira%20done%22%7D';
    const tickets = { 'PROJ-7': { ...ticketed['PROJ-7'], summary: `OrderRepository <${cmd}> [x](${cmd})\n# Heading` } };
    const { session, ws } = await importVeracode(flaws(), tickets);
    const opened = await reply('open new', session, ws);

    const out = await reply('search orderrepository', opened.session, ws);

    // The follow-up line carries real command links (Show); only the result lines hold Jira text.
    const resultLines = out.text.split('\n').filter(l => l.startsWith('- '));
    expect(resultLines).toHaveLength(1);
    expect(resultLines[0]).toContain('PROJ-7');
    expect(resultLines[0]).not.toMatch(/\]\(command:/);
    expect(resultLines[0]).not.toMatch(/(^|[^\\])<command:/);
    expect(out.text).not.toMatch(/\n# Heading/);
  });

  it('a session whose ticket info is present but empty says nothing matched', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    opened.session.ticketInfo = {};
    const out = await reply('search repository', opened.session, ws);
    expect(out.text).toMatch(/No open tickets/);
    expect(out.text).not.toContain('reload report');
  });

  it('does not list a ticket whose row finished as a ticket merge', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const row = opened.session.allRows.find(r => r.existingTicketKey !== null)!;
    row.result = { status: 'done', action: 'merge', into: 'PROJ-1' };

    const out = await reply('search repository', opened.session, ws);

    expect(out.text).toMatch(/No open tickets/);
  });

  it('an extra open ticket of a row is listed by key alone, never under the row\'s A id', async () => {
    const tickets: Record<string, FakeTicket> = {
      'PROJ-7': { labels: ['veracode', 'veracode-issue-101'], summary: 'OrderRepository.java - SQL Injection', status: 'Open', created: '2026-02-01T09:00:00.000+0000' },
      'PROJ-8': { labels: ['veracode', 'veracode-issue-101'], summary: 'Older duplicate for OrderRepository', status: 'Open', created: '2026-01-01T09:00:00.000+0000' },
    };
    const { session, ws } = await importVeracode(flaws(), tickets);
    const opened = await reply('open new', session, ws);

    const out = await reply('search orderrepository', opened.session, ws);

    const lines = out.text.split('\n');
    expect(lines.find(l => l.includes('PROJ-7'))).toContain('A1');
    expect(lines.find(l => l.includes('PROJ-8'))).not.toMatch(/\bA\d/);
  });
});

describe('merge … into <ticket> on a Veracode review (import ticket search)', () => {
  it('a New row goes to the ticket behind an A id: the add prompt shows that ticket and writes nothing', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const writes = client.updateIssueCalls.length;

    const out = await reply('merge 1 into A1', opened.session, ws);

    const text = decodeURIComponent(out.text);
    expect(text).toContain('PROJ-7');
    expect(text).toMatch(/as comment/i);
    expect(text).toMatch(/as rewrite/i);
    expect(client.updateIssueCalls).toHaveLength(writes);
  });

  it('an A id the review does not have is refused with the reason', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const out = await reply('merge 1 into A9', opened.session, ws);
    expect(out.text).toContain('A9');
    expect(out.text).toMatch(/no ticket to merge into/);
  });

  it('plain merge still combines New rows', async () => {
    const { session, ws } = await importVeracode([flaw('301', 'A.java'), flaw('302', 'B.java', { cweId: '79' })], {});
    const opened = await reply('open new', session, ws);
    const out = await reply('merge 1 2', opened.session, ws);
    expect(out.session.rows).toHaveLength(1);
    expect(out.session.rows[0].memberIds).toHaveLength(2);
  });
});

describe('show on every screen of a Veracode review (import ticket search)', () => {
  it('re-prints the overview', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const out = await reply('show', session, ws);
    expect(out.session.view).toBe('overview');
    expect(out.text).toMatch(/Already ticketed/);
  });

  it('re-prints the Already ticketed screen', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open already ticketed', session, ws);
    const out = await reply('show', opened.session, ws);
    expect(out.session.view).toBe('ticketed');
    expect(out.text).toContain('PROJ-7');
  });
});

describe('an importer without dedup (email) does not get the new replies (import ticket search)', () => {
  const emailLike = { ...genericDescriptor, dedupKeyOf: undefined, searchLabelOf: undefined, labelToDedupKey: undefined };

  async function replyAsEmail(text: string) {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const stream = mockStream();
    await handleImportReviewReply(text, opened.session, ticketService, stream as never, ws as never, emailLike as never);
    return streamText(stream);
  }

  it.each(['search repository', 'show', 'merge 1 into A1'])('"%s" is not understood', async (text) => {
    expect(await replyAsEmail(text)).toMatch(/Didn't understand/);
  });
});
