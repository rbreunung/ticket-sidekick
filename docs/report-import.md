# Report Import (EML, Veracode, Waltz)

How `@jira` turns an `.eml` email, a Veracode Detailed Report, or a Waltz OSS
Report into Jira tickets.

The code lives in:

- [`src/utils/emlParser.ts`](../src/utils/emlParser.ts) — `.eml` parsing (`postal-mime`), plus `parseEmlFile()` (one file → one batch item) and the `EmailImportItem`/`EmailReviewRow` types.
- [`src/participant/jira/emailHandler.ts`](../src/participant/jira/emailHandler.ts) — batch email-to-ticket chat flow (the `email` `ReportImportDescriptor`) and the untouched single-file comment-attach flow.
- [`src/utils/reportImport.ts`](../src/utils/reportImport.ts) — shared, `vscode`-free primitives used by all three importers, including `BATCH_LIMIT` and `MAX_EMAIL_BATCH_BYTES`.
- [`src/participant/jira/reportImportHandler.ts`](../src/participant/jira/reportImportHandler.ts) — shared session-flow orchestration for all three report importers; dedup fields on `ReportImportDescriptor` are optional, and `buildTicketFields`/`afterCreate` let an importer with no `labels`/`descriptionWiki` concept (email) still drive the same `executeImportBatch`.
- [`src/utils/veracodeReport.ts`](../src/utils/veracodeReport.ts) / [`src/participant/jira/veracodeHandler.ts`](../src/participant/jira/veracodeHandler.ts) — Veracode-specific parsing and thin wrapper.
- [`src/utils/waltzReport.ts`](../src/utils/waltzReport.ts) / [`src/participant/jira/waltzHandler.ts`](../src/participant/jira/waltzHandler.ts) — Waltz-specific parsing and thin wrapper.
- [`src/services/TicketService.ts`](../src/services/TicketService.ts) — `searchTicketsRaw` (dedup search) and `createTicket` (batch creation) backing all three importers.
- [`src/participant/sessionState.ts`](../src/participant/sessionState.ts) — `pickEmailOption()`, reused by all three importers for template/issue-type selection.

## EML email import (batch)

Users download `.eml` files from OWA via **More actions → Download message** and import one or more of them in a single run — every selected file becomes a candidate ticket, reviewed together and created as a batch. See `docs/plans/2026-09-03-2108-feat-batch-email-import-plan.md` for the batching decisions and rationale.

Email import is the third `ReportImportDescriptor` kind (`descriptorKind: 'email'`), reusing the same shared session flow, review screen, and batch-creation machinery the OSS/vulnerability importers below already share — see that section for the mechanics common to all three. Email supplies no dedup fields (there is no per-email dedup key, so the "already ticketed" search step is skipped entirely) and its own `buildTicketFields` (subject → summary, `buildEmailJiraWiki(markdownBody)` → description) and `afterCreate` hook (per-ticket attachment upload, then the `ticketSidekick.email.deleteEmlAfterImport` cleanup step).

### Import flow

