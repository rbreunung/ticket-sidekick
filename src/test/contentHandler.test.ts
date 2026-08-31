import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  commands: { executeCommand: vi.fn() },
}));
vi.mock('../participant/jira/llmHelpers', () => ({
  generateContent: vi.fn(),
  isLmRefusal: vi.fn(),
  buildHistoryContext: vi.fn(),
}));

import { streamContentPreview, handleContentSession, buildContentContext } from '../participant/jira/contentHandler';
import { generateContent, isLmRefusal, buildHistoryContext } from '../participant/jira/llmHelpers';
import type { ContentSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

const mockStream = () => ({ markdown: vi.fn() });
const mockWs = () => ({ get: vi.fn(), update: vi.fn() });
const nullModel = {} as never;
const nullToken = {} as never;

// ---------------------------------------------------------------------------
// streamContentPreview — createTicket renders a ticket card
// ---------------------------------------------------------------------------

describe('streamContentPreview — createTicket', () => {
  it('renders ticket card with summary, type, project, template, and description', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login times out',
      issueType: 'Bug',
      templateName: 'Billing Bug',
      extraFields: {},
      currentContent: 'Steps to reproduce the issue.',
    };

    await streamContentPreview(session, stream as never, ws as never);

    expect(ws.update).toHaveBeenCalledWith('jira.session.previewing', session);
    const rendered: string = stream.markdown.mock.calls[0][0];
    expect(rendered).toContain('**Summary:** Login times out');
    expect(rendered).toContain('**Type:** Bug');
    expect(rendered).toContain('**Project:** PROJ');
    expect(rendered).toContain('**Template:** Billing Bug');
    expect(rendered).toContain('Steps to reproduce the issue.');
    expect(rendered).toContain('create it');
    expect(rendered).toContain('<!-- jira:previewing -->');
  });

  it('omits template line when templateName is null', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login times out',
      issueType: 'Bug',
      templateName: null,
      extraFields: {},
      currentContent: 'Some description.',
    };

    await streamContentPreview(session, stream as never, ws as never);

    const rendered: string = stream.markdown.mock.calls[0][0];
    expect(rendered).not.toContain('Template:');
  });

  it('omits description section when currentContent is empty', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'No description',
      issueType: 'Task',
      templateName: null,
      extraFields: {},
      currentContent: '',
    };

    await streamContentPreview(session, stream as never, ws as never);

    const rendered: string = stream.markdown.mock.calls[0][0];
    expect(rendered).not.toContain('Description:');
  });
});

// ---------------------------------------------------------------------------
// handleContentSession — createTicket confirmation
// ---------------------------------------------------------------------------

describe('handleContentSession — createTicket confirmation', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('calls ticketService.createTicket on confirmation and clears session', async () => {
    const createTicketSpy = vi.spyOn(ticketService, 'createTicket');
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login timeout',
      issueType: 'Bug',
      templateName: null,
      extraFields: { priority: { name: 'High' } },
      currentContent: 'The login form times out after 5 minutes.',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'create it', nullModel, nullToken, stream as never, ticketService, ws as never);

    // Session should be cleared
    expect(ws.update).toHaveBeenCalledWith('jira.session.previewing', undefined);

    // createTicket called with correct args
    expect(createTicketSpy).toHaveBeenCalledOnce();
    const [projectKey, summary, issueType, fields] = createTicketSpy.mock.calls[0];
    expect(projectKey).toBe('PROJ');
    expect(summary).toBe('Login timeout');
    expect(issueType).toBe('Bug');
    expect(fields).toMatchObject({ priority: { name: 'High' } });
    expect(fields).toHaveProperty('description'); // converted from markdown to Jira wiki

    // Result streamed (the ticket key from created-issue.json fixture is PROJ-125)
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('PROJ-125');

    // Ticket marker appended
    expect(allMarkdown).toContain('<!-- @jira-ticket:PROJ-125 -->');
  });

  it('links the ticket key when baseUrl is configured, and still appends the correct marker', async () => {
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login timeout',
      issueType: 'Bug',
      templateName: null,
      extraFields: {},
      currentContent: '',
    };
    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'create it', nullModel, nullToken, stream as never, ticketService, ws as never, 'https://jira.example.com');

    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('[PROJ-125](https://jira.example.com/browse/PROJ-125)');
    expect(allMarkdown).toContain('<!-- @jira-ticket:PROJ-125 -->');
  });

  it('clears session on cancellation without calling createTicket', async () => {
    const createTicketSpy = vi.spyOn(ticketService, 'createTicket');
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Something',
      issueType: 'Task',
      templateName: null,
      extraFields: {},
      currentContent: 'Some description.',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'cancel', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(ws.update).toHaveBeenCalledWith('jira.session.previewing', undefined);
    expect(createTicketSpy).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('_Cancelled._');
  });

  it('also cancels with "c" shorthand', async () => {
    const createTicketSpy = vi.spyOn(ticketService, 'createTicket');
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Something',
      issueType: 'Task',
      templateName: null,
      extraFields: {},
      currentContent: '',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'c', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(createTicketSpy).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('_Cancelled._');
  });

  it('does not include description field when currentContent is empty', async () => {
    const createTicketSpy = vi.spyOn(ticketService, 'createTicket');
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'No description ticket',
      issueType: 'Task',
      templateName: null,
      extraFields: {},
      currentContent: '',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'ok', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(createTicketSpy).toHaveBeenCalledOnce();
    const [, , , fields] = createTicketSpy.mock.calls[0];
    expect(fields).not.toHaveProperty('description');
  });
});

