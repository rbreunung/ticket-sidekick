import * as fs from 'fs';
import * as path from 'path';
import type { ServerStats } from './localhostServer';

// The prototype report: one plain-text block a tester copies and pastes back. It carries the
// evidence for the prototype's open checks (does the Agent Host store the MCP key, does a sandbox
// block loopback, how do several windows behave, how is the folder protected). `buildReport`
// formats facts; `redact` removes every key and token afterwards as a last line of defence.

export interface ReportEntry {
  pid: number;
  port: number;
  workspaceFolders: string[];
  startedAt: string;
  alive: boolean;
}

export interface KeyScanResult {
  /** Which key was searched: the running server's, or the last run's after a stop. */
  keyKind?: 'current' | 'last-run';
  matches: string[];
  filesScanned: number;
  capped: boolean;
  roots: string[];
  missingRoots: string[];
}

export interface ReportFacts {
  generatedAt: string;
  vscodeVersion: string;
  extensionVersion: string;
  os: string;
  providerApiAvailable: boolean;
  /** Whether 127.0.0.1 is in http.noProxy; the MCP server is offered to Copilot only then. */
  loopbackBypass: boolean;
  running: boolean;
  port: number | undefined;
  pid: number;
  workspaceFolders: string[];
  stats: ServerStats;
  prototypeFolder: string;
  folderPermissions: string;
  entries: ReportEntry[];
  skippedEntries: string[];
  launcherLog: string[];
  chatSettings: Record<string, unknown>;
  keyScan: KeyScanResult | undefined;
  /** Free text the caller adds; redacted like everything else. */
  recentNote?: string;
}

function list(values: string[]): string {
  return values.length ? values.join(', ') : '(none)';
}

function counts(record: Record<string, number>): string {
  const parts = Object.entries(record).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(', ') : '(none)';
}

export function buildReport(f: ReportFacts): string {
  const lines: string[] = [];
  lines.push('Ticket Sidekick prototype report', `Generated: ${f.generatedAt}`, '');
  lines.push('## Environment');
  lines.push(`VS Code ${f.vscodeVersion}; Ticket Sidekick ${f.extensionVersion}; ${f.os}`);
  lines.push(`MCP server registration API available: ${f.providerApiAvailable ? 'yes' : 'no'}`, '');

  lines.push('## Server');
  lines.push(`State: ${f.running ? 'running' : 'stopped'}${f.port ? ` on 127.0.0.1:${f.port}` : ''}; window pid ${f.pid}`);
  lines.push(`MCP server offered to Copilot: ${f.running && f.loopbackBypass ? 'yes' : 'no'} (127.0.0.1 in http.noProxy: ${f.loopbackBypass ? 'yes' : 'no'})`);
  lines.push(`Workspace folders: ${list(f.workspaceFolders)}`, '');

  lines.push('## Requests');
  lines.push(`MCP requests with a valid key: ${f.stats.allowed.mcp ?? 0}`);
  lines.push(`Allowed: ${counts(f.stats.allowed)}`);
  lines.push(`Refused: ${counts(f.stats.refused)}`);
  lines.push(`Host headers seen: ${list(f.stats.recentHosts)}`);
  lines.push(`Origins seen: ${list(f.stats.recentOrigins)}`);
  lines.push(`Paths seen: ${list(f.stats.recentPaths)}`);
  lines.push(`MCP client user agents: ${list(f.stats.userAgents)}`, '');

  lines.push('## Prototype folder');
  lines.push(`Path: ${f.prototypeFolder}`);
  lines.push(`Permissions: ${f.folderPermissions}`, '');

  lines.push('## Windows');
  if (f.entries.length === 0) lines.push('No rendezvous entries.');
  for (const e of f.entries) {
    lines.push(`- pid ${e.pid} (${e.alive ? 'alive' : 'not running'}), port ${e.port}, started ${e.startedAt}, folders: ${list(e.workspaceFolders)}`);
  }
  if (f.skippedEntries.length) lines.push(`Unreadable entries: ${list(f.skippedEntries)}`);
  lines.push('');

  lines.push('## Launcher');
  if (f.launcherLog.length === 0) lines.push('no launcher activity');
  else lines.push(...f.launcherLog);
  lines.push('');

  lines.push('## Settings');
  const settings = Object.entries(f.chatSettings);
  if (settings.length === 0) lines.push('(no chat sandbox, canvas or MCP settings found)');
  for (const [key, value] of settings) lines.push(`${key} = ${JSON.stringify(value)}`);
  lines.push('');

  lines.push('## Stored key search');
  if (!f.keyScan) {
    lines.push('Not run: the prototype has not run in this window since VS Code started, so there is no key to search for.');
  } else {
    const s = f.keyScan;
    lines.push(`Searched: ${list(s.roots)}`);
    if (s.missingRoots.length) lines.push(`Missing: ${list(s.missingRoots)}`);
    lines.push(`Files scanned: ${s.filesScanned}${s.capped ? ` (stopped after ${s.filesScanned} files)` : ''}`);
    const label = s.keyKind === 'last-run' ? 'MCP key of the last run (prototype stopped)' : 'Current MCP key';
    lines.push(s.matches.length ? `${label} FOUND in: ${list(s.matches)}` : `${label}: not found`);
  }
  if (f.recentNote) lines.push('', f.recentNote);
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
  maxFileBytes: number;
  skip: string[];
}

/**
 * Looks for a secret in every file under the given folders, within limits. Reports only which
 * files contain it; file contents never leave this function.
 */
export async function scanForSecret(roots: string[], secret: string, limits: ScanLimits): Promise<KeyScanResult> {
  const needle = Buffer.from(secret, 'utf8');
  const skip = limits.skip.map(s => path.resolve(s));
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
      if (skip.some(s => path.resolve(full) === s || path.resolve(full).startsWith(s + path.sep))) continue;
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
