# Local Server Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional local HTTP server to VS Code so the Tampermonkey userscript can POST email data directly (no file in Downloads), add a `@jira load email` chat command to pick pending handover files manually, and fix the userscript button stability.

**Architecture:** Three paths (A: HTTP POST, B: `@jira load email` folder scan, C: existing `GM_download` + `vscode://` URI) all converge on the same `readHandoverEmail()` processing. A new `LocalServerService` owns the server lifecycle and token; `parseHandoverManifest` is extracted as a pure function so both the file reader and the HTTP endpoint share the same conversion logic.

**Tech Stack:** Node.js `http` module (no external server dependency), VS Code ExtensionContext SecretStorage for token, Vitest for unit tests, TypeScript strict mode.

---

## Task 0: Revalidation checkpoint (run FIRST, before touching any code)

> This step exists because bug fixes may have landed on the branch since this plan was written. Read the current state of every file this plan will modify, compare it against what the plan expects, and surface any divergences before implementing.

**Files to read:**
- `src/utils/owaUserscript.ts`
- `src/utils/handoverFolder.ts`
- `src/participant/jira/emailHandler.ts`
- `src/participant/jira/llmHelpers.ts` (lines 1–100)
- `src/participant/sessionState.ts`
- `src/extension.ts`
- `src/services/ConfigService.ts`
- `package.json` (the `contributes` section)
- `src/test/owaUserscript.test.ts`

- [ ] **Step 1: Read all files listed above**

- [ ] **Step 2: Compare against plan expectations**

Check for any of these differences from what the plan assumes:
- `generateOwaUserscript` signature changed (plan assumes `{ owaUrl, vscodeUriBase }`)
- `HandoverManifest` interface moved or changed fields
- `readHandoverEmail` signature changed
- `Operation` type already contains `loadEmail`
- `HandoverEmail` type changed (especially `handoverFolder` / `timestamp` fields)
- `processHandoverEmail` command logic changed
- Any new settings already added under `ticketSidekick.localServer.*`

- [ ] **Step 3: Report findings and ask how to proceed**

List every divergence found. For each one, ask: adopt the current code as the new baseline (and adjust the plan), revert to what the plan expects, or handle it a different way. Do NOT continue to Task 1 until the user responds.

---

## Task 1: Export `HandoverManifest` and extract `parseHandoverManifest`

**Files:**
- Modify: `src/utils/handoverFolder.ts`
- Test: `src/test/handoverFolder.test.ts` (create if absent)

This refactor splits file I/O from JSON → `HandoverEmail` conversion. The `LocalServerService` (Task 3) will call `parseHandoverManifest` directly with the JSON body it received over HTTP.

- [ ] **Step 1: Write the failing test**

Create `src/test/handoverFolder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseHandoverManifest } from '../utils/handoverFolder';

describe('parseHandoverManifest', () => {
  const minimalManifest = {
    subject: 'Test Subject',
    senderName: 'Alice',
    receivedDateTime: '2026-05-23T10:00:00.000Z',
    bodyHtml: '<p>Hello <b>world</b></p>',
    stripFooter: false,
  };

  it('converts bodyHtml to markdownBody', () => {
    const email = parseHandoverManifest(minimalManifest, '/tmp', '1234567890');
    expect(email.markdownBody).toContain('Hello');
    expect(email.markdownBody).toContain('world');
  });

  it('passes through scalar fields', () => {
    const email = parseHandoverManifest(minimalManifest, '/tmp', '1234567890');
    expect(email.subject).toBe('Test Subject');
    expect(email.senderName).toBe('Alice');
    expect(email.stripFooter).toBe(false);
    expect(email.handoverFolder).toBe('/tmp');
    expect(email.timestamp).toBe('1234567890');
  });

  it('maps inlineImages to attachments with isInline: true', () => {
    const manifest = {
      ...minimalManifest,
      inlineImages: [{ filename: 'img.png', contentType: 'image/png', dataBase64: 'abc==' }],
    };
    const email = parseHandoverManifest(manifest, '/tmp', '111');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ name: 'img.png', isInline: true, dataBase64: 'abc==' });
  });

  it('maps attachments with isInline: false', () => {
    const manifest = {
      ...minimalManifest,
      attachments: [{ filename: 'doc.pdf', contentType: 'application/pdf', dataBase64: 'xyz==' }],
    };
    const email = parseHandoverManifest(manifest, '/tmp', '222');
    expect(email.attachments[0]).toMatchObject({ name: 'doc.pdf', isInline: false });
  });

  it('handles missing inlineImages and attachments arrays', () => {
    const email = parseHandoverManifest(minimalManifest, '/tmp', '333');
    expect(email.attachments).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A5 'handoverFolder'
```

Expected: `parseHandoverManifest is not a function` or similar import error.

- [ ] **Step 3: Export `HandoverManifest` and add `parseHandoverManifest` to `handoverFolder.ts`**

In `src/utils/handoverFolder.ts`, change `interface HandoverManifest` to `export interface HandoverManifest` and add the new function before `readHandoverEmail`:

```typescript
export interface HandoverManifest {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  bodyHtml: string;
  stripFooter: boolean;
  inlineImages?: Array<{ filename: string; contentType: string; dataBase64: string }>;
  attachments?: Array<{ filename: string; contentType: string; dataBase64: string }>;
}

export function parseHandoverManifest(
  manifest: HandoverManifest,
  handoverFolder: string,
  timestamp: string,
): HandoverEmail {
  const markdownBody = htmlToMarkdown(manifest.bodyHtml);
  return {
    subject: manifest.subject,
    senderName: manifest.senderName,
    receivedDateTime: manifest.receivedDateTime,
    markdownBody,
    stripFooter: manifest.stripFooter,
    handoverFolder,
    timestamp,
    attachments: [
      ...(manifest.inlineImages ?? []).map(img => ({
        name: img.filename,
        contentType: img.contentType,
        dataBase64: img.dataBase64,
        isInline: true as const,
      })),
      ...(manifest.attachments ?? []).map(att => ({
        name: att.filename,
        contentType: att.contentType,
        dataBase64: att.dataBase64,
        isInline: false as const,
      })),
    ],
  };
}
```

Then refactor `readHandoverEmail` to use it:

```typescript
export async function readHandoverEmail(handoverFolder: string, timestamp: string): Promise<HandoverEmail> {
  const filePath = path.join(handoverFolder, `TicketSidekick-${timestamp}.json`);
  let manifest: HandoverManifest;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    manifest = JSON.parse(raw) as HandoverManifest;
  } catch {
    throw new Error(`Could not read handover manifest at ${filePath}`);
  }
  return parseHandoverManifest(manifest, handoverFolder, timestamp);
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -E '(PASS|FAIL|✓|✗|handoverFolder)'
```

Expected: all `handoverFolder` tests pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/utils/handoverFolder.ts src/test/handoverFolder.test.ts
git commit -m "refactor: export HandoverManifest and extract parseHandoverManifest pure fn"
```

---

## Task 2: Add settings, activation event, and command to `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `onStartupFinished` to `activationEvents`**

