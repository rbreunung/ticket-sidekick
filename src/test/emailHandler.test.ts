import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: (key: string, defaultVal?: unknown) => {
        if (key === 'jira.baseUrl') return 'https://jira.example.com';
        if (key === 'jira.defaultProject') return 'PROJ';
        if (key === 'email.deleteEmlAfterImport') return false;
        return defaultVal ?? null;
      },
    })),
  },
  window: {
    showOpenDialog: vi.fn(),
    showInputBox: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(() => ({
    loadTemplates: vi.fn(),
  })),
}));

import * as vscode from 'vscode';
import {
  buildEmailJiraWiki,
  buildEmailCommentHeader,
  addEmailAsComment,
  streamEmailCommentPreview,
  handleEmailContentSession,
  handleCreateFromEmail,
  handleAddEmailFromChat,
  handleEmailTemplateSelection,
  handleEmailReviewReply,
  handleEmailAwaitIssueType,
  checkEmailBatchCaps,
} from '../participant/jira/emailHandler';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { EmailContentSession, AwaitIssueTypeResume, EmailTemplateSelectionSession } from '../participant/sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from '../participant/jira/ticketContext';

const FIXTURE = path.resolve(process.cwd(), 'src/test/fixtures/eml/sample.eml');

function makeSession(overrides: Partial<EmailContentSession> = {}): EmailContentSession {
  return {
    emailId: 'eml-import',
    subject: 'Test Subject',
    senderName: 'Alice',
    receivedDateTime: '2024-05-01T10:00:00Z',
    markdownBody: 'Hello **world**',
    inlineImageMap: {},
    attachments: [],
    ...overrides,
  };
}

const mockStream = () => ({ markdown: vi.fn() });

function makeMockWs(initial: Record<string, unknown> = {}): { get: <T>(k: string, d?: T) => T | undefined; update: (k: string, v: unknown) => Promise<void>; store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string, defaultValue?: T) => (key in store ? store[key] as T : defaultValue),
    update: async (key: string, value: unknown) => { store[key] = value; },
  };
}

describe('buildEmailJiraWiki', () => {
  it('converts markdown to Jira Wiki markup', () => {
    const result = buildEmailJiraWiki('Hello **world**');
    expect(result).toContain('world');
  });

  it('replaces [📎 filename] placeholders with Jira thumbnail syntax', () => {
    const result = buildEmailJiraWiki('See [📎 screenshot.png] for details');
    expect(result).toContain('!screenshot.png|thumbnail!');
    expect(result).not.toContain('[📎');
  });

  it('collapses 3+ consecutive blank lines to 1 blank line', () => {
    const input = 'paragraph one\n\n\n\nparagraph two';
    const result = buildEmailJiraWiki(input);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('sanitizes a crafted attachment filename containing a Jira-native "!" trigger', () => {
    const result = buildEmailJiraWiki('See [📎 evil!.gif] for details');
    expect(result).toContain('!evil.gif|thumbnail!');
    expect(result.match(/!/g)).toHaveLength(2);
  });
});

describe('buildEmailCommentHeader', () => {
  it('builds From · Date header when both present', () => {
    const h = buildEmailCommentHeader('Alice', '2024-05-01T10:00:00Z');
    expect(h).toBe('*From:* Alice  ·  *Date:* 2024-05-01\n\n');
  });

  it('returns empty string when both absent', () => {
    expect(buildEmailCommentHeader()).toBe('');
  });

  it('sanitizes a crafted sender name containing Jira-native trigger characters', () => {
    const h = buildEmailCommentHeader('Evil{color}HACKED{color}!', undefined);
    expect(h).toBe('*From:* EvilcolorHACKEDcolor\n\n');
    expect(h).not.toContain('{');
  });
});

describe('addEmailAsComment', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('posts comment with From/Date header and body', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'Body text' });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    expect(client.addCommentCalls).toHaveLength(1);
    const body = client.addCommentCalls[0].body;
    expect(body).toContain('*From:* Alice');
    expect(body).toContain('Body text');
  });

  it('uploads all attachments including inline ones', async () => {
    const stream = mockStream();
    const session = makeSession({
      attachments: [
        { name: 'inline.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
        { name: 'report.pdf', contentType: 'application/pdf', contentBytes: 'bbb=', isInline: false },
      ],
    });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    expect(client.uploadAttachmentCalls).toHaveLength(2);
  });

  it('continues uploading remaining attachments when one fails', async () => {
    const stream = mockStream();
    let callCount = 0;
    client.uploadAttachment = async () => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
    };
    ticketService = new TicketService(client);

    const session = makeSession({
      attachments: [
        { name: 'fail.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
        { name: 'ok.pdf', contentType: 'application/pdf', contentBytes: 'bbb=', isInline: false },
      ],
    });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Warning') && c.includes('fail.png'))).toBe(true);
    expect(calls.some(c => c.includes('1 of 2'))).toBe(true);
  });
});

