import { beforeEach, describe, expect, it, vi } from 'vitest';

// The chat flow imports `vscode`, so it gets a local `vi.mock('vscode', ...)` factory, as this
// suite's other handler tests do. `workspace.fs` is backed by an in-memory `Map` so the chat
// flow's writes are assertable; `vi.hoisted` is required because the factory below is hoisted
// above this file's own imports.
const { fakeFiles, resetFakeFiles } = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  return { fakeFiles: files, resetFakeFiles: () => files.clear() };
});

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath.replace(/\/+$/, ''), ...segments].join('/'),
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {
      createDirectory: vi.fn(async () => {}),
      writeFile: vi.fn(async (uri: { fsPath: string }, content: Uint8Array) => {
        fakeFiles.set(uri.fsPath, content);
      }),
      readFile: vi.fn(async (uri: { fsPath: string }) => {
        const content = fakeFiles.get(uri.fsPath);
        if (!content) throw new Error(`ENOENT: ${uri.fsPath}`);
        return content;
      }),
    },
    getConfiguration: vi.fn(() => ({ get: () => 'https://jira.example.com' })),
  },
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

import { loadTicketToWorkspace, type LoadWriter } from '../participant/jira/loadCore';
import { handleLoadTicket } from '../participant/jira/loadHandler';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import type { JiraAttachment, JiraIssue } from '../jira/IJiraClient';

// The load core against the real `ticket-PROJ-123.json` fixture (via `MockJiraClient` and
// `TicketService`, as the chat flow and the tools use it), writing into an in-memory writer, so
// the fetch, classify, download, write and git-ignore sequence is proven end to end.

/** A writer that keeps every file in memory, keyed by its path relative to the workspace folder. */
function memoryWriter(initial: Record<string, string> = {}): LoadWriter & { files: Map<string, Uint8Array>; text(relPath: string): string } {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([k, v]) => [k, new TextEncoder().encode(v)]));
  return {
    files,
    text: relPath => new TextDecoder().decode(files.get(relPath)),
    createDirectory: async () => {},
    writeFile: async (relPath, bytes) => { files.set(relPath, bytes); },
    readFile: async relPath => {
      const content = files.get(relPath);
      if (!content) throw new Error(`ENOENT: ${relPath}`);
      return content;
    },
  };
}

async function loadFixtureTicket(client: MockJiraClient, service: TicketService, ticketKey: string) {
  const issue = await service.getIssue(ticketKey);
  const comments = await service.getAllComments(ticketKey);
  const attachments = service.getAttachments(issue);
  const fieldMeta = await service.getFieldMeta();
  const remoteLinks = await service.getRemoteLinks(ticketKey);
  return { issue, comments, attachments, fieldMeta, remoteLinks };
}

