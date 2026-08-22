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
  window: {
    showOpenDialog: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
}));

import {
  buildEmailJiraWiki,
  buildEmailCommentHeader,
  addEmailAsComment,
  finishEmailTicket,
  streamEmailCommentPreview,
  streamEmailContentPreview,
  handleEmailContentSession,
  handleCreateFromEmail,
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

  it('sanitizes a crafted attachment filename containing a Jira-native "!" trigger', () => {
    // Unsanitized, the captured filename's own "!" would combine with the template's delimiters
    // to form a second, live !url! image-embed trigger (`!evil!.gif|thumbnail!`) instead of one
    // well-formed embed — exactly two "!" characters (the template's own delimiters) must survive.
    const result = buildEmailJiraWiki('See [📎 evil!.gif] for details');
    expect(result).toContain('!evil.gif|thumbnail!');
    expect(result.match(/!/g)).toHaveLength(2);
  });

  it('sanitizes a crafted attachment filename containing a "|" (Jira image-attribute delimiter)', () => {
    // Unsanitized, an extra "|" in the filename injects a second delimiter into the !name|thumbnail!
    // template, letting the attacker append/alter Jira image attributes (e.g. align, border) —
    // exactly one "|" (the template's own delimiter) must survive.
    const result = buildEmailJiraWiki('See [📎 report|malicious.pdf] for details');
    expect(result).toContain('!report/malicious.pdf|thumbnail!');
    expect(result.match(/\|/g)).toHaveLength(1);
  });

  it('leaves a normal filename with no trigger characters unchanged', () => {
    const result = buildEmailJiraWiki('See [📎 screenshot.png] for details');
    expect(result).toContain('!screenshot.png|thumbnail!');
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

  it('sanitizes a crafted sender name containing Jira-native trigger characters', () => {
    // Unsanitized, an attacker-controlled "From" display name like "Evil{color}HACKED{color}!"
    // would inject live Jira macro/image-embed markup directly into the comment header.
    const h = buildEmailCommentHeader('Evil{color}HACKED{color}!', undefined);
    expect(h).toBe('*From:* EvilcolorHACKEDcolor\n\n');
    expect(h).not.toContain('{');
    expect(h).not.toContain('}');
  });

  it('sanitizes a crafted sender name containing "|" without breaking the bold delimiters', () => {
    const h = buildEmailCommentHeader('Alice|Bob', undefined);
    expect(h).toBe('*From:* Alice/Bob\n\n');
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
    expect(body).toContain('*Date:* 2024-05-01');
    expect(body).toContain('Body text');
  });

  it('links the ticket key in the confirmation when a baseUrl is passed', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'Body text' });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('[PROJ-1](https://jira.example.com/browse/PROJ-1)');
  });

  it('converts [📎 img] placeholder in comment body', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'See [📎 screenshot.png]' });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    const body = client.addCommentCalls[0].body;
    expect(body).toContain('!screenshot.png|thumbnail!');
    expect(body).not.toContain('[📎');
  });

  it('sanitizes a crafted sender name so it does not survive as live Jira markup in the posted comment', async () => {
    const stream = mockStream();
    const session = makeSession({ senderName: 'Evil{color}HACKED{color}!', markdownBody: 'Body text' });
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    const body = client.addCommentCalls[0].body;
    expect(body).toContain('*From:* EvilcolorHACKEDcolor');
    expect(body).not.toContain('{color}');
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
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

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
    await addEmailAsComment('PROJ-1', session, ticketService, stream, 'https://jira.example.com');

    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Warning') && c.includes('fail.png'))).toBe(true);
    // Should still report 1 uploaded
    expect(calls.some(c => c.includes('1 of 2'))).toBe(true);
  });

  it('appends jira-ticket marker to stream', async () => {
    const stream = mockStream();
    const session = makeSession();
    await addEmailAsComment('PROJ-99', session, ticketService, stream, 'https://jira.example.com');

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
    await finishEmailTicket(session, ticketService, stream, 'https://jira.example.com');

    expect(client.uploadAttachmentCalls).toHaveLength(2);
    const names = client.uploadAttachmentCalls.map(c => c.filename);
    expect(names).toContain('inline.png');
    expect(names).toContain('report.pdf');
  });

  it('links the ticket key in the confirmation when a baseUrl is passed', async () => {
    const stream = mockStream();
    const session = makeSession();
    await finishEmailTicket(session, ticketService, stream, 'https://jira.example.com');

    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('[PROJ-125](https://jira.example.com/browse/PROJ-125)');
  });

  it('converts [📎 img] placeholder in description', async () => {
    const stream = mockStream();
    const session = makeSession({ markdownBody: 'See [📎 diagram.png]' });
    await finishEmailTicket(session, ticketService, stream, 'https://jira.example.com');

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
    await finishEmailTicket(session, ticketService, stream, 'https://jira.example.com');

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

describe('streamEmailContentPreview', () => {
  it('shows numbered template and issue-type list when both available', async () => {
    const session = makeSession({
      availableTemplates: [{ name: 'Bug Report', issueType: 'Bug' }],
      availableIssueTypes: ['Story', 'Task'],
    });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailContentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('1. Bug Report');
    expect(text).toContain('2. Story');
    expect(text).toContain('3. Task');
  });

  it('shows simplified "post it" prompt when no templates or issue types', async () => {
    const session = makeSession({ availableTemplates: undefined, availableIssueTypes: undefined });
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailContentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('post it');
    expect(text).not.toMatch(/^\d+\./m);
  });

  it('saves session to workspaceState', async () => {
    const session = makeSession();
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailContentPreview(session, stream as never, ws as never);
    expect(ws.store['jira.session.emailContent']).toBeDefined();
  });

  it('appends <!-- jira:email-content --> marker', async () => {
    const session = makeSession();
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailContentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('<!-- jira:email-content -->');
  });

  it('includes From, date, and subject in header', async () => {
    const session = makeSession();
    const stream = mockStream();
    const ws = makeMockWs();
    await streamEmailContentPreview(session, stream as never, ws as never);
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('Alice');
    expect(text).toContain('2024-05-01');
    expect(text).toContain('Test Subject');
  });
});

describe('handleCreateFromEmail', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('no session and file picker cancelled → nothing streamed', async () => {
    // showOpenDialog returns undefined by default (user cancelled)
    const stream = mockStream();
    const ws = makeMockWs();
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    expect(stream.markdown).not.toHaveBeenCalled();
  });

  it('session with missing issueTypes → retries getProject and shows numbered list', async () => {
    const session = makeSession({ availableIssueTypes: undefined });
    const stream = mockStream();
    const ws = makeMockWs({ 'jira.session.emailContent': session });
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Fixture returns Bug, Story, Task (non-subtask)
    expect(text).toContain('Bug');
    expect(text).toContain('Story');
    expect(text).toContain('Task');
    expect(text).toContain('<!-- jira:email-content -->');
  });

  it('session with issueTypes already set → shows preview without calling getProject', async () => {
    const getProjectSpy = vi.spyOn(client, 'getProject');
    const session = makeSession({ availableIssueTypes: ['Epic', 'Bug'] });
    const stream = mockStream();
    const ws = makeMockWs({ 'jira.session.emailContent': session });
    await handleCreateFromEmail(
      undefined as never, stream as never, undefined as never,
      client, ticketService, undefined as never, ws as never,
    );
    expect(getProjectSpy).not.toHaveBeenCalled();
    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain('Epic');
    expect(text).toContain('Bug');
  });
});

describe('handleEmailContentSession — ticket creation', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('type number selection → creates ticket with that issue type', async () => {
    const session = makeSession({ issueType: 'Bug', availableIssueTypes: ['Bug', 'Story', 'Task'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('2', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].issueType).toBe('Story');
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('"post it" → creates ticket with session issueType', async () => {
    const session = makeSession({ issueType: 'Task', availableIssueTypes: ['Bug', 'Story', 'Task'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('post it', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].issueType).toBe('Task');
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('cancellation → clears session without creating ticket', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug', 'Story'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('c', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(0);
    expect(ws.store['jira.session.emailContent']).toBeUndefined();
  });

  it('ticket key reply → switches to comment preview without creating ticket', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug', 'Story'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('PROJ-7', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(0);
    const stored = ws.store['jira.session.emailContent'] as typeof session;
    expect(stored.pendingCommentTicketKey).toBe('PROJ-7');
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('Comment preview:'))).toBe(true);
  });

  it('unrecognized input → re-shows preview without creating ticket', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug', 'Story'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('blah blah', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(0);
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('<!-- jira:email-content -->'))).toBe(true);
  });

  it('out-of-range number → re-shows preview without creating ticket', async () => {
    const session = makeSession({ availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();
    await handleEmailContentSession('99', session, ticketService, stream as never, ws as never, client);
    expect(client.createIssueCalls).toHaveLength(0);
    const calls = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some(c => c.includes('<!-- jira:email-content -->'))).toBe(true);
  });
});
