import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
}));
vi.mock('../participant/jira/llmHelpers', () => ({ spellCheckValue: vi.fn() }));
vi.mock('../participant/jira/contentHandler', () => ({ streamContentPreview: vi.fn() }));

import { handleSpellCheck, streamFieldUpdatePreview } from '../participant/jira/fieldHandler';
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
    await streamFieldUpdatePreview(
      { ticketKeys: ['PROJ-1'], fieldId: 'priority', fieldName: 'Priority', fieldValue: 'High', isArray: false, arrayOp: 'set' },
      stream as never,
      ws as never,
    );
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('Reply **post it** to apply');
    expect(allMarkdown).not.toContain('**ok**');
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