describe('loadTicketToWorkspace', () => {
  it('writes ticket.md and comments.md, downloads eligible attachments, skips the rest, and git-ignores .jira-context/', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');
    const writer = memoryWriter();

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      writer,
    );

    // screenshot.png (image/png) and error.log (text/plain) are eligible; heap-dump.bin
    // (application/octet-stream, no matching extension) is not.
    expect(result.downloadedCount).toBe(2);
    expect(result.skipped).toEqual([
      expect.objectContaining({ filename: 'heap-dump.bin', reason: 'unknown binary format' }),
    ]);
    expect(result.writeErrors).toEqual([]);

    const ticketMd = writer.text('.jira-context/PROJ-123/ticket.md');
    expect(ticketMd).toContain('# PROJ-123: Implement user authentication');
    expect(ticketMd).toContain('attachments/screenshot.png');
    expect(ticketMd).toContain('attachments/error.log');
    expect(ticketMd).not.toContain('attachments/heap-dump.bin');

    const commentsMd = writer.text('.jira-context/PROJ-123/comments.md');
    expect(commentsMd).toContain('Please add unit tests for the token refresh flow.');

    expect(writer.files.has('.jira-context/PROJ-123/attachments/screenshot.png')).toBe(true);
    expect(writer.files.has('.jira-context/PROJ-123/attachments/error.log')).toBe(true);

    expect(writer.text('.gitignore')).toContain('.jira-context/');
  });

  it('reports a per-attachment download failure in the skipped list with reason "download failed", without failing the whole load', async () => {
    const client = new MockJiraClient();
    client.downloadAttachment = async (contentUrl: string) => {
      if (contentUrl.includes('screenshot.png')) throw new Error('HTTP 500');
      return new Uint8Array([1]);
    };
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');
    const writer = memoryWriter();

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      writer,
    );

    expect(result.downloadedCount).toBe(1); // error.log still downloads
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: 'screenshot.png', reason: 'download failed' })]),
    );
    expect(writer.files.has('.jira-context/PROJ-123/attachments/screenshot.png')).toBe(false);
    expect(writer.files.has('.jira-context/PROJ-123/attachments/error.log')).toBe(true);
  });

  it('downloads only the most-recently-created attachment when two share a filename', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');
    const olderVersion = {
      id: 'att010', filename: 'notes.txt', mimeType: 'text/plain', size: 100,
      content: 'https://jira.example.com/secure/attachment/att010/notes.txt', created: '2024-01-01T00:00:00.000+0000',
    };
    const newerVersion = {
      id: 'att011', filename: 'notes.txt', mimeType: 'text/plain', size: 200,
      content: 'https://jira.example.com/secure/attachment/att011/notes.txt', created: '2024-01-05T00:00:00.000+0000',
    };
    client.downloadAttachment = async (contentUrl: string) =>
      new TextEncoder().encode(contentUrl.includes('att010') ? 'older content' : 'newer content');
    const writer = memoryWriter();

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments: [olderVersion, newerVersion], remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      writer,
    );

    // Exactly one file lands on disk — no write race between the two same-named attachments —
    // and it holds the newer attachment's content, not whichever happened to write last.
    expect(result.downloadedCount).toBe(1);
    expect(writer.text('.jira-context/PROJ-123/attachments/notes.txt')).toBe('newer content');
    expect(result.skipped).toEqual([
      expect.objectContaining({ filename: 'notes.txt', reason: 'duplicate filename; only the newest attachment with this name is downloaded' }),
    ]);
  });

  it('keeps the exact filename in the skipped list for a download failure, even when the filename contains a colon', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');
    const colonNamed = {
      id: 'att020', filename: 'log:2024-01-15.txt', mimeType: 'text/plain', size: 50,
      content: 'https://jira.example.com/secure/attachment/att020/log:2024-01-15.txt', created: '2024-01-01T00:00:00.000+0000',
    };
    client.downloadAttachment = async () => { throw new Error('HTTP 500: request failed'); };

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments: [colonNamed], remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      memoryWriter(),
    );

    // Previously, the failed-download filename was recovered by splitting a logged
    // "<filename>: <message>" string on ":" — which truncated a filename containing a colon.
    expect(result.skipped).toEqual([
      expect.objectContaining({ filename: 'log:2024-01-15.txt', reason: 'download failed', size: 50, mimeType: 'text/plain' }),
    ]);
  });

  it('leaves .jira-context/ out of .gitignore untouched when it is already present', async () => {
    const writer = memoryWriter({ '.gitignore': 'node_modules/\n.jira-context/\n' });
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');

    await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      writer,
    );

    expect(writer.text('.gitignore')).toBe('node_modules/\n.jira-context/\n');
  });
});

// handleLoadTicket() is the chat entry point that owns the 'load-skipped' resume session: it
// reports back whether that session is now live, so the participant can carry the matching
// session metadata, and returns the loaded ticket's project key and issue type, read off the same
// `getIssue` call, so the follow-up chips never need a second fetch.
describe('handleLoadTicket — load-skipped session liveness', () => {
  beforeEach(() => {
    resetFakeFiles();
  });

  const mockStream = () => ({ markdown: vi.fn() });
  const mockWs = () => ({ get: vi.fn(), update: vi.fn() });

  it('returns hasSkippedAttachments: true and stores the session when attachments were skipped', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleLoadTicket('PROJ-123', service, stream as never, ws as never, [], new Set(), new Set());

    // heap-dump.bin (application/octet-stream) is skipped in the PROJ-123 fixture.
    expect(result.hasSkippedAttachments).toBe(true);
    expect(result.projectKey).toBe('PROJ');
    expect(ws.update).toHaveBeenCalledWith('jira.session.loadSkipped', expect.objectContaining({ ticketKey: 'PROJ-123' }));
  });

  it('returns hasSkippedAttachments: false and does not touch the session when nothing was skipped', async () => {
    const client = new MockJiraClient();
    const originalGetIssue = client.getIssue.bind(client);
    client.getIssue = async (issueKey: string) => {
      const issue = await originalGetIssue(issueKey);
      return { ...issue, fields: { ...issue.fields, attachment: [] } };
    };
    const service = new TicketService(client);
    const stream = mockStream();
    const ws = mockWs();

    const result = await handleLoadTicket('PROJ-123', service, stream as never, ws as never, [], new Set(), new Set());

    expect(result.hasSkippedAttachments).toBe(false);
    expect(ws.update).not.toHaveBeenCalledWith('jira.session.loadSkipped', expect.anything());
  });
});

