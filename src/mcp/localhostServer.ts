import * as http from 'http';
import type { AddressInfo } from 'net';
import { bearerOf, checkRequest, maskPath, type GuardExpectation } from './requestGuard';

// The extension's one HTTP server: bound to 127.0.0.1 on a random port, every request through the
// guard before it reaches the MCP handler or, under the canvas key, the canvas handler. Counters and the recently seen Host/Origin values stay
// in memory for the diagnostics report; nothing here holds a key in a field that could be logged.

export type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
/** Handles a request under the canvas key; `canvasPath` is the path after the key, without the query. */
export type CanvasHandler = (req: http.IncomingMessage, res: http.ServerResponse, canvasPath: string) => Promise<void>;

export interface LocalhostServerOptions {
  onMcp: RouteHandler;
  /** Canvas pages; without it, paths under the canvas key are not found. */
  onCanvas?: CanvasHandler;
  /** Checked on every MCP request after the guard; false refuses it (403) before the handler runs. */
  allowMcp?: () => boolean;
  onError?: (message: string) => void;
  /** Called for every refused request with its reason code and masked path, for logging. */
  onRefused?: (reason: string, path: string) => void;
  /**
   * Whether a refused bearer key is one this server accepted at an earlier start. Such a refusal
   * is counted as `mcp-key-earlier-start` (a client still holding an old definition) instead of
   * `mcp-key-invalid`.
   */
  isEarlierKey?: (key: string) => boolean;
}

export interface ClientSeen {
  userAgent: string;
  /** ISO time of this client's last request with a valid key. */
  lastSeen: string;
}

export interface ServerStats {
  allowed: Record<string, number>;
  refused: Record<string, number>;
  recentHosts: string[];
  recentOrigins: string[];
  recentPaths: string[];
  clients: ClientSeen[];
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

function noteClient(clients: ClientSeen[], userAgent: string): void {
  const index = clients.findIndex(c => c.userAgent === userAgent);
  if (index >= 0) clients.splice(index, 1);
  clients.push({ userAgent, lastSeen: new Date().toISOString() });
  if (clients.length > RECENT_LIMIT) clients.shift();
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

  /**
   * Starts listening on 127.0.0.1 with a random port, accepting `mcpKey` as bearer key and, when
   * given, `canvasKey` as the first path segment of canvas pages. Returns the port.
   */
  async start(mcpKey: string, canvasKey?: string): Promise<number> {
    if (this.server) throw new Error('The MCP server is already running.');
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    this.server = server;
    this.expectation = { port, mcpKey, canvasKey };
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

  private refuse(res: http.ServerResponse, status: 401 | 403 | 404, reason: string, path: string): void {
    this.counters.refused[reason] = (this.counters.refused[reason] ?? 0) + 1;
    this.options.onRefused?.(reason, maskPath(path));
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not found');
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
      const bearer = bearerOf(header('authorization'));
      const earlier = decision.reason === 'mcp-key-invalid' && bearer !== undefined && this.options.isEarlierKey?.(bearer) === true;
      this.refuse(res, decision.status, earlier ? 'mcp-key-earlier-start' : decision.reason, path);
      return;
    }
    if (this.options.allowMcp && !this.options.allowMcp()) {
      this.refuse(res, 403, 'mcp-disabled', path);
      return;
    }
    const onCanvas = this.options.onCanvas;
    if (decision.canvasPath !== undefined && !onCanvas) {
      this.refuse(res, 404, 'unknown-path', path);
      return;
    }
    const route = decision.canvasPath !== undefined ? 'canvas' : 'mcp';
    this.counters.allowed[route] = (this.counters.allowed[route] ?? 0) + 1;
    if (route === 'mcp') noteClient(this.counters.clients, sanitizeShort(header('user-agent')));
    try {
      if (decision.canvasPath !== undefined && onCanvas) await onCanvas(req, res, decision.canvasPath);
      else await this.options.onMcp(req, res);
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
  return { allowed: {}, refused: {}, recentHosts: [], recentOrigins: [], recentPaths: [], clients: [] };
}
