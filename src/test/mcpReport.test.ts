import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildReport, redact, scanForSecret, type KeyScanResult, type ReportFacts } from '../mcp/report';
import { McpServerController, type ControllerSnapshot } from '../mcp/serverController';
import { defineTool, type McpToolDefinition } from '../mcp/mcpServer';
import { evaluateNoProxy } from '../mcp/proxyBypass';
import { generateKey } from '../mcp/keys';
import { JiraApiError } from '../utils/apiError';

const MB = 1024 * 1024;

let tmp: string;
let controller: McpServerController<object> | undefined;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mcp-report-')); });
afterEach(async () => {
  await controller?.stop('deactivate');
  controller = undefined;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function snapshot(overrides: Partial<ControllerSnapshot> = {}): ControllerSnapshot {
  return {
    running: true,
    port: 43123,
    history: [{ at: '2026-11-05T11:59:00.000Z', event: 'started', trigger: 'activation', port: 43123 }],
    announcements: 1,
    resolveServed: 1,
    resolveRefused: 0,
    stats: {
      allowed: { mcp: 3 },
      refused: {},
      recentHosts: ['127.0.0.1:43123'],
      recentOrigins: ['(none)'],
      recentPaths: ['/mcp'],
      clients: [{ userAgent: 'node', lastSeen: '2026-11-05T11:59:30.000Z' }],
    },
    toolCalls: {},
    ...overrides,
  };
}

function scan(overrides: Partial<KeyScanResult> = {}): KeyScanResult {
  return {
    matches: [], filesScanned: 12, bytesRead: 4096, stopped: undefined, roots: ['/home/u/.copilot'], missingRoots: [],
    limits: { maxFiles: 20000, maxFileBytes: 8 * MB, maxTotalBytes: 512 * MB },
    ...overrides,
  };
}

function facts(overrides: Partial<ReportFacts> = {}): ReportFacts {
  return {
    generatedAt: '2026-11-05T12:00:00.000Z',
    vscodeVersion: '1.144.0',
    extensionVersion: '0.8.5',
    os: 'linux 6.1',
    providerApiAvailable: true,
    loopbackBypass: true,
    server: snapshot(),
    proxy: { noProxy: evaluateNoProxy(['127.0.0.1']), proxySet: false, proxySupport: 'override' },
    jira: { configured: true, authType: 'datacenter', tokenPresent: true },
    chatSettings: { 'chat.mcp.discovery.enabled': true },
    keyScan: scan(),
    home: { dir: '/home/u', windows: false },
    ...overrides,
  };
}

/** A raw POST with a chosen bearer key. */
function postWithKey(port: number, key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
}

function bearerOf(c: McpServerController<object>): string {
  return c.definition()?.headers.Authorization.slice('Bearer '.length) ?? '';
}

describe('MCP diagnostics report', () => {
  it('contains neither the key nor the Jira token, even when a fact carries them', () => {
    const mcpKey = generateKey();
    const token = 'jira-pat-secret-value';
    const text = redact(buildReport(facts({
      chatSettings: { 'chat.mcp.serverSampling': `Bearer ${mcpKey}` },
      server: snapshot({ stats: { ...snapshot().stats, clients: [{ userAgent: `agent ${token}`, lastSeen: '2026-11-05T11:59:30.000Z' }] } }),
    })), [mcpKey, token]);
    expect(text).not.toContain(mcpKey);
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted]');
  });

  it('states that the server is not offered when the entry is missing', () => {
    expect(buildReport(facts({ loopbackBypass: false, server: snapshot({ running: false, port: undefined }) })))
      .toContain('MCP server offered: no (127.0.0.1 in http.noProxy: no)');
    expect(buildReport(facts())).toContain('MCP server offered: yes (127.0.0.1 in http.noProxy: yes)');
  });

  it('names the stored-key search result by file path', () => {
    const text = buildReport(facts({
      keyScan: scan({ matches: ['/srv/copilot/session.json'], filesScanned: 3, roots: ['/srv/copilot'] }),
    }));
    expect(text).toContain('Current MCP key FOUND in: /srv/copilot/session.json');
  });

  it('shows searched folders and found files under the home folder with ~, so the user name stays out', () => {
    const text = buildReport(facts({
      home: { dir: '/home/alice', windows: false },
      keyScan: scan({
        roots: ['/home/alice/.copilot', '/var/log/code'],
        missingRoots: ['/home/alice/.vscode-server/data/logs'],
        matches: ['/home/alice/.config/Code/User/workspaceStorage/abc/state.vscdb'],
      }),
    }));
    expect(text).toContain('Searched: ~/.copilot, /var/log/code');
    expect(text).toContain('Missing: ~/.vscode-server/data/logs');
    expect(text).toContain('Current MCP key FOUND in: ~/.config/Code/User/workspaceStorage/abc/state.vscdb');
    expect(text).not.toContain('/home/alice');
    expect(text).not.toContain('alice');
  });

  it('on Windows, replaces the home folder with ~ whatever its letter case', () => {
    const text = buildReport(facts({
      home: { dir: 'C:\\Users\\Alice', windows: true },
      keyScan: scan({
        roots: ['C:\\Users\\Alice\\.copilot'],
        matches: ['c:\\users\\alice\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb'],
      }),
    }));
    expect(text).toContain('Searched: ~\\.copilot');
    expect(text).toContain('Current MCP key FOUND in: ~\\AppData\\Roaming\\Code\\User\\globalStorage\\state.vscdb');
    expect(text.toLowerCase()).not.toContain('alice');
  });

  it('shows the 127.0.0.1 entry with a port as ignored and an internal host only as a count', () => {
    const text = buildReport(facts({
      loopbackBypass: false,
      proxy: { noProxy: evaluateNoProxy(['127.0.0.1:8080', 'build.corp.internal', '*.intra.example']), proxySet: true, proxySupport: 'override' },
    }));
    expect(text).toMatch(/127\.0\.0\.1:8080: ignored \(.*port/);
    expect(text).toContain('Other entries: 2 (not listed)');
    expect(text).not.toContain('corp.internal');
    expect(text).not.toContain('intra.example');
    expect(text).toContain('http.proxy set: yes');
    expect(text).toContain('System proxy discovery: yes (http.proxySupport: override)');
  });

  it('reports the Jira configuration without the base URL', () => {
    const text = buildReport(facts({ jira: { configured: false, authType: 'cloud', tokenPresent: false } }));
    expect(text).toContain('Configured: no');
    expect(text).toContain('Auth type: cloud');
    expect(text).toContain('Token present: no');
  });
});

describe('MCP diagnostics from a running server', () => {
  it('after a restart, counts a request with the earlier key as from an earlier start and lists both ports', async () => {
    let allowed = true;
    controller = new McpServerController<object>({ tools: [], toolDeps: {}, serverInfo: { name: 'test', version: '0.0.0' }, isMcpAllowed: () => allowed });
    await controller.start('activation');
    const firstPort = controller.port()!;
    const firstKey = bearerOf(controller);
    allowed = false;
    await controller.stop('entry removed');
    allowed = true;
    await controller.start('entry added');
    const secondPort = controller.port()!;

    expect(await postWithKey(secondPort, firstKey)).toBe(401);
    expect(await postWithKey(secondPort, generateKey())).toBe(401);

    const text = buildReport(facts({ server: controller.snapshot() }));
    expect(text).toContain('Refused key checks: key from an earlier start 1, unknown key 1');
    expect(text).toContain(`Current port: ${secondPort}`);
    expect(text).toContain(`Earlier ports: ${firstPort}`);
    expect(text).toMatch(/started on port \d+ \(activation\)/);
    expect(text).toMatch(/stopped \(entry removed\)/);
    expect(text).toMatch(/started on port \d+ \(entry added\)/);
    expect(text).not.toContain(firstKey);
  });

  it('lists a failed tool call by tool name and Jira HTTP status, with no argument text', async () => {
    const failing = defineTool<object, { text: z.ZodString }>({
      name: 'test_fail',
      title: 'Fail',
      description: 'Always fails with a Jira 404.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ text }) => { throw new JiraApiError(`not found: ${text}`, 404, 'https://jira.example.com/rest/api/2/issue/X'); },
    });
    const ok = defineTool<object, Record<string, never>>({
      name: 'test_ok', title: 'Ok', description: 'Answers ok.', inputSchema: {}, annotations: { readOnlyHint: true },
      handler: async () => 'fine',
    });
    controller = new McpServerController<object>({
      tools: [failing, ok] as McpToolDefinition<object>[], toolDeps: {}, serverInfo: { name: 'test', version: '0.0.0' }, isMcpAllowed: () => true,
    });
    await controller.start('activation');
    const definition = controller.definition()!;
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers } }));
    await client.callTool({ name: 'test_fail', arguments: { text: 'very-private-argument' } });
    await client.callTool({ name: 'test_ok', arguments: {} });
    await client.close();

    const text = buildReport(facts({ server: controller.snapshot() }));
    expect(text).toContain('test_fail: ok 0, failed 1 (HTTP 404 ×1)');
    expect(text).toContain('test_ok: ok 1, failed 0');
    expect(text).not.toContain('very-private-argument');
    expect(text).not.toContain('jira.example.com');
  });
});

