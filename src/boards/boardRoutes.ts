import * as fs from 'fs';
import * as path from 'path';
import { BOARD_OPEN_PATH, BOARD_PING_PATH } from '../canvas/boardPaths';
import { CanvasRequestError, readJson, sendJson, type CanvasRoute } from '../canvas/canvasRoutes';
import { isSessionId } from '../sessions/sessionId';
import type { SessionManager } from '../sessions/sessionManager';
import { SessionError } from '../sessions/sessionTypes';

// The routes every board shares, under the canvas key. A board kind adds no route code: the page
// names its kind in the path and its session in the request, and the session manager does the
// rest. Nothing here knows a board's rules.

export const SESSIONS_BOARD = 'sessions';

/** The longest a state request waits for a change before it answers with the unchanged state. */
const MAX_WAIT_MS = 25_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function body(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CanvasRequestError(400, 'Invalid request body.');
  return value as Record<string, unknown>;
}

function sessionIdOf(value: unknown): string {
  if (!isSessionId(value)) throw new CanvasRequestError(400, 'Invalid session.');
  return value;
}

function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new CanvasRequestError(400, 'Invalid revision.');
  return value;
}

/** Runs a session call and answers a refusal with its status and message. */
async function answer(res: Parameters<CanvasRoute['handle']>[1], work: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(res, 200, await work());
  } catch (err) {
    if (err instanceof SessionError) throw new CanvasRequestError(err.status, err.message);
    throw err;
  }
}

/** The routes of one board kind. */
function kindRoutes(manager: SessionManager, kind: string): CanvasRoute[] {
  const base = `/board/${kind}`;
  const post = (name: string, handle: (b: Record<string, unknown>) => Promise<unknown>): CanvasRoute => ({
    method: 'POST',
    path: `${base}/${name}`,
    handle: async (req, res) => {
      const b = body(await readJson(req));
      await answer(res, () => handle(b));
    },
  });
  return [
    {
      method: 'GET',
      path: `${base}/state`,
      handle: async (_req, res, ctx) => {
        const id = sessionIdOf(ctx.query.get('s'));
        const tickText = ctx.query.get('tick');
        const tick = tickText === null ? undefined : Number(tickText);
        const wait = Math.min(Math.max(Number(ctx.query.get('wait') ?? 0) || 0, 0), MAX_WAIT_MS);
        await answer(res, () => manager.state(kind, id, Number.isInteger(tick) ? tick : undefined, wait));
      },
    },
    post('action', b => manager.action(kind, sessionIdOf(b.s), revisionOf(b.revision), b.action)),
    post('refresh', b => manager.refresh(kind, sessionIdOf(b.s))),
    post('preview', b => manager.preview(kind, sessionIdOf(b.s), revisionOf(b.revision), b.action)),
    post('apply', b => {
      if (typeof b.planId !== 'string') throw new CanvasRequestError(400, 'Invalid plan.');
      return manager.apply(kind, sessionIdOf(b.s), b.planId);
    }),
    post('save', async b => {
      if (typeof b.format !== 'string') throw new CanvasRequestError(400, 'Invalid format.');
      return { outcome: await manager.exportFile(kind, sessionIdOf(b.s), b.format) };
    }),
    post('discard', async b => {
      await manager.discard(sessionIdOf(b.s));
      return { ok: true };
    }),
  ];
}

/** Every file under `root` as a GET route below `/board`; a folder's `index.html` also answers for the folder. */
export function assetRoutes(root: string): CanvasRoute[] {
  const routes: CanvasRoute[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file, `${prefix}/${entry.name}`);
        continue;
      }
      const type = CONTENT_TYPES[path.extname(entry.name).toLowerCase()];
      if (!type) continue;
      const serve: CanvasRoute['handle'] = async (_req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', type);
        res.end(await fs.promises.readFile(file));
      };
      routes.push({ method: 'GET', path: `${prefix}/${entry.name}`, handle: serve });
      if (entry.name === 'index.html') routes.push({ method: 'GET', path: `${prefix}/`, handle: serve });
    }
  };
  walk(root, '/board');
  return routes;
}

export interface BoardRouteOptions {
  manager: SessionManager;
  /** The registered board kinds' names. */
  kinds: string[];
  /** The folder the pages are shipped in. */
  pagesDir: string;
  /** VS Code's theme kind in this window; a canvas host passes none to the page. */
  theme(): 'light' | 'dark' | 'hc';
}

export function boardRoutes({ manager, kinds, pagesDir, theme }: BoardRouteOptions): CanvasRoute[] {
  return [
    // The canvas program asks here before it hands the agent a page address.
    {
      method: 'GET',
      path: BOARD_OPEN_PATH,
      handle: async (_req, res, ctx) => {
        const kind = ctx.query.get('kind') ?? '';
        if (kind === SESSIONS_BOARD) return sendJson(res, 200, { ok: true, id: '', title: 'Stored sessions' });
        let input: unknown = {};
        try {
          input = JSON.parse(ctx.query.get('input') ?? '{}');
        } catch {
          return sendJson(res, 200, { ok: false, reason: 'the request could not be read.' });
        }
        sendJson(res, 200, await manager.open(kind, input));
      },
    },
    { method: 'GET', path: '/board/theme', handle: async (_req, res) => sendJson(res, 200, { kind: theme() }) },
    { method: 'GET', path: BOARD_PING_PATH, handle: async (_req, res) => sendJson(res, 200, { ok: true }) },
    ...kinds.flatMap(kind => kindRoutes(manager, kind)),
    { method: 'GET', path: `/board/${SESSIONS_BOARD}/list`, handle: async (_req, res) => sendJson(res, 200, { sessions: await manager.list() }) },
    {
      method: 'POST',
      path: `/board/${SESSIONS_BOARD}/delete`,
      handle: async (req, res) => {
        await manager.discard(sessionIdOf(body(await readJson(req)).id));
        sendJson(res, 200, { sessions: await manager.list() });
      },
    },
    {
      method: 'POST',
      path: `/board/${SESSIONS_BOARD}/delete-all`,
      handle: async (req, res) => {
        await readJson(req);
        await manager.discardAll();
        sendJson(res, 200, { sessions: [] });
      },
    },
    ...assetRoutes(pagesDir),
  ];
}
