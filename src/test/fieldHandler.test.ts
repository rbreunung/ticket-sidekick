import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));
vi.mock('../participant/jira/llmHelpers', () => ({ spellCheckValue: vi.fn() }));
vi.mock('../participant/jira/contentHandler', () => ({ streamContentPreview: vi.fn() }));

import { handleSpellCheck, streamFieldUpdatePreview, handleSetField, continueSetField } from '../participant/jira/fieldHandler';
import { spellCheckValue } from '../participant/jira/llmHelpers';
import { streamContentPreview } from '../participant/jira/contentHandler';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';

const mockStream = () => ({ markdown: vi.fn() });
const mockWs = () => ({ get: vi.fn(), update: vi.fn() });
const nullModel = {} as never;
const nullToken = {} as never;

// U5: several responses now stream a trusted vscode.MarkdownString (command links) rather than a
// bare string — this file's mocked MarkdownString stores the raw text on `.value`.
function markdownText(arg: unknown): string {
  return typeof arg === 'string' ? arg : (arg as { value: string }).value;
}

describe('streamFieldUpdatePreview', () => {
  it('suggests "post it" to apply, not "ok" (R5)', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const chatResult = await streamFieldUpdatePreview(
      { ticketKeys: ['PROJ-1'], fieldId: 'priority', fieldName: 'Priority', fieldValue: 'High', isArray: false, arrayOp: 'set' },
      stream as never,
      ws as never,
    );
    const allMarkdown = stream.markdown.mock.calls.map((c: unknown[]) => markdownText(c[0])).join('');
    expect(allMarkdown).toContain('Reply [Post it](command:workbench.action.chat.open?');
    expect(allMarkdown).not.toContain('**ok**');
    // No visible session marker (R3) — liveness is metadata-based (R1).
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult.metadata?.jiraSession?.kinds).toEqual(['field-update-preview']);
  });
});

describe('handleSetField — field-selection session', () => {
  it('returns field-selection metadata when the field name is ambiguous', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();
    const fieldMeta = [
      { id: 'sp1', name: 'Story Points', navigable: true, schema: { type: 'number' } },
      { id: 'sp2', name: 'Story Category', navigable: true, schema: { type: 'string' } },
    ] as never;

    const chatResult = await handleSetField(
      ['PROJ-1'], 'Story', '5', 'set', fieldMeta, service, stream as never, ws as never, nullModel, nullToken,
    );

    expect(ws.update).toHaveBeenCalledWith('jira.session.fieldSelection', expect.objectContaining({
      candidates: expect.arrayContaining([expect.objectContaining({ id: 'sp1' }), expect.objectContaining({ id: 'sp2' })]),
    }));
    const allMarkdown = stream.markdown.mock.calls.map((c: unknown[]) => markdownText(c[0])).join('');
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual(['field-selection']);
  });
});

describe('continueSetField — sprint-selection session', () => {
  it('returns sprint-selection metadata when multiple sprints match', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    vi.spyOn(service, 'findSprints').mockResolvedValue([
      { id: 1, name: 'Sprint 1', state: 'active' },
      { id: 2, name: 'Sprint 10', state: 'future' },
    ] as never);
    const stream = mockStream();
    const ws = mockWs();
    const field = { id: 'customfield_10001', name: 'Sprint', navigable: true, schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } } as never;

    const chatResult = await continueSetField(
      ['PROJ-1'], field, 'Sprint 1', 'set', service, stream as never, ws as never, nullModel, nullToken,
    );

    expect(ws.update).toHaveBeenCalledWith('jira.session.sprintSelection', expect.objectContaining({
      candidates: expect.arrayContaining([expect.objectContaining({ name: 'Sprint 1' }), expect.objectContaining({ name: 'Sprint 10' })]),
    }));
    const allMarkdown = stream.markdown.mock.calls.map((c: unknown[]) => markdownText(c[0])).join('');
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual(['sprint-selection']);
  });
});

describe('handleSpellCheck', () => {
  let client: MockJiraClient;
  let service: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    service = new TicketService(client);
  });

  it('calls streamContentPreview with corrected text and carries the ticket key on metadata (R13)', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue({
      correctedText: 'We need OAuth2 authentication for the mobile app.',
      changeSummary: null,
    });
    const previewResult = { metadata: { jiraSession: { kinds: ['previewing'] } } };
    vi.mocked(streamContentPreview).mockResolvedValue(previewResult as never);
    const stream = mockStream();
    const ws = mockWs();

    const chatResult = await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, ws as never);

    expect(spellCheckValue).toHaveBeenCalledOnce();
    expect(streamContentPreview).toHaveBeenCalledOnce();
    const [session] = vi.mocked(streamContentPreview).mock.calls[0];
    expect(session.ticketKey).toBe('PROJ-123');
    expect(session.operation).toBe('updateDescription');
    expect(session.currentContent).toBe('We need OAuth2 authentication for the mobile app.');
    // R13: no visible marker; the ticket key rides on metadata merged with the preview session.
    expect(stream.markdown).not.toHaveBeenCalledWith('\n\n<!-- @jira-ticket:PROJ-123 -->');
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual(['previewing']);
    expect(chatResult?.metadata?.jiraSession?.lastTicketKey).toBe('PROJ-123');
  });

  it('merges the ticket key into streamContentPreview\'s returned metadata (R13)', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue({
      correctedText: 'We need OAuth2 authentication for the mobile app.',
      changeSummary: null,
    });
    const previewResult = { metadata: { jiraSession: { kinds: ['previewing'] } } };
    vi.mocked(streamContentPreview).mockResolvedValue(previewResult as never);
    const stream = mockStream();
    const ws = mockWs();

    const chatResult = await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, ws as never);

    // The preview session's kinds are preserved and the ticket key is added alongside.
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual(['previewing']);
    expect(chatResult?.metadata?.jiraSession?.lastTicketKey).toBe('PROJ-123');
  });

  it('streams the change summary before the preview when the model provides one', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue({
      correctedText: 'We need OAuth2 authentication for the mobile app.',
      changeSummary: '- Fixed "OAuth" capitalization',
    });
    const stream = mockStream();
    const ws = mockWs();

    await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, ws as never);

    expect(stream.markdown).toHaveBeenCalledWith('**Changes:**\n- Fixed "OAuth" capitalization\n\n');
  });

  it('streams a no-description message when description is empty', async () => {
    client.getIssue = async () => ({
      id: '1', key: 'PROJ-123',
      fields: {
        summary: 'Test', description: null,
        status: { name: 'Open' }, assignee: null, reporter: null,
        priority: null, labels: [], fixVersions: [], comment: null,
      },
    });
    const stream = mockStream();

    const chatResult = await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, mockWs() as never);

    expect(spellCheckValue).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('**PROJ-123** has no description to check.');
    // R13: the no-op response still names the ticket, so it rides on metadata for bare follow-ups.
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual([]);
    expect(chatResult?.metadata?.jiraSession?.lastTicketKey).toBe('PROJ-123');
  });

  it('streams a no-issues message when spellCheckValue returns null', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue(null);
    const stream = mockStream();

    const chatResult = await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, mockWs() as never);

    expect(streamContentPreview).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('No spelling or grammar issues found in **PROJ-123**.');
    // R13: a completed no-op still references the ticket.
    expect(chatResult?.metadata?.jiraSession?.kinds).toEqual([]);
    expect(chatResult?.metadata?.jiraSession?.lastTicketKey).toBe('PROJ-123');
  });
});
