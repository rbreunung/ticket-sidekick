import * as fs from 'fs';
import * as path from 'path';

// The one folder the prototype owns outside VS Code: the canvas launcher the Copilot runtime
// loads, plus one rendezvous file per running VS Code window (port and canvas key, never a Jira
// token). Keeping both in one folder makes cleanup a single delete. On POSIX the folders are
// 0700 and files 0600; on Windows they inherit the user profile's permissions.

export interface RendezvousEntry {
  pid: number;
  port: number;
  canvasKey: string;
  workspaceFolders: string[];
  startedAt: string;
}

export const PROTOTYPE_FOLDER_NAME = 'ticket-sidekick';
const RENDEZVOUS_DIR = 'rendezvous';
const LAUNCHER_FILES = ['extension.mjs', 'package.json'];
export const LAUNCHER_LOG = 'launcher-log.jsonl';

/** The Copilot home the runtime reads user-scope configuration from. */
export function copilotHome(env: NodeJS.ProcessEnv, homedir: string): string {
  const custom = env.COPILOT_HOME?.trim();
  return custom ? custom : path.join(homedir, '.copilot');
}

export function prototypeFolderPath(copilotHomeDir: string): string {
  return path.join(copilotHomeDir, 'extensions', PROTOTYPE_FOLDER_NAME);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.promises.chmod(dir, 0o700);
}

/** Copies the bundled launcher files into the folder. */
export async function placeLauncher(folder: string, sourceDir: string): Promise<void> {
  await ensurePrivateDir(folder);
  for (const name of LAUNCHER_FILES) {
    await fs.promises.copyFile(path.join(sourceDir, name), path.join(folder, name));
    if (process.platform !== 'win32') await fs.promises.chmod(path.join(folder, name), 0o600);
  }
}

function entryFile(folder: string, pid: number): string {
  return path.join(folder, RENDEZVOUS_DIR, `window-${pid}.json`);
}

/** Writes this window's entry: a temporary file renamed into place, so a reader never sees half a file. */
export async function writeEntry(folder: string, entry: RendezvousEntry): Promise<void> {
  const dir = path.join(folder, RENDEZVOUS_DIR);
  await ensurePrivateDir(dir);
  const target = entryFile(folder, entry.pid);
  const temp = `${target}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(entry), { mode: 0o600 });
  await fs.promises.rename(temp, target);
}

function isEntry(value: unknown): value is RendezvousEntry {
  const v = value as RendezvousEntry;
  return typeof v === 'object' && v !== null
    && Number.isInteger(v.pid) && Number.isInteger(v.port)
    && typeof v.canvasKey === 'string' && Array.isArray(v.workspaceFolders)
    && v.workspaceFolders.every(f => typeof f === 'string') && typeof v.startedAt === 'string';
}

/** Every readable entry; files that are not valid entries are named in `skipped`. */
export async function readEntries(folder: string): Promise<{ entries: RendezvousEntry[]; skipped: string[] }> {
  const dir = path.join(folder, RENDEZVOUS_DIR);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return { entries: [], skipped: [] };
  }
  const entries: RendezvousEntry[] = [];
  const skipped: string[] = [];
  for (const name of names.filter(n => /^window-\d+\.json$/.test(n)).sort()) {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
      if (isEntry(parsed)) entries.push(parsed);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { entries, skipped };
}

/**
 * Removes this window's entry, and the whole folder when no other window's entry belongs to a
 * live process.
 */
export async function removeEntry(folder: string, pid: number, isAlive: (pid: number) => boolean): Promise<{ folderRemoved: boolean }> {
  await fs.promises.rm(entryFile(folder, pid), { force: true });
  const { entries } = await readEntries(folder);
  if (entries.some(e => e.pid !== pid && isAlive(e.pid))) return { folderRemoved: false };
  return { folderRemoved: await removeFolder(folder) };
}

/** Deletes the folder and everything in it. Returns whether there was anything to delete. */
export async function removeFolder(folder: string): Promise<boolean> {
  try {
    await fs.promises.access(folder);
  } catch {
    return false;
  }
  await fs.promises.rm(folder, { recursive: true, force: true });
  return true;
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
