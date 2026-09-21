import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Rejects an identifier that could escape the REST path segment it's interpolated into.
 * `JiraApiClient`/`BitbucketApiClient` build request URLs via template-literal interpolation of
 * ticket keys, project keys, and repo slugs — not `encodeURIComponent` — so a value containing
 * `/`, `\`, or `..` could redirect the request to an unintended endpoint on the same host. Every
 * Language Model tool that builds a path from LLM-supplied input validates it against this before
 * use, since `invoke()` — not the confirmation dialog — is a tool's real safety boundary (KTD1);
 * the equivalent chat-flow inputs go through the same client methods, but a human typing into
 * chat is a materially different trust boundary than an autonomously LLM-supplied tool argument.
 */
export function isSafePathSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

/**
 * Rejects a value unsafe to use as a single filesystem path segment (e.g. joined under
 * `.jira-context/<ticketKey>/attachments/`) — deliberately more permissive than
 * `isSafePathSegment` above. That function rejects any `..` *substring* because a ticket/project
 * key is interpolated into a REST URL path, where a bare `..` substring is already suspicious.
 * A filename has no such constraint: without `/` or `\` it is inherently a single segment, so
 * the only values with directory-traversal meaning are the literal segments `.` and `..`
 * themselves — a real, unremarkable filename like `v1..2-notes.txt` must not be rejected just
 * because it contains that substring (code-review fix).
 */
export function isSafeFilename(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

/**
 * Security fix (upload-attachment-to-ticket plan, code-review P0/P1): an explicit `filePath` for
 * `@jira upload`/`jira_uploadAttachment` is either LLM-supplied (Agent Mode, autonomously chosen
 * from a prompt) or free-text-typed in chat — either way it's untrusted input that ends up read
 * off the local filesystem and sent to Jira, so an attacker-influenced prompt could otherwise
 * exfiltrate an arbitrary file the VS Code process can read (e.g. `~/.ssh/id_rsa`, `~/.aws/credentials`).
 * Restricts explicit upload paths to: (1) resolving inside the user's home directory, via
 * `fs.realpathSync` so a symlink can't point back out, and (2) containing no dotfile/dotdir path
 * segment (`.ssh`, `.aws`, `.env`, `.git`, ...), which is where most sensitive local files live.
 * Deliberately does NOT apply to file-picker, active-editor, or chat-attachment-reference paths —
 * those come from a human clicking/selecting in the VS Code UI, not from text a prompt can steer.
 */
export function isAllowedUploadPath(candidatePath: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(candidatePath);
  } catch {
    real = path.resolve(candidatePath);
  }
  const homeDir = path.resolve(os.homedir());
  const rel = path.relative(homeDir, real);
  const withinHome = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!withinHome) return false;
  return !real.split(path.sep).some((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg.startsWith('.'));
}
