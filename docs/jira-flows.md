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

1. **Project key** — from prompt, then `ticketSidekick.jira.defaultProject` setting, then `showInputBox`. Resolved first, since issue types are project-scoped.
2. **Summary** — from prompt (LLM extraction), then `showInputBox`
3. **Template + issue type** — always fetched together: templates from `.jira-templates.json` and issue types from `GET /rest/api/2/project/{key}` (subtasks filtered out). If either exists, one combined chat-native numbered list is streamed via `CreateSelectionSession` — templates first (each showing its issue type), then remaining issue types — and the user always replies with a number (or `(c)` to cancel); an out-of-range or non-numeric reply re-presents the same list. When no issue type can be resolved for a template or list entry (nothing fetched), it carries an empty-string sentinel instead of a guessed value — rendered as "you will be asked to type it" — and picking it opens `showInputBox` for a free-typed issue type rather than silently defaulting. The same `showInputBox` fallback fires directly when both templates and issue types are empty.

If a template is chosen:

- If the picked template can no longer be found (renamed/removed from `.jira-templates.json` since the list was shown), a warning is shown and creation proceeds without its default fields
- `FieldResolver.resolve(defaultFields, resolveFields)` maps any `name`-based specs to Jira field values via API lookups; `id`-based specs pass through directly; array entries produce array results
- `descriptionSections` (optional) drives a multi-turn Q&A via `CreationSession`; if absent or empty, ticket is created directly
- When all sections are answered `finishTicketCreation` assembles the description and calls `TicketService.createTicket`
- Field resolution + section handling are in `continueAfterIssueType`, called from the combined-selection routing block

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

`ticketSidekick.jira.cleanupFields` (array of field IDs, default empty) adds one column per configured field to this review table — for both `@jira run cleanup` and the ad-hoc bulk-transition flow, and for both parent and subtask rows. It's the same generic, opt-in mechanism as `ticketSidekick.jira.searchFields` (`@jira search`'s extra columns): any field ID valid for one works in the other, rendered through the same shared column-building helper (`buildExtraFieldColumns` in `TicketService.ts`). A configured field ID that doesn't match any known field logs a warning to the "Ticket Sidekick" Output Channel once per review-table render, for either setting.

Execution streams one line per ticket (subtasks first), then a summary. Failures are collected and reported at the end — the batch continues on failure.

## Template generation

`@jira` can generate a reusable `.jira-templates.json` template from a reference ticket's template-shaped fields, or from a project's required-fields metadata when no reference ticket is given, reviewed as an include/exclude list and saved on confirmation with an offer to create a first ticket from it — see [`docs/plans/2026-08-30-1135-feat-template-generation-from-ticket-plan.md`](plans/2026-08-30-1135-feat-template-generation-from-ticket-plan.md) and [`src/participant/jira/templateGenerationHandler.ts`](../src/participant/jira/templateGenerationHandler.ts).

## Jira sessions

Each session below is looked up by its `workspaceState` key and expires once its response tag is no longer the **last** assistant message — see `CLAUDE.md`'s "Multi-turn session state" for the tag/workspaceState mechanism itself.

| Session | workspaceState key | Tag in response |
| --- | --- | --- |
| `ResolutionSelectionSession` | `jira.session.resolutionSelection` | `<!-- jira:selecting-resolution -->` |
| `TransitionBatchSession` | `jira.session.transitionReview` | `<!-- jira:transition-review -->` |
| `FilterSelectionSession` | `jira.session.filterSelection` | `<!-- jira:selecting-filter -->` |
| `BulkUpdateReviewSession` | `jira.session.bulkUpdateReview` | `<!-- jira:bulk-update-review -->` |
| `SearchResultSession` | `jira.session.searchResult` | _(no marker — background session, overwritten on each search)_ |
| `CreateSelectionSession` | `jira.session.creatingSelection` | `<!-- jira:selecting-create-option -->` |
| `AwaitIssueTypeSession` | `jira.session.awaitIssueType` | `<!-- jira:await-issue-type -->` |
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
| `EmailTemplateSelectionSession` | `jira.session.emailTemplateSelection` | `<!-- jira:email-template -->` |
| `EmailReviewSession` | `jira.session.emailReview` | `<!-- jira:email-review -->` |
| `TemplateGenerationAwaitNameSession` | `jira.session.templateGenAwaitName` | `<!-- jira:template-gen-await-name -->` |
| `TemplateGenerationTypePickSession` | `jira.session.templateGenTypePick` | `<!-- jira:template-gen-type-pick -->` |
| `TemplateGenerationAwaitFreeTypeSession` | `jira.session.templateGenAwaitFreeType` | `<!-- jira:template-gen-await-free-type -->` |
| `TemplateGenerationReviewSession` | `jira.session.templateGenReview` | `<!-- jira:template-gen-review -->` |
| `TemplateGenerationCollisionSession` | `jira.session.templateGenCollision` | `<!-- jira:template-gen-collision -->` |
| `TemplateGenerationOfferCreateSession` | `jira.session.templateGenOfferCreate` | `<!-- jira:template-gen-offer-create -->` |
| `TemplateGenerationAwaitSummarySession` | `jira.session.templateGenAwaitSummary` | `<!-- jira:template-gen-await-summary -->` |

Detection order in the Jira handler: resolution selection → transition review → filter selection → bulk-update-review → combined template/issue-type selection → shared issue-type ask (R6) → creation → content → more-comments → check command → load-skipped → email content (comment-attach) → batch email template selection → batch email review → veracode template selection → veracode review → Waltz template selection → Waltz review → template-gen await-name (R2) → template-gen type pick → template-gen await-free-type (R3) → template-gen review → template-gen collision → template-gen offer-create → template-gen await-summary → comment list → greeting/empty-prompt check → intent parse.

The shared issue-type ask (`AwaitIssueTypeSession`, R6/KTD4) replaces `resolveIssueTypeOrPrompt()`'s
former `showInputBox` for every flow that resolves an issue type before creating a ticket —
`@jira create` and Veracode/Waltz/email report import. Its `resume` field is a discriminated union
(`'create' | 'reportImport'`) carrying the *identity* of what the user already picked (a
project/summary, a picked template name, the rest of the originating session) rather than a
pre-resolved object; the `'reportImport'` kind's `descriptorKind` (`'veracode' | 'waltz' | 'email'`)
picks which family's thin wrapper resumes through. Each family resumes through its own existing
continuation (`continueAfterIssueType` for `create`; report import's `continueAfterImportIssueType`,
reused unmodified for email) once the type is known. Batch email import (KTD1, see
`docs/report-import.md`) is the `reportImport` kind's third `descriptorKind` rather than a
standalone resume kind — the single-file comment-attach flow (`EmailContentSession`) never resolves
an issue type, so it never reaches this ask at all. See `src/participant/jira/ticketContext.ts`
(`resolveIssueTypeOrPrompt`/`streamAwaitIssueType`) and the resume dispatcher in `JiraParticipant.ts`
(kept there rather than in `ticketContext.ts` to avoid a require cycle with the handler files it
resumes into).

Follow-up suggestion chips (after every major response), greeting/empty-prompt detection, and the unclassifiable-prompt fallback that replaces the old bare "Unrecognised operation." message are documented in [`docs/onboarding.md`](onboarding.md#follow-up-suggestion-chips-greeting-detection-and-the-unclassifiable-prompt-fallback).
