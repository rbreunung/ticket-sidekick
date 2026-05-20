# Design: `@jira load` — ticket context loading with attachments

**Date:** 2026-05-20
**Status:** Approved for implementation

---

## Problem

When starting a bug analysis or implementation task from a Jira ticket, the
relevant information is spread across the ticket description, comments, and
binary attachments (screenshots, log files, heap dumps, code patches). The
`@jira show` command surfaces description and comments but ignores
attachments entirely. There is no way to bring ticket attachments into the
workspace so the LM can reason over them alongside code.

---

## Solution

A new `@jira load PROJ-123` intent that:

1. Downloads the full ticket context into `.jira-context/PROJ-123/` in the
   workspace root
2. Renders the same output as `@jira show PROJ-123` so the user immediately
   sees what was loaded
3. Ensures `.jira-context/` is in `.gitignore`

After loading, the LM's existing file-reading machinery can discover and read
any of the downloaded files independently during the session.

---

## File layout

```
.jira-context/
  PROJ-123/
    ticket.md          ← metadata + description (formatted Markdown)
    comments.md        ← all comments in full, newest-last
    attachments/
      screenshot.png   ← binary image, downloaded as-is
      error.log        ← text file, downloaded as-is
      heap-dump.bin    ← skipped (binary non-image > 5 MB)
```

`ticket.md` format:

```markdown
# PROJ-123: <summary>

**Status:** In Progress
**Assignee:** Jane Doe
**Reporter:** John Smith
**Priority:** High
**Labels:** performance, backend
**Fix Versions:** 3.2

## Description

<formatted description>

## Attachments

- `attachments/screenshot.png` — 234 KB (image/png)
- `attachments/error.log` — 45 KB (text/plain)
- `heap-dump.bin` — 48 MB — skipped (binary, over size limit)
```

`comments.md` format:

```markdown
# Comments — PROJ-123

## 1. Jane Doe (2026-05-10)

<comment body>

---

## 2. John Smith (2026-05-12)

<comment body>
```

---

## Attachment handling rules

| Category | Criterion | Action |
|---|---|---|
| Text | mimeType starts with `text/`, or extension in known-text list | Download, save as file |
| Image | mimeType starts with `image/` | Download, save as binary |
| Any | size > 5 MB | Skip, list in `ticket.md` with size and reason |
| Other binary | anything else | Skip, list in `ticket.md` with name and size |

Known-text extensions (regardless of mimeType): `.log`, `.txt`, `.java`,
`.xml`, `.json`, `.yaml`, `.yml`, `.md`, `.properties`, `.sql`, `.sh`,
`.py`, `.js`, `.ts`, `.html`, `.css`, `.patch`, `.diff`.

---

## Architecture

### New types — `IJiraClient.ts`

```typescript
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;        // bytes
  content: string;     // full URL to download
}
```

Add `attachment?: JiraAttachment[]` to `JiraIssue.fields` (typed alongside
the existing index signature).

### New client method — `IJiraClient` + `JiraApiClient`

```typescript
downloadAttachment(url: string): Promise<Uint8Array>
```

`JiraApiClient` implementation: authenticated GET to the full `content` URL
(same auth header already used everywhere). Returns raw bytes as
`Uint8Array`. Throws on non-200 or non-JSON content-type check is skipped —
this endpoint returns binary, not JSON.

### Attachment link rewriting in generated Markdown

Jira wiki markup uses two syntaxes for attachments that `jiraWikiToMarkdown`
currently does not handle — both pass through as literal text:

- `!filename.png!` / `!filename.png|thumbnail!` — inline image
- `[^filename.txt]` — attachment link

**Step 1 — extend `applyInline` in `jiraWikiToMarkdown.ts`:**

```typescript
// !filename! and !filename|params! → ![filename](filename)
.replace(/!([^!\s|]+?)(?:\|[^!]*)?\!/g, (_, f) => `![${f}](${f})`)
// [^filename] attachment link → [filename](filename)
.replace(/\[\^([^\]]+)\]/g, '[$1]($1)')
```

This produces generic relative links — `![screenshot.png](screenshot.png)` —
which are correct for the root of any directory that contains the file.