In `package.json` line 19, change:

```json
"activationEvents": ["onUri"],
```

to:

```json
"activationEvents": ["onUri", "onStartupFinished"],
```

- [ ] **Step 2: Add the `testLocalServer` command to `contributes.commands`**

After the existing `exportOwaUserscript` command entry (around line 62), add:

```json
      {
        "command": "ticket-sidekick.testLocalServer",
        "title": "Ticket Sidekick: Test Local Server Connection"
      }
```

- [ ] **Step 3: Add the `localServer` configuration block**

After the closing `}` of the `"email"` configuration block (after line 212), and before the closing `]` of `"configuration"`, add:

```json
      {
        "id": "localServer",
        "title": "Ticket Sidekick — Local Server",
        "properties": {
          "ticketSidekick.localServer.enabled": {
            "type": "boolean",
            "default": false,
            "description": "Start a local HTTP server so the Tampermonkey userscript can POST email data directly to VS Code (Path A). When disabled, the userscript uses GM_download + vscode:// URI (Path C)."
          },
          "ticketSidekick.localServer.port": {
            "type": "number",
            "default": 17385,
            "description": "Port for the local handover server (127.0.0.1 only). Change if this port is already in use."
          }
        }
      }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
~/.volta/bin/npm run compile 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: add localServer settings, testLocalServer command, onStartupFinished activation"
```

---

## Task 3: Create `LocalServerService`

**Files:**
- Create: `src/services/LocalServerService.ts`
- Create: `src/test/LocalServerService.test.ts`

The service owns the HTTP server lifecycle, token generation/retrieval, and the two endpoints. It receives an `onEmail` callback from the caller (extension.ts) that contains all VS Code-specific logic — keeping this class free of `vscode` imports and therefore fully testable.

- [ ] **Step 1: Write failing tests**

Create `src/test/LocalServerService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { LocalServerService } from '../services/LocalServerService';

const TEST_PORT = 17399;
const TEST_TOKEN = 'test-token-uuid-1234';

function makeSecrets(token: string | undefined) {
  return {
    get: vi.fn().mockResolvedValue(token),
    store: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(token: string | undefined = TEST_TOKEN) {
  return { secrets: makeSecrets(token) } as any;
}

async function req(
  method: string,
  path: string,
  token: string | undefined,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    const r = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

describe('LocalServerService', () => {
  let svc: LocalServerService;
  let onEmail: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    onEmail = vi.fn().mockResolvedValue(undefined);
    svc = new LocalServerService(makeContext(), onEmail);
    await svc.start(TEST_PORT);
  });

  afterEach(() => {
    svc.stop();
  });

  describe('GET /ping', () => {
    it('returns 200 with status ok for valid token', async () => {
      const res = await req('GET', '/ping', TEST_TOKEN);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.port).toBe(TEST_PORT);
    });

    it('returns 403 for missing token', async () => {
      const res = await req('GET', '/ping', undefined);
      expect(res.status).toBe(403);
    });

    it('returns 403 for wrong token', async () => {
      const res = await req('GET', '/ping', 'wrong-token');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /email', () => {
    const validManifest = JSON.stringify({
      subject: 'Hello',
      senderName: 'Alice',
      receivedDateTime: '2026-05-23T10:00:00.000Z',
      bodyHtml: '<p>body</p>',
      stripFooter: false,
    });

    it('returns 200 and calls onEmail for valid payload', async () => {
      const res = await req('POST', '/email', TEST_TOKEN, validManifest);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).status).toBe('received');
      expect(onEmail).toHaveBeenCalledOnce();
    });

    it('returns 403 for missing token', async () => {
      const res = await req('POST', '/email', undefined, validManifest);
      expect(res.status).toBe(403);
      expect(onEmail).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await req('POST', '/email', TEST_TOKEN, '{not-json}');
      expect(res.status).toBe(400);
    });

    it('returns 400 when subject is missing', async () => {
      const bad = JSON.stringify({ senderName: 'Alice', bodyHtml: '<p>x</p>', stripFooter: false });
      const res = await req('POST', '/email', TEST_TOKEN, bad);
      expect(res.status).toBe(400);
    });

    it('returns 400 when bodyHtml is missing', async () => {
      const bad = JSON.stringify({ subject: 'Hi', senderName: 'Alice', stripFooter: false });
      const res = await req('POST', '/email', TEST_TOKEN, bad);
      expect(res.status).toBe(400);
    });
  });

  describe('unknown route', () => {
    it('returns 404', async () => {
      const res = await req('GET', '/unknown', TEST_TOKEN);
      expect(res.status).toBe(404);
    });
  });

  describe('getOrCreateToken', () => {
    it('returns existing token from SecretStorage', async () => {
      const ctx = makeContext('existing-token');
      const s = new LocalServerService(ctx, vi.fn());
      const token = await s.getOrCreateToken();
      expect(token).toBe('existing-token');
      expect(ctx.secrets.store).not.toHaveBeenCalled();
    });

    it('generates and stores a token when none exists', async () => {
      const ctx = makeContext(undefined);
      const s = new LocalServerService(ctx, vi.fn());
      const token = await s.getOrCreateToken();
      expect(token).toBeTruthy();
      expect(ctx.secrets.store).toHaveBeenCalledWith(
        'ticket-sidekick.local-server.token',
        expect.any(String),
      );
    });
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A5 'LocalServerService'
```

Expected: `Cannot find module '../services/LocalServerService'`.

- [ ] **Step 3: Create `src/services/LocalServerService.ts`**

```typescript
import * as http from 'http';
import * as crypto from 'crypto';
import type { HandoverManifest } from '../utils/handoverFolder';

interface SecretStorage {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
}

interface ExtensionContext {
  secrets: SecretStorage;
}

export class LocalServerService {
  private server: http.Server | null = null;
  private static readonly TOKEN_KEY = 'ticket-sidekick.local-server.token';

  constructor(
    private readonly context: ExtensionContext,
    private readonly onEmail: (manifest: HandoverManifest) => Promise<void>,
  ) {}

  async getOrCreateToken(): Promise<string> {
    let token = await this.context.secrets.get(LocalServerService.TOKEN_KEY);
    if (!token) {
      token = crypto.randomUUID();
      await this.context.secrets.store(LocalServerService.TOKEN_KEY, token);
    }
    return token;
  }

  async start(port: number): Promise<void> {
    if (this.server) return;
    const token = await this.getOrCreateToken();

    this.server = http.createServer((req, res) => {
      const auth = req.headers['authorization'];
      const authorized = auth === `Bearer ${token}`;

      if (req.method === 'GET' && req.url === '/ping') {
        if (!authorized) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', port }));
        return;
      }

      if (req.method === 'POST' && req.url === '/email') {
        if (!authorized) { res.writeHead(403); res.end('{"error":"forbidden"}'); return; }
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
          let manifest: HandoverManifest;
          try {
            manifest = JSON.parse(body) as HandoverManifest;
          } catch {
            res.writeHead(400); res.end('{"error":"invalid JSON"}'); return;
          }
          if (!manifest.subject || !manifest.bodyHtml) {
            res.writeHead(400); res.end('{"error":"missing required fields: subject, bodyHtml"}'); return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"status":"received"}');
          this.onEmail(manifest).catch(() => {});
        });
        return;
      }

      res.writeHead(404); res.end('{"error":"not found"}');
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, '127.0.0.1', resolve);
      this.server!.once('error', reject);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -E '(PASS|FAIL|✓|✗|LocalServer)'
```

