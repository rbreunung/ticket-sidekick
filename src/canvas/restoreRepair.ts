import { restoreAction, SECURITY_REPORT_CANVAS_ID } from './openDecision';

// After a restart the Copilot runtime may bring a security report canvas back with the address of
// the previous start, whose port and canvas key no longer exist. The canvas program repairs each
// one when it joins the session: it reopens the canvas once a window's server runs (the reopen asks
// the chat's window for a fresh address, so the page reads Jira again) or closes it when no window
// comes back in time. A canvas whose page still answers is left alone.

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
  anyWindowRunning(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(record: Record<string, string | number | boolean>): Promise<void>;
}

export const RESTORE_POLL_MS = 2_000;

export async function repairRestoredCanvases(deps: RepairDeps): Promise<void> {
  let open: RestoredCanvas[];
  try {
    open = await deps.listOpen();
  } catch {
    return;
  }
  for (const canvas of open.filter(c => c.canvasId === SECURITY_REPORT_CANVAS_ID)) {
    const started = deps.now();
    for (;;) {
      const action = restoreAction({
        pageAnswers: await deps.pageAnswers(canvas.url),
        anyWindowRunning: await deps.anyWindowRunning(),
        waitedMs: deps.now() - started,
      });
      if (action === 'wait') {
        await deps.sleep(RESTORE_POLL_MS);
        continue;
      }
      let outcome: string = action;
      try {
        if (action === 'reopen') {
          const reopened = await deps.reopen(canvas);
          if (!reopened.url) {
            await deps.close(canvas.instanceId);
            outcome = 'reopen-without-page-closed';
          }
        } else if (action === 'close') {
          await deps.close(canvas.instanceId);
        }
      } catch {
        outcome = `${action}-failed`;
      }
      await deps.log({ event: 'restore', outcome, waitedMs: deps.now() - started });
      break;
    }
  }
}
