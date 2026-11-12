import * as http from 'http';
import * as net from 'net';

// Two requests the extension sends to its own MCP endpoint for the diagnostics report. The first
// goes over a plain socket, so nothing between the extension and its server can interfere: it
// shows whether the server answers at all. The second goes through Node's http module, which VS
// Code routes through its proxy handling: a different outcome there means a proxy setting takes
// requests to 127.0.0.1 somewhere else. Neither result contains the key.

export interface SelfCheckResult {
  /** The HTTP status, or the error's code or first line when no answer came. */
  outcome: string;
  ms: number;
}

const TIMEOUT_MS = 4000;
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ticket-sidekick-self-check', version: '1' } },
});

function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  return typeof e?.code === 'string' ? e.code : String(e?.message ?? err).split(/\r?\n/)[0].slice(0, 120);
}

/** A request over a plain socket to 127.0.0.1, which no proxy handling can redirect. */
export function checkOverSocket(port: number, key: string): Promise<SelfCheckResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const done = (outcome: string) => { socket.destroy(); resolve({ outcome, ms: Date.now() - started }); };
    const socket = net.connect({ host: '127.0.0.1', port });
    let head = '';
    socket.setTimeout(TIMEOUT_MS, () => done('no answer in time'));
    socket.on('error', err => done(errorText(err)));
    socket.on('connect', () => {
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${key}\r\n`
        + 'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n'
        + `Content-Length: ${Buffer.byteLength(INITIALIZE)}\r\nConnection: close\r\n\r\n${INITIALIZE}`,
      );
    });
    socket.on('data', chunk => {
      head += chunk.toString('latin1');
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (match) done(`HTTP ${match[1]}`);
    });
    socket.on('close', () => done(head ? 'unreadable answer' : 'closed without an answer'));
  });
}

/** The same request through Node's http module, as VS Code's proxy handling sees it. */
export function checkOverHttp(port: number, key: string): Promise<SelfCheckResult> {
  const started = Date.now();
  return new Promise(resolve => {
    const done = (outcome: string) => resolve({ outcome, ms: Date.now() - started });
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST', timeout: TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(INITIALIZE),
      },
    }, res => {
      res.resume();
      done(`HTTP ${res.statusCode}`);
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', err => done(errorText(err)));
    req.end(INITIALIZE);
  });
}
