import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => {
  class Uri {
    fsPath = '';
    path = '';
    static file(p: string): Uri {
      const u = new Uri();
      u.fsPath = p;
      u.path = p;
      return u;
    }
    toString(): string {
      return this.fsPath;
    }
  }
  class Location {
    constructor(public uri: Uri) {}
  }
  return {
    Uri,
    Location,
    MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
      fs: { readFile: vi.fn() },
    },
    window: {
      showOpenDialog: vi.fn(),
      activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    },
  };
});

import * as vscode from 'vscode';
import {
  resolveTicketKeyForUpload,
  buildUploadConfirmationMessage,
  buildUploadResultMessage,
  type UploadReviewSession,
  type AwaitUploadTicketSession,
} from '../participant/sessionState';
import {
  handleUploadAttachment, handleUploadReviewReply, handleAwaitUploadTicketReply,
} from '../participant/jira/uploadHandler';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import type { ParsedIntent } from '../participant/jira/llmHelpers';

function markdownText(arg: unknown): string {
  return typeof arg === 'string' ? arg : (arg as { value: string }).value;
}

function mockStream() {
  return { markdown: vi.fn() };
}

function mockWs() {
  return { get: vi.fn(), update: vi.fn() };
}

function makeIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return {
    operation: 'uploadAttachment', ticketKey: null, projectKey: null, summary: null, issueType: null,
    assignee: null, components: null, description: null, comment: null, commentQuery: null,
    contentSource: 'literal', fieldUpdates: [], fieldName: null, fieldValue: null, arrayOp: 'set',
    scope: null, jql: null, filterId: null, filterName: null, useMyTeamJql: false,
    constraintFixVersion: null, constraintSprint: null, constraintAssignee: null, targetStatus: null,
    bulkFieldName: null, bulkFieldValue: null, cleanupRuleName: null, fixVersion: null,
    resolution: null, templateName: null, filePath: null,
    ...overrides,
  };
}

function makeRequest(overrides: { prompt?: string; references?: unknown[] } = {}) {
  return { prompt: overrides.prompt ?? 'upload the report', references: overrides.references ?? [] } as never;
}

const nullContext = { history: [] } as never;

beforeEach(() => {
  vi.mocked(vscode.workspace.fs.readFile).mockReset();
  vi.mocked(vscode.window.showOpenDialog).mockReset();
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
});

describe('resolveTicketKeyForUpload', () => {
  it('prefers a ticket key found in the prompt text over the filename and last-ticket context', () => {
    const key = resolveTicketKeyForUpload('upload the report to PROJ-123', 'OTHER-9-report.pdf', 'THIRD-1');
    expect(key).toBe('PROJ-123');
  });

  it('falls back to a ticket key embedded in the filename when the text has none', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'PROJ-123-report.pdf', 'THIRD-1');
    expect(key).toBe('PROJ-123');
  });

  it('falls back to the last-referenced ticket when text and filename have no key', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'report.pdf', 'THIRD-1');
    expect(key).toBe('THIRD-1');
  });

  it('returns null when no source has a ticket key', () => {
    const key = resolveTicketKeyForUpload('upload the report', 'report.pdf', null);
    expect(key).toBeNull();
  });
});

describe('buildUploadConfirmationMessage', () => {
  it('renders a single file with its size and the target ticket', () => {
    const message = buildUploadConfirmationMessage('PROJ-123', [{ name: 'report.pdf', size: 2_097_152 }]);
    expect(message).toContain('PROJ-123');
    expect(message).toContain('report.pdf');
    expect(message).toContain('2.0 MB');
  });

  it('renders one line per file for multiple files', () => {
    const message = buildUploadConfirmationMessage('PROJ-123', [
      { name: 'a.pdf', size: 1024 },
      { name: 'b.pdf', size: 2048 },
      { name: 'c.pdf', size: 4096 },
    ]);
    expect(message).toContain('a.pdf');
    expect(message).toContain('b.pdf');
    expect(message).toContain('c.pdf');
  });
});

describe('buildUploadResultMessage', () => {
  it('renders each file\'s own success or failure outcome', () => {
    const message = buildUploadResultMessage('PROJ-123', [
      { name: 'a.pdf', ok: true },
      { name: 'b.pdf', ok: false, error: 'network error' },
    ]);
    expect(message).toContain('a.pdf');
    expect(message).toContain('b.pdf');
    expect(message).toContain('network error');
  });
});

describe('handleUploadAttachment — file resolution (R1-R3, AE2)', () => {
  it('opens a multi-select file picker when no chat reference, active editor, or path is given', async () => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleUploadAttachment(makeRequest(), nullContext, stream as never, ws as never, makeIntent());

    expect(result).toBeUndefined();
    expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectMany: true }));
  });

  it('an explicit path wins over the active editor (R3)', async () => {
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = { document: { uri: vscode.Uri.file('/workspace/other.txt') } };
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode('hello'));
    const stream = mockStream();
    const ws = mockWs();

    await handleUploadAttachment(
      makeRequest({ prompt: 'upload report.pdf to PROJ-123' }),
      nullContext, stream as never, ws as never,
      makeIntent({ filePath: 'report.pdf' }),
    );

    const readCalls = vi.mocked(vscode.workspace.fs.readFile).mock.calls;
    expect(readCalls[0][0].fsPath).toBe('/workspace/report.pdf');
  });

  it('resolves every file attached to the chat message, not just the first (R1/R8)', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode('hello'));
    const stream = mockStream();
    const ws = mockWs();
    const refs = [
      { value: vscode.Uri.file('/workspace/a.pdf') },
      { value: vscode.Uri.file('/workspace/b.pdf') },
    ];

    await handleUploadAttachment(
      makeRequest({ prompt: 'upload these to PROJ-123', references: refs }),
      nullContext, stream as never, ws as never, makeIntent(),
    );

    const session = ws.update.mock.calls.find((c) => c[0] === 'jira.session.uploadReview')?.[1] as UploadReviewSession;
    expect(session.files.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });
});

