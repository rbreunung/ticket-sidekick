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
- **Open blockers:** None.

---

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

- R1. When the user explicitly names an absolute or relative file path in the message, the flow uses that path directly. Otherwise, it resolves the target file(s) from any file references attached to the chat message — all of them, treated as a batch per R8, not just the first — or, if none is attached, the file currently open and active in the editor.
- R2. If no file resolves from an explicit path, a chat attachment, or the active editor, the flow opens a native multi-select file picker.
- R3. An explicit path named in the message (R1) always wins — the flow never consults the chat attachment or active editor when one is present.
- R4. The flow resolves the target ticket key by checking, in order: an explicit ticket key in the message text; a ticket key embedded in the resolved file's name; the ticket last referenced in the current chat session.
- R5. If no ticket key resolves from any source in R4, the flow asks the user explicitly which ticket to use rather than guessing.
- R6. Before uploading, the flow shows a confirmation naming the file name(s), size(s), and target ticket, and proceeds only after the user confirms.
- R7. A file the flow uploads must be at or under the existing 25 MB attachment size limit (`MAX_ATTACHMENT_BYTES`); an oversized file is rejected before upload with a message naming the file and the limit.
- R8. When multiple files are selected via the picker or attached to the chat message, the flow uploads each to the same resolved ticket and reports per-file success or failure.

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

**Product Contract preservation:** unchanged. Its former Outstanding Questions (ask-mechanism, `filePath` validation, intent-classification wording) are resolved below as KTD4, KTD5, and Unit U2's Approach, respectively.

### Sources / Research

