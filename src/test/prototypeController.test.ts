import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PrototypeController, type ControllerDeps } from '../prototype/prototypeController';
import { readEntries } from '../prototype/prototypeFolder';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

let tmp: string;
let controller: PrototypeController | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ctrl-'));
  const source = path.join(tmp, 'bundle');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'extension.mjs'), 'export {};');
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
});

afterEach(async () => {
  await controller?.stop();
  controller = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function make(overrides: Partial<ControllerDeps> = {}): { controller: PrototypeController; folder: string; changes: number[] } {
  const folder = path.join(tmp, 'copilot', 'extensions', 'ticket-sidekick');
  const changes: number[] = [];
  const c = new PrototypeController({
    getJira: async () => ({ configured: true, ticketService: new TicketService(new MockJiraClient()), baseUrl: 'https://jira.example' }),
    getProjectKey: () => 'PROJ',
    confirmWrite: async () => false,
    workspaceFolders: () => ['/work/a'],
    launcherSourceDir: path.join(tmp, 'bundle'),
    prototypeFolder: folder,
    pid: 4242,
    isAlive: () => false,
    ...overrides,
  });
  c.onDidChange(() => changes.push(changes.length));
  controller = c;
  return { controller: c, folder, changes };
}

describe('PrototypeController', () => {
  it('starts stopped, with no MCP server to offer and no folder on disk', () => {
    const { controller: c, folder } = make();
    expect(c.isRunning()).toBe(false);
    expect(c.mcpDefinition()).toBeUndefined();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('on start places the launcher, writes this window’s entry and offers an HTTP definition with a bearer header', async () => {
    const { controller: c, folder, changes } = make();
    await c.start();
    const definition = c.mcpDefinition();
    expect(definition?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(definition?.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(fs.existsSync(path.join(folder, 'extension.mjs'))).toBe(true);
    const { entries } = await readEntries(folder);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pid: 4242, port: c.port(), workspaceFolders: ['/work/a'] });
    expect(changes).toHaveLength(1);
  });

  it('uses new keys after a stop and a new start', async () => {
    const { controller: c } = make();
    await c.start();
    const first = c.mcpDefinition()?.headers.Authorization;
    await c.stop();
    await c.start();
    expect(c.mcpDefinition()?.headers.Authorization).not.toBe(first);
  });

  it('on stop closes the server, removes the folder and offers no definition', async () => {
    const { controller: c, folder, changes } = make();
    await c.start();
    const port = c.port();
    const result = await c.stop();
    expect(result.folderRemoved).toBe(true);
    expect(fs.existsSync(folder)).toBe(false);
    expect(c.mcpDefinition()).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
    expect(changes).toHaveLength(2);
  });

  it('keeps the folder on stop while another live window still uses it', async () => {
    const { controller: c, folder } = make({ isAlive: pid => pid === 7777 });
    await c.start();
    fs.writeFileSync(path.join(folder, 'rendezvous', 'window-7777.json'), JSON.stringify({
      pid: 7777, port: 1, canvasKey: 'k', workspaceFolders: [], startedAt: 'x',
    }));
    expect((await c.stop()).folderRemoved).toBe(false);
    expect(fs.existsSync(path.join(folder, 'extension.mjs'))).toBe(true);
  });

  it('stop while stopped does nothing and announces nothing', async () => {
    const { controller: c, changes } = make();
    await expect(c.stop()).resolves.toEqual({ folderRemoved: false });
    expect(changes).toEqual([]);
  });

  it('remove leftovers stops the prototype and deletes every given folder', async () => {
    const { controller: c, folder } = make();
    await c.start();
    const other = path.join(tmp, 'other-home', 'extensions', 'ticket-sidekick');
    fs.mkdirSync(other, { recursive: true });
    const removed = await c.removeLeftovers([folder, other, path.join(tmp, 'never')]);
    expect(c.isRunning()).toBe(false);
    expect(removed.sort()).toEqual([other].sort());
    expect(fs.existsSync(folder)).toBe(false);
    expect(fs.existsSync(other)).toBe(false);
  });

  it('starts only one server when start is triggered twice at once', async () => {
    const { controller: c, changes } = make();
    await Promise.all([c.start(), c.start()]);
    const port = c.port();
    await c.stop();
    expect(changes).toHaveLength(2);
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow();
  });

  it('rolls back the server when the launcher cannot be placed', async () => {
    const { controller: c } = make({ launcherSourceDir: path.join(tmp, 'missing') });
    await expect(c.start()).rejects.toThrow();
    expect(c.isRunning()).toBe(false);
    expect(c.mcpDefinition()).toBeUndefined();
  });
});
