# Design: Spell Check Refactor + JiraParticipant Refactor + Outlook Email → Jira Ticket

**Date:** 2026-05-21  
**Status:** Approved for implementation

## Context

`JiraParticipant.ts` has grown to 2042 lines with 33 top-level functions and a 843-line factory function. Adding an email-to-ticket feature on top of that would make it unmanageable. This design does three things in sequence:

1. **Phase 0** — Move spell check from an automatic field-update interrupt to an explicit on-demand command
2. **Phase 1** — Refactor the participant into focused handler modules (no further behavior change)
3. **Phase 2** — Add the Outlook email-to-ticket feature into the clean structure

The email feature lets a user type `@jira create from email` in Copilot Chat, pick a mail folder once (saved for future runs), pick an email by number, preview the converted Markdown body in the chat, confirm, and have a Jira ticket created with subject → summary, body → description (Jira wiki markup), and all attachments uploaded.

---

## Phase 0 — Spell check as an explicit command

### Problem with the current design

Spell check currently fires automatically mid-flow inside `continueSetField` whenever `ticketSidekick.jira.spellCheck` is `true` and the field being updated is a string. This interrupts every field update with a yes/no prompt the user did not ask for. It also makes the field update code harder to follow (the `spellCheckEnabled` parameter threads through multiple function signatures) and would require special-case handling in the email import flow to avoid checking someone else's words.

### New design: `@jira spell check`

Spell check becomes an explicit, user-initiated operation on a ticket's description:

```
@jira spell check PROJ-123
@jira fix grammar on PROJ-123
```

**Handler flow:**
1. Resolve ticket key (prompt → branch → history, same as all other operations)
2. `ticketService.getTicket(key)` → extract current description text
3. `spellCheckValue(description, model, token)` → LLM returns corrected text or `null` (no errors)
4. If `null` → stream "No spelling or grammar issues found in PROJ-123"
5. If corrected → create `ContentSession` with the corrected text, stream Markdown preview
6. User confirms ("post it") → `ticketService.updateField(key, 'description', corrected)`
7. User refines → LLM regenerates from instruction, new preview (existing `ContentSession` loop)

The `spellCheckValue` function itself is unchanged and moves to `jira/llmHelpers.ts` in Phase 1.

### What is removed

| Removed | Replaced by |
|---|---|
| `SpellCheckSession` type in `sessionState.ts` | — (not needed; `ContentSession` handles preview) |
| `jira.session.spellCheck` workspaceState key | — |
| `<!-- jira:spell-check -->` session marker | — |
| `spellCheckEnabled` parameter on `continueSetField` / `handleSetField` | — |
| Inline spell-check interrupt block in `continueSetField` | — |
| `ticketSidekick.jira.spellCheck` VS Code setting | — |

### What is added

| Added | Note |
|---|---|
| `'spellCheck'` to `Operation` union | — |
| Intent description in `INTENT_PROMPT` | `"spellCheck: check and correct spelling/grammar on a ticket's description; triggered by 'spell check', 'fix grammar', 'check spelling'"` |
| `handleSpellCheck` in `jira/fieldHandler.ts` (Phase 1 location) | Fetch → LLM → ContentSession |

### Migration note

Users who relied on the automatic spell check will no longer see the prompt during field updates. The behavior is intentionally removed, not replaced by a setting. `README.md` and `CLAUDE.md` are updated in Phase 2 to document the new command.

### Verification

- `npm test` passes (no `SpellCheckSession` references remain)
- `npm run compile` passes
- Field updates (set field, bulk update) complete without any spell-check interruption
- `@jira spell check PROJ-123` on a ticket with typos → ContentSession preview appears
- `@jira spell check PROJ-123` on a clean ticket → "No issues found" response

---

## Phase 1 — Refactor `JiraParticipant.ts` (no behavior change)

### Goal

Reduce `JiraParticipant.ts` from 2042 → ~250 lines. Create `src/participant/jira/` with one file per handler domain. Imports are updated; all tests stay green; `npm run compile` stays clean.

### New file layout

