// Whether VS Code's `http.noProxy` setting sends 127.0.0.1 past the network proxy. The Copilot
// runtime resolves proxies with the same precedence as VS Code, `http.noProxy` first; without this
// entry it may route the loopback MCP requests through a corporate web proxy, which blocks them
// and sees the bearer header. The MCP server is offered only when this holds.
//
// Only the bare entry counts. An entry with a port, such as `127.0.0.1:8080`, bypasses the proxy
// for that one port, while the server picks a random port at every start, so it counts as missing.

export const LOOPBACK_HOST = '127.0.0.1';

/** Whether the server may run: the same rule the diagnostics report uses to mark an entry as counting. */
export function loopbackBypassConfigured(noProxy: unknown): boolean {
  return evaluateNoProxy(noProxy).loopbackEntries.some(e => e.counts);
}

/** One loopback-related `http.noProxy` entry and whether it makes the server reachable. */
export interface LoopbackEntry {
  entry: string;
  counts: boolean;
  reason: string;
}

export interface NoProxyEvaluation {
  loopbackEntries: LoopbackEntry[];
  /** Every other entry is only counted: such entries may name internal hosts. */
  otherEntries: number;
}

function loopbackReason(entry: string): LoopbackEntry | undefined {
  const value = entry.trim().toLowerCase();
  if (value === LOOPBACK_HOST) return { entry: value, counts: true, reason: 'the server\'s address, for every port' };
  if (value.startsWith(`${LOOPBACK_HOST}:`)) {
    return { entry: value, counts: false, reason: 'has a port, so it covers that one port only; the server\'s port changes at every start' };
  }
  if (value === 'localhost' || value.startsWith('localhost:')) {
    return { entry: value, counts: false, reason: 'names localhost; the server is reached at 127.0.0.1' };
  }
  if (value === '::1' || value.startsWith('[::1]')) {
    return { entry: value, counts: false, reason: 'IPv6 loopback; the server listens on 127.0.0.1' };
  }
  if (value === '*' || value.startsWith('127.')) {
    return { entry: value, counts: false, reason: 'only the exact entry 127.0.0.1 is checked' };
  }
  return undefined;
}

/**
 * Explains a `http.noProxy` value for the diagnostics report: each loopback-related entry with
 * whether it counts and why, and the number of all other entries, which are never listed.
 */
export function evaluateNoProxy(noProxy: unknown): NoProxyEvaluation {
  const entries = Array.isArray(noProxy) ? noProxy : [];
  const loopbackEntries: LoopbackEntry[] = [];
  let otherEntries = 0;
  for (const entry of entries) {
    const loopback = typeof entry === 'string' ? loopbackReason(entry) : undefined;
    if (loopback) loopbackEntries.push({ ...loopback, entry: loopback.entry.replace(/[^\x20-\x7e]/g, '?').slice(0, 60) });
    else otherEntries++;
  }
  return { loopbackEntries, otherEntries };
}