describe('handleLoadTicket — unsafe attachment filenames', () => {
  beforeEach(() => {
    resetFakeFiles();
  });

  it('lists an attachment with a path in its filename as skipped for its unsafe filename and writes nothing outside the attachments folder', async () => {
    const client = new MockJiraClient();
    const getIssue = client.getIssue.bind(client);
    const evil: JiraAttachment[] = [
      { id: 'att030', filename: '../../evil.txt', mimeType: 'text/plain', size: 2048, content: 'https://jira.example.com/a/att030', created: '2024-01-01T00:00:00.000+0000' },
      { id: 'att031', filename: '..\\..\\evil.txt', mimeType: 'text/plain', size: 2048, content: 'https://jira.example.com/a/att031', created: '2024-01-01T00:00:00.000+0000' },
      { id: 'att032', filename: 'notes.txt', mimeType: 'text/plain', size: 2048, content: 'https://jira.example.com/a/att032', created: '2024-01-01T00:00:00.000+0000' },
    ];
    client.getIssue = async (issueKey: string): Promise<JiraIssue> => {
      const issue = await getIssue(issueKey);
      return { ...issue, fields: { ...issue.fields, attachment: evil } };
    };
    const stream = { markdown: vi.fn() };
    const ws = { get: vi.fn(), update: vi.fn() };

    const result = await handleLoadTicket('PROJ-123', new TicketService(client), stream as never, ws as never, [], new Set(), new Set());

    expect([...fakeFiles.keys()].sort()).toEqual([
      '/workspace/.gitignore',
      '/workspace/.jira-context/PROJ-123/attachments/notes.txt',
      '/workspace/.jira-context/PROJ-123/comments.md',
      '/workspace/.jira-context/PROJ-123/ticket.md',
    ]);
    const skippedList = streamedText(stream);
    expect(skippedList).toContain('**Skipped attachments:**');
    expect(skippedList).toContain('- Not downloaded because the name is unsafe: `../../evil.txt` (2 KB)');
    expect(skippedList).toContain('- Not downloaded because the name is unsafe: `..\\..\\evil.txt` (2 KB)');
    // Nothing can be downloaded on request, so nothing is offered.
    expect(skippedList).not.toContain('command:');
    expect(skippedList).not.toContain('Reply with a number');
    expect(result.hasSkippedAttachments).toBe(false);
    expect(ws.update).not.toHaveBeenCalledWith('jira.session.loadSkipped', expect.anything());
  });

  it('numbers and offers only the skipped attachment that can be downloaded, and lists the unsafe one as a plain line', async () => {
    const client = new MockJiraClient();
    const getIssue = client.getIssue.bind(client);
    const attachments: JiraAttachment[] = [
      { id: 'att040', filename: '../evil.txt', mimeType: 'text/plain', size: 2048, content: 'https://jira.example.com/a/att040', created: '2024-01-01T00:00:00.000+0000' },
      { id: 'att041', filename: 'dump.bin', mimeType: 'application/octet-stream', size: 4096, content: 'https://jira.example.com/a/att041', created: '2024-01-01T00:00:00.000+0000' },
    ];
    client.getIssue = async (issueKey: string): Promise<JiraIssue> => {
      const issue = await getIssue(issueKey);
      return { ...issue, fields: { ...issue.fields, attachment: attachments } };
    };
    const stream = { markdown: vi.fn() };
    const ws = { get: vi.fn(), update: vi.fn() };

    const result = await handleLoadTicket('PROJ-123', new TicketService(client), stream as never, ws as never, [], new Set(), new Set());

    const text = streamedText(stream);
    expect(text).toMatch(/^1\. \[`dump\.bin` — 4 KB \(application\/octet-stream\) — unknown binary format\]\(command:workbench\.action\.chat\.open\?/m);
    expect(text).not.toMatch(/^2\. /m);
    expect(text).toContain('\n- Not downloaded because the name is unsafe: `../evil.txt` (2 KB)');
    expect(text).toContain('Reply with a number to download it anyway.');
    expect(result.hasSkippedAttachments).toBe(true);
    expect(ws.update).toHaveBeenCalledWith('jira.session.loadSkipped', {
      ticketKey: 'PROJ-123',
      skipped: [{ filename: 'dump.bin', content: 'https://jira.example.com/a/att041', size: 4096, mimeType: 'application/octet-stream', reason: 'unknown binary format' }],
    });
  });
});

/** Everything the chat flow streamed, trusted Markdown included, as one text. */
function streamedText(stream: { markdown: ReturnType<typeof vi.fn> }): string {
  return stream.markdown.mock.calls.map(([md]) => (typeof md === 'string' ? md : (md as { value: string }).value)).join('\n');
}
