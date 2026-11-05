import * as fs from 'fs';
import * as path from 'path';
import type { NoProxyEvaluation } from './proxyBypass';
import type { ControllerSnapshot, HistoryEntry } from './serverController';

// The MCP diagnostics report: one plain-text block a user copies and sends to support when the
// Jira tools do not show up in a Copilot chat. Every fact comes from in-memory counters or
// settings; it never holds tool arguments or results, the Jira base URL, or `http.noProxy`
// entries other than the loopback ones. `buildReport` formats the facts; `redact` removes every
// key and token afterwards as a last line of defence.

export interface KeyScanResult {
  matches: string[];
  filesScanned: number;
  capped: boolean;
  roots: string[];
  missingRoots: string[];
}

export interface ProxyFacts {
  noProxy: NoProxyEvaluation;
  /** Whether `http.proxy` is set; its value is never shown. */
  proxySet: boolean;
  /** The `http.proxySupport` value; anything but `off` lets VS Code discover the system proxy. */
  proxySupport: string;
}

export interface JiraFacts {
  configured: boolean;
  authType: string;
  tokenPresent: boolean;
}

export interface ReportFacts {
  generatedAt: string;
  vscodeVersion: string;
  extensionVersion: string;
  os: string;
  providerApiAvailable: boolean;
  /** Whether 127.0.0.1 is in http.noProxy; the server is offered to VS Code only then. */
  loopbackBypass: boolean;
  /** Undefined without the provider API, since then no server exists. */
  server: ControllerSnapshot | undefined;
  proxy: ProxyFacts;
  jira: JiraFacts;
  chatSettings: Record<string, unknown>;
  /** Undefined when the server is not running, so there is no key to search for. */
  keyScan: KeyScanResult | undefined;
}

function list(values: string[]): string {
  return values.length ? values.join(', ') : '(none)';
}

