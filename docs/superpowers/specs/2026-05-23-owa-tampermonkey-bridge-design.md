# OWA → Jira: Tampermonkey + Handover Folder Bridge

## Context

Microsoft Graph API Mail.Read is blocked by the corporate IT tenant. The existing email-to-ticket flow in `emailHandler.ts` is complete but unreachable. This feature replaces the Graph API call with a local bridge: a generated Tampermonkey userscript saves all email data (body, inline images, attachments) into a shared **handover folder** on disk, then pings VS Code via a short `vscode://` URI. VS Code reads the folder, converts the email, and kicks off the existing preview/confirm/create flow.

**No clipboard payload. No open ports. No IT involvement. Full fixture-based automated testing.**

---

## Handover folder contract

Each button click creates its own **subfolder** named after the epoch timestamp. Files inside use clean original names — no prefix needed, no cross-email collision possible.

```
~/Downloads/TicketSidekick/        ← handoverFolder (configurable)
  1716459123456/                   ← subfolder per click (epoch ms)
    email.json                     ← manifest (written last)
    email-body.html
    email-image-1.png              ← inline images, simple indexed names
    email-image-2.jpg
    report.pdf                     ← original attachment filenames
    Project Specification.docx
  1716459200000/                   ← next click, completely isolated
    email.json
    summary.pdf
```

`GM_download` on Chromium-based browsers (Edge) supports subdirectory `name` values: `name: 'TicketSidekick/1716459123456/report.pdf'` creates the subfolder hierarchy under the browser's downloads directory automatically.

The `vscode://` URI carries just the subfolder name: `?folder=1716459123456`. VS Code polls for `{handoverFolder}/1716459123456/email.json` (up to 15 s), reads all referenced files, then after ticket creation **deletes the entire subfolder** (`fs.rmSync(subfolderPath, { recursive: true })`).

**Stale folder cleanup:** on each `processHandoverEmail` invocation, scan `handoverFolder` and delete subfolders older than 24 h before processing the new one. This gives enough time to gather debug data if something went wrong.

---

## Manifest JSON schema (`email.json`)

```typescript
interface HandoverManifest {
  subject: string;
  senderName: string;
  receivedDateTime: string;         // ISO 8601
  bodyFile: string;                 // "email-body.html"
  stripFooter: boolean;
  inlineImages: Array<{
    filename: string;               // "email-image-1.png", "email-image-2.jpg", …
    contentType: string;
  }>;
  attachments: Array<{
    filename: string;               // original name: "report.pdf", "spec.docx", …
    contentType: string;
  }>;
}
```

The HTML body lives in a separate file (blob download handles large content reliably; avoids `encodeURIComponent` size limits in data URIs). All filenames are simple — collision-free by virtue of the subfolder.

---

## Inline image positioning in Jira description

**Tampermonkey** — for each `<img>` in the email body:
1. Assign filename `email-image-N.{ext}` (simple index, no prefix — subfolder provides isolation)
2. Fetch bytes (blob URL or via `GM_xmlhttpRequest`)
3. Download: `GM_download({ url: blobUrl, name: 'TicketSidekick/' + folder + '/email-image-N.png' })`
4. Replace `<img src="...">` in the body HTML with `<img data-ts-filename="email-image-N.png">`
5. Add to `inlineImages[]` in manifest

**`src/utils/htmlToMarkdown.ts`** — update `<img>` handling:
- `<img data-ts-filename="X">` → `![X](X)` (markdown image; filename is both alt and URL)
- Existing `<img src="cid:...">` path unchanged

**`markdownToJiraWiki()`** — add image rule:
- `![alt](name.ext)` where URL has no protocol → `!name.ext|thumbnail!`

**Result in Jira ticket:** `!email-image-1.png|thumbnail!` appears inline at the right position. After attachment upload Jira resolves it to a clickable thumbnail.

---

## Data flow