Expected: all `LocalServerService` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/LocalServerService.ts src/test/LocalServerService.test.ts
git commit -m "feat: add LocalServerService with /ping and /email endpoints and Bearer token auth"
```

---

## Task 4: Wire `LocalServerService` into `extension.ts`

**Files:**
- Modify: `src/extension.ts`

This task: (a) extracts the footer-cleanup + workspaceState + chat-open logic into a shared `finishHandoverEmail` helper reused by both the URI handler path and the HTTP server; (b) starts/stops the server; (c) adds the status bar item; (d) adds the "Test Local Server" command; (e) updates the export command to embed server config.

- [ ] **Step 1: Add imports at the top of `extension.ts`**

After the existing imports, add:

```typescript
import { LocalServerService } from './services/LocalServerService';
import { parseHandoverManifest } from './utils/handoverFolder';
import type { HandoverManifest } from './utils/handoverFolder';
```

- [ ] **Step 2: Extract `finishHandoverEmail` helper**

Add this function just before the `activate` export. It replaces the duplicated footer-cleanup + workspaceState + chat-open block:

```typescript
async function finishHandoverEmail(
  email: HandoverEmail,
  context: vscode.ExtensionContext,
  config: vscode.WorkspaceConfiguration,
): Promise<void> {
  let processed = email;
  if (email.stripFooter) {
    const modelFamily = config.get<string>('email.cleanupModel', 'gpt-4o-mini');
    try {
      const models = await vscode.lm.selectChatModels({ family: modelFamily });
      if (models.length > 0) {
        const msgs = [
          vscode.LanguageModelChatMessage.User(
            `You are cleaning up an email before it becomes a Jira ticket description. ` +
            `Remove ONLY the following types of boilerplate — do not rewrite, rephrase, or change any of the remaining text:\n` +
            `- Corporate email footers and signatures\n` +
            `- Legal disclaimers and confidentiality notices\n` +
            `- Classification lines (e.g. "Classification: For internal use only", "For internal use only")\n` +
            `- Email retention policy notices\n` +
            `- Virus scan / security scan notices\n` +
            `Return the cleaned email body as-is in markdown, preserving the original wording exactly.\n\n` +
            `${email.markdownBody}`,
          ),
        ];
        const cts = new vscode.CancellationTokenSource();
        try {
          const res = await models[0].sendRequest(msgs, {}, cts.token);
          let cleaned = '';
          for await (const chunk of res.text) cleaned += chunk;
          processed = { ...email, markdownBody: cleaned.trim() };
        } finally {
          cts.dispose();
        }
      }
    } catch {
      // Footer cleanup failed — continue with original body
    }
  }
  await context.workspaceState.update('jira.handover.email', processed);
  await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' });
}
```

- [ ] **Step 3: Refactor `processHandoverEmail` command to use `finishHandoverEmail`**

Inside the `processHandoverEmail` command handler in `activate()`, replace the footer-cleanup + workspaceState + chat block (lines 133–167 in the original) with:

```typescript
      await finishHandoverEmail(email, context, config);
