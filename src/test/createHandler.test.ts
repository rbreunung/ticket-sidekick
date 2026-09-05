import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));
vi.mock('../participant/jira/llmHelpers', () => ({
  parseIntent: vi.fn(),
  looksLikeUnfilledPlaceholder: vi.fn(),
}));
vi.mock('../participant/jira/ticketContext', () => ({
  resolveProjectKey: vi.fn(),
  resolveIssueTypeOrPrompt: vi.fn(),
}));
vi.mock('../participant/jira/contentHandler', () => ({ streamContentPreview: vi.fn() }));
vi.mock('../templates/TemplateService', () => ({ TemplateService: vi.fn() }));
vi.mock('../templates/FieldResolver', () => ({ FieldResolver: vi.fn() }));

import { streamNextSection, streamCreateSelection, finishTicketCreation } from '../participant/jira/createHandler';
import { streamContentPreview } from '../participant/jira/contentHandler';
import type { CreationSession, CreateSelectionSession } from '../participant/sessionState';

const mockStream = () => ({ markdown: vi.fn() });
const mockWs = () => ({ get: vi.fn(), update: vi.fn() });

describe('streamNextSection', () => {
  it('returns creating metadata and no visible tag when asking for the summary', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: CreationSession = {
      template: '', project: 'PROJ', summary: null, issueType: 'Bug',
      allSections: [], pending: ['__summary__'], answers: {}, fields: {},
    };

    const chatResult = await streamNextSection(session, stream as never, ws as never);

    expect(ws.update).toHaveBeenCalledWith('jira.session.creating', session);
    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('summary');
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult.metadata?.jiraSession?.kinds).toEqual(['creating']);
  });

  it('returns creating metadata when asking for the next description section', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: CreationSession = {
      template: 'Bug Template', project: 'PROJ', summary: 'Something broke', issueType: 'Bug',
      allSections: ['Steps', 'Expected'], pending: ['Steps', 'Expected'], answers: {}, fields: {},
    };

    const chatResult = await streamNextSection(session, stream as never, ws as never);

    const allMarkdown = stream.markdown.mock.calls.map((c: string[]) => c[0]).join('');
    expect(allMarkdown).toContain('Steps');
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult.metadata?.jiraSession?.kinds).toEqual(['creating']);
  });
});

describe('streamCreateSelection', () => {
  it('returns selecting-create-option metadata and no visible tag', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: CreateSelectionSession = {
      templates: [{ name: 'Billing Bug', issueType: 'Bug' }],
      issueTypes: ['Task'],
      projectKey: 'PROJ',
      summary: null,
      description: null,
      originalPrompt: 'create a ticket',
    };

    const chatResult = await streamCreateSelection(session, stream as never, ws as never);

    expect(ws.update).toHaveBeenCalledWith('jira.session.creatingSelection', session);
    const allMarkdown = stream.markdown.mock.calls
      .map((c: unknown[]) => { const arg = c[0]; return typeof arg === 'string' ? arg : (arg as { value: string }).value; })
      .join('');
    expect(allMarkdown).toContain('Billing Bug');
    expect(allMarkdown).not.toContain('<!-- jira:');
    expect(chatResult.metadata?.jiraSession?.kinds).toEqual(['selecting-create-option']);
  });
});

describe('finishTicketCreation', () => {
  it('forwards streamContentPreview\'s returned metadata', async () => {
    const previewResult = { metadata: { jiraSession: { kinds: ['previewing'] } } };
    vi.mocked(streamContentPreview).mockResolvedValue(previewResult as never);
    const stream = mockStream();
    const ws = mockWs();
    const session: CreationSession = {
      template: '', project: 'PROJ', summary: 'Login broken', issueType: 'Bug',
      allSections: ['Steps'], pending: [], answers: { Steps: 'Click login' }, fields: {},
    };

    const chatResult = await finishTicketCreation(session, stream as never, ws as never);

    expect(chatResult).toBe(previewResult);
  });

  it('returns no metadata when there is no summary to create a ticket with', async () => {
    const stream = mockStream();
    const ws = mockWs();
    const session: CreationSession = {
      template: '', project: 'PROJ', summary: null, issueType: 'Bug',
      allSections: [], pending: [], answers: {}, fields: {},
    };

    const chatResult = await finishTicketCreation(session, stream as never, ws as never);

    expect(chatResult).toBeUndefined();
    expect(stream.markdown).toHaveBeenCalledWith('_Cannot create ticket: no summary was provided._');
  });
});
