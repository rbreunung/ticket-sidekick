import * as fs from 'fs';
import * as path from 'path';

// Each VS Code window's copy of the extension leaves one note while its localhost server runs, so
// the canvas program (which runs in the Copilot runtime, outside every window) can find the window
// that holds a chat's folder and reach its server. A note holds the port, the per-start canvas key
// and the window's workspace folders, never a Jira token. On POSIX the folder is 0700 and each note
// 0600; on Windows they inherit the user profile's permissions.

export interface WindowNote {
  pid: number;
  port: number;
  canvasKey: string;
  workspaceFolders: string[];
  startedAt: string;
}

/** The folder of the window notes, under the Copilot home the runtime uses for this user. */
export function windowNotesDir(copilotHomeDir: string): string {
  return path.join(copilotHomeDir, 'ticket-sidekick', 'windows');
}

function noteFile(dir: string, pid: number): string {
  return path.join(dir, `window-${pid}.json`);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(path.dirname(dir), 0o700);
    await fs.promises.chmod(dir, 0o700);
  }
}

/** Writes this window's note through a temporary file renamed into place, so a reader never sees half a note. */
export async function writeNote(dir: string, note: WindowNote): Promise<void> {
  await ensurePrivateDir(dir);
  const target = noteFile(dir, note.pid);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temp, JSON.stringify(note), { mode: 0o600 });
    await fs.promises.rename(temp, target);
  } catch (err) {
    await fs.promises.rm(temp, { force: true });
    throw err;
  }
}

function isNote(value: unknown): value is WindowNote {
  const v = value as WindowNote;
  return typeof v === 'object' && v !== null
    && Number.isInteger(v.pid) && Number.isInteger(v.port)
    && typeof v.canvasKey === 'string' && Array.isArray(v.workspaceFolders)
    && v.workspaceFolders.every(f => typeof f === 'string') && typeof v.startedAt === 'string';
}

/** Every readable note; files that are not valid notes are named in `skipped`. */
export async function readNotes(dir: string): Promise<{ notes: WindowNote[]; skipped: string[] }> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return { notes: [], skipped: [] };
  }
  const notes: WindowNote[] = [];
  const skipped: string[] = [];
  for (const name of names.filter(n => /^window-\d+\.json$/.test(n)).sort()) {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
      if (isNote(parsed)) notes.push(parsed);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { notes, skipped };
}

/** Removes this window's note; a missing note is not an error. */
export async function removeNote(dir: string, pid: number): Promise<void> {
  await fs.promises.rm(noteFile(dir, pid), { force: true });
}

/** Whether a process with this id is running (EPERM still means it exists). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface NoteKeeperDeps {
  dir: string;
  pid: number;
  /** Port and canvas key while the server runs, else undefined. */
  access(): { port: number; canvasKey: string } | undefined;
  workspaceFolders(): string[];
  onError(message: string): void;
}

/**
 * Keeps this window's note in step with its server: written while the server runs, rewritten when
 * the workspace folders change, removed when it stops. Changes run one after another, so a late
 * write never lands after the removal that followed it.
 */
export class WindowNoteKeeper {
  private queue: Promise<void> = Promise.resolve();
  private startedAt: string | undefined;

  constructor(private readonly deps: NoteKeeperDeps) {}

  /** Brings the note in line with the server as it is now. */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      const access = this.deps.access();
      if (!access) {
        this.startedAt = undefined;
        await removeNote(this.deps.dir, this.deps.pid);
        return;
      }
      this.startedAt ??= new Date().toISOString();
      await writeNote(this.deps.dir, {
        pid: this.deps.pid,
        port: access.port,
        canvasKey: access.canvasKey,
        workspaceFolders: this.deps.workspaceFolders(),
        startedAt: this.startedAt,
      });
    });
  }

  /** Removes the note, whatever the server's state. */
  remove(): Promise<void> {
    return this.enqueue(async () => {
      this.startedAt = undefined;
      await removeNote(this.deps.dir, this.deps.pid);
    });
  }

  /** Settles once every change asked for so far has been written or removed. */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(operation).catch(err => {
      this.deps.onError(err instanceof Error ? err.message : String(err));
    });
    this.queue = run;
    return run;
  }
}
