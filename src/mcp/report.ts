import * as fs from 'fs';
import * as path from 'path';
import { maskKeys } from '../utils/keyMask';
import type { NoProxyEvaluation } from './proxyBypass';
import type { ControllerSnapshot, HistoryEntry } from './serverController';

// The MCP diagnostics report: one plain-text block a user copies and sends to support when the
// Jira tools do not show up in a Copilot chat. Every fact comes from in-memory counters or
// settings; it never holds tool arguments or results, the Jira base URL, or `http.noProxy`
// entries other than the loopback ones. The `chat.mcp.*` and sandbox settings are shown with
// their values, as they are. Paths under the home folder are shown with `~`. `buildReport`
// formats the facts; `redact` removes every key and token afterwards as a last line of defence.

/** Why the stored-key search ended before it had read every file. */
export type ScanStop = 'file-limit' | 'byte-limit' | 'cancelled';

export interface KeyScanResult {
  matches: string[];
  filesScanned: number;
  /** Bytes of file content read so far, counted against `limits.maxTotalBytes`. */
  bytesRead: number;
  /** Undefined when every file under the roots was checked. */
  stopped: ScanStop | undefined;
  limits: ScanLimits;
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

/** What the extension can observe of VS Code's side of the connection. */
export interface HostFacts {
  /** The build the running extension was made from. */
  build: string;
  /** Where the extension runs from, and other installed copies of it next to that folder. */
  installFolder: string;
  otherCopies: string[];
  /** How often VS Code asked for the server definition, and when last. */
  provideCalls: number;
  lastProvideAt?: string;
  /** Each time VS Code asked for the address and key to start the server. */
  resolveCalls: string[];
  /** The tools of this server that VS Code offers to chats. */
  toolsListed: number;
  /** The extension's own requests to its server; undefined when the server is not running. */
  selfCheck?: { socket: string; http: string };
  /** MCP configuration files that name a server like this one, which can make VS Code disable one of the two. */
  sameNameIn: string[];
  /** The newest lines about MCP from VS Code's own log files of this window, masked. */
  vscodeLog?: string[];
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
  /** The user's home folder, shown as `~` in paths; Windows paths compare without letter case. */
  home: { dir: string; windows: boolean };
  /** The newest lines of the canvas program's log, as written (keys are masked here). */
  canvasLog: string[];
  host?: HostFacts;
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

/** `p` with a leading home folder replaced by `~` (`~/…`, or `~\…` on Windows). */
export function withHomeAsTilde(p: string, home: { dir: string; windows: boolean }): string {
  const separators = home.windows ? ['\\', '/'] : ['/'];
  let dir = home.dir;
  while (dir.length > 1 && separators.includes(dir[dir.length - 1])) dir = dir.slice(0, -1);
  if (!dir) return p;
  const head = p.slice(0, dir.length);
  const same = home.windows ? head.toLowerCase() === dir.toLowerCase() : head === dir;
  if (!same) return p;
  if (p.length === dir.length) return '~';
  return separators.includes(p[dir.length]) ? `~${p.slice(dir.length)}` : p;
}

function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb && bytes % mb === 0 ? `${bytes / mb} MB` : `${bytes} bytes`;
}

function scanStatus(k: KeyScanResult): string {
  if (k.stopped === 'file-limit') return ` (stopped after ${k.filesScanned} files)`;
  if (k.stopped === 'byte-limit') {
    return ` (search stopped after ${formatBytes(k.limits.maxTotalBytes)}: ${k.filesScanned} files checked; the rest was not searched)`;
  }
  if (k.stopped === 'cancelled') return ` (search cancelled: ${k.filesScanned} files checked; the rest was not searched)`;
  return '';
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
    const h = f.host;
    if (h) {
      lines.push(`VS Code asked for the server definition: ${h.provideCalls} time(s)${h.lastProvideAt ? `, last at ${h.lastProvideAt}` : ''}`);
      lines.push(`VS Code asked to start the server: ${h.resolveCalls.length} time(s)${h.resolveCalls.length ? `: ${h.resolveCalls.join('; ')}` : ''}`);
      lines.push(`Tools of this server VS Code offers to chats: ${h.toolsListed}`);
      if (h.provideCalls > 0 && h.resolveCalls.length === 0 && h.toolsListed === 0) {
        lines.push('Reading: VS Code knows the server but never tried to start it through the extension. Look at "MCP: List Servers" for its state, and below for a server of the same name.');
      }
      lines.push('');
      lines.push('## Self check');
      if (!h.selfCheck) lines.push('Not run: the server is not running.');
      else {
        lines.push(`Direct to 127.0.0.1 (plain socket): ${h.selfCheck.socket}`);
        lines.push(`Through VS Code's proxy handling (Node http): ${h.selfCheck.http}`);
        if (h.selfCheck.socket.startsWith('HTTP 200') && !h.selfCheck.http.startsWith('HTTP 200')) {
          lines.push('Reading: the server answers, but a request through the proxy handling does not reach it. A proxy setting takes requests to 127.0.0.1 elsewhere.');
        }
      }
      lines.push('');
      lines.push('## Installation');
      lines.push(`Build: ${h.build}`);
      lines.push(`Runs from: ${withHomeAsTilde(h.installFolder, f.home)}`);
      lines.push(`Other copies of the extension next to it: ${list(h.otherCopies)}`);
      lines.push(`A server of the same name in: ${list(h.sameNameIn.map(p => withHomeAsTilde(p, f.home)))}`);
      lines.push('');
    }

    if (h?.vscodeLog) {
      lines.push("## VS Code's own log about MCP (this window, newest lines)");
      if (h.vscodeLog.length === 0) lines.push('No line about MCP in this window\'s log files.');
      else lines.push(...h.vscodeLog.map(line => `- ${line}`));
      lines.push('');
    }

    lines.push('## Requests (since the last start)');
    lines.push(`MCP requests with a valid key: ${stats.allowed.mcp ?? 0}`);
    lines.push(`Canvas requests with a valid key: ${stats.allowed.canvas ?? 0}`);
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

  lines.push('## Canvas');
  if (f.canvasLog.length === 0) lines.push('No canvas log yet.');
  else lines.push('Newest decisions of the canvas program:', ...f.canvasLog.map(line => `- ${maskKeys(line)}`));
  lines.push('');

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
  // A setting's value may be a path under the home folder, which carries the user's name.
  const withoutHome = (text: string) => text.replace(/((?:\/|%2F|\\\\)(?:Users|home)(?:\/|%2F|\\\\))[^\/\\%"',\]\s]+/gi, '$1~');
  for (const [key, value] of settings) lines.push(`${key} = ${withoutHome(JSON.stringify(value))}`);
  lines.push('');

  lines.push('## Stored key search');
  if (!f.keyScan) {
    lines.push('Not run: the server is not running, so there is no current key to search for.');
  } else {
    const k = f.keyScan;
    const shown = (paths: string[]) => list(paths.map(p => withHomeAsTilde(p, f.home)));
    lines.push(`Searched: ${shown(k.roots)}`);
    if (k.missingRoots.length) lines.push(`Missing: ${shown(k.missingRoots)}`);
    lines.push(`Files scanned: ${k.filesScanned}${scanStatus(k)}`);
    lines.push(k.matches.length ? `Current MCP key FOUND in: ${shown(k.matches)}` : 'Current MCP key: not found');
  }
  return lines.join('\n');
}

/** Replaces every occurrence of each secret with [redacted]. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter(s => s.length >= 8)) out = out.split(secret).join('[redacted]');
  return out;
}


export interface ScanLimits {
  maxFiles: number;
  /** Larger files are skipped. */
  maxFileBytes: number;
  /** The search stops before a file would take the bytes read past this budget. */
  maxTotalBytes: number;
}

/** The limits the diagnostics command searches with. */
export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxFiles: 20000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

/**
 * Looks for a secret in every file under the given folders, within limits, until `isCancelled`
 * says to stop. Reports only which files contain it; file contents never leave this function.
 */
export async function scanForSecret(
  roots: string[],
  secret: string,
  limits: ScanLimits,
  isCancelled: () => boolean = () => false,
): Promise<KeyScanResult> {
  const needle = Buffer.from(secret, 'utf8');
  const result: KeyScanResult = {
    matches: [], filesScanned: 0, bytesRead: 0, stopped: undefined, limits, roots: [...roots], missingRoots: [],
  };

  async function walk(dir: string): Promise<void> {
    let items: fs.Dirent[];
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (result.stopped) return;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile()) {
        if (isCancelled()) { result.stopped = 'cancelled'; return; }
        if (result.filesScanned >= limits.maxFiles) { result.stopped = 'file-limit'; return; }
        const size = await fs.promises.stat(full).then(st => st.size, () => undefined);
        const readable = size !== undefined && size <= limits.maxFileBytes;
        if (readable && result.bytesRead + size > limits.maxTotalBytes) { result.stopped = 'byte-limit'; return; }
        result.filesScanned++;
        if (!readable) continue;
        try {
          const content = await fs.promises.readFile(full);
          result.bytesRead += content.length;
          if (content.includes(needle)) result.matches.push(full);
        } catch {
          // Unreadable files (locked databases, permissions) are skipped.
        }
      }
    }
  }

  for (const root of roots) {
    if (result.stopped) break;
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