```

The full refactored command becomes:

```typescript
    vscode.commands.registerCommand('ticket-sidekick.processHandoverEmail', async (subfolder: string) => {
      if (!subfolder || !/^\d+$/.test(subfolder)) {
        if (subfolder) vscode.window.showErrorMessage('Ticket Sidekick: Invalid handover folder name.');
        return;
      }
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const rawFolder = config.get<string>('email.handoverFolder', '').trim();
      const handoverFolder = rawFolder
        ? rawFolder.replace(/^~/, os.homedir())
        : path.join(os.homedir(), 'Downloads');

      await purgeStaleFiles(handoverFolder, 24 * 60 * 60 * 1000);

      const manifestPath = path.join(handoverFolder, `TicketSidekick-${subfolder}.json`);
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(manifestPath)) {
        if (Date.now() >= deadline) {
          vscode.window.showErrorMessage(
            `Ticket Sidekick: Timed out waiting for handover email. Expected: ${manifestPath}`,
          );
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      let email: HandoverEmail;
      try {
        email = await readHandoverEmail(handoverFolder, subfolder);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Ticket Sidekick: Could not read handover email — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      await finishHandoverEmail(email, context, config);
    }),
```

- [ ] **Step 4: Add `LocalServerService` startup, status bar, and "Test" command**

At the top of `activate()`, before the `context.subscriptions.push(...)` block, add:

```typescript
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ticket-sidekick.testLocalServer';
  context.subscriptions.push(statusBar);

  const serverConfig = vscode.workspace.getConfiguration('ticketSidekick');
  const serverEnabled = serverConfig.get<boolean>('localServer.enabled', false);
  const serverPort = serverConfig.get<number>('localServer.port', 17385);

  const localServer = new LocalServerService(context, async (manifest: HandoverManifest) => {
    const email = parseHandoverManifest(manifest, '', '');
    const cfg = vscode.workspace.getConfiguration('ticketSidekick');
    await finishHandoverEmail(email, context, cfg);
  });

  if (serverEnabled) {
    try {
      await localServer.start(serverPort);
      statusBar.text = `TS ⚡ :${serverPort}`;
      statusBar.tooltip = 'Ticket Sidekick local server running — click to test';
      statusBar.show();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `Ticket Sidekick: could not start local server on port ${serverPort} — ${msg}. Change ticketSidekick.localServer.port in settings.`,
      );
    }
  }
```

Then inside `context.subscriptions.push(...)`, add the test command:

```typescript
    vscode.commands.registerCommand('ticket-sidekick.testLocalServer', async () => {
      const cfg = vscode.workspace.getConfiguration('ticketSidekick');
      if (!cfg.get<boolean>('localServer.enabled', false)) {
        vscode.window.showInformationMessage('Ticket Sidekick: local server is disabled. Enable ticketSidekick.localServer.enabled to use Path A.');
        return;
      }
      const port = cfg.get<number>('localServer.port', 17385);
      const token = await localServer.getOrCreateToken();
      try {
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = require('http').request(
            { hostname: '127.0.0.1', port, path: '/ping', method: 'GET', headers: { Authorization: `Bearer ${token}` } },
            (res: any) => {
              let data = '';
              res.on('data', (c: any) => { data += c; });
              res.on('end', () => resolve({ status: res.statusCode, body: data }));
            },
          );
          req.on('error', reject);
          req.end();
        });
        if (result.status === 200) {
          vscode.window.showInformationMessage(`Ticket Sidekick: server on port ${port} is reachable ✓`);
        } else {
          vscode.window.showErrorMessage(`Ticket Sidekick: server responded with HTTP ${result.status}`);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: could not reach server on port ${port} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
```

And wire deactivate to stop the server:

```typescript
export function deactivate(): void {
  // localServer is module-scoped — VS Code disposes subscriptions first
}
```

Note: because `localServer` is defined inside `activate`, it will be garbage collected when the extension host shuts down. The `stop()` call is not strictly needed, but for a clean shutdown add it via a `Disposable`:

Add this after `localServer.start(...)`:

```typescript
      context.subscriptions.push({ dispose: () => localServer.stop() });
```

- [ ] **Step 5: Update `exportOwaUserscript` command to pass server config**

Replace the existing `exportOwaUserscript` command body:

```typescript
    vscode.commands.registerCommand('ticket-sidekick.exportOwaUserscript', async () => {
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const owaUrl = config.get<string>('outlook.owaUrl', 'https://outlook.office.com').trim() || 'https://outlook.office.com';
      const serverMode = config.get<boolean>('localServer.enabled', false);
      const port = config.get<number>('localServer.port', 17385);
      const token = serverMode ? await localServer.getOrCreateToken() : '';
      const script = generateOwaUserscript({
        owaUrl,
        vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
        serverMode,
        port,
        token,
      });
      const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: script });
      await vscode.window.showTextDocument(doc);
    }),
```

- [ ] **Step 6: Compile and run tests**

```bash
~/.volta/bin/npm run compile 2>&1 | tail -20
~/.volta/bin/npm test 2>&1 | tail -20
```

Expected: no compile errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire LocalServerService into extension — status bar, test command, server lifecycle"
```

---

## Task 5: Update `generateOwaUserscript` for server mode + button fix

**Files:**
- Modify: `src/utils/owaUserscript.ts`
- Modify: `src/test/owaUserscript.test.ts`

When `serverMode: true` the generated script uses `GM_xmlhttpRequest` POST instead of `GM_download` + `vscode://` navigation. The button moves to a Shadow DOM host with `position: fixed` (both modes), eliminating the resize-stability problem. A `GM_registerMenuCommand` entry for connectivity testing is added in both modes.

- [ ] **Step 1: Add new tests for server mode and button fix**

Append to `src/test/owaUserscript.test.ts`:

```typescript
describe('generateOwaUserscript — server mode', () => {
  const SERVER_SCRIPT = generateOwaUserscript({
    owaUrl: 'https://mail.contoso.com',
    vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
    serverMode: true,
    port: 17385,
    token: 'test-uuid-token',
  });

  it('grants GM_xmlhttpRequest', () => {
    expect(SERVER_SCRIPT).toContain('@grant        GM_xmlhttpRequest');
  });

  it('grants GM_notification', () => {
    expect(SERVER_SCRIPT).toContain('@grant        GM_notification');
  });

  it('grants GM_registerMenuCommand', () => {
    expect(SERVER_SCRIPT).toContain('@grant        GM_registerMenuCommand');
  });

  it('does NOT grant GM_download in server mode', () => {
    expect(SERVER_SCRIPT).not.toContain('@grant        GM_download');
  });

  it('POSTs to the configured port', () => {
    expect(SERVER_SCRIPT).toContain('http://127.0.0.1:17385/email');
  });

  it('includes the Bearer token in the POST', () => {
    expect(SERVER_SCRIPT).toContain('Bearer test-uuid-token');
  });

  it('does NOT contain GM_download call in server mode', () => {
    expect(SERVER_SCRIPT).not.toContain('GM_download(');
  });

  it('does NOT contain vscode:// URI navigation in server mode', () => {
    expect(SERVER_SCRIPT).not.toContain('window.location.href');
  });

  it('registers a Test Connection menu command', () => {
    expect(SERVER_SCRIPT).toContain('GM_registerMenuCommand');
    expect(SERVER_SCRIPT).toContain('Test connection to VS Code');
  });
});

describe('generateOwaUserscript — button stability', () => {
  const SCRIPT = generateOwaUserscript({
    owaUrl: 'https://mail.contoso.com',
    vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
    serverMode: false,
    port: 17385,
    token: '',
  });

  it('uses Shadow DOM for the button host', () => {
    expect(SCRIPT).toContain('attachShadow');
  });

  it('positions the button host with position fixed', () => {
    expect(SCRIPT).toContain('position: fixed');
  });
});
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -E '(server mode|button stability)'
```

Expected: all new tests fail (missing params / no Shadow DOM).

- [ ] **Step 3: Rewrite `src/utils/owaUserscript.ts`**

```typescript
export function generateOwaUserscript(config: {
  owaUrl: string;
  vscodeUriBase: string;
  serverMode: boolean;
  port: number;
  token: string;
}): string {
  const { owaUrl, vscodeUriBase, serverMode, port, token } = config;
  const rawOwaUrl = owaUrl.replace(/[\r\n]/g, '');
  let safeOwaUrl: string;
  try {
    safeOwaUrl = new URL(rawOwaUrl).origin;
  } catch {
    safeOwaUrl = rawOwaUrl.replace(/\/+$/, '');
  }
  const safeVscodeUri = vscodeUriBase.replace(/[\r\n]/g, '').replace(/'/g, '%27').replace(/\\/g, '/');
  const safeToken = token.replace(/[\r\n'`\\]/g, '');

  const grants = serverMode
    ? ['GM_xmlhttpRequest', 'GM_notification', 'GM_registerMenuCommand']
    : ['GM_download', 'GM_xmlhttpRequest', 'GM_registerMenuCommand'];

  const grantLines = grants.map(g => `// @grant        ${g}`).join('\n');

  const deliveryCode = serverMode
    ? `
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'http://127.0.0.1:${port}/email',
      headers: {
        'Authorization': 'Bearer ${safeToken}',
        'Content-Type': 'application/json',
      },
      data: manifest,
      onload(res) {
        if (res.status === 200) {
          GM_notification({ text: 'Email sent to VS Code ✓', title: 'Ticket Sidekick', timeout: 3000 });
        } else {
          GM_notification({ text: 'VS Code server error: HTTP ' + res.status + ' — check Output channel', title: 'Ticket Sidekick', timeout: 6000 });
        }
      },
      onerror() {
        GM_notification({ text: 'VS Code server unreachable on port ${port}. Is VS Code running with localServer.enabled?', title: 'Ticket Sidekick', timeout: 6000 });
      },
    });
`
    : `
    const blob = new Blob([manifest], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      GM_download({
        url,
        name: 'TicketSidekick-' + timestamp + '.json',
        onload() { URL.revokeObjectURL(url); resolve(); },
        onerror(err) {
          URL.revokeObjectURL(url);
          reject(new Error(err.error || err.statusText || 'GM_download failed'));
        },
      });
    });
    setTimeout(() => {
      window.location.href = '${safeVscodeUri}/from-email' + '?folder=' + timestamp;
    }, 1500);
`;

  const testMenuCommand = serverMode
    ? `
  GM_registerMenuCommand('Test connection to VS Code', function () {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:${port}/ping',
      headers: { 'Authorization': 'Bearer ${safeToken}' },
      onload(res) {
        if (res.status === 200) {
          GM_notification({ text: 'VS Code server reachable on port ${port} ✓', title: 'Ticket Sidekick', timeout: 4000 });
        } else {
          GM_notification({ text: 'Server responded HTTP ' + res.status, title: 'Ticket Sidekick', timeout: 6000 });
        }
      },
      onerror() {
        GM_notification({ text: 'Server unreachable on port ${port}. Enable ticketSidekick.localServer.enabled in VS Code settings.', title: 'Ticket Sidekick', timeout: 6000 });
      },
    });
  });
`
    : `
  GM_registerMenuCommand('Test connection to VS Code', function () {
    GM_notification({ text: 'Server mode is disabled. Using GM_download (Path C). Re-export the userscript after enabling ticketSidekick.localServer.enabled.', title: 'Ticket Sidekick', timeout: 6000 });
  });
`;

  return `// ==UserScript==
// @name         Ticket Sidekick — OWA to Jira
// @namespace    https://ticket-sidekick
// @version      1.2
// @description  Capture OWA email and send to Ticket Sidekick in VS Code
// @author       Ticket Sidekick
// @match        ${safeOwaUrl}/*
${grantLines}
// ==/UserScript==

(function () {
  'use strict';
${testMenuCommand}
  function getReadingPane() {
    return document.querySelector('.wide-content-host')
      || document.querySelector('[data-testid="reading-pane"]')
      || document.querySelector('[aria-label="Reading Pane"]')
      || document.querySelector('.ReadingPane');
  }

  function getSubject() {
    return (
      document.querySelector('[id$="_SUBJECT"] span[title]')?.getAttribute('title')?.trim()
      || document.querySelector('[data-testid="subject"]')?.textContent?.trim()
      || document.querySelector('[data-testid="ConversationTopic"]')?.textContent?.trim()
      || document.querySelector('[aria-label^="Email subject"]')?.textContent?.trim()
      || document.querySelector('h1')?.textContent?.trim()
      || '(no subject)'
    );
  }

  function getSenderName() {
    const fromEl = document.querySelector('[aria-label^="Von: "], [aria-label^="From: "]');
    if (fromEl) {
      const label = fromEl.getAttribute('aria-label') || '';
      return label.replace(/^(Von|From):\\\\s*/i, '').replace(/<[^>]+>/, '').trim() || 'Unknown';
    }
    return document.querySelector('[data-testid="sender-name"]')?.textContent?.trim() || 'Unknown';
  }

  function getReceivedDateTime() {
    const dateEl = document.querySelector('[data-testid="SentReceivedSavedTime"]');
    if (dateEl) {
      const text = dateEl.textContent || '';
      const isoMatch = text.match(/(\\\\d{4}-\\\\d{2}-\\\\d{2})\\\\s+(\\\\d{2}:\\\\d{2})/);
      if (isoMatch) {
        try { return new Date(isoMatch[1] + 'T' + isoMatch[2] + ':00').toISOString(); } catch (_) {}
      }
      const euMatch = text.match(/(\\\\d{2})\\\\.(\\\\d{2})\\\\.(\\\\d{4})\\\\s+(\\\\d{2}:\\\\d{2})/);
      if (euMatch) {
        try { return new Date(euMatch[3] + '-' + euMatch[2] + '-' + euMatch[1] + 'T' + euMatch[4] + ':00').toISOString(); } catch (_) {}
      }
    }
    return document.querySelector('time')?.getAttribute('datetime') || new Date().toISOString();
  }

  function getBodyElement() {
    const newOutlook = document.querySelector('[data-test-id="mailMessageBodyContainer"] [role="document"]')
      || document.querySelector('[data-test-id="mailMessageBodyContainer"] .allowTextSelection');
    if (newOutlook) return newOutlook;
    const pane = getReadingPane();
    if (!pane) return null;
    for (const iframe of pane.querySelectorAll('iframe')) {
      try {
        if (iframe.contentDocument?.body) return iframe.contentDocument.body;
      } catch (_) {}
    }
    return (
      pane.querySelector('[data-testid="message-body"]')
      || pane.querySelector('[aria-label="Message body"]')
      || pane.querySelector('.allowTextSelection')
    );
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function fetchAsBase64(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        onload(res) { resolve(arrayBufferToBase64(res.response)); },
        onerror(err) { reject(new Error('fetch failed: ' + (err.statusText || err.error || JSON.stringify(err)))); },
      });
    });
  }

  async function captureEmail(stripFooter) {
    const timestamp = Date.now().toString();
    const subject = getSubject();
    const senderName = getSenderName();
    const receivedDateTime = getReceivedDateTime();

    const bodyEl = getBodyElement();
    if (!bodyEl) {
      alert('Ticket Sidekick: Could not find the email body. Make sure an email is open.');
      return;
    }

    const bodyClone = bodyEl.cloneNode(true);
    const inlineImages = [];
    let imgIdx = 0;
    const fetches = [];

    for (const img of bodyClone.querySelectorAll('img')) {
      const src = img.getAttribute('src') || img.src;
      if (!src || src.startsWith('data:')) { img.remove(); continue; }
      imgIdx++;
      const extMatch = src.match(/\\\\.([a-z]{2,4})(\\\\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const filename = 'email-image-' + imgIdx + '.' + ext;
      const mimeExt = ext === 'jpg' ? 'jpeg' : ext;
      img.setAttribute('data-ts-filename', filename);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      const entry = { filename, contentType: 'image/' + mimeExt, dataBase64: '' };
      inlineImages.push(entry);
      fetches.push(fetchAsBase64(src).then(b64 => { entry.dataBase64 = b64; }).catch(() => {}));
    }

    const attachmentListbox = document.querySelector('[id$="_ATTACHMENTS"] [role="listbox"]');
    if (attachmentListbox) {
      const names = [];
      for (const option of attachmentListbox.querySelectorAll('[role="option"]')) {
        const nameEl = option.querySelector('[title]');
        const name = nameEl?.getAttribute('title')?.trim();
        if (name) names.push(name);
      }
      if (names.length > 0) {
        bodyClone.innerHTML += '<p>&#128206; <strong>Attachments (attach to ticket manually):</strong> '
          + names.map(n => '<em>' + n + '</em>').join(', ') + '</p>';
      }
    }

    await Promise.all(fetches);

    const manifest = JSON.stringify({
      subject, senderName, receivedDateTime,
      stripFooter: !!stripFooter,
      bodyHtml: bodyClone.innerHTML,
      inlineImages: inlineImages.filter(e => e.dataBase64),
    }, null, 2);

    ${deliveryCode}
  }

  function makeBtn(label, stripFooter) {
    const btn = document.createElement('button');
    btn.dataset.tsBtn = '1';
    btn.textContent = label;
    btn.title = stripFooter ? 'Create Jira ticket (AI footer removal)' : 'Create Jira ticket';
    btn.style.cssText = 'display:block;margin:4px 0;padding:4px 10px;cursor:pointer;font-size:12px;'
      + 'border:1px solid #888;border-radius:3px;background:#f5f5f5;white-space:nowrap;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      captureEmail(stripFooter).catch((err) => alert('Ticket Sidekick: Capture failed — ' + String(err)));
    });
    return btn;
  }

  // Single persistent floating host — survives OWA re-renders without re-injection
  function ensureFloatingHost() {
    if (document.getElementById('ts-floating-host')) return;
    const host = document.createElement('div');
    host.id = 'ts-floating-host';
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:2px;';
    wrapper.appendChild(makeBtn('📋 To Ticket', false));
    wrapper.appendChild(makeBtn('📋✨ To Ticket (Clean)', true));
    shadow.appendChild(wrapper);
    document.body.appendChild(host);
  }

  // Inject once; MutationObserver handles SPA navigation that removes document.body children
  const observer = new MutationObserver(() => {
    if (getReadingPane()) ensureFloatingHost();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (getReadingPane()) ensureFloatingHost();
})();
`;
}
```

> **Note on regex escaping:** The generated script is a TypeScript template literal that contains JavaScript regex literals. Each `\\` in the TypeScript source produces a single `\` in the output string. Verify the generated script's regex sections look correct by running the tests — they check for the EU date pattern string specifically.

- [ ] **Step 4: Update existing tests that reference the old signature**

In `src/test/owaUserscript.test.ts`, update the top-level `SCRIPT` constant (the existing file mode tests):

```typescript
const SCRIPT = generateOwaUserscript({
  owaUrl: 'https://mail.contoso.com',
  vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
  serverMode: false,
  port: 17385,
  token: '',
});
```

Update the test "grants GM_download" to be scoped to file mode — this test is already in the `describe('generateOwaUserscript')` block (not server mode), so it stays correct.

Update "embeds the vscode URI base for navigation" — this is still true for file mode only. Add a check that server mode does NOT embed it:

The existing test `'embeds the vscode URI base for navigation'` checks `SCRIPT` (file mode) — that is still correct. No change needed since `SCRIPT` is now file mode.

Also update the two tests that pass `owaUrl` directly (the strip-path tests) to include the new required params:

```typescript
  it('strips path from owaUrl so @match uses origin only', () => {
    const script = generateOwaUserscript({
      owaUrl: 'https://outlook.cloud.microsoft/mail/',
      vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
      serverMode: false, port: 17385, token: '',
    });
    expect(script).toContain('@match        https://outlook.cloud.microsoft/*');
    expect(script).not.toContain('/mail/');
  });

  it('strips trailing slash from owaUrl', () => {
    const script = generateOwaUserscript({
      owaUrl: 'https://outlook.office.com/',
      vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
      serverMode: false, port: 17385, token: '',
    });
    expect(script).toContain('@match        https://outlook.office.com/*');
  });

  it('escapes single quotes in vscodeUriBase to prevent script injection', () => {
    const injected = generateOwaUserscript({
      owaUrl: 'https://mail.example.com',
      vscodeUriBase: "vscode://foo'; alert(1); var x='",
      serverMode: false, port: 17385, token: '',
    });
    expect(injected).not.toContain("'; alert(1);");
  });
