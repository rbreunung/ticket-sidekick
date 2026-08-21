# Jira Feature Flows

How `@jira`'s multi-turn flows work: ticket creation, bulk cleanup, workflow
discovery, comment handling, content preview/refinement, last-ticket context,
and the Jira session-state table that ties them together.

The code lives in:

- [`src/participant/jira/*Handler.ts`](../src/participant/jira/) — per-flow handlers (`createHandler.ts`, `cleanupHandler.ts`, `workflowHandler.ts`, `contentHandler.ts`, `loadHandler.ts`, `fieldHandler.ts`).
- [`src/participant/sessionState.ts`](../src/participant/sessionState.ts) — pure session-state types and helpers, including `pickEmailOption()`.
- [`src/services/WorkflowService.ts`](../src/services/WorkflowService.ts) — workflow graph cache I/O, BFS path-finding, `discoverWorkflow` sampling.
- [`src/services/TicketService.ts`](../src/services/TicketService.ts) — ticket business logic backing all of the flows below.
- [`src/templates/TemplateService.ts`](../src/templates/TemplateService.ts) / [`src/templates/FieldResolver.ts`](../src/templates/FieldResolver.ts) — reads `.jira-templates.json` and resolves template field specs during ticket creation.

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
- `subtaskResolution` — resolution for subtask transitions; falls back to `resolution` if omitted
- `subtaskTargetState` — target status for subtasks; falls back to `targetState` if omitted
- `closeSubtasks` — if true, open subtasks are fetched in one bulk query (`parent in (...)`) and transitioned before their parent
- `fixVersionFilter` — `"released"` or `"unreleased"`; adds `fixVersion in releasedVersions()` / `unreleasedVersions()` to the JQL
- `fixVersionPattern` — glob pattern (e.g. `"Release*"`); adds `fixVersion ~ "pattern"` (Jira 11+ / modern DC); mutually exclusive with `fixVersionFilter`
- `jql` — extra JQL ANDed onto the base query; `project`, `issueType`, and `status` are always anchored regardless

Prompt overrides: `in "Version Name"` (exact), `in released` / `in unreleased` (JQL function), `in "Release*"` (wildcard) — always win over rule fields. Quoted `in "released"` targets a version literally named "released", not the JQL function.

Trigger: `@jira run cleanup "rule name"` or ad-hoc `@jira close PROJ bugs in "Fix Version 3.2"`.

Review screen shows all tickets with their subtasks and proposed transitions. User replies: **ok**, **(c)** to cancel the run, or key numbers to skip (cascading: subtask skip → parent skipped; parent skip → all subtasks skipped).

Execution streams one line per ticket (subtasks first), then a summary. Failures are collected and reported at the end — the batch continues on failure.

## Jira sessions

Each session below is looked up by its `workspaceState` key and expires once its response tag is no longer the **last** assistant message — see `CLAUDE.md`'s "Multi-turn session state" for the tag/workspaceState mechanism itself.

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
| `EmailContentSession` | `jira.session.emailContent` | `<!-- jira:email-content -->` |
| `VeracodeTemplateSelectionSession` | `jira.session.veracodeTemplateSelection` | `<!-- jira:veracode-template -->` |
| `VeracodeReviewSession` | `jira.session.veracodeReview` | `<!-- jira:veracode-review -->` |
| `WaltzTemplateSelectionSession` | `jira.session.waltzTemplateSelection` | `<!-- jira:waltz-template -->` |
| `WaltzReviewSession` | `jira.session.waltzReview` | `<!-- jira:waltz-review -->` |

Detection order in the Jira handler: resolution selection → transition review → filter selection → bulk-update-review → template selection → issue type selection → creation → content → more-comments → check command → load-skipped → email content → veracode template selection → veracode review → Waltz template selection → Waltz review → comment list → intent parse.
