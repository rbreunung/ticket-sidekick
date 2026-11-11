import * as fs from 'fs';
import * as path from 'path';

// The canvas program runs in the Copilot runtime, outside VS Code, so its decisions cannot reach
// the extension's Output channel. It appends one JSON line per decision to a user-only log file next
// to the window notes, and the diagnostics report shows the latest lines. A record carries counts,
// choices and outcomes only: never a canvas key, an address or report data.

const MAX_LOG_BYTES = 64 * 1024;
const KEEP_BYTES = 32 * 1024;

export function canvasLogFile(copilotHomeDir: string): string {
  return path.join(copilotHomeDir, 'ticket-sidekick', 'canvas-log.jsonl');
}

/** Appends one record with its time; trims the file to its newest lines once it outgrows the cap. Never throws. */
export async function appendCanvasLog(file: string, record: Record<string, string | number | boolean>): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    const { size } = await fs.promises.stat(file);
    if (size > MAX_LOG_BYTES) {
      const text = await fs.promises.readFile(file, 'utf8');
      const tail = text.slice(text.length - KEEP_BYTES);
      await fs.promises.writeFile(file, tail.slice(tail.indexOf('\n') + 1), { mode: 0o600 });
    }
  } catch {
    // Logging is best effort: a full disk must not stop a canvas from opening.
  }
}

/** The newest lines of the canvas log, or an empty list when there is none. */
export async function readCanvasLog(file: string, maxLines: number): Promise<string[]> {
  try {
    const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** Masks every run of 32 or more key characters as `[key]`, the length rule the server uses for logged paths. */
export function maskKeys(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{32,}/g, '[key]');
}
