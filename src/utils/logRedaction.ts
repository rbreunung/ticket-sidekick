/**
 * Redaction/truncation applied automatically inside `logDiag` (see
 * `diagLog.ts`) before any `details` object is written to the shared Output
 * Channel — no call site needs to remember to do this itself. Guards
 * against secrets and oversized ticket/PR/email content ending up in a
 * plain-text, on-screen log.
 */
const SENSITIVE_WORDS = new Set(['token', 'authorization', 'password', 'secret', 'credential', 'bearer']);

/**
 * A key is sensitive if it exactly equals one of the known secret-shaped
 * words after splitting on case/separator boundaries (so "authToken" and
 * "api_key" redact, but "authType" and "maxInputTokens" — which merely
 * contain "auth"/"token" as a substring — do not). "apiKey" is handled as
 * a special compound case rather than by adding the generic word "key" to
 * SENSITIVE_WORDS, which would incorrectly redact fields like "issueKey".
 */
function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  const collapsed = key.toLowerCase().replace(/[_-]/g, '');
  return collapsed.includes('apikey');
}

export const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 4;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated, ${value.length} chars total]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    const capped = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      capped.push(`…${value.length - MAX_ARRAY_LENGTH} more`);
    }
    return capped;
  }
  if (value !== null && typeof value === 'object') {
    if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function sanitizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = sanitizeValue(value, depth);
  }
  return result;
}

export function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(details, 1);
}