```
src/participant/
  JiraParticipant.ts          ← slim dispatch only (~250 lines)
  sessionState.ts             ← unchanged
  reviewSessionState.ts       ← unchanged
  jira/
    llmHelpers.ts             ← LLM-calling utilities
    ticketContext.ts          ← ticket/project key resolution
    contentHandler.ts         ← content preview/refinement session
    createHandler.ts          ← ticket creation flow
    loadHandler.ts            ← load-ticket handler + comment serialization
    fieldHandler.ts           ← set field, bulk update
    cleanupHandler.ts         ← cleanup run, review screen, batch execution
    workflowHandler.ts        ← workflow discovery
    emailHandler.ts           ← email-to-ticket handler (Phase 2)
```

### Function assignments

| File | Functions |
|---|---|
| `jira/llmHelpers.ts` | `parseIntent`, `generateContent`, `isLmRefusal`, `extractHistoryTurns`, `buildHistoryContext`, `synthesizeComments`, `generateDescriptionAndCommentsSummary` |
| `jira/ticketContext.ts` | `getLastAssistantText`, `resolveTicketFromBranch`, `resolveProjectKey`, `parseLastTicketFromContext` |
| `jira/contentHandler.ts` | `gatherFileContent`, `buildContentContext`, `streamContentPreview`, `handleContentSession` |
| `jira/createHandler.ts` | `streamIssueTypeSelection`, `continueAfterIssueType`, `checkSectionCoverage`, `streamNextSection`, `streamTemplateSelection`, `finishTicketCreation`, `handleCreateTicket` |
| `jira/loadHandler.ts` | `handleLoadTicket`, `serializeCommentsForLLM` |
| `jira/fieldHandler.ts` | `spellCheckValue`, `streamFieldUpdatePreview`, `continueSetField`, `handleSetField` |
| `jira/cleanupHandler.ts` | `streamReviewScreen`, `executeCleanupBatch`, `handleRunCleanup` |
| `jira/workflowHandler.ts` | `handleDiscoverWorkflow` |

### What stays in `JiraParticipant.ts`

- `Operation` type and `ParsedIntent` interface
- `INTENT_PROMPT` constant
- `createJiraParticipant` export — contains only:
  - Config/auth guard
  - `JiraApiClient` + `TicketService` construction
  - `check` command
  - Session-state dispatch (one `if` block per session type, delegating to handler imports)
  - Intent-dispatch `switch` (one `case` per operation, delegating to handler imports)

### Verification

`npm test` and `npm run compile` must pass after each handler file is extracted, not just at the end.

---

## Phase 2 — Email-to-ticket feature

### Architecture

Follows the existing three-layer pattern:

```
JiraParticipant (email intent)
  → emailHandler.ts           ← chat flow
    → OutlookService          ← business logic
      → IOutlookClient        ← interface + types
        → OutlookApiClient    ← Microsoft Graph HTTP
    → htmlToMarkdown.ts       ← new pure utility
    → markdownToJiraWiki.ts   ← existing utility (reused)
    → ContentSession          ← existing preview flow (reused)
    → TicketService           ← existing (reused; needs uploadAttachment)
```

### New files

| File | Purpose |
|---|---|
| `src/outlook/IOutlookClient.ts` | Interface + types |
| `src/outlook/OutlookApiClient.ts` | Microsoft Graph HTTP, VS Code Microsoft auth |
| `src/services/OutlookService.ts` | Business logic: list, fetch, convert |
| `src/utils/htmlToMarkdown.ts` | Pure HTML → Markdown converter |
| `src/participant/jira/emailHandler.ts` | Chat handler |
| `src/test/mocks/MockOutlookClient.ts` | Test fixture |
| `src/test/OutlookService.test.ts` | Unit tests |

### Types (`IOutlookClient.ts`)

```typescript
interface FolderItem {
  id: string;           // stable Graph API folder ID — persisted to settings
  displayName: string;  // shown in the picker
  unreadItemCount: number;
}

interface EmailListItem {
  id: string;
  subject: string;
  receivedDateTime: string;  // ISO 8601
  senderName: string;
}

interface EmailAttachment {
  name: string;
  contentType: string;
  contentBytes: string;    // base64
  isInline: boolean;
  contentId?: string;      // matches cid: references in HTML body
}

interface EmailMessage extends EmailListItem {
  bodyHtml: string;
  attachments: EmailAttachment[];
}

interface IOutlookClient {
  listFolders(): Promise<FolderItem[]>;
  listEmails(folderId: string, limit: number): Promise<EmailListItem[]>;
  getEmail(emailId: string): Promise<EmailMessage>;
}
```

