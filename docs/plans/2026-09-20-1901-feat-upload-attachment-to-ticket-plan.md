---
title: Upload Attachment to Ticket - Plan
type: feat
date: 2026-09-20
topic: upload-attachment-to-ticket
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Upload Attachment to Ticket - Plan

## Goal Capsule

- **Objective:** A user working in `@jira` chat can get a local file attached to a ticket by asking in natural language, without attaching the wrong file or exceeding a realistic size limit; an AI agent in Copilot Agent Mode can do the same by calling a tool with an explicit ticket and file path.
- **Product authority:** Resolved through user dialogue in this brainstorm session (all Key Decisions below are session-settled, user-directed).
- **Open blockers:** None — see Outstanding Questions for items deferred to planning rather than blocking it.

## Product Contract

### Summary

`@jira` gains a natural-language upload flow that attaches one or more local files to a ticket, resolving the file from a chat attachment or the active editor and the ticket from text, filename, or session context, with a file-picker fallback and a pre-upload confirmation. A parallel `jira_uploadAttachment` Language Model tool exposes the same underlying upload to Copilot Agent Mode with fully explicit inputs.

### Key Decisions

- **Reuse the existing 25 MB attachment cap rather than build large-file support.** The existing `MAX_ATTACHMENT_BYTES` cap already bounds realistic attachment sizes, and real Jira instances rarely allow anywhere near multi-GB attachments; true large-file upload would require streaming/chunking disproportionate to the need. (session-settled: user-directed — chosen over a literal 25 GB cap: matches existing architecture and real-world Jira limits) Governs R7, R11.
- **Chat file auto-resolution is limited to a chat-attached file or the active editor tab.** Fuzzy-matching a word like "report" against workspace filenames risks silently attaching the wrong same-named file; anything not resolved this way or by an explicit path falls to the picker. (session-settled: user-directed) Governs R1, R2, R3.
- **Ticket resolution checks text, then filename, then last-ticket session context, before asking.** Matches how a filename commonly carries the ticket key and reuses the last-referenced-ticket context other `@jira` flows already maintain; the flow never guesses beyond these three sources. (session-settled: user-directed) Governs R4, R5.
- **A confirmation step precedes every upload, in chat and via the tool.** Trades one extra turn for protection against an auto-resolved file or ticket being wrong, consistent with every other write operation in this codebase. (session-settled: user-directed) Governs R6, R10.
- **The Language Model tool takes fully explicit inputs, with no auto-resolution and no picker.** Matches every other `jira_*` tool's statelessness — an Agent Mode caller already knows the ticket and file it wants uploaded. (session-settled: user-directed) Governs R9, R12.

### Requirements

**Chat flow (`@jira` upload)**

- R1. When the user asks in chat to upload a file to a ticket, the flow resolves the target file from a file reference attached to the chat message, or, if none is attached, the file currently open and active in the editor.
- R2. If no file resolves from a chat attachment or the active editor, and no absolute or relative path was given in the message, the flow opens a native multi-select file picker.
- R3. When the user explicitly names an absolute or relative file path in the message, the flow uses that path directly, without consulting the chat attachment or active editor.
- R4. The flow resolves the target ticket key by checking, in order: an explicit ticket key in the message text; a ticket key embedded in the resolved file's name; the ticket last referenced in the current chat session.
- R5. If no ticket key resolves from any source in R4, the flow asks the user explicitly which ticket to use rather than guessing.
- R6. Before uploading, the flow shows a confirmation naming the file name(s), size(s), and target ticket, and proceeds only after the user confirms.
- R7. A file the flow uploads must be at or under the existing 25 MB attachment size limit (`MAX_ATTACHMENT_BYTES`); an oversized file is rejected before upload with a message naming the file and the limit.
- R8. When multiple files are selected via the picker, the flow uploads each to the same resolved ticket and reports per-file success or failure.

**Language Model tool (`jira_uploadAttachment`)**

- R9. A `jira_uploadAttachment` Language Model tool is registered alongside the other `jira_*` tools, taking an explicit ticket key and file path as input, with no file/ticket auto-resolution and no file picker.
- R10. The tool shows a confirmation naming the file, its size, and the target ticket before uploading, and re-validates its inputs independently in `invoke()`, consistent with every other write tool in `jiraTools.ts`.
- R11. The tool enforces the same 25 MB size limit as the chat flow and rejects an oversized file before attempting the upload.
- R12. The tool uploads exactly one file per call; attaching several files means the calling model calls the tool multiple times.

