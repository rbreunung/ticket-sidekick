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

```text
OutlookService → IOutlookClient (interface)
                      ↓
              OutlookApiClient (Microsoft Graph HTTP, vscode.authentication)
              MockOutlookClient (test fixture)
```

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
| `src/services/TicketService.ts` | Jira business logic; depends on IJiraClient |
| `src/services/PrReviewService.ts` | PR review logic: diff parsing, file gathering, two-pass LLM prompt building, result formatting |
| `src/services/ConfigService.ts` | VS Code settings + SecretStorage for both Jira and Bitbucket |
| `src/participant/JiraParticipant.ts` | Jira chat handler + intent routing; delegates to `src/participant/jira/` handlers |
| `src/participant/jira/llmHelpers.ts` | `Operation` type, `ParsedIntent`, `INTENT_PROMPT`, all LLM utility functions |
| `src/participant/jira/ticketContext.ts` | Ticket key + project key resolution helpers |
| `src/participant/jira/contentHandler.ts` | Content preview/refinement flow (`streamContentPreview`, `handleContentSession`) |
| `src/participant/jira/createHandler.ts` | Ticket creation flow (templates, issue type selection, section Q&A) |
| `src/participant/jira/loadHandler.ts` | Load-ticket handler (attachment download, comment pagination) |
| `src/participant/jira/fieldHandler.ts` | Field update flow + explicit `@jira spell check` command |
| `src/participant/jira/cleanupHandler.ts` | Bulk cleanup flow (review screen, transition batch execution) |
| `src/participant/jira/workflowHandler.ts` | Workflow discovery handler |
| `src/participant/jira/emailHandler.ts` | Email-to-ticket chat flow: OWA handover shortcut (reads `jira.handover.email` from workspaceState) + Microsoft Graph folder picker / email selection / preview / create |
| `src/participant/BitbucketParticipant.ts` | Bitbucket chat handler: check, PR review, multi-turn follow-ups |
| `src/participant/sessionState.ts` | VS Code-free pure helpers and Jira multi-turn session types; includes `pickEmailOption()` for unified template+issue-type selection |
| `src/participant/reviewSessionState.ts` | Bitbucket session types, `parsePrUrl`, `parseDiff`, `resolveByNumber` |
| `src/services/WorkflowService.ts` | Workflow graph cache I/O, BFS path-finding, `discoverWorkflow` sampling |
| `src/templates/TemplateService.ts` | Reads `.jira-templates.json`; returns `{ templates, cleanupRules }` |
| `src/templates/FieldResolver.ts` | Resolves `resolveFields` entries by name (API lookup) or id (pass-through) |
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name |
| `src/utils/markdownFormatter.ts` | `formatJiraBody(node)` — converts Jira wiki markup (v2 string) or ADF object (v3/legacy) to Markdown; `wikiToMarkdown(str)` delegates to `jiraWikiToMarkdown` |
| `src/utils/jiraWikiToMarkdown.ts` | Own Jira wiki markup → Markdown converter; handles headings, tables, lists, code/noformat blocks, quotes, panels, and all inline markup without any third-party dependency |
| `src/outlook/IOutlookClient.ts` | All Outlook/Graph types + IOutlookClient interface |
| `src/outlook/OutlookApiClient.ts` | Real Microsoft Graph HTTP; auth via `vscode.authentication` |
| `src/services/OutlookService.ts` | Outlook business logic: list folders, list emails, fetch+convert email |
| `src/utils/htmlToMarkdown.ts` | Converts HTML email body to Markdown; `data-ts-filename` imgs → `![name](name)`; `cid:` imgs → `[📎 name]`; strips OWA span whitespace inside bold/italic |
| `src/utils/owaUserscript.ts` | Generates the Tampermonkey userscript string via `generateOwaUserscript()`; embeds `MANIFEST_VERSION` in every saved JSON |
| `src/utils/handoverFolder.ts` | Reads handover folder into `HandoverEmail`; validates `scriptVersion` against `REQUIRED_MANIFEST_VERSION`; purges stale subfolders; deletes subfolder after ticket creation |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron participant tests (requires VS Code)
```

**`npm test` must be green before every commit.** Run `npm run compile` to catch TypeScript errors first.

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

## Adding a new Bitbucket operation

1. Add method to `IBitbucketClient` interface
2. Implement in `BitbucketApiClient` (real HTTP, handle both DC and Cloud branches)
3. Implement in `MockBitbucketClient` (fixture return)
4. Write failing tests in `PrReviewService.test.ts`
5. Implement in `PrReviewService` (business logic) until tests pass
6. Add routing in `BitbucketParticipant.ts`
7. If the operation introduces pure helpers, put them in `reviewSessionState.ts` and test them in `PrReviewService.test.ts`

## Jira API

- Base path: `<baseUrl>/rest/api/2/` — used for all standard operations on both Data Center and Cloud
- Data Center auth: `Authorization: Bearer <PAT>`
- Cloud auth: `Authorization: Basic base64(email:apiToken)`
- Descriptions and comments are always sent and received as **plain strings** (Jira wiki markup). ADF is not used; `wrapInAdf()` has been removed.
- For Cloud-only fields that require the v3 API: add a `requestV3()` private method in `JiraApiClient` when the need arises. No current operations require it.
- Reading: `extractTextFromAdf()` in `TicketService` handles both plain strings (v2 read) and ADF objects (legacy rich content), so existing tickets with ADF descriptions display correctly.
- Agile API base path: `<baseUrl>/rest/agile/1.0/` — used for sprint resolution (`getSprintByName`)
- Teams API base path: `<baseUrl>/rest/teams/1.0/` — used for Data Center team resolution (`getTeamByName`); Cloud does not support team lookup by name, use `id` in the template instead

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

## VS Code settings keys

### Jira settings

| Setting | Key |
| --- | --- |
| Base URL | `ticketSidekick.jira.baseUrl` |
| Auth type | `ticketSidekick.jira.authType` (`datacenter` \| `cloud`) |
| Default project | `ticketSidekick.jira.defaultProject` |
| Required fields | `ticketSidekick.jira.requiredFields` |
| Show connection info | `ticketSidekick.jira.showConnectionInfo` |

### Bitbucket settings

| Setting | Key |
| --- | --- |
| Base URL (DC only) | `ticketSidekick.bitbucket.baseUrl` |
| Auth type | `ticketSidekick.bitbucket.authType` (`datacenter` \| `cloud`) |
| Show connection info | `ticketSidekick.bitbucket.showConnectionInfo` |
| Review instructions | `ticketSidekick.bitbucket.reviewInstructions` |

### Outlook settings

| Setting | Key |
| --- | --- |
| Folder ID | `ticketSidekick.outlook.folderId` |
| Email list size | `ticketSidekick.outlook.emailListSize` |
| OWA URL | `ticketSidekick.outlook.owaUrl` |
| Handover folder | `ticketSidekick.email.handoverFolder` (default: `~/Downloads/`) |
| Cleanup model | `ticketSidekick.email.cleanupModel` (AI footer removal model family) |

## Credentials

Always stored in `vscode.ExtensionContext.secrets` (VS Code SecretStorage, OS-encrypted). Never in `settings.json`.

| Secret key | Contents |
| --- | --- |
| `ticket-sidekick.token` | Jira: PAT (DC) or `base64(email:apiToken)` (Cloud) |
| `ticket-sidekick.bitbucket.token` | Bitbucket: PAT (DC) or `base64(username:apppassword)` (Cloud) |

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Multi-turn session state

Multi-turn flows store structured state in `vscode.ExtensionContext.workspaceState` and embed a compact HTML tag in the response as an expiry signal. On the next turn, the handler checks whether the tag appears in the **last** assistant response; if it does, it reads from `workspaceState`. If the user moved on (different response is last), the tag is absent and the session is silently ignored.

### Jira sessions

| Session | workspaceState key | Tag in response |
| --- | --- | --- |
| `ResolutionSelectionSession` | `jira.session.resolutionSelection` | `<!-- jira:selecting-resolution -->` |
| `TransitionBatchSession` | `jira.session.transitionReview` | `<!-- jira:transition-review -->` |
| `FilterSelectionSession` | `jira.session.filterSelection` | `<!-- jira:selecting-filter -->` |
| `BulkUpdateReviewSession` | `jira.session.bulkUpdateReview` | `<!-- jira:bulk-update-review -->` |
| `SearchResultSession` | `jira.session.searchResult` | _(no marker — background session, overwritten on each search)_ |
| `TemplateSelectionSession` | `jira.session.templateSelection` | `<!-- jira:selecting-template -->` |
| `IssueTypeSelectionSession` | `jira.session.typeSelection` | `<!-- jira:selecting-type -->` |
| `CreationSession` | `jira.session.creating` | `<!-- jira:creating -->` |
| `ContentSession` | `jira.session.previewing` | `<!-- jira:previewing -->` |
| `MoreCommentsSession` | `jira.session.moreComments` | `<!-- jira:more-comments -->` |
| `CommentListSession` | `jira.session.commentList` | `<!-- jira:comment-list -->` |
| `LoadSkippedSession` | `jira.session.loadSkipped` | `<!-- jira:load-skipped -->` |
| `FolderSelectionSession` | `jira.session.folderSelection` | `<!-- jira:folder-selection -->` |
| `EmailSelectionSession` | `jira.session.emailSelection` | `<!-- jira:email-selection -->` |
| `EmailContentSession` | `jira.session.emailContent` | `<!-- jira:email-content -->` |
| `HandoverEmail` (one-shot, not a session) | `jira.handover.email` | _(no marker — cleared immediately on read)_ |

Detection order in the Jira handler: resolution selection → transition review → filter selection → bulk-update-review → template selection → issue type selection → creation → content → more-comments → check command → load-skipped → folder selection → email selection → email content → comment list → intent parse.

### Bitbucket sessions

| Session | workspaceState key | Tag in response |
| --- | --- | --- |
| `ReviewSession` | `bitbucket.session.review` | `<!-- bitbucket:review-session -->` |

Detection order in the Bitbucket handler: `check` command → review session follow-up → new PR review.

## Ticket creation flow

`handleCreateTicket` in `JiraParticipant` resolves missing mandatory fields interactively:

1. **Template** — chat-native numbered list streamed from `.jira-templates.json`; user replies with number, name, `(n)` / `"no template"` to skip, or `(c)` to cancel entirely; unrecognised reply re-presents the list; template load errors surface as chat messages and fall through to templateless creation
2. **Project key** — from prompt, then `ticketSidekick.jira.defaultProject` setting, then `showInputBox`
3. **Summary** — from prompt (LLM extraction), then `showInputBox`
4. **Issue type** — from template `issueType` field or prompt (LLM extraction); if neither is present, chat-native numbered list via `IssueTypeSelectionSession` (subtasks filtered out); `(c)` to cancel; fallback to `showInputBox` if no types can be fetched from `GET /rest/api/2/project/{key}`

If a template is chosen:

- `FieldResolver.resolve(defaultFields, resolveFields)` maps any `name`-based specs to Jira field values via API lookups; `id`-based specs pass through directly; array entries produce array results
- `descriptionSections` (optional) drives a multi-turn Q&A via `CreationSession`; if absent or empty, ticket is created directly
- When all sections are answered `finishTicketCreation` assembles the description and calls `TicketService.createTicket`
- Field resolution + section handling are in `continueAfterIssueType`, called from both `handleCreateTicket` and the issue type session handler

API endpoint: `POST /rest/api/2/issue` with `{ fields: { project: { key }, summary, issuetype: { name }, ...additionalFields } }`

## PR review flow (Bitbucket)

1. Parse PR URL → extract project/workspace, repo, PR id, auth type
2. `BitbucketApiClient.getPullRequest` → metadata (title, author, target branch, source commit hash)
3. `BitbucketApiClient.getPullRequestDiff` → raw unified diff string
4. `parseDiff(raw)` → `FileDiff[]` (one entry per changed file)
5. `PrReviewService.gatherFileContents` — for each changed file: workspace reader first (`vscode.workspace.findFiles`), API fallback (`getFileContent`); all files fetched in parallel via `Promise.all`
6. `PrReviewService.buildPrompt` → structured prompt with file diffs + full file contents
7. LLM returns `{ findings: ReviewFinding[], additionalFilesNeeded: string[] }`
8. If `additionalFilesNeeded` is non-empty: fetch up to 5 extra files (parallel), re-run prompt (pass 2)
9. `PrReviewService.formatReview` → markdown report with numbered findings grouped by file
10. `ReviewSession` saved to `workspaceState` for follow-up turns

## Comment handling

`getComments` fetches up to 20 newest comments via `TicketService.getIssueComments`, then asks the LLM to synthesize them:

- No query → one-sentence summary per comment
- With query (e.g. "login bug") → finds and quotes relevant comments with author and date

If the ticket has more than 20 comments the response includes a load-more offer via `MoreCommentsSession`. The user confirms ("load all") to fetch up to 100 comments and re-synthesize.

`TicketService.getTicket` (and therefore `@jira show`) also includes a **Comments** section rendered by `formatComments()`. Each comment shows author display name, date (YYYY-MM-DD), and body extracted from ADF.

## Content preview/refinement

`addComment` with a non-literal `contentSource`, and `updateField` for the description field, trigger a chat-native preview loop via `ContentSession`:

1. LLM generates the content based on the instruction (and optional conversation history for `history-recent` / `history-full`)
2. Content is streamed to chat with a confirm/adjust prompt
3. User confirms ("post it") → content is posted; user cancels → session cleared; user gives a refinement instruction → LLM regenerates with the previous content and instruction as context, new preview is streamed

`contentSource` is resolved by the intent parser:

- `"literal"` — user provided exact text; skip preview, post directly
- `"generate"` — new content from scratch
- `"history-recent"` — synthesise from the last 3 conversation turns
- `"history-full"` — synthesise from the entire conversation history

## Last-ticket context

After every successful ticket operation, `JiraParticipant` appends `<!-- @jira-ticket:KEY -->` to the response (invisible in rendered markdown).

When a follow-up prompt arrives without an explicit ticket key, the handler scans `ChatContext.history` in reverse via `extractLastTicketFromText` and resolves to the last referenced ticket automatically.

**Ticket key resolution order (highest to lowest priority):**

1. Explicit key in the user's prompt
2. Current git branch (regex `[A-Z][A-Z0-9]+-\d+`)
3. Last ticket from `ChatContext` history (hidden marker)
4. `showInputBox` — ask the user

## Workflow discovery

`@jira discover workflow PROJ Bug` samples tickets across all statuses, calls `getTransitions` on a representative per status, and builds a directed graph. Saved to `.jira-workflow-cache.json` at the workspace root. Re-run any time the workflow changes.

`WorkflowService.findPath(graph, from, to)` uses BFS to find the shortest sequence of transitions from the current status to the target state.

## Bulk cleanup

`cleanupRules` in `.jira-templates.json` define named rules:

- `project`, `issueType`, `targetState` — required
- `resolution` — optional; if omitted and target is a closed state, asked in chat once before the review screen
- `closeSubtasks` — if true, open subtasks appear in the review and are transitioned before their parent

Trigger: `@jira run cleanup "rule name"` or ad-hoc `@jira close PROJ bugs in "Fix Version 3.2"` (exact version match required).

Review screen shows all tickets with their subtasks and proposed transitions. User replies: **ok**, **(c)** to cancel the run, or key numbers to skip (cascading: subtask skip → parent skipped; parent skip → all subtasks skipped).

Execution streams one line per ticket (subtasks first), then a summary. Failures are collected and reported at the end — the batch continues on failure.

## OWA Tampermonkey bridge

When Microsoft Graph API Mail.Read is blocked by the corporate tenant, the email-to-ticket flow uses a local file bridge instead.

### Handover folder contract

The Tampermonkey script saves all email data into a **flat JSON file** in the handover folder:

```
~/Downloads/                             ← configurable via ticketSidekick.email.handoverFolder
  TicketSidekick-1716459123456.json      ← one file per click; timestamp is the session ID
