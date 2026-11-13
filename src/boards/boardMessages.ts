import { isSessionId } from '../sessions/sessionId';
import type { SessionManager } from '../sessions/sessionManager';
import { SessionError } from '../sessions/sessionTypes';

// What a board page may ask of the extension. A page lives in an editor tab (a webview) and talks
// to the extension over VS Code's own message channel: it posts a request, the tab's host answers
// it through `handleBoardRequest`. There is no local server, no port and no key. A board kind adds
// nothing here: the tab knows its kind and session, and the session manager does the rest.

export const SESSIONS_BOARD = 'sessions';

/** The longest a state request waits for a change before it answers with the unchanged state. */
const MAX_WAIT_MS = 25_000;

/** A request the board layer refuses, with a status the page tells cases apart by (404 gone, 409 changed meanwhile). */
export class BoardRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Which board a tab shows; set by the extension when it opens the tab, never taken from the page. */
export interface BoardTarget {
  kind: string;
  /** The session the tab shows; empty for the sessions board. */
  id: string;
}

export interface BoardHost {
  /** Opens the board of a stored session in its own tab (the sessions board's Reopen). */
  openStored(kind: string, id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface BoardRequest {
  id: number;
  op: string;
  body: Record<string, unknown>;
}

export type BoardReply =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; status: number; error: string };

/** A page's message in its known shape, or nothing: anything else is ignored. */
export function asBoardRequest(raw: unknown): BoardRequest | undefined {
  const m = raw as Partial<BoardRequest> | null;
  if (typeof m !== 'object' || m === null) return undefined;
  if (typeof m.id !== 'number' || !Number.isInteger(m.id) || typeof m.op !== 'string') return undefined;
  const body = m.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;
  return { id: m.id, op: m.op, body: body as Record<string, unknown> };
}

function sessionIdOf(value: unknown): string {
  if (!isSessionId(value)) throw new BoardRequestError(400, 'Invalid session.');
  return value;
}

function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new BoardRequestError(400, 'Invalid revision.');
  return value;
}

async function sessionsBoard(manager: SessionManager, op: string, body: Record<string, unknown>, host: BoardHost): Promise<unknown> {
  switch (op) {
    case 'list':
      return { sessions: await manager.list() };
    case 'delete':
      await manager.discard(sessionIdOf(body.id));
      return { sessions: await manager.list() };
    case 'delete-all':
      await manager.discardAll();
      return { sessions: [] };
    case 'open': {
      if (typeof body.kind !== 'string') throw new BoardRequestError(400, 'Invalid board.');
      const opened = await host.openStored(body.kind, sessionIdOf(body.id));
      if (!opened.ok) throw new BoardRequestError(404, `Not opened: ${opened.reason}`);
      return { ok: true };
    }
    default:
      throw new BoardRequestError(404, 'Unknown request.');
  }
}

async function sessionBoard(manager: SessionManager, { kind, id }: BoardTarget, op: string, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case 'state': {
      const tick = typeof body.tick === 'number' && Number.isInteger(body.tick) ? body.tick : undefined;
      const wait = typeof body.wait === 'number' ? Math.min(Math.max(body.wait, 0), MAX_WAIT_MS) : 0;
      return manager.state(kind, id, tick, wait);
    }
    case 'action':
      return manager.action(kind, id, revisionOf(body.revision), body.action);
    case 'refresh':
      return manager.refresh(kind, id);
    case 'preview':
      return manager.preview(kind, id, revisionOf(body.revision), body.action);
    case 'apply':
      if (typeof body.planId !== 'string') throw new BoardRequestError(400, 'Invalid plan.');
      return manager.apply(kind, id, body.planId);
    case 'save':
      if (typeof body.format !== 'string') throw new BoardRequestError(400, 'Invalid format.');
      return { outcome: await manager.exportFile(kind, id, body.format) };
    case 'discard':
      await manager.discard(id);
      return { ok: true };
    default:
      throw new BoardRequestError(404, 'Unknown request.');
  }
}

/** Answers one request of the page in the tab that shows `target`. Refusals are thrown as `BoardRequestError`. */
export async function handleBoardRequest(manager: SessionManager, target: BoardTarget, op: string, body: Record<string, unknown>, host: BoardHost): Promise<unknown> {
  try {
    return target.kind === SESSIONS_BOARD ? await sessionsBoard(manager, op, body, host) : await sessionBoard(manager, target, op, body);
  } catch (err) {
    if (err instanceof SessionError) throw new BoardRequestError(err.status, err.message);
    throw err;
  }
}

/**
 * The reply the tab posts back to its page. An unexpected error is answered with a fixed sentence
 * and handed to `onError`, so nothing internal reaches the page.
 */
export async function answerBoardRequest(
  manager: SessionManager, target: BoardTarget, request: BoardRequest, host: BoardHost, onError: (message: string) => void,
): Promise<BoardReply> {
  try {
    return { id: request.id, ok: true, data: await handleBoardRequest(manager, target, request.op, request.body, host) };
  } catch (err) {
    if (err instanceof BoardRequestError) return { id: request.id, ok: false, status: err.status, error: err.message };
    onError(err instanceof Error ? err.message : String(err));
    return { id: request.id, ok: false, status: 500, error: 'The extension could not answer. See the Ticket Sidekick output for details.' };
  }
}
