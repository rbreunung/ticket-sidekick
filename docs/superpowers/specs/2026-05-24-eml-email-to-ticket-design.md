# EML Email-to-Ticket Design

## Context

Microsoft Graph API Mail.Read is blocked by the corporate IT tenant. Previous attempts
to bridge email into Jira via Tampermonkey DOM scraping and a local handover folder were
abandoned: attachment download URLs require authenticated EWS IDs not present in the OWA
DOM, making a reliable implementation infeasible without heavy reverse engineering.

The replacement: the user downloads the email as a standard `.eml` file from OWA's native
"Download message" menu item, then imports it into the VS Code extension via a file picker.
The `.eml` format (RFC 2822 / MIME) is a stable, well-documented standard that includes
the full email body, inline images, and all file attachments.

---

## What Gets Removed

| Artifact | Location |
|---|---|
| Tampermonkey userscript generator | `src/utils/owaUserscript.ts` + tests |
| Handover folder reader | `src/utils/handoverFolder.ts` + tests |
| EML fixture folder | `src/test/fixtures/email-handover/` |
| URI handler (`vscode://…/from-email`) | `src/extension.ts` |
| `ticket-sidekick.processHandoverEmail` command | `src/extension.ts` |
| `ticket-sidekick.exportOwaUserscript` command | `src/extension.ts` |
| `ticket-sidekick.setOutlookToken` command | `src/extension.ts` |
| Graph API email flow (folder picker, email selection) | `src/participant/jira/emailHandler.ts` |
| `OutlookService`, `OutlookApiClient`, `IOutlookClient` | `src/services/`, `src/outlook/` |
| `HandoverEmail` type, `handoverCleanup` on `EmailContentSession` | `src/participant/sessionState.ts` |
| Package.json: `outlook.*` settings, `email.handoverFolder`, `email.cleanupModel` | `package.json` |
| `FolderSelectionSession`, `EmailSelectionSession` | `src/participant/sessionState.ts` |

The `finishEmailTicket`, `streamEmailContentPreview`, and `handleEmailContentSession`
functions in `emailHandler.ts` are **kept** — the confirm/preview/create flow is unchanged.

---

## Architecture

### New dependency: `postal-mime`

`postal-mime` is the actively recommended successor to `mailparser`, from the same author.
Simpler async API, no streaming complexity, works in both Node.js and browser environments.

```
npm install postal-mime
```

`postal-mime` is written in TypeScript and ships its own `.d.ts` — no `@types/` package needed.

### New file: `src/utils/emlParser.ts`

Pure function, no VS Code API dependency, fully unit-testable.

```typescript
export interface ParsedEml {
  subject: string;
  senderName: string;
  receivedDateTime: string;           // ISO 8601
  htmlBody: string | undefined;       // HTML part if present
  plainBody: string | undefined;      // plain-text fallback
  inlineImageMap: Map<string, string>; // contentId → filename
  attachments: Array<{
    name: string;
    contentType: string;
    contentBytes: string;             // base64
    isInline: boolean;
  }>;
}

export async function parseEml(buffer: Buffer): Promise<ParsedEml>
```

**Body fallback chain:**
1. `htmlBody` present → `htmlToMarkdown(htmlBody, inlineImageMap)` (existing util)
2. `plainBody` only → use plain text directly as `markdownBody`
3. Neither → empty string

**Inline image handling:** `postal-mime` returns attachments with
`disposition: 'inline'` and a `contentId`. Build `inlineImageMap` mapping each
`contentId` (stripped of surrounding `<>`) to the attachment filename. The existing
`htmlToMarkdown` already resolves `cid:` references via this map.
`attachment.content` is a `Uint8Array` — convert with `Buffer.from(att.content).toString('base64')`.

**Edge cases handled by `parseEml`:**
- Plain-text-only emails (no HTML part)
- Malformed HTML (htmlToMarkdown strips unknown tags)
- Missing subject → `'(no subject)'`
- Missing sender → `'Unknown'`
- Missing date → `new Date().toISOString()`