function counts(record: Record<string, number>): string {
  const parts = Object.entries(record).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : '(none)';
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function offeredLine(f: ReportFacts): string {
  const entry = `127.0.0.1 in http.noProxy: ${yesNo(f.loopbackBypass)}`;
  if (!f.providerApiAvailable) return 'MCP server offered: no (MCP server provider API missing)';
  if (!f.loopbackBypass) return `MCP server offered: no (${entry})`;
  if (!f.server?.running) return `MCP server offered: no (server not running; ${entry})`;
  return `MCP server offered: yes (${entry})`;
}

function historyLine(e: HistoryEntry): string {
  if (e.event === 'started') return `- ${e.at}: started on port ${e.port} (${e.trigger})`;
  if (e.event === 'stopped') return `- ${e.at}: stopped (${e.trigger})`;
  return `- ${e.at}: start failed (${e.trigger})`;
}

function earlierPorts(s: ControllerSnapshot): number[] {
  const ports = s.history.filter(e => e.event === 'started' && e.port !== undefined).map(e => e.port as number);
  return [...new Set(ports)].filter(p => p !== s.port);
}

export function buildReport(f: ReportFacts): string {
  const lines: string[] = [];
  const s = f.server;
  lines.push('Ticket Sidekick MCP diagnostics', `Generated: ${f.generatedAt}`, '');

  lines.push('## Environment');
  lines.push(`VS Code ${f.vscodeVersion}; Ticket Sidekick ${f.extensionVersion}; ${f.os}`);
  lines.push(`MCP server provider API present: ${yesNo(f.providerApiAvailable)}`, '');

  lines.push('## Server');
  if (!s) lines.push('State: not started (this VS Code has no MCP server provider API)');
  else lines.push(`State: ${s.running ? `running on 127.0.0.1:${s.port}` : 'stopped'}`);
  lines.push(offeredLine(f), '');

  if (s) {
    lines.push('## Server history (this VS Code session)');
    if (s.history.length === 0) lines.push('No start or stop yet.');
    lines.push(...s.history.map(historyLine));
    lines.push(`Current port: ${s.port ?? '(none)'}`);
    lines.push(`Earlier ports: ${list(earlierPorts(s).map(String))}`, '');

    lines.push('## Definition handshake');
    lines.push(`Change announcements fired: ${s.announcements}`);
    lines.push(`Resolve requests served: ${s.resolveServed}, refused: ${s.resolveRefused}`, '');

    const { stats } = s;
    lines.push('## Requests (since the last start)');
    lines.push(`MCP requests with a valid key: ${stats.allowed.mcp ?? 0}`);
    lines.push(`Refused: ${counts(stats.refused)}`);
    lines.push(
      `Refused key checks: key from an earlier start ${stats.refused['mcp-key-earlier-start'] ?? 0}, `
      + `unknown key ${stats.refused['mcp-key-invalid'] ?? 0}`,
    );
    lines.push(`Host headers seen: ${list(stats.recentHosts)}`);
    lines.push(`Origins seen: ${list(stats.recentOrigins)}`);
    lines.push(`Paths seen: ${list(stats.recentPaths)}`, '');

    lines.push('## MCP clients');
    if (stats.clients.length === 0) lines.push('No client has sent a request with a valid key since the last start.');
    for (const c of stats.clients) lines.push(`- ${c.userAgent} (last request ${c.lastSeen})`);
    lines.push('');

    lines.push('## Tool calls');
    const tools = Object.entries(s.toolCalls);
    if (tools.length === 0) lines.push('No tool calls yet.');
    for (const [tool, c] of tools) {
      const failedTotal = Object.values(c.failed).reduce((a, b) => a + b, 0);
      const detail = Object.entries(c.failed).map(([label, n]) => `${label} ×${n}`).join(', ');
      lines.push(`${tool}: ok ${c.ok}, failed ${failedTotal}${detail ? ` (${detail})` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Proxy');
  if (f.proxy.noProxy.loopbackEntries.length === 0) lines.push('Loopback entries in http.noProxy: (none)');
  for (const e of f.proxy.noProxy.loopbackEntries) {
    lines.push(`- ${e.entry}: ${e.counts ? 'counts' : 'ignored'} (${e.reason})`);
  }
  lines.push(`Other entries: ${f.proxy.noProxy.otherEntries} (not listed)`);
  lines.push(`http.proxy set: ${yesNo(f.proxy.proxySet)}`);
  lines.push(`System proxy discovery: ${yesNo(f.proxy.proxySupport !== 'off')} (http.proxySupport: ${f.proxy.proxySupport})`, '');

  lines.push('## Jira configuration');
  lines.push(`Configured: ${yesNo(f.jira.configured)}`);
  lines.push(`Auth type: ${f.jira.authType}`);
  lines.push(`Token present: ${yesNo(f.jira.tokenPresent)}`, '');

  lines.push('## Settings');
  const settings = Object.entries(f.chatSettings);
  if (settings.length === 0) lines.push('(no chat.mcp or sandbox settings found)');
  for (const [key, value] of settings) lines.push(`${key} = ${JSON.stringify(value)}`);
  lines.push('');

  lines.push('## Stored key search');
  if (!f.keyScan) {
    lines.push('Not run: the server is not running, so there is no current key to search for.');
  } else {
    const k = f.keyScan;
    lines.push(`Searched: ${list(k.roots)}`);
    if (k.missingRoots.length) lines.push(`Missing: ${list(k.missingRoots)}`);
    lines.push(`Files scanned: ${k.filesScanned}${k.capped ? ` (stopped after ${k.filesScanned} files)` : ''}`);
    lines.push(k.matches.length ? `Current MCP key FOUND in: ${list(k.matches)}` : 'Current MCP key: not found');
  }
  return lines.join('\n');
}

/** Replaces every occurrence of each secret with [redacted]. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter(s => s.length >= 8)) out = out.split(secret).join('[redacted]');
  return out;
}

/** The Copilot home folder: `COPILOT_HOME` when set, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv, homedir: string): string {
  const custom = env.COPILOT_HOME?.trim();
  return custom ? custom : path.join(homedir, '.copilot');
}

export interface ScanLimits {
  maxFiles: number;
  maxFileBytes: number;
}

/**
 * Looks for a secret in every file under the given folders, within limits. Reports only which
 * files contain it; file contents never leave this function.
 */
export async function scanForSecret(roots: string[], secret: string, limits: ScanLimits): Promise<KeyScanResult> {
  const needle = Buffer.from(secret, 'utf8');
  const result: KeyScanResult = { matches: [], filesScanned: 0, capped: false, roots: [...roots], missingRoots: [] };

  async function walk(dir: string): Promise<void> {
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (result.capped) return;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        if (result.filesScanned >= limits.maxFiles) { result.capped = true; return; }
        result.filesScanned++;
        try {
          const stat = await fs.promises.stat(full);
          if (stat.size > limits.maxFileBytes) continue;
          const content = await fs.promises.readFile(full);
          if (content.includes(needle)) result.matches.push(full);
        } catch {
          // Unreadable files (locked databases, permissions) are skipped.
        }
      }
    }
  }

  for (const root of roots) {
    try {
      await fs.promises.access(root);
    } catch {
      result.missingRoots.push(root);
      continue;
    }
    await walk(root);
  }
  return result;
}
