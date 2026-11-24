# Ticket Sidekick — Agent Context

## Language

Always reply in English, regardless of the language of any personal preferences or earlier context. Code, comments, commit messages and docs are English too. Only switch the chat language if the user explicitly asks for it in the current conversation.

The project itself is always English: source code, comments, identifiers, commit messages, PR descriptions, UI strings and all documentation (`README.md`, `docs/`, `CHANGELOG.md`). This holds even if the user's personal language changes or they write to you in another language — a different chat language never makes project artifacts non-English.

## What this is

A VS Code extension that brings Jira and Bitbucket into GitHub Copilot Chat. It has moved from chat participants to tools and boards, and that direction is settled:

- **Current, build here:** **extension tools** (VS Code language model tools Copilot's agent calls; the Jira catalog is in `src/tools/jiraTools/`), the **`/ts-jira` skills** on top of them, and **boards** (editor views: webviews in editor tabs that show a session the extension owns). See "Tools, skills and boards" below.
- **Removed, no chat participant left:** **`@jira` was removed on 2026-11-16** and **`@bitbucket` on 2026-11-23**. Every Jira task, the email import included, and every pull request review runs from a tool, a skill or a board; the review runs on the review board (`src/boards/review/`). `package.json` declares no `chatParticipants`, and `src/test/bundleSmoke.test.ts` fails if one comes back.
- **Release rule during the migration:** every release is a preview; the stable channel gets no release, not even a hotfix, until the whole migration is done and tested. The code side is done; what is left is the manual checklist runs and the accessibility check. See [`docs/architecture/migration-status.md`](docs/architecture/migration-status.md).
- **Removed, do not plan with:** the MCP server, the `ticketSidekick.jira.toolsFrom` setting, VS Code canvases, the agent plugin and the local HTTP server (`http.noProxy`). Documents that describe them are marked superseded.

Jira and Bitbucket share `ConfigService` for credential storage but are otherwise independent. Neither requires the other to be configured. The one crossing: the review board can check a pull request against a Jira ticket (typed on its first step, or the one the PR title names) through the shared `TicketService`/`JiraApiClient`, only when Jira is configured and the developer chooses it (see `docs/review-process.md` "Requirements check").

## Architecture (three layers — never skip)

The service and client layers below are shared by everything. The top layer is a tool (`src/tools/jiraTools/*` → `TicketService`, `src/tools/bitbucketTools/*` → `IBitbucketClient`/`PrReviewService`) or a board kind (`src/boards/<kind>/` → services; the import board goes through the shared import engine `src/imports/`, the review board through the staged review engine `src/review/engine/`).

### Jira

```text
Jira tool / board → TicketService → IJiraClient (interface)
                                       ↓
                               JiraApiClient (production HTTP)
                               MockJiraClient (test fixture returns)
```

**Rule:** `TicketService` imports `IJiraClient` only — never `JiraApiClient` directly.

### Bitbucket

```text
Bitbucket tool / review board → PrReviewService → IBitbucketClient (interface)
                                                        ↓
                                                BitbucketApiClient (production HTTP)
                                                MockBitbucketClient (test fixture returns)
```

**Rule:** `PrReviewService` imports `IBitbucketClient` only — never `BitbucketApiClient` directly.

## Key files

| File | Responsibility |
| --- | --- |
| `src/jira/IJiraClient.ts` | All Jira types + IJiraClient interface |
| `src/jira/JiraApiClient.ts` | Real HTTP; builds auth header from authType |
| `src/bitbucket/IBitbucketClient.ts` | All Bitbucket types + IBitbucketClient interface |
| `src/bitbucket/BitbucketApiClient.ts` | Real HTTP; Data Center (Bearer PAT) + Cloud (Basic base64(username:apppassword)). `getPullRequestDiffWithCoverage`/`getPullRequestFileDiff` find and re-fetch files a truncated Data Center diff cut, and `summarizeDcDiffShape` logs each Data Center response's content-free shape (see `docs/review-process.md` "Data Center truncated diffs") |
| `src/services/TicketService.ts` | Jira business logic; depends on IJiraClient. `getRequirementsSource(key)` returns a ticket's capped summary/description/comments or a failure classified by HTTP status, for the review board's requirements check. `getLinkTypeNames()`, `linkIssues(from, to, typeName)`, `hasLinkBetween()` and `markTicketMerged()` serve the Waltz ticket merge. `createTicket`/`rewriteTicket` take optional `optionalFields` (the Waltz Due Date) and repeat a write once without a field Jira refuses (`withOptionalFields`, `droppedFields`), and `rewriteTicket` takes `extraFields`/`removeLabels`. `isMultiLine()` decides table-row vs own-section by field schema (textarea / description / environment → section; single-line text & URL stay inline even when long), falling back to a length heuristic |
| `src/services/PrReviewService.ts` | PR review logic: diff parsing, file gathering, two-pass LLM prompt building, result formatting |
| `src/services/ConfigService.ts` | VS Code settings + SecretStorage for both Jira and Bitbucket |
| `src/services/configValidation.ts` | Pure (vscode-free) config validators; `validateBaseUrl` rejects malformed/non-http(s) base URLs. Surfaced by `jira_check_connection` (`/ts-jira check`) and `bitbucket_check_connection` (`/ts-bitbucket check`, DC) before attempting a connection. `PROJECT_KEY_PATTERN`/`normalizeProjectKey` are the one project-key rule |
| `src/services/defaultProjectCheck.ts`, `src/services/defaultProjectNotice.ts` | The check of `ticketSidekick.jira.defaultProject` at start and after a change (debounced): `checkDefaultProject` (form first, then Jira's project lookup when Jira is set up; only a 404 counts as wrong) and `defaultProjectWarning`; the notice offers Open Setting and never writes the setting |
| `src/services/setupHints.ts` | Pure (vscode-free) `buildJiraNotConfiguredMessage(config)`: the plain-text Jira setup hint the Jira tools answer with while Jira is not configured |
| `src/tools/bitbucketTools/` | The vscode-free Bitbucket tool catalog (`ToolDefinition`s over `IBitbucketClient`/`PrReviewService` and the review board's stored sessions) |
| `src/tools/registerBitbucketTools.ts` | Registers the Bitbucket tool catalog with VS Code as language model tools |
| `src/tools/jiraTools/loadCore.ts` | vscode-free load core behind a small writer interface: writes `ticket.md`, `comments.md` and the eligible or named attachments into `.jira-context/<KEY>/` and keeps it git-ignored; used by the load tool |
| `src/imports/email.ts` | The email descriptor over injected settings readers (`emailSettings` in `src/services/importSettings.ts`): rows from parsed `.eml` files, the subject as summary, `buildEmailJiraWiki`/`buildEmailCommentHeader`/`buildEmailCommentWiki`, `afterCreate` (attachment upload, then `ticketSidekick.email.deleteEmlAfterImport`), `checkEmailBatchCaps`, `uploadEmailAttachments`, and the likely-repeat match (`normaliseSubject`, `subjectSearchTerm`, `matchRepeats`) |
| `src/boards/boardModels.ts` | The language models a board may call without a chat request (`BoardModels`: list, send; bound over `vscode.lm` in `registerBoards.ts`), the two model settings (`ticketSidekick.email.checkModel`, `ticketSidekick.bitbucket.reviewModel`), `emailModelInUse` and the one-call `checkModelAnswers` the start screen makes after a pick |
| `src/boards/import/cleanupStage.ts`, `emailRows.ts` | The email import's boilerplate cleanup as a stage before New (`cleanupPhase`: consent, preview, done): pattern blocks from the reading, the model check as a previewed plan (`cleanup-check`, the pick saved with it), strip/keep/exclude, save as pattern; `emailRowForWrite` reads an email's attachments from its file again at the write (the session keeps none) and refuses an email whose file is gone |
| `src/utils/emailBoilerplate.ts` | Pure, `vscode`-free email boilerplate detection on the converted Markdown body: per-message thread segmentation, `ticketSidekick.email.boilerplatePatterns` matching (`detectPatternBlocks`), stripping with signature-name retention and image dropping (`applyBoilerplateCleanup`), save-as-pattern (`buildPatternFromBlock`), and the consented model check's prompt/reply parsing/quote verification (`buildModelCheckPrompt`, `parseModelCheckReply`, `verifyModelBlocks`) |
| `src/utils/emlParser.ts` | Parses `.eml` files via `postal-mime`; returns `ParsedEml` (subject, sender, date, htmlBody, plainBody, inlineImageMap, attachments). `parseEmlFile(filePath)` wraps one file into an `EmailImportItem` (markdown-converted body, flattened inline-image map) — the shared per-file parser all three `.eml` entry points use |
| `src/utils/reportImport.ts` | Shared, `vscode`-free primitives used by the Veracode, Waltz, and email importers: `chunkStrings`, `buildDedupJql` (always quotes labels), `extractDedupMap` (nested `{key, fields:{labels?}}[]` shape), `findAlreadyTicketed` (fault-tolerant per-chunk dedup search — one failed chunk doesn't discard matches from others), `capNewRows` (pre-cap-before-build, tracks `totalNewMatched`/`droppedOverCap`), `buildReviewRows`, `sanitizeCellText`/`sanitizeStandaloneLine` (untrusted-content sanitizers — the latter prefixes a value with `: ` before it becomes a standalone line, closing line-start injection vectors span-text stripping alone can't), the shared `MAX_REPORT_BYTES`/`BATCH_LIMIT` constants, `resolveMaxReportBytes()` (turns a configured size in MB into a validated byte limit, falling back to a default when missing or out of range), and `REPORT_SIZE_LIMITS_MB` + `resolveSizeLimitSetting()` — each `ticketSidekick.<x>.maxReportSizeMB`/`maxBatchSizeMB` setting's default and range in one place, tested against `package.json`, used by `src/services/importSettings.ts` Also the size budgets for folded tickets: `MAX_SUMMARY_CHARS`/`MAX_DESCRIPTION_CHARS`, `clampSummary()` (trims only the name part of a title) and `fitWiki()` (steps a builder through detail levels until it fits) And the Veracode Due Date backfill: `DedupTicket.dueDate` (null = empty, undefined = not returned) and `applyMissingDueDate()`; `stringOrNull()` reads a Jira date field |
| `src/imports/descriptor.ts`, `src/imports/types.ts` | The `ReportImportDescriptor` (parser, config reader, `buildTicketFields`, review-table columns, optional dedup fields, optional `afterCreate` post-creation hook, optional issue-type-fetch-failure callback) and its optional capabilities, and the review types (rows, session, `MergeRun`, the stale types). Type-only and vscode-free. `fold` (Veracode and Waltz, not email) enables merge/unmerge of New rows (`memberIds`), add to ticket as comment or rewrite, and the Already-ticketed `rewrite` action (all-or-none per target ticket, applied by target group under the batch cap); `TicketService.rewriteTicket` does the one-call write. `changeTracking.deriveActions` (Veracode and Waltz, `deriveRewriteActions`) replaces the five-action policy with `rewrite`/`leave`/`new ticket` (id `follow-up`, label via `actionLabels`) and also switches on the full-ticket `new ticket` and the shared `rewrite` default (`alignRewriteDefaults`); `changeTracking.readsTargetDescriptions` (Waltz only) switches on reading each target ticket's description (`readTargetDescriptions`) and the dropped-member pass (`applyDroppedMembers`, `reportKeys`); `overviewExport` (Veracode and Waltz) enables the overview export; `buildTicketFields`/`buildFollowUp` may return `optionalFields` (the Due Date). `accepted` (Waltz only) keeps accepted CVEs and accepted components off New (`narrowNew` hook of `buildReviewRows`) and drops accepted components from Already ticketed (`dropTicketed` hook). The optional `rewriteDueDate`/`dueDateNote` hooks (Veracode and Waltz; email has none, so its rewrite writes no Due Date) decide the date a rewrite writes and word its result line, and `TicketWriteContext` carries an existing ticket's creation time to `buildTicketFields`. `ticketMerge` (Waltz in rewrite mode, Veracode with `mode: 'close'`) enables the ticket merge |
| `src/imports/review.ts`, `rows.ts`, `create.ts`, `rewrite.ts`, `ticketedActions.ts`, `staleClose.ts`, `cleanup.ts` | The shared import engine, vscode-free, logging through an injected `onDiag` and progress through `onEvent`; the import board calls it: `buildImportReview` (parse and filter, template, dedup search, rows, accepted list, stale check), the New-row page slice, merged rows, row action change and ticket search match (`findTicketsBySummary`), ticket creation (`createNewRowTickets`, `createTicketForRow`), add to ticket and the rewrite plan and write (`planRewrite`, `writeRewrite`), the Already-ticketed actions (`runTicketedActions`), the stale close's target options and run, and `buildStaleTicketGroups`/`transitionTickets`. See `docs/report-import.md` |
| `src/utils/veracodeReport.ts` | Veracode Detailed Report XML parsing (`parseVeracodeReport`, with `ISSUE_ID_PATTERN`/`CWE_ID_PATTERN` validation dropping malformed ids rather than letting them reach a generated URL), filtering, short-label/summary/label builders, and `buildDescriptionWiki` (Markdown-authored, every untrusted field sanitized via `reportImport.ts`, converted once via `markdownToJiraWiki()`) — pure, no `vscode` import Findings fold by `groupFlawsByLocation()` (same file + CWE, or same file + line, as a transitive closure); a folded group gets a count-based title (`buildGroupSummary`, clamped to 255 characters) and a banner + overview-table description (`buildGroupDescriptionWiki`, shortened per finding when over the size budget), and `buildFoldedCommentWiki` builds the `add … to <KEY>` comment — see `docs/report-import.md` "Finding folding" `parseVeracodeReport` also reads `date_first_occurrence` into `firstFoundDate`, and the Findings table has First found and Due date columns (`DueContext`); `buildMergedSourceComment` is the comment on a Veracode ticket closed by `merge` |
| `src/imports/veracode.ts` | The Veracode descriptor over injected settings readers (`veracodeSettings` in `src/services/importSettings.ts`): reading and folding the report, labels, the stale-check predicate, and the SLA Due Date: `buildTicketFields`/`buildFollowUp` (`duedate`), `rewriteDueDate` (set once, only moved earlier by joining flaws), `changeTracking.dueDateBackfill` and `overviewExport.dueDateOf`. A problem with `ticketSidekick.veracode.slaDays` is logged once per import |
| `src/utils/veracodeDates.ts` | Pure, `vscode`-free Veracode SLA due-date logic: `SLA_SEVERITY_NAMES`, `resolveSlaDays` (lenient reader of `ticketSidekick.veracode.slaDays`: case-insensitive names, 0 = no date, invalid values and unknown keys returned in lists, an absent setting = no policy), `addCalendarDays`, `flawDueDate` (first-found date else the fallback start, plus the severity's days), `groupDueDate` (earliest) and `earlierOf`, and the `DueContext` (policy days + fallback start) and `NO_DUE` the date functions and the Findings table take. See `docs/report-import.md` "Due dates from the SLA table (Veracode)" |
| `src/utils/calendarDate.ts` | Pure, `vscode`-free `toCalendarDate` (text or date cell → `YYYY-MM-DD`, no time zone, impossible dates rejected), shared by the Veracode and Waltz importers |
| `src/utils/waltzReport.ts` | Waltz/SCA OSS Report `.xlsx` parsing, filtering, summary/description/label builders (labels are sanitized + 6-hex-char-hash-suffixed for collision safety) — pure, no `vscode` import Items are one-member groups (`WaltzComponent[]`, row field `sourceGroup`); `buildGroupSummary`/`buildGroupLabels`/`buildGroupDescriptionWiki`/`buildFoldedCommentWiki` give a merged group its title (ending in the highest rating), union labels with one rating label, banner + table description and add comment — a one-member group renders as before; also parses the remediation dates/plan status per component (`remediation`), renders the "Remediation dates" section and overview-table columns, and builds the Due Date fields (`dueDateFields`) and rewrite-comment date lines |
| `src/imports/merge.ts` | The ticket merge (`merge <sources> into <survivor>`) in two modes: Waltz (rewrite) and Veracode (close — `planCloseMoves`: the kept ticket is rewritten only when a source has items it lacks, each source is linked, commented on and closed; `mergeModeOf` picks the mode's preview, run plan, Due Date rule and merged step in one place). `prepareMergePrompt` reads the tickets and words the warnings and fallbacks; `startMergeRun`/`resumeMerge` run the ordered steps (survivor rewrite and comment, per-source link and `TicketService.markTicketMerged`, then the closes) recorded on a `MergeRun`, with retry/ignore (`resumeMerge`), the target status per issue type (`pickMergeTarget`), the resolution (`pickMergeResolution`) and `stopMerge`. Enabled by the descriptor's optional `ticketMerge` capability; the import board's `mergeTab.ts` drives it. See `docs/report-import.md` "Merging tickets (Waltz)" and "Duplicate open tickets and Veracode ticket merge" |
| `src/utils/ticketMerge.ts` | Pure, `vscode`-free merge helpers: `resolveMergeSides` (A ids and keys, refusals), `buildMergePlan` (step order), `mergedSummary`/`mergedBanner` (idempotent marker text), `hasUnfinishedChoices` (refresh now or mark the screens out of date), and for close mode `analyzeSourceMoves` (movable vs unlisted items per source), `closeLinkType` and `buildCloseMergePlan` |
| `src/utils/wikiTableRead.ts`, `src/utils/veracodeFindingsTable.ts`, `src/utils/waltzComponentsTable.ts` | Pure, `vscode`-free readers for the tables every Veracode and Waltz description carries: `wikiTableRead.ts` the shared wiki-table helpers; `veracodeFindingsTable.ts` the Findings table's column titles and `readVeracodeFindings` (layers: table, older layouts, title and labels; per-record `detailSource`, `approximate`, ticket-level `edited`); `waltzComponentsTable.ts` the same for the Components table (`readWaltzComponents`). See `docs/report-import.md` "Ticket tables and readers" |
| `src/utils/securityOverview.ts`, `src/utils/securityOverviewColumns.ts`, `src/utils/securityOverviewCsv.ts`, `src/utils/securityOverviewXlsx.ts` | Pure security overview: `buildOverview` (Fix Version tables by release date, Not assigned table, `overdue` / `due-before-release` flags, counts, Jira links with `resolution is EMPTY`), the `OverviewFormat` type (`csv` / `xlsx`), the unplanned-ticket flag rule (no Fix Version → compared with the latest unreleased release), `buildOverviewSheet` (the shared column order and typed records), the CSV (`renderOverviewCsv`, `csvCell` formula prefix, `resolveCsvDelimiter`) and the Excel workbook (`renderOverviewXlsx`: date cells, frozen header, autofilter, orange/yellow flag fills). Fed by `TicketService.listOverviewTickets` / `getOverviewTicketsByKeys` / `getProjectVersions` / `readDescriptions` |
| `src/imports/waltz.ts` | The Waltz descriptor over injected settings readers and the workspace folder (`waltzSettings` in `src/services/importSettings.ts`): reading the report, labels, the stale-check predicate, the accepted list (`AcceptedListService`) and the Due Date fields |
| `src/services/importSettings.ts` | The Veracode, Waltz and email filter, size and SLA settings as VS Code holds them, read each time they are needed (`veracodeSettings`, `waltzSettings`, `emailSettings`) |
| `src/boards/import/kind.ts`, `read.ts`, `recipe.ts` | The import board kind (vscode-free): the recipe (report kind, project, absolute report path, template, issue type; the session id from kind, project and normalised path), `readImport` (the review build, the export data, a fingerprint per tab; a missing file throws `ReportNotFoundError`, a failed dedup chunk `DedupFailedError`), choices keyed by row key or ticket key, the board's recorded writes, `reconcile` with the out-of-date mark per tab, and `view`. See `docs/report-import.md` "Import board (Veracode + Waltz)" |
| `src/boards/import/handlers.ts`, `registry.ts`, `newTab.ts`, `ticketedTab.ts`, `staleTab.ts`, `acceptedTab.ts`, `mergeTab.ts`, `searchExport.ts` | The import board's area handlers, one per area: New (include, merge, add to ticket, create), Already ticketed (filters, actions, set all shown, conflict refusal), Stale (close per issue type), Accepted (accept, unaccept, reload report, all `risky: false`), the ticket merge run and its tab (`blocksPlans` while unfinished), and search, the CSV and Excel overview export from the stored reading and the finished state |
| `src/boards/import/startScreen.ts`, `jiraDeps.ts` | The session-less import start screen (`ImportStartScreen`: kind, file, the template from `ticketSidekick.<kind>.template` asked for once and saved, the issue type, the default project asked for when empty or wrong (a typed key checked with Jira, `IJiraClient.listProjects` as suggestions) and saved, Open and Start over, `openIfReady` for the open-board tool) and the board's dependencies over the Jira services |
| `src/utils/waltzAccepted.ts` | Pure, `vscode`-free accepted list for the Waltz import: parse/serialize `.jira-oss-accepted.json` (fail-open `parseAcceptedFile`; an entry is a CVE pair or, with a `version` and no `cve`, a whole component at that version), `componentNameOf`/`componentVersionOf` (split `nameVersion` at the last `:`), `narrowGroup` (drop accepted components, then accepted CVEs, recompute the rating, re-apply `minVulnRating`; a group that lost nothing is returned untouched), `isComponentAccepted`, `acceptedEntriesOf`/`acceptedComponentEntriesOf`, `addAcceptedEntries`/`removeAcceptedEntry`/`removeAcceptedComponent`. See `docs/report-import.md` "Accepted CVEs and components (Waltz)" |
| `src/utils/waltzDates.ts` | Pure, `vscode`-free Waltz remediation-date logic: `effectiveDueDate`/`earliestDueDate` (planned date else policy date; earliest over a group), `diffRemediationDates`, the shared "Remediation dates" section constants, and `parseRecordedDates` (reads a ticket description's recorded dates back, leniently; round-trip tested against the builder). The third date is the attestation date (`COLUMN_ATTESTATION`, report column `Attested Rem Plan Due By`); the old "Plan deadline" title is not read back. See `docs/report-import.md` "Remediation dates and the Due Date (Waltz)" |
| `src/utils/jiraFieldErrors.ts` | `refusedFieldsOf(err, names)`: which optional fields a Jira 400 names under `errors` (keyed on the field name, never the message). `TicketService.createTicket`/`rewriteTicket` use it to repeat a write once without a refused Due Date and report `droppedFields` |
| `src/services/AcceptedListService.ts` | Reads/writes `.jira-oss-accepted.json` in the workspace root (vscode-free, like `TemplateService`); `load()` never throws; `add`/`remove`/`removePair`/`removeComponent` refuse to write over a file that could not be read in full (invalid JSON or a skipped entry) |
| `src/review/requirementsPass.ts` | Pure, `vscode`-free `runRequirementsPass(params, deps)`: packs the diff, makes the one call and at most one extra-file round, and words a failure; the model call, file fetch and cancellation arrive as `deps`. A cancelled request is rethrown |
| `src/review/requirementsCoverage.ts` | Pure, `vscode`-free requirements-pass core: `parseRequirementsReply` (tolerant, throws `UnparseableReplyError`), `packDiffFiles`, and the plain-text renderer (`renderCoverageText`) the board and Copy use |
| `src/utils/requirementsSource.ts` | Pure: shapes a Jira issue and its comments into a size-capped `RequirementsSource` (newest comment first) and its prompt text |
| `src/review/reviewDiagnostics.ts` | Diagnostics orchestration glue for the review pipeline's LLM call sites: `CallAttemptOut`/`OnCallAttemptError`/`CallDiagHooks` types, `errorCodeOf`, `handleAttemptFailure` (shared pass1/critic `onAttemptFailed` handling — logs the failure plus the R1/R2 per-call error line, then R5's recovery-decision line, gated on item-array identity against the original unsplit batch so a split half's terminal attempt never falsely logs a retry that won't happen); re-exports `createAttemptTracker`; also `describeErrorForLog` (error class plus a trimmed stack head for log lines), the failure-wording helpers (`formatBatchFailureNotice` says "after retrying" only for transient errors, `PARTIAL_REVIEW_WARNING`, `formatReviewFailedMessage`), and the logged not-retried `give-up` decision. No `vscode` import — pure and Vitest-loadable; callers inject their logging as callbacks |
| `src/review/tokenMeter.ts` | `createTokenMeter(model, record, onDiag?)`: per-response proxy over the chat model (proxies an empty target so a frozen host model cannot trip the Proxy invariants; fails open to the raw model with `metered: false` when it cannot wrap) that counts every `sendRequest` (input via `countTokens` once the request is accepted, output when the stream ends or breaks, `chars/4` fallback flagged estimated) and records it. No `vscode` import. See `docs/review-process.md` "Token usage" |
| `src/utils/tokenUsage.ts` | Pure monthly per-model token counters (`TokenUsageService` over `globalState`, current month + two before, pruned on write), plus `formatUsageTable` for `bitbucket_token_usage` (`/ts-bitbucket usage`) |
| `src/review/reviewSessionState.ts` | The vscode-free review core of the review board and the Bitbucket tools: `parsePrUrl`, `parseDiff`, `parseReviewReply` (tolerant reply parser — NDJSON, pretty-printed, arrays, wrappers, cut-off replies), `buildAdaptiveChunks`, `numberDiffLines` (render-only gutter), `locateAnchor` + `resolveFindingAnchors` (tiered match of the quoted `anchorCode` → verified line + provenance, or *location unverified*; drops and counts findings naming files outside the PR), `mergePass2Findings`, `buildStoredReviewDiff`, `formatReviewForSharing`, `buildFindingFollowUpPrompt`, `dedupeFindings`, `extractHunkAround`, `selectFilesWithinBudget`, `parseCriticKeep`, `createAttemptTracker`, `buildRunTag`, `formatCallLine`, `buildTruncationEvent`, `formatRecoveryDecision`, `formatFindingsFunnel`, `formatStructuredRunRecord`, `formatContinuationMessage` — the Bitbucket review pipeline's diagnostic-timeline formatters (see `docs/review-process.md` "Resilience & debugging") — plus its own `neutralizeMarkdownLinks()` (duplicated from `src/utils/chatPrimitives.ts` rather than shared) |
| `src/review/engine/` | The staged review engine, vscode-free: the regular pass (`regularPass.ts`), the persona passes (`extraPass.ts`), the critic, the requirements check and the goal rewording, over the shared batch review; findings are kept in a `FindingStore` with numbers that never change. The review board drives it |
| `src/boards/review/` | The review board kind (vscode-free): the session-less start screen that asks for the PR link (`startScreen.ts`), the first step (model, requirements source: Jira ticket, a goal or none, optional question; `firstStep.ts`), the runs (regular pass, suggested and picked extra passes, critic, re-check; `runs.ts`), and the findings with Explain, draft comments with Rewrite, Post and Copy (`findings.ts`). Opened by `bitbucket_open_review`, `/ts-bitbucket review` and `Ticket Sidekick: Review a pull request` |
| `src/services/WorkflowService.ts` | Workflow graph cache I/O, BFS path-finding, `discoverWorkflow` sampling; the cache entry also keeps `doneStatuses` (Jira's Done category, `IJiraClient.getDoneStatuses`) |
| `src/utils/finalStatus.ts` | Pure `isFinalStatus(status, doneStatuses?)`: the Done category decides when known, else `FINAL_STATUS_NAMES`; used by the ticket list board (resolution only on final moves, R39 risk) and the imports' stale close |
| `src/templates/TemplateService.ts` | Reads `.jira-templates.json`; returns `{ templates, cleanupRules }` |
| `src/templates/FieldResolver.ts` | Resolves `resolveFields` entries by name (API lookup) or id (pass-through) |
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name; `findJiraKeyMatch`/`findJiraKeyInText`/`isLikelyJiraKey` find a key in free text (a PR title or review prompt), skipping non-ticket shapes like `UTF-8` and `SHA-256` |
| `src/utils/markdownFormatter.ts` | `formatJiraBody(node)` — converts Jira wiki markup (v2 string) or ADF object (v3/legacy) to Markdown; `wikiToMarkdown(str)` delegates to `jiraWikiToMarkdown` |
| `src/utils/jiraWikiToMarkdown.ts` | Own Jira wiki markup → Markdown converter; handles headings, tables, lists, code/noformat blocks, quotes, panels, and all inline markup without any third-party dependency |
| `src/utils/htmlToMarkdown.ts` | Converts HTML email body to Markdown; resolves `cid:` references via optional `inlineImageMap`; strips OWA span whitespace inside bold/italic |
| `src/utils/extractJsonObject.ts` | Bracket-counting extractor for the first complete JSON object in a raw LLM response (ignores braces in strings + trailing prose). Used by the Bitbucket review reply parsers; `src/review/reviewSessionState.ts` re-exports it |
| `src/utils/lmRetry.ts` | 3-try retry for VS Code Language Model API calls: `withLmRetry` (identical-retry, for a single non-splittable prompt) and `withEasierRetry` (the 3rd try splits a batch in half instead of repeating it). `isTransientLmError` classifies which failures are worth retrying. `PartialLmResponseError` preserves any text a broken response stream had already sent; `UnparseableReplyError` marks a review reply with no usable JSON so it is retried like a provider error |
| `src/utils/diagTypes.ts` | `LogLevel` (`'info' \| 'warn' \| 'error'`) and `DiagLogger` types — no `vscode` import, so `TicketService`/`PrReviewService`/`JiraApiClient`/`BitbucketApiClient` can depend on them without pulling in `vscode` transitively |
| `src/utils/logRedaction.ts` | `sanitizeDetails()` — recursively redacts values whose key looks like a secret and truncates long strings before a `logDiag` details object is written to the Output Channel. Applied automatically inside `logDiag`; no call site invokes it directly |
| `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` VS Code Output Channel singleton (`getOutputChannel()`) and `logDiag(scope, level, message, details?)` — the place for diagnostic detail beyond the chat transcript. `level` (`'info' \| 'warn' \| 'error'`) tags each line for skimmability; `details` is redacted/truncated via `logRedaction.ts` automatically. Used throughout the tools and the boards |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron smoke tests in a real VS Code (src/e2e/); on Linux: xvfb-run -a npm run test:e2e
                  # optional env: VSCODE_TEST_VERSION=1.95.0 (engines floor), VSCODE_TEST_EXECUTABLE=<path to Code>
```

Node.js is installed system-wide — use plain `npm` from your PATH. (Volta was previously used but has been removed; do not reference `~/.volta/bin/npm`.)

**`npm test` must be green before every commit.** Run `npm run compile` to catch TypeScript errors first.

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run compile` → `npm test` on every push and pull request against `main`, on Ubuntu and Windows with Node 24 and 26. A final `ci-ok` job (`needs` every other job, `if: always()`) is the one check branch protection requires and the release gate reads, so the matrix can change without a required check vanishing. A separate `e2e` job in the same workflow runs `xvfb-run -a npm run test:e2e`: a small smoke suite (`src/e2e/`) that checks, in a real VS Code, that the bundled extension activates and registers every command and language model tool `package.json` declares, that VS Code can call a Jira tool (`jira_check_connection`), and that a board opens as an editor tab whose page gets an answer from the extension. `src/test/bundleSmoke.test.ts` does the same against a stubbed `vscode` inside `npm test`, with no VS Code download. Chat flows are not covered by either (they need Copilot and real credentials).

Releases are manual: `.github/workflows/release.yml` is a `workflow_dispatch` with inputs `channel` (`release` | `preview`), `bump` (`patch`/`minor`/`major`), and an optional explicit `version` (overrides `bump`). It first requires a green `ci-ok` check on the newest non-bot commit (the bump commits it pushes start no CI), computes the version via `npm version --no-git-tag-version`, gates on compile+test, then commits the bump, pushes the bare tag `X.Y.Z` and merges the bump into the branch (fetch, merge with the branch as first parent, push; five tries, so a PR merged during the run cannot stop it), builds the `.vsix` from the tagged commit, publishes to the Marketplace (`vsce publish`, needs the `VSCE_PAT` secret) as the last irreversible step, and creates the GitHub Release on the tag. When resolving the version it asks the Marketplace (`vsce show`) and the tags whether the version is taken: a bump skips forward to the next free patch with a warning, an explicit `version` that is taken stops the run; a `concurrency` group allows one run at a time. **Both** channels commit the bump back to the branch and push it (with the `RELEASE_PUSH_TOKEN` secret when set, which lets an admin-owned token bypass the `main` ruleset; otherwise with `GITHUB_TOKEN`), so the published version line is strictly increasing and a version is never reused (avoids the Marketplace "no duplicate version" rule with no manual bumping); `preview` only adds `--pre-release` + marks the GitHub release as a pre-release. Before packaging the `.vsix`, the workflow fetches that version's notes via `gh api .../releases/generate-notes` once and reuses the captured text for both surfaces: a `channel: release` run strips GitHub's "by @author in #PR" attribution and prepends the result to `CHANGELOG.md` (committed in the same bump commit, so the entry ships inside that release's own `.vsix`); `preview` runs leave `CHANGELOG.md` untouched. `scripts/backfill-changelog.mjs` is a re-runnable one-off that seeds/regenerates `CHANGELOG.md` from every non-prerelease GitHub Release. See the README "Releasing" section.

## Testing

Write tests for **user-facing use cases**, not internal mechanics. A test should read like a scenario: given this input, what does the user get back? Cover the happy path and the main failure case for every new feature.

Only a few files import `vscode` (`extension.ts`, `registerBoards.ts`, `boardPanels.ts`, the `register*` tool files, `ConfigService.ts`, `importSettings.ts`, `defaultProjectNotice.ts`, `diagLog.ts`). Keep logic in vscode-free modules (`src/utils/`, `src/review/`, `src/boards/<kind>/`, `src/imports/`, `TicketService.ts`, `PrReviewService.ts`) so it can be unit-tested; the e2e suite only smoke-tests activation, registration, a tool call and a board tab. Tools are tested by calling them through `callTool` (`jiraReadTools.test.ts`, `jiraWriteTools.test.ts`), boards through `boardMessages.test.ts`, `boardPanels.test.ts` and each kind's scenario tests.

## Adding a new Jira operation

Steps 1 to 6 hold for every Jira operation. The entry point is a **tool** or a board (see "Tools, skills and boards" and the checklists in [`docs/architecture/boards-and-sessions.md`](docs/architecture/boards-and-sessions.md) section 10).

1. Add method to `IJiraClient` interface
2. Implement in `JiraApiClient` (real HTTP)
3. Implement in `MockJiraClient` (fixture return)
4. Add a fixture file to `src/test/fixtures/` matching real Jira v3 API shape
5. Write failing tests in `TicketService.test.ts`
6. Implement in `TicketService` (business logic) until tests pass
7. Add the tool to the catalog in `src/tools/jiraTools/` and run `node scripts/sync-tools.mjs`; keep pure helpers vscode-free
8. If the operation introduces a new multi-step flow, document it in `docs/jira-flows.md` (or the relevant domain doc) — add only a one-line summary and link here, not new flow prose (see "Where documentation belongs")
9. If users can see the change (a new command, reply, chip, setting, or changed behaviour), update the user manual too — see "Where documentation belongs"

## Adding a new Bitbucket operation

The entry point is a **tool** (the catalog in `src/tools/bitbucketTools/`, registered by `src/tools/registerBitbucketTools.ts`) or the review board (`src/boards/review/`).

1. Add method to `IBitbucketClient` interface
2. Implement in `BitbucketApiClient` (real HTTP, handle both DC and Cloud branches)
3. Implement in `MockBitbucketClient` (fixture return)
4. Write failing tests in `PrReviewService.test.ts`
5. Implement in `PrReviewService` (business logic) until tests pass
6. Add the tool to the catalog in `src/tools/bitbucketTools/` and run `node scripts/sync-tools.mjs`, or the action to the review board kind
7. If the operation introduces pure helpers, put them in `src/review/` and test them
8. If the operation introduces a new multi-step flow, document it in `docs/review-process.md` (or the relevant domain doc) — add only a one-line summary and link here, not new flow prose (see "Where documentation belongs")
9. If users can see the change (a new command, reply, chip, setting, or changed behaviour), update the user manual too — see "Where documentation belongs"

## Jira API

- Base path: `<baseUrl>/rest/api/2/` — used for all standard operations on both Data Center and Cloud
- Data Center auth: `Authorization: Bearer <PAT>`
- Cloud auth: `Authorization: Basic base64(email:apiToken)`
- Descriptions and comments are always sent and received as **plain strings** (Jira wiki markup). ADF is not used; `wrapInAdf()` has been removed.
- For Cloud-only fields that require the v3 API: add a `requestV3()` private method in `JiraApiClient` when the need arises. No current operations require it.
- Reading: `extractTextFromAdf()` in `TicketService` handles both plain strings (v2 read) and ADF objects (legacy rich content), so existing tickets with ADF descriptions display correctly.
- Agile API base path: `<baseUrl>/rest/agile/1.0/` — used for sprint resolution (`getSprintByName`)
- Teams API base path: `<baseUrl>/rest/teams/1.0/` — used for Data Center team resolution (`getTeamByName`); Cloud does not support team lookup by name, use `id` in the template instead
- Attachment uploads (`uploadAttachment`) build the multipart `Content-Disposition` via `buildFileContentDisposition()`, which sanitizes the (possibly email-derived) filename and adds an RFC 5987 `filename*` so quotes/CR-LF cannot break or inject headers and Unicode names round-trip. `assertAttachmentWithinLimit()` rejects files over `MAX_ATTACHMENT_BYTES` (25 MB) up front, before the in-memory multipart buffer is built
- All requests go through `fetchWithRetry()` (`src/utils/fetchWithRetry.ts`): idempotent calls (GET/HEAD/PUT/DELETE) retry on 429/503 with exponential backoff (honoring `Retry-After`); POST/PATCH are never retried (no duplicate comments/transitions). Error handling is narrowed — `getRemoteLinks` returns `[]` only on 404, and sprint-board iteration skips non-Scrum boards but rethrows auth (401) errors instead of yielding silently empty results
- Failed requests throw a typed `JiraApiError` (`src/utils/apiError.ts`, extends `ApiError`) carrying numeric `status`, `url`, and optional `body`. Classify with `err.status === 401`/`err.isAuth` etc. — never by sniffing message strings

## Bitbucket API

- Data Center base: `<baseUrl>/rest/api/1.0/`
  - Auth: `Authorization: Bearer <PAT>`
  - Health probe: `GET /profile/recent/repos?limit=1` (no "current user" endpoint exists in API 1.0)
- Cloud base: `https://api.bitbucket.org/2.0/`
  - Auth: `Authorization: Basic base64(username:apppassword)` — App Passwords from bitbucket.org → Personal settings → App passwords; **not** Atlassian API tokens
  - Current user: `GET /user` (requires Account: Read scope; gracefully degrades if scope absent)
- PR URL patterns:
  - Data Center: `<baseUrl>/projects/{KEY}/repos/{slug}/pull-requests/{id}`
  - Cloud: `bitbucket.org/{workspace}/{slug}/pull-requests/{id}`
  - Trailing segments (`/overview`, `/diff`, `/commits`) are stripped by `parsePrUrl`
- All requests go through `fetchWithRetry()` (`src/utils/fetchWithRetry.ts`): GET requests retry on 429/503 with backoff; POST comment writes are not retried
- Failed requests throw a typed `BitbucketApiError` (`src/utils/apiError.ts`) carrying numeric `status` — classify by `status`, not message text

## VS Code settings keys

All settings live under `package.json`'s `contributes.configuration`, grouped under six prefixes: `ticketSidekick.jira.*`, `.bitbucket.*`, `.email.*`, `.veracode.*`, `.waltz.*`, `.sessions.*`. That file is the authoritative source for exact keys, defaults, and descriptions. Every setting must also be listed in `docs/manual/settings-reference.md` with the same default; `src/test/userDocsSync.test.ts` fails otherwise. A setting's `description` is what users read in VS Code's Settings screen, so keep it in step with the code's behaviour.

## Credentials

Always stored in `vscode.ExtensionContext.secrets` (VS Code SecretStorage, OS-encrypted). Never in `settings.json`.

| Secret key | Contents |
| --- | --- |
| `ticket-sidekick.token` | Jira: PAT (DC) or `base64(email:apiToken)` (Cloud) |
| `ticket-sidekick.bitbucket.token` | Bitbucket: PAT (DC) or `base64(username:apppassword)` (Cloud) |

## Diagnostics

A shared VS Code Output Channel named `"Ticket Sidekick"` (`View → Output`,
via `getOutputChannel()`/`logDiag(scope, level, message, details?)` in
`src/utils/diagLog.ts`) is the place for anything a user or a future
debugging session needs beyond the chat transcript — model identity, retry
attempts, raw API errors, and major operations (ticket created, PR review
completed, cleanup batch run) across the tools and the boards. `level`
is `'info' | 'warn' | 'error'`; `details`, when given, is automatically
redacted/truncated by `src/utils/logRedaction.ts` before being written, so
call sites never need to sanitize their own data.

Files that already import `vscode` (`extension.ts`, `registerBoards.ts`,
`boardPanels.ts`, the `register*` tool files) call `logDiag` directly. The four
files that must stay `vscode`-free to remain loadable by Vitest
(`TicketService`, `PrReviewService`, `JiraApiClient`, `BitbucketApiClient`)
take an optional injected `onDiag?: DiagLogger` (constructor param on the
services, config field on the API clients) instead — the caller binds it to
a scope-tagged `logDiag` call at construction time, e.g.
`new TicketService(client, (level, message, details) => logDiag('jira.ticketService', level, message, details))`.
This mirrors the `onAttemptFailed` hook `src/utils/lmRetry.ts` already used
for the same reason. **New features should log
through `logDiag()`/`onDiag` too**, rather than inventing separate
console/output-channel logging.

## Documented Solutions

`docs/solutions/` — documented solutions to past problems (bugs, best
practices, workflow patterns), organized by category with YAML frontmatter
(`module`, `tags`, `problem_type`). Relevant when implementing or debugging
in documented areas.

`CONCEPTS.md` — shared domain vocabulary (entities, named processes, status
concepts) with project-specific meaning. Relevant when orienting to the
codebase or discussing domain concepts.

## Known-Limitation Register

[`docs/known-limitations.md`](docs/known-limitations.md) — consciously-deferred
known limitations, each with a severity, checked periodically by a scheduled
Routine rather than left to decay unnoticed. Relevant before adding a new
"known limitation" note elsewhere, and before declaring a real fix for one
already tracked there.

## Where documentation belongs

[`docs/README.md`](docs/README.md) is the index: which documents are current and which are history (dated plans and specs, which still name the removed chat participants).

New multi-step feature-flow detail belongs in the relevant domain doc —
[`docs/jira-flows.md`](docs/jira-flows.md), [`docs/report-import.md`](docs/report-import.md),
[`docs/review-process.md`](docs/review-process.md), or a new domain doc when
none of those fit — not in this file. When a feature grows a new flow, add
one line here: a short summary plus a link to where the detail lives. This
file stays a lean, always-loaded index; the domain docs are read on demand.

Those domain docs are for developers. Users read a separate **user manual**:
`README.md` (setup and the core-command tables) and the
[`docs/manual/`](docs/manual/) pages it links to. Any change users can see —
a new command, reply word, chip, setting, or changed behaviour — updates the
matching README table or manual page in the same PR. Updating a domain doc
does not cover it. `src/test/userDocsSync.test.ts` checks everything
`package.json` declares: settings, Command Palette commands, slash commands
(README tables) and Agent Mode tools
([`docs/manual/agent-mode-tools.md`](docs/manual/agent-mode-tools.md)), plus
the Jira tool catalog
([`docs/manual/copilot-tools.md`](docs/manual/copilot-tools.md)).
Chat flows, reply words and chips are not checked, so review them by hand
(tracked as KL9 in [`docs/known-limitations.md`](docs/known-limitations.md)).

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Multi-step state

There are no chat sessions any more: the `workspaceState` chat sessions and their `ChatResult.metadata` expiry went with `@jira` and `@bitbucket`, and their stored `jira.session.*` and `bitbucket.session.*` keys are left in place and never read. Multi-step work is a board's **session** (see "Tools, skills and boards" below).

## Jira flows

`@jira` is removed. [`docs/jira-flows.md`](docs/jira-flows.md) lists where each removed flow went, the cleanup rules the ticket list board keeps, and the import sessions.

## PR review flow (Bitbucket)

How the review board turns a PR into a grounded, line-accurate,
staged LLM review — chunking, anchor verification, provenance tagging, the
regular pass, the persona passes, the critic, the requirements check, Explain,
Post and Copy — is documented in
[`docs/review-process.md`](docs/review-process.md). **Keep that document in
sync with any change to the review pipeline.**

## Report import (EML, Veracode, Waltz)

The import board (`src/boards/import/`) turns a Veracode Detailed Report or a
Waltz OSS Report, or one or more `.eml` emails, into Jira tickets; all
three share the import engine in `src/imports/` and its
`ReportImportDescriptor` (email as a dedup-less third kind). Documented in
[`docs/report-import.md`](docs/report-import.md), user manual in
[`docs/manual/boards.md`](docs/manual/boards.md#jira-import-board).
Emails first pass through the board's boilerplate cleanup stage (patterns, the model check as a previewed plan, strip/keep), then each becomes a ticket or a comment, with likely repeats marked by subject.

## Tools, skills and boards

This is the current architecture; design, module layout, security model and the "adding a board, tool, skill or action" checklists are in [`docs/architecture/boards-and-sessions.md`](docs/architecture/boards-and-sessions.md), the requirements in [`docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md). What is done and what is still open for the full migration is listed in [`docs/architecture/migration-status.md`](docs/architecture/migration-status.md); update it with every change that closes or adds an open point. There is no MCP server, no canvas and no local HTTP server; [`docs/architecture/copilot-harness-migration.md`](docs/architecture/copilot-harness-migration.md) and the plans dated 2026-11-05 and 2026-11-09 are superseded history.

**Tools.** The seventeen Jira tools (check connection, view, find, list filters, workflow, list templates, create template, load, move, create, comment, update field, correct description, upload, list fields, check required fields, open board) are `ToolDefinition`s (`src/tools/toolDefinition.ts`: `defineTool`, `callTool`, `ToolFailure`) in the vscode-free catalog `src/tools/jiraTools/` (names any message text uses in `toolNames.ts`, shared dependencies in `jiraAccess.ts`). `src/tools/registerJiraTools.ts` registers each with `vscode.lm.registerTool`; a tool that is not read-only shows a confirmation with every value it will write (`jiraToolConfirmation.ts`), plus what its optional `preview` works out from Jira or the workspace (`confirmationWithPreview`). `jira_correct_description` applies approved spelling corrections to the stored wiki description through the pure `src/utils/descriptionCorrections.ts` (only the listed text changes; code, monospace, link targets and web addresses are protected), and `jira_create_template` saves a template built from a ticket through `src/templates/templateFromTicket.ts` (next free numbered name, never a replace). Their `contributes.languageModelTools` entries are generated from the catalog: run `node scripts/sync-tools.mjs` after adding or changing a tool (`src/test/toolManifest.test.ts` fails when they differ). The write tools share a one-minute duplicate guard kept in the long-lived tool dependencies (`writeGuard.ts`), and a write Jira does not answer in time is reported as possibly saved. The Bitbucket tools are in the vscode-free catalog `src/tools/bitbucketTools/`, registered by `src/tools/registerBitbucketTools.ts`.

**Skills.** `/ts-jira-create`, which the agent also starts by itself for a new ticket so it goes through a template and a draft, and the explicit-only (`disable-model-invocation`) `/ts-jira-brief`, `/ts-jira-spell-check`, `/ts-jira-template` and `/ts-jira`, a command router the user types, e.g. `/ts-jira load PROJ-123`, whose `help brief`/`help create`/`help spell-check`/`help template` print `help-brief.md`/`help-create.md`/`help-spell-check.md`/`help-template.md` from its folder, live in `skills/<name>/SKILL.md`, contributed through `contributes.chatSkills`; `src/test/skillsGuard.test.ts` fails on a `jira_` name not in the catalog, a frontmatter `name` other than the folder, a `ts-` skill other than `ts-jira-create` without `disable-model-invocation`, or another skill with it, a `/ts-jira` row naming a tool or skill that does not exist or a tool without a row, or a basic `@jira` command with no tool or skill left for it. User manual page: [`docs/manual/copilot-tools.md`](docs/manual/copilot-tools.md), checked against the catalog by `src/test/userDocsSync.test.ts`.

**Boards and sessions.** A board is a webview in an editor tab that shows a **session** the extension owns and caches on disk; the page holds no state. `src/boards/boardPanels.ts` opens the tab for the `jira_open_board` and `bitbucket_open_review` tools and six Command Palette commands, writes its document (`boardPanelHtml.ts`), answers the page's `postMessage` requests through `src/boards/boardMessages.ts` (vscode-free; the tab, not the page, names the session) and restores the tab after a restart. `src/sessions/` (vscode-free) has the session types, the id derived from kind and source, the file store, and `SessionManager` (open or restore, actions in order, background check (told `background` or `refresh` through `CheckMode`) with conflicts, single-use plan ids, native confirmation for risky writes, no preview or Apply while the last check failed (`writesBlocked`), expiry). A board's rules live in one `BoardKind` object under `src/boards/<kind>/` with pure `reduce`, `plan` and `reconcile`; `src/boards/registerBoards.ts` and `boardPanels.ts` are the only board files that import `vscode`. Pages are plain files in `board-pages/` (shared client and style, one `page.js` per board), copied to `out/board-pages` by `esbuild.js`. Built so far: the security report, the ticket list (`src/boards/ticketList/`: `kind.ts` for the rules — paging, extra columns, the out-of-date state, add or remove of list values — `cleanupSource.ts` for a cleanup rule's check and lookup (`checkCleanupRules`, `lookupCleanupRule`), query, subtasks and paths, `jiraDeps.ts` for search, move, field update, rules, workflow and resolutions over the services), the sessions board, the import board for Veracode, Waltz and emails (`src/boards/import/`: a session-less start screen, the kind with one area handler per tab and the email cleanup stage, over the shared engine `src/imports/`), and the PR review board (`src/boards/review/`: a session-less start screen, the first step, the staged review over `src/review/engine/`, Explain, Post and Copy). The session model saves after each write of an Apply, shows Apply progress with the controls locked, rebuilds a board from its stored recipe after an update that changes the stored format (`revalidate`), reads before a plan's preview (`prepare`) and moves a session to a new source (`relocate`, for "Pick the file again"). User manual: [`docs/manual/boards.md`](docs/manual/boards.md).

## Onboarding

Language Model tools (`contributes.languageModelTools`, letting Copilot Agent
Mode call Jira/Bitbucket operations directly), the `/ts-jira` and
`/ts-bitbucket` skills, and the two Getting-Started walkthroughs are documented in
[`docs/onboarding.md`](docs/onboarding.md).
