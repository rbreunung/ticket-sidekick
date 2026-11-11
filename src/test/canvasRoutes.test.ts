import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { LocalhostServer } from '../mcp/localhostServer';
import { generateKey } from '../mcp/keys';
import { CANVAS_CONTENT_POLICY, createCanvasHandler, readJson, sendJson, type CanvasRoute } from '../canvas/canvasRoutes';

// Canvas pages over a real loopback socket: the server routes paths under the canvas key to the
// canvas handler, which answers every request with the canvas security headers.

let server: LocalhostServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const echoRoutes: CanvasRoute[] = [
  { method: 'GET', path: '/echo', handle: async (_req, res, ctx) => sendJson(res, 200, { project: ctx.query.get('project') }) },
  { method: 'POST', path: '/echo', handle: async (req, res) => sendJson(res, 200, { got: await readJson(req) }) },
];

async function startServer(refused: Array<{ reason: string; path: string }> = []) {
  const handled: string[] = [];
  server = new LocalhostServer({
    onMcp: async (_req, res) => { res.statusCode = 204; res.end(); },
    onCanvas: async (req, res, canvasPath) => { handled.push(canvasPath); await createCanvasHandler(echoRoutes)(req, res, canvasPath); },
    onRefused: (reason, path) => refused.push({ reason, path }),
  });
  const canvasKey = generateKey();
  const port = await server.start(generateKey(), canvasKey);
  return { port, canvasKey, handled };
}

function send(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

describe('canvas pages on the localhost server', () => {
  it('serves a route under the canvas key with its query', async () => {
    const { port, canvasKey, handled } = await startServer();
    const res = await send(port, `/${canvasKey}/echo?project=PROJ`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ project: 'PROJ' });
    expect(handled).toEqual(['/echo']);
    expect(server?.stats().allowed.canvas).toBe(1);
  });

  it('refuses a wrong canvas key with 401 and logs the path with the key masked', async () => {
    const refused: Array<{ reason: string; path: string }> = [];
    const { port, handled } = await startServer(refused);
    const wrong = generateKey();
    const res = await send(port, `/${wrong}/echo`);
    expect(res.status).toBe(401);
    expect(handled).toEqual([]);
    expect(refused).toEqual([{ reason: 'canvas-key-invalid', path: '/[key]/echo' }]);
    expect(server?.stats().refused['canvas-key-invalid']).toBe(1);
  });

  it('refuses a canvas request from a foreign origin before the handler runs', async () => {
    const { port, canvasKey, handled } = await startServer();
    const res = await send(port, `/${canvasKey}/echo`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(handled).toEqual([]);
  });

  it('refuses the earlier canvas key after a stop and start', async () => {
    const { canvasKey } = await startServer();
    await server!.stop();
    const port = await server!.start(generateKey(), generateKey());
    expect((await send(port, `/${canvasKey}/echo`)).status).toBe(401);
  });

  it('answers every canvas response with the content policy, no caching and no referrer', async () => {
    const { port, canvasKey } = await startServer();
    for (const path of ['/echo', '/missing']) {
      const res = await send(port, `/${canvasKey}${path}`);
      expect(res.headers['content-security-policy']).toBe(CANVAS_CONTENT_POLICY);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('accepts a JSON body and refuses any other content type with 415', async () => {
    const { port, canvasKey } = await startServer();
    const json = await send(port, `/${canvasKey}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(JSON.parse(json.body)).toEqual({ got: { a: 1 } });
    const form = await send(port, `/${canvasKey}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
    expect(form.status).toBe(415);
  });

  it('has no canvas route when the server was started without a canvas key', async () => {
    server = new LocalhostServer({ onMcp: async (_req, res) => { res.end(); }, onCanvas: async (_req, res) => { res.end('reached'); } });
    const port = await server.start(generateKey());
    expect((await send(port, `/${generateKey()}/echo`)).status).toBe(404);
  });
});

describe('logging canvas requests', () => {
  it('reports each request\'s path after the key, its status and duration, never the key', async () => {
    const served: Array<{ method: string; path: string; status: number; ms: number }> = [];
    const handler = createCanvasHandler(echoRoutes, undefined, entry => served.push(entry));
    server = new LocalhostServer({ onMcp: async (_req, res) => { res.end(); }, onCanvas: handler });
    const canvasKey = generateKey();
    const port = await server.start(generateKey(), canvasKey);
    await send(port, `/${canvasKey}/echo?project=PROJ`);
    await send(port, `/${canvasKey}/missing`);
    expect(served.map(e => [e.method, e.path, e.status])).toEqual([['GET', '/echo', 200], ['GET', '/missing', 404]]);
    expect(served.every(e => e.ms >= 0)).toBe(true);
    expect(JSON.stringify(served)).not.toContain(canvasKey);
  });
});

