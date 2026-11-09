import { keysMatch } from './keys';

// The one gate every request to the localhost MCP server passes before any routing or Jira call.
// Checks run in a fixed order: Host first (blocks DNS rebinding), then Origin (blocks other web
// pages), then the path and the bearer key. Reasons are short codes that never contain a key, so
// they are safe to log and count.

export interface GuardExpectation {
  port: number;
  mcpKey: string;
}

export interface GuardRequest {
  method: string;
  path: string;
  headers: { host?: string; origin?: string; authorization?: string };
}

export type GuardDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 | 404; reason: string };

export const MCP_PATH = '/mcp';

export function checkRequest(req: GuardRequest, expected: GuardExpectation): GuardDecision {
  const ownHost = `127.0.0.1:${expected.port}`;
  if (req.headers.host !== ownHost) return { allowed: false, status: 403, reason: 'host-mismatch' };

  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${ownHost}`) {
    return { allowed: false, status: 403, reason: 'origin-mismatch' };
  }

  const path = req.path.split('?')[0];
  if (path !== MCP_PATH) return { allowed: false, status: 404, reason: 'unknown-path' };

  return keysMatch(bearerOf(req.headers.authorization), expected.mcpKey)
    ? { allowed: true }
    : { allowed: false, status: 401, reason: 'mcp-key-invalid' };
}

/** The key an `Authorization: Bearer <key>` header carries, or undefined for any other header. */
export function bearerOf(authorization: string | undefined): string | undefined {
  const auth = authorization ?? '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

/**
 * A request path safe to log or count. A first segment as long as a key (keys are 43 characters)
 * is masked, so a client that wrongly puts the key in the path never gets it into a report; short
 * paths such as /favicon.ico stay readable. The query string is dropped.
 */
export function maskPath(path: string): string {
  const bare = path.split('?')[0];
  return bare.replace(/^\/[^/]{32,}/, '/[key]');
}
