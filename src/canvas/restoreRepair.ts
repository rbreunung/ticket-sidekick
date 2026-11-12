import { BOARD_CANVASES, restoreAction } from './openDecision';

// After a restart the Copilot runtime may bring a board canvas back with the address of
// the previous start, whose port and canvas key no longer exist. The canvas program repairs each
// one when it joins the session: it reopens the canvas once the window holding the chat's folder
// runs again (the reopen asks that window for a fresh address, and the page shows its stored session) or
// closes it when that window does not come back in time. A canvas whose page still answers is left
// alone. The wait is counted from the start of the repair, so every canvas is settled within it.

export interface RestoredCanvas {
  instanceId: string;
  canvasId: string;
  url?: string;
  input?: unknown;
}

export interface RepairDeps {
  listOpen(): Promise<RestoredCanvas[]>;
  /** Reopens the canvas; resolves with the address it got, if any. */
  reopen(canvas: RestoredCanvas): Promise<{ url?: string }>;
  close(instanceId: string): Promise<void>;
  pageAnswers(url: string | undefined): Promise<boolean>;
  /** Whether the window whose workspace holds the chat's folder runs its server. */
  chatWindowRunning(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(record: Record<string, string | number | boolean>): Promise<void>;
}

export const RESTORE_POLL_MS = 2_000;

/**
 * Reopens the canvas and checks that the address it got answers. When the runtime only brought the
 * old panel forward with its old address, the canvas is closed and opened once more, which asks the
 * window for a fresh address; a canvas still without a working page is closed.
 */
async function reopenToWorkingPage(canvas: RestoredCanvas, deps: RepairDeps): Promise<string> {
  const reopened = await deps.reopen(canvas);
  if (reopened.url && await deps.pageAnswers(reopened.url)) return 'reopen';
  if (reopened.url) {
    await deps.close(canvas.instanceId);
    const fresh = await deps.reopen(canvas);
    if (fresh.url && await deps.pageAnswers(fresh.url)) return 'reopen-after-close';
  }
  await deps.close(canvas.instanceId);
  return 'reopen-without-page-closed';
}

export async function repairRestoredCanvases(deps: RepairDeps): Promise<void> {
  let open: RestoredCanvas[];
  try {
    open = await deps.listOpen();
  } catch {
    return;
  }
  const started = deps.now();
  const ours = new Set(BOARD_CANVASES.map(c => c.id));
  for (const canvas of open.filter(c => ours.has(c.canvasId))) {
    for (;;) {
      const action = restoreAction({
        pageAnswers: await deps.pageAnswers(canvas.url),
        chatWindowRunning: await deps.chatWindowRunning(),
        waitedMs: deps.now() - started,
      });
      if (action === 'wait') {
        await deps.sleep(RESTORE_POLL_MS);
        continue;
      }
      let outcome: string = action;
      try {
        if (action === 'reopen') outcome = await reopenToWorkingPage(canvas, deps);
        else if (action === 'close') await deps.close(canvas.instanceId);
      } catch {
        outcome = `${action}-failed`;
      }
      await deps.log({ event: 'restore', outcome, waitedMs: deps.now() - started });
      break;
    }
  }
}