### Key Flows

- F1. Upload from chat with a resolvable file and ticket
  - **Trigger:** User asks `@jira` to upload a file; a file is attached to the chat message or open in the active editor, and a ticket key resolves from text, filename, or session context.
  - **Steps:** Resolve file → resolve ticket → show confirmation (file, size, ticket) → user confirms → upload → report result.
  - **Covers:** R1, R4, R6, R7.
- F2. Upload from chat with no resolvable file
  - **Trigger:** User asks to upload with no chat attachment, no active editor file, and no path in the message.
  - **Steps:** Open multi-select file picker → user picks one or more files → resolve ticket → confirmation → user confirms → upload each → report per-file result.
  - **Covers:** R2, R4, R6, R8.
- F3. Upload from chat with no resolvable ticket
  - **Trigger:** A file resolves but no ticket key is found in text, filename, or last-ticket session context.
  - **Steps:** Resolve file → ask user explicitly for the ticket key → resume with confirmation → upload.
  - **Covers:** R4, R5, R6.
- F4. Upload via the Language Model tool
  - **Trigger:** Agent Mode calls `jira_uploadAttachment` with an explicit ticket key and file path.
  - **Steps:** Validate inputs → show confirmation → user confirms (or auto-approves) → upload → return result text.
  - **Covers:** R9, R10, R11, R12.

### Acceptance Examples

- AE1. **Covers R7, R11.** Given a file larger than 25 MB, When the user (via chat or the tool) attempts to upload it, Then the upload is rejected before it starts, with a message naming the file and the 25 MB limit.
- AE2. **Covers R2.** Given no chat attachment, no active editor file, and no path in the message, When the user asks to upload, Then a multi-select file picker opens.
- AE3. **Covers R4, R5.** Given a resolved file with no ticket key in text, filename, or last-ticket session context, When the user asks to upload, Then the flow asks explicitly which ticket to use, rather than guessing.
- AE4. **Covers R8.** Given the user selects three files in the picker, When all three are within the size limit, Then all three are uploaded to the same ticket and each file's success or failure is reported individually.
- AE5. **Covers R9.** Given an Agent Mode call to `jira_uploadAttachment` with a ticket key but no file path, Then the tool returns a validation message and uploads nothing.

### Scope Boundaries

- Fuzzy-matching a bare word (e.g. "report") against workspace filenames is not supported — only a chat attachment, the active editor, or an explicit path resolve a file automatically.
- Naming multiple files by path in one chat message, outside the picker, is not supported in this iteration.
- The Language Model tool uploads exactly one file per call; there is no multi-file tool input.
- True large-file upload (multi-GB, streamed or chunked) is out of scope — the existing 25 MB cap applies everywhere.
- Detecting or adapting to a Jira instance's own (possibly lower) configured attachment limit is out of scope; Jira's own rejection surfaces through today's existing error handling.

### Outstanding Questions

**Deferred to Planning:**
- Exact mechanism for asking the user which ticket to use when none resolves (a typed free-text reply vs. a clickable follow-up, matching the multi-turn session patterns already in `sessionState.ts`).
- How `jira_uploadAttachment`'s `filePath` input is validated and resolved (workspace-relative vs. absolute), and which existing `pathSafety.ts` helper(s) apply to it.
- Exact intent-classification wording/triggers (e.g. "upload", "attach") to add to the existing LLM intent parser (`llmHelpers.ts`).

### Sources / Research

- `src/utils/attachmentEligibility.ts` — existing attachment-size and filename-matching helpers (`ATTACHMENT_SIZE_LIMIT`, `findAttachmentByFilename`, `formatFileSize`) that a download-side counterpart to this upload flow already establishes patterns for.
- `src/jira/JiraApiClient.ts` — existing `uploadAttachment()`, `MAX_ATTACHMENT_BYTES` (25 MB), `assertAttachmentWithinLimit()`, and `buildFileContentDisposition()`, currently only reachable via the email-import flow.
- `src/tools/jiraTools.ts` — existing `jira_*` Language Model tool pattern (KTD1 confirmation-independent re-validation, KTD6 statelessness) that `jira_uploadAttachment` follows.
- `src/participant/jira/ticketContext.ts` — `parseLastTicketFromContext()`, the existing last-referenced-ticket session mechanism reused for ticket resolution (R4).
