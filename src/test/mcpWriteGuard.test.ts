import { describe, it, expect, vi, afterEach } from 'vitest';
import { RecentCallGuard } from '../tools/recentCallGuard';
import { ToolFailure } from '../mcp/mcpServer';
import { WRITE_TIMEOUT_LABEL } from '../mcp/jiraTools/runJiraTool';
import { writeOnce } from '../mcp/jiraTools/writeGuard';

// The one-minute duplicate guard of the Jira write tools, on a fake clock: a write that may still
// land in Jira blocks the same write for a full minute after its outcome is known.

afterEach(() => vi.useRealTimers());

const SKIPPED = 'skipped';

/** Runs a guarded write that ends, at `endsAt` ms on the fake clock, the way `outcome` says. */
async function guardedWrite(guard: RecentCallGuard, endsAt: number, outcome: 'written' | 'timeout' | 'refused' | 'nothing') {
  return writeOnce(guard, 'key', SKIPPED, async markWritten => {
    vi.setSystemTime(endsAt);
    if (outcome === 'timeout') throw new ToolFailure('may still have been saved', WRITE_TIMEOUT_LABEL);
    if (outcome === 'refused') throw new ToolFailure('HTTP 400', 'HTTP 400');
    if (outcome === 'written') markWritten();
    return 'done';
  });
}

async function attemptAt(guard: RecentCallGuard, at: number): Promise<string> {
  vi.setSystemTime(at);
  return writeOnce(guard, 'key', SKIPPED, async markWritten => { markWritten(); return 'written again'; });
}

describe('the write tools\' duplicate guard', () => {
  it('blocks the same write for a full minute after a timeout, counted from the timeout', async () => {
    vi.useFakeTimers({ now: 0 });
    const guard = new RecentCallGuard();
    await expect(guardedWrite(guard, 30_000, 'timeout')).rejects.toThrow('may still have been saved');

    expect(await attemptAt(guard, 61_000)).toBe(SKIPPED);
    expect(await attemptAt(guard, 89_000)).toBe(SKIPPED);
    expect(await attemptAt(guard, 90_001)).toBe('written again');
  });

  it('blocks the same write for a full minute after it was written, counted from when it ended', async () => {
    vi.useFakeTimers({ now: 0 });
    const guard = new RecentCallGuard();
    await guardedWrite(guard, 45_000, 'written');

    expect(await attemptAt(guard, 100_000)).toBe(SKIPPED);
    expect(await attemptAt(guard, 105_001)).toBe('written again');
  });

  it('blocks the same write while the first one is still running, however long it takes', async () => {
    vi.useFakeTimers({ now: 0 });
    const guard = new RecentCallGuard();
    let finish: () => void = () => {};
    const first = writeOnce(guard, 'key', SKIPPED, markWritten => new Promise<string>(resolve => {
      finish = () => { markWritten(); resolve('done'); };
    }));

    expect(await attemptAt(guard, 150_000)).toBe(SKIPPED);
    finish();
    expect(await first).toBe('done');
  });

  it('lets a retry through at once after a write Jira refused or a call that wrote nothing', async () => {
    vi.useFakeTimers({ now: 0 });
    const guard = new RecentCallGuard();
    await expect(guardedWrite(guard, 1_000, 'refused')).rejects.toThrow('HTTP 400');
    expect(await attemptAt(guard, 1_001)).toBe('written again');

    const other = new RecentCallGuard();
    await guardedWrite(other, 1_000, 'nothing');
    expect(await writeOnce(other, 'key', SKIPPED, async markWritten => { markWritten(); return 'written'; })).toBe('written');
  });
});