### New VS Code command: `ticket-sidekick.importEml`

Registered in `src/extension.ts`. Two-step handoff — the command cannot call
`streamEmailContentPreview` directly because that function requires a chat response stream.

**Step 1 — VS Code command handler:**
```typescript
vscode.window.showOpenDialog({
  canSelectMany: false,
  filters: { 'Email files': ['eml'] },
  defaultUri: vscode.Uri.file(os.homedir() + '/Downloads'),
  title: 'Select email (.eml) to import',
})
```
Reads the selected file → calls `parseEml` → fetches templates + issue types in parallel →
builds a complete `EmailContentSession` (including `emlFilePath`) → stores it in
`workspaceState('jira.session.emailContent')` → opens chat via:
```typescript
vscode.commands.executeCommand('workbench.action.chat.open',
  { query: '@jira create from email' })
```

**Step 2 — Chat participant handler (`handleCreateFromEmail`):**
Detects `jira.session.emailContent` already populated → calls `streamEmailContentPreview`
directly (same as the existing flow). No Graph API path, no `HandoverEmail` shortcut.

### Modified: `src/participant/sessionState.ts`

Add `emlFilePath?: string` to `EmailContentSession` — stores the absolute path to the
source `.eml` file so `finishEmailTicket` can delete it after upload without changing
the function signature.

### Modified: `src/participant/jira/emailHandler.ts`

- Remove `handleCreateFromEmail` (the old `HandoverEmail` shortcut + Graph API folder/email picker)
- Replace with lean `handleCreateFromEmail` that reads the pre-built `EmailContentSession`
  from `workspaceState` and calls `streamEmailContentPreview`
- `finishEmailTicket`: read `session.emlFilePath`; if set and
  `ticketSidekick.email.deleteEmlAfterImport` is `true`, call `fs.promises.unlink` after
  successful attachment upload (failure is non-fatal)
- Remove the `📎 Attachments (attach to ticket manually)` fallback regex strip — no
  longer needed (attachments come from MIME, not appended text)

---

## Preview Format

```
**From:** Sender Name · **Date:** YYYY-MM-DD
**Subject:** Email subject line
**Attachments:** file1.pdf, file2.pptx

**Description preview:**

[markdown body — inline images appear at their original position]

**Templates:**
1. Bug Report _(Bug)_
2. Feature Request _(Story)_

**Issue types (no template):**
3. Story
4. Task

Reply with a number to select, **post it** to create as **Story**, or **(c)** to cancel.

<!-- jira:email-content -->
```

Inline images appear in the body via `![filename](filename)` at their original `cid:`
position. File attachments (non-inline) are listed in the header, not appended to the body.

---

## Formatting Rules (htmlToMarkdown — structural only)

| Element | Treatment |
|---|---|
| `<b>`, `<strong>` | `**bold**` |
| `<i>`, `<em>` | `_italic_` |
| `<ul>/<li>` | `- item` |
| `<ol>/<li>` | `1. item` |
| `<a href>` | `[text](url)` |
| `<table>` | GFM table |
| `<code>`, `<pre>` | `` `inline` `` / fenced block |
| `<h1>`–`<h6>` | Stripped (emails abuse headings as font-size) |
| `<blockquote>` | Stripped (corporate reply chains add noise) |
| Colors, fonts, background | Stripped |
| `<style>`, `<script>` | Stripped |
| `<img src="cid:…">` | `![filename](filename)` via inlineImageMap |

This matches the existing `htmlToMarkdown` behaviour — no changes required to that util.

---

## Clickable Ticket Link

**After ticket creation** (`finishEmailTicket`):
```
Ticket **[PROJ-123](https://jira.company.com/browse/PROJ-123)** created.
<!-- @jira-ticket:PROJ-123 -->
```

**After load / show** (`loadHandler.ts`):
```
## [PROJ-123](https://jira.company.com/browse/PROJ-123): Summary title
```

