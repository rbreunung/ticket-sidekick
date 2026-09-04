import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
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

describe('streamFieldUpdatePreview', () => {
  it('suggests "post it" to apply, not "ok" (R5)', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const chatResult = await streamFieldUpdatePreview(
      { ticketKeys: ['PROJ-1'], fieldId: 'priority', fieldName: 'Priority', fieldValue: 'High', isArray: false, arrayOp: 'set' },
      stream as never,
      ws as never,
    );
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('Reply **post it** to apply');
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
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
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
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
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

  it('calls streamContentPreview with corrected text and emits ticket marker on happy path', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue({
      correctedText: 'We need OAuth2 authentication for the mobile app.',
      changeSummary: null,
    });
    const stream = mockStream();
    const ws = mockWs();

    await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, ws as never);

    expect(spellCheckValue).toHaveBeenCalledOnce();
    expect(streamContentPreview).toHaveBeenCalledOnce();
    const [session] = vi.mocked(streamContentPreview).mock.calls[0];
    expect(session.ticketKey).toBe('PROJ-123');
    expect(session.operation).toBe('updateDescription');
    expect(session.currentContent).toBe('We need OAuth2 authentication for the mobile app.');
    expect(stream.markdown).toHaveBeenCalledWith('\n\n<!-- @jira-ticket:PROJ-123 -->');
  });

  it('forwards streamContentPreview\'s returned metadata to its own caller', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue({
      correctedText: 'We need OAuth2 authentication for the mobile app.',
      changeSummary: null,
    });
    const previewResult = { metadata: { jiraSession: { kinds: ['previewing'] } } };
    vi.mocked(streamContentPreview).mockResolvedValue(previewResult as never);
    const stream = mockStream();
    const ws = mockWs();

    const chatResult = await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, ws as never);

    expect(chatResult).toBe(previewResult);
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

    await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, mockWs() as never);

    expect(spellCheckValue).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('**PROJ-123** has no description to check.');
  });

  it('streams a no-issues message when spellCheckValue returns null', async () => {
    vi.mocked(spellCheckValue).mockResolvedValue(null);
    const stream = mockStream();

    await handleSpellCheck('PROJ-123', service, nullModel, stream as never, nullToken, mockWs() as never);

    expect(streamContentPreview).not.toHaveBeenCalled();
    expect(stream.markdown).toHaveBeenCalledWith('No spelling or grammar issues found in **PROJ-123**.');
  });
});
