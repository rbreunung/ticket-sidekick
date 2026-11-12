import { keysMatch } from './keys';
import { KEY_LENGTH_FLOOR } from '../utils/keyMask';

// The one gate every request to the localhost server passes before any routing or Jira call.
// Checks run in a fixed order: Host first (blocks DNS rebinding), then Origin (blocks other web
// pages), then the path and its key: the bearer key for /mcp, or the canvas key as the first path
// segment for canvas pages (a canvas host passes only a URL, so that key has to live in the path).
// Reasons are short codes that never contain a key, so they are safe to log and count.

export interface GuardExpectation {
  port: number;
  mcpKey: string;
  /** The key canvas pages carry as their first path segment; without it there is no canvas route. */
  canvasKey?: string;
}

export interface GuardRequest {
  method: string;
  path: string;
  headers: { host?: string; origin?: string; authorization?: string };
}

export type GuardDecision =
  | { allowed: true; canvasPath?: undefined }
  | { allowed: true; canvasPath: string }
  | { allowed: false; status: 401 | 403 | 404; reason: string };

/** A first path segment this long is treated as a key attempt (keys are 43 characters). */

export const MCP_PATH = '/mcp';

export function checkRequest(req: GuardRequest, expected: GuardExpectation): GuardDecision {
  const ownHost = `127.0.0.1:${expected.port}`;
  if (req.headers.host !== ownHost) return { allowed: false, status: 403, reason: 'host-mismatch' };

  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${ownHost}`) {
    return { allowed: false, status: 403, reason: 'origin-mismatch' };
  }

  const path = req.path.split('?')[0];
  if (path !== MCP_PATH) return checkCanvasPath(path, expected);

  return keysMatch(bearerOf(req.headers.authorization), expected.mcpKey)
    ? { allowed: true }
    : { allowed: false, status: 401, reason: 'mcp-key-invalid' };
}

function checkCanvasPath(path: string, expected: GuardExpectation): GuardDecision {
  const match = /^\/([^/]+)(\/.*)?$/.exec(path);
  if (!expected.canvasKey || !match || match[1].length < KEY_LENGTH_FLOOR) {
    return { allowed: false, status: 404, reason: 'unknown-path' };
  }
  return keysMatch(match[1], expected.canvasKey)
    ? { allowed: true, canvasPath: match[2] ?? '/' }
    : { allowed: false, status: 401, reason: 'canvas-key-invalid' };
}

/** The key an `Authorization: Bearer <key>` header carries, or undefined for any other header. */
export function bearerOf(authorization: string | undefined): string | undefined {
  const auth = authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

/**
 * A request path safe to log or count. Every segment as long as a key (keys are 43 characters) is
 * masked, wherever it is in the path, so a client that wrongly puts the key in the path never gets
 * it into the Output log or a report; short paths such as /favicon.ico stay readable. The query
 * string is dropped.
 */
export function maskPath(path: string): string {
  const bare = path.split('?')[0];
  return bare.split('/').map(segment => (segment.length >= KEY_LENGTH_FLOOR ? '[key]' : segment)).join('/');
}
