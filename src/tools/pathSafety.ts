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
