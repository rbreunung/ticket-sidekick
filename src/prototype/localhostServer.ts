import * as http from 'http';
import type { AddressInfo } from 'net';
import { checkRequest, maskPath, type GuardExpectation } from './requestGuard';

// The prototype's one HTTP server: bound to 127.0.0.1 on a random port, every request through the
// guard before it reaches the MCP handler or the canvas routes. Counters and the recently seen
// Host/Origin values stay in memory for the prototype report; nothing here holds a key in a field
// that could be logged.

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
export type CanvasHandler = (req: http.IncomingMessage, res: http.ServerResponse, subPath: string) => Promise<void>;

export interface LocalhostServerOptions {
  onMcp: RouteHandler;
  onCanvas: CanvasHandler;
  onError?: (message: string) => void;
}

export interface ServerStats {
  allowed: Record<string, number>;
  refused: Record<string, number>;
  recentHosts: string[];
  recentOrigins: string[];
  recentPaths: string[];
  userAgents: string[];
}

const RECENT_LIMIT = 10;

function pushRecent(list: string[], value: string): void {
  if (list.includes(value)) return;
  list.push(value);
  if (list.length > RECENT_LIMIT) list.shift();
}

/** Scheme and host only; anything unparsable is recorded as such, never verbatim. */
function sanitizeOrigin(origin: string | undefined): string {
  if (origin === undefined) return '(none)';
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(unparsable)';
  }
}

function sanitizeShort(value: string | undefined): string {
  if (value === undefined) return '(none)';
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
}

export class LocalhostServer {
  private server: http.Server | undefined;
  private expectation: GuardExpectation | undefined;
  private counters: ServerStats = emptyStats();

  constructor(private readonly options: LocalhostServerOptions) {}

  /** Starts listening on 127.0.0.1 with a random port and returns the port. */
  async start(keys: { mcpKey: string; canvasKey: string }): Promise<number> {
    if (this.server) throw new Error('The prototype server is already running.');
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    this.server = server;
    this.expectation = { port, ...keys };
    this.counters = emptyStats();
    return port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.expectation = undefined;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  isRunning(): boolean {
    return this.server !== undefined;
  }

  address(): AddressInfo | undefined {
    return this.server?.address() as AddressInfo | undefined;
  }

  stats(): ServerStats {
    return JSON.parse(JSON.stringify(this.counters)) as ServerStats;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const expectation = this.expectation;
    if (!expectation) {
      res.statusCode = 503;
      res.end();
      return;
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const path = req.url ?? '/';
    pushRecent(this.counters.recentHosts, sanitizeShort(header('host')));
    pushRecent(this.counters.recentOrigins, sanitizeOrigin(header('origin')));
    pushRecent(this.counters.recentPaths, maskPath(path));

    const decision = checkRequest(
      { method: req.method ?? 'GET', path, headers: { host: header('host'), origin: header('origin'), authorization: header('authorization') } },
      expectation,
    );
    if (!decision.allowed) {
      this.counters.refused[decision.reason] = (this.counters.refused[decision.reason] ?? 0) + 1;
      res.statusCode = decision.status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(decision.status === 401 ? 'Unauthorized' : decision.status === 403 ? 'Forbidden' : 'Not found');
      return;
    }
    this.counters.allowed[decision.route] = (this.counters.allowed[decision.route] ?? 0) + 1;
    if (decision.route === 'mcp') pushRecent(this.counters.userAgents, sanitizeShort(header('user-agent')));
    try {
      if (decision.route === 'mcp') await this.options.onMcp(req, res);
      else await this.options.onCanvas(req, res, decision.subPath);
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal error');
      } else {
        res.end();
      }
    }
  }
}

function emptyStats(): ServerStats {
  return { allowed: {}, refused: {}, recentHosts: [], recentOrigins: [], recentPaths: [], userAgents: [] };
}
