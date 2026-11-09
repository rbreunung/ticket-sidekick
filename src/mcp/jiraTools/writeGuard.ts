import type { RecentCallGuard } from '../../tools/recentCallGuard';
import { ToolFailure } from '../mcpServer';
import { WRITE_TIMEOUT_LABEL } from './runJiraTool';

/**
 * Runs a Jira write at most once per minute for the same `key`: a call repeated while the first
 * one runs, or within a minute after it ended, for example by an agent retrying, is answered with
 * `skippedAnswer` and writes nothing. `run` calls `markWritten` once Jira took the write. A call
 * that wrote nothing (Jira not configured, refused input, a failed request) does not count, so a
 * real retry goes through; a write that timed out does count, from the timeout on, since Jira may
 * still make it.
 */
export async function writeOnce(
  guard: RecentCallGuard,
  key: string,
  skippedAnswer: string,
  run: (markWritten: () => void) => Promise<string>,
): Promise<string> {
  if (!guard.claim(key)) return skippedAnswer;
  // The minute is counted from when the write ended, so a slow write keeps its claim meanwhile.
  guard.hold(key);
  let written = false;
  try {
    const answer = await run(() => { written = true; });
    if (written) guard.refresh(key);
    else guard.release(key);
    return answer;
  } catch (err) {
    if (err instanceof ToolFailure && err.label === WRITE_TIMEOUT_LABEL) guard.refresh(key);
    else guard.release(key);
    throw err;
  }
}
