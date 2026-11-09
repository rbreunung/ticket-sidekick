import { STATUS_CODES } from 'http';

// The one wording for a failed Jira call that an agent or a chat reader sees: the HTTP status and
// a plain reason, or for an error without a status the first line of its message, capped in
// length. Never Jira's or a proxy's response body: that goes to the Output channel only.

/** The longest reason given for a failure that carries no HTTP status. */
export const MAX_FAILURE_REASON_CHARS = 160;

/** Plainer reasons than the HTTP reason phrase for the statuses a reader can act on. */
const STATUS_REASONS: Record<number, string> = {
  401: 'authentication failed; check the stored token',
  403: 'no permission',
  404: 'not found, or no permission to see it',
  429: 'too many requests; try again later',
};

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The error behind `err`: an error that wraps another one in its `cause`, as a move that failed
 * partway does, stands for that cause.
 */
export function rootCause(err: unknown): unknown {
  let current = err;
  for (let depth = 0; depth < 5; depth++) {
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null || cause === current) break;
    current = cause;
  }
  return current;
}

/** A short, body-free description of a failed Jira call, from the error behind `err`. */
export function describeJiraFailure(err: unknown): string {
  const cause = rootCause(err);
  const status = (cause as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    const reason = STATUS_REASONS[status] ?? STATUS_CODES[status] ?? 'request failed';
    return `Jira answered HTTP ${status} (${reason}).`;
  }
  const firstLine = (cause instanceof Error ? cause.message : String(cause)).split(/\r?\n/)[0].trim();
  return cap(firstLine || 'unknown error', MAX_FAILURE_REASON_CHARS);
}
