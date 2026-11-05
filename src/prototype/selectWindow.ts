import * as path from 'path';
import type { RendezvousEntry } from './prototypeFolder';

// Which running VS Code window a canvas request belongs to. The canvas request carries the chat
// session's working directory; the window whose workspace folder contains it wins (the most
// specific folder when several do). With no match, the only live window is used; with several
// unmatched windows the answer is "ambiguous" rather than a guess.

export type WindowChoice =
  | { kind: 'selected'; entry: RendezvousEntry; reason: 'workspace-match' | 'single-window' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'not-running' };

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function contains(folder: string, target: string): boolean {
  const f = normalize(folder);
  const t = normalize(target);
  return t === f || t.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
}

export function selectWindow(
  entries: RendezvousEntry[],
  workingDirectory: string | undefined,
  isAlive: (pid: number) => boolean,
): WindowChoice {
  const live = entries.filter(e => isAlive(e.pid));
  if (live.length === 0) return { kind: 'not-running' };

  if (workingDirectory) {
    let best: { entry: RendezvousEntry; length: number } | undefined;
    for (const entry of live) {
      for (const folder of entry.workspaceFolders) {
        if (contains(folder, workingDirectory) && (!best || folder.length > best.length)) {
          best = { entry, length: folder.length };
        }
      }
    }
    if (best) return { kind: 'selected', entry: best.entry, reason: 'workspace-match' };
  }

  if (live.length === 1) return { kind: 'selected', entry: live[0], reason: 'single-window' };
  return { kind: 'ambiguous', count: live.length };
}