describe('scanForSecret', () => {
  it('finds a planted key and reports only the file path', async () => {
    const key = generateKey();
    const root = path.join(tmp, 'home');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'config.json'), `{"headers":{"Authorization":"Bearer ${key}"}}`);
    fs.writeFileSync(path.join(root, 'clean.log'), 'nothing here');
    const result = await scanForSecret([root], key, { maxFiles: 100, maxFileBytes: 1_000_000, maxTotalBytes: 1_000_000 });
    expect(result.matches).toEqual([path.join(root, 'nested', 'config.json')]);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.filesScanned).toBe(2);
  });

  it('stops at the file cap and says so', async () => {
    const root = path.join(tmp, 'many');
    fs.mkdirSync(root);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    const result = await scanForSecret([root], generateKey(), { maxFiles: 3, maxFileBytes: 1_000, maxTotalBytes: 1_000_000 });
    expect(result.stopped).toBe('file-limit');
    expect(buildReport(facts({ keyScan: result }))).toMatch(/stopped after 3 files/);
  });

  it('lists a root that does not exist instead of failing', async () => {
    const result = await scanForSecret([path.join(tmp, 'nope')], generateKey(), { maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 10 });
    expect(result.missingRoots).toEqual([path.join(tmp, 'nope')]);
  });

  it('stops once the files read reach the total size budget and says the search is incomplete', async () => {
    const root = path.join(tmp, 'big');
    fs.mkdirSync(root);
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x'.repeat(10));
    const result = await scanForSecret([root], generateKey(), { maxFiles: 100, maxFileBytes: 1_000, maxTotalBytes: 25 });
    expect(result.stopped).toBe('byte-limit');
    expect(result.filesScanned).toBe(2);
    expect(buildReport(facts({ keyScan: result }))).toContain('search stopped after 25 bytes: 2 files checked; the rest was not searched');
  });

  it('names the default budget in MB when it is reached', () => {
    const text = buildReport(facts({ keyScan: scan({ stopped: 'byte-limit', filesScanned: 812 }) }));
    expect(text).toContain('search stopped after 512 MB: 812 files checked; the rest was not searched');
  });

  it('stops when cancelled and says so', async () => {
    const root = path.join(tmp, 'cancel');
    fs.mkdirSync(root);
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    let checked = 0;
    const result = await scanForSecret([root], generateKey(), { maxFiles: 100, maxFileBytes: 1_000, maxTotalBytes: 1_000 }, () => checked++ >= 1);
    expect(result.stopped).toBe('cancelled');
    expect(result.filesScanned).toBe(1);
    expect(buildReport(facts({ keyScan: result }))).toContain('search cancelled: 1 files checked; the rest was not searched');
  });
});