### Authentication (`OutlookApiClient.ts`)

Uses `vscode.authentication.getSession('microsoft', ['https://graph.microsoft.com/Mail.Read'])`.

- On Windows domain-joined machines with an existing Microsoft/Kerberos SSO session: silent, no browser prompt.
- For all other users: VS Code's standard Microsoft sign-in browser flow (same UX as GitHub sign-in in VS Code).
- No new secret key. No token stored in settings. The VS Code session manager handles refresh.
- If auth fails: stream a clear error message with instructions to sign in to a Microsoft account in VS Code.

Microsoft Graph endpoints used:
- `GET https://graph.microsoft.com/v1.0/me/mailFolders?$select=id,displayName,unreadItemCount&$top=25`
- `GET https://graph.microsoft.com/v1.0/me/mailFolders/{folderId}/messages?$select=subject,receivedDateTime,from&$top={limit}&$orderby=receivedDateTime desc`
- `GET https://graph.microsoft.com/v1.0/me/messages/{id}?$expand=attachments`

### HTML → Markdown converter (`htmlToMarkdown.ts`)

Pure function, zero dependencies. Recursive HTML parser (no external library — matches the project's zero-dependency policy).

```typescript
function htmlToMarkdown(html: string, inlineImageMap: Map<string, string>): string
// inlineImageMap: contentId → filename, used to replace <img src="cid:...">
```

Handles:

| HTML | Markdown output |
|---|---|
| `h1`–`h6` | `# ` … `###### ` |
| `b`, `strong` | `**text**` |
| `i`, `em` | `_text_` |
| `ul` / `li` | `- item` |
| `ol` / `li` | `1. item` |
| `table` / `tr` / `th` / `td` | GFM table |
| `pre` / `code` | fenced ` ``` ` block |
| `a href` | `[text](url)` |
| `<img src="cid:xyz">` | `[📎 filename.png]` (placeholder) → becomes `!filename.png\|thumbnail!` in Jira wiki after user confirms |
| `p`, `br` | paragraph breaks |
| Inline `<style>`, `<script>` | stripped |

The output Markdown is what the user sees in the chat preview (VS Code renders it natively). `[📎 filename.png]` is not valid Markdown link syntax, so `markdownToJiraWiki` passes it through unchanged as literal text. After that conversion, a regex replace is applied to the Jira wiki string: `/\[📎 ([^\]]+)\]/g` → `!$1|thumbnail!`. This two-step approach keeps the converters simple and single-purpose.

**Plain-text email fallback:** If the Graph API returns no HTML body (email is plain text only), `OutlookService.fetchEmailForTicket` uses the plain-text body directly as the Markdown preview without any conversion step. `inlineImageMap` is empty; inline attachments are still uploaded normally.

### `OutlookService`

```typescript
class OutlookService {
  constructor(private readonly client: IOutlookClient) {}

  async listEmailsForDisplay(folderId: string, limit: number): Promise<string>
  // Returns a numbered markdown list for streaming into chat

  async fetchEmailForTicket(emailId: string): Promise<{
    subject: string;
    markdownBody: string;   // converted via htmlToMarkdown
    inlineImageMap: Map<string, string>;  // contentId → filename
    attachments: EmailAttachment[];
  }>
}
```

### New Jira API method

```typescript
// IJiraClient
uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void>;
```

Implementation in `JiraApiClient`: `POST /rest/api/2/issue/{key}/attachments` with `multipart/form-data`, header `X-Atlassian-Token: nocheck`. The base64 `contentBytes` is decoded to a `Buffer` before sending.

`MockJiraClient` stub: resolves immediately (no-op).

### Email handler flow (`emailHandler.ts`)

Triggered by `@jira create from email`.

```
1. Read outlook config (folderId, emailListSize) from VS Code settings
2. Construct OutlookApiClient (triggers auth if needed)

