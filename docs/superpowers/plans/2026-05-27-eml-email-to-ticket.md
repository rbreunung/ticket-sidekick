# EML Email-to-Ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tampermonkey/Graph-API email bridge with a simple `.eml` file import that parses RFC 2822 emails into Jira tickets via the existing preview/confirm/create flow.

**Architecture:** A new `parseEml()` util wraps `postal-mime` to extract subject, sender, date, HTML/plain body, inline images, and attachments from a Buffer. A VS Code command (`ticket-sidekick.importEml`) shows a file picker, calls `parseEml`, builds an `EmailContentSession`, stores it in `workspaceState`, then opens `@jira create from email` in chat. The lean chat handler reads the pre-built session and streams the preview — reusing all existing confirm/create logic.

**Tech Stack:** TypeScript, `postal-mime` (RFC 2822 parser), VS Code Extension API, Vitest (unit tests)

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/utils/emlParser.ts` | CREATE | Pure `parseEml(Buffer)` wrapping postal-mime |
| `src/test/fixtures/eml/sample.eml` | CREATE | RFC 2822 fixture: HTML body + inline image + PDF attachment |
| `src/test/emlParser.test.ts` | CREATE | Unit tests (TDD) for parseEml |
| `src/utils/owaUserscript.ts` | DELETE | Tampermonkey generator — obsolete |
| `src/utils/handoverFolder.ts` | DELETE | Handover folder reader — obsolete |
| `src/outlook/IOutlookClient.ts` | DELETE | Outlook types/interface — obsolete |
| `src/outlook/OutlookApiClient.ts` | DELETE | Graph API client — obsolete |
| `src/outlook/tokenProviders.ts` | DELETE | Token providers — obsolete |
| `src/services/OutlookService.ts` | DELETE | Outlook business logic — obsolete |
| `src/test/owaUserscript.test.ts` | DELETE | Tests for deleted module |
| `src/test/handoverFolder.test.ts` | DELETE | Tests for deleted module |
| `src/test/fixtures/email-handover/` | DELETE | Old fixture directory |
| `src/participant/sessionState.ts` | MODIFY | Add `emlFilePath?`, `senderName?`, `receivedDateTime?` to `EmailContentSession`; remove `HandoverEmail`, `FolderSelectionSession`, `EmailSelectionSession`, `handoverCleanup` |
| `src/services/ConfigService.ts` | MODIFY | Remove 5 Outlook methods |
| `src/participant/jira/emailHandler.ts` | REWRITE | Lean `handleCreateFromEmail`; updated `finishEmailTicket` (clickable link, emlFilePath delete, no OWA regex); updated preview header |
| `src/participant/JiraParticipant.ts` | MODIFY | Remove folder/email-selection session detection blocks and their imports |
| `src/extension.ts` | MODIFY | Remove URI handler + 3 old commands; add `importEml` command |
| `package.json` | MODIFY | Remove outlook/handover settings + 2 commands; add `importEml` command + `deleteEmlAfterImport` setting |
| `src/participant/jira/loadHandler.ts` | MODIFY | Clickable `[KEY](baseUrl/browse/KEY)` in ticket heading |
| `CLAUDE.md` | MODIFY | Update key files table, session state table, settings section |
| `README.md` | MODIFY | Replace OWA bridge section with EML import instructions |

---

## Task 1: Install postal-mime

**Files:**
- Modify: `package.json` (dependency added by npm)

- [ ] **Step 1: Install postal-mime**

```bash
npm install postal-mime
```

Expected: `postal-mime` appears in `package.json` `dependencies` section.

- [ ] **Step 2: Verify types ship with the package (no @types needed)**

```bash
ls node_modules/postal-mime/src/*.d.ts 2>/dev/null || ls node_modules/postal-mime/*.d.ts
```

Expected: `postal-mime.d.ts` found — no `@types/postal-mime` needed.

- [ ] **Step 3: Verify TypeScript compile is still clean**

```bash
npm run compile
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add postal-mime dependency for EML parsing"
```

---

## Task 2: EML parser with TDD

**Files:**
- Create: `src/test/fixtures/eml/sample.eml`
- Create: `src/test/emlParser.test.ts`
- Create: `src/utils/emlParser.ts`

- [ ] **Step 1: Create the EML fixture directory and sample.eml**

Create `src/test/fixtures/eml/sample.eml` with this exact content (a multipart RFC 2822 email with HTML body, one inline PNG, and one PDF attachment):

```
From: Jane Doe <jane.doe@example.com>
To: test@example.com
Subject: Test Email Subject
Date: Thu, 22 May 2026 15:22:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed_boundary_001"

--mixed_boundary_001
Content-Type: multipart/related; boundary="related_boundary_001"

--related_boundary_001
Content-Type: text/html; charset=utf-8

<html><body><p>Hello <strong>World</strong></p><p>See: <img src="cid:image001@test.com"></p></body></html>

--related_boundary_001
Content-Type: image/png
Content-ID: <image001@test.com>
Content-Disposition: inline; filename="email-image-1.png"
Content-Transfer-Encoding: base64

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=

--related_boundary_001--

--mixed_boundary_001
Content-Type: application/pdf
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjAKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBv
YmoKPDwvVHlwZS9QYWdlcy9LaWRzWzMgMCBSXS9Db3VudCAxPj5lbmRvYmoKMyAwIG9iajw8L1R5
cGUvUGFnZS9NZWRpYUJveFswIDAgMyAzXT4+ZW5kb2JqCnhyZWYKMCA0CjAwMDAwMDAwMDAgNjU1
MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUg
MDAwMDAgbiAKdHJhaWxlcjw8L1NpemUgNC9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjE5MAolJUVP
Rg==

--mixed_boundary_001--
```

- [ ] **Step 2: Write the failing test file**

Create `src/test/emlParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseEml } from '../utils/emlParser';

const FIXTURE = path.resolve(process.cwd(), 'src/test/fixtures/eml/sample.eml');

describe('parseEml — fixture: sample.eml', () => {
  it('parses subject from headers', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.subject).toBe('Test Email Subject');
  });

  it('parses sender name from From header', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.senderName).toBe('Jane Doe');
  });

  it('parses date as ISO 8601 string', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.receivedDateTime).toBe('2026-05-22T15:22:00.000Z');
  });

  it('returns htmlBody from HTML part', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.htmlBody).toContain('Hello');
    expect(result.htmlBody).toContain('<strong>World</strong>');
  });

  it('maps contentId to filename in inlineImageMap', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.inlineImageMap.get('image001@test.com')).toBe('email-image-1.png');
  });

  it('marks inline image attachment with isInline true', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    const img = result.attachments.find(a => a.name === 'email-image-1.png');
    expect(img).toBeDefined();
    expect(img!.isInline).toBe(true);
  });

  it('marks file attachment with isInline false', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    const pdf = result.attachments.find(a => a.name === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf!.isInline).toBe(false);
  });

  it('returns valid base64 for all attachment contentBytes', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    for (const att of result.attachments) {
      expect(att.contentBytes).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
  });
});

describe('parseEml — edge cases', () => {
  it('defaults subject to "(no subject)" when Subject header absent', async () => {
    const eml = Buffer.from('From: t@t.com\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    expect(result.subject).toBe('(no subject)');
  });

  it('defaults senderName to "Unknown" when From header absent', async () => {
    const eml = Buffer.from('Subject: Hi\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    expect(result.senderName).toBe('Unknown');
  });

  it('uses current time when Date header absent', async () => {
    const before = Date.now();
    const eml = Buffer.from('Subject: Hi\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    const after = Date.now();
    const parsed = new Date(result.receivedDateTime).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 50);
  });

  it('handles plain-text-only email — htmlBody undefined, plainBody set', async () => {
    const eml = Buffer.from('Subject: Plain\r\nContent-Type: text/plain\r\n\r\nJust plain text');
    const result = await parseEml(eml);
    expect(result.htmlBody).toBeUndefined();
    expect(result.plainBody).toBe('Just plain text');
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail (emlParser.ts does not exist yet)**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|emlParser)"
```

Expected: Tests fail with "Cannot find module '../utils/emlParser'".

- [ ] **Step 4: Create `src/utils/emlParser.ts`**

```typescript
import PostalMime from 'postal-mime';

export interface ParsedEml {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  htmlBody: string | undefined;
  plainBody: string | undefined;
  inlineImageMap: Map<string, string>;
  attachments: Array<{
    name: string;
    contentType: string;
    contentBytes: string;
    isInline: boolean;
  }>;
}

export async function parseEml(buffer: Buffer): Promise<ParsedEml> {
  const email = await new PostalMime().parse(buffer);

  const subject = email.subject ?? '(no subject)';
  const senderName = email.from?.name || email.from?.address || 'Unknown';
  const receivedDateTime = email.date
    ? new Date(email.date).toISOString()
    : new Date().toISOString();
  const htmlBody = email.html || undefined;
  const plainBody = email.text || undefined;

  const inlineImageMap = new Map<string, string>();
  const attachments: ParsedEml['attachments'] = [];

  for (const att of email.attachments ?? []) {
    const isInline = att.disposition === 'inline';
    const name = att.filename ?? att.mimeType.replace('/', '-');
    const contentBytes = Buffer.from(att.content).toString('base64');

    if (isInline && att.contentId) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      inlineImageMap.set(cid, name);
    }

    attachments.push({
      name,
      contentType: att.mimeType ?? 'application/octet-stream',
      contentBytes,
      isInline,
    });
  }

  return { subject, senderName, receivedDateTime, htmlBody, plainBody, inlineImageMap, attachments };
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm test -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|✓|✗|emlParser)"
```

Expected: All emlParser tests PASS.

- [ ] **Step 6: Run compile to verify TypeScript is clean**

```bash
npm run compile
```

Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/emlParser.ts src/test/emlParser.test.ts src/test/fixtures/eml/sample.eml
git commit -m "feat: add EML parser (postal-mime) with unit tests"
```

---

## Task 3: Remove old email infrastructure

This task replaces the entire OWA/Tampermonkey/Graph-API email stack in one atomic commit. All files must be updated together because the imports form a dependency cycle. By the end of this task `npm run compile && npm test` must both pass.

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/services/ConfigService.ts`
- Rewrite: `src/participant/jira/emailHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`
- Delete: `src/utils/owaUserscript.ts`
- Delete: `src/utils/handoverFolder.ts`
- Delete: `src/outlook/IOutlookClient.ts`
- Delete: `src/outlook/OutlookApiClient.ts`
- Delete: `src/outlook/tokenProviders.ts`
- Delete: `src/services/OutlookService.ts`
- Delete: `src/test/owaUserscript.test.ts`
- Delete: `src/test/handoverFolder.test.ts`
- Delete: `src/test/fixtures/email-handover/` (directory)

- [ ] **Step 1: Update `src/participant/sessionState.ts`**

a) Remove the `HandoverEmail` interface (lines 88–102) — delete the entire block:
```typescript
export interface HandoverEmail {
  ...
}
```

b) Remove the `FolderSelectionSession` interface (lines 104–106):
```typescript
export interface FolderSelectionSession {
  folders: Array<{ id: string; displayName: string; unreadItemCount: number }>;
}
```

c) Remove the `EmailSelectionSession` interface (lines 108–111):
```typescript
export interface EmailSelectionSession {
  folderId: string;
  emails: Array<{ id: string; subject: string; receivedDateTime: string; senderName: string }>;
}
```

d) Replace the `EmailContentSession` interface (lines 113–129) with this updated version that removes `handoverCleanup` and adds `emlFilePath?`, `senderName?`, `receivedDateTime?`:

```typescript
export interface EmailContentSession {
  emailId: string;
  subject: string;
  senderName?: string;
  receivedDateTime?: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  emlFilePath?: string;
  selectedTemplateName: string | null;
  projectKey: string;
  issueType: string;
  additionalFields: Record<string, unknown>;
  availableTemplates?: Array<{ name: string; issueType: string }>;
  availableIssueTypes?: string[];
}
```

- [ ] **Step 2: Update `src/services/ConfigService.ts`**

Remove the private constant `OUTLOOK_TOKEN_KEY` (line 19) and all five Outlook methods. The entire file after changes:

```typescript
import * as vscode from 'vscode';
import type { BitbucketAuthType, BitbucketConfig } from '../bitbucket/IBitbucketClient';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  showConnectionInfo: boolean;
  requiredFields: string[];
  additionalDisplayFields: string[];
  hiddenDisplayFields: string[];
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'ticket-sidekick.token';
  private static readonly BITBUCKET_TOKEN_KEY = 'ticket-sidekick.bitbucket.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('jira.baseUrl'),
      authType: config.get<AuthType>('jira.authType') ?? 'datacenter',
      showConnectionInfo: config.get<boolean>('jira.showConnectionInfo') ?? false,
      requiredFields: config.get<string[]>('jira.requiredFields') ?? [],
      additionalDisplayFields: config.get<string[]>('jira.additionalDisplayFields') ?? [],
      hiddenDisplayFields: config.get<string[]>('jira.hiddenDisplayFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
    };
  }

  async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.TOKEN_KEY, token);
  }

  async getBitbucketConfig(): Promise<BitbucketConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('bitbucket.baseUrl'),
      authType: config.get<BitbucketAuthType>('bitbucket.authType') ?? 'datacenter',
      token: await this.context.secrets.get(ConfigService.BITBUCKET_TOKEN_KEY),
      showConnectionInfo: config.get<boolean>('bitbucket.showConnectionInfo') ?? false,
      reviewInstructions: config.get<string>('bitbucket.reviewInstructions') || undefined,
    };
  }

  async storeBitbucketToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.BITBUCKET_TOKEN_KEY, token);
  }
}
```

- [ ] **Step 3: Rewrite `src/participant/jira/emailHandler.ts`**

Replace the entire file with this content:

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import type { TicketService } from '../../services/TicketService';
import type { ConfigService } from '../../services/ConfigService';
import type { IJiraClient } from '../../jira/IJiraClient';
import { markdownToJiraWiki } from '../../utils/markdownToJiraWiki';
import { TemplateService } from '../../templates/TemplateService';
import { FieldResolver } from '../../templates/FieldResolver';
import type { EmailContentSession } from '../sessionState';
import { isCancellation, isConfirmation, pickEmailOption } from '../sessionState';

export async function handleCreateFromEmail(
  _request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  _token: vscode.CancellationToken,
  _jiraClient: IJiraClient,
  _ticketService: TicketService,
  _configService: ConfigService,
  ws: vscode.Memento,
): Promise<void> {
  const session = ws.get<EmailContentSession>('jira.session.emailContent');
  if (!session) {
    stream.markdown(
      'No email loaded. Use **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)** to import an email first.',
    );
    return;
  }
  await streamEmailContentPreview(session, stream, ws);
}

export async function handleEmailContentSession(
  reply: string,
  session: EmailContentSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  jiraClient: IJiraClient,
): Promise<void> {
  if (isCancellation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    stream.markdown('_Cancelled._');
    return;
  }

  const n = parseInt(reply.trim(), 10);
  const pick = isNaN(n) ? null : pickEmailOption(n, session.availableTemplates ?? [], session.availableIssueTypes ?? []);
  if (pick) {
    await ws.update('jira.session.emailContent', undefined);
    let additionalFields = session.additionalFields;
    if (pick.kind === 'template') {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      if (workspaceRoot) {
        try {
          const { templates } = new TemplateService(workspaceRoot).loadTemplates();
          const fullTemplate = templates.find(t => t.name === pick.name);
          if (fullTemplate) {
            const resolver = new FieldResolver(jiraClient, session.projectKey);
            const resolved = await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields);
            additionalFields = { ...resolved, ...session.additionalFields };
          }
        } catch { /* proceed without template fields */ }
      }
    }
    const overrides = pick.kind === 'template'
      ? { issueType: pick.issueType, selectedTemplateName: pick.name, additionalFields }
      : { issueType: pick.issueType };
    await finishEmailTicket({ ...session, ...overrides }, ticketService, stream);
    return;
  }

  if (isConfirmation(reply)) {
    await ws.update('jira.session.emailContent', undefined);
    await finishEmailTicket(session, ticketService, stream);
    return;
  }
  stream.markdown(`_Reply with a number, **post it** to create as **${session.issueType}**, or **(c)** to cancel._`);
  await streamEmailContentPreview(session, stream, ws);
}