1. Any of three entry points: Command Palette → **Ticket Sidekick: Create Jira ticket from email (.eml)** (multi-select file picker), `@jira create from email` / `@jira import email` in chat (multi-select), or `@jira add email` with no ticket key in the prompt (also routes into batch creation — only a prompt naming a ticket key stays single-file, adding the email as a comment instead)
2. Before any file is read: the selected-file count is checked against `BATCH_LIMIT` (50), and the selected files' total size against `MAX_EMAIL_BATCH_BYTES` (150 MB) — both in `src/utils/reportImport.ts`. Either cap being exceeded rejects the whole selection with a message naming the cap
3. `parseEmlFile(filePath)` (`src/utils/emlParser.ts`) reads and parses each selected file (via `parseEml`/postal-mime), converting the HTML body to Markdown (`htmlToMarkdown`) with `[📎 name]` placeholders for inline images. A file that fails to parse is reported immediately and excluded — the rest of the batch still proceeds
4. `EmailTemplateSelectionSession` stored in `workspaceState('jira.session.emailTemplateSelection')`; chat opened (or continued) with the template/issue-type picker — **one shared template/issue type for the whole batch**, not a per-email choice
5. `EmailReviewSession` stored in `workspaceState('jira.session.emailReview')` — the review table lists every email's subject and non-inline attachment names; user replies **ok** / **(c)** / a list of row ids to toggle inclusion, exactly like Veracode/Waltz's review screen
6. On **ok**, one ticket is created per included email (skip-and-continue: a single email's creation failure is reported and does not stop the rest), each with `buildEmailJiraWiki(markdownBody)` as the description and its own attachments uploaded afterward; if `ticketSidekick.email.deleteEmlAfterImport: true`, the source `.eml` is deleted after each successful creation (non-fatal)

The "add email as a comment to an existing ticket" flow (a ticket key present in the `@jira add email ...` prompt) is unaffected by any of the above — it stays single-file, using `EmailContentSession`/`workspaceState('jira.session.emailContent')` and `handleEmailContentSession`.

### `pickEmailOption` helper

`pickEmailOption(n, templates, issueTypes)` in `sessionState.ts` maps a 1-based user reply index to a template or issue type pick. Templates occupy indices 1..N, issue types N+1..N+M. Returns `{ kind: 'template', name, issueType }` or `{ kind: 'type', issueType }` or `null` if out of range.

## OSS/vulnerability report import (Veracode + Waltz) and email

Veracode, Waltz, and email import share one implementation — `src/participant/jira/reportImportHandler.ts` + `src/utils/reportImport.ts` — for session flow, dedup search, the review-table/toggle-reply UX, and batch ticket creation. Each importer supplies only its own parser, config, and ticket-field-building specifics via a `ReportImportDescriptor` passed from its thin wrapper (`veracodeHandler.ts`/`waltzHandler.ts`/`emailHandler.ts`). This means: dedup search is fault-tolerant per chunk and JQL-quoted where an importer has a dedup key (Veracode/Waltz), or skipped entirely where it doesn't (email); a picked template that vanishes before the user replies produces the same warning for all three; all three cap "new" rows at `BATCH_LIMIT` before building them and show the same "N more matched, re-run to get them" note; all three link to each newly created ticket in the per-item progress output, and any importer may supply an `afterCreate` hook for per-row work after ticket creation (email uses this for attachment upload). A behavior difference between importers on shared ground is a bug, not a feature — see `docs/plans/2026-08-13-001-refactor-consolidate-report-importers-plan.md` for the original Veracode/Waltz consolidation rationale and `docs/plans/2026-09-03-2108-feat-batch-email-import-plan.md` for email's extension of the same pattern.

### Veracode report import

Users export a Detailed Report XML from Veracode and import it via the VS Code command or directly from chat (`@jira import veracode report`).

1. Command Palette → **Ticket Sidekick: Create Jira tickets from Veracode report (.xml)** (or trigger from chat, which opens its own file picker)
2. `parseVeracodeReport(xml)` (own parser, `fast-xml-parser`-based) extracts all `<staticflaws>` entries; rejected up front if the file exceeds 20 MB or contains a `<!DOCTYPE`/`<!ENTITY` declaration. `issueId` and `cweId` are each validated numeric (`ISSUE_ID_PATTERN`/`CWE_ID_PATTERN`) at parse time — a malformed `cweId` becomes `null` rather than surviving into a generated CWE-database URL
3. `filterFlaws()` applies `ticketSidekick.veracode.minSeverity` and `ticketSidekick.veracode.includeRemediationStatuses`
4. `VeracodeTemplateSelectionSession` stored in `workspaceState('jira.session.veracodeTemplateSelection')`; chat opened with `@jira import veracode report`
5. User picks a template or issue type (`pickEmailOption()`, reused from the email flow) → `FieldResolver.resolve()` resolves the template's fields
6. De-dup search (via the shared `reportImport.ts` primitives): `TicketService.searchTicketsRaw` is called in chunks of 40 issue ids with a quoted `labels in ("veracode-issue-<id>", ...)` JQL clause; a failed chunk is logged and skipped without discarding matches already found by other chunks; matches become the "Already ticketed" section of the review screen (excluded by default, toggleable back in)
7. `VeracodeReviewSession` stored in `workspaceState('jira.session.veracodeReview')`; "new" rows are capped at `BATCH_LIMIT` (50) before the session is built, with `totalNewMatched` noting how many more exist (this cap-and-resume behavior is new for Veracode as of the consolidation — a report with more than 50 new flaws previously showed them all on one screen). User replies **ok** / **(c)** / a list of row ids to toggle inclusion
8. On **ok**, up to `BATCH_LIMIT` tickets are created via the existing `TicketService.createTicket` — one per included flaw, each labeled `veracode`, `veracode-issue-<id>`, `cwe-<id>` (merged with any template labels), with a Markdown-authored description (converted to Jira wiki via `markdownToJiraWiki()`, every untrusted field sanitized) covering Severity, CWE + link, Location, Description, Recommendation, Veracode Issue ID; each per-ticket progress line links to the created ticket when a Jira base URL is configured

#### Known limitation

The multi-step vulnerability data-path trace shown in Veracode's web UI ("Injection Point → ... → Flaw") is **not present** in the Detailed Report XML format — confirmed by full XSD schema review and empirical inspection of a real report. Only the flaw's own `description` attribute (which sometimes names generic tainted-source APIs, but not the actual call chain) is available and is included (sanitized) in the ticket. Full data-path support would require a different Veracode API/export (e.g. the Findings REST API) and is out of scope for this feature.

### Waltz OSS report import

Users export an "OSS Report" `.xlsx` from Waltz (or a compatible SCA tool) and import it via the VS Code command or directly from chat (`@jira import oss report`).

1. Command Palette → **Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)** (or trigger from chat, which opens its own file picker)
2. `parseWaltzReport(buffer)` (`exceljs`-based — `workbook.xlsx.load()`, which reads the ZIP via `jszip`'s central-directory-first parsing rather than a sequential/streaming reader, so it doesn't choke on real-world exports written by streaming XLSX writers; a prior `read-excel-file`/`unzipper-esm` build threw `Couldn't unzip \`.xlsx\` file contents` on exactly this class of file even though Excel opened it fine — see `docs/solutions/` for the write-up) joins the required `ComponentRemediations` sheet with the optional `VersionInstances`/`Vulnerabilities` sheets on `Component name and version`; guarded by a 20 MB size cap and a `PARSE_TIMEOUT_MS` (15s) hard ceiling. The timeout is a `Promise.race`, not a true cancellation — it bounds how long the user waits before seeing an error on a pathological (e.g. decompression-bomb-style single-entry) `.xlsx`, but the underlying parse keeps consuming CPU/memory in the background after it fires; it does not itself prevent resource exhaustion
3. `filterComponents()` applies `ticketSidekick.waltz.minVulnRating` and `ticketSidekick.waltz.includeRemediationActions`
4. `WaltzTemplateSelectionSession` stored in `workspaceState('jira.session.waltzTemplateSelection')`; chat opened with `@jira import oss report`
5. User picks a template or issue type (`pickEmailOption()`, reused from the email flow) → `FieldResolver.resolve()` resolves the template's fields
6. De-dup search (via the shared `reportImport.ts` primitives): `TicketService.searchTicketsRaw` is called in chunks of 40 sanitized component labels with a `labels in ("oss-dep-...", ...)` JQL clause; matches become the "Already ticketed" section of the review screen (excluded by default, toggleable back in). A dedup-search failure degrades gracefully (empty dedup map + warning) rather than aborting the import
7. `WaltzReviewSession` stored in `workspaceState('jira.session.waltzReview')`; "new" (not-yet-ticketed) rows are capped at `BATCH_LIMIT` (50) before the session is built — `totalNewMatched` records the true match count so the review screen can note how many more exist and that re-running the import (after this batch completes) picks up the rest via the same dedup mechanism. User replies **ok** / **(c)** / a list of row ids to toggle inclusion
8. On **ok**, up to `BATCH_LIMIT` tickets are created via the existing `TicketService.createTicket` — one per included component, labeled `oss-dependency` + a sanitized, hash-suffixed component label (merged with any template labels), with a Markdown-authored description (converted to Jira wiki via `markdownToJiraWiki()`) covering max vuln rating, the single most critical CVE, affected artifacts (capped at 25, "+N more"), and a "Known vulnerabilities" table (capped at 10, "+N more")

#### Component labels

`sanitizeComponentLabel()` lowercases and hyphenates disallowed separators (dots pass through unchanged, so version numbers like `1.2.3` stay readable), then appends a 6-hex-char SHA-256-derived hash of the *raw* `nameVersion` — this keeps the label human-readable while making it collision-safe as the sole dedup key, since two distinct components (e.g. differing only in a separator character) can otherwise sanitize to the identical readable text.

#### Known limitation

The report's real-world schema (sheet names, column headers) was validated against a single inspected `.xlsx` export; a schema drift in a different Waltz version, report template, or locale would break parsing for some users with no test coverage to catch it in advance — tracked as an open question in the plan doc, not yet validated against a second real export.
