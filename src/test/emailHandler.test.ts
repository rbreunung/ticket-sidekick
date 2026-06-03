import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: (key: string, defaultVal?: unknown) => {
        if (key === 'jira.baseUrl') return 'https://jira.example.com';
        if (key === 'email.deleteEmlAfterImport') return false;
        return defaultVal ?? null;
      },
    })),
  },
  window: { showOpenDialog: vi.fn() },
}));

import {
  buildEmailJiraWiki,
  buildEmailCommentHeader,
  addEmailAsComment,
  finishEmailTicket,
  streamEmailCommentPreview,
  handleEmailContentSession,
} from '../participant/jira/emailHandler';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { EmailContentSession } from '../participant/sessionState';

function makeSession(overrides: Partial<EmailContentSession> = {}): EmailContentSession {
  return {
    emailId: 'eml-import',
    subject: 'Test Subject',
    senderName: 'Alice',
    receivedDateTime: '2024-05-01T10:00:00Z',
    markdownBody: 'Hello **world**',
    inlineImageMap: {},
    attachments: [],
    selectedTemplateName: null,
    projectKey: 'PROJ',
    issueType: 'Bug',
    additionalFields: {},
    ...overrides,
  };
}

const mockStream = () => ({ markdown: vi.fn() });

function makeMockWs(initial: Record<string, unknown> = {}): { get: <T>(k: string, d?: T) => T | undefined; update: (k: string, v: unknown) => Promise<void>; keys: () => readonly string[]; store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string, defaultValue?: T) => (key in store ? store[key] as T : defaultValue),
    update: async (key: string, value: unknown) => { store[key] = value; },
    keys: () => Object.keys(store) as readonly string[],
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

  it('replaces multiple placeholders', () => {
    const result = buildEmailJiraWiki('[📎 img1.png] and [📎 img2.jpg]');
    expect(result).toContain('!img1.png|thumbnail!');
    expect(result).toContain('!img2.jpg|thumbnail!');
  });

  it('collapses 3+ consecutive blank lines to 1 blank line', () => {
    const input = 'paragraph one\n\n\n\nparagraph two';
    const result = buildEmailJiraWiki(input);
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('paragraph one');
    expect(result).toContain('paragraph two');
  });
});

describe('buildEmailCommentHeader', () => {
  it('builds From · Date header when both present', () => {
    const h = buildEmailCommentHeader('Alice', '2024-05-01T10:00:00Z');
    expect(h).toBe('*From:* Alice  ·  *Date:* 2024-05-01\n\n');
  });

  it('builds header with only sender', () => {
    const h = buildEmailCommentHeader('Alice', undefined);
    expect(h).toBe('*From:* Alice\n\n');
  });

  it('returns empty string when both absent', () => {
    expect(buildEmailCommentHeader()).toBe('');
  });

  it('slices date to YYYY-MM-DD', () => {
    const h = buildEmailCommentHeader(undefined, '2024-12-31T23:59:59Z');
    expect(h).toBe('*Date:* 2024-12-31\n\n');
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
    await addEmailAsComment('PROJ-1', session, ticketService, stream);

    expect(client.addCommentCalls).toHaveLength(1);
    const body = client.addCommentCalls[0].body;
    expect(body).toContain('*From:* Alice');
    expect(body).toContain('*Date:* 2024-05-01');
    expect(body).toContain('Body text');
  });

  it('converts [📎 img] placeholder in comment body', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'See [📎 screenshot.png]' });
    await addEmailAsComment('PROJ-1', session, ticketService, stream);

    const body = client.addCommentCalls[0].body;
    expect(body).toContain('!screenshot.png|thumbnail!');
    expect(body).not.toContain('[📎');
  });

  it('uploads all attachments including inline ones', async () => {
    const stream = mockStream();
    const session = makeSession({
      attachments: [
        { name: 'inline.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
        { name: 'report.pdf', contentType: 'application/pdf', contentBytes: 'bbb=', isInline: false },
      ],
    });
    await addEmailAsComment('PROJ-1', session, ticketService, stream);

    expect(client.uploadAttachmentCalls).toHaveLength(2);
    const names = client.uploadAttachmentCalls.map(c => c.filename);
    expect(names).toContain('inline.png');
    expect(names).toContain('report.pdf');
  });

  it('reports upload count in stream output', async () => {
    const stream = mockStream();
    const session = makeSession({
      attachments: [
        { name: 'img.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
      ],
    });
    await addEmailAsComment('PROJ-1', session, ticketService, stream);

    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((c: unknown) => typeof c === 'string' && c.includes('1 of 1'))).toBe(true);
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
    await addEmailAsComment('PROJ-1', session, ticketService, stream);

    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Warning') && c.includes('fail.png'))).toBe(true);
    // Should still report 1 uploaded
    expect(calls.some(c => c.includes('1 of 2'))).toBe(true);
  });

  it('appends jira-ticket marker to stream', async () => {
    const stream = mockStream();
    const session = makeSession();
    await addEmailAsComment('PROJ-99', session, ticketService, stream);

    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('<!-- @jira-ticket:PROJ-99 -->'))).toBe(true);
  });
});

