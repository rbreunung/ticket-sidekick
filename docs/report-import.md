# Report Import (EML, Veracode, Waltz)

How `@jira` turns an `.eml` email, a Veracode Detailed Report, or a Waltz OSS
Report into Jira tickets.

The code lives in:

- [`src/utils/emlParser.ts`](../src/utils/emlParser.ts) — `.eml` parsing (`postal-mime`).
- [`src/participant/jira/emailHandler.ts`](../src/participant/jira/emailHandler.ts) — email-to-ticket chat flow.
- [`src/utils/reportImport.ts`](../src/utils/reportImport.ts) — shared, `vscode`-free primitives used by both the Veracode and Waltz importers.
- [`src/participant/jira/reportImportHandler.ts`](../src/participant/jira/reportImportHandler.ts) — shared session-flow orchestration for both report importers.
- [`src/utils/veracodeReport.ts`](../src/utils/veracodeReport.ts) / [`src/participant/jira/veracodeHandler.ts`](../src/participant/jira/veracodeHandler.ts) — Veracode-specific parsing and thin wrapper.
- [`src/utils/waltzReport.ts`](../src/utils/waltzReport.ts) / [`src/participant/jira/waltzHandler.ts`](../src/participant/jira/waltzHandler.ts) — Waltz-specific parsing and thin wrapper.

## EML email import

Users download `.eml` files from OWA via **More actions → Download message** and import them via the VS Code command.

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

## OSS/vulnerability report import (Veracode + Waltz)

Veracode and Waltz report import share one implementation — `src/participant/jira/reportImportHandler.ts` + `src/utils/reportImport.ts` — for session flow, dedup search, the review-table/toggle-reply UX, and batch ticket creation. Each importer supplies only its own parser, config, and label/summary/description-building specifics via a `ReportImportDescriptor` passed from its thin wrapper (`veracodeHandler.ts`/`waltzHandler.ts`). This means: dedup search is fault-tolerant per chunk and JQL-quoted for both; a picked template that vanishes before the user replies produces the same warning for both; both cap "new" rows at `BATCH_LIMIT` before building them and show the same "N more matched, re-run to get them" note; both link to each newly created ticket in the per-item progress output. A behavior difference between the two today is a bug, not a feature — see `docs/plans/2026-08-13-001-refactor-consolidate-report-importers-plan.md` for the consolidation rationale.

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
