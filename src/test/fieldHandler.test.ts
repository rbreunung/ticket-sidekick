import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

import { streamFieldUpdatePreview, handleSetField, continueSetField } from '../participant/jira/fieldHandler';
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
