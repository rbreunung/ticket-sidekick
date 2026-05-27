# OWA Tampermonkey Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tampermonkey userscript bridge that captures OWA emails (body, inline images, file attachments) into a local handover folder and feeds them into the existing `@jira create from email` flow without touching the blocked Microsoft Graph API.

**Architecture:** The extension generates a Tampermonkey script via a VS Code command. The script saves all email data into a per-click epoch subfolder under `~/Downloads/TicketSidekick/`, then navigates to a `vscode://` URI. A URI handler in `extension.ts` reads the folder, converts the HTML body to markdown, and stores a `HandoverEmail` in `workspaceState`. `emailHandler.ts` checks for this stored value before attempting the Graph API path, so the existing preview/confirm/create flow runs unchanged.

**Tech Stack:** TypeScript, Node.js `fs`/`path`/`os`, Vitest, Tampermonkey (GM_download, GM_xmlhttpRequest), VS Code extension API (URI handler, workspace state, LM API for footer cleanup).

---

## Files changed

| File | Change |
|---|---|
| `src/participant/sessionState.ts` | +`HandoverEmail` interface; +`handoverCleanup?` field on `EmailContentSession` |
| `src/utils/htmlToMarkdown.ts` | +`data-ts-filename` → `![name](name)` rule (before cid: rule) |
| `src/test/htmlToMarkdown.test.ts` | +3 test cases for `data-ts-filename` handling |
| `src/utils/markdownToJiraWiki.ts` | Change image rule: local URL → `!url\|thumbnail!`, remote → `!url!` |
| `src/test/markdownToJiraWiki.test.ts` | +2 test cases for local-image thumbnail rule |
| `src/test/fixtures/email-handover/test-session-1/email.json` | NEW — HandoverManifest fixture |
| `src/test/fixtures/email-handover/test-session-1/email-body.html` | NEW — HTML body fixture with one inline image marker |
| `src/test/fixtures/email-handover/test-session-1/email-image-1.png` | NEW — minimal 1×1 PNG |
| `src/test/fixtures/email-handover/test-session-1/report.pdf` | NEW — minimal valid PDF |
| `src/utils/handoverFolder.ts` | NEW — `readHandoverEmail`, `deleteHandoverSubfolder`, `purgeStaleSubfolders` |
| `src/test/handoverFolder.test.ts` | NEW — full pipeline tests using fixture files |
| `src/utils/owaUserscript.ts` | NEW — `generateOwaUserscript` pure function |
| `src/test/owaUserscript.test.ts` | NEW — script generator output tests |
| `src/participant/jira/emailHandler.ts` | +handover shortcut at top of `handleCreateFromEmail`; +subfolder cleanup in `finishEmailTicket` |
| `src/extension.ts` | +URI handler; +`processHandoverEmail` command; +`exportOwaUserscript` command |
| `package.json` | +`onUri` activation event; +1 command; +`outlook.owaUrl` setting; +email configuration block |
| `README.md` | +OWA bridge section after existing Outlook section |

---

## Task 1: Foundation types

**Files:**
- Modify: `src/participant/sessionState.ts`

Add `HandoverEmail` interface and optional `handoverCleanup` to `EmailContentSession`. No tests needed — pure type changes verified by `npm run compile`.

- [ ] **Step 1: Add `HandoverEmail` interface and `handoverCleanup` to `EmailContentSession`**

In `src/participant/sessionState.ts`, add the following immediately after the `// --- Outlook email-to-ticket sessions ---` comment block (around line 86), before `FolderSelectionSession`:

```typescript
export interface HandoverEmail {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  markdownBody: string;
  stripFooter: boolean;
  handoverFolder: string;
  subfolder: string;
  attachments: Array<{
    name: string;
    contentType: string;
    filePath: string;
    isInline: boolean;
  }>;
}
```

Then add `handoverCleanup?: { folder: string; subfolder: string }` as a new optional field to `EmailContentSession` (after the existing `additionalFields` field):

```typescript
export interface EmailContentSession {
  emailId: string;
  subject: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  selectedTemplateName: string | null;
  projectKey: string;
  issueType: string;
  additionalFields: Record<string, unknown>;
  handoverCleanup?: { folder: string; subfolder: string };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npm run compile`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/participant/sessionState.ts