**Step 2 — rewrite to `attachments/` paths in `handleLoadTicket`:**

After converting description and comment bodies to Markdown, post-process the
text to redirect links for filenames that were actually downloaded:

```typescript
function rewriteAttachmentLinks(md: string, downloadedFilenames: Set<string>): string {
  return md.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, href) =>
    downloadedFilenames.has(href) ? `[${alt}](attachments/${href})` : match
  );
}
```

Skipped attachments (too large or binary-only) keep their original relative
link form and are annotated in the `## Attachments` index as skipped, so the
reader knows the file is not present locally.

This keeps `jiraWikiToMarkdown` context-free (it does not know about local
file structure) while ensuring `ticket.md` and `comments.md` contain correct
relative paths to downloaded files.

---

### New service method — `TicketService`

```typescript
async getAttachments(issueKey: string): Promise<JiraAttachment[]>
async downloadAttachment(url: string): Promise<Uint8Array>
```

`getAttachments` calls `getIssue` and extracts `fields.attachment ?? []`.
`downloadAttachment` delegates to `client.downloadAttachment(url)`.

No file I/O in `TicketService` — it stays VS Code–free.

### New intent — `JiraParticipant`

Add `loadTicket` to the `Operation` union and `INTENT_PROMPT`:

> `loadTicket`: load full ticket context (description, comments, attachments)
> into `.jira-context/{key}/` in the workspace; triggered by "load", "fetch
> context", "download ticket"

Handler (`handleLoadTicket`):

1. Resolve workspace root — `vscode.workspace.workspaceFolders?.[0]?.uri`; if
   absent, show error and return
2. Fetch issue via `ticketService.getTicket(key)` and
   `ticketService.getIssueComments(key, 100)`
3. Fetch attachments via `ticketService.getAttachments(key)`
4. Create directory `{workspace}/.jira-context/{key}/attachments/` via
   `vscode.workspace.fs.createDirectory`
5. Write `ticket.md` — metadata + description + attachment index
6. Write `comments.md` — all comments formatted
7. For each attachment:
   - Skip if size > 5 MB (record in skipped list)
   - Skip if binary non-image (record in skipped list)
   - Download via `ticketService.downloadAttachment(attachment.content)`
   - Write to `attachments/{filename}` via `vscode.workspace.fs.writeFile`
8. Ensure `.jira-context/` is in workspace-root `.gitignore` (append if
   file exists and line is absent; create if file absent)
9. Stream summary of what was written
10. Stream the same `@jira show` output (ticket metadata + comment synthesis)
    so the user sees the loaded content immediately

### `.gitignore` management

Read `.gitignore` at workspace root. If `.jira-context/` is not already
present, append it. If `.gitignore` does not exist, create it with that
single line.

---

## Error handling

- No workspace folder open → stream clear error, do nothing
- Attachment download fails → log the filename and error in the response,
  continue with remaining attachments (don't abort the whole load)
- File write fails → same: report and continue
- Issue not found → existing `getIssue` error propagates normally

---

## Testing

- `jiraWikiToMarkdown.test.ts`: `!filename.png!` → `![filename.png](filename.png)`;
  `!filename.png|thumbnail!` → `![filename.png](filename.png)`;
  `[^file.txt]` → `[file.txt](file.txt)`
- `TicketService.test.ts`: `getAttachments` returns typed list from fixture;
  `downloadAttachment` delegates to client method
- `MockJiraClient`: add `downloadAttachment` returning a fixture byte array;
  add `attachment` array to `ticket-PROJ-123.json` fixture
- `JiraParticipant.test.ts`: `loadTicket` intent parsed correctly from
  "load PROJ-123" and "fetch context for PROJ-123"; `rewriteAttachmentLinks`
  rewrites downloaded filenames to `attachments/` paths and leaves skipped
  filenames unchanged
- File writing and `.gitignore` management are VS Code–dependent and covered
  by the e2e suite only

---

## Out of scope

- Uploading attachments to Jira (separate future feature)
- Automatic loading on `@jira show` (opt-in only)
- MCP / model-initiated Jira queries (separate future project)
- Attachment preview in chat UI
