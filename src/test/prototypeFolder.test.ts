import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  copilotHome, prototypeFolderPath, placeLauncher, writeEntry, readEntries, removeEntry, removeFolder,
  type RendezvousEntry,
} from '../prototype/prototypeFolder';
import { selectWindow } from '../prototype/selectWindow';

const posix = process.platform !== 'win32';
let tmp: string;
let source: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-proto-'));
  source = path.join(tmp, 'bundle');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'extension.mjs'), 'export {};');
  fs.writeFileSync(path.join(source, 'package.json'), '{"type":"module","main":"extension.mjs"}');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function entry(pid: number, folders: string[] = []): RendezvousEntry {
  return { pid, port: 40000 + pid, canvasKey: `key-${pid}`, workspaceFolders: folders, startedAt: '2026-11-05T12:00:00Z' };
}

describe('copilotHome / prototypeFolderPath', () => {
  it('uses COPILOT_HOME when set and ~/.copilot otherwise', () => {
    expect(copilotHome({ COPILOT_HOME: '/custom' }, '/home/u')).toBe('/custom');
    expect(copilotHome({}, '/home/u')).toBe(path.join('/home/u', '.copilot'));
    expect(prototypeFolderPath('/custom')).toBe(path.join('/custom', 'extensions', 'ticket-sidekick'));
  });
});

describe('prototype folder', () => {
  it('places the launcher and writes this window’s entry with user-only permissions', async () => {
    const folder = path.join(tmp, 'extensions', 'ticket-sidekick');
    await placeLauncher(folder, source);
    await writeEntry(folder, entry(101, ['/work/a']));
    expect(fs.existsSync(path.join(folder, 'extension.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'package.json'))).toBe(true);
    const { entries } = await readEntries(folder);
    expect(entries).toEqual([entry(101, ['/work/a'])]);
    if (posix) {
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(folder, 'rendezvous')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(folder, 'rendezvous', 'window-101.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the folder while another window’s live entry remains', async () => {
    const folder = path.join(tmp, 'ts');
    await placeLauncher(folder, source);
    await writeEntry(folder, entry(101));
    await writeEntry(folder, entry(202));
    const result = await removeEntry(folder, 101, pid => pid === 202);
    expect(result.folderRemoved).toBe(false);
    expect((await readEntries(folder)).entries.map(e => e.pid)).toEqual([202]);
  });

  it('deletes the whole folder when the last live entry goes', async () => {
    const folder = path.join(tmp, 'ts');
    await placeLauncher(folder, source);
    await writeEntry(folder, entry(101));
    await writeEntry(folder, entry(303));
    const result = await removeEntry(folder, 101, () => false);
    expect(result.folderRemoved).toBe(true);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('skips a corrupt entry without losing the others', async () => {
    const folder = path.join(tmp, 'ts');
    await placeLauncher(folder, source);
    await writeEntry(folder, entry(101));
    fs.writeFileSync(path.join(folder, 'rendezvous', 'window-999.json'), '{not json');
    const { entries, skipped } = await readEntries(folder);
    expect(entries.map(e => e.pid)).toEqual([101]);
    expect(skipped).toEqual(['window-999.json']);
  });

  it('reads no entries from a folder that does not exist', async () => {
    expect(await readEntries(path.join(tmp, 'missing'))).toEqual({ entries: [], skipped: [] });
  });

  it('removes the folder on request even when entries remain', async () => {
    const folder = path.join(tmp, 'ts');
    await placeLauncher(folder, source);
    await writeEntry(folder, entry(101));
    expect(await removeFolder(folder)).toBe(true);
    expect(fs.existsSync(folder)).toBe(false);
    expect(await removeFolder(folder)).toBe(false);
  });
});

describe('selectWindow', () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  it('ignores an entry whose process is gone', () => {
    const result = selectWindow([entry(1, ['/work/a'])], '/work/a', alive([]));
    expect(result).toEqual({ kind: 'not-running' });
  });

  it('picks the window whose workspace folder holds the session’s working directory', () => {
    const entries = [entry(1, ['/work/a']), entry(2, ['/work/b'])];
    const result = selectWindow(entries, '/work/b/sub', alive([1, 2]));
    expect(result).toMatchObject({ kind: 'selected', entry: { pid: 2 }, reason: 'workspace-match' });
  });

  it('prefers the most specific matching folder', () => {
    const entries = [entry(1, ['/work']), entry(2, ['/work/b'])];
    expect(selectWindow(entries, '/work/b', alive([1, 2]))).toMatchObject({ kind: 'selected', entry: { pid: 2 } });
  });

  it('does not treat a sibling folder with a common prefix as a match', () => {
    const entries = [entry(1, ['/work/a']), entry(2, ['/work/b'])];
    expect(selectWindow(entries, '/work/ab', alive([1, 2]))).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('falls back to the only live window when nothing matches', () => {
    const result = selectWindow([entry(1, ['/work/a']), entry(2, ['/x'])], '/elsewhere', alive([2]));
    expect(result).toMatchObject({ kind: 'selected', entry: { pid: 2 }, reason: 'single-window' });
  });

  it('reports ambiguity instead of guessing between unmatched windows', () => {
    const result = selectWindow([entry(1, ['/a']), entry(2, ['/b'])], undefined, alive([1, 2]));
    expect(result).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('reports not running when there is no entry', () => {
    expect(selectWindow([], '/work', alive([]))).toEqual({ kind: 'not-running' });
  });
});
