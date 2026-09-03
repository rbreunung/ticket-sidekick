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