`baseUrl` is read with `vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.baseUrl')`
directly inside `finishEmailTicket` and `loadHandler` — no signature changes needed.
The link is `${baseUrl}/browse/${issueKey}`. If `baseUrl` is unset, emit the key only.

---

## EML File Lifecycle

| Setting | Key | Default |
|---|---|---|
| Delete after import | `ticketSidekick.email.deleteEmlAfterImport` | `false` |

When `true`, the `.eml` file is deleted with `fs.promises.unlink` after successful ticket
creation and attachment upload. Deletion failure is non-fatal (logged, not surfaced to user).

---

## New Package.json Settings

```jsonc
"ticketSidekick.email.deleteEmlAfterImport": {
  "type": "boolean",
  "default": false,
  "description": "Delete the .eml file automatically after the Jira ticket is created."
}
```

New command:
```jsonc
{
  "command": "ticket-sidekick.importEml",
  "title": "Ticket Sidekick: Create Jira ticket from email (.eml)"
}
```

---

## Files Changed

| File | Change |
|---|---|
| `src/utils/emlParser.ts` | NEW — RFC 2822 parser wrapping postal-mime |
| `src/utils/owaUserscript.ts` | DELETE |
| `src/utils/handoverFolder.ts` | DELETE |
| `src/outlook/IOutlookClient.ts` | DELETE |
| `src/outlook/OutlookApiClient.ts` | DELETE |
| `src/outlook/tokenProviders.ts` | DELETE |
| `src/services/OutlookService.ts` | DELETE |
| `src/services/ConfigService.ts` | Remove `getOutlookConfig()`, `getOutlookAuthProvider()`, `saveOutlookFolderId()` methods |
| `src/participant/jira/emailHandler.ts` | Replace entry point; remove OWA strip regex; read `emlFilePath` from session for delete |
| `src/participant/sessionState.ts` | Add `emlFilePath?` to `EmailContentSession`; remove `HandoverEmail`, `FolderSelectionSession`, `EmailSelectionSession`, `handoverCleanup` |
| `src/participant/JiraParticipant.ts` | Remove folder/email-selection session detection; keep email-content detection |
| `src/participant/jira/loadHandler.ts` | Add clickable `[KEY](baseUrl/browse/KEY)` link to ticket heading |
| `src/services/TicketService.ts` | No change — link constructed in handler, not here |
| `src/extension.ts` | Remove URI handler, 3 old commands; add `importEml` command |
| `package.json` | Remove `outlook.*` + handover settings; add `deleteEmlAfterImport`; add `importEml` command |
| `src/test/emlParser.test.ts` | NEW — unit tests using real .eml fixture files |
| `src/test/fixtures/eml/sample.eml` | NEW — minimal RFC 2822 fixture with HTML body + inline image + attachment |
| `src/test/owaUserscript.test.ts` | DELETE |
| `src/test/handoverFolder.test.ts` | DELETE |
| `src/test/fixtures/email-handover/` | DELETE |
| `CLAUDE.md` | Update key files table, session state table, Outlook settings section |
| `README.md` | Replace OWA bridge section with EML import instructions |

---

## Verification

1. `npm run compile` — no TypeScript errors
2. `npm test` — all tests green; new `emlParser.test.ts` covers: subject/sender/date parsing, HTML body, plain-text fallback, inline image map, base64 attachment bytes, missing-field defaults; fixture at `src/test/fixtures/eml/sample.eml`
3. Manual: OWA → More actions → Download message → `.eml` saved → Command Palette → "Ticket Sidekick: Create Jira ticket from email (.eml)" → file picker opens in Downloads → select file → chat preview appears with subject, From, Date, attachment list, body
4. Manual: reply "post it" → ticket created → clickable link appears in chat → attachment uploaded to Jira
5. Manual: `@jira show PROJ-123` → heading includes clickable URL
6. Manual: with `deleteEmlAfterImport: true` → `.eml` file gone from Downloads after creation
