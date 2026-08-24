# Ticket Sidekick — Agent Context

## What this is

A VS Code extension with two independent GitHub Copilot Chat participants:

- **`@jira`** — manage Jira tickets (create, read, edit fields, comment, search) in natural language
- **`@bitbucket`** — review Bitbucket pull requests with structured LLM analysis and multi-turn follow-ups

The two participants share `ConfigService` for credential storage but are otherwise fully independent. Neither requires the other to be configured.

## Architecture (three layers — never skip)

### Jira

```text
JiraParticipant → TicketService → IJiraClient (interface)
                                       ↓
                               JiraApiClient (production HTTP)
                               MockJiraClient (test fixture returns)
```

**Rule:** `TicketService` imports `IJiraClient` only — never `JiraApiClient` directly.

### Bitbucket

```text
BitbucketParticipant → PrReviewService → IBitbucketClient (interface)
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
| `src/bitbucket/BitbucketApiClient.ts` | Real HTTP; Data Center (Bearer PAT) + Cloud (Basic base64(username:apppassword)) |
| `src/services/TicketService.ts` | Jira business logic; depends on IJiraClient. `isMultiLine()` decides table-row vs own-section by field schema (textarea / description / environment → section; single-line text & URL stay inline even when long), falling back to a length heuristic |
| `src/services/PrReviewService.ts` | PR review logic: diff parsing, file gathering, two-pass LLM prompt building, result formatting |
| `src/services/ConfigService.ts` | VS Code settings + SecretStorage for both Jira and Bitbucket |
| `src/services/configValidation.ts` | Pure (vscode-free) config validators; `validateBaseUrl` rejects malformed/non-http(s) base URLs. Surfaced by `@jira check` and `@bitbucket check` (DC) before attempting a connection |
| `src/participant/JiraParticipant.ts` | Jira chat handler + intent routing; delegates to `src/participant/jira/` handlers |
| `src/participant/jira/llmHelpers.ts` | `Operation` type, `ParsedIntent`, `INTENT_PROMPT`, all LLM utility functions |
| `src/participant/jira/ticketContext.ts` | Ticket key + project key resolution helpers |
| `src/participant/jira/contentHandler.ts` | Content preview/refinement flow (`streamContentPreview`, `handleContentSession`) |
| `src/participant/jira/createHandler.ts` | Ticket creation flow (templates, issue type selection, section Q&A) |
| `src/participant/jira/loadHandler.ts` | Load-ticket handler (attachment download, comment pagination) |
| `src/participant/jira/fieldHandler.ts` | Field update flow + explicit `@jira spell check` command |
| `src/participant/jira/cleanupHandler.ts` | Bulk cleanup flow (review screen, transition batch execution) |
| `src/participant/jira/workflowHandler.ts` | Workflow discovery handler |
| `src/participant/jira/emailHandler.ts` | Email-to-ticket chat flow: reads pre-built `EmailContentSession` from workspaceState → streams preview → confirm/create |
| `src/utils/emlParser.ts` | Parses `.eml` files via `postal-mime`; returns `ParsedEml` (subject, sender, date, htmlBody, plainBody, inlineImageMap, attachments) |
| `src/utils/reportImport.ts` | Shared, `vscode`-free primitives used by both the Veracode and Waltz importers: `chunkStrings`, `buildDedupJql` (always quotes labels), `extractDedupMap` (nested `{key, fields:{labels?}}[]` shape), `findAlreadyTicketed` (fault-tolerant per-chunk dedup search — one failed chunk doesn't discard matches from others), `capNewRows` (pre-cap-before-build, tracks `totalNewMatched`/`droppedOverCap`), `buildReviewRows`, `sanitizeCellText`/`sanitizeStandaloneLine` (untrusted-content sanitizers — the latter prefixes a value with `: ` before it becomes a standalone line, closing line-start injection vectors span-text stripping alone can't), and the shared `MAX_REPORT_BYTES`/`BATCH_LIMIT` constants |
| `src/participant/jira/reportImportHandler.ts` | Shared session-flow orchestration for both report importers: template/issue-type selection, review-screen streaming, toggle-reply handling, batch ticket creation — parameterized per importer by a `ReportImportDescriptor` (parser, config reader, content builders, `labelToDedupKey`, review-table columns, optional issue-type-fetch-failure UI callback). Owns the shared message wording (missing-template warning, cap/resume message, toggle-reply footer) so the two importers can't drift apart the way they did pre-consolidation |
| `src/utils/veracodeReport.ts` | Veracode Detailed Report XML parsing (`parseVeracodeReport`, with `ISSUE_ID_PATTERN`/`CWE_ID_PATTERN` validation dropping malformed ids rather than letting them reach a generated URL), filtering, short-label/summary/label builders, and `buildDescriptionWiki` (Markdown-authored, every untrusted field sanitized via `reportImport.ts`, converted once via `markdownToJiraWiki()`) — pure, no `vscode` import |
| `src/participant/jira/veracodeHandler.ts` | Thin Veracode-specific wrapper: parser/config/content-builder descriptor passed to `reportImportHandler.ts`; re-exports the handler functions under their original names so `extension.ts`/`JiraParticipant.ts` need no changes |
| `src/utils/waltzReport.ts` | Waltz/SCA OSS Report `.xlsx` parsing, filtering, summary/description/label builders (labels are sanitized + 6-hex-char-hash-suffixed for collision safety) — pure, no `vscode` import |
| `src/participant/jira/waltzHandler.ts` | Thin Waltz-specific wrapper: parser/config/content-builder descriptor passed to `reportImportHandler.ts`; re-exports the handler functions under their original names |
| `src/participant/BitbucketParticipant.ts` | Bitbucket chat handler: check, PR review, multi-turn follow-ups |
| `src/participant/sessionState.ts` | VS Code-free pure helpers and Jira multi-turn session types; includes `pickEmailOption()` for unified template+issue-type selection |
| `src/participant/reviewSessionState.ts` | Bitbucket session types + all pure review helpers: `parsePrUrl`, `hasPrUrl`, `parseDiff`, `parseFollowUpIntent` (parses multi-turn follow-up messages into a typed `FollowUpIntent` — `add` with `targets: number[] \| 'all'` and extracted note, or `explain` with cleaned `question` text and optional `findingRef`), `buildAdaptiveChunks`, `numberDiffLines` (render-only gutter), `locateAnchor` + `resolveFindingAnchors` (verify line from quoted `anchorCode`, tag provenance), `dedupeFindings`, `extractHunkAround`, `selectFilesWithinBudget`, `parseCriticKeep` |
| `src/services/WorkflowService.ts` | Workflow graph cache I/O, BFS path-finding, `discoverWorkflow` sampling |
| `src/templates/TemplateService.ts` | Reads `.jira-templates.json`; returns `{ templates, cleanupRules }` |
| `src/templates/FieldResolver.ts` | Resolves `resolveFields` entries by name (API lookup) or id (pass-through) |
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name |
| `src/utils/markdownFormatter.ts` | `formatJiraBody(node)` — converts Jira wiki markup (v2 string) or ADF object (v3/legacy) to Markdown; `wikiToMarkdown(str)` delegates to `jiraWikiToMarkdown` |
| `src/utils/jiraWikiToMarkdown.ts` | Own Jira wiki markup → Markdown converter; handles headings, tables, lists, code/noformat blocks, quotes, panels, and all inline markup without any third-party dependency |
| `src/utils/htmlToMarkdown.ts` | Converts HTML email body to Markdown; resolves `cid:` references via optional `inlineImageMap`; strips OWA span whitespace inside bold/italic |
| `src/utils/extractJsonObject.ts` | Bracket-counting extractor for the first complete JSON object in a raw LLM response (ignores braces in strings + trailing prose). Shared by `parseIntent` (Jira) and the Bitbucket review parser; `reviewSessionState.ts` re-exports it so neither participant imports the other |
| `src/utils/lmRetry.ts` | 3-try retry for VS Code Language Model API calls: `withLmRetry` (identical-retry, for a single non-splittable prompt) and `withEasierRetry` (the 3rd try splits a batch in half instead of repeating it). `isTransientLmError` classifies which failures are worth retrying. `PartialLmResponseError` preserves any text a broken response stream had already sent |
| `src/utils/diagTypes.ts` | `LogLevel` (`'info' \| 'warn' \| 'error'`) and `DiagLogger` types — no `vscode` import, so `TicketService`/`PrReviewService`/`JiraApiClient`/`BitbucketApiClient` can depend on them without pulling in `vscode` transitively |
| `src/utils/logRedaction.ts` | `sanitizeDetails()` — recursively redacts values whose key looks like a secret and truncates long strings before a `logDiag` details object is written to the Output Channel. Applied automatically inside `logDiag`; no call site invokes it directly |
| `src/utils/diagLog.ts` | Shared `"Ticket Sidekick"` VS Code Output Channel singleton (`getOutputChannel()`) and `logDiag(scope, level, message, details?)` — the place for diagnostic detail beyond the chat transcript. `level` (`'info' \| 'warn' \| 'error'`) tags each line for skimmability; `details` is redacted/truncated via `logRedaction.ts` automatically. Used throughout both `@jira` and `@bitbucket` |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron participant tests (requires VS Code)
```