describe('handleUploadAttachment — size limit (R7, AE1)', () => {
  it('rejects an oversized file before a session is stored', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(26 * 1024 * 1024));
    const stream = mockStream();
    const ws = mockWs();

    await handleUploadAttachment(
      makeRequest({ prompt: 'upload report.pdf to PROJ-123' }),
      nullContext, stream as never, ws as never,
      makeIntent({ filePath: 'report.pdf' }),
    );

    expect(markdownText(stream.markdown.mock.calls[0][0])).toMatch(/25 MB limit/);
    expect(ws.update).not.toHaveBeenCalled();
  });
});

describe('handleUploadAttachment — ticket resolution (R4/R5, AE3)', () => {
  it('asks explicitly when no ticket key resolves from text, filename, or session context', async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new TextEncoder().encode('hello'));
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleUploadAttachment(
      makeRequest({ prompt: 'upload report.pdf' }),
      nullContext, stream as never, ws as never,
      makeIntent({ filePath: 'report.pdf' }),
    );

    expect(ws.update).toHaveBeenCalledWith('jira.session.awaitUploadTicket', expect.objectContaining({
      files: expect.arrayContaining([expect.objectContaining({ name: 'report.pdf' })]),
    }));
    expect(result).toEqual({ metadata: { jiraSession: { kinds: ['await-upload-ticket'] } } });
  });
});

describe('handleUploadReviewReply (R6, R8)', () => {
  function makeSession(overrides: Partial<UploadReviewSession> = {}): UploadReviewSession {
    return {
      ticketKey: 'PROJ-123',
      files: [{ name: 'report.pdf', size: 1024, contentType: 'application/pdf', base64Content: 'aGVsbG8=' }],
      schemaVersion: 5,
      ...overrides,
    };
  }

  it('uploads every pending file on confirm and reports per-file outcomes', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();
    const session = makeSession({
      files: [
        { name: 'a.pdf', size: 1024, contentType: 'application/pdf', base64Content: 'aGVsbG8=' },
        { name: 'b.pdf', size: 1024, contentType: 'application/pdf', base64Content: 'aGVsbG8=' },
      ],
    });

    await handleUploadReviewReply('confirm', session, ticketService, stream as never, ws as never);

    expect(client.uploadAttachmentCalls).toHaveLength(2);
    expect(client.uploadAttachmentCalls[0]).toMatchObject({ issueKey: 'PROJ-123', filename: 'a.pdf' });
    expect(ws.update).toHaveBeenCalledWith('jira.session.uploadReview', undefined);
  });

  it('cancels without uploading anything', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();

    await handleUploadReviewReply('cancel', makeSession(), ticketService, stream as never, ws as never);

    expect(client.uploadAttachmentCalls).toHaveLength(0);
    expect(ws.update).toHaveBeenCalledWith('jira.session.uploadReview', undefined);
  });

  it('re-shows the confirmation on anything that is not a clear confirm or cancel', async () => {
    const client = new MockJiraClient();
    const ticketService = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleUploadReviewReply('maybe later', makeSession(), ticketService, stream as never, ws as never);

    expect(client.uploadAttachmentCalls).toHaveLength(0);
    expect(ws.update).not.toHaveBeenCalled();
    expect(result).toEqual({ metadata: { jiraSession: { kinds: ['upload-review'] } } });
  });
});

describe('handleAwaitUploadTicketReply (R5/KTD4)', () => {
  function makeAwaitSession(): AwaitUploadTicketSession {
    return {
      files: [{ name: 'report.pdf', size: 1024, contentType: 'application/pdf', base64Content: 'aGVsbG8=' }],
      schemaVersion: 5,
    };
  }

  it('proceeds to the upload review once a ticket key is given', async () => {
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleAwaitUploadTicketReply('PROJ-123', makeAwaitSession(), stream as never, ws as never);

    expect(ws.update).toHaveBeenCalledWith('jira.session.awaitUploadTicket', undefined);
    expect(ws.update).toHaveBeenCalledWith('jira.session.uploadReview', expect.objectContaining({ ticketKey: 'PROJ-123' }));
    expect(result).toEqual({ metadata: { jiraSession: { kinds: ['upload-review'] } } });
  });

  it('re-asks when the reply has no ticket key', async () => {
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleAwaitUploadTicketReply('not a ticket key', makeAwaitSession(), stream as never, ws as never);

    expect(ws.update).not.toHaveBeenCalled();
    expect(result).toEqual({ metadata: { jiraSession: { kinds: ['await-upload-ticket'] } } });
  });
});