export async function streamEmailContentPreview(session: EmailContentSession, stream: vscode.ChatResponseStream, ws: vscode.Memento): Promise<void> {
  await ws.update('jira.session.emailContent', session);
  const templates = session.availableTemplates ?? [];
  const issueTypes = session.availableIssueTypes ?? [];
  const hasOptions = templates.length > 0 || issueTypes.length > 0;

  let optionsList = '';
  if (templates.length > 0) {
    optionsList += `**Templates:**\n${templates.map((t, i) => `${i + 1}. ${t.name} _(${t.issueType})_`).join('\n')}\n\n`;
  }
  if (issueTypes.length > 0) {
    const offset = templates.length;
    optionsList += `**Issue types (no template):**\n${issueTypes.map((t, i) => `${offset + i + 1}. ${t}`).join('\n')}\n\n`;
  }

  const prompt = hasOptions
    ? `${optionsList}Reply with a number to select, **post it** to create as **${session.issueType}**, or **(c)** to cancel.`
    : `Reply **post it** to create the Jira ticket in **${session.projectKey}** as **${session.issueType}**, or **(c)** to cancel.`;

  const headerLines: string[] = [];
  if (session.senderName || session.receivedDateTime) {
    const fromPart = session.senderName ? `**From:** ${session.senderName}` : '';
    const datePart = session.receivedDateTime ? `**Date:** ${session.receivedDateTime.slice(0, 10)}` : '';
    if (fromPart && datePart) headerLines.push(`${fromPart} · ${datePart}`);
    else headerLines.push(fromPart || datePart);
  }
  headerLines.push(`**Subject:** ${session.subject}`);
  const nonInlineAttachments = session.attachments.filter(a => !a.isInline);
  if (nonInlineAttachments.length > 0) {
    headerLines.push(`**Attachments:** ${nonInlineAttachments.map(a => a.name).join(', ')}`);
  }

  stream.markdown(
    `${headerLines.join('\n')}\n\n` +
    `**Description preview:**\n\n${session.markdownBody}\n\n` +
    `${prompt}\n\n<!-- jira:email-content -->`,
  );
}