describe('streamEmailCommentPreview', () => {
  it('renders "Comment preview:" label (not "Description preview:")', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailCommentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('Comment preview:');
  });

  it('includes the target ticket key and returns email-content session metadata', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    const result = await streamEmailCommentPreview(session, stream as never, ws as never);
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => {
      const arg = c[0];
      return typeof arg === 'string' ? arg : (arg as { value: string }).value;
    });
    expect(calls.some(c => c.includes('PROJ-42'))).toBe(true);
    expect(result.metadata?.jiraSession?.kinds).toEqual(['email-content']);
  });
});

describe('handleEmailContentSession — comment-attach flow (only remaining consumer)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('confirmation posts comment to stored key and clears session', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('post it', session, ticketService, stream as never, ws as never);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-42');
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('cancellation clears session without posting comment', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('c', session, ticketService, stream as never, ws as never);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('ticket key reply updates target key and re-shows comment preview without posting', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('OTHER-7', session, ticketService, stream as never, ws as never);
    expect(client.addCommentCalls).toHaveLength(0);
    const stored = ws.store['jira.session.emailContent'] as typeof session;
    expect(stored.pendingCommentTicketKey).toBe('OTHER-7');
  });

  it('unrecognized input re-shows comment preview without posting', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('random text', session, ticketService, stream as never, ws as never);
    expect(client.addCommentCalls).toHaveLength(0);
  });
});

describe('checkEmailBatchCaps', () => {
  it('passes when under both caps', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1024 } as never);
    const uris = [{ fsPath: 'a.eml' }, { fsPath: 'b.eml' }] as vscode.Uri[];
    const result = await checkEmailBatchCaps(uris);
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it('rejects when the file count exceeds the batch limit', async () => {
    const uris = Array.from({ length: 51 }, (_, i) => ({ fsPath: `f${i}.eml` })) as vscode.Uri[];
    const result = await checkEmailBatchCaps(uris);
    expect(result).toContain('51 files');
    expect(result).toContain('batch limit is 50');
  });

  it('rejects when the total attachment size exceeds the aggregate cap', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 100 * 1024 * 1024 } as never);
    const uris = [{ fsPath: 'a.eml' }, { fsPath: 'b.eml' }] as vscode.Uri[];
    const result = await checkEmailBatchCaps(uris);
    expect(result).toContain('200.0 MB');
    expect(result).toContain('150 MB');
    vi.restoreAllMocks();
  });
});

