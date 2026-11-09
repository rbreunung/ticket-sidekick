import { execFile } from 'child_process';
import { isSafePathSegment } from '../tools/pathSafety';
import { extractTicketId } from '../utils/branchParser';
import type { DiagLogger } from '../utils/diagTypes';

// The ticket key in the current git branch, for tools that take the key as optional. The branch
// is read in the first workspace folder, and the answer names that folder and branch, so in a
// multi-root workspace the agent can see which repository the key came from.

/** How long `git branch --show-current` may take before the lookup gives up. */
export const GIT_BRANCH_TIMEOUT_MS = 5000;

export type BranchTicket =
  | { kind: 'found'; folder: string; branch: string; key: string }
  /** `branch` is empty when the folder is not on a branch (a detached HEAD). */
  | { kind: 'no-key'; folder: string; branch: string }
  | { kind: 'git-failed'; folder: string; error: string }
  | { kind: 'no-folder' };

/** Runs `git branch --show-current` in `cwd` without a shell and resolves its trimmed output. */
export type BranchReader = (cwd: string) => Promise<string>;

export const readCurrentBranch: BranchReader = cwd =>
  new Promise((resolve, reject) => {
    execFile('git', ['branch', '--show-current'], { cwd, timeout: GIT_BRANCH_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim().split(/\r?\n/)[0];
        reject(new Error(detail || err.message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });

export async function ticketFromBranch(folders: readonly string[], readBranch: BranchReader = readCurrentBranch): Promise<BranchTicket> {
  const folder = folders[0];
  if (!folder) return { kind: 'no-folder' };
  let branch: string;
  try {
    branch = await readBranch(folder);
  } catch (err) {
    return { kind: 'git-failed', folder, error: err instanceof Error ? err.message : String(err) };
  }
  const key = branch ? extractTicketId(branch) : null;
  return key ? { kind: 'found', folder, branch, key } : { kind: 'no-key', folder, branch };
}

/** The line a result starts with when its key came from the branch. */
export function branchSourceNote(found: Extract<BranchTicket, { kind: 'found' }>): string {
  return `_Ticket key ${found.key} taken from the git branch \`${found.branch}\` of the workspace folder \`${found.folder}\`._`;
}

/**
 * Why no key could be taken from the branch, for a tool that was called without one. `toolName`
 * is the tool to call again with an explicit key.
 */
export function noBranchKeyMessage(result: Exclude<BranchTicket, { kind: 'found' }>, toolName: string): string {
  const retry = `Call ${toolName} again with a ticket key, e.g. PROJ-123.`;
  switch (result.kind) {
    case 'no-folder':
      return `No ticket key was given and no workspace folder is open, so no key could be taken from a git branch. ${retry}`;
    case 'git-failed':
      return `No ticket key was given, and the git branch of the workspace folder \`${result.folder}\` could not be read (${result.error.slice(0, 160)}). ${retry}`;
    case 'no-key':
      return result.branch
        ? `No ticket key was given, and the git branch \`${result.branch}\` of the workspace folder \`${result.folder}\` holds no ticket key. ${retry}`
        : `No ticket key was given, and the workspace folder \`${result.folder}\` is not on a git branch (detached HEAD), so it holds no ticket key. ${retry}`;
  }
}

export type ResolvedTicketKey =
  | {
    kind: 'key';
    key: string;
    /** The line the answer starts with, followed by a blank line, when the key came from the branch; empty otherwise. */
    sourceNote: string;
    /** How a failure names the ticket: the key, and when it came from the branch, that branch and folder. */
    failureSubject: string;
  }
  /** No usable key: `text` is the whole answer. */
  | { kind: 'answer'; text: string };

/**
 * The ticket key a tool works on: `ticketKey` when one was given, which must be a safe path
 * segment, or else the key in the git branch of the first of `folders`. `toolName` is the tool to
 * call again with an explicit key when the branch gives none.
 */
export async function resolveTicketKey(
  ticketKey: string | undefined,
  folders: readonly string[],
  toolName: string,
  onDiag?: DiagLogger,
  readBranch: BranchReader = readCurrentBranch,
): Promise<ResolvedTicketKey> {
  const explicit = ticketKey?.trim();
  if (explicit) {
    if (!isSafePathSegment(explicit)) return { kind: 'answer', text: `"${explicit}" is not a valid ticket key.` };
    return { kind: 'key', key: explicit, sourceNote: '', failureSubject: explicit };
  }
  const branch = await ticketFromBranch(folders, readBranch);
  if (branch.kind !== 'found') {
    if (branch.kind === 'git-failed') onDiag?.('warn', 'Could not read the git branch for a ticket key', { error: branch.error });
    return { kind: 'answer', text: noBranchKeyMessage(branch, toolName) };
  }
  return {
    kind: 'key',
    key: branch.key,
    sourceNote: `${branchSourceNote(branch)}\n\n`,
    failureSubject: `${branch.key} (taken from the git branch ${branch.branch} of the folder "${branch.folder}")`,
  };
}
