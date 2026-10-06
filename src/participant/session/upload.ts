// `@jira upload` session shapes and message builders.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { extractTicketId } from '../../utils/branchParser';
import { formatFileSize } from '../../utils/attachmentEligibility';
import { buildChatCommandLink } from './primitives';

// ---------------------------------------------------------------------------------------------
// U1 (upload-attachment-to-ticket plan): `@jira upload` chat flow session shapes. R7's size check
// runs before either session below is built, so every pending file here is already known to be at
// or under `MAX_ATTACHMENT_BYTES` — see `uploadHandler.ts`'s `handleUploadAttachment`.
// ---------------------------------------------------------------------------------------------

/** One file resolved and read, ready to upload once a ticket is confirmed. `contentType` is
 * inferred from the file extension (generic `application/octet-stream` fallback), matching how
 * `emlParser.ts`'s attachment parsing already infers it for email attachments. */
export interface PendingUploadFile {
  name: string;
  size: number;
  contentType: string;
  base64Content: string;
  // Code-review fix: the full resolved local path this file was read from, shown on the
  // confirmation (buildUploadConfirmationMessage) so a user approving an upload can see exactly
  // where the file came from — `name` alone (a bare basename) hides an unexpected source
  // location, e.g. a path resolved from outside the workspace.
  sourcePath: string;
}

/** R6/KTD3: the pre-upload confirmation, mirroring `TransitionBatchSession`'s confirm/cancel
 * `buildChatCommandLink` pattern — VS Code's native tool-confirmation dialog only exists for
 * Language Model tool calls, not natural-language chat turns. */
export interface UploadReviewSession {
  ticketKey: string;
  files: PendingUploadFile[];
  schemaVersion: number;
}

/** R5/KTD4: sibling to `AwaitIssueTypeSession` — a plain free-text ask for the ticket key when
 * `resolveTicketKeyForUpload()` found none, carrying the already-resolved file(s) so the resuming
 * turn can go straight to the `UploadReviewSession` confirmation once a key arrives. */
export interface AwaitUploadTicketSession {
  files: PendingUploadFile[];
  schemaVersion: number;
}

/** R4/KTD1: resolves the target ticket key by checking, in order, the message text, the resolved
 * file's name, then the ticket last referenced in the current chat session — never guessing beyond
 * these three sources. Reuses `extractTicketId()` (the same canonical `[A-Z][A-Z0-9]+-\d+` matcher
 * `branchParser.ts` uses for branch names) for both text and filename checks. */
export function resolveTicketKeyForUpload(
  promptText: string,
  resolvedFilename: string,
  lastTicketKey: string | null,
): string | null {
  return extractTicketId(promptText) ?? extractTicketId(resolvedFilename) ?? lastTicketKey;
}

/** R6: renders the pre-upload confirmation naming each file's name and size plus the target
 * ticket, with Confirm/Cancel `buildChatCommandLink`s — parsed on reply via the shared
 * `isConfirmation()`/`isCancellation()` (KTD3: no new confirm/cancel vocabulary). */
export function buildUploadConfirmationMessage(
  ticketKey: string,
  files: Array<{ name: string; size: number; sourcePath: string }>,
): string {
  const fileLines = files.map((f) => `- **${f.name}** (${formatFileSize(f.size)}) — \`${f.sourcePath}\``).join('\n');
  const confirm = buildChatCommandLink('Confirm', '@jira', 'confirm');
  const cancel = buildChatCommandLink('Cancel', '@jira', 'cancel');
  return `Upload the following to **${ticketKey}**?\n\n${fileLines}\n\n${confirm} · ${cancel}`;
}

/** R8: renders each file's own upload outcome — used by both the multi-file picker path and a
 * multi-file chat-attachment batch. */
export function buildUploadResultMessage(
  ticketKey: string,
  results: Array<{ name: string; ok: boolean; error?: string }>,
): string {
  const lines = results.map((r) => (r.ok ? `- **${r.name}**: uploaded` : `- **${r.name}**: failed — ${r.error}`));
  return `Upload to **${ticketKey}**:\n\n${lines.join('\n')}`;
}
