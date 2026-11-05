import { randomBytes, timingSafeEqual } from 'crypto';

// Access keys for the prototype's localhost server: 32 random bytes, base64url so they fit in a
// URL path segment and an HTTP header without escaping. A new pair is made at every start and
// never leaves memory except through the MCP server definition and the rendezvous file.

export function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison. A missing value or a length mismatch is a plain refusal. */
export function keysMatch(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