async function finishEmailTicket(session: EmailContentSession, ticketService: TicketService, stream: vscode.ChatResponseStream): Promise<void> {
  let jiraWiki = markdownToJiraWiki(session.markdownBody);
  jiraWiki = jiraWiki.replace(/\[📎 ([^\]]+)\]/g, '!$1|thumbnail!');

  const result = await ticketService.createTicket(
    session.projectKey, session.subject, session.issueType,
    { ...session.additionalFields, description: jiraWiki },
  );

  const keyMatch = result.match(/([A-Z][A-Z0-9]+-\d+)/);
  const issueKey = keyMatch?.[1];
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';
  const linkMsg = issueKey && baseUrl
    ? `Ticket **[${issueKey}](${baseUrl}/browse/${issueKey})** created.`
    : result;
  stream.markdown(linkMsg);

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

  if (issueKey && session.emlFilePath) {
    const deleteAfter = vscode.workspace.getConfiguration('ticketSidekick').get<boolean>('email.deleteEmlAfterImport', false);
    if (deleteAfter) {
      await fs.promises.unlink(session.emlFilePath).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Update `src/participant/JiraParticipant.ts`**

a) Update the emailHandler import (line 24) — remove `handleFolderSelection` and `handleEmailSelection`:

Old:
```typescript
import {
  handleCreateFromEmail, handleFolderSelection, handleEmailSelection, handleEmailContentSession,
} from './jira/emailHandler';
import type { FolderSelectionSession, EmailSelectionSession, EmailContentSession } from './sessionState';
```

New:
```typescript
import {
  handleCreateFromEmail, handleEmailContentSession,
} from './jira/emailHandler';
import type { EmailContentSession } from './sessionState';
```

b) Remove the folder-selection session block (find by the comment `// Folder selection`):
```typescript
// Folder selection — user replied with their folder choice for email import
if (lastResponse.includes('<!-- jira:folder-selection -->')) {
  const folderSession = ws.get<FolderSelectionSession>('jira.session.folderSelection');
  if (folderSession) {
    await handleFolderSelection(request.prompt, folderSession, configService, stream, ws);
    return;
  }
}
```