```
OWA reading pane (browser, Tampermonkey active)
  ↓ click "📋 To Ticket" or "📋✨ To Ticket (Clean)"

const folder = Date.now().toString()   // e.g. "1716459123456"
const base = 'TicketSidekick/' + folder + '/'

1. Extract: subject, senderName, receivedDateTime from DOM
2. Extract HTML body from reading pane

For each inline image (index N):
  fetch bytes (blob URL) → GM_download(blobUrl, base + 'email-image-N.png')
  replace <img> in body with <img data-ts-filename="email-image-N.png">

For each file attachment:
  GM_download(owaAttachUrl, base + originalFilename)

Save body HTML:
  new Blob([bodyHtml]) → GM_download(blobDataUri, base + 'email-body.html')

Save manifest (LAST):
  new Blob([JSON.stringify(manifest)]) → GM_download(manifestDataUri, base + 'email.json')

setTimeout(1500ms) → navigate to:
  vscode://RobertBreunung.ticket-sidekick/from-email?folder=1716459123456

// Note: window.location.href = 'vscode://...' hands off to the OS and does NOT
// navigate away from the OWA page — downloads continue uninterrupted.
// The 1500ms delay is a soft head-start buffer so at least the first files
// are on disk before VS Code starts its 15s polling window. It is NOT
// "wait for all downloads to complete" — the 15s poll handles that.

  ↓
VS Code URI handler → ticket-sidekick.processHandoverEmail(folder) command

Purge subfolders in handoverFolder older than 24 h
Poll {handoverFolder}/{folder}/email.json (up to 15 s)
  ↓
Read manifest → read email-body.html from same subfolder
Poll for all listed image + attachment files (up to 15 s)
  ↓
htmlToMarkdown(bodyHtml) → markdownBody with ![name](name) for inline images
if stripFooter → LLM cleanup call (ticketSidekick.email.cleanupModel)
  ↓
Build HandoverEmail → store in workspaceState('jira.handover.email')
  ↓
vscode.commands.executeCommand('workbench.action.chat.open',
  { query: '@jira create from email' })

  ↓
JiraParticipant: createFromEmail intent
emailHandler.handleCreateFromEmail():
  check workspaceState('jira.handover.email') → found → skip Graph API folder picker
  build EmailContentSession
  streamEmailPreview(session, stream)    [existing helper]
  show attachment names in preview

User: "post it"
  ↓
ticketService.createTicket(...)          Jira ticket created → get issue key
jiraApiClient.uploadAttachment(key, ...) for each inline image + file attachment
fs.rmSync({handoverFolder}/{folder}, { recursive: true })
stream: "PROJ-123 created. N attachment(s) uploaded."
```

---

## Architecture

### New type in `src/participant/sessionState.ts`

```typescript
export interface HandoverEmail {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  markdownBody: string;              // inline images as ![name](name)
  stripFooter: boolean;             // whether LLM footer cleanup was requested
  handoverFolder: string;           // absolute path — needed for cleanup after upload
  subfolder: string;                // e.g. "1716459123456" — needed for cleanup
  attachments: Array<{
    name: string;                   // clean filename: "email-image-1.png" or "report.pdf"
    contentType: string;
    filePath: string;               // absolute path = handoverFolder/subfolder/name
    isInline: boolean;              // true → referenced as !name|thumbnail! in description
  }>;
}
```

workspaceState key: `jira.handover.email` (cleared immediately after use)

### New util: `src/utils/handoverFolder.ts`

Pure functions — no VS Code API dependency, fully unit-testable with real fixture files:

```typescript
export async function readHandoverEmail(
  handoverFolder: string,
  subfolder: string,        // e.g. "1716459123456"
): Promise<HandoverEmail>
// Returns HandoverEmail with handoverFolder + subfolder populated for later cleanup.
// Reads manifest, reads body HTML, calls htmlToMarkdown(), resolves absolute filePaths.

export async function deleteHandoverSubfolder(
  handoverFolder: string,
  subfolder: string,
): Promise<void>
// fs.rmSync(path.join(handoverFolder, subfolder), { recursive: true, force: true })

export async function purgeStaleSubfolders(
  handoverFolder: string,
  maxAgeMs: number,         // default 24 * 60 * 60 * 1000
): Promise<void>
// Reads dirents of handoverFolder; deletes any subfolder whose mtime is older than maxAgeMs.
// Skips non-directory entries and entries that fail stat (already deleted, race-safe).
```

### New util: `src/utils/owaUserscript.ts`

```typescript
export function generateOwaUserscript(config: {
  owaUrl: string;
  vscodeUriBase: string;  // e.g. "vscode://RobertBreunung.ticket-sidekick"
}): string
```

Pure function — no VS Code dependency, fully unit-testable. Returns complete Tampermonkey script as a string.

Script grants required: `@grant GM_download`, `@grant GM_xmlhttpRequest`

Script behaviour:
1. `MutationObserver` detects email reading pane changes
2. Injects two buttons: "📋 To Ticket" and "📋✨ To Ticket (Clean)"
3. On click: extract DOM data, download all files via `GM_download`, navigate to `vscode://` after 1.5 s

DOM selectors (prefer `aria-*` / `data-testid` over class names):
- Subject: `[data-testid="subject"]` or `h1` in reading pane
- Sender: aria / data attributes in message header
- Date: `<time>` element in header
- Body: main content `div` of reading pane; if in iframe, use `contentDocument.body`
- Attachment list: attachment container elements in reading pane

### New method: `src/jira/IJiraClient.ts` + `JiraApiClient.ts`

