import { createHash, randomBytes, timingSafeEqual } from 'crypto';

// The bearer key of the localhost MCP server: 32 random bytes, base64url so it fits in an HTTP
// header without escaping. A new key is made at every start and leaves memory only through the
// MCP server definition handed to VS Code.

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

/**
 * A short fingerprint of a key: the first 8 hex characters of its SHA-256. Used to recognise a
 * key from an earlier start without keeping the key itself.
 */
export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
}