c) Remove the email-selection session block (find by the comment `// Email selection`):
```typescript
// Email selection — user replied with their email choice for ticket creation
if (lastResponse.includes('<!-- jira:email-selection -->')) {
  const emailSession = ws.get<EmailSelectionSession>('jira.session.emailSelection');
  if (emailSession) {
    await handleEmailSelection(request.prompt, emailSession, stream, configService, ws, jiraClient);
    return;
  }
}
```

- [ ] **Step 5: Delete the obsolete source files**

```bash
rm src/utils/owaUserscript.ts
rm src/utils/handoverFolder.ts
rm src/outlook/IOutlookClient.ts
rm src/outlook/OutlookApiClient.ts
rm src/outlook/tokenProviders.ts
rm src/services/OutlookService.ts
rm src/test/owaUserscript.test.ts
rm src/test/handoverFolder.test.ts
rm -rf src/test/fixtures/email-handover/
```

- [ ] **Step 6: Verify compile is clean**

```bash
npm run compile
```

Expected: No TypeScript errors. If errors appear, check for any remaining imports that reference the deleted files.

- [ ] **Step 7: Verify all tests pass**

```bash
npm test
```

Expected: All tests pass. The deleted test files no longer appear. emlParser tests still pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: remove OWA/Tampermonkey/Graph-API email stack; replace with lean EML session handler"
```

---

## Task 4: Add importEml VS Code command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Rewrite `src/extension.ts`**

Replace the entire file content with the following (key changes: remove URI handler + 3 old commands + their imports; add `importEml` command using `parseEml` + `JiraApiClient` + `TemplateService`):

```typescript
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from './services/ConfigService';
import { createJiraParticipant } from './participant/JiraParticipant';
import { createBitbucketParticipant } from './participant/BitbucketParticipant';
import { parseEml, type ParsedEml } from './utils/emlParser';
import { htmlToMarkdown } from './utils/htmlToMarkdown';
import { JiraApiClient } from './jira/JiraApiClient';
import { TemplateService } from './templates/TemplateService';
import type { EmailContentSession } from './participant/sessionState';

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('ticket-sidekick.setDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Personal Access Token saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureCloud', async () => {
      const email = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian account email',
        ignoreFocusOut: true,
      });
      if (!email) return;
      const apiToken = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian API token (from id.atlassian.com)',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiToken) {
        const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
        await configService.storeToken(encoded);
        vscode.window.showInformationMessage('Ticket Sidekick: Cloud credentials saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.setBitbucketDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeBitbucketToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Bitbucket PAT saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureBitbucketCloud', async () => {
      const username = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket Cloud username',
        ignoreFocusOut: true,
      });
      if (!username) return;
      const appPassword = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket App Password (bitbucket.org → Personal settings → App passwords)',
        password: true,
        ignoreFocusOut: true,
      });
      if (appPassword) {
        const encoded = Buffer.from(`${username}:${appPassword}`).toString('base64');
        await configService.storeBitbucketToken(encoded);
        vscode.window.showInformationMessage('Ticket Sidekick: Bitbucket Cloud credentials saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.importEml', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Email files': ['eml'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
        title: 'Select email (.eml) to import',
      });
      if (!uris || uris.length === 0) return;
      const emlPath = uris[0].fsPath;

      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(emlPath);
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      let parsed: ParsedEml;
      try {
        parsed = await parseEml(buffer);
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse email: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const config = await configService.getConfig();
      if (!config.baseUrl || !config.token) {
        vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
        return;
      }
      const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
      if (!projectKey) {
        vscode.window.showErrorMessage('Ticket Sidekick: Set ticketSidekick.jira.defaultProject in VS Code settings before importing email.');
        return;
      }

      const jiraClient = new JiraApiClient({ baseUrl: config.baseUrl, authType: config.authType, token: config.token });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const [availableTemplates, issueTypes] = await Promise.all([
        Promise.resolve(workspaceRoot ? (() => {
          try {
            return new TemplateService(workspaceRoot).loadTemplates().templates
              .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
          } catch { return [] as Array<{ name: string; issueType: string }>; }
        })() : [] as Array<{ name: string; issueType: string }>),
        jiraClient.getProject(projectKey)
          .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
          .catch(() => [] as string[]),
      ]);
      const issueType = issueTypes.find(t => t === 'Story') ?? issueTypes.find(t => t === 'Task') ?? issueTypes[0] ?? 'Story';

      const markdownBody = parsed.htmlBody
        ? htmlToMarkdown(parsed.htmlBody, parsed.inlineImageMap)
        : (parsed.plainBody ?? '');

      const inlineImageMap: Record<string, string> = {};
      for (const [k, v] of parsed.inlineImageMap) {
        inlineImageMap[k] = v;
      }

      const session: EmailContentSession = {
        emailId: 'eml-import',
        subject: parsed.subject,
        senderName: parsed.senderName,
        receivedDateTime: parsed.receivedDateTime,
        markdownBody,
        inlineImageMap,
        attachments: parsed.attachments.map(a => ({
          name: a.name,
          contentType: a.contentType,
          contentBytes: a.contentBytes,
          isInline: a.isInline,
        })),
        emlFilePath: emlPath,
        selectedTemplateName: null,
        projectKey,
        issueType,
        additionalFields: {},
        availableTemplates: availableTemplates.length > 0 ? availableTemplates : undefined,
        availableIssueTypes: issueTypes.length > 1 ? issueTypes : undefined,
      };

      await context.workspaceState.update('jira.session.emailContent', session);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' });
    }),
  );

  createJiraParticipant(context, configService);
  createBitbucketParticipant(context, configService);
}