git commit -m "feat: add HandoverEmail type and handoverCleanup to EmailContentSession"
```

---

## Task 2: htmlToMarkdown — data-ts-filename support

**Files:**
- Modify: `src/test/htmlToMarkdown.test.ts`
- Modify: `src/utils/htmlToMarkdown.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/test/htmlToMarkdown.test.ts` (at the end of the `describe('htmlToMarkdown', ...)` block):

```typescript
  it('converts data-ts-filename img to markdown image at correct position', () => {
    const html = '<p>Before</p><img data-ts-filename="email-image-1.png"><p>After</p>';
    const result = htmlToMarkdown(html);
    expect(result).toContain('![email-image-1.png](email-image-1.png)');
    expect(result.indexOf('Before')).toBeLessThan(result.indexOf('![email-image-1.png]'));
    expect(result.indexOf('![email-image-1.png]')).toBeLessThan(result.indexOf('After'));
  });

  it('data-ts-filename img is not caught by the alt-text fallback', () => {
    const html = '<img data-ts-filename="photo.jpg" alt="photo">';
    expect(htmlToMarkdown(html)).toBe('![photo.jpg](photo.jpg)');
  });

  it('data-ts-filename takes precedence over src attribute', () => {
    const html = '<img src="https://example.com/img.png" data-ts-filename="email-image-2.png">';
    expect(htmlToMarkdown(html)).toBe('![email-image-2.png](email-image-2.png)');
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --reporter=verbose src/test/htmlToMarkdown.test.ts`
Expected: 3 new tests FAIL — data-ts-filename is not yet handled.

- [ ] **Step 3: Implement data-ts-filename handling**

In `src/utils/htmlToMarkdown.ts`, add the new rule immediately BEFORE the existing `// Inline images: cid: references` comment (currently around line 57):

```typescript
  // Inline images: data-ts-filename (OWA Tampermonkey bridge) — must come before cid: and alt rules
  s = s.replace(/<img[^>]+data-ts-filename="([^"]*)"[^>]*\/?>/gi, (_: string, filename: string) =>
    `![${filename}](${filename})`
  );
```

The section now reads:

```typescript
  // Inline images: data-ts-filename (OWA Tampermonkey bridge) — must come before cid: and alt rules
  s = s.replace(/<img[^>]+data-ts-filename="([^"]*)"[^>]*\/?>/gi, (_: string, filename: string) =>
    `![${filename}](${filename})`
  );
  // Inline images: cid: references
  s = s.replace(/<img[^>]+src="cid:([^"]*)"[^>]*\/?>/gi, (_: string, cid: string) => {
    const filename = inlineImageMap.get(cid.trim()) ?? cid.trim();
    return `[📎 ${filename}]`;
  });
  // Other images: use alt text
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, '[$1]');
  s = s.replace(/<img[^>]*\/?>/gi, '');
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --reporter=verbose src/test/htmlToMarkdown.test.ts`
Expected: All tests pass including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/utils/htmlToMarkdown.ts src/test/htmlToMarkdown.test.ts
git commit -m "feat: htmlToMarkdown converts data-ts-filename img to markdown image"
```

---

## Task 3: markdownToJiraWiki — local image thumbnail rule

**Files:**
- Modify: `src/test/markdownToJiraWiki.test.ts`
- Modify: `src/utils/markdownToJiraWiki.ts`

- [ ] **Step 1: Write failing tests**

In `src/test/markdownToJiraWiki.test.ts`, add a new `describe` block for images (before the closing `});` of the top-level describe):

```typescript
  describe('images', () => {
    it('converts local image (no protocol) to Jira thumbnail syntax', () => {
      expect(markdownToJiraWiki('![email-image-1.png](email-image-1.png)')).toBe('!email-image-1.png|thumbnail!');
    });

    it('converts remote image (https) to plain Jira image syntax without thumbnail', () => {
      expect(markdownToJiraWiki('![logo](https://example.com/logo.png)')).toBe('!https://example.com/logo.png!');
    });
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --reporter=verbose src/test/markdownToJiraWiki.test.ts`
Expected: The "local image" test FAILS (current output is `!email-image-1.png!` without `|thumbnail`). The "remote image" test PASSES because it was already produced by the old rule (no change needed for remote).

- [ ] **Step 3: Implement the thumbnail rule**

In `src/utils/markdownToJiraWiki.ts`, inside the `inline()` function, find the current image rule (around line 101):

```typescript
  // Images before links so ![...](...) is handled first
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '!$2!');
```

Replace it with:

```typescript
  // Images before links so ![...](...) is handled first
  // Local URLs (no protocol) → thumbnail syntax; remote URLs → plain syntax
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, _alt, url) =>
    /^https?:\/\/|^\/\//.test(url) ? `!${url}!` : `!${url}|thumbnail!`
  );
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --reporter=verbose src/test/markdownToJiraWiki.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run full suite to catch regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/utils/markdownToJiraWiki.ts src/test/markdownToJiraWiki.test.ts
git commit -m "feat: markdownToJiraWiki uses thumbnail syntax for local image URLs"
```

---

## Task 4: Test fixture files

**Files:**
- Create: `src/test/fixtures/email-handover/test-session-1/email.json`
- Create: `src/test/fixtures/email-handover/test-session-1/email-body.html`
- Create: `src/test/fixtures/email-handover/test-session-1/email-image-1.png`
- Create: `src/test/fixtures/email-handover/test-session-1/report.pdf`

These are test data files, not TypeScript — no TDD cycle applies. Create them directly.

- [ ] **Step 1: Create the fixture directory**

```bash
mkdir -p src/test/fixtures/email-handover/test-session-1
```

- [ ] **Step 2: Write `email.json`**

Create `src/test/fixtures/email-handover/test-session-1/email.json`:

```json
{
  "subject": "Test Email Subject",
  "senderName": "Jane Doe",
  "receivedDateTime": "2026-05-23T10:00:00Z",
  "bodyFile": "email-body.html",
  "stripFooter": false,
  "inlineImages": [
    { "filename": "email-image-1.png", "contentType": "image/png" }
  ],
  "attachments": [
    { "filename": "report.pdf", "contentType": "application/pdf" }
  ]
}
```

- [ ] **Step 3: Write `email-body.html`**

Create `src/test/fixtures/email-handover/test-session-1/email-body.html`:

```html
<p>Hello <strong>World</strong></p>
<p>See the attached image:</p>
<img data-ts-filename="email-image-1.png">
<p>And the report is in the attachments.</p>
```

- [ ] **Step 4: Write minimal `email-image-1.png`**

Create the minimal 1×1 transparent PNG by running:

```bash
node -e "
const fs = require('fs');
// Minimal 1x1 black pixel PNG (base64-encoded)
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=',
  'base64'
);
fs.writeFileSync('src/test/fixtures/email-handover/test-session-1/email-image-1.png', png);
console.log('PNG written, size:', png.length, 'bytes');
"
```

Expected output: `PNG written, size: 68 bytes`

- [ ] **Step 5: Write minimal `report.pdf`**

Create `src/test/fixtures/email-handover/test-session-1/report.pdf` with this exact content (a valid minimal 1-page PDF):

```
%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer<</Size 4/Root 1 0 R>>
startxref
190
%%EOF
```

Create it with:
```bash
node -e "
const fs = require('fs');
const pdf = '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF';
fs.writeFileSync('src/test/fixtures/email-handover/test-session-1/report.pdf', pdf);
console.log('PDF written');
"
```

- [ ] **Step 6: Verify all four files exist**

```bash
ls -la src/test/fixtures/email-handover/test-session-1/
```

Expected: `email.json`, `email-body.html`, `email-image-1.png`, `report.pdf`

- [ ] **Step 7: Commit**

```bash
git add src/test/fixtures/email-handover/
git commit -m "test: add email-handover fixture files for handoverFolder pipeline tests"
```

---

## Task 5: handoverFolder.ts utility + tests

**Files:**
- Create: `src/test/handoverFolder.test.ts`
- Create: `src/utils/handoverFolder.ts`

- [ ] **Step 1: Write failing tests**

Create `src/test/handoverFolder.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readHandoverEmail, deleteHandoverSubfolder, purgeStaleSubfolders } from '../utils/handoverFolder';