describe('finishEmailTicket', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('uploads all attachments including inline images', async () => {
    const stream = mockStream();
    const session = makeSession({
      attachments: [
        { name: 'inline.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
        { name: 'report.pdf', contentType: 'application/pdf', contentBytes: 'bbb=', isInline: false },
      ],
    });
    await finishEmailTicket(session, ticketService, stream);

    expect(client.uploadAttachmentCalls).toHaveLength(2);
    const names = client.uploadAttachmentCalls.map(c => c.filename);
    expect(names).toContain('inline.png');
    expect(names).toContain('report.pdf');
  });

  it('converts [📎 img] placeholder in description', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'See [📎 diagram.png]' });
    await finishEmailTicket(session, ticketService, stream);

    expect(client.createIssueCalls).toHaveLength(1);
    const desc = client.createIssueCalls[0].additionalFields?.description as string;
    expect(desc).toContain('!diagram.png|thumbnail!');
    expect(desc).not.toContain('[📎');
  });

  it('reports upload failures as warnings without aborting', async () => {
    const stream = mockStream();
    let callCount = 0;
    client.uploadAttachment = async () => {
      callCount++;
      if (callCount === 1) throw new Error('quota exceeded');
    };
    ticketService = new TicketService(client);

    const session = makeSession({
      attachments: [
        { name: 'fail.png', contentType: 'image/png', contentBytes: 'aaa=', isInline: true },
        { name: 'ok.pdf', contentType: 'application/pdf', contentBytes: 'bbb=', isInline: false },
      ],
    });
    await finishEmailTicket(session, ticketService, stream);

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
    expect(text).not.toContain('Description preview:');
  });

  it('includes the target ticket key in the prompt', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailCommentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('PROJ-42');
  });

  it('includes the From/Date/Subject header', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailCommentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('Alice');
    expect(text).toContain('2024-05-01');
    expect(text).toContain('Test Subject');
  });

  it('appends <!-- jira:email-content --> marker', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailCommentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('<!-- jira:email-content -->');
  });

  it('saves session to workspaceState with pendingCommentTicketKey set', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailCommentPreview(session, stream as never, ws as never);
    const stored = ws.store['jira.session.emailContent'] as typeof session;
    expect(stored.pendingCommentTicketKey).toBe('PROJ-42');
  });
});

describe('handleEmailContentSession — pending comment', () => {
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
    await handleEmailContentSession('post it', session, ticketService, stream as never, ws as never, client);
    expect(client.addCommentCalls).toHaveLength(1);
    expect(client.addCommentCalls[0].issueKey).toBe('PROJ-42');
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('cancellation clears session without posting comment', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('c', session, ticketService, stream as never, ws as never, client);
    expect(client.addCommentCalls).toHaveLength(0);
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('ticket key reply updates target key and re-shows comment preview without posting', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('OTHER-7', session, ticketService, stream as never, ws as never, client);
    expect(client.addCommentCalls).toHaveLength(0);
    const stored = ws.store['jira.session.emailContent'] as typeof session;
    expect(stored.pendingCommentTicketKey).toBe('OTHER-7');
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Comment preview:'))).toBe(true);
    expect(calls.some(c => c.includes('OTHER-7'))).toBe(true);
  });

  it('unrecognized input re-shows comment preview without posting', async () => {
    const session = makeSession({ pendingCommentTicketKey: 'PROJ-42' });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('random text', session, ticketService, stream as never, ws as never, client);
    expect(client.addCommentCalls).toHaveLength(0);
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Comment preview:'))).toBe(true);
  });
});
