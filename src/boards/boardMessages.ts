import { isSessionId } from '../sessions/sessionId';
import type { SessionManager } from '../sessions/sessionManager';
import { SessionError, type Session } from '../sessions/sessionTypes';
import { IMPORT_KIND, withReportPath, type ImportRecipe, type ReportKind } from './import/recipe';
import { IMPORT_START_BOARD, type ImportStartScreen } from './import/startScreen';
import { reviewCopyText } from './review/findings';
import type { ReviewDerived, ReviewWorking } from './review/kind';
import { REVIEW_KIND, type ReviewRecipe } from './review/recipe';
import { REVIEW_START_BOARD, type ReviewStartScreen } from './review/startScreen';

// What a board page may ask of the extension. A page lives in an editor tab (a webview) and talks
// to the extension over VS Code's own message channel: it posts a request, the tab's host answers
// it through `handleBoardRequest`. There is no local server, no port and no key. A board kind adds
// nothing here: the tab knows its kind and session, and the session manager does the rest. The
// import start screen has no session either: its requests go to the start screen the host holds,
// which also brings the native file dialog and the setting writes, so its page names no file path,
// no setting key and no session. The review start screen is the same: it takes a pull request link
// and opens that review's board.

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
  /** The import start screen of this window; absent where imports are not available. */
  readonly importStart?: ImportStartScreen;
  /** The pull request review start screen of this window; absent where reviews are not available. */
  readonly reviewStart?: ReviewStartScreen;
  /** VS Code's native open dialog for a report of this kind; undefined when it was cancelled. */
  pickReportFile?(kind: ReportKind): Promise<string | undefined>;
  /** Points the tab that shows `fromId` at the session it moved to. */
  followSession?(kind: string, fromId: string, toId: string, title: string): Promise<void>;
  /** Closes the tab that shows this session, after its session was discarded. */
  closeSession?(kind: string, id: string): void;
  /** Puts text on the system clipboard; the text is always built by the extension. */
  copyText?(text: string): Promise<void>;
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

/**
 * "Pick the file again" on an import whose report file moved: the file comes from the native dialog,
 * never from the page; the session moves to the id of the new path and the tab follows it.
 */
async function pickReportFileAgain(manager: SessionManager, { kind, id }: BoardTarget, host: BoardHost): Promise<unknown> {
  if (kind !== IMPORT_KIND || !host.pickReportFile) throw new BoardRequestError(404, 'Unknown request.');
  const session = await manager.read(kind, id);
  if (!session) throw new BoardRequestError(409, 'The board is still loading.');
  const recipe = session.recipe as ImportRecipe;
  const picked = await host.pickReportFile(recipe.kind);
  if (!picked) return { outcome: 'cancelled' };
  const moved = await manager.relocate(kind, id, withReportPath(recipe, picked));
  if (moved.id !== id) await host.followSession?.(kind, id, moved.id, moved.state.title);
  return { outcome: 'picked', id: moved.id, state: moved.state };
}

const COPY_FORMATS = new Set(['teams', 'markdown']);

/**
 * Copy on the review board: the page names the format and the selected finding numbers, and the
 * text is built from the session. Any text the page sends along is not read.
 */
async function copyFindings(manager: SessionManager, { kind, id }: BoardTarget, body: Record<string, unknown>, host: BoardHost): Promise<unknown> {
  if (kind !== REVIEW_KIND || !host.copyText) throw new BoardRequestError(404, 'Unknown request.');
  const format = body.format;
  if (typeof format !== 'string' || !COPY_FORMATS.has(format)) throw new BoardRequestError(400, 'Invalid format.');
  const numbers = body.numbers ?? [];
  if (!Array.isArray(numbers) || numbers.some(n => typeof n !== 'number' || !Number.isInteger(n))) throw new BoardRequestError(400, 'Invalid selection.');
  const session = await manager.read(kind, id) as Session<ReviewRecipe, ReviewDerived, ReviewWorking> | undefined;
  if (!session) throw new BoardRequestError(409, 'The board is still loading.');
  const built = reviewCopyText(session, format as 'teams' | 'markdown', numbers as number[]);
  if ('ok' in built) throw new BoardRequestError(400, built.reason);
  try {
    await host.copyText(built.text);
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  return { outcome: 'copied', count: built.count };
}

async function sessionBoard(manager: SessionManager, target: BoardTarget, op: string, body: Record<string, unknown>, host: BoardHost): Promise<unknown> {
  const { kind, id } = target;
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
    case 'run':
      // Starts a model run the board kind names from `request`; the page follows it through `state`.
      return manager.startRun(kind, id, revisionOf(body.revision), body.request);
    case 'stop':
      if (body.what !== undefined && typeof body.what !== 'string') throw new BoardRequestError(400, 'Invalid run.');
      return manager.stopRun(kind, id, body.what);
    case 'save':
      if (typeof body.format !== 'string') throw new BoardRequestError(400, 'Invalid format.');
      return { outcome: await manager.exportFile(kind, id, body.format) };
    case 'discard':
      // Close discards the session and closes its tab; nothing in Jira or Bitbucket changes.
      await manager.discard(id);
      host.closeSession?.(kind, id);
      return { ok: true };
    case 'pick-file':
      return pickReportFileAgain(manager, target, host);
    case 'copy':
      return copyFindings(manager, target, body, host);
    default:
      throw new BoardRequestError(404, 'Unknown request.');
  }
}

/** Answers one request of the page in the tab that shows `target`. Refusals are thrown as `BoardRequestError`. */
export async function handleBoardRequest(manager: SessionManager, target: BoardTarget, op: string, body: Record<string, unknown>, host: BoardHost): Promise<unknown> {
  try {
    if (target.kind === SESSIONS_BOARD) return await sessionsBoard(manager, op, body, host);
    if (target.kind === IMPORT_START_BOARD) {
      if (!host.importStart) throw new BoardRequestError(404, 'There is no import start screen here.');
      return await host.importStart.handle(op, body);
    }
    if (target.kind === REVIEW_START_BOARD) {
      if (!host.reviewStart) throw new BoardRequestError(404, 'There is no review start screen here.');
      return await host.reviewStart.handle(op, body);
    }
    return await sessionBoard(manager, target, op, body, host);
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
