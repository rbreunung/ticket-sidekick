import { describe, it, expect } from 'vitest';
import { repairRestoredCanvases, type RepairDeps, type RestoredCanvas } from '../canvas/restoreRepair';
import { RESTORE_WAIT_MS } from '../canvas/openDecision';

// A security report canvas the runtime brought back after a restart either recovers into a working
// page or is closed, never left blank. Time is simulated: each wait advances the clock.

function harness(canvases: RestoredCanvas[], opts: { windowAfterMs?: number; pageAnswers?: boolean; reopenUrl?: string | undefined } = {}) {
  let clock = 0;
  const reopened: string[] = [];
  const closed: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const deps: RepairDeps = {
    listOpen: async () => canvases,
    reopen: async canvas => { reopened.push(canvas.instanceId); return { url: 'reopenUrl' in opts ? opts.reopenUrl : 'http://127.0.0.1:50001/key/security-report/?project=PROJ' }; },
    close: async id => { closed.push(id); },
    pageAnswers: async () => opts.pageAnswers ?? false,
    anyWindowRunning: async () => opts.windowAfterMs !== undefined && clock >= opts.windowAfterMs,
    sleep: async ms => { clock += ms; },
    now: () => clock,
    log: async record => { logs.push(record); },
  };
  return { deps, reopened, closed, logs };
}

const restored: RestoredCanvas = { instanceId: 'security-report-PROJ', canvasId: 'security-report', url: 'http://127.0.0.1:41000/oldkey/security-report/?project=PROJ', input: { project: 'PROJ' } };

describe('repairing security report canvases after a restart', () => {
  it('reopens a restored canvas once its window runs again', async () => {
    const h = harness([restored], { windowAfterMs: 6_000 });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ']);
    expect(h.closed).toEqual([]);
    expect(h.logs).toEqual([{ event: 'restore', outcome: 'reopen', waitedMs: 6_000 }]);
  });

  it('closes a restored canvas when no window comes back within the wait', async () => {
    const h = harness([restored]);
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual(['security-report-PROJ']);
    expect(h.logs[0]).toMatchObject({ outcome: 'close' });
    expect(Number(h.logs[0].waitedMs)).toBeGreaterThanOrEqual(RESTORE_WAIT_MS);
  });

  it('closes a canvas whose reopen got no page, for example because no window holds its chat\'s folder', async () => {
    const h = harness([restored], { windowAfterMs: 0, reopenUrl: undefined });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual(['security-report-PROJ']);
    expect(h.closed).toEqual(['security-report-PROJ']);
  });

  it('leaves a canvas alone while its page still answers', async () => {
    const h = harness([restored], { windowAfterMs: 0, pageAnswers: true });
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual([]);
  });

  it('leaves canvases of other extensions alone', async () => {
    const h = harness([{ instanceId: 'board-1', canvasId: 'kanban', url: 'http://127.0.0.1:1/x' }]);
    await repairRestoredCanvases(h.deps);
    expect(h.reopened).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});
