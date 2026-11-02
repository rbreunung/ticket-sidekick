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

import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import { type AwaitIssueTypeResume, type VeracodeReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText } from './helpers/reportImportHarness';

// `help` and the help printed after a refused reply, through the real review handler (Veracode review).

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
  const result = await handleVeracodeReviewReply(text, session, ticketService, stream as never, ws as never);
  return { text: streamText(stream), session: ws.store['jira.session.veracodeReview'] as VeracodeReviewSession, result };
}

const ticketed: Record<string, FakeTicket> = {
  'PROJ-7': { labels: ['veracode', 'veracode-issue-101', 'cwe-89'], summary: 'OrderRepository.java - SQL Injection', status: 'Open' },
};
const flaws = () => [flaw('101', 'OrderRepository.java'), flaw('201', 'Billing.java', { cweId: '79', cweName: 'XSS' })];

describe('help on a review', () => {
  it('prints the New screen help and leaves the session as it was', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    const before = JSON.stringify(opened.session);

    const out = await reply('help', opened.session, ws);

    expect(out.text).toContain('**Help — New screen**');
    expect(out.text).toContain('search netty');
    expect(JSON.stringify(out.session)).toBe(before);
    expect(out.result).toMatchObject({ metadata: { jiraSession: { kinds: [expect.any(String)] } } });
  });

  it('prints the help of whichever screen the session is on', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const overview = await reply('help', session, ws);
    expect(overview.text).toContain('**Help — Overview**');
    expect(overview.text).toContain('open new');

    const opened = await reply('open already ticketed', overview.session, ws);
    const out = await reply('help', opened.session, ws);
    expect(out.text).toContain('**Help — Already ticketed screen**');
    expect(out.session.view).toBe('ticketed');
  });

  it('keeps a Veracode review free of the accept words', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);
    expect((await reply('help', opened.session, ws)).text).not.toContain('accept');
  });
});

describe('a refused reply prints the screen help', () => {
  it('quotes what was typed when nothing was recognized, then prints the help', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);

    const out = await reply('2x', opened.session, ws);

    expect(out.text.startsWith("Didn't understand `2x`.")).toBe(true);
    expect(out.text).toContain('**Help — New screen**');
    expect(out.session.view).toBe('new');
  });

  it('gives the specific reason, not a quote, when the parser has one', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);

    const out = await reply('merge 1 99', opened.session, ws);

    expect(out.text).toMatch(/^Row 99 isn't a New row on this page/);
    expect(out.text).not.toContain("Didn't understand");
    expect(out.text).toContain('**Help — New screen**');
  });

  it('keeps pasted link syntax inside the code span', async () => {
    const { session, ws } = await importVeracode(flaws(), ticketed);
    const opened = await reply('open new', session, ws);

    const out = await reply('[x](command:workbench.action.chat.open)', opened.session, ws);

    expect(out.text.split('\n\n')[0]).toBe("Didn't understand `[x](command:workbench.action.chat.open)`.");
  });
});