3. If folderId is empty (first run / cleared):
   OutlookService.listFolders → stream numbered folder list into chat:
     Which folder should I list emails from?
     1. Inbox (423 unread)
     2. Support Requests (12 unread)
     3. Jira Inbox (5 unread)
   + "Reply with a number to select, or (c) to cancel."
   + <!-- jira:folder-selection --> marker
   + Save FolderSelectionSession to workspaceState
   → STOP, wait for next turn

   On next turn (user replies with folder number):
   → Persist chosen folder ID to VS Code settings (ConfigurationTarget.Global)
   → Proceed to step 4

4. OutlookService.listEmailsForDisplay(folderId, emailListSize) →
   stream numbered email list into chat:
     1. [2026-05-20] Support request – Login failing on mobile (Alice Smith)
     2. [2026-05-19] Bug report – Payment timeout (Bob Jones)
   + "Reply with a number to select, or (c) to cancel."
   + <!-- jira:email-selection --> marker
5. Save EmailSelectionSession to workspaceState
```

On next turn (user replies with email number):
```
5. Parse selection number
6. OutlookService.fetchEmailForTicket → { subject, markdownBody, inlineImageMap, attachments }
7. streamTemplateSelection → user picks template (existing flow, reused)
8. Build ContentSession:
   - subject becomes the summary
   - markdownBody is the preview content
9. Stream Markdown preview of email body in chat
10. "Subject: <subject>\n\nContent preview:\n\n{markdownBody}\n\nPost this as a Jira ticket? Reply **post it** to confirm, or give a refinement instruction."
11. + <!-- jira:email-content --> marker, save EmailContentSession to workspaceState
```

On confirmation ("post it"):
```
12. Convert markdownBody → Jira wiki via markdownToJiraWiki
13. Post-process: replace [📎 filename.png] → !filename.png|thumbnail!
14. TicketService.createTicket({ summary: subject, description: jiraWikiBody, ...templateFields })
15. Upload all attachments in parallel: TicketService.uploadAttachment(newKey, ...)
16. Stream success response with ticket key and link
17. Append <!-- @jira-ticket:KEY --> (existing last-ticket tracking)
```

### New session types

Added to `sessionState.ts`:

```typescript
interface FolderSelectionSession {
  folders: FolderItem[];  // FolderItem imported from IOutlookClient
}

interface EmailSelectionSession {
  folderId: string;
  emails: EmailListItem[];
}

