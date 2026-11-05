// Whether VS Code's `http.noProxy` setting sends 127.0.0.1 past the network proxy. The Copilot
// runtime resolves proxies with the same precedence as VS Code, `http.noProxy` first; without this
// entry it may route the prototype's loopback MCP requests through a corporate web proxy, which
// blocks them and sees the bearer header. The prototype offers its MCP server only when this holds.

export const LOOPBACK_HOST = '127.0.0.1';

export function loopbackBypassConfigured(noProxy: unknown): boolean {
  if (!Array.isArray(noProxy)) return false;
  return noProxy.some(entry => {
    if (typeof entry !== 'string') return false;
    const value = entry.trim();
    return value === LOOPBACK_HOST || value.startsWith(`${LOOPBACK_HOST}:`);
  });
}