```

VS Code polls for the file (up to 15 s), reads it, converts the email, then **deletes the file** after the ticket is created. Files older than 24 h are purged on each invocation.

### Manifest JSON schema

The JSON file contains subject, sender, dates, the base64-encoded HTML body, all inline images (base64-encoded), and all file attachments (base64-encoded). It also carries a `scriptVersion` integer that VS Code checks for compatibility.

### MANIFEST_VERSION versioning — CRITICAL

Two constants must stay in sync:

| Constant | Location |
| --- | --- |
| `MANIFEST_VERSION` | `src/utils/owaUserscript.ts` (embedded into every saved JSON) |
| `REQUIRED_MANIFEST_VERSION` | `src/utils/handoverFolder.ts` (minimum accepted by VS Code) |

**When the manifest schema changes:** increment both constants to the same new value. VS Code will reject stale installed scripts with a clear error message directing the user to re-export and reinstall.

**When the Tampermonkey script changes for any other reason:** bump the `@version` header in `owaUserscript.ts` (semver, e.g. `1.2` → `1.3`) but leave `MANIFEST_VERSION` unchanged.

### Email-to-ticket flow (OWA path)

1. User clicks "📋 To Ticket" in OWA reading pane → Tampermonkey saves JSON → navigates to `vscode://RobertBreunung.ticket-sidekick/from-email?ts=<timestamp>`
2. URI handler triggers `ticket-sidekick.processHandoverEmail` command
3. `handoverFolder.readHandoverEmail()` validates `scriptVersion`, parses JSON, calls `htmlToMarkdown()`, resolves attachment file paths
4. If `stripFooter=true`: LLM footer removal via `ticketSidekick.email.cleanupModel`
5. `HandoverEmail` stored in `workspaceState('jira.handover.email')`
6. Chat opened with `@jira create from email`
7. `handleCreateFromEmail` in `emailHandler.ts` detects the workspaceState entry, skips Graph API, builds `EmailContentSession` (with templates + issue types pre-fetched via `Promise.all`)
8. Preview streamed; user picks template/type or confirms; `finishEmailTicket` creates ticket + uploads attachments + deletes handover file

### `pickEmailOption` helper

`pickEmailOption(n, templates, issueTypes)` in `sessionState.ts` maps a 1-based user reply index to a template or issue type pick. Templates occupy indices 1..N, issue types N+1..N+M. Returns `{ kind: 'template', name, issueType }` or `{ kind: 'type', issueType }` or `null` if out of range.

### OWA attachment limitation

OWA attachment download URLs require an authenticated session — there are no stable public download URLs in the DOM. The userscript detects attachment names from the DOM and appends them to the body HTML as a `📄 Attachments (attach to ticket manually): name1.pdf, name2.docx` paragraph. `finishEmailTicket` strips this paragraph from the description (via regex) before creating the ticket, and surfaces the names as a post-creation chat note.