export function deactivate(): void {}
```

- [ ] **Step 2: Update `package.json` — commands section**

a) Remove the two obsolete commands from the `"commands"` array:
- `{ "command": "ticket-sidekick.setOutlookToken", ... }`
- `{ "command": "ticket-sidekick.exportOwaUserscript", ... }`

b) Add the new command (at the end of the commands array):
```json
{
  "command": "ticket-sidekick.importEml",
  "title": "Ticket Sidekick: Create Jira ticket from email (.eml)"
}
```

- [ ] **Step 3: Update `package.json` — configuration section**

a) Remove the entire `"outlook"` configuration block (id: `"outlook"`, all 4 properties: `folderId`, `emailListSize`, `authProvider`, `owaUrl`).

b) Replace the `"email"` configuration block entirely. Old content had `handoverFolder` and `cleanupModel`. New content:

```json
{
  "id": "email",
  "title": "Ticket Sidekick — Email",
  "properties": {
    "ticketSidekick.email.deleteEmlAfterImport": {
      "type": "boolean",
      "default": false,
      "description": "Delete the .eml file automatically after the Jira ticket is created."
    }
  }
}
```

- [ ] **Step 4: Verify compile**

```bash
npm run compile
```

Expected: No TypeScript errors.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: add importEml command — file picker, parse EML, open chat preview"
```