describe('handleCreateFromEmail (batch, U1-U3)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockReset();
  });

  it('no session and file picker cancelled → nothing streamed', async () => {
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('selecting one file streams the template-selection screen with exactly one item (Covers AE1)', async () => {
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue([{ fsPath: FIXTURE }]);
    const stream = mockStream();
    const ws = makeMockWs();
    const result = await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const session = ws.store['jira.session.emailTemplateSelection'] as EmailTemplateSelectionSession;
    expect(session.items).toHaveLength(1);
    expect(session.items[0].subject).toBe('Test Email Subject');
    expect(result?.metadata?.jiraSession?.kinds).toEqual(['email-template']);
  });

  it('selecting three files builds a session with three items', async () => {
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue([{ fsPath: FIXTURE }, { fsPath: FIXTURE }, { fsPath: FIXTURE }]);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const session = ws.store['jira.session.emailTemplateSelection'] as EmailTemplateSelectionSession;
    expect(session.items).toHaveLength(3);
  });

  it('a file that fails to parse is reported and excluded — the rest still build the session', async () => {
    const badPath = path.join(path.dirname(FIXTURE), 'does-not-exist.eml');
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue([{ fsPath: FIXTURE }, { fsPath: badPath }]);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Could not import 1 file'))).toBe(true);
    const session = ws.store['jira.session.emailTemplateSelection'] as EmailTemplateSelectionSession;
    expect(session.items).toHaveLength(1);
  });

  it('selecting more files than the batch cap is rejected before any parsing (Covers AE4)', async () => {
    const uris = Array.from({ length: 51 }, () => ({ fsPath: FIXTURE }));
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue(uris);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('batch limit is 50'))).toBe(true);
    expect(ws.store['jira.session.emailTemplateSelection']).toBeUndefined();
  });

  it('an existing session resumes the template-selection screen without re-prompting the file picker', async () => {
    const existing: EmailTemplateSelectionSession = {
      reportFileName: '1 file', projectKey: 'PROJ', items: [], availableTemplates: [], availableIssueTypes: ['Bug'], schemaVersion: 2,
    };
    const ws = makeMockWs({ 'jira.session.emailTemplateSelection': existing });
    const stream = mockStream();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('handleAddEmailFromChat', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockReset();
  });

  it('with a ticket key in the prompt: single file, unchanged comment-attach flow', async () => {
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue([{ fsPath: FIXTURE }]);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleAddEmailFromChat(
      { prompt: 'add email to PROJ-42' } as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const showOpenDialogArgs = (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mock.calls[0][0] as { canSelectMany: boolean };
    expect(showOpenDialogArgs.canSelectMany).toBe(false);
    const session = ws.store['jira.session.emailContent'] as EmailContentSession;
    expect(session.pendingCommentTicketKey).toBe('PROJ-42');
  });

  it('with no ticket key: batch ticket-creation flow, multi-select', async () => {
    (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mockResolvedValue([{ fsPath: FIXTURE }, { fsPath: FIXTURE }]);
    const stream = mockStream();
    const ws = makeMockWs();
    await handleAddEmailFromChat(
      { prompt: 'add email' } as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const showOpenDialogArgs = (vscode.window.showOpenDialog as ReturnType<typeof vi.fn>).mock.calls[0][0] as { canSelectMany: boolean };
    expect(showOpenDialogArgs.canSelectMany).toBe(true);
    const session = ws.store['jira.session.emailTemplateSelection'] as EmailTemplateSelectionSession;
    expect(session.items).toHaveLength(2);
  });
});

describe('batch email creation (U3/U4, via the shared reportImportHandler flow)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  function makeTemplateSession(overrides: Partial<EmailTemplateSelectionSession> = {}): EmailTemplateSelectionSession {
    return {
      reportFileName: '2 selected file(s)',
      projectKey: 'PROJ',
      items: [
        { subject: 'Email One', senderName: 'Alice', markdownBody: 'Body one', inlineImageMap: {}, attachments: [], emlFilePath: '/a.eml' },
        { subject: 'Email Two', senderName: 'Bob', markdownBody: 'Body two', inlineImageMap: {}, attachments: [], emlFilePath: '/b.eml' },
      ],
      availableTemplates: [],
      availableIssueTypes: ['Bug', 'Story'],
      schemaVersion: 2,
      ...overrides,
    };
  }

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('picking an issue type skips the dedup search entirely (KTD2) and streams the review screen', async () => {
    const searchSpy = vi.spyOn(client, 'searchJql');
    const session = makeTemplateSession();
    const stream = mockStream();
    const ws = makeMockWs();
    const result = await handleEmailTemplateSelection('1', session, client, ticketService, stream as never, ws as never);

    expect(searchSpy).not.toHaveBeenCalled();
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
    expect(result?.metadata?.jiraSession?.kinds).toEqual(['email-review']);
    expect(text).toContain('Email One');
    expect(text).toContain('Email Two');
  });

  it('confirming the review creates one ticket per included row, using the subject as summary (Covers R5)', async () => {
    const templateSession = makeTemplateSession();
    const ws = makeMockWs();
    await handleEmailTemplateSelection('1', templateSession, client, ticketService, mockStream() as never, ws as never);
    const reviewSession = ws.store['jira.session.emailReview'];
    const stream = mockStream();

    await handleEmailReviewReply('post it', reviewSession as never, ticketService, stream as never, ws as never, 'https://jira.example.com');

    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.createIssueCalls.map(c => c.summary)).toEqual(['Email One', 'Email Two']);
    expect(client.createIssueCalls[0].additionalFields?.description).toContain('Body one');
  });

  it('uploads each row\'s attachments after creating its ticket (KTD4 afterCreate hook)', async () => {
    const templateSession = makeTemplateSession({
      items: [{ subject: 'With attachment', senderName: 'Alice', markdownBody: 'Body', inlineImageMap: {}, emlFilePath: '/a.eml', attachments: [
        { name: 'report.pdf', contentType: 'application/pdf', contentBytes: 'YWJj', isInline: false },
      ] }],
    });
    const ws = makeMockWs();
    await handleEmailTemplateSelection('1', templateSession, client, ticketService, mockStream() as never, ws as never);
    const reviewSession = ws.store['jira.session.emailReview'];

    await handleEmailReviewReply('post it', reviewSession as never, ticketService, mockStream() as never, ws as never, 'https://jira.example.com');

    expect(client.uploadAttachmentCalls).toHaveLength(1);
    expect(client.uploadAttachmentCalls[0].filename).toBe('report.pdf');
  });

  it('one row\'s ticket creation failing does not stop the others (Covers AE3, R6)', async () => {
    let calls = 0;
    client.createIssue = async () => {
      calls++;
      if (calls === 1) throw new Error('Jira is down');
      return { id: '10200', key: 'PROJ-200' };
    };
    ticketService = new TicketService(client);

    const templateSession = makeTemplateSession();
    const ws = makeMockWs();
    await handleEmailTemplateSelection('1', templateSession, client, ticketService, mockStream() as never, ws as never);
    const reviewSession = ws.store['jira.session.emailReview'];
    const stream = mockStream();

    await handleEmailReviewReply('post it', reviewSession as never, ticketService, stream as never, ws as never, 'https://jira.example.com');

    const summaryLine = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(summaryLine).toContain('1** created, 1 failed');
    expect(summaryLine).toContain('Email One');
  });

  it('excluding a row on the review screen keeps it out of the created batch (Covers AE2)', async () => {
    const templateSession = makeTemplateSession();
    const ws = makeMockWs();
    await handleEmailTemplateSelection('1', templateSession, client, ticketService, mockStream() as never, ws as never);
    const reviewSession = ws.store['jira.session.emailReview'];

    await handleEmailReviewReply('2', reviewSession as never, ticketService, mockStream() as never, ws as never); // toggle row 2 off
    const toggled = ws.store['jira.session.emailReview'];
    await handleEmailReviewReply('post it', toggled as never, ticketService, mockStream() as never, ws as never, 'https://jira.example.com');

    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].summary).toBe('Email One');
  });
});

