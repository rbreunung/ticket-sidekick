// Whether VS Code's `http.noProxy` setting sends 127.0.0.1 past the network proxy. The Copilot
// runtime resolves proxies with the same precedence as VS Code, `http.noProxy` first; without this
// entry it may route the loopback MCP requests through a corporate web proxy, which blocks them
// and sees the bearer header. The MCP server is offered only when this holds.
//
// Only the bare entry counts. An entry with a port, such as `127.0.0.1:8080`, bypasses the proxy
// for that one port, while the server picks a random port at every start, so it counts as missing.

export const LOOPBACK_HOST = '127.0.0.1';

export function loopbackBypassConfigured(noProxy: unknown): boolean {
  if (!Array.isArray(noProxy)) return false;
  return noProxy.some(entry => typeof entry === 'string' && entry.trim() === LOOPBACK_HOST);
}
