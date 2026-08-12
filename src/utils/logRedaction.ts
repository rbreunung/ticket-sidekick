/**
 * Redaction/truncation applied automatically inside `logDiag` (see
 * `diagLog.ts`) before any `details` object is written to the shared Output
 * Channel — no call site needs to remember to do this itself. Guards
 * against secrets and oversized ticket/PR/email content ending up in a
 * plain-text, on-screen log.
 */
const SENSITIVE_KEY_PATTERN = /token|auth|password|secret|credential|bearer|apikey/i;
const MAX_STRING_LENGTH = 500;
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
    if (SENSITIVE_KEY_PATTERN.test(key)) {
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
