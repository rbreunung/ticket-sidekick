import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectMcpLogLines, maskLogLine } from '../mcp/logTail';

// The diagnostics report quotes what VS Code itself logged about MCP, since that is where the
// reason for a server that will not start is written.

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-logs-'));
  await fs.promises.mkdir(path.join(dir, 'exthost'), { recursive: true });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('VS Code\'s log lines about MCP', () => {
  it('finds the lines about MCP in the window\'s log files, oldest first, and leaves the rest out', async () => {
    await fs.promises.writeFile(path.join(dir, 'renderer.log'), [
      '2026-11-12 19:57:01.000 [info] Started local extension host',
      '2026-11-12 19:57:03.000 [error] McpServer Ticket Sidekick: MCP servers are disabled by your organization',
      '2026-11-12 19:57:02.000 [info] MCP registry loaded',
    ].join('\n'));
    await fs.promises.writeFile(path.join(dir, 'exthost', 'exthost.log'), '2026-11-12 19:56:59.000 [info] ExtensionService#_doActivateExtension RobertBreunung.ticket-sidekick\n');
    const lines = await collectMcpLogLines(dir, 40);
    expect(lines).toEqual([
      `${path.join('exthost', 'exthost.log')}: 2026-11-12 19:56:59.000 [info] ExtensionService#_doActivateExtension RobertBreunung.ticket-sidekick`,
      'renderer.log: 2026-11-12 19:57:02.000 [info] MCP registry loaded',
      'renderer.log: 2026-11-12 19:57:03.000 [error] McpServer Ticket Sidekick: MCP servers are disabled by your organization',
    ]);
  });

  it('keeps an error when many ordinary lines follow it', async () => {
    const noise = Array.from({ length: 80 }, (_, i) => `2026-11-12 20:00:${String(i % 60).padStart(2, '0')}.000 [info] mcp poll ${i}`);
    await fs.promises.writeFile(path.join(dir, 'renderer.log'), ['2026-11-12 19:00:00.000 [error] MCP start refused by policy', ...noise].join('\n'));
    const lines = await collectMcpLogLines(dir, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('MCP start refused by policy');
  });

  it('masks other hosts and long values, and keeps this computer\'s address without its path', () => {
    const masked = maskLogLine('[error] mcp https://mcp.corp.example/api?token=abc failed, tried http://127.0.0.1:63521/mcp with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh');
    expect(masked).toBe('[error] mcp <address> failed, tried http://127.0.0.1:63521/… with <long value>');
  });

  it('leaves the user name out of home and temporary folder paths', () => {
    expect(maskLogLine('[info] [CopilotCLI] MCP server started. Lock file: /Users/ada/.copilot/ide/abc.lock')).toBe('[info] [CopilotCLI] MCP server started. Lock file: ~/.copilot/ide/abc.lock');
    expect(maskLogLine('mcp at /home/ada/x and C:\\Users\\Ada\\AppData\\y')).toBe('mcp at ~/x and ~\\AppData\\y');
    expect(maskLogLine('[info] Server URI: unix:/var/folders/g3/cm_ftx8x7dz1/T/mcp-XncrNC/mcp.sock#%2Fmcp')).toBe('[info] Server URI: unix:<temporary folder>#%2Fmcp');
  });

  it('answers with nothing when the folder does not exist', async () => {
    expect(await collectMcpLogLines(path.join(dir, 'missing'), 40)).toEqual([]);
  });
});
