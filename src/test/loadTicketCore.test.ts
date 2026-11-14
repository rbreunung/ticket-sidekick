import { describe, expect, it } from 'vitest';

import { loadTicketToWorkspace, type LoadWriter } from '../tools/jiraTools/loadCore';
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
    isLink: async () => false,
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

