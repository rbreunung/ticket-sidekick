import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same shape as this suite's other `vscode`-importing handler tests (e.g.
// reportImportHandler.test.ts, emailHandler.test.ts) — a local `vi.mock('vscode', ...)`
// factory, not a project-wide mock. `workspace.fs` is backed by an in-memory `Map` so
// loadTicketToWorkspace()'s writes are assertable; `vi.hoisted` is required because the
// factory below is hoisted above this file's own imports.
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
}));

import * as vscode from 'vscode';
import { loadTicketToWorkspace } from '../participant/jira/loadHandler';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

// Integration coverage for U2's extracted load core (KTD8) — exercised against the real
// `ticket-PROJ-123.json` fixture (via `MockJiraClient`/`TicketService`, exactly as the chat
// handler and the Agent Mode tools do) and the mocked `vscode.workspace.fs`, so the fetch→
// classify→download→write→gitignore sequence is proven end to end instead of manually only.

const wsRoot = vscode.Uri.file('/workspace');

async function loadFixtureTicket(client: MockJiraClient, service: TicketService, ticketKey: string) {
  const issue = await service.getIssue(ticketKey);
  const comments = await service.getAllComments(ticketKey);
  const attachments = service.getAttachments(issue);
  const fieldMeta = await service.getFieldMeta();
  const remoteLinks = await service.getRemoteLinks(ticketKey);
  return { issue, comments, attachments, fieldMeta, remoteLinks };
}

describe('loadTicketToWorkspace (KTD8 integration)', () => {
  beforeEach(() => {
    resetFakeFiles();
  });

  it('writes ticket.md and comments.md, downloads eligible attachments, skips the rest, and git-ignores .jira-context/', async () => {
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      wsRoot,
    );

    // screenshot.png (image/png) and error.log (text/plain) are eligible; heap-dump.bin
    // (application/octet-stream, no matching extension) is not.
    expect(result.downloadedCount).toBe(2);
    expect(result.skipped).toEqual([
      expect.objectContaining({ filename: 'heap-dump.bin', reason: 'unknown binary format' }),
    ]);
    expect(result.writeErrors).toEqual([]);

    const ticketMd = new TextDecoder().decode(fakeFiles.get('/workspace/.jira-context/PROJ-123/ticket.md'));
    expect(ticketMd).toContain('# PROJ-123: Implement user authentication');
    expect(ticketMd).toContain('attachments/screenshot.png');
    expect(ticketMd).toContain('attachments/error.log');
    expect(ticketMd).not.toContain('attachments/heap-dump.bin');

    const commentsMd = new TextDecoder().decode(fakeFiles.get('/workspace/.jira-context/PROJ-123/comments.md'));
    expect(commentsMd).toContain('Please add unit tests for the token refresh flow.');

    expect(fakeFiles.has('/workspace/.jira-context/PROJ-123/attachments/screenshot.png')).toBe(true);
    expect(fakeFiles.has('/workspace/.jira-context/PROJ-123/attachments/error.log')).toBe(true);

    const gitignore = new TextDecoder().decode(fakeFiles.get('/workspace/.gitignore'));
    expect(gitignore).toContain('.jira-context/');
  });

  it('reports a per-attachment download failure in the skipped list with reason "download failed", without failing the whole load', async () => {
    const client = new MockJiraClient();
    client.downloadAttachment = async (contentUrl: string) => {
      if (contentUrl.includes('screenshot.png')) throw new Error('HTTP 500');
      return new Uint8Array([1]);
    };
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');

    const result = await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      wsRoot,
    );

    expect(result.downloadedCount).toBe(1); // error.log still downloads
    expect(result.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: 'screenshot.png', reason: 'download failed' })]),
    );
    expect(fakeFiles.has('/workspace/.jira-context/PROJ-123/attachments/screenshot.png')).toBe(false);
    expect(fakeFiles.has('/workspace/.jira-context/PROJ-123/attachments/error.log')).toBe(true);
  });

  it('leaves .jira-context/ out of .gitignore untouched when it is already present', async () => {
    fakeFiles.set('/workspace/.gitignore', new TextEncoder().encode('node_modules/\n.jira-context/\n'));
    const client = new MockJiraClient();
    const service = new TicketService(client);
    const { issue, comments, attachments, fieldMeta, remoteLinks } = await loadFixtureTicket(client, service, 'PROJ-123');

    await loadTicketToWorkspace(
      'PROJ-123', service,
      { issue, comments, attachments, remoteLinks },
      { fieldMeta, alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
      wsRoot,
    );

    const gitignore = new TextDecoder().decode(fakeFiles.get('/workspace/.gitignore'));
    expect(gitignore).toBe('node_modules/\n.jira-context/\n');
  });
});