Node.js is managed by **Volta** — use `~/.volta/bin/npm` if `npm` isn't on your PATH (e.g. in scripts or terminals that don't load the shell profile).

**`npm test` must be green before every commit.** Run `npm run compile` to catch TypeScript errors first.

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run compile` → `npm test` on every push and pull request against `main` (Node 24). The `test:e2e` suite is not run in CI (it needs a real VS Code instance).

Releases are manual: `.github/workflows/release.yml` is a `workflow_dispatch` with inputs `channel` (`release` | `preview`), `bump` (`patch`/`minor`/`major`), and an optional explicit `version` (overrides `bump`). It computes the version via `npm version --no-git-tag-version`, gates on compile+test, builds the `.vsix`, publishes to the Marketplace (`vsce publish`, needs the `VSCE_PAT` secret), and creates the GitHub Release + bare tag `X.Y.Z`. **Both** channels commit the bump back to the branch and push it, so the published version line is strictly increasing and a version is never reused (avoids the Marketplace "no duplicate version" rule with no manual bumping); `preview` only adds `--pre-release` + marks the GitHub release as a pre-release. See the README "Releasing" section.

## Testing

Write tests for **user-facing use cases**, not internal mechanics. A test should read like a scenario: given this input, what does the user get back? Cover the happy path and the main failure case for every new feature.

`JiraParticipant.ts` and `BitbucketParticipant.ts` import `vscode` and cannot be loaded by Vitest. Keep pure logic (string extraction, data formatting) in `sessionState.ts`, `reviewSessionState.ts`, `TicketService.ts`, or `PrReviewService.ts` so it can be unit-tested. VS Code-dependent glue code is covered by the e2e suite only.

## Adding a new Jira operation

1. Add method to `IJiraClient` interface
2. Implement in `JiraApiClient` (real HTTP)
3. Implement in `MockJiraClient` (fixture return)
4. Add a fixture file to `src/test/fixtures/` matching real Jira v3 API shape
5. Write failing tests in `TicketService.test.ts`
6. Implement in `TicketService` (business logic) until tests pass
7. Add intent routing in `JiraParticipant.ts`
8. If the new operation introduces any pure extraction/transformation logic, put it in `sessionState.ts` and test it in `JiraParticipant.test.ts`
9. If the operation introduces a new multi-step flow, document it in `docs/jira-flows.md` (or the relevant domain doc) — add only a one-line summary and link here, not new flow prose (see "Where documentation belongs")

## Adding a new Bitbucket operation

1. Add method to `IBitbucketClient` interface
2. Implement in `BitbucketApiClient` (real HTTP, handle both DC and Cloud branches)
3. Implement in `MockBitbucketClient` (fixture return)
4. Write failing tests in `PrReviewService.test.ts`
5. Implement in `PrReviewService` (business logic) until tests pass
6. Add routing in `BitbucketParticipant.ts`
7. If the operation introduces pure helpers, put them in `reviewSessionState.ts` and test them in `PrReviewService.test.ts`
8. If the operation introduces a new multi-step flow, document it in `docs/review-process.md` (or the relevant domain doc) — add only a one-line summary and link here, not new flow prose (see "Where documentation belongs")

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

All settings live under `package.json`'s `contributes.configuration`, grouped under five prefixes: `ticketSidekick.jira.*`, `.bitbucket.*`, `.email.*`, `.veracode.*`, `.waltz.*`. That file is the authoritative source for exact keys, defaults, and descriptions.

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
completed, cleanup batch run) across both `@jira` and `@bitbucket`. `level`
is `'info' | 'warn' | 'error'`; `details`, when given, is automatically
redacted/truncated by `src/utils/logRedaction.ts` before being written, so
call sites never need to sanitize their own data.

Files that already import `vscode` (both participant files, `extension.ts`,
all of `src/participant/jira/*Handler.ts`) call `logDiag` directly. The four
files that must stay `vscode`-free to remain loadable by Vitest
(`TicketService`, `PrReviewService`, `JiraApiClient`, `BitbucketApiClient`)
take an optional injected `onDiag?: DiagLogger` (constructor param on the
services, config field on the API clients) instead — the caller binds it to
a scope-tagged `logDiag` call at construction time, e.g.
`new TicketService(client, (level, message, details) => logDiag('jira.ticketService', level, message, details))`.
This mirrors the `onAttemptFailed` hook `src/utils/lmRetry.ts` already used
for the same reason. **New features in either participant should log
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

## Where documentation belongs

New multi-step feature-flow detail belongs in the relevant domain doc —
[`docs/jira-flows.md`](docs/jira-flows.md), [`docs/report-import.md`](docs/report-import.md),
[`docs/review-process.md`](docs/review-process.md), or a new domain doc when
none of those fit — not in this file. When a feature grows a new flow, add
one line here: a short summary plus a link to where the detail lives. This
file stays a lean, always-loaded index; the domain docs are read on demand.

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Multi-turn session state

Multi-turn flows store structured state in `vscode.ExtensionContext.workspaceState` and embed a compact HTML tag in the response as an expiry signal. On the next turn, the handler checks whether the tag appears in the **last** assistant response; if it does, it reads from `workspaceState`. If the user moved on (different response is last), the tag is absent and the session is silently ignored.

Jira's sixteen session types plus their `workspaceState` keys and response tags live in [`docs/jira-flows.md`](docs/jira-flows.md#jira-sessions). Bitbucket's single `ReviewSession` — key, tag, detection order, and the PR-URL-bypass rule — lives in [`docs/review-process.md`](docs/review-process.md#follow-ups).

## Jira flows

`@jira`'s multi-turn flows — ticket creation (template/project/summary/issue-type
resolution), bulk cleanup (`cleanupRules` review-and-transition), workflow
discovery (BFS-based transition-path finding), comment handling
(summarize/search up to 100 comments), content preview/refinement
(generate-then-confirm for descriptions and comments), and last-ticket context
(resolving a bare follow-up prompt to the right ticket) are documented in
[`docs/jira-flows.md`](docs/jira-flows.md).

## PR review flow (Bitbucket)

How `@bitbucket <pr-url>` turns a PR into a grounded, line-accurate,
multi-pass LLM review — chunking, anchor verification, provenance tagging,
quick/deep modes, the critic pass, and follow-up turns — is documented in
[`docs/review-process.md`](docs/review-process.md). **Keep that document in
sync with any change to the review pipeline.**

## Report import (EML, Veracode, Waltz)

`@jira` turns an `.eml` email, a Veracode Detailed Report, or a Waltz OSS
Report into Jira tickets — including the dedup/review/batch-creation flow
Veracode and Waltz import share via `reportImportHandler.ts`. Documented in
[`docs/report-import.md`](docs/report-import.md).
