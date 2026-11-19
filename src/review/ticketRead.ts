import type { RequirementsSourceResult } from '../services/TicketService';
import { neutralizeMarkdownLinks } from './reviewSessionState';

/**
 * An error message shown in a notice line. It can carry text from a remote server (a Jira response body),
 * so links, autolinks, HTML and emphasis markers are flattened and it is cut to `maxChars`.
 */
export function safeErrorText(message: string, maxChars: number): string {
  return neutralizeMarkdownLinks(message.replace(/\s+/g, ' ').trim())
    .replace(/[`*_~|<>\\]/g, ' ')
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, '$1:\u200b//')
    .replace(/\s+/g, ' ')
    .slice(0, maxChars);
}

/** How long the ticket read may take before the review goes on without it. */
export const TICKET_READ_TIMEOUT_MS = 20000;

/**
 * Runs the ticket read so it can never hold the review up or sink it: a read that does not settle in
 * time, or that throws, becomes an `error` failure that the usual failure line names.
 */
export async function readTicketGuarded(
  read: () => Promise<RequirementsSourceResult>,
  timeoutMs: number = TICKET_READ_TIMEOUT_MS,
): Promise<RequirementsSourceResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RequirementsSourceResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'error', message: 'timed out' }), timeoutMs);
  });
  try {
    return await Promise.race([read(), timeout]);
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unexpected error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
