import * as path from 'path';
import type { WindowNote } from './windowNotes';

// Which running VS Code window serves a canvas for a chat. The canvas request carries the chat's
// working folder; the window whose workspace folder holds it wins, the most specific folder when
// several do. No match means no window: another workspace's settings are never used by guess.

export type WindowChoice =
  | { kind: 'selected'; note: WindowNote }
  | { kind: 'no-match' }
  | { kind: 'not-running' };

function pathsFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalize(p: string, platform: NodeJS.Platform): string {
  const resolved = pathsFor(platform).resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function holds(folder: string, target: string, platform: NodeJS.Platform): boolean {
  const sep = pathsFor(platform).sep;
  const f = normalize(folder, platform);
  const t = normalize(target, platform);
  return t === f || t.startsWith(f.endsWith(sep) ? f : f + sep);
}

export function selectWindow(
  notes: readonly WindowNote[],
  workingDirectory: string | undefined,
  isAlive: (pid: number) => boolean,
  platform: NodeJS.Platform = process.platform,
): WindowChoice {
  const live = notes.filter(n => isAlive(n.pid));
  if (live.length === 0) return { kind: 'not-running' };
  if (!workingDirectory) return { kind: 'no-match' };

  let best: { note: WindowNote; length: number } | undefined;
  for (const note of live) {
    for (const folder of note.workspaceFolders) {
      if (holds(folder, workingDirectory, platform) && (!best || folder.length > best.length)) {
        best = { note, length: folder.length };
      }
    }
  }
  return best ? { kind: 'selected', note: best.note } : { kind: 'no-match' };
}