```typescript
// IJiraClient.ts
uploadAttachment(issueKey: string, filename: string, contentType: string, data: Buffer): Promise<void>;

// JiraApiClient.ts — POST /rest/api/2/issue/{key}/attachments
// Headers: X-Atlassian-Token: no-check   (required by Jira)
// Body: multipart/form-data with file field "file"
```

Also add to `MockJiraClient` as a no-op.

### Changes to `src/extension.ts`

1. URI handler:
```typescript
vscode.window.registerUriHandler({
  handleUri(uri: vscode.Uri) {
    if (uri.path === '/from-email') {
      const folder = new URLSearchParams(uri.query).get('folder') ?? '';
      vscode.commands.executeCommand('ticket-sidekick.processHandoverEmail', folder);
    }
  }
});
```

2. `ticket-sidekick.processHandoverEmail(subfolder: string)`:
   - Resolve `handoverFolder` from settings (default `~/Downloads/TicketSidekick/`, use `os.homedir()` to expand `~`)
   - `purgeStaleSubfolders(handoverFolder, 24h)`
   - Poll for `{handoverFolder}/{subfolder}/email.json` (up to 15 s, 500 ms interval)
   - Call `readHandoverEmail(handoverFolder, subfolder)`
   - If `email.stripFooter`: LLM cleanup call using model from `ticketSidekick.email.cleanupModel` setting
   - `ws.update('jira.handover.email', email)`
   - `vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' })`
   - Error cases: timeout → `vscode.window.showErrorMessage` with expected path; JSON parse failure → error message

3. `ticket-sidekick.exportOwaUserscript`:
   - Read `ticketSidekick.outlook.owaUrl` from settings
   - `generateOwaUserscript({ owaUrl, vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick' })`
   - Open result in a new VS Code document (language: javascript) for the user to copy

### Changes to `src/participant/jira/emailHandler.ts`

Prepend handover shortcut to `handleCreateFromEmail()`:

```typescript
const handover = ws.get<HandoverEmail>('jira.handover.email');
if (handover) {
  await ws.update('jira.handover.email', undefined);
  const defaultProject = /* read ticketSidekick.jira.defaultProject */;
  if (!defaultProject) { stream.markdown('Set `ticketSidekick.jira.defaultProject` first.'); return; }
  const session: EmailContentSession = {
    emailId: 'handover',
    subject: handover.subject,
    markdownBody: handover.markdownBody,
    inlineImageMap: {},
    attachments: handover.attachments.map(a => ({
      name: a.name, contentType: a.contentType,
      contentBytes: fs.readFileSync(a.filePath).toString('base64'),
      isInline: a.isInline,
    })),
    projectKey: defaultProject,
    issueType: 'Story',
    additionalFields: {},
  };
  await ws.update('jira.session.emailContent', session);
  await streamEmailPreview(session, stream);
  return;
}
// Existing Graph API flow (unchanged) below
```

After ticket creation in `handleEmailContentSession`: upload all attachments via `jiraApiClient.uploadAttachment`, then call `deleteHandoverSubfolder(handover.handoverFolder, handover.subfolder)`. The subfolder path comes from the `HandoverEmail` that was stored in the session.

### Changes to `package.json`

Settings:
- `ticketSidekick.email.handoverFolder` — string, default `""` (resolves to `~/Downloads/TicketSidekick/`), "Root folder where the Tampermonkey script saves email subfolders. Must match the browser's downloads directory + 'TicketSidekick/' unless reconfigured."
- `ticketSidekick.email.cleanupModel` — string, default `"gpt-4o-mini"`, "VS Code LM model family used for AI email footer/signature removal"

Commands:
- `ticket-sidekick.exportOwaUserscript` → "Ticket Sidekick: Export OWA Userscript for Tampermonkey"
- `ticket-sidekick.processHandoverEmail` → internal (triggered by URI handler, not shown in Command Palette)

---

## Files changed