describe('handleEmailAwaitIssueType (R6/KTD4 resume via the shared reportImport descriptorKind)', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  function makeSentinelSession(): EmailTemplateSelectionSession {
    return {
      reportFileName: '1 file', projectKey: 'PROJ',
      items: [{ subject: 'Needs a type', senderName: 'Alice', markdownBody: 'Body', inlineImageMap: {}, attachments: [], emlFilePath: '/a.eml' }],
      availableTemplates: [], availableIssueTypes: [''], schemaVersion: 2,
    };
  }

  function makeResume(session: EmailTemplateSelectionSession): Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> {
    return { kind: 'reportImport', descriptorKind: 'email', pickedTemplateName: null, session };
  }

  it('resumes normally into the review flow when not superseded', async () => {
    const ws = makeMockWs();
    await handleEmailAwaitIssueType(makeResume(makeSentinelSession()), 'Task', client, ticketService, mockStream() as never, ws as never);
    const reviewSession = ws.store['jira.session.emailReview'] as { issueType: string };
    expect(reviewSession.issueType).toBe('Task');
  });

  it('aborts instead of creating a batch when a newer email import session was written while the ask was open', async () => {
    const ws = makeMockWs();
    ws.store['jira.session.emailTemplateSelection'] = makeSentinelSession();
    const stream = mockStream();

    await handleEmailAwaitIssueType(makeResume(makeSentinelSession()), 'Task', client, ticketService, stream as never, ws as never);

    expect(client.createIssueCalls).toHaveLength(0);
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('newer email import was started'))).toBe(true);
  });
});