// ---------------------------------------------------------------------------
// handleContentSession — refinement re-previews with updated content
// ---------------------------------------------------------------------------

describe('handleContentSession — createTicket refinement', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('refines currentContent and re-previews on non-confirm input', async () => {
    vi.mocked(generateContent).mockResolvedValue('Improved description text.');
    vi.mocked(isLmRefusal).mockReturnValue(false);

    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login timeout',
      issueType: 'Bug',
      templateName: null,
      extraFields: {},
      currentContent: 'Original description.',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'make it more concise', nullModel, nullToken, stream as never, ticketService, ws as never);

    // generateContent was called with the refinement prompt
    expect(generateContent).toHaveBeenCalledOnce();

    // session re-previewed with updated content
    expect(ws.update).toHaveBeenCalledWith(
      'jira.session.previewing',
      expect.objectContaining({
        operation: 'createTicket',
        currentContent: 'Improved description text.',
      }),
    );

    // The rendered output contains the refined content
    const rendered: string = stream.markdown.mock.calls[0][0];
    expect(rendered).toContain('Improved description text.');
  });

  it('re-previews original session when LLM returns a refusal', async () => {
    vi.mocked(generateContent).mockResolvedValue('I cannot help with that.');
    vi.mocked(isLmRefusal).mockReturnValue(true);

    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Login timeout',
      issueType: 'Bug',
      templateName: null,
      extraFields: {},
      currentContent: 'Original description.',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'do something illegal', nullModel, nullToken, stream as never, ticketService, ws as never);

    // Refusal message shown
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('declined the request');

    // Original session re-previewed (not the refined one)
    expect(ws.update).toHaveBeenCalledWith(
      'jira.session.previewing',
      expect.objectContaining({ currentContent: 'Original description.' }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleContentSession — addComment regression
// ---------------------------------------------------------------------------

describe('handleContentSession — addComment regression', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('calls ticketService.addComment when operation is addComment and prompt is a confirmation', async () => {
    const addCommentSpy = vi.spyOn(ticketService, 'addComment');
    const session: ContentSession = {
      operation: 'addComment',
      ticketKey: 'PROJ-123',
      currentContent: 'This is a test comment.',
      historyContext: undefined,
      contentSource: 'generate',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'post it', nullModel, nullToken, stream as never, ticketService, ws as never);

    // Session cleared
    expect(ws.update).toHaveBeenCalledWith('jira.session.previewing', undefined);

    // addComment called with correct ticket key and content
    expect(addCommentSpy).toHaveBeenCalledOnce();
    const [issueKey, body] = addCommentSpy.mock.calls[0];
    expect(issueKey).toBe('PROJ-123');
    expect(body).toBeTruthy(); // converted Jira wiki text

    // Ticket marker appended
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('<!-- @jira-ticket:PROJ-123 -->');
  });

  it('links the ticket key when baseUrl is configured', async () => {
    const session: ContentSession = {
      operation: 'addComment',
      ticketKey: 'PROJ-123',
      currentContent: 'This is a test comment.',
      historyContext: undefined,
      contentSource: 'generate',
    };
    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'post it', nullModel, nullToken, stream as never, ticketService, ws as never, 'https://jira.example.com');

    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('[PROJ-123](https://jira.example.com/browse/PROJ-123)');
  });
});

// ---------------------------------------------------------------------------
// handleContentSession — addComment refinement preserves contentSource
// ---------------------------------------------------------------------------

describe('handleContentSession — addComment refinement preserves contentSource', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('passes session.contentSource to generateContent on refinement', async () => {
    vi.mocked(generateContent).mockResolvedValue('Refined comment text.');
    vi.mocked(isLmRefusal).mockReturnValue(false);

    const session: ContentSession = {
      operation: 'addComment',
      ticketKey: 'PROJ-123',
      currentContent: 'Original comment.',
      historyContext: 'Some history context.',
      contentSource: 'history-full',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'make it shorter', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(generateContent).toHaveBeenCalledOnce();
    const args = vi.mocked(generateContent).mock.calls[0];
    expect(args[4]).toBe('history-full');
  });
});

// ---------------------------------------------------------------------------
// handleContentSession — end-to-end Jira-native trigger neutralization (AE2)
//
// Exercises the REAL content-preview confirmation flow (not markdownToJiraWiki()
// directly — that's covered by markdownToJiraWiki.test.ts) to prove a crafted
// Jira-native-trigger payload (as an LLM might generate, or a user might type)
// does not survive as live wiki markup in the text that actually reaches the
// mocked Jira sink (MockJiraClient's captured call args).
// ---------------------------------------------------------------------------

describe('handleContentSession — end-to-end Jira-native trigger neutralization', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  const craftedPayload =
    'Root cause analysis: -struck- the old assumption, see !http://evil.example/t.gif! for details.';

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('neutralizes a crafted trigger payload in the createTicket description call site (contentHandler.ts ~line 117)', async () => {
    const session: ContentSession = {
      operation: 'createTicket',
      projectKey: 'PROJ',
      summary: 'Investigate root cause',
      issueType: 'Bug',
      templateName: null,
      extraFields: {},
      currentContent: craftedPayload,
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'create it', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(client.createIssueCalls).toHaveLength(1);
    const description = client.createIssueCalls[0].additionalFields?.description as string;
    expect(description).toBeTruthy();
    // The raw Jira-native trigger shapes must not survive intact
    expect(description).not.toContain('-struck-');
    expect(description).not.toContain('!http://evil.example/t.gif!');
    // The underlying content (stripped of trigger delimiters) is still present
    expect(description).toContain('struck');
    expect(description).toContain('http://evil.example/t.gif');
  });

  it('neutralizes a crafted trigger payload in the addComment/updateDescription call site (contentHandler.ts ~line 131) — addComment', async () => {
    const session: ContentSession = {
      operation: 'addComment',
      ticketKey: 'PROJ-123',
      currentContent: craftedPayload,
      historyContext: undefined,
      contentSource: 'generate',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'post it', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(client.addCommentCalls).toHaveLength(1);
    const body = client.addCommentCalls[0].body;
    expect(body).not.toContain('-struck-');
    expect(body).not.toContain('!http://evil.example/t.gif!');
    expect(body).toContain('struck');
    expect(body).toContain('http://evil.example/t.gif');
  });

  it('neutralizes a crafted trigger payload in the addComment/updateDescription call site (contentHandler.ts ~line 131) — updateDescription', async () => {
    const session: ContentSession = {
      operation: 'updateDescription',
      ticketKey: 'PROJ-123',
      currentContent: craftedPayload,
      historyContext: undefined,
      contentSource: 'generate',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'post it', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(client.updateIssueCalls).toHaveLength(1);
    const description = client.updateIssueCalls[0].fields.description as string;
    expect(description).not.toContain('-struck-');
    expect(description).not.toContain('!http://evil.example/t.gif!');
    expect(description).toContain('struck');
    expect(description).toContain('http://evil.example/t.gif');
  });
});

// ---------------------------------------------------------------------------
// buildContentContext — contentSource routing
// ---------------------------------------------------------------------------

describe('buildContentContext — contentSource routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildHistoryContext).mockReturnValue(undefined);
  });

  it('calls buildHistoryContext with "generate" when contentSource is generate', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '', 'generate');
    expect(buildHistoryContext).toHaveBeenCalledWith('generate', chatContext);
  });

  it('calls buildHistoryContext with "history-recent" when contentSource is history-recent', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '', 'history-recent');
    expect(buildHistoryContext).toHaveBeenCalledWith('history-recent', chatContext);
  });

  it('defaults to history-full when contentSource is omitted', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '');
    expect(buildHistoryContext).toHaveBeenCalledWith('history-full', chatContext);
  });
});
