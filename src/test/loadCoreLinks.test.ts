import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadTicketToWorkspace, nodeFsWriter } from '../participant/jira/loadCore';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeTempDir, removeTempDirs } from './helpers/gitRepo';

// Load writes into `.jira-context/<KEY>/` on disk. A link planted in that folder (by a cloned
// repository or a tool with terminal access) must never let a load write outside it, while a
// `.jira-context` that the user links somewhere else on purpose keeps working. Every test keeps an
// outside "sentinel" file and checks that it is unchanged.

const SENTINEL = 'outside file, must not change\n';

afterEach(() => removeTempDirs());

async function loadInto(folder: string) {
  const client = new MockJiraClient();
  const service = new TicketService(client);
  const issue = await service.getIssue('PROJ-123');
  return loadTicketToWorkspace(
    'PROJ-123', service,
    {
      issue,
      comments: await service.getAllComments('PROJ-123'),
      attachments: service.getAttachments(issue),
      remoteLinks: await service.getRemoteLinks('PROJ-123'),
    },
    { fieldMeta: await service.getFieldMeta(), alwaysShowIds: new Set(), hiddenIds: new Set(), baseUrl: 'https://jira.example.com' },
    nodeFsWriter(folder),
  );
}

/** An outside folder holding the sentinel file. */
function outside(): { dir: string; file: string } {
  const dir = makeTempDir('ts-outside-');
  const file = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(file, SENTINEL);
  return { dir, file };
}

/** Creates a file link, or returns false where this system does not allow it (Windows without developer mode). */
function tryFileLink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('loading a ticket next to links on disk', () => {
  it('replaces a linked attachment file instead of writing through it', async ctx => {
    const folder = makeTempDir();
    const ext = outside();
    const attachments = path.join(folder, '.jira-context', 'PROJ-123', 'attachments');
    fs.mkdirSync(attachments, { recursive: true });
    if (!tryFileLink(ext.file, path.join(attachments, 'error.log'))) ctx.skip();

    await loadInto(folder);

    expect(fs.readFileSync(ext.file, 'utf-8')).toBe(SENTINEL);
    expect(fs.lstatSync(path.join(attachments, 'error.log')).isSymbolicLink()).toBe(false);
  });

  it('replaces a linked ticket.md or comments.md instead of writing through it', async ctx => {
    const folder = makeTempDir();
    const ext = outside();
    const ticketDir = path.join(folder, '.jira-context', 'PROJ-123');
    fs.mkdirSync(ticketDir, { recursive: true });
    if (!tryFileLink(ext.file, path.join(ticketDir, 'ticket.md'))) ctx.skip();
    tryFileLink(ext.file, path.join(ticketDir, 'comments.md'));

    const result = await loadInto(folder);

    expect(fs.readFileSync(ext.file, 'utf-8')).toBe(SENTINEL);
    expect(result.writeErrors).toEqual([]);
    expect(fs.readFileSync(path.join(ticketDir, 'ticket.md'), 'utf-8')).toContain('# PROJ-123');
  });

  it('refuses to load when the attachments folder is a link, and writes nothing through it', async () => {
    const folder = makeTempDir();
    const ext = outside();
    const ticketDir = path.join(folder, '.jira-context', 'PROJ-123');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.symlinkSync(ext.dir, path.join(ticketDir, 'attachments'), 'junction');

    await expect(loadInto(folder)).rejects.toThrow(/\.jira-context\/PROJ-123\/attachments is a link/);

    expect(fs.readdirSync(ext.dir)).toEqual(['sentinel.txt']);
    expect(fs.existsSync(path.join(ticketDir, 'ticket.md'))).toBe(false);
  });

  it('refuses to load when the ticket folder is a link', async () => {
    const folder = makeTempDir();
    const ext = outside();
    fs.mkdirSync(path.join(folder, '.jira-context'), { recursive: true });
    fs.symlinkSync(ext.dir, path.join(folder, '.jira-context', 'PROJ-123'), 'junction');

    await expect(loadInto(folder)).rejects.toThrow(/\.jira-context\/PROJ-123 is a link/);

    expect(fs.readdirSync(ext.dir)).toEqual(['sentinel.txt']);
  });

  it('loads into a .jira-context that the user linked to another folder', async () => {
    const folder = makeTempDir();
    const elsewhere = makeTempDir('ts-context-');
    fs.symlinkSync(elsewhere, path.join(folder, '.jira-context'), 'junction');

    const result = await loadInto(folder);

    expect(result.writeErrors).toEqual([]);
    expect(fs.readFileSync(path.join(elsewhere, 'PROJ-123', 'ticket.md'), 'utf-8')).toContain('# PROJ-123');
    expect(fs.existsSync(path.join(elsewhere, 'PROJ-123', 'attachments', 'error.log'))).toBe(true);
  });

  it('leaves a linked .gitignore alone instead of copying its target into the workspace', async ctx => {
    const folder = makeTempDir();
    const ext = outside();
    if (!tryFileLink(ext.file, path.join(folder, '.gitignore'))) ctx.skip();

    const result = await loadInto(folder);

    expect(result.gitignoreUpdated).toBe(false);
    expect(fs.readFileSync(ext.file, 'utf-8')).toBe(SENTINEL);
    expect(fs.lstatSync(path.join(folder, '.gitignore')).isSymbolicLink()).toBe(true);
  });

  it('still writes every file into a plain folder and leaves no temporary files behind', async () => {
    const folder = makeTempDir();

    const result = await loadInto(folder);

    expect(result.writeErrors).toEqual([]);
    const ticketDir = path.join(folder, '.jira-context', 'PROJ-123');
    expect(fs.readdirSync(ticketDir).sort()).toEqual(['attachments', 'comments.md', 'ticket.md']);
    expect(fs.readdirSync(path.join(ticketDir, 'attachments')).sort()).toEqual(['error.log', 'screenshot.png']);
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf-8')).toBe('.jira-context/\n');
  });
});