| File | Change |
|---|---|
| `src/utils/owaUserscript.ts` | NEW — generates Tampermonkey script |
| `src/utils/handoverFolder.ts` | NEW — reads handover folder into `HandoverEmail` (pure, testable) |
| `src/utils/htmlToMarkdown.ts` | +`data-ts-filename` → `![name](name)` handling |
| `markdownToJiraWiki` (location TBD — verify during impl; likely inline in `emailHandler.ts` or a utils file) | +`![alt](local.ext)` → `!local.ext\|thumbnail!` rule |
| `src/participant/sessionState.ts` | +`HandoverEmail` interface |
| `src/jira/IJiraClient.ts` | +`uploadAttachment` method |
| `src/jira/JiraApiClient.ts` | +`uploadAttachment` implementation |
| `src/test/mocks/MockJiraClient.ts` | +`uploadAttachment` no-op |
| `src/participant/jira/emailHandler.ts` | +handover shortcut before Graph API flow; +attachment upload + folder cleanup after creation |
| `src/extension.ts` | +URI handler, +2 commands |
| `package.json` | +2 settings, +1 command |
| `src/test/handoverFolder.test.ts` | NEW — full pipeline test using fixture files |
| `src/test/fixtures/email-handover/` | NEW — test fixture folder with manifest + body + images + PDF |
| `src/test/owaUserscript.test.ts` | NEW — script generator output tests |
| `src/test/htmlToMarkdown.test.ts` | +`data-ts-filename` test cases |
| `README.md` | +OWA bridge section (see README section below) |

---

## Automated tests

`src/test/handoverFolder.test.ts` exercises the **full pipeline** with real fixture files — no browser, no VS Code, no Tampermonkey:

```typescript
import { readHandoverEmail } from '../utils/handoverFolder';
import * as path from 'path';

const FIXTURES = path.join(__dirname, 'fixtures', 'email-handover');

describe('readHandoverEmail', () => {
  it('parses subject, sender, date', async () => { ... });
  it('converts HTML body to markdown', async () => { ... });
  it('positions inline images as ![name](name) in markdownBody', async () => { ... });
  it('lists file attachments with absolute filePaths', async () => { ... });
  it('returns isInline:true for images, isInline:false for attachments', async () => { ... });
  it('throws when manifest file not found', async () => { ... });
  it('throws when referenced body file missing', async () => { ... });
});
```

Fixture files committed to the repo — subfolder structure matches production layout exactly:
```
src/test/fixtures/email-handover/
  test-session-1/
    email.json              ← HandoverManifest with known values
    email-body.html         ← HTML with one inline image marker
    email-image-1.png       ← 1×1 transparent PNG (minimal binary)
    report.pdf              ← minimal valid PDF
```

---

## Tampermonkey setup (user-facing)

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Edge (recommended — `GM_download` subdirectory support confirmed on Chromium). Safari's Tampermonkey port may not support subdirectory `name` values; verify before use.
2. Optionally set `ticketSidekick.email.handoverFolder` if your Edge downloads folder differs from `~/Downloads/`
3. Command Palette → **Ticket Sidekick: Export OWA Userscript for Tampermonkey**
4. Copy the script → Tampermonkey → New Script → paste → Save
5. Open OWA — "📋 To Ticket" / "📋✨ To Ticket (Clean)" buttons appear in the email reading pane
6. Click → files appear in handover folder → VS Code focuses → preview appears

---

## Verification

1. `npm test` — all existing tests + new tests pass
2. `npm run compile` — no TypeScript errors
3. Copy `src/test/fixtures/email-handover/test-session-1/` to `~/Downloads/TicketSidekick/test-session-1/`, then open `vscode://RobertBreunung.ticket-sidekick/from-email?folder=test-session-1` in the browser address bar → preview appears in @jira chat
4. Install Tampermonkey script, open OWA email with 1 inline image + 1 PDF → click "📋 To Ticket" → preview shows body with `![...]` image ref + attachment name
5. Reply "post it" → Jira ticket created, image appears as thumbnail in description, PDF listed as attachment, temp files deleted
6. Click "📋✨ To Ticket (Clean)" → same but footer stripped
7. Trigger URI with a folder name that doesn't exist → friendly timeout error message with expected path shown

---

## README section

Add a **Create ticket from Outlook email — OWA bridge (Tampermonkey)** subsection inside `## @jira — Jira`, directly after the existing "Create ticket from Outlook email" section that covers the Graph API flow. Content:

```markdown
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
```

---

## Known risks

- **`GM_download` path**: Tampermonkey uses `name: 'TicketSidekick/{folder}/filename'` which lands under the browser's configured downloads directory. If the user moved their downloads folder away from `~/Downloads/`, they must update `ticketSidekick.email.handoverFolder` to match. Mismatch → timeout with expected path shown in error.
- **OWA DOM selectors**: Microsoft can rename elements. Mitigated by preferring `aria-*` / `data-testid`. Re-exporting the userscript is the recovery path.
- **OWA body in iframe**: Some OWA versions sandbox the email body in a same-origin iframe. Script checks `contentDocument.body` as fallback.
- **`GM_download` timing**: All files download in parallel; manifest is triggered last with a 1.5 s delay. VS Code polls up to 15 s. For very slow connections this window may need extending (add `ticketSidekick.email.handoverTimeoutSeconds` setting if needed).
- **Safari `GM_download` subdirectories**: Unconfirmed. Edge is the recommended browser for this feature.