interface EmailContentSession {
  emailId: string;
  subject: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;  // serializable form of Map; convert to Map<string,string> before passing to htmlToMarkdown on restore
  attachments: EmailAttachment[];
  selectedTemplate: JiraTemplate | null;
  projectKey: string;
}
```

Session keys and markers:

| Session | `workspaceState` key | Marker |
|---|---|---|
| `FolderSelectionSession` | `jira.session.folderSelection` | `<!-- jira:folder-selection -->` |
| `EmailSelectionSession` | `jira.session.emailSelection` | `<!-- jira:email-selection -->` |
| `EmailContentSession` | `jira.session.emailContent` | `<!-- jira:email-content -->` |

Detection added to the session-dispatch order in `JiraParticipant.ts`: folder selection → email selection → email content, inserted after load-skipped and before comment list.

### New intent operation

Add `'createFromEmail'` to the `Operation` union. Update `INTENT_PROMPT` with:

```
- createFromEmail: create a Jira ticket from an Outlook email; triggered by "create from email", "ticket from email", "email to ticket"
```

### VS Code settings (added to `package.json` contributes)

| Setting | Type | Default | Description |
|---|---|---|---|
| `ticketSidekick.outlook.folderId` | `string` | `""` | Microsoft Graph folder ID. Empty = not yet configured; set automatically by the chat-native folder picker on first run. Clear to re-run the picker. |
| `ticketSidekick.outlook.emailListSize` | `number` | `10` | Number of emails to show in the selection list |

`ConfigService` gains a `getOutlookConfig()` method returning `{ folderId: string; emailListSize: number }`.

The folder ID stored in settings is the stable Graph API `id` (e.g. `AQMkADAwATM...`), not the display name, so it survives folder renames. The picker resolves the display name at selection time.

---

## Documentation updates

Both files are updated in **Phase 2** after the feature is complete (no point updating them during the refactor since no user-visible behavior changes).

### `CLAUDE.md`

- **Key files table**: add `src/outlook/IOutlookClient.ts`, `src/outlook/OutlookApiClient.ts`, `src/services/OutlookService.ts`, `src/utils/htmlToMarkdown.ts`, `src/participant/jira/emailHandler.ts`; update `JiraParticipant.ts` entry to note it now delegates to `src/participant/jira/` handlers
- **Architecture section (Jira)**: add the Outlook layer to the diagram
- **Session state table**: remove `SpellCheckSession` row; add `FolderSelectionSession`, `EmailSelectionSession`, and `EmailContentSession` rows
- **Detection order**: update to include the two new email sessions
- **VS Code settings table**: add the two `ticketSidekick.outlook.*` entries
- **Adding a new Jira operation**: no structural change needed; the steps already describe the pattern the email feature follows
- **Credentials table**: note that Outlook auth uses `vscode.authentication` (no secret key)

### `README.md`

- New section: **Create a ticket from Outlook email** — describes the `@jira create from email` command, Microsoft sign-in flow, folder configuration, preview-and-confirm step
- New settings documented: `ticketSidekick.outlook.folderId`, `ticketSidekick.outlook.emailListSize`

---

## Testing

### Unit tests (`OutlookService.test.ts`)

- `listEmailsForDisplay` formats the numbered list correctly
- `fetchEmailForTicket` builds the correct subject, markdownBody, inlineImageMap, attachments
- `htmlToMarkdown` coverage: headings, bold/italic, lists, tables, code blocks, inline images (cid replacement), stripped scripts/styles

### Phase 1 test impact

**Zero test changes required.** `JiraParticipant.test.ts` imports only from `sessionState.ts` and `IJiraClient.ts` — it never imports from `JiraParticipant.ts` itself (which can't run under Vitest because it imports `vscode`). All functions moved in Phase 1 are VS Code-dependent handler functions that are not directly unit-tested. The test suite stays green throughout every extraction step.

Verification gate after each handler file extracted: `npm test` passes, `npm run compile` passes.

### Email feature end-to-end

Manual test with a real Outlook account:
1. `@jira create from email` → numbered list appears
2. Select a formatted email with inline images and attachments
3. Preview renders in chat with correct Markdown structure
4. Confirm → ticket created, attachments visible in Jira, inline images appear as thumbnails in description
5. Refinement turn: give a correction instruction → preview regenerates, confirm → ticket posted with revised content

---

## File change summary

### Phase 0 (spell check refactor)

**Modified:** `src/participant/JiraParticipant.ts` (remove `SpellCheckSession` dispatch, remove `spellCheckEnabled` wiring, add `spellCheck` intent case), `src/participant/sessionState.ts` (remove `SpellCheckSession` type and `jira.session.spellCheck` key), `package.json` (remove `ticketSidekick.jira.spellCheck` contribution)

### Phase 1 (structural refactor — no behavior change)

**Modified:** `src/participant/JiraParticipant.ts`  
**Created:** `src/participant/jira/llmHelpers.ts`, `ticketContext.ts`, `contentHandler.ts`, `createHandler.ts`, `loadHandler.ts`, `fieldHandler.ts` (includes `handleSpellCheck`), `cleanupHandler.ts`, `workflowHandler.ts`

### Phase 2 (email feature)

**Created:** `src/outlook/IOutlookClient.ts`, `src/outlook/OutlookApiClient.ts`, `src/services/OutlookService.ts`, `src/utils/htmlToMarkdown.ts`, `src/participant/jira/emailHandler.ts`, `src/test/mocks/MockOutlookClient.ts`, `src/test/OutlookService.test.ts`  
**Modified:** `src/jira/IJiraClient.ts` (add `uploadAttachment`), `src/jira/JiraApiClient.ts` (implement), `src/test/mocks/MockJiraClient.ts` (stub), `src/services/ConfigService.ts` (add `getOutlookConfig`), `src/participant/sessionState.ts` (add `FolderSelectionSession`, `EmailSelectionSession`, `EmailContentSession`), `src/participant/JiraParticipant.ts` (add email session dispatch + intent routing), `package.json` (add two `ticketSidekick.outlook.*` settings), `README.md`, `CLAUDE.md`
