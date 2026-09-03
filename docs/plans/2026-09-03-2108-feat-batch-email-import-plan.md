---
title: Batch Email Import - Plan
type: feat
date: 2026-09-03
topic: batch-email-import
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Batch Email Import - Plan

## Goal Capsule

- **Objective:** A user creating Jira tickets from `.eml` files — from `@jira` chat or the Command Palette — always reviews and confirms a batch before any ticket is created (one file is simply a batch of one), picks a single shared template for the whole batch, and sees per-email failures skipped and reported rather than blocking the rest.
- **Means:** Unify all `.eml` ticket-creation entry points onto one multi-select code path, sharing one per-file parsing helper and extending the Veracode/Waltz report-import `ReportImportDescriptor` pattern with a third, email, kind (KTD1-KTD7).
- **Product authority:** User-directed (this conversation, brainstorm and planning sessions).
- **Stop conditions:** None — no open blockers.
- **Execution profile:** `code`, Standard depth, 5 implementation units.
- **Tail ownership:** Automated tests mock `vscode` directly (matching the existing `emailHandler.test.ts` pattern) and cover parsing, session building, and the review/creation loop. The implementer manually verifies the file picker and chat streaming in the Extension Development Host for all three entry points — mocks don't exercise a real VS Code dialog.

---

## Product Contract

**Product Contract preservation:** changed — R1-R8 renumbered from the brainstorm's R1-R9, and two brainstorm decisions were reversed this planning session: every import, including a single file, now always goes through the review screen (was: single-file stays unchanged, no review screen); and batch selection now spans every ticket-creation `.eml` entry point, not chat only (was: chat-only extension). See Key Technical Decisions KTD2, KTD3 for the rationale.

### Summary

Unify every `.eml` ticket-creation entry point — the chat-triggered picker and the Command Palette "Create Jira ticket from email" command — onto one multi-select file picker. Every selection, including a single file, goes through a review screen: pick one template/issue type for the batch, optionally exclude individual emails, then confirm to create one ticket per included email — skipping and reporting any that fail rather than aborting the batch.

### Problem Frame

Today's email import opens a file picker with `canSelectMany: false` in three separate places — `openEmailFilePicker` and `handleAddEmailFromChat` in `src/participant/jira/emailHandler.ts`, and the `ticket-sidekick.importEml` Command Palette command in `src/extension.ts` — each with its own copy of the same read-file-parse-build-session logic. Each run handles exactly one `.eml` file, with its own template/issue-type prompt and its own create-ticket confirmation. Importing several related emails (e.g. a folder of incident reports that should all become tickets under the same template) means running that entire dialogue once per file by hand, re-picking the same template each time, from whichever entry point the user started at.

### Requirements

**Selection & review**