---

## Task 5: Clickable ticket link in loadHandler

**Files:**
- Modify: `src/participant/jira/loadHandler.ts`

- [ ] **Step 1: Update `handleLoadTicket` in `src/participant/jira/loadHandler.ts`**

Find the line (around line 58):
```typescript
  const showParts: string[] = [`## ${issue.key}: ${issue.fields.summary}`];
```

Replace with:
```typescript
  const baseUrl = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl') ?? '';
  const heading = baseUrl
    ? `## [${issue.key}](${baseUrl}/browse/${issue.key}): ${issue.fields.summary}`
    : `## ${issue.key}: ${issue.fields.summary}`;
  const showParts: string[] = [heading];
```

- [ ] **Step 2: Verify compile**

```bash
npm run compile
```

Expected: No TypeScript errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/participant/jira/loadHandler.ts
git commit -m "feat: add clickable Jira ticket link in load command heading"
```

---

## Task 6: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `CLAUDE.md` — Key files table**

a) Remove these rows from the "Key files" table:
- `src/utils/owaUserscript.ts`
- `src/utils/handoverFolder.ts`
- `src/outlook/IOutlookClient.ts`
- `src/outlook/OutlookApiClient.ts`
- `src/services/OutlookService.ts`

b) Add a new row for `emlParser.ts`:
```
| `src/utils/emlParser.ts` | Parses `.eml` files via `postal-mime`; returns `ParsedEml` (subject, sender, date, htmlBody, plainBody, inlineImageMap, attachments) |
```

