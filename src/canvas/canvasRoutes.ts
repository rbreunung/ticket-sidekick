import type * as http from 'http';

// Routing for canvas pages under the canvas key. Every response carries the same security headers:
// a content policy that lets a page run only the extension's own script and styles and talk only to
// this server, no caching, and no referrer, so following a link to Jira never sends the page
// address (which carries the canvas key) along. Request bodies are JSON only and capped, so a plain
// HTML form elsewhere cannot post here.

export const CANVAS_CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MAX_BODY_BYTES = 64 * 1024;

export interface CanvasRequestContext {
  /** The path after the canvas key, without the query string. */
  path: string;
  query: URLSearchParams;
}

export interface CanvasRoute {
  method: 'GET' | 'POST';
  path: string;
  handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: CanvasRequestContext): Promise<void>;
}

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('Content-Security-Policy', CANVAS_CONTENT_POLICY);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Reads a JSON request body; throws on a non-JSON content type, a body over the cap, or invalid JSON. */
export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new CanvasRequestError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new CanvasRequestError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CanvasRequestError(400, 'Invalid request body.');
  }
}

/** A request the canvas refuses, answered with its status and a short message. */
export class CanvasRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The handler the localhost server calls for paths under the canvas key. */
export function createCanvasHandler(
  routes: readonly CanvasRoute[],
  onError?: (message: string) => void,
): (req: http.IncomingMessage, res: http.ServerResponse, canvasPath: string) => Promise<void> {
  return async (req, res, canvasPath) => {
    setSecurityHeaders(res);
    const method = req.method ?? 'GET';
    const route = routes.find(r => r.path === canvasPath && r.method === method);
    if (!route) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    try {
      await route.handle(req, res, { path: canvasPath, query });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof CanvasRequestError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      onError?.(err instanceof Error ? err.message : String(err));
      sendJson(res, 500, { error: 'Internal error.' });
    }
  };
}
