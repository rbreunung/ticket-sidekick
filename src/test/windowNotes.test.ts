import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isProcessAlive, readNotes, removeNote, windowNotesDir, WindowNoteKeeper, writeNote, type WindowNote } from '../canvas/windowNotes';

// The window notes the canvas program reads to find a window's server: written while the server
// runs, private to the user, and never half-written.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function notesDir(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-notes-'));
  dirs.push(home);
  return windowNotesDir(home);
}

function note(overrides: Partial<WindowNote> = {}): WindowNote {
  return { pid: 4711, port: 52344, canvasKey: 'k'.repeat(43), workspaceFolders: ['/work/payments'], startedAt: '2026-11-11T10:00:00.000Z', ...overrides };
}

describe('window notes', () => {
  it('writes a note with port, canvas key, folders and start time, readable only by the user', async () => {
    const dir = notesDir();
    await writeNote(dir, note());
    expect(fs.readdirSync(dir)).toEqual(['window-4711.json']);
    expect((await readNotes(dir)).notes).toEqual([note()]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'window-4711.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('replaces a note for the same process without leaving a temporary file', async () => {
    const dir = notesDir();
    await writeNote(dir, note());
    await writeNote(dir, note({ port: 60000 }));
    expect(fs.readdirSync(dir)).toEqual(['window-4711.json']);
    expect((await readNotes(dir)).notes[0].port).toBe(60000);
  });

  it('removes only this window\'s note', async () => {
    const dir = notesDir();
    await writeNote(dir, note());
    await writeNote(dir, note({ pid: 815 }));
    await removeNote(dir, 4711);
    expect((await readNotes(dir)).notes.map(n => n.pid)).toEqual([815]);
  });

  it('skips and names a malformed note instead of failing', async () => {
    const dir = notesDir();
    await writeNote(dir, note());
    fs.writeFileSync(path.join(dir, 'window-1.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'window-2.json'), JSON.stringify({ pid: 2 }));
    const { notes, skipped } = await readNotes(dir);
    expect(notes.map(n => n.pid)).toEqual([4711]);
    expect(skipped).toEqual(['window-1.json', 'window-2.json']);
  });

  it('reads no notes when the folder does not exist yet', async () => {
    expect(await readNotes(path.join(notesDir(), 'missing'))).toEqual({ notes: [], skipped: [] });
  });

  it('tells a running process from one that has ended', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('the note keeper', () => {
  function keeper(dir: string, state: { access?: { port: number; canvasKey: string }; folders: string[] }, errors: string[] = []) {
    return new WindowNoteKeeper({
      dir, pid: 4711, access: () => state.access, workspaceFolders: () => state.folders, onError: m => errors.push(m),
    });
  }

  it('writes the note while the server runs and removes it when it stops', async () => {
    const dir = notesDir();
    const state: { access?: { port: number; canvasKey: string }; folders: string[] } = { access: { port: 52344, canvasKey: 'k'.repeat(43) }, folders: ['/work/payments'] };
    const k = keeper(dir, state);
    await k.sync();
    expect((await readNotes(dir)).notes[0]).toMatchObject({ pid: 4711, port: 52344, workspaceFolders: ['/work/payments'] });
    state.access = undefined;
    await k.sync();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('lists a folder added while the server runs, and drops a removed one', async () => {
    const dir = notesDir();
    const state = { access: { port: 52344, canvasKey: 'k'.repeat(43) }, folders: ['/work/payments'] };
    const k = keeper(dir, state);
    await k.sync();
    const startedAt = (await readNotes(dir)).notes[0].startedAt;
    state.folders = ['/work/portal'];
    await k.sync();
    const rewritten = (await readNotes(dir)).notes[0];
    expect(rewritten.workspaceFolders).toEqual(['/work/portal']);
    expect(rewritten.startedAt).toBe(startedAt);
  });

  it('reports a failed write instead of throwing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-notes-'));
    dirs.push(home);
    fs.writeFileSync(path.join(home, 'ticket-sidekick'), 'a file where the folder should be');
    const errors: string[] = [];
    await keeper(windowNotesDir(home), { access: { port: 1, canvasKey: 'k'.repeat(43) }, folders: [] }, errors).sync();
    expect(errors).toHaveLength(1);
  });
});