- `src/utils/attachmentEligibility.ts` — existing attachment-size and filename-matching helpers (`ATTACHMENT_SIZE_LIMIT`, `findAttachmentByFilename`, `formatFileSize`) that a download-side counterpart to this upload flow already establishes patterns for.
- `src/jira/JiraApiClient.ts` — existing `uploadAttachment()`, `MAX_ATTACHMENT_BYTES` (25 MB), `assertAttachmentWithinLimit()`, and `buildFileContentDisposition()`, currently only reachable via the email-import flow.
- `src/tools/jiraTools.ts` — existing `jira_*` Language Model tool pattern (its own code-comment KTD1: confirmation-independent re-validation; KTD6: statelessness) that `jira_uploadAttachment` follows.
- `src/participant/jira/ticketContext.ts` — `parseLastTicketFromContext()`, the existing last-referenced-ticket session mechanism reused for ticket resolution (R4).
- `src/participant/jira/emailHandler.ts` and `src/participant/jira/cleanupHandler.ts` — existing multi-select `showOpenDialog` picker usage and `workspaceState`-backed review-session (confirm/cancel `buildChatCommandLink`) patterns this plan's chat flow reuses.
- `src/test/emailHandler.test.ts` — precedent for Vitest-testing a `vscode`-importing handler file via an inline `vi.mock('vscode', ...)`, reused for this plan's handler tests.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Reuse `extractTicketId` (`src/utils/branchParser.ts`) for ticket-key detection in message text and filenames.** The codebase already has one canonical `[A-Z][A-Z0-9]+-\d+` matcher (used today for branch names); a second hand-rolled regex would drift from it. Governs R4.
- KTD2. **Reuse `MAX_ATTACHMENT_BYTES` and `formatFileSize` (`src/jira/JiraApiClient.ts`, `src/utils/attachmentEligibility.ts`) as the single size-limit source for both the chat flow and the tool.** Avoids a second, divergent 25 MB constant. Governs R7, R11.
- KTD3. **The pre-upload confirmation is a new `UploadReviewSession` stored in `workspaceState`, mirroring `TransitionBatchSession`'s confirm/cancel `buildChatCommandLink` pattern (`cleanupHandler.ts`).** VS Code's native tool-confirmation dialog only exists for Language Model tool calls, not natural-language chat turns, so the chat flow needs its own session-backed confirmation. Governs R6.
- KTD4. **When no ticket resolves (R5), the flow asks via a plain free-text follow-up (`AwaitUploadTicketSession`), mirroring `AwaitIssueTypeSession` (`ticketContext.ts`) rather than a clickable list.** A ticket key is open-ended input, not a bounded option set, so a numbered pick-list doesn't fit. Resolves the Product Contract's former ask-mechanism question. Governs R5.
- KTD5. **`jira_uploadAttachment`'s `filePath` needs no new path-safety helper.** Unlike `ticketKey` (interpolated into a REST URL segment, guarded by `isSafePathSegment`), `filePath` is read directly via `vscode.workspace.fs.readFile` and never interpolated into a URL; the outgoing attachment filename is already sanitized by `buildFileContentDisposition()`. `invoke()` validates only existence, that it is a regular file, and the size cap. Resolves the Product Contract's former `filePath`-validation question. Governs R9, R11.
- KTD6. **New per-flow handler file `src/participant/jira/uploadHandler.ts`**, matching the existing one-file-per-flow convention (`emailHandler.ts`, `cleanupHandler.ts`, `loadHandler.ts`). Governs R1-R8.
- KTD7. **`jira_uploadAttachment` uses a `RecentCallGuard`, like `jira_addComment`/`jira_createTicket`.** Jira does not dedupe attachments by filename (per `findAttachmentByFilename`'s doc comment), so a retried Agent Mode call with identical input would otherwise create a duplicate attachment with no reconciliation. Governs R9, R12.

### Assumptions

- `request.references` (VS Code's chat-attached-file mechanism) is read the same way for a dragged/`#file:`-attached file regardless of file type — no per-type handling is needed for R1.
- `TicketService.uploadAttachment()`'s existing signature (`issueKey, filename, contentType, contentBytes`) needs no change; `contentType` is inferred from the file extension with a generic `application/octet-stream` fallback, matching how `emlParser.ts`'s attachment parsing already infers it for email attachments.

---

## Implementation Units

### U1. Pure ticket resolution and upload session types

- **Goal:** Add the reusable, Vitest-testable pieces the chat flow and its confirmation depend on — ticket-key resolution ordering, confirmation/result message formatters, and the new session types.
- **Requirements:** R4, R5, R6, R7, R8. KTD1, KTD2.
- **Dependencies:** None.
- **Files:**
  - `src/participant/sessionState.ts` (add `UploadReviewSession`, `AwaitUploadTicketSession` types; extend `JiraSessionContinuity['kinds']` with `'upload-review'` and `'await-upload-ticket'`; add `resolveTicketKeyForUpload()`, `buildUploadConfirmationMessage()`, `buildUploadResultMessage()`)
  - `src/test/uploadHandler.test.ts` (new — pure-helper cases; also houses U2's handler tests)
- **Approach:**
  1. `resolveTicketKeyForUpload(promptText, resolvedFilename, lastTicketKey)` checks, via `extractTicketId` (KTD1), the prompt text, then the filename, then falls back to `lastTicketKey`; returns the first match or `null` (R4).
  2. `UploadReviewSession` carries `ticketKey`, `schemaVersion`, and pending files as `{ name, size, contentType, base64Content }[]`.
  3. `AwaitUploadTicketSession` carries the same pending-files shape without a `ticketKey`, for the R5 ask-explicitly path.
  4. `buildUploadConfirmationMessage(ticketKey, files)` renders one line per file with `formatFileSize` (KTD2) plus Confirm/Cancel `buildChatCommandLink`s (R6).
  5. `buildUploadResultMessage(ticketKey, results: { name, ok, error? }[])` renders per-file success/failure (R8).
- **Test scenarios:**
  - `resolveTicketKeyForUpload`: a ticket key in the prompt text wins over one in the filename and over `lastTicketKey`.
  - No key in text, a key in the filename: filename wins over `lastTicketKey`.
  - No key in text, filename, or `lastTicketKey`: returns `null`. Covers AE3.
  - `buildUploadConfirmationMessage`: single file renders name, size, and ticket; three files render one line each. Covers AE4.
  - `buildUploadResultMessage`: a mixed success/failure result set renders each file's own outcome. Covers AE4.
- **Verification:** `npm test` passes the new cases; `npm run compile` is clean.

### U2. Chat upload flow (`uploadHandler.ts`) and intent routing

- **Goal:** Implement the `@jira` upload flow end-to-end — file/ticket resolution, the review-session confirmation, execution, and its two resume paths — wired through a new `uploadAttachment` intent operation.
- **Requirements:** R1, R2, R3, R4, R5, R6, R7, R8. KTD3, KTD4, KTD6.
- **Dependencies:** U1.
- **Files:**
  - `src/participant/jira/uploadHandler.ts` (new)
  - `src/participant/jira/llmHelpers.ts` (add `'uploadAttachment'` to `Operation`; extend `INTENT_PROMPT` and `ParsedIntent` with an optional `filePath` field)
  - `src/participant/JiraParticipant.ts` (route the `uploadAttachment` operation to `handleUploadAttachment`; route resumed `upload-review` confirm/cancel replies and `await-upload-ticket` replies to their handlers)
  - `src/test/uploadHandler.test.ts` (handler-level cases, mocking `vscode` inline per `emailHandler.test.ts`'s precedent)
  - `src/test/JiraParticipant.test.ts` (intent-parsing cases for the new operation)
- **Approach:**
  1. File resolution order (R1-R3; Covers AE2): an absolute/relative path found in `request.prompt` — the same `filePath` `llmHelpers.ts` already extracts via LLM intent parsing, not a second independent extractor — wins outright per R3. Only when no path is given: all file references on `request.references` (every chat-attached file, not just the first — R8) → else `vscode.window.activeTextEditor`'s document URI → else `vscode.window.showOpenDialog({ canSelectMany: true })`.
  2. Resolve the ticket via `resolveTicketKeyForUpload(request.prompt, resolvedFilename, parseLastTicketFromContext(context))` (U1). No match: build an `AwaitUploadTicketSession` from the already-resolved file(s), store it, ask in chat, and return `{ metadata: { jiraSession: { kinds: ['await-upload-ticket'] } } }` (KTD4).
  3. Read each resolved file's bytes (`vscode.workspace.fs.readFile`); if any file exceeds `MAX_ATTACHMENT_BYTES`, reject the whole batch before building a session, naming the oversized file(s) (R7; Covers AE1).
  4. Build the `UploadReviewSession`, store it, stream `buildUploadConfirmationMessage`, return `{ metadata: { jiraSession: { kinds: ['upload-review'] } } }` (KTD3).
  5. On a confirm reply: call `ticketService.uploadAttachment(ticketKey, name, contentType, base64Content)` per file sequentially, collect per-file outcomes, stream `buildUploadResultMessage` (R8). On a cancel reply: clear the session and acknowledge.
  6. On an `await-upload-ticket` reply: parse the reply for a ticket key via the same `extractTicketId` check, then continue at step 3 with the previously resolved files.
- **Technical design (directional):**
  ```
  handleUploadAttachment(request, stream, ctx):
    files = fromExplicitPath(request.prompt) ?? fromChatReferences(request) ?? fromActiveEditor() ?? await pickFiles()
    if !files: return
    ticket = resolveTicketKeyForUpload(request.prompt, files[0].name, lastTicketKey(ctx))
    if !ticket: return askForTicket(files)   // KTD4
    return reviewAndConfirm(ticket, files)   // KTD3
  ```
- **Test scenarios:**
  - No chat reference, no active editor, no path in the prompt: `showOpenDialog` is invoked with `canSelectMany: true`. Covers AE2.
  - An explicit path in the prompt and an unrelated file open in the active editor: the explicit path wins, per R3.
  - Two files attached to the chat message (`request.references` has two entries): both are resolved and carried into the `UploadReviewSession`, not just the first — per R1/R8.
  - A resolved file over 25 MB: the batch is rejected before a session is stored, naming the file and the limit. Covers AE1.
  - Three files resolved via the picker, all within the limit: `UploadReviewSession` carries all three; confirming uploads each and reports per-file outcomes. Covers AE4.
  - A resolved file with no ticket key anywhere: an `AwaitUploadTicketSession` is created and the chat asks explicitly, uploading nothing yet. Covers AE3.
  - Confirm reply on a stored `UploadReviewSession`: `ticketService.uploadAttachment` is called once per pending file with the right arguments.
  - Cancel reply on a stored `UploadReviewSession`: no upload call happens and the session is cleared.
  - `llmHelpers.ts`/`JiraParticipant.test.ts`: prompt "upload the report to PROJ-123" parses to `operation: 'uploadAttachment'`, `ticketKey: 'PROJ-123'`.
  - `llmHelpers.ts`/`JiraParticipant.test.ts`: prompt "upload report.pdf" (no ticket key) parses with `ticketKey: null`, `filePath: 'report.pdf'`.
- **Verification:** `npm test` passes all cases above; `npm run compile` is clean. A manual Extension Development Host pass exercises the real file picker and active-editor resolution end-to-end (per CLAUDE.md's Testing section: real `vscode` UI interaction beyond what the inline mock covers is checked manually).

### U3. `jira_uploadAttachment` Language Model tool

- **Goal:** Add the Agent Mode tool counterpart with fully explicit inputs, following the existing `jira_*` write-tool pattern.
- **Requirements:** R9, R10, R11, R12. KTD2, KTD5, KTD7.
- **Dependencies:** None (independent of U1/U2 — reuses `TicketService.uploadAttachment` directly, not the chat session types).
- **Files:**
  - `src/tools/jiraTools.ts` (add `UploadAttachmentTool` class; register `jira_uploadAttachment` in `registerJiraTools()`)
  - `src/participant/sessionState.ts` (add `buildUploadAttachmentConfirmation(ticketKey, filePath, size)`)
  - `package.json` (add the `jira_uploadAttachment` entry under `contributes.languageModelTools`, mirroring `jira_downloadAttachment`'s shape)
  - `src/test/jiraTools.test.ts` (new tool's cases)
- **Approach:**
  1. `prepareInvocation()` best-effort-stats the file (existence, size) the same way `UpdateFieldTool`/`TransitionTicketTool` best-effort-fetch current state — never throws — and calls `buildUploadAttachmentConfirmation` (R10).
  2. `invoke()` re-validates independently (KTD1 in `jiraTools.ts`'s own header comment): non-empty `ticketKey` validated with `isSafePathSegment`, non-empty `filePath`, the file exists and is a regular file, and its size is at or under `MAX_ATTACHMENT_BYTES` (KTD2, KTD5) — reject before any Jira call.
  3. Claim a `RecentCallGuard` fingerprint on `(ticketKey, filePath)` before uploading (KTD7); release it on a validation failure or a failed upload, same pattern as `AddCommentTool`.
  4. On success, call `ticketService.uploadAttachment(ticketKey, path.basename(filePath), inferredContentType, base64Content)` and return a short confirmation text naming the ticket and filename.
- **Test scenarios:**
  - Missing `ticketKey` or `filePath`: `invoke()` returns a validation message and uploads nothing. Covers AE5.
  - An unsafe `ticketKey` (contains `/`): rejected by `isSafePathSegment` before any Jira call.
  - A `filePath` that does not exist: `invoke()` returns a not-found message and uploads nothing.
  - A `filePath` over 25 MB: rejected before upload, naming the limit. Covers AE1.
  - A valid `ticketKey` and `filePath` within the limit: `TicketService.uploadAttachment` is called once with the expected arguments (via `MockJiraClient`'s `uploadAttachmentCalls`).
  - A repeated identical call within the guard window: the second call is skipped as a likely duplicate, matching `AddCommentTool`'s existing dedup message shape.
- **Verification:** `npm test` passes all cases above; `npm run compile` is clean.

### U4. Documentation

- **Goal:** Keep `CLAUDE.md` and `docs/jira-flows.md` in sync with the new flow and file, per the "Adding a new Jira operation" checklist and "Where documentation belongs."
- **Requirements:** None directly — process requirement from `CLAUDE.md` itself.
- **Dependencies:** U2, U3.
- **Files:**
  - `CLAUDE.md` (add `src/participant/jira/uploadHandler.ts` to the Key Files table)
  - `docs/jira-flows.md` (one-line summary of the upload flow plus a link, per "Where documentation belongs")
- **Approach:** Mirror the existing one-line-per-file style already used for `emailHandler.ts`/`cleanupHandler.ts` in `CLAUDE.md`'s table; add the upload flow's one-liner to `docs/jira-flows.md` without duplicating flow prose there (full detail stays in this plan and the code).
- **Test scenarios:** Test expectation: none — documentation only.
- **Verification:** A reviewer can find the new file and flow from `CLAUDE.md`/`docs/jira-flows.md` alone.

---

## Verification Contract

| Command | Applicability | Gate |
|---|---|---|
| `npm run compile` | All units | TypeScript type check must pass with no errors |
| `npm test` | U1, U2, U3 | All new and existing Vitest cases pass |
| Manual Extension Development Host check | U2 | File picker, active-editor resolution, and an end-to-end upload against `MockJiraClient` or a real ticket behave as specified (CLAUDE.md: `vscode`-importing UI interaction beyond the inline mock is checked manually, not by `npm run test:e2e`, which this repo does not run in CI) |

---

## Definition of Done

- All Implementation Units (U1-U4) are complete and their test scenarios pass.
- `npm run compile` and `npm test` are green.
- `docs/jira-flows.md` and `CLAUDE.md`'s Key Files table reference the new upload flow and file (U4).
- No dead-end or experimental code from abandoned approaches remains in the diff.
