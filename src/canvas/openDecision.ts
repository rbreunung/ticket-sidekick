import type { WindowChoice } from './selectWindow';

// The decisions of the canvas program, kept free of the Copilot SDK and of I/O so they can be
// tested: which canvases exist, what an open request answers, and what to do with a canvas the
// runtime brought back after a restart. The answer's status is the only thing the agent learns,
// so it says "opened" or the reason and never carries board data.

export interface BoardCanvas {
  /** The canvas id, which is also the board kind and the page's folder. */
  id: string;
  displayName: string;
  /** What the agent reads to decide when to open the canvas and what to pass. */
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SECURITY_REPORT_CANVAS_ID = 'security-report';
export const TICKET_LIST_CANVAS_ID = 'ticket-list';
export const SESSIONS_CANVAS_ID = 'sessions';

export const BOARD_CANVASES: readonly BoardCanvas[] = [
  {
    id: SECURITY_REPORT_CANVAS_ID,
    displayName: 'Security report',
    description:
      'A project\'s open Veracode and Waltz security tickets by release, with Due Date flags, read from Jira by Ticket Sidekick '
      + 'and shown in its own tab, with filters and CSV or Excel export. Open it when the user asks for the security report. '
      + 'Pass the project key as input.project when the user names one. Use the instance id "security-report-<PROJECT>", '
      + 'or "security-report" when no project is named, so an open report is brought forward instead of opened twice.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'The Jira project key, e.g. PROJ. Leave out to use the default project.' } },
      additionalProperties: false,
    },
  },
  {
    id: TICKET_LIST_CANVAS_ID,
    displayName: 'Ticket list',
    description:
      'The Jira tickets of a JQL query or a saved filter, shown by Ticket Sidekick in their own tab, where the user selects tickets and moves them '
      + 'to a status or sets a field on them after a preview. Open it whenever the user asks to see a list of tickets, to search Jira, or to change '
      + 'more than one ticket; do not list the tickets in chat and do not change them one by one. Pass input.jql or input.filter (a saved filter\'s '
      + 'id or name). When the user asked for a change, pass it as input.change: {"type":"transition","status":"Closed","resolution":"Fixed"} or '
      + '{"type":"field","field":"labels","value":"cleanup"}; the board shows it as proposed and writes nothing until the user applies it. '
      + 'You get back only whether it opened, never the tickets. Use the instance id "ticket-list-" followed by a short name of the query.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'A JQL query, e.g. project = PROJ AND status = Done.' },
        filter: { type: 'string', description: 'A saved filter\'s id or name, in place of jql.' },
        change: {
          type: 'object',
          description: 'A change the user asked for, shown as proposed.',
          properties: {
            type: { type: 'string', enum: ['transition', 'field'] },
            status: { type: 'string', description: 'For a transition: the status to move to.' },
            resolution: { type: 'string', description: 'For a transition: the resolution to set, if any.' },
            field: { type: 'string', description: 'For a field change: the field\'s name or id.' },
            value: { type: 'string', description: 'For a field change: the new value.' },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    id: SESSIONS_CANVAS_ID,
    displayName: 'Stored sessions',
    description:
      'The work in progress Ticket Sidekick keeps for this workspace (reports, lists, imports, reviews), with reopen and delete, '
      + 'shown in its own tab. Open it when the user asks for the stored sessions or types /ts-jira sessions. '
      + 'It takes no input. Use the instance id "sessions".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** What a window answered when asked to open a board: the session it belongs to, or the reason it cannot open. */
export type BoardOpenCheck = { ok: true; id: string; title: string } | { ok: false; reason: string };

export interface OpenAnswer {
  url?: string;
  title: string;
  status: string;
}

export const OPEN_STATUS = {
  notRunning:
    'Not opened: Ticket Sidekick\'s local server is not running in any VS Code window. It runs while 127.0.0.1 is in the http.noProxy setting.',
  noMatch:
    'Not opened: no open VS Code window holds this chat\'s folder. Ask from the chat of the window whose workspace holds the project; a window without a folder cannot open a board.',
  unreachable: 'Not opened: Ticket Sidekick in that window did not answer. Try again in a moment.',
} as const;

const MAX_TEXT = 300;

/** One line of plain text, capped: what a window says is passed to the agent, so it stays short and flat. */
function plain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

/** A window's answer, accepted only in its known shapes. */
export function asBoardOpenCheck(body: unknown): BoardOpenCheck | undefined {
  const b = body as { ok?: unknown; id?: unknown; title?: unknown; reason?: unknown };
  if (typeof b !== 'object' || b === null) return undefined;
  if (b.ok === true) {
    const title = plain(b.title);
    return typeof b.id === 'string' && /^[0-9a-f]{0,64}$/.test(b.id) && title ? { ok: true, id: b.id, title } : undefined;
  }
  const reason = plain(b.reason);
  return b.ok === false && reason ? { ok: false, reason } : undefined;
}

/** The open answer for a chosen window and what it said. */
export function openAnswer(canvas: BoardCanvas, choice: WindowChoice, check: BoardOpenCheck | undefined): OpenAnswer {
  const title = canvas.displayName;
  if (choice.kind === 'not-running') return { title, status: OPEN_STATUS.notRunning };
  if (choice.kind === 'no-match') return { title, status: OPEN_STATUS.noMatch };
  if (!check) return { title, status: OPEN_STATUS.unreachable };
  if (!check.ok) return { title, status: `Not opened: ${check.reason}` };
  const { port, canvasKey } = choice.note;
  const query = check.id ? `?s=${check.id}` : '';
  return {
    url: `http://127.0.0.1:${port}/${canvasKey}/board/${canvas.id}/${query}`,
    title: check.title,
    status: `Opened: ${check.title}.`,
  };
}

/** The longest the restart repair waits for the chat's window to run again before closing a canvas. */
export const RESTORE_WAIT_MS = 30_000;

/**
 * What to do with a board canvas found open when the canvas program joins a session: keep it when
 * its page still answers, reopen it once the window holding the chat's folder runs again (the
 * reopen asks that window for a fresh address, and the page then shows its stored session), wait
 * while it does not, and close it when the wait is over.
 */
export function restoreAction(state: { pageAnswers: boolean; chatWindowRunning: boolean; waitedMs: number }): 'keep' | 'reopen' | 'wait' | 'close' {
  if (state.pageAnswers) return 'keep';
  if (state.chatWindowRunning) return 'reopen';
  return state.waitedMs >= RESTORE_WAIT_MS ? 'close' : 'wait';
}