- R1. Selecting `.eml` files for import supports choosing one or more files in a single file-picker invocation, from every ticket-creation entry point: the two chat-triggered code paths (`openEmailFilePicker`, reached via the `createFromEmail` intent, and `handleAddEmailFromChat`'s no-ticket-key branch, reached via the `addEmailComment` intent) and the Command Palette "Create Jira ticket from email" command. The "add email as a comment to an existing ticket" picker (used when a ticket key is present in the prompt) is unaffected and stays single-file.
- R2. Before any ticket is created — including when exactly one file was selected — the user sees a review screen listing every selected email (at minimum its subject) and picks one template, or one issue type when no template applies, used for the whole batch.
- R3. The review screen lets the user exclude individual emails before confirming; excluded emails are not turned into tickets.
- R4. The number of `.eml` files selectable in one run is capped; selecting more than the cap is rejected with a message naming the cap, rather than silently truncated or attempted.

**Batch creation & reporting**

- R5. Confirming the review creates one ticket per included email, using the batch's shared template/issue type and the same per-ticket field/attachment handling email import already performs.
- R6. A failure importing one email (parse failure, ticket-creation failure, attachment-upload failure) is reported for that email and does not stop the rest of the batch from being processed.
- R7. After the batch finishes, the user sees a summary: how many tickets were created, and which emails (if any) failed and why.
- R8. Every per-email failure and the batch-level outcome are logged via the existing `logDiag()` Output Channel convention (`src/utils/diagLog.ts`).

### Key Decisions

- **One shared template/issue type for the whole batch, not a per-email choice.** (session-settled: user-directed — chosen over letting each email pick its own template: matches how the feature was framed and keeps the review screen to one decision instead of one per email.) Governs R2, R5.
- **A confirmable review screen with per-email exclude**, mirroring the Veracode/Waltz batch-import review pattern. (session-settled: user-directed — chosen over going straight from file selection to creation: lets the user catch a wrong file or a bad subject before anything is written to Jira.) Governs R2, R3.
- **Every import always shows the review screen, including a batch of one — the old single-file-only flow is retired.** (session-settled: user-directed — reverses the brainstorm's original single-file-unchanged decision: a single file is simply a batch of one, so the codebase keeps one code path instead of two.) Governs R2.
- **Batch selection spans every ticket-creation `.eml` entry point** (chat-triggered picker and the Command Palette command), not chat only. (session-settled: user-directed — reverses the brainstorm's original chat-only scoping after research surfaced the Command Palette command as a duplicate, likely-primary entry point.) Governs R1.
- **The old single-email review's "reply with a ticket key to add this email as a comment instead" hint is dropped from the new batch review screen.** (session-settled: user-directed — chosen over carrying the hint into the batch flow: adding an email as a comment stays available only through the untouched, single-file comment-attach path.) Governs R1 (Scope Boundaries).
- **Skip-and-continue on a per-email failure, not all-or-nothing.** (session-settled: user-directed — chosen over aborting the whole batch: one bad email — unparseable, oversized attachment, a transient API error — shouldn't block tickets that would otherwise succeed.) Governs R6, R7.
- **Batch size is capped at the existing report-import batch limit (50) by default.** (session-settled: user-approved — the user accepted defaulting to the existing Veracode/Waltz `BATCH_LIMIT` unless a different number is wanted.) Governs R4.

### Key Flows

- F1. Batch email import
  - **Trigger:** User selects one or more `.eml` files from any ticket-creation entry point.
  - **Actors:** User, `@jira` chat participant.
  - **Steps:** Files are read and parsed; the review screen lists every parsed email's subject (and attachments, where present) alongside the batch's template/issue-type options; the user optionally excludes emails and confirms; tickets are created one per included email, each with its own attachment upload; failures are recorded and skipped; a summary is shown.
  - **Covers:** R1, R2, R3, R5, R6, R7.

### Acceptance Examples

- AE1. **Covers R1, R2.** Given the user selects exactly one `.eml` file from any ticket-creation entry point, When they confirm, Then it goes through the same review screen as a multi-file batch (template pick, exclude list, confirm) and produces one ticket.
- AE2. **Covers R2, R3.** Given the user selects three `.eml` files and excludes one on the review screen, When they confirm, Then exactly two tickets are created, both using the one template/issue type chosen on the review screen.
- AE3. **Covers R6, R7, R8.** Given one of three selected emails fails to parse, When the batch runs, Then the other two are still created, the summary names the failed email and the reason, and the failure is logged via `logDiag()`.
- AE4. **Covers R4.** Given the user selects more files than the batch cap allows, When they confirm the selection, Then the batch is rejected with a message naming the cap, and no files are parsed or ticketed.

### Scope Boundaries

- Parsing multiple tickets out of a single email (e.g. a forwarded digest or a list embedded in one message's body) — a materially different parsing problem from selecting several files; deferred.
- A batch-import tool for Copilot Agent Mode — no `jira_*` email tool exists today; this stays a chat- and Command-Palette-only extension of the existing email import.
- Deduping a batch's emails against tickets that already exist in Jira, the way Veracode/Waltz dedup by label — there is no reliable per-email dedup key, so this is not attempted.
- Per-email template or issue-type overrides within one batch — R2 fixes one choice for the whole batch.
- The "add email as a comment to an existing ticket" flow, when a ticket key is present in the prompt (`pendingCommentTicketKey` path in `emailHandler.ts`) — stays single-file and untouched; batching does not apply there.
- The old single-email review's per-email "reply with a ticket key to add as a comment instead" hint — not carried into the new batch review screen (see Key Decisions).

### Dependencies / Assumptions

- Assumes the existing per-ticket creation logic (`buildEmailJiraWiki`, attachment upload, `finishEmailTicket`'s creation step) continues to be the per-email unit of work the batch loop drives — no assumed change to how one email becomes one ticket.
- Assumes VS Code's native open-dialog (`canSelectMany: true`) is an acceptable UI for selecting several files; no custom picker is assumed.
- Assumes the old single-email ticket-creation preview/confirm code path (`streamEmailContentPreview`/`handleEmailContentSession`'s non-comment branches, `buildEmailCreateSession`) can be removed once every ticket-creation entry point routes through the email descriptor flow (see Planning Contract) — nothing reaches it anymore.

---

## Planning Contract

**Doc-review note:** the Planning Contract below reflects a post-review architecture change: email import extends the existing `ReportImportDescriptor` pattern (`src/participant/jira/reportImportHandler.ts`) as a third descriptor kind, rather than the new parallel `EmailBatchReviewSession` type first drafted. Chosen over the parallel-type draft after doc review flagged it as an unexamined default against `reportImportHandler.ts`'s own stated purpose ("so the two importers can't drift apart"); extending the descriptor also gets the two-stage template-then-review flow and the existing `AwaitIssueTypeResume` chat-detour for free. This changes only Planning Contract and Implementation Units — the Product Contract's Requirements, Key Decisions, and Acceptance Examples above are unaffected.

### Key Technical Decisions

- KTD1. **Email import becomes a third `ReportImportDescriptor` kind (`descriptorKind: 'email'`)**, reusing the shared `readAndFilterReport` / `streamImportTemplateSelection` / `handleImportTemplateSelection` / `streamImportReview` / `handleImportReviewReply` / `executeImportBatch` functions Veracode and Waltz already share in `reportImportHandler.ts`, rather than a new parallel session type. (session-settled: user-directed — chosen over building a new parallel `EmailBatchReviewSession` type: keeps one shared implementation for the parse → template-pick → review → batch-create flow instead of a third independently-maintained copy.) Governs R1-R7.
- KTD2. **The descriptor's dedup fields (`searchLabelOf`/`dedupKeyOf`/`labelToDedupKey`) become optional**; when a descriptor omits them, the "already ticketed" JQL search step is skipped entirely rather than run and found empty. The email descriptor omits them — there is no per-email dedup key. Governs R1.
- KTD3. **`ReportImportRow`'s dedup-shaped fields (`labels`, `summary`, `descriptionWiki`) move to a Veracode/Waltz-specific row extension**; the shared base row stays `ReviewRowBase`. The email descriptor defines its own row shape (subject, sender, receivedDateTime, markdown body, inline-image map, attachments, source file path). Governs R2, R3, R5.
- KTD4. **`executeImportBatch` gains an optional per-row post-creation hook** (Veracode/Waltz leave it unset); the email descriptor supplies attachment upload as that hook, running after ticket creation, with its own failure caught per-row without failing the row's already-created ticket. Governs R5, R6, R8.
- KTD5. **The descriptor's `parseAndFilter` contract (one file in, many items out) is adapted rather than reshaped** for email's one-file-per-item shape: the email descriptor's file-selection step (`canSelectMany: true`) calls the shared per-file parsing helper (`parseEmlFile`, added to `emailHandler.ts`, replacing today's three duplicated read-parse-build-fields blocks in `openEmailFilePicker`, `handleAddEmailFromChat`, and `extension.ts`) once per selected file and assembles the item list itself. Governs R1.
- KTD6. **The existing count cap is enforced at selection time, before any file is parsed** — reuses `BATCH_LIMIT` from `src/utils/reportImport.ts` (currently 50) rather than introducing a second constant. Governs R4.
- KTD7. **An aggregate attachment-byte cap is added, checked alongside the count cap, before any file is parsed** — mirroring the existing per-file `MAX_REPORT_BYTES` pattern, scaled to a batch total, so a large multi-file batch with sizable attachments can't hold hundreds of MB of base64 content in memory before the user has even seen the review screen. (session-settled: user-directed — chosen over accepting the gap as a known risk, after doc review flagged that the count cap alone doesn't bound memory.) Governs R4.

### Assumptions

- The Command Palette command's existing `.eml` filter and workspace-folder checks are unaffected by multi-select and need no separate handling beyond passing `canSelectMany: true` and wiring into the shared descriptor flow.
- Extending `AwaitIssueTypeResume`'s existing `'reportImport'` resume kind to also cover `descriptorKind: 'email'` (widening its `descriptorKind` union and session type) is sufficient — no new top-level resume kind is needed, since the email descriptor reuses the same chat-detour machinery Veracode/Waltz already resume through.

---

## Implementation Units

### U1. Add an `email` descriptor kind to `ReportImportDescriptor`

- **Goal:** Generalize the shared descriptor machinery so a third kind (email) can plug in with no dedup concept and with per-row attachment upload, and extract the shared per-file `.eml` parsing the email descriptor needs.
- **Requirements:** R1, R2, R5. KTD1, KTD2, KTD3, KTD5.
- **Dependencies:** None.
- **Files:**
  - `src/participant/jira/reportImportHandler.ts` (widen dedup fields to optional; skip the dedup search when absent; move `labels`/`summary`/`descriptionWiki` off the shared row base)
  - `src/participant/jira/emailHandler.ts` (add `parseEmlFile`; define the email descriptor and its row type)
  - `src/extension.ts` (import and use `parseEmlFile` instead of its inline copy)
  - `src/participant/sessionState.ts` (if the row-base split touches shared types)
  - `src/test/reportImportHandler.test.ts`
  - `src/test/emailHandler.test.ts`
- **Approach:**
  1. Add `parseEmlFile(filePath): Promise<ParsedEmailFile>` to `emailHandler.ts`: read the file, call `parseEml`, build `markdownBody` (`htmlToMarkdown` when an HTML body exists, else `plainBody`), build the inline-image map, and map attachments — the logic `openEmailFilePicker`, `handleAddEmailFromChat`, and `extension.ts` each already inline. Update `extension.ts`'s `ticket-sidekick.importEml` command to call it instead of its own inline copy.
  2. Widen `ReportImportDescriptor`'s `searchLabelOf`/`dedupKeyOf`/`labelToDedupKey` to optional; when unset, the dedup JQL search step is skipped rather than run.
  3. Move `labels`/`summary`/`descriptionWiki` off the shared row base (`ReportImportRow`) onto a Veracode/Waltz-specific row extension; confirm Veracode's and Waltz's existing descriptors and tests are unaffected by the split.
  4. Define the email descriptor: `fileFilter`/`filePickerTitle` for `.eml`, `descriptorKind: 'email'`, no dedup fields, and a `parseAndFilter` that calls `parseEmlFile` once per selected file and assembles the row list (adapting the one-file-to-many-items contract to email's one-file-per-row shape), `buildRowFields` mapping `parseEmlFile`'s output onto the email row type, and `reviewColumns` (subject, attachments).
- **Test scenarios:**
  - `parseEmlFile` returns the correct subject/sender/date/markdown body for an HTML-body `.eml` fixture, and falls back to `plainBody` when no HTML body is present.
  - `parseEmlFile` maps inline vs. non-inline attachments correctly, and rejects with a clear error on a read or parse failure (not swallowed).
  - A descriptor with no dedup fields set skips the "already ticketed" JQL search entirely (the search function is never invoked).
  - The email descriptor's `parseAndFilter` returns one row per selected file, including a failed-row marker for a file that couldn't be parsed.
  - Veracode's and Waltz's existing `reportImportHandler.test.ts` suites still pass unmodified after the row-base and dedup-field changes.
- **Verification:** `parseEmlFile` is the single place all three entry points build per-file fields; the email descriptor satisfies `ReportImportDescriptor`'s (now-widened) contract; `npm test` passes, including the unmodified Veracode/Waltz suites.

### U2. Wire all `.eml` entry points onto the email descriptor's multi-select flow

- **Goal:** All three ticket-creation entry points select one or more files and hand off into the shared descriptor-driven flow; the old single-email ticket-creation session/prompts are removed.
- **Requirements:** R1, R2. KTD1.
- **Dependencies:** U1.
- **Files:**
  - `src/participant/jira/emailHandler.ts`
  - `src/extension.ts`
  - `src/participant/JiraParticipant.ts` (route the email descriptor's `<!-- jira:email-template -->`/`<!-- jira:email-review -->`-equivalent tags the same way Veracode's/Waltz's are routed today)
  - `src/test/emailHandler.test.ts`
- **Approach:**
  1. Change `openEmailFilePicker`'s and the Command Palette command's `showOpenDialog` calls to `canSelectMany: true`.
  2. Change `handleAddEmailFromChat`'s no-ticket-key branch's `showOpenDialog` call to `canSelectMany: true` too — that branch already leads to ticket creation, not comment-attach. Its ticket-key-present branch (comment-attach) keeps `canSelectMany: false`, unchanged.
  3. Each entry point starts the shared descriptor flow (mirroring how the Veracode/Waltz handler wrappers in `veracodeHandler.ts`/`waltzHandler.ts` start theirs) instead of building an `EmailContentSession` for ticket creation. The Command Palette command writes its session under the email descriptor's own session key (not `jira.session.emailContent`) before opening chat.
  4. Remove the now-unreachable ticket-creation branches of `streamEmailContentPreview`/`handleEmailContentSession` and `buildEmailCreateSession` — the comment-attach (`pendingCommentTicketKey`) branch of `handleEmailContentSession` stays.
  5. Widen `AwaitIssueTypeResume`'s `'reportImport'` kind's `descriptorKind` union to include `'email'` (KTD1 Assumptions) so the existing NO_ISSUE_TYPE chat-detour resumes into the email descriptor's session the same way it resumes Veracode's/Waltz's.
- **Test scenarios:**
  - Selecting one file starts the descriptor flow with exactly one row and streams the template-selection screen (Covers AE1).
  - Selecting three files starts the flow with three rows.
  - One file failing to parse still starts the flow with the other files' rows plus a failed-row marker for the bad file.
  - The Command Palette command and the chat-triggered picker produce an equivalent session shape for the same input files, both under the email descriptor's session key.
  - `handleAddEmailFromChat` with a ticket key in the prompt is unchanged: single file, `EmailContentSession`, comment preview.
  - A project whose issue types can't be fetched resumes correctly through the widened `AwaitIssueTypeResume` path.
- **Verification:** No code path can still reach the old single-email ticket-creation prompts; `npm test` and `npm run compile` pass.

### U3. Batch caps and review: template/issue-type pick, exclude

- **Goal:** Enforce both the file-count cap and a new aggregate attachment-byte cap before parsing; the existing two-stage template-then-review flow (`streamImportTemplateSelection`/`handleImportTemplateSelection`, then `streamImportReview`/`handleImportReviewReply`) runs unmodified for the email descriptor.
- **Requirements:** R2, R3, R4. KTD1, KTD6, KTD7.
- **Dependencies:** U2.
- **Files:**
  - `src/participant/jira/emailHandler.ts`
  - `src/utils/reportImport.ts` (add the aggregate attachment-byte-cap constant)
  - `src/test/reportImportHandler.test.ts`
- **Approach:**
  1. Before parsing any file, check the selected file count against `BATCH_LIMIT`; if over, reject with a message naming the cap and parse nothing (unchanged from `BATCH_LIMIT`'s existing use).
  2. Add a new constant (e.g. alongside `MAX_REPORT_BYTES`) capping total attachment bytes across the selected files; check it the same way, before any file is parsed, and reject naming the cap if exceeded.
  3. No new review-screen code: the email descriptor plugs into `streamImportTemplateSelection`/`streamImportReview` exactly as Veracode/Waltz do.
- **Test scenarios:**
  - Picking a template resolves and applies its default fields to every included row (existing shared-function coverage, exercised against the email descriptor).
  - Toggling a row's include flag persists across a reply that doesn't confirm.
  - Selecting more files than the count cap is rejected before any parsing, naming the cap (Covers AE4).
  - Selecting files whose combined attachment size exceeds the new aggregate cap is rejected before any parsing, naming the cap.
  - Cancelling clears the session and creates nothing.
- **Verification:** The review screen behaves identically in shape to the Veracode/Waltz review table for the same row count; `npm test` passes.

### U4. Batch ticket creation: attachment upload, skip-and-continue, summary, logging

- **Goal:** `executeImportBatch` creates one ticket per included row and, via the email descriptor's post-creation hook (KTD4), uploads that row's attachments; a per-row failure (creation or upload) is skipped and recorded rather than aborting the batch; the existing summary and `logDiag` behavior covers the outcome.
- **Requirements:** R5, R6, R7, R8. KTD4.
- **Dependencies:** U3.
- **Files:**
  - `src/participant/jira/reportImportHandler.ts` (add the optional post-creation hook to `executeImportBatch`)
  - `src/participant/jira/emailHandler.ts` (supply the attachment-upload hook)
  - `src/test/reportImportHandler.test.ts`
- **Approach:**
  1. Add an optional per-row post-creation hook to `executeImportBatch` (e.g. `afterCreate?: (row, issueKey, ticketService) => Promise<void>`); Veracode and Waltz leave it unset.
  2. The email descriptor's hook uploads the row's attachments (`ticketService.uploadAttachment`) and catches its own failure per-row (mirroring today's existing attachment-upload try/catch + `logDiag('jira.email', 'warn', ...)` pattern) without failing the row's already-created ticket.
  3. `executeImportBatch`'s existing created/failed counters, summary line, and `logDiag` calls cover the batch outcome unmodified.
- **Test scenarios:**
  - All rows succeed: summary reports N created, 0 failed.
  - One row's ticket creation throws: the other rows still create, and the summary lists the failed subject and reason (Covers AE3).
  - One row's attachment-upload hook fails: the ticket is still created, a warning is shown for that row, the batch continues.
  - `logDiag` is called once per failed row and once for the batch-level summary (Covers R8).
  - Veracode's/Waltz's existing `executeImportBatch` test coverage still passes with the hook left unset.
- **Verification:** A batch with a mixed pass/fail row set creates every passing row's ticket, uploads attachments for the successful ones, and reports every failing row by subject and reason; `npm test` passes.

### U5. Documentation

- **Goal:** Record the new descriptor kind and flow per the project's documentation convention for new multi-step flows.
- **Requirements:** none (documentation only).
- **Dependencies:** U1, U2, U3, U4.
- **Files:**
  - `docs/report-import.md` (add the email descriptor kind alongside Veracode/Waltz)
  - `docs/jira-flows.md` (add the email descriptor's session key/tag to the Jira Sessions table)
  - `CLAUDE.md` ("Jira flows" and "Report import" sections: one-line mention of batch email import as a third descriptor kind)
- **Test expectation:** none — documentation only, no behavioral change.
- **Verification:** `docs/report-import.md`, `docs/jira-flows.md`, and `CLAUDE.md` all mention the email descriptor kind.

---

## Verification Contract

| Command | Applies to | Done signal |
|---|---|---|
| `npm run compile` | All units | `tsc` reports no errors |
| `npm test` | All units | All Vitest suites pass, including the tests added/updated in U1-U4 and the unmodified Veracode/Waltz suites |

Manual verification (Extension Development Host): for each of the three entry points, select one file and confirm the template/review screens appear and create the ticket; select several files and confirm the review screen, exclude, and batch creation all behave as specified; confirm Veracode and Waltz report import still work unchanged.

## Definition of Done

- `npm run compile` and `npm test` are both green, including new coverage from U1-U4 and unmodified Veracode/Waltz coverage.
- All three `.eml` ticket-creation entry points route through the email `ReportImportDescriptor` flow; the old single-email ticket-creation prompts (`streamEmailContentPreview`/`handleEmailContentSession`'s non-comment branches, `buildEmailCreateSession`) are removed, not left dead in the diff.
- The comment-attach (`pendingCommentTicketKey`) flow is verified unchanged (still single-file, still `EmailContentSession`).
- Veracode and Waltz report import are verified unaffected by the shared-code changes (dedup-fields-optional, row-base split, `executeImportBatch` hook).
- `docs/report-import.md`, `docs/jira-flows.md`, and `CLAUDE.md` reflect the new descriptor kind (U5).
- Manual verification in the Extension Development Host confirms all three entry points for both a single file and a multi-file batch.
