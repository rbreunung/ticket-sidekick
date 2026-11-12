import * as fs from 'fs';
import * as path from 'path';

// VS Code writes why it could not start an MCP server into its own log files, not into anything an
// extension can ask for. For the diagnostics report, this reads the newest lines about MCP from
// the log files of the current window. Addresses other than this computer's are masked, since a
// line may name another server's host.

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 400;
const RELEVANT = /mcp|ticket.?sidekick/i;

/** Masks every address that is not this computer's, and anything shaped like a long key. */
export function maskLogLine(line: string): string {
  return line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, url => (/^https?:\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/i.test(url) ? url.replace(/(:\d+)\/[^\s]*/, '$1/…') : '<address>'))
    .replace(/[A-Za-z0-9_-]{32,}/g, '<long value>')
    .slice(0, MAX_LINE_CHARS);
}

async function logFiles(dir: string, depth: number): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) files.push(...await logFiles(full, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.log')) files.push(full);
  }
  return files;
}

/** The end of a file as text; a large file is read from its last two megabytes. */
async function tail(file: string): Promise<string> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The newest lines that mention MCP in the log files under `windowLogDir`, each prefixed with its
 * file's name, masked, oldest first. Lines of warning or error level come first in the choice, so
 * a busy log does not push the one error out.
 */
export async function collectMcpLogLines(windowLogDir: string, limit: number): Promise<string[]> {
  const found: Array<{ file: string; line: string; serious: boolean }> = [];
  for (const file of await logFiles(windowLogDir, 3)) {
    let text: string;
    try {
      text = await tail(file);
    } catch {
      continue;
    }
    const name = path.relative(windowLogDir, file);
    for (const line of text.split(/\r?\n/)) {
      if (!RELEVANT.test(line)) continue;
      found.push({ file: name, line: line.trim(), serious: /\[(error|warning|warn)\]|error:/i.test(line) });
    }
  }
  const serious = found.filter(f => f.serious).slice(-limit);
  const rest = found.filter(f => !f.serious).slice(-Math.max(0, limit - serious.length));
  // Log lines start with their time, so sorting the chosen ones by text puts them in order.
  return [...serious, ...rest].sort((a, b) => a.line.localeCompare(b.line)).map(f => `${f.file}: ${maskLogLine(f.line)}`);
}