```

- [ ] **Step 5: Run all tests**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | tail -40
```

Expected: all tests pass including the new server mode and button tests.

- [ ] **Step 6: Compile**

```bash
~/.volta/bin/npm run compile 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/owaUserscript.ts src/test/owaUserscript.test.ts
git commit -m "feat: add server mode to generateOwaUserscript; fix button with Shadow DOM position:fixed; add GM_registerMenuCommand test entry"
```

---

## Task 6: Add `@jira load email` (Path B)

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/utils/handoverFolder.ts`
- Modify: `src/participant/jira/emailHandler.ts`
- Modify: `src/participant/jira/llmHelpers.ts`
- Modify: `src/participant/JiraParticipant.ts`
- Modify: `CLAUDE.md` (session table)

### 6a — Session type and pure scan helper

- [ ] **Step 1: Add `HandoverFileSelectionSession` to `sessionState.ts`**

After the `EmailContentSession` interface (around line 127), add:

```typescript
export interface HandoverFileEntry {
  filename: string;
  timestamp: string;
  subject: string;
  receivedDateTime: string;
  stale: boolean;
}

export interface HandoverFileSelectionSession {
  files: HandoverFileEntry[];
  handoverFolder: string;
}
```

- [ ] **Step 2: Add `listHandoverFiles` to `handoverFolder.ts`**

Add this after `purgeStaleFiles`:

```typescript
export async function listHandoverFiles(
  handoverFolder: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): Promise<Array<{ filename: string; timestamp: string; mtimeMs: number }>> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(handoverFolder, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{ filename: string; timestamp: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^TicketSidekick-(\d+)\.json$/);
    if (!m) continue;
    try {
      const stat = await fs.promises.stat(path.join(handoverFolder, entry.name));
      results.push({ filename: entry.name, timestamp: m[1], mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const now = Date.now();
  return results.map(r => ({ ...r, stale: now - r.mtimeMs > maxAgeMs })) as any;
}
```

Wait — `stale` isn't in the return type. Correct:

```typescript
export async function listHandoverFiles(
  handoverFolder: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): Promise<Array<{ filename: string; timestamp: string; mtimeMs: number; stale: boolean }>> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(handoverFolder, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const results: Array<{ filename: string; timestamp: string; mtimeMs: number; stale: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^TicketSidekick-(\d+)\.json$/);
    if (!m) continue;
    try {
      const stat = await fs.promises.stat(path.join(handoverFolder, entry.name));
      results.push({ filename: entry.name, timestamp: m[1], mtimeMs: stat.mtimeMs, stale: now - stat.mtimeMs > maxAgeMs });
    } catch {
      // File disappeared — skip
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}
```

- [ ] **Step 3: Write tests for `listHandoverFiles`**

Add to `src/test/handoverFolder.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listHandoverFiles } from '../utils/handoverFolder';

describe('listHandoverFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for empty folder', async () => {
    const files = await listHandoverFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('returns empty array for non-existent folder', async () => {
    const files = await listHandoverFiles('/nonexistent/path/xyz');
    expect(files).toHaveLength(0);
  });

  it('ignores files that do not match the pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'other.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-abc.json'), '{}');
    const files = await listHandoverFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  it('returns matching files sorted newest first', async () => {
    const older = path.join(tmpDir, 'TicketSidekick-1000.json');
    const newer = path.join(tmpDir, 'TicketSidekick-2000.json');
    fs.writeFileSync(older, '{"subject":"Old"}');
    // small delay so mtime differs
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(newer, '{"subject":"New"}');
    const files = await listHandoverFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files[0].timestamp).toBe('2000');
    expect(files[1].timestamp).toBe('1000');
  });

  it('marks files older than maxAgeMs as stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-9999.json'), '{}');
    const files = await listHandoverFiles(tmpDir, 0); // 0 ms → everything is stale
    expect(files[0].stale).toBe(true);
  });

  it('marks fresh files as not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-8888.json'), '{}');
    const files = await listHandoverFiles(tmpDir, 24 * 60 * 60 * 1000);
    expect(files[0].stale).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -E '(listHandoverFiles|PASS|FAIL)'
```

Expected: all `listHandoverFiles` tests pass.

### 6b — Intent routing

- [ ] **Step 5: Add `loadEmail` to `Operation` type in `llmHelpers.ts`**

In `src/participant/jira/llmHelpers.ts` line 22, add `| 'loadEmail'` to the `Operation` union after `'createFromEmail'`:

```typescript
  | 'createFromEmail'
  | 'loadEmail';
```

- [ ] **Step 6: Add `loadEmail` to `INTENT_PROMPT` in `llmHelpers.ts`**

In the `INTENT_PROMPT` string (line 57–80 area), add `"loadEmail"` to the schema's `"operation"` union string and add the description line. In the schema line, append `|"loadEmail"` after `"createFromEmail"`. Then add after the `createFromEmail` description line:

```
- loadEmail: list handover email files waiting in the Downloads folder and let the user pick one; triggered by "load email", "pick email", "load from downloads", "show pending emails"
```

- [ ] **Step 7: Add `handleLoadEmail` and `handleHandoverFileSelection` to `emailHandler.ts`**

Append to `src/participant/jira/emailHandler.ts`:

```typescript
export async function handleLoadEmail(
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('ticketSidekick');
  const rawFolder = config.get<string>('email.handoverFolder', '').trim();
  const handoverFolder = rawFolder
    ? rawFolder.replace(/^~/, require('os').homedir())
    : require('path').join(require('os').homedir(), 'Downloads');

  const { listHandoverFiles } = await import('../../utils/handoverFolder');
  const raw = await listHandoverFiles(handoverFolder);

  if (raw.length === 0) {
    stream.markdown(
      `No handover files found in \`${handoverFolder}\`.\n\n` +
      `**To get emails there:**\n` +
      `- **Path A:** Enable \`ticketSidekick.localServer.enabled\` and re-export the userscript — emails POST directly to VS Code (no files).\n` +
      `- **Path C:** The userscript uses GM_download — check that your browser's download location matches the configured handover folder.`,
    );
    return;
  }

  // Read subject + date from each file (lightweight)
  const entries: import('../sessionState').HandoverFileEntry[] = [];
  for (const f of raw) {
    let subject = '(unknown subject)';
    let receivedDateTime = '';
    try {
      const text = await require('fs').promises.readFile(
        require('path').join(handoverFolder, f.filename), 'utf-8',
      );
      const parsed = JSON.parse(text);
      subject = parsed.subject ?? subject;
      receivedDateTime = parsed.receivedDateTime ?? '';
    } catch {
      // File unreadable — show with placeholder
    }
    entries.push({ filename: f.filename, timestamp: f.timestamp, subject, receivedDateTime, stale: f.stale });
  }

  const list = entries
    .map((e, i) => {
      const date = e.receivedDateTime ? e.receivedDateTime.slice(0, 10) : '?';
      const staleNote = e.stale ? ' _(stale)_' : '';
      return `${i + 1}. [${date}] ${e.subject}${staleNote}`;
    })
    .join('\n');

  const session: import('../sessionState').HandoverFileSelectionSession = { files: entries, handoverFolder };
  await ws.update('jira.session.handoverFileSelection', session);
  stream.markdown(`${list}\n\nReply with a number to load that email, or **(c)** to cancel.\n\n<!-- jira:handover-file-selection -->`);
}

export async function handleHandoverFileSelection(
  reply: string,
  session: import('../sessionState').HandoverFileSelectionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  context: vscode.ExtensionContext,
): Promise<void> {
  await ws.update('jira.session.handoverFileSelection', undefined);
  if (isCancellation(reply)) { stream.markdown('_Cancelled._'); return; }

  const n = parseInt(reply.trim(), 10);
  if (isNaN(n) || n < 1 || n > session.files.length) {
    await ws.update('jira.session.handoverFileSelection', session);
    const list = session.files.map((f, i) => `${i + 1}. ${f.subject}`).join('\n');
    stream.markdown(`Please reply with a number between 1 and ${session.files.length}, or **(c)** to cancel.\n\n${list}\n\n<!-- jira:handover-file-selection -->`);
    return;
  }

  const chosen = session.files[n - 1];
  const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  if (!projectKey) {
    stream.markdown('**No default project configured.** Set `ticketSidekick.jira.defaultProject` in settings and try again.');
    return;
  }

  stream.markdown('_Loading email…_');
  const { readHandoverEmail } = await import('../../utils/handoverFolder');
  let email: import('../sessionState').HandoverEmail;
  try {
    email = await readHandoverEmail(session.handoverFolder, chosen.timestamp);
  } catch (err) {
    stream.markdown(`**Could not read file:** ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const attachments: import('../sessionState').EmailContentSession['attachments'] = email.attachments
    .filter(a => a.dataBase64.length > 0)
    .map(a => ({ name: a.name, contentType: a.contentType, contentBytes: a.dataBase64, isInline: a.isInline }));

  const contentSession: import('../sessionState').EmailContentSession = {
    emailId: 'handover',
    subject: email.subject,
    markdownBody: email.markdownBody,
    inlineImageMap: {},
    attachments,
    selectedTemplateName: null,
    projectKey,
    issueType: 'Story',
    additionalFields: {},
    handoverCleanup: { folder: session.handoverFolder, timestamp: chosen.timestamp },
  };
  await streamEmailContentPreview(contentSession, stream, ws);
}
```

> **Note on imports:** The dynamic `import()` calls above are used because `emailHandler.ts` already imports many VS Code-only dependencies at the top. If TypeScript complains, convert to static imports at the top of the file — the test suite won't load this file anyway (it imports `vscode`), so static imports are fine.

Clean up by converting the `require` calls to top-of-file imports:

At the top of `emailHandler.ts`, the existing imports already include `path` if needed. Add:

```typescript
import * as os from 'os';
import * as fsSync from 'fs';
import { listHandoverFiles, readHandoverEmail } from '../../utils/handoverFolder';
import type { HandoverFileEntry, HandoverFileSelectionSession } from '../sessionState';
```

And rewrite `handleLoadEmail` to use the static imports (replacing the `require` and `import()` calls).

- [ ] **Step 8: Wire into `JiraParticipant.ts`**

Open `src/participant/JiraParticipant.ts`. Find the detection order block (the chain of `if (lastResponse?.includes('<!-- jira:...'))` checks). Add handover file selection detection near the end, just before the comment-list check (or before the final intent parse):

```typescript
    const handoverFileSession = ws.get<HandoverFileSelectionSession>('jira.session.handoverFileSelection');
    if (handoverFileSession && lastResponse?.includes('<!-- jira:handover-file-selection -->')) {
      await handleHandoverFileSelection(userText, handoverFileSession, stream, ws, context);
      return result;
    }
```

Also route the `loadEmail` intent. Find where `createFromEmail` is routed (where `parsed.operation === 'createFromEmail'`). After it, add:

```typescript
    if (parsed.operation === 'loadEmail') {
      await handleLoadEmail(stream, ws);
      return result;
    }
```

Add to the import at the top of `JiraParticipant.ts`:

```typescript
import { handleLoadEmail, handleHandoverFileSelection } from './jira/emailHandler';
import type { HandoverFileSelectionSession } from './sessionState';
```

- [ ] **Step 9: Update `CLAUDE.md` session table**

In `CLAUDE.md`, in the "Jira sessions" table, add a row:

```
| `HandoverFileSelectionSession` | `jira.session.handoverFileSelection` | `<!-- jira:handover-file-selection -->` |
```

And update the detection order description to include: `… → email content → **handover file selection** → comment list → intent parse`.

- [ ] **Step 10: Run compile and all tests**

```bash
~/.volta/bin/npm run compile 2>&1 | tail -20
~/.volta/bin/npm test 2>&1 | tail -20
```

Expected: no compile errors, all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/participant/sessionState.ts src/utils/handoverFolder.ts src/participant/jira/emailHandler.ts src/participant/jira/llmHelpers.ts src/participant/JiraParticipant.ts CLAUDE.md src/test/handoverFolder.test.ts
git commit -m "feat: add @jira load email (Path B) — folder scan, handover file selection, chat flow"
```

---

## Task 7: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

Read `README.md` fully to understand the existing structure before editing.

- [ ] **Step 2: Add / update the OWA email section**

Find the section describing the OWA email / Tampermonkey feature. Update it to document all three paths, the new settings, `@jira load email`, and the diagnostic sequence. The section should read approximately:

---

**OWA Email → Jira Ticket**

The extension can capture emails from Outlook Web App (OWA) and turn them into Jira tickets. Three delivery paths are available:

**Path A — Local HTTP server (recommended)**  
Enable `ticketSidekick.localServer.enabled` in VS Code settings. Re-export the userscript via *Command Palette → Ticket Sidekick: Export OWA Userscript for Tampermonkey*. The script will POST email data directly to VS Code — no files are saved to disk.

Settings:
- `ticketSidekick.localServer.enabled` — `false` by default; set to `true` to start the server
- `ticketSidekick.localServer.port` — default `17385`; change if the port is in use

**Path B — `@jira load email`**  
If emails were already downloaded to the handover folder (via Path C, or manually), type `@jira load email` in the Jira chat. VS Code lists the pending files by subject and date; reply with the number to load it into the ticket creation flow.

**Path C — GM_download + vscode:// URI (default when server is disabled)**  
The userscript saves a JSON file to the folder configured in `ticketSidekick.email.handoverFolder` (defaults to `~/Downloads/`) and fires a `vscode://` URI to trigger VS Code.

**Diagnosing corporate firewall issues (Path A)**  
1. *Command Palette → Ticket Sidekick: Test Local Server Connection* — confirms VS Code's server started and is reachable from VS Code itself
2. Tampermonkey toolbar icon → *Test connection to VS Code* — confirms the browser can reach the server; if this fails but step 1 passes, use Path B or C instead
3. *Output → Ticket Sidekick* — shows per-request detail

---

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document three handover paths, localServer settings, @jira load email, and diagnostic sequence"
```

---

## Self-review

**Spec coverage check:**

| Spec requirement | Covered by task |
|---|---|
| Optional HTTP server (`localServer.enabled`, `localServer.port`) | Task 2, 3, 4 |
| `/ping` health endpoint | Task 3 |
| `POST /email` endpoint | Task 3 |
| Bearer token auth (SecretStorage, auto-generated) | Task 3 |
| Status bar `TS ⚡ :PORT` | Task 4 |
| Port conflict error message | Task 4 |
| "Test Local Server" VS Code command | Task 4, 2 |
| `onStartupFinished` activation | Task 2 |
| Server binds to `127.0.0.1` only | Task 3 |
| Output channel logging | ⚠️ **Gap — see below** |
| `@jira load email` folder scan + selection | Task 6 |
| Stale file marker in list | Task 6 |
| `@jira load email` no-files guidance | Task 6 |
| `GM_registerMenuCommand` test entry | Task 5 |
| Shadow DOM button (position: fixed) | Task 5 |
| `GM_xmlhttpRequest` POST replaces `GM_download` | Task 5 |
| Server mode embedded at export time | Task 4, 5 |
| `parseHandoverManifest` pure function | Task 1 |
| README update | Task 7 |

**Gap found — Output channel:** The spec requires logging every request to a "Ticket Sidekick" output channel. This was not included in any task above.

- [ ] **Add to Task 4 Step 4:** Create an output channel and pass it to `LocalServerService` for request logging.

Add to the top of `activate()`:

```typescript
  const outputChannel = vscode.window.createOutputChannel('Ticket Sidekick');
  context.subscriptions.push(outputChannel);
```

Update `LocalServerService` constructor to accept an optional logger:

```typescript
constructor(
  private readonly context: ExtensionContext,
  private readonly onEmail: (manifest: HandoverManifest) => Promise<void>,
  private readonly log?: (msg: string) => void,
) {}
```

Inside the server's request handler, after each `res.writeHead(...)`, add:

```typescript
this.log?.(`${req.method} ${req.url} → ${statusCode}`);
```

And on `POST /email` success, after calling `this.onEmail`:

```typescript
this.log?.(`POST /email received: subject="${manifest.subject}", images=${manifest.inlineImages?.length ?? 0}, attachments=${manifest.attachments?.length ?? 0}`);
```

Pass the logger in `extension.ts`:

```typescript
  const localServer = new LocalServerService(
    context,
    async (manifest) => { ... },
    (msg) => outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`),
  );
```

This closes the gap.

**Placeholder scan:** No TBDs, TODOs, or vague steps found.

**Type consistency check:** `HandoverManifest` is used in `LocalServerService`, `handoverFolder.ts`, and `extension.ts` — all importing from `handoverFolder.ts`. `HandoverFileEntry` / `HandoverFileSelectionSession` defined in `sessionState.ts`, used in `emailHandler.ts` and `JiraParticipant.ts`. `parseHandoverManifest` defined in Task 1, called in Task 4. All consistent.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-23-local-server-handover.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
