import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendCanvasLog, canvasLogFile, readCanvasLog } from '../canvas/canvasLog';
import { maskKeys } from '../utils/keyMask';

// The canvas program's own log: one line per decision, user-only, capped in size, and safe to
// copy into a diagnostics report.

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true }); });

function logFile(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-canvaslog-'));
  homes.push(home);
  return canvasLogFile(home);
}

describe('the canvas log', () => {
  it('appends one line per decision with its time', async () => {
    const file = logFile();
    await appendCanvasLog(file, { event: 'open', windows: 2, choice: 'selected', opened: true });
    const lines = await readCanvasLog(file, 10);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'open', windows: 2, choice: 'selected', opened: true });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps its newest lines once it outgrows the cap', async () => {
    const file = logFile();
    for (let i = 0; i < 1500; i++) await appendCanvasLog(file, { event: 'open', n: i });
    expect(fs.statSync(file).size).toBeLessThanOrEqual(64 * 1024);
    const lines = await readCanvasLog(file, 5);
    expect(JSON.parse(lines[4]).n).toBe(1499);
    expect(lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
  });

  it('reads no lines when there is no log yet', async () => {
    expect(await readCanvasLog(logFile(), 5)).toEqual([]);
  });

  it('masks anything shaped like a key, so another window\'s key never reaches a report', () => {
    const key = 'Ab3_' + 'x'.repeat(39);
    expect(maskKeys(`{"url":"http://127.0.0.1:5/${key}/security-report/"}`)).toBe('{"url":"http://127.0.0.1:5/[key]/security-report/"}');
    expect(maskKeys('{"event":"open","choice":"selected"}')).toBe('{"event":"open","choice":"selected"}');
  });
});
