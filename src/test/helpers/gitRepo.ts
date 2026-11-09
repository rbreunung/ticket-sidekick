import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Throwaway folders for tests that need a workspace folder, optionally a git repository on a
// given branch. `removeTempDirs()` deletes every folder made since the last call.

const made: string[] = [];

export function makeTempDir(prefix = 'ts-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A new git repository whose HEAD names `branch` (no commit needed for `git branch --show-current`). */
export function makeRepoOnBranch(branch: string): string {
  const dir = makeTempDir('ts-branch-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir });
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
