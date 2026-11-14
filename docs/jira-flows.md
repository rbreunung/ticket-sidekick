# Jira Feature Flows

> **Deprecated surface.** `@jira` is deprecated and runs only the report imports (emails, Veracode, Waltz) since 2026-11-14. Every other request gets a fixed notice (`JIRA_ONLY_IMPORTS_NOTICE` in `src/participant/session/jiraCommands.ts`) pointing to `/ts-jira` and Agent mode. New work is built as extension tools and boards; see [`docs/architecture/boards-and-sessions.md`](architecture/boards-and-sessions.md). The imports themselves are documented in [`docs/report-import.md`](report-import.md).

The code lives in:

- [`src/participant/JiraParticipant.ts`](../src/participant/JiraParticipant.ts) — the imports-only handler: the import sessions, the help screen, the intent parse (`createFromEmail`, `addEmailComment`, `importVeracode`, `importWaltzReport` or `other`) and the notice.
- [`src/participant/jira/`](../src/participant/jira/) — the import handlers, `cleanupHandler.ts` (the stale-ticket close of an import), `overviewHandler.ts` (the import `export` reply) and `ticketContext.ts`.
- [`src/participant/sessionState.ts`](../src/participant/sessionState.ts) — pure session-state types and helpers, including `pickEmailOption()`.

## Where the removed flows went

| Removed `@jira` flow | Now |
| --- | --- |
| create, with templates and section questions | `/ts-jira-create` and `jira_create_ticket` |
| view, summarize, show fields, check required fields, comments | `jira_view_ticket`, `jira_list_fields`, `jira_check_required_fields`, `jira_add_comment` |
| field, move, load, upload, workflow, check | `jira_update_field`, `jira_move_ticket`, `jira_load_ticket`, `jira_upload_attachment`, `jira_workflow`, `jira_check_connection` |
| search, filters, narrowing by fix version, sprint, assignee and team | `jira_find_tickets`, `jira_list_my_filters`, and the ticket list board through `jira_open_board` |
| bulk transition, bulk field update | the ticket list board |
| cleanup by `cleanupRules` | the ticket list board loaded from a rule (`src/boards/ticketList/cleanupSource.ts`) |
| `/security-report` | the security report board |
| description and comment preview | dropped |

The rules the cleanup board keeps from `@jira run cleanup` are below.

## Bulk cleanup rules

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

Start: `/ts-jira cleanup "rule name" [in VERSION]`, a plain request, or `Ticket Sidekick: Run a cleanup rule`. A board opened with a proposed move ("close the PROJ bugs in 3.2") is the ad-hoc form.

Review screen shows all tickets with their subtasks and proposed transitions. User replies: **ok**, **(c)** to cancel the run, or key numbers to skip (cascading: subtask skip → parent skipped; parent skip → all subtasks skipped).

`ticketSidekick.jira.cleanupFields` (array of field IDs, default empty) adds one column per configured field to this review table — for both `@jira run cleanup` and the ad-hoc bulk-transition flow, and for both parent and subtask rows. It's the same generic, opt-in mechanism as `ticketSidekick.jira.searchFields` (`@jira search`'s extra columns): any field ID valid for one works in the other, rendered through the same shared column-building helper (`buildExtraFieldColumns` in `TicketService.ts`). A configured field ID that doesn't match any known field logs a warning to the "Ticket Sidekick" Output Channel once per review-table render, for either setting.

Execution streams one line per ticket (subtasks first), then a summary. Failures are collected and reported at the end — the batch continues on failure.

## Jira sessions

Each session below is looked up by its `workspaceState` key; liveness is checked by round-tripping a `kind` through `ChatResult.metadata.jiraSession` (read by `getActiveJiraSession()` in `ticketContext.ts`). If the user moved on, the last turn carries no such kind and the session is ignored.

| Session | workspaceState key | Liveness check |
| --- | --- | --- |
| `AwaitIssueTypeSession` | `jira.session.awaitIssueType` | metadata — `jiraSession.kinds: ['await-issue-type']` |
| `StaleCloseSession` | `jira.session.staleResolution` | metadata — `jiraSession.kinds: ['stale-resolution-selection']` |
| `EmailCleanupSession` | `jira.session.emailCleanup` | metadata — `jiraSession.kinds: ['email-cleanup']` |
| `EmailContentSession` | `jira.session.emailContent` | metadata — `jiraSession.kinds: ['email-content']` |
| `EmailTemplateSelectionSession` | `jira.session.emailTemplateSelection` | metadata — `jiraSession.kinds: ['email-template']` |
| `EmailReviewSession` | `jira.session.emailReview` | metadata — `jiraSession.kinds: ['email-review']` |
| `VeracodeTemplateSelectionSession` | `jira.session.veracodeTemplateSelection` | metadata — `jiraSession.kinds: ['veracode-template']` |
| `VeracodeReviewSession` | `jira.session.veracodeReview` | metadata — `jiraSession.kinds: ['veracode-review']` |
| `WaltzTemplateSelectionSession` | `jira.session.waltzTemplateSelection` | metadata — `jiraSession.kinds: ['waltz-template']` |
| `WaltzReviewSession` | `jira.session.waltzReview` | metadata — `jiraSession.kinds: ['waltz-review']` |

Detection order in the Jira handler is the order of this table. A stored `AwaitIssueTypeSession` from an older build whose `resume` is a ticket create, not an import, is cleared with the expired-session message.

The shared issue-type ask (`AwaitIssueTypeSession`) asks for an issue type when an import's template names none. Its `resume` carries the identity of what the user already picked (a template name and the rest of the originating session); `descriptorKind` (`'veracode' | 'waltz' | 'email'`) picks which importer resumes. See `src/participant/jira/ticketContext.ts` (`resolveIssueTypeOrPrompt`/`streamAwaitIssueType`).

### Clickable replies

Every reply a session above can currently only be answered by typing — a numbered pick, a confirm/cancel word, or a per-row batch-review toggle — also renders as a clickable element wrapping that exact text (`buildChatCommandLink()` in `sessionState.ts`), so clicking resubmits the identical reply a typed message would have sent; typing continues to work unchanged. The shared issue-type ask (`AwaitIssueTypeSession`) is the one exception — their cancel word must be the literal `(c)` (`isExplicitCancelToken()`), so their clickable "Cancel" resubmits `(c)` rather than the word "cancel".

The Veracode/Waltz/email import review screens render each row's inclusion state as its own per-row toggle link — clicking flips that row's `included` flag and re-renders the table; typing the same row numbers/keys does the same thing. They run one group's action at a time from that group's own screen (see [`docs/report-import.md`](report-import.md#overview-and-group-screens-all-three-importers)).

Any response containing one of these links is a trusted `vscode.MarkdownString` (`trustedChatMarkdown()` in `src/utils/chatMarkdown.ts`, enabled only for `workbench.action.chat.open`). Every externally-influenced string combined into such a response — a ticket summary, a custom field value, an email subject, a Veracode/Waltz finding — is neutralized first via `neutralizeMarkdownLinks()` (`sessionState.ts`), which also runs automatically inside `buildChatCommandLink()` on its own `label` argument. Without this, a crafted `[text](command:...)` sequence in that content could render as a second, attacker-chosen live command once the response is trusted.
