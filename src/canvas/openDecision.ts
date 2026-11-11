import type { WindowChoice } from './selectWindow';

// The decisions of the canvas program, kept free of the Copilot SDK and of I/O so they can be
// tested: what an open request answers, and what to do with a security report canvas the runtime
// brought back after a restart. The answer's status is the only thing the agent learns, so it
// names the project or the reason and never carries report data.

export const SECURITY_REPORT_CANVAS_ID = 'security-report';
export const SECURITY_REPORT_PAGE_PATH = '/security-report/';

/** What a window's open check answered for the requested project. */
export type OpenCheck =
  | { ok: true; project: string }
  | { ok: false; reason: 'no-project' | 'not-configured' | 'unreachable' };

export interface OpenAnswer {
  url?: string;
  title: string;
  status: string;
}

const TITLE = 'Security report';

export const OPEN_STATUS = {
  notRunning:
    'Not opened: Ticket Sidekick\'s local server is not running in any VS Code window. It runs while 127.0.0.1 is in the http.noProxy setting.',
  noMatch:
    'Not opened: no open VS Code window holds this chat\'s folder. Ask from the chat of the window whose workspace holds the project; a window without a folder cannot open the report.',
  noProject:
    'Not opened: no project was named and ticketSidekick.jira.defaultProject is not set. Ask again with a project key, for example "security report for PROJ".',
  notConfigured: 'Not opened: Jira is not set up in that window\'s Ticket Sidekick settings.',
  unreachable: 'Not opened: Ticket Sidekick in that window did not answer. Try again in a moment.',
} as const;

/** A window's open-check answer, accepted only in its known shapes so no other text reaches the agent. */
export function asOpenCheck(body: unknown): OpenCheck | undefined {
  const b = body as { ok?: unknown; project?: unknown; reason?: unknown };
  if (typeof b !== 'object' || b === null) return undefined;
  if (b.ok === true) {
    const project = projectFromInput({ project: b.project });
    return project ? { ok: true, project } : undefined;
  }
  if (b.ok === false && (b.reason === 'no-project' || b.reason === 'not-configured' || b.reason === 'unreachable')) {
    return { ok: false, reason: b.reason };
  }
  return undefined;
}

/** The project key from the canvas input, upper-cased, or undefined when none or an invalid one was given. */
export function projectFromInput(input: unknown): string | undefined {
  const raw = typeof input === 'object' && input !== null ? (input as { project?: unknown }).project : undefined;
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,49}$/.test(key) ? key : undefined;
}

/** The instance id the agent is asked to use, so a second request for the project reuses the open canvas. */
export function instanceIdFor(project: string | undefined): string {
  return project ? `${SECURITY_REPORT_CANVAS_ID}-${project}` : SECURITY_REPORT_CANVAS_ID;
}

/** The open answer for a chosen window and its open check. */
export function openAnswer(choice: WindowChoice, check: OpenCheck | undefined): OpenAnswer {
  if (choice.kind === 'not-running') return { title: TITLE, status: OPEN_STATUS.notRunning };
  if (choice.kind === 'no-match') return { title: TITLE, status: OPEN_STATUS.noMatch };
  if (!check || !check.ok) {
    const reason = check?.reason ?? 'unreachable';
    const status = reason === 'no-project' ? OPEN_STATUS.noProject : reason === 'not-configured' ? OPEN_STATUS.notConfigured : OPEN_STATUS.unreachable;
    return { title: TITLE, status };
  }
  const { port, canvasKey } = choice.note;
  return {
    url: `http://127.0.0.1:${port}/${canvasKey}${SECURITY_REPORT_PAGE_PATH}?project=${encodeURIComponent(check.project)}`,
    title: `${TITLE}: ${check.project}`,
    status: `Opened the security report for ${check.project}.`,
  };
}

/** The longest the restart repair waits for the chat's window to run again before closing a canvas. */
export const RESTORE_WAIT_MS = 30_000;

/**
 * What to do with a security report canvas found open when the canvas program joins a session:
 * keep it when its page still answers, reopen it once the window holding the chat's folder runs
 * again (the reopen asks that window for a fresh address), wait while it does not, and close it
 * when the wait is over.
 */
export function restoreAction(state: { pageAnswers: boolean; chatWindowRunning: boolean; waitedMs: number }): 'keep' | 'reopen' | 'wait' | 'close' {
  if (state.pageAnswers) return 'keep';
  if (state.chatWindowRunning) return 'reopen';
  return state.waitedMs >= RESTORE_WAIT_MS ? 'close' : 'wait';
}
