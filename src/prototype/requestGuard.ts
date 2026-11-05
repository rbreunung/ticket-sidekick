import { keysMatch } from './keys';

// The one gate every request to the prototype's localhost server passes before any routing or
// Jira call. Checks run in a fixed order: Host first (blocks DNS rebinding), then Origin (blocks
// other web pages), then the key. Reasons are short codes that never contain a key, so they are
// safe to log and count.

export interface GuardExpectation {
  port: number;
  mcpKey: string;
  canvasKey: string;
}

export interface GuardRequest {
  method: string;
  path: string;
  headers: { host?: string; origin?: string; authorization?: string };
}

export type GuardDecision =
  | { allowed: true; route: 'mcp' }
  | { allowed: true; route: 'canvas'; subPath: string }
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
  if (path === MCP_PATH) {
    const auth = req.headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    return keysMatch(bearer, expected.mcpKey)
      ? { allowed: true, route: 'mcp' }
      : { allowed: false, status: 401, reason: 'mcp-key-invalid' };
  }

  const match = /^\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return { allowed: false, status: 404, reason: 'unknown-path' };
  if (!keysMatch(match[1], expected.canvasKey)) {
    return { allowed: false, status: 401, reason: 'canvas-key-invalid' };
  }
  return { allowed: true, route: 'canvas', subPath: match[2] ?? '/' };
}

/** A request path safe to log or count: the first segment (a canvas key) is masked. */
export function maskPath(path: string): string {
  const bare = path.split('?')[0];
  if (bare === MCP_PATH) return MCP_PATH;
  return bare.replace(/^\/[^/]+/, '/[key]');
}