const FIXTURES = path.resolve(process.cwd(), 'src/test/fixtures/email-handover');
const SUBFOLDER = 'test-session-1';

describe('readHandoverEmail', () => {
  it('parses subject, sender, date from manifest', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.subject).toBe('Test Email Subject');
    expect(email.senderName).toBe('Jane Doe');
    expect(email.receivedDateTime).toBe('2026-05-23T10:00:00Z');
  });

  it('converts HTML body to markdown', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.markdownBody).toContain('Hello **World**');
    expect(email.markdownBody).toContain('See the attached image');
  });

  it('positions inline image as ![name](name) in markdownBody', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.markdownBody).toContain('![email-image-1.png](email-image-1.png)');
  });

  it('lists file attachments with correct absolute filePaths', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf!.filePath).toBe(path.join(FIXTURES, SUBFOLDER, 'report.pdf'));
  });

  it('returns isInline:true for images, isInline:false for attachments', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    const img = email.attachments.find(a => a.name === 'email-image-1.png');
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(img!.isInline).toBe(true);
    expect(pdf!.isInline).toBe(false);
  });

  it('returns handoverFolder and subfolder for later cleanup', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.handoverFolder).toBe(FIXTURES);
    expect(email.subfolder).toBe(SUBFOLDER);
  });

  it('throws when manifest file not found', async () => {
    await expect(readHandoverEmail(FIXTURES, 'nonexistent-subfolder')).rejects.toThrow(
      /Could not read handover manifest/
    );
  });

  it('throws when referenced body file is missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
    const sub = 'broken-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    fs.writeFileSync(
      path.join(tmpDir, sub, 'email.json'),
      JSON.stringify({
        subject: 'x', senderName: 'x', receivedDateTime: 'x',
        bodyFile: 'missing-body.html', stripFooter: false,
        inlineImages: [], attachments: [],
      }),
    );
    await expect(readHandoverEmail(tmpDir, sub)).rejects.toThrow(/Could not read email body/);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('deleteHandoverSubfolder', () => {
  it('removes the subfolder', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-del-'));
    const sub = 'to-delete';
    fs.mkdirSync(path.join(tmpDir, sub));
    fs.writeFileSync(path.join(tmpDir, sub, 'email.json'), '{}');
    await deleteHandoverSubfolder(tmpDir, sub);
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('purgeStaleSubfolders', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-purge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes subfolders older than maxAgeMs', async () => {
    const sub = 'old-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    // Set mtime to 2 hours ago
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(tmpDir, sub), old, old);
    await purgeStaleSubfolders(tmpDir, 60 * 60 * 1000); // maxAge = 1 hour
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(false);
  });

  it('keeps subfolders newer than maxAgeMs', async () => {
    const sub = 'new-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    await purgeStaleSubfolders(tmpDir, 60 * 60 * 1000); // maxAge = 1 hour
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(true);
  });

  it('does not throw when handoverFolder does not exist', async () => {
    await expect(purgeStaleSubfolders('/tmp/nonexistent-ts-folder-xyz', 1000)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --reporter=verbose src/test/handoverFolder.test.ts`
Expected: All tests FAIL — module `../utils/handoverFolder` does not exist.

- [ ] **Step 3: Implement `src/utils/handoverFolder.ts`**

Create `src/utils/handoverFolder.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { htmlToMarkdown } from './htmlToMarkdown';
import type { HandoverEmail } from '../participant/sessionState';

interface HandoverManifest {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  bodyFile: string;
  stripFooter: boolean;
  inlineImages: Array<{ filename: string; contentType: string }>;
  attachments: Array<{ filename: string; contentType: string }>;
}

export async function readHandoverEmail(handoverFolder: string, subfolder: string): Promise<HandoverEmail> {
  const dir = path.join(handoverFolder, subfolder);
  const manifestPath = path.join(dir, 'email.json');

  let manifest: HandoverManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as HandoverManifest;
  } catch {
    throw new Error(`Could not read handover manifest at ${manifestPath}`);
  }

  const bodyPath = path.join(dir, manifest.bodyFile);
  let bodyHtml: string;
  try {
    bodyHtml = fs.readFileSync(bodyPath, 'utf-8');
  } catch {
    throw new Error(`Could not read email body at ${bodyPath}`);
  }

  const markdownBody = htmlToMarkdown(bodyHtml);

  return {
    subject: manifest.subject,
    senderName: manifest.senderName,
    receivedDateTime: manifest.receivedDateTime,
    markdownBody,
    stripFooter: manifest.stripFooter,
    handoverFolder,
    subfolder,
    attachments: [
      ...manifest.inlineImages.map(img => ({
        name: img.filename,
        contentType: img.contentType,
        filePath: path.join(dir, img.filename),
        isInline: true,
      })),
      ...manifest.attachments.map(att => ({
        name: att.filename,
        contentType: att.contentType,
        filePath: path.join(dir, att.filename),
        isInline: false,
      })),
    ],
  };
}

export async function deleteHandoverSubfolder(handoverFolder: string, subfolder: string): Promise<void> {
  fs.rmSync(path.join(handoverFolder, subfolder), { recursive: true, force: true });
}

export async function purgeStaleSubfolders(handoverFolder: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(handoverFolder, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(handoverFolder, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Already deleted (race condition) — skip
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --reporter=verbose src/test/handoverFolder.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/utils/handoverFolder.ts src/test/handoverFolder.test.ts
git commit -m "feat: add handoverFolder utility (readHandoverEmail, deleteHandoverSubfolder, purgeStaleSubfolders)"
```

---

## Task 6: owaUserscript.ts generator + tests

**Files:**
- Create: `src/test/owaUserscript.test.ts`
- Create: `src/utils/owaUserscript.ts`

- [ ] **Step 1: Write failing tests**

Create `src/test/owaUserscript.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateOwaUserscript } from '../utils/owaUserscript';

const SCRIPT = generateOwaUserscript({
  owaUrl: 'https://mail.contoso.com',
  vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
});

describe('generateOwaUserscript', () => {
  it('starts with the Tampermonkey header marker', () => {
    expect(SCRIPT.startsWith('// ==UserScript==')).toBe(true);
  });

  it('includes @match with the configured owaUrl', () => {
    expect(SCRIPT).toContain('@match        https://mail.contoso.com/*');
  });

  it('grants GM_download', () => {
    expect(SCRIPT).toContain('@grant        GM_download');
  });

  it('grants GM_xmlhttpRequest', () => {
    expect(SCRIPT).toContain('@grant        GM_xmlhttpRequest');
  });

  it('embeds the vscode URI base for navigation', () => {
    expect(SCRIPT).toContain('vscode://RobertBreunung.ticket-sidekick/from-email');
  });

  it('uses folder query parameter in the URI', () => {
    expect(SCRIPT).toContain('?folder=');
  });

  it('includes the plain capture button label', () => {
    expect(SCRIPT).toContain('📋 To Ticket');
  });

  it('includes the clean capture button label', () => {
    expect(SCRIPT).toContain('📋✨ To Ticket (Clean)');
  });

  it('uses epoch timestamp as folder name', () => {
    expect(SCRIPT).toContain('Date.now()');
  });

  it('uses TicketSidekick/ as the downloads prefix', () => {
    expect(SCRIPT).toContain("'TicketSidekick/'");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npm test -- --reporter=verbose src/test/owaUserscript.test.ts`
Expected: All tests FAIL — module `../utils/owaUserscript` does not exist.

- [ ] **Step 3: Implement `src/utils/owaUserscript.ts`**

Create `src/utils/owaUserscript.ts`:

```typescript
export function generateOwaUserscript(config: {
  owaUrl: string;
  vscodeUriBase: string;
}): string {
  const { owaUrl, vscodeUriBase } = config;
  return `// ==UserScript==
// @name         Ticket Sidekick — OWA to Jira
// @namespace    https://ticket-sidekick
// @version      1.0
// @description  Capture OWA email and send to Ticket Sidekick in VS Code
// @author       Ticket Sidekick
// @match        ${owaUrl}/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  const VSCODE_URI = '${vscodeUriBase}/from-email';
  const FOLDER_PREFIX = 'TicketSidekick/';

  function getReadingPane() {
    return document.querySelector('[data-testid="reading-pane"]')
      || document.querySelector('[aria-label="Reading Pane"]')
      || document.querySelector('.ReadingPane');
  }

  function getSubject() {
    return (
      document.querySelector('[data-testid="subject"]')?.textContent?.trim()
      || document.querySelector('[aria-label^="Email subject"]')?.textContent?.trim()
      || document.querySelector('h1')?.textContent?.trim()
      || '(no subject)'
    );
  }

  function getSenderName() {
    return (
      document.querySelector('[data-testid="sender-name"]')?.textContent?.trim()
      || document.querySelector('[aria-label^="From"]')?.textContent?.trim()
      || 'Unknown'
    );
  }

  function getReceivedDateTime() {
    return document.querySelector('time')?.getAttribute('datetime') || new Date().toISOString();
  }

  function getBodyElement() {
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

  function blobDownload(content, name) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      GM_download({
        url,
        name,
        onload() { URL.revokeObjectURL(url); resolve(); },
        onerror(e) { URL.revokeObjectURL(url); reject(e); },
      });
    });
  }

  function fetchAndDownload(src, name) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: src,
        responseType: 'blob',
        onload(res) {
          const url = URL.createObjectURL(res.response);
          GM_download({
            url,
            name,
            onload() { URL.revokeObjectURL(url); resolve(); },
            onerror(e) { URL.revokeObjectURL(url); reject(e); },
          });
        },
        onerror: reject,
      });
    });
  }

  async function captureEmail(stripFooter) {
    const folder = Date.now().toString();
    const base = FOLDER_PREFIX + folder + '/';
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
    const downloads = [];
    let imgIdx = 0;

    for (const img of bodyClone.querySelectorAll('img')) {
      const src = img.getAttribute('src') || img.src;
      if (!src || src.startsWith('data:')) { img.remove(); continue; }
      imgIdx++;
      const extMatch = src.match(/\\.([a-z]{2,4})(\\?|$)/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const filename = 'email-image-' + imgIdx + '.' + ext;
      const mimeExt = ext === 'jpg' ? 'jpeg' : ext;
      img.setAttribute('data-ts-filename', filename);
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      inlineImages.push({ filename, contentType: 'image/' + mimeExt });
      downloads.push(fetchAndDownload(src, base + filename));
    }

    const attachments = [];
    for (const link of document.querySelectorAll('[data-testid="attachment-item"] a')) {
      const href = link.href;
      const name = (link.textContent || link.title || '').trim();
      if (href && !href.startsWith('javascript') && name) {
        attachments.push({ filename: name, contentType: 'application/octet-stream' });
        downloads.push(fetchAndDownload(href, base + name));
      }
    }

    await Promise.all(downloads);
    await blobDownload(bodyClone.innerHTML, base + 'email-body.html');
    await blobDownload(
      JSON.stringify({
        subject, senderName, receivedDateTime,
        bodyFile: 'email-body.html',
        stripFooter: !!stripFooter,
        inlineImages, attachments,
      }, null, 2),
      base + 'email.json',
    );

    // 1.5 s soft head-start before VS Code polling begins; downloads continue uninterrupted
    // (window.location.href to a vscode:// URI hands off to the OS — does not navigate away)
    setTimeout(() => {
      window.location.href = VSCODE_URI + '?folder=' + folder;
    }, 1500);
  }

  function injectButtons(pane) {
    if (pane.dataset.tsInjected) return;
    pane.dataset.tsInjected = 'true';

    const toolbar = (
      pane.querySelector('[data-testid="reading-pane-toolbar"]')
      || pane.querySelector('[role="toolbar"]')
      || pane.firstElementChild
    );
    if (!toolbar) return;

    function makeBtn(label, stripFooter) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = stripFooter ? 'Create Jira ticket (AI footer removal)' : 'Create Jira ticket';
      btn.style.cssText = 'margin:2px 4px;padding:3px 8px;cursor:pointer;font-size:12px;'
        + 'border:1px solid #888;border-radius:3px;background:#f5f5f5;';
      btn.addEventListener('click', (e) => { e.stopPropagation(); captureEmail(stripFooter); });
      return btn;
    }

    toolbar.appendChild(makeBtn('📋 To Ticket', false));
    toolbar.appendChild(makeBtn('📋✨ To Ticket (Clean)', true));
  }

  const observer = new MutationObserver(() => {
    const pane = getReadingPane();
    if (pane) injectButtons(pane);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npm test -- --reporter=verbose src/test/owaUserscript.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/owaUserscript.ts src/test/owaUserscript.test.ts
git commit -m "feat: add generateOwaUserscript — pure function returning Tampermonkey userscript"
```

---

## Task 7: emailHandler.ts — handover shortcut and cleanup

**Files:**
- Modify: `src/participant/jira/emailHandler.ts`

`emailHandler.ts` uses the VS Code API and cannot be unit-tested. Verification is by `npm run compile` and manual testing.

- [ ] **Step 1: Add imports**

At the top of `src/participant/jira/emailHandler.ts`, add the following imports after the existing imports:

```typescript
import * as fs from 'fs';
import { readHandoverEmail, deleteHandoverSubfolder } from '../../utils/handoverFolder';
import type { HandoverEmail } from '../sessionState';
```

The import for `HandoverEmail` is type-only (`import type`) because it's only used as a type annotation.

- [ ] **Step 2: Add handover shortcut at the top of `handleCreateFromEmail`**

Inside `handleCreateFromEmail`, add the following block as the very first thing in the function body (before `const outlookConfig = ...`):

```typescript
  // Handover shortcut — populated by ticket-sidekick.processHandoverEmail command (URI handler)
  const handover = ws.get<HandoverEmail>('jira.handover.email');
  if (handover) {
    await ws.update('jira.handover.email', undefined);
    const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
    if (!projectKey) {
      stream.markdown('**No default project configured.** Set `ticketSidekick.jira.defaultProject` in VS Code settings and try again.');
      return;
    }
    const contentSession: EmailContentSession = {
      emailId: 'handover',
      subject: handover.subject,
      markdownBody: handover.markdownBody,
      inlineImageMap: {},
      attachments: handover.attachments.map(a => ({
        name: a.name,
        contentType: a.contentType,
        contentBytes: fs.readFileSync(a.filePath).toString('base64'),
        isInline: a.isInline,
      })),
      selectedTemplateName: null,
      projectKey,
      issueType: 'Story',
      additionalFields: {},
      handoverCleanup: { folder: handover.handoverFolder, subfolder: handover.subfolder },
    };
    await streamEmailContentPreview(contentSession, stream, ws);
    return;
  }
```

- [ ] **Step 3: Add cleanup in `finishEmailTicket`**

At the end of the `finishEmailTicket` function, after the last `stream.markdown(...)` call but before the closing `}`, add:

```typescript
  if (session.handoverCleanup) {
    await deleteHandoverSubfolder(session.handoverCleanup.folder, session.handoverCleanup.subfolder).catch(() => {
      // Cleanup failure is non-fatal — files will be purged on next processHandoverEmail invocation
    });
  }
```

The full `finishEmailTicket` function after the change:

```typescript
async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  let jiraWiki = markdownToJiraWiki(session.markdownBody);
  jiraWiki = jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');

  const result = await ticketService.createTicket(
    session.projectKey, session.subject, session.issueType,
    { ...session.additionalFields, description: jiraWiki },
  );
  stream.markdown(result);

  const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
  const issueKey = keyMatch?.[1];
  if (issueKey && session.attachments.length > 0) {
    await Promise.all(
      session.attachments.map(att =>
        ticketService.uploadAttachment(issueKey, att.name, att.contentType, att.contentBytes).catch(err => {
          stream.markdown(`_Warning: could not upload ${att.name}: ${err instanceof Error ? err.message : String(err)}_`);
        }),
      ),
    );
    stream.markdown(`\n\nUploaded ${session.attachments.length} attachment(s).\n\n<!-- @jira-ticket:${issueKey} -->`);
  } else if (issueKey) {
    stream.markdown(`\n\n<!-- @jira-ticket:${issueKey} -->`);
  }

  if (session.handoverCleanup) {
    await deleteHandoverSubfolder(session.handoverCleanup.folder, session.handoverCleanup.subfolder).catch(() => {
      // Non-fatal — stale files are purged on the next processHandoverEmail invocation
    });
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `npm run compile`
Expected: No TypeScript errors.

- [ ] **Step 5: Run tests to catch regressions**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/participant/jira/emailHandler.ts
git commit -m "feat: emailHandler checks handover workspaceState before Graph API; cleans up subfolder after ticket creation"
```

---

## Task 8: extension.ts URI handler + commands and package.json settings

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Add imports to `extension.ts`**

Add to the top of `src/extension.ts`, after the existing imports:

```typescript
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readHandoverEmail, purgeStaleSubfolders } from './utils/handoverFolder';
import { generateOwaUserscript } from './utils/owaUserscript';
import type { HandoverEmail } from './participant/sessionState';
```

- [ ] **Step 2: Add URI handler and two commands to `activate`**

Inside `activate(context)`, add the following to `context.subscriptions.push(...)` (add after the existing `ticket-sidekick.setOutlookToken` command, before the closing `)`):

```typescript
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/from-email') {
          const folder = new URLSearchParams(uri.query).get('folder') ?? '';
          if (folder) vscode.commands.executeCommand('ticket-sidekick.processHandoverEmail', folder);
        }
      },
    }),

    vscode.commands.registerCommand('ticket-sidekick.processHandoverEmail', async (subfolder: string) => {
      if (!subfolder) return;
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const rawFolder = config.get<string>('email.handoverFolder', '').trim();
      const handoverFolder = rawFolder
        ? rawFolder.replace(/^~/, os.homedir())
        : path.join(os.homedir(), 'Downloads', 'TicketSidekick');

      await purgeStaleSubfolders(handoverFolder, 24 * 60 * 60 * 1000);

      const manifestPath = path.join(handoverFolder, subfolder, 'email.json');
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

      if (email.stripFooter) {
        const modelFamily = config.get<string>('email.cleanupModel', 'gpt-4o-mini');
        try {
          const models = await vscode.lm.selectChatModels({ family: modelFamily });
          if (models.length > 0) {
            const msgs = [
              vscode.LanguageModelChatMessage.User(
                `Remove the corporate email footer, signature, and legal disclaimer from this email body. ` +
                `Return only the relevant content as markdown:\n\n${email.markdownBody}`,
              ),
            ];
            const res = await models[0].sendRequest(msgs, {}, new vscode.CancellationTokenSource().token);
            let cleaned = '';
            for await (const chunk of res.text) cleaned += chunk;
            email = { ...email, markdownBody: cleaned.trim() };
          }
        } catch {
          // Footer cleanup failed — continue with original body
        }
      }

      await context.workspaceState.update('jira.handover.email', email);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' });
    }),

    vscode.commands.registerCommand('ticket-sidekick.exportOwaUserscript', async () => {
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const owaUrl = config.get<string>('outlook.owaUrl', 'https://outlook.office.com').trim() || 'https://outlook.office.com';
      const script = generateOwaUserscript({
        owaUrl,
        vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
      });
      const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: script });
      await vscode.window.showTextDocument(doc);
    }),
```

- [ ] **Step 3: Add `onUri` to activationEvents in `package.json`**

In `package.json`, change:

```json
"activationEvents": [],
```

To:

```json
"activationEvents": ["onUri"],
```

- [ ] **Step 4: Add `exportOwaUserscript` to contributes.commands in `package.json`**

In `package.json`, in the `"commands"` array inside `"contributes"`, add after the last existing command:

```json
      {
        "command": "ticket-sidekick.exportOwaUserscript",
        "title": "Ticket Sidekick: Export OWA Userscript for Tampermonkey"
      }
```

- [ ] **Step 5: Add `ticketSidekick.outlook.owaUrl` to the outlook configuration section in `package.json`**

In `package.json`, inside the `"outlook"` configuration object's `"properties"`, add after the existing `ticketSidekick.outlook.authProvider` setting:

```json
          "ticketSidekick.outlook.owaUrl": {
            "type": "string",
            "default": "https://outlook.office.com",
            "description": "OWA base URL used when generating the Tampermonkey userscript. Use your corporate URL if different (e.g. https://mail.company.com)."
          }
```

- [ ] **Step 6: Add new email configuration block to `package.json`**

In `package.json`, add a new configuration block after the `"outlook"` block (before the closing `]` of the `"configuration"` array):

```json
      ,{
        "id": "email",
        "title": "Ticket Sidekick — Email",
        "properties": {
          "ticketSidekick.email.handoverFolder": {
            "type": "string",
            "default": "",
            "description": "Root folder where the Tampermonkey userscript saves email subfolders. Defaults to ~/Downloads/TicketSidekick/ when empty. Must match where Microsoft Edge saves downloads plus the 'TicketSidekick/' subdirectory."
          },
          "ticketSidekick.email.cleanupModel": {
            "type": "string",
            "default": "gpt-4o-mini",
            "description": "VS Code LM model family used for AI email footer/signature removal when '📋✨ To Ticket (Clean)' is clicked. Must be a model family available in your VS Code instance."
          }
        }
      }
```

- [ ] **Step 7: Verify compilation**

Run: `npm run compile`
Expected: No TypeScript errors.

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add URI handler, processHandoverEmail command, exportOwaUserscript command, and OWA package settings"
```

---

## Task 9: README.md — OWA bridge section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the insertion point**

Read `README.md` and find the existing "Create ticket from Outlook email" section inside `## @jira — Jira`. The new section goes immediately AFTER that section and its content.

- [ ] **Step 2: Insert the OWA bridge section**

Add the following markdown block immediately after the last line of the existing Outlook email section:

````markdown
### Create ticket from Outlook email — OWA bridge (Tampermonkey)

Use this approach when the Microsoft Graph API is blocked by your corporate tenant.

**How it works:** A browser userscript captures the open email in OWA (subject, body,
inline images, attachments) and saves everything to a local handover folder. VS Code
reads the folder and opens the ticket creation preview automatically.

**One-time setup:**

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Microsoft Edge
   (Edge recommended — subdirectory download support confirmed on Chromium).
2. In VS Code settings, set:
   - `ticketSidekick.outlook.owaUrl` — your OWA URL
     (default: `https://outlook.office.com`; use your corporate URL if different)
   - `ticketSidekick.email.handoverFolder` — path where VS Code reads email files
     (default: `~/Downloads/TicketSidekick/`; must match Edge's downloads location)
   - `ticketSidekick.jira.defaultProject` — Jira project key for new tickets
3. Run **Command Palette → Ticket Sidekick: Export OWA Userscript for Tampermonkey**
4. Copy the generated script into Tampermonkey (New Script → paste → Save)

**Per-email workflow:**

1. Open an email in OWA
2. Click **📋 To Ticket** in the reading pane toolbar
   (or **📋✨ To Ticket (Clean)** to strip the corporate footer/signature via AI)
3. VS Code focuses automatically and shows a preview of the Jira ticket
4. Reply **post it** to create — or **(c)** to cancel

Inline images are uploaded as Jira attachments and embedded as thumbnails at their
original position in the description. File attachments are uploaded to the ticket.
The local handover files are deleted automatically after the ticket is created.
Handover files older than 24 hours are cleaned up on the next use.

**Settings reference:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.outlook.owaUrl` | `https://outlook.office.com` | OWA base URL used when generating the userscript |
| `ticketSidekick.email.handoverFolder` | `~/Downloads/TicketSidekick/` | Folder VS Code reads email files from |
| `ticketSidekick.email.cleanupModel` | `gpt-4o-mini` | VS Code LM model family for footer removal |

**Troubleshooting:**

- _VS Code says "timed out waiting for email.json"_ — the handover folder path in VS Code
  settings doesn't match where Edge saves downloads. Check `ticketSidekick.email.handoverFolder`.
- _Button doesn't appear in OWA_ — the userscript `@match` URL may not cover your OWA
  address. Re-export the script after correcting `ticketSidekick.outlook.owaUrl`.
- _OWA DOM changed after a Microsoft update_ — re-export and reinstall the userscript.
````

- [ ] **Step 3: Run final compilation and test suite**

Run: `npm run compile && npm test`
Expected: No TypeScript errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add OWA bridge setup guide and settings reference to README"
```

---

## Verification

After all tasks:

1. `npm test` — all existing + new tests pass (handoverFolder.test.ts, owaUserscript.test.ts, htmlToMarkdown.test.ts, markdownToJiraWiki.test.ts)
2. `npm run compile` — no TypeScript errors
3. Manual fixture test: copy `src/test/fixtures/email-handover/test-session-1/` to `~/Downloads/TicketSidekick/test-session-1/`, then open `vscode://RobertBreunung.ticket-sidekick/from-email?folder=test-session-1` in the browser address bar → chat panel opens with `@jira create from email` → preview appears
4. Reply "post it" → Jira ticket created, `email-image-1.png` appears as thumbnail in description, `report.pdf` uploaded as attachment, temp files in `~/Downloads/TicketSidekick/test-session-1/` deleted
5. Trigger URI with a folder that doesn't exist → error message shows expected path
6. Command Palette → "Ticket Sidekick: Export OWA Userscript for Tampermonkey" → new JS document opens with the Tampermonkey script, `@match` includes the configured owaUrl
