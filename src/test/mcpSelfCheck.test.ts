import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkOverHttp, checkOverSocket } from '../mcp/selfCheck';

// The extension's own requests to its server, for the diagnostics report: they say whether the
// server answers, without ever putting the key into the result.

let server: http.Server | undefined;

async function listen(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await new Promise(resolve => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('the self check', () => {
  it('reports the status the server answers, over the plain socket and over http', async () => {
    const seen: Array<{ host?: string; auth?: string; path?: string }> = [];
    const port = await listen((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization, path: req.url });
      req.resume();
      res.statusCode = req.headers.authorization === 'Bearer the-key' ? 200 : 401;
      res.end('{}');
    });
    expect((await checkOverSocket(port, 'the-key')).outcome).toBe('HTTP 200');
    expect((await checkOverHttp(port, 'the-key')).outcome).toBe('HTTP 200');
    expect((await checkOverSocket(port, 'wrong')).outcome).toBe('HTTP 401');
    expect(seen[0]).toEqual({ host: `127.0.0.1:${port}`, auth: 'Bearer the-key', path: '/mcp' });
  });

  it('names the failure when nothing listens, and never repeats the key', async () => {
    const port = await listen(() => undefined);
    await new Promise(resolve => server!.close(resolve));
    server = undefined;
    const socket = await checkOverSocket(port, 'the-key');
    const viaHttp = await checkOverHttp(port, 'the-key');
    expect(socket.outcome).toBe('ECONNREFUSED');
    expect(viaHttp.outcome).toBe('ECONNREFUSED');
    expect(JSON.stringify([socket, viaHttp])).not.toContain('the-key');
  });
});
