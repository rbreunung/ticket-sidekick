import type { RecentCallGuard } from '../../tools/recentCallGuard';
import { ToolFailure } from '../mcpServer';
import { WRITE_TIMEOUT_LABEL } from './runJiraTool';

/**
 * Runs a write that creates something new each time (a comment, a ticket, an attachment) at most
 * once per minute for the same `key`: a call repeated within the minute, for example by an agent
 * retrying, is answered with `skippedAnswer` and writes nothing. `run` calls `markWritten` once
 * Jira took the write. A call that wrote nothing (Jira not configured, refused input, a failed
 * request) does not count, so a real retry goes through; a write that timed out does count,
 * since Jira may still have made it.
 */
export async function writeOnce(
  guard: RecentCallGuard,
  key: string,
  skippedAnswer: string,
  run: (markWritten: () => void) => Promise<string>,
): Promise<string> {
  if (!guard.claim(key)) return skippedAnswer;
  let written = false;
  try {
    const answer = await run(() => { written = true; });
    if (!written) guard.release(key);
    return answer;
  } catch (err) {
    if (!(err instanceof ToolFailure && err.label === WRITE_TIMEOUT_LABEL)) guard.release(key);
    throw err;
  }
}