c) Update the `src/utils/htmlToMarkdown.ts` row — remove the `data-ts-filename` reference since OWA is gone:
```
| `src/utils/htmlToMarkdown.ts` | Converts HTML email body to Markdown; resolves `cid:` references via optional `inlineImageMap`; strips OWA span whitespace inside bold/italic |
```

d) Update the `src/participant/jira/emailHandler.ts` row:
```
| `src/participant/jira/emailHandler.ts` | Email-to-ticket chat flow: reads pre-built `EmailContentSession` from workspaceState → streams preview → confirm/create |
```

- [ ] **Step 2: Update `CLAUDE.md` — VS Code settings section**

Remove the entire "Outlook settings" subsection (all 4 rows: `folderId`, `emailListSize`, `owaUrl`, `handoverFolder`, `cleanupModel`).

Replace with:

```markdown
### Email settings

| Setting | Key |
| --- | --- |
| Delete .eml after import | `ticketSidekick.email.deleteEmlAfterImport` |
```

- [ ] **Step 3: Update `CLAUDE.md` — Multi-turn session state table**

Remove these rows from the "Jira sessions" table:
- `FolderSelectionSession` (key: `jira.session.folderSelection`)
- `EmailSelectionSession` (key: `jira.session.emailSelection`)
- `HandoverEmail (one-shot, not a session)` (key: `jira.handover.email`)

- [ ] **Step 4: Update `CLAUDE.md` — Remove the "OWA Tampermonkey bridge" section**

