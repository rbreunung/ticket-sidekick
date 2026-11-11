import { describe, it, expect } from 'vitest';
import { repairRestoredCanvases, type RepairDeps, type RestoredCanvas } from '../canvas/restoreRepair';
import { RESTORE_WAIT_MS } from '../canvas/openDecision';

// A security report canvas the runtime brought back after a restart either recovers into a working
// page or is closed, never left blank. Time is simulated: each wait advances the clock.

const FRESH_URL = 'http://127.0.0.1:50001/newkey/security-report/?project=PROJ';

interface HarnessOptions {
  /** When the window holding the chat's folder runs again; never when left out. */
  chatWindowAfterMs?: number;
  /** The addresses whose page answers. */
  answering?: string[];
  /** What each reopen returns, in order; the last one repeats. */
  reopenUrls?: Array<string | undefined>;
  reopenFails?: boolean;
  closeFails?: boolean;
}

function harness(canvases: RestoredCanvas[], opts: HarnessOptions = {}) {
  let clock = 0;
  const reopened: string[] = [];
  const closed: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const reopenUrls = opts.reopenUrls ?? [FRESH_URL];
  const answering = opts.answering ?? [FRESH_URL];
  const deps: RepairDeps = {
    listOpen: async () => canvases,
    reopen: async canvas => {
      if (opts.reopenFails) throw new Error('reopen refused');
      reopened.push(canvas.instanceId);
      return { url: reopenUrls[Math.min(reopened.length - 1, reopenUrls.length - 1)] };
    },
    close: async id => {
      if (opts.closeFails) throw new Error('close refused');
      closed.push(id);
    },
    pageAnswers: async url => url !== undefined && answering.includes(url),
    chatWindowRunning: async () => opts.chatWindowAfterMs !== undefined && clock >= opts.chatWindowAfterMs,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    log: async record => { logs.push(record); },
  };
  return { deps, reopened, closed, logs };
}

const restored: RestoredCanvas = { instanceId: 'security-report-PROJ', canvasId: 'security-report', url: 'http://127.0.0.1:41000/oldkey/security-report/?project=PROJ', input: { project: 'PROJ' } };
const restoredOther: RestoredCanvas = { ...restored, instanceId: 'security-report-PAY', url: 'http://127.0.0.1:41000/oldkey/security-report/?project=PAY', input: { project: 'PAY' } };

describe('repairing security report canvases after a restart', () => {
  it('reopens a restored canvas once the window holding its chat\'s folder runs again', async () => {
    const h = harness([restored], { chatWindowAfterMs: 6_000 });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ']);
    expect(h.closed).toEqual([]);
    expect(h.logs).toEqual([{ event: 'restore', outcome: 'reopen', waitedMs: 6_000 }]);
  });

  it('keeps waiting while only other windows run, and reopens when the chat\'s window comes back', async () => {
    // Another window's server already runs from the start; only the chat's window decides.
    const h = harness([restored], { chatWindowAfterMs: 10_000 });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ']);
    expect(h.closed).toEqual([]);
    expect(h.logs[0]).toMatchObject({ outcome: 'reopen', waitedMs: 10_000 });
  });

  it('closes a restored canvas when its chat\'s window does not come back within the wait', async () => {
    const h = harness([restored]);
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual(['security-report-PROJ']);
    expect(h.logs[0]).toMatchObject({ outcome: 'close' });
    expect(Number(h.logs[0].waitedMs)).toBeGreaterThanOrEqual(RESTORE_WAIT_MS);
  });

  it('closes every restored canvas within the one wait, not one wait after another', async () => {
    const h = harness([restored, restoredOther]);
    await repairRestoredCanvases(h.deps);
    expect(h.closed).toEqual(['security-report-PROJ', 'security-report-PAY']);
    for (const log of h.logs) expect(Number(log.waitedMs)).toBeLessThan(RESTORE_WAIT_MS + 5_000);
  });

  it('closes a canvas whose reopen got no page, for example because no window holds its chat\'s folder', async () => {
    const h = harness([restored], { chatWindowAfterMs: 0, reopenUrls: [undefined] });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ']);
    expect(h.closed).toEqual(['security-report-PROJ']);
    expect(h.logs[0]).toMatchObject({ outcome: 'reopen-without-page-closed' });
  });

  it('closes and opens again when the reopen only brought the old address forward', async () => {
    const h = harness([restored], { chatWindowAfterMs: 0, reopenUrls: [restored.url, FRESH_URL] });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ', 'security-report-PROJ']);
    expect(h.closed).toEqual(['security-report-PROJ']);
    expect(h.logs[0]).toMatchObject({ outcome: 'reopen-after-close' });
  });

  it('closes the canvas when opening again still gives no working page', async () => {
    const h = harness([restored], { chatWindowAfterMs: 0, reopenUrls: [restored.url] });
    await repairRestoredCanvases(h.deps);
    expect(h.closed).toEqual(['security-report-PROJ', 'security-report-PROJ']);
    expect(h.logs[0]).toMatchObject({ outcome: 'reopen-without-page-closed' });
  });

  it('leaves a canvas alone while its page still answers', async () => {
    const h = harness([restored], { chatWindowAfterMs: 0, answering: [restored.url!] });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.logs).toEqual([{ event: 'restore', outcome: 'keep', waitedMs: 0 }]);
  });

  it('logs a refused reopen or close and goes on with the next canvas', async () => {
    const reopenFails = harness([restored, restoredOther], { chatWindowAfterMs: 0, reopenFails: true });
    await repairRestoredCanvases(reopenFails.deps);
    expect(reopenFails.logs.map(l => l.outcome)).toEqual(['reopen-failed', 'reopen-failed']);

    const closeFails = harness([restored], { closeFails: true });
    await repairRestoredCanvases(closeFails.deps);
    expect(closeFails.logs.map(l => l.outcome)).toEqual(['close-failed']);
  });

  it('does nothing when the open canvases cannot be listed', async () => {
    const h = harness([restored]);
    h.deps.listOpen = async () => { throw new Error('not supported'); };
    await repairRestoredCanvases(h.deps);
    expect(h.logs).toEqual([]);
  });

  it('leaves canvases of other extensions alone', async () => {
    const h = harness([{ instanceId: 'board-1', canvasId: 'kanban', url: 'http://127.0.0.1:1/x' }]);
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});
