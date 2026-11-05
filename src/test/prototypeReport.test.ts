import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildReport, redact, scanForSecret, type ReportFacts } from '../prototype/report';
import { generateKey } from '../prototype/keys';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-report-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function facts(overrides: Partial<ReportFacts> = {}): ReportFacts {
  return {
    generatedAt: '2026-11-05T12:00:00.000Z',
    vscodeVersion: '1.144.0',
    extensionVersion: '0.8.5',
    os: 'linux 6.1',
    providerApiAvailable: true,
    running: true,
    port: 43123,
    pid: 4242,
    workspaceFolders: ['/work/a'],
    stats: {
      allowed: { mcp: 3, canvas: 2 },
      refused: { 'mcp-key-invalid': 1 },
      recentHosts: ['127.0.0.1:43123'],
      recentOrigins: ['(none)', 'http://127.0.0.1:43123'],
      recentPaths: ['/mcp', '/[key]/api/plan'],
      userAgents: ['node'],
    },
    prototypeFolder: '/home/u/.copilot/extensions/ticket-sidekick',
    folderPermissions: 'drwx------',
    entries: [{ pid: 4242, port: 43123, workspaceFolders: ['/work/a'], startedAt: '2026-11-05T11:59:00Z', alive: true }],
    skippedEntries: [],
    launcherLog: ['{"outcome":"selected","pid":4242,"reason":"workspace-match"}'],
    chatSettings: { 'chat.canvases.enabled': true },
    keyScan: { matches: [], filesScanned: 12, capped: false, roots: ['/home/u/.copilot'], missingRoots: [] },
    ...overrides,
  };
}

describe('prototype report', () => {
  it('contains neither key nor token, even when a fact carries them', () => {
    const mcpKey = generateKey();
    const canvasKey = generateKey();
    const token = 'jira-pat-secret-value';
    const text = redact(buildReport(facts({
      recentNote: `seen ${mcpKey} and /${canvasKey}/api and Bearer ${token}`,
    })), [mcpKey, canvasKey, token]);
    expect(text).not.toContain(mcpKey);
    expect(text).not.toContain(canvasKey);
    expect(text).not.toContain(token);
    expect(text).toContain('[redacted]');
  });

  it('reports the evidence sections a tester pastes back', () => {
    const text = buildReport(facts());
    for (const heading of ['Environment', 'Server', 'Requests', 'Prototype folder', 'Windows', 'Launcher', 'Settings', 'Stored key search']) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('/[key]/api/plan');
    expect(text).toContain('not found');
  });

  it('says there was no launcher activity when the log is empty', () => {
    expect(buildReport(facts({ launcherLog: [] }))).toContain('no launcher activity');
  });
});

describe('scanForSecret', () => {
  it('finds a planted key and reports only the file path', async () => {
    const key = generateKey();
    const root = path.join(tmp, 'home');
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'config.json'), `{"headers":{"Authorization":"Bearer ${key}"}}`);
    fs.writeFileSync(path.join(root, 'clean.log'), 'nothing here');
    const result = await scanForSecret([root], key, { maxFiles: 100, maxFileBytes: 1_000_000, skip: [] });
    expect(result.matches).toEqual([path.join(root, 'nested', 'config.json')]);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.filesScanned).toBe(2);
  });

  it('skips folders it is told to skip', async () => {
    const key = generateKey();
    const root = path.join(tmp, 'home');
    const own = path.join(root, 'extensions', 'ticket-sidekick');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'window-1.json'), key);
    const result = await scanForSecret([root], key, { maxFiles: 100, maxFileBytes: 1_000_000, skip: [own] });
    expect(result.matches).toEqual([]);
  });

  it('stops at the file cap and says so', async () => {
    const root = path.join(tmp, 'many');
    fs.mkdirSync(root);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    const result = await scanForSecret([root], generateKey(), { maxFiles: 3, maxFileBytes: 1_000, skip: [] });
    expect(result.capped).toBe(true);
    expect(result.filesScanned).toBe(3);
    expect(buildReport(facts({ keyScan: result }))).toMatch(/stopped after 3 files/);
  });

  it('lists a root that does not exist instead of failing', async () => {
    const result = await scanForSecret([path.join(tmp, 'nope')], generateKey(), { maxFiles: 10, maxFileBytes: 10, skip: [] });
    expect(result.missingRoots).toEqual([path.join(tmp, 'nope')]);
  });
});