Remove the entire section starting with `## OWA Tampermonkey bridge` through the end of the file (it's the last major section). This includes:
- Handover folder contract
- Manifest JSON schema
- MANIFEST_VERSION versioning — CRITICAL
- Email-to-ticket flow (OWA path)
- `pickEmailOption` helper subsection (keep the `pickEmailOption` subsection but move it inline under emailHandler in key files if needed — actually `pickEmailOption` is still in sessionState.ts so no change needed there)

Actually keep the `### pickEmailOption helper` subsection since `pickEmailOption` is still in `sessionState.ts` and still used. Remove only the OWA-specific content:
- Handover folder contract
- Manifest JSON schema
- MANIFEST_VERSION versioning — CRITICAL
- Email-to-ticket flow (OWA path)
- OWA attachment limitation

Replace the old OWA section with a new **EML import** section:

```markdown
## EML email import

When Microsoft Graph API Mail.Read is blocked, the user downloads the email from OWA's native "Download message" menu and imports the `.eml` file via the VS Code command.

### Import flow

1. Command Palette → **Ticket Sidekick: Create Jira ticket from email (.eml)**
2. File picker opens (defaults to `~/Downloads`)
3. `parseEml(buffer)` (postal-mime) extracts subject, sender, date, HTML body, inline images, file attachments
4. HTML body → `htmlToMarkdown(html, inlineImageMap)` → `markdownBody` with `[📎 name]` for inline images
5. `EmailContentSession` (with `emlFilePath`, `senderName`, `receivedDateTime`) stored in `workspaceState('jira.session.emailContent')`
6. Chat opened with `@jira create from email`
7. `handleCreateFromEmail` reads session from workspaceState → `streamEmailContentPreview`
8. User picks template/type or confirms → `finishEmailTicket` creates ticket + uploads attachments
9. If `ticketSidekick.email.deleteEmlAfterImport: true` → `.eml` file deleted after successful creation (non-fatal)

### `pickEmailOption` helper

`pickEmailOption(n, templates, issueTypes)` in `sessionState.ts` maps a 1-based user reply index to a template or issue type pick. Templates occupy indices 1..N, issue types N+1..N+M. Returns `{ kind: 'template', name, issueType }` or `{ kind: 'type', issueType }` or `null` if out of range.
```

- [ ] **Step 5: Update `README.md`**

Find the section that describes the OWA Tampermonkey bridge / Outlook email flow (the section under `## @jira — Jira` about creating tickets from email using Tampermonkey or Graph API).

Replace it with:

```markdown
### Create Jira ticket from email (.eml)

Download the email from OWA using **More actions → Download message** to save a `.eml` file, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)**
2. Select the `.eml` file from your Downloads folder
3. A preview appears in the `@jira` chat with subject, sender, date, body, and attachments
4. Reply with a template number, an issue type number, or **post it** to create the ticket

Inline images are uploaded as Jira attachments and embedded as thumbnails at their position in the description. File attachments are uploaded to the ticket.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.email.deleteEmlAfterImport` | `false` | Delete the `.eml` file automatically after the ticket is created |
| `ticketSidekick.jira.defaultProject` | — | Project key used when creating tickets |
```

- [ ] **Step 6: Verify compile + tests still pass**

```bash
npm run compile && npm test
```

Expected: No errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and README.md for EML email-to-ticket flow"
```

---

## Verification Checklist

After all tasks are complete, verify the full spec against the implementation:

- [ ] `npm run compile` — no TypeScript errors
- [ ] `npm test` — all tests green; `emlParser.test.ts` covers fixture + edge cases
- [ ] `src/utils/owaUserscript.ts` does not exist
- [ ] `src/utils/handoverFolder.ts` does not exist
- [ ] `src/outlook/` directory has been deleted
- [ ] `src/services/OutlookService.ts` does not exist
- [ ] `src/test/owaUserscript.test.ts` does not exist
- [ ] `src/test/handoverFolder.test.ts` does not exist
- [ ] `src/test/fixtures/email-handover/` does not exist
- [ ] `package.json` has no `outlook.*` settings
- [ ] `package.json` `commands` contains `ticket-sidekick.importEml` and does NOT contain `setOutlookToken` or `exportOwaUserscript`
- [ ] `EmailContentSession` in `sessionState.ts` has `emlFilePath?`, `senderName?`, `receivedDateTime?` and does NOT have `handoverCleanup`
- [ ] `ConfigService.ts` has no Outlook methods
- [ ] `JiraParticipant.ts` does NOT import `handleFolderSelection`, `handleEmailSelection`, `FolderSelectionSession`, or `EmailSelectionSession`
