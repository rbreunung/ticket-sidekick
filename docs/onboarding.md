# Onboarding

How a first-time user of Ticket Sidekick discovers what the extension can do
and gets to a working first ticket or PR review without reading the README
first.

## Jira Language Model tools

Alongside `@jira` chat, every core Jira read/write operation is also exposed
as a `contributes.languageModelTools` entry, so GitHub Copilot's Agent Mode
can call it directly — without the user typing `@jira` at all. Every tool is
thin glue over the same `TicketService` (→ `IJiraClient` → `JiraApiClient`)
stack the chat participant uses, so a tool call gets the same business logic
and safeguards a chat command does — there is no separate, divergent
implementation of the same operation. Code lives in:

- [`src/tools/jiraTools.ts`](../src/tools/jiraTools.ts) — tool registration, `prepareInvocation`/`invoke` implementations.
- [`src/participant/sessionState.ts`](../src/participant/sessionState.ts) — pure confirmation-text and result-message builders the tools call into (Vitest-loadable; `jiraTools.ts` itself imports `vscode` and is not).
- `package.json`'s `contributes.languageModelTools` — the tool declarations (name, description, JSON input schema, `when` clause) VS Code reads.

None of these tools appear in Agent Mode's tool picker until Jira
credentials are configured — each one's `when` clause gates on the
`ticketSidekick.jiraCredentialsSet` context key (kept in sync in
`extension.ts`). If a tool is still invoked with credentials unset (e.g. a
stale tool list, or a programmatic call), its result is U1's
`buildJiraNotConfiguredMessage(config)` text naming the missing setup step —
never a raw `JiraApiError`.

### Read tools

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `jira_getTicket` | Fetch a ticket's fields and description | `ticketKey` | — |
| `jira_searchTickets` | Search tickets with a JQL query | `jql` | — |
| `jira_getComments` | Fetch a ticket's comments, most recent first | `ticketKey` | `maxResults` (default 20) |
| `jira_listTemplates` | List the templates in `.jira-templates.json` | — | — |
| `jira_discoverWorkflow` | Sample and cache a project/issue type's status-transition graph | `projectKey`, `issueType` | — |

`jira_listTemplates` returns an empty list — not an error — when the
workspace has no `.jira-templates.json`. `jira_discoverWorkflow` writes to
the same `.jira-workflow-cache.json` the chat `@jira discover workflow`
command does, so a workflow discovered via a tool call also benefits
`jira_transitionTicket`'s multi-hop lookups (and vice versa).

### Write tools

Every write tool declares an explicit `confirmationMessages` in
`prepareInvocation()` naming the concrete change about to be made — a tool
call never writes silently. But because a user's `chat.tools.autoApprove`
setting can skip that confirmation dialog entirely, each write tool's
`invoke()` re-validates its own inputs independently rather than trusting
that the confirmation was actually seen — `invoke()`, not the confirmation
dialog, is the real safety boundary.

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `jira_addComment` | Add a comment to a ticket | `ticketKey`, `comment` | — |
| `jira_updateField` | Update one field on one ticket | `ticketKey`, `fieldName`, `value` | — |
| `jira_createTicket` | Create a new ticket | `projectKey`, `summary` | `issueType`, `templateName`, `description` |
| `jira_transitionTicket` | Move a ticket to a target status | `ticketKey`, `targetStatus` | `resolution` |

`fieldName` for `jira_updateField` accepts: `summary`, `description`,
`priority`, `assignee`, `labels`, `components`, `fix version` — the same
allowlist `TicketService.updateField` (reused directly, not reimplemented)
already backs the `@jira set <field>` chat flow's description-update path
with. Its confirmation shows the field's **current** value (read fresh from
Jira) next to the **new** value, e.g. `Critical → High`, before any write
happens.

Write tools touch exactly one ticket per call — there is no bulk/multi-ticket
write tool. (`jira_searchTickets` and `jira_discoverWorkflow` are reads and
aren't bound by this.)

### Never-guess issue type (`jira_createTicket`)

`jira_createTicket`'s `modelDescription` steers the calling model to call
`jira_listTemplates` first and prefer `templateName` over a bare
`issueType`, since a template carries the process's default field values.

When neither `issueType` nor a resolvable `templateName` is given —
`templateName` doesn't match a template in `.jira-templates.json`, or a
matched template has no `issueType` of its own — `invoke()` never guesses
one. Instead it fetches `TicketService.getIssueTypes(projectKey)` and
returns that list as the actionable result, creating nothing. This mirrors
the chat create flow's own never-guess sentinel handling, adapted from an
interactive `showInputBox` prompt (chat has one; Agent Mode doesn't) to a
returned list the calling model can act on in its next call. See
[`docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md`](solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md)
for the failure mode this must not repeat.

### No session memory

Unlike `@jira` chat's twenty-one multi-turn session types (see
[`docs/jira-flows.md`](jira-flows.md#jira-sessions)), tools carry no session
state between calls. Every call takes fully-specified parameters — a
ticket key, a project key — with no last-ticket or branch-derived context to
fall back on.

### Diagnostics

Every write tool's `invoke()` constructs its `TicketService` with the same
`onDiag` binding the chat participant uses
(`(level, message, details) => logDiag('jira.ticketService', level, message, details)`),
so tool-invoked writes show up in the "Ticket Sidekick" Output Channel the
same way chat writes do. Tool-specific failures (a fetch, a write) are
additionally logged under the `jira.tools` scope.

## Bitbucket Language Model tools

Alongside `@bitbucket` chat, Bitbucket's single-object read and write
operations are also exposed as `contributes.languageModelTools` entries, so
GitHub Copilot's Agent Mode can call them directly — without the user typing
`@bitbucket` at all. Every tool is thin glue over the same
`IBitbucketClient` (reads) or `PrReviewService` → `IBitbucketClient` (the
write) stack the chat participant uses, so a tool call gets the same
business logic and safeguards a chat command does — there is no separate,
divergent implementation of the same operation. Code lives in:

- [`src/tools/bitbucketTools.ts`](../src/tools/bitbucketTools.ts) — tool registration, `prepareInvocation`/`invoke` implementations.
- [`src/participant/reviewSessionState.ts`](../src/participant/reviewSessionState.ts) — pure confirmation-text and result-message builders the tools call into (Vitest-loadable; `bitbucketTools.ts` itself imports `vscode` and is not).
- `package.json`'s `contributes.languageModelTools` — the tool declarations (name, description, JSON input schema, `when` clause) VS Code reads.

None of these tools appear in Agent Mode's tool picker until Bitbucket
credentials are configured — each one's `when` clause gates on the
`ticketSidekick.bitbucketCredentialsSet` context key (kept in sync in
`extension.ts`). If a tool is still invoked with credentials unset (e.g. a
stale tool list, or a programmatic call), its result is U1's
`buildBitbucketNotConfiguredMessage(config)` text naming the missing setup
step — never a raw `BitbucketApiError`.

### Read tools

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `bitbucket_getPullRequest` | Fetch a PR's title, description, author, target branch, and source commit hash | `project`, `repo`, `prId` | — |
| `bitbucket_getPullRequestDiff` | Fetch a PR's unified diff | `project`, `repo`, `prId` | `contextLines` |

`project`/`repo` take a Data Center project key/repo slug or a Cloud
workspace/repo slug interchangeably — `IBitbucketClient` (and `parsePrUrl`,
which the chat participant uses to derive them from a pasted PR URL)
already normalizes both identity shapes into the same two fields.

### Write tool

`bitbucket_postComment` declares an explicit `confirmationMessages` in
`prepareInvocation()` naming the PR and the literal comment text about to be
posted — a tool call never writes silently. But because a user's
`chat.tools.autoApprove` setting can skip that confirmation dialog
entirely, `invoke()` re-validates its own inputs independently rather than
trusting that the confirmation was actually seen — `invoke()`, not the
confirmation dialog, is the real safety boundary (KTD1).

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `bitbucket_postComment` | Post a comment to a PR's activity feed | `project`, `repo`, `prId`, `comment` | — |

`bitbucket_postComment` calls `PrReviewService.postCommentItems` — the same
method the chat participant's "post it"/"add to review" flows call — with a
synthetic, line-less finding, so the comment is posted as a plain
activity-feed comment rather than anchored inline to a diff line (there is
no line-anchoring input on this tool). Its `PrReviewService` is constructed
with the same `onDiag` binding `BitbucketParticipant.ts` already uses
(`(level, message, details) => logDiag('bitbucket.prReviewService', level, message, details)`),
so a tool-invoked comment post shows up in the "Ticket Sidekick" Output
Channel the same way a chat-invoked one does. Tool-specific failures (a
fetch, a post) are additionally logged under the `bitbucket.tools` scope.

### No full-review tool (deferred)

There is no `bitbucket_reviewPr` tool. `@bitbucket <pr-url>`'s multi-pass
review pipeline — adaptive chunking, anchor verification, the optional
critic pass, findings-funnel diagnostics — lives inline in
`BitbucketParticipant.ts`'s chat handler, not as a callable `PrReviewService`
method a tool could invoke; building one is explicitly out of scope for this
pass and deferred to a future plan. Use `@bitbucket <pr-url>` in chat for a
full review; the three tools above cover single-object PR reads and posting
one comment.

### No session memory

Like `@jira`'s tools, `bitbucket_*` tools carry no session state between
calls (KTD6) — every call takes fully-specified parameters (`project`,
`repo`, `prId`, …), with no last-PR or in-progress-review context to fall
back on, unlike `@bitbucket` chat's single `ReviewSession` (see
[`docs/review-process.md`](review-process.md#follow-ups)).

## Slash commands

Both chat participants also expose a `/command` per major capability, shown
in their own autocomplete when typing `@jira ` or `@bitbucket ` in Copilot
Chat. Every command is a discoverability shortcut into the same
natural-language-routed flow described elsewhere in this doc set — never a
separate mechanism a user has to learn (R5). `contributes.chatParticipants`
in `package.json` declares each command's `name`, `description`, and
`sampleRequest` (the text shown as an autocomplete preview); both
participants also declare `disambiguation` metadata (category, description,
example prompts) there so Copilot can route an ambiguous prompt to the right
participant without the user typing `@jira`/`@bitbucket` explicitly.

### `@jira`

`request.command` is dispatched right after `parseIntent()` runs — every
other field the flow needs (ticket key, field name/value, target status,
JQL, comment text, …) still comes from the LLM's parse of the remaining
prompt text; the command only pre-decides *which* operation to route to,
removing the one ambiguity a deliberate `/command` shouldn't be subject to.
This is checked after the full multi-turn session-tag scan, so a session
already in flight always finishes claiming the turn before a slash command
can (KTD12). `/check` is the one exception — it's merged directly into the
existing plain-text `check` regex special-case, which runs (unchanged)
before the session-tag scan, same as it always did.

| Command | Target flow | `sampleRequest` |
| --- | --- | --- |
| `/check` | Connection check (`config`/`connection` special-case) | `check` |
| `/create` | `createTicket` — multi-turn ticket creation | `create a bug in PROJ: login fails after password reset` |
| `/view` | `getTicket` — show a ticket's fields, description, comments | `view PROJ-123` |
| `/comment` | `addComment` | `PROJ-123 thanks, looks good to merge` |
| `/field` | `updateField` | `PROJ-123 set priority to High` |
| `/move` | `transition` | `PROJ-123 to In Progress` |
| `/search` | `searchJql` | `my open bugs in PROJ` |

The pure `mapCommandToOperation()` (`src/participant/jira/llmHelpers.ts`)
holds the command-name → `Operation` mapping and is unit-tested in
`src/test/llmHelpers.test.ts`; the dispatch itself lives in
`src/participant/JiraParticipant.ts`.

### `@bitbucket`

| Command | Target flow | `sampleRequest` |
| --- | --- | --- |
| `/check` | Connection check | `check` |
| `/review` | PR review — the remaining prompt text is the PR URL | `https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42` |

`/check` is merged into the existing plain-text `check` regex special-case
the same way `@jira`'s is. `/review` needs no dispatch code of its own: VS
Code's Chat API never includes the participant name or command name in
`request.prompt`, so `/review <url>` leaves `request.prompt` as exactly the
PR URL — which the existing `prUrlMatch`-driven flow in
`BitbucketParticipant.ts` already handles unchanged, including its "Point me
at a PR to review" guidance when `/review` is used with no URL.

## Follow-up suggestion chips, greeting detection, and the unclassifiable-prompt fallback

Both participants offer follow-up suggestion chips (`vscode.ChatFollowup`,
via `participant.followupProvider`) after every major response, proposing a
likely next action — e.g. after loading a ticket: add a comment, transition
it; after a PR review: add findings to review, explain finding #1 (R6).

**State passing.** `vscode.ChatResult.metadata` is the VS Code-native
channel a chat handler uses to hand its own `followupProvider` "what just
happened," so each handler's major return points now return
`{ metadata: { jiraFollowup } }` / `{ metadata: { bitbucketFollowup } }`
instead of a bare `return;`; a bare `return;` (still valid — `void` stays in
the handler's return-type union) means "no chip-worthy state," e.g. a
multi-turn session reply whose own response tag already carries the
next-step guidance. `followupProvider.provideFollowups(result, …)` reads
`result.metadata` and hands it to the pure computer below.

**Pure logic (KTD15).** `computeJiraFollowups(state: JiraFollowupState)`
(`src/participant/sessionState.ts`) and
`computeBitbucketFollowups(state: BitbucketFollowupState)`
(`src/participant/reviewSessionState.ts`) each take one discriminated
"what just happened" state (`'greeting'`, `'fallback'` (`@jira` only),
`'loadedTicket'` / `'reviewCompleted'`, or `'none'`) and return 2-3
`{ prompt, label? }` suggestions phrased as literal next prompts — one
function per participant, rather than a separate function per state, since
"no prior operation, this is a greeting" is just one more case of the same
"what just happened" question every other state answers.

**Greeting/empty-prompt detection (R9).** `isGreetingOrEmpty(prompt)`
(`src/participant/sessionState.ts`, shared by both participants) detects an
empty invocation or an obvious greeting/help-shaped prompt ("hi", "help",
"what can you do") before it's ever handed to `@jira`'s LLM intent parser or
`@bitbucket`'s PR-URL match — checked only *after* every multi-turn
session-tag branch has had its chance to claim the turn (a session already
in flight always wins, mirroring the ordering `docs/jira-flows.md`'s
slash-command dispatch already follows), and, for `@jira`, only when no
`/command` was used. It matches the WHOLE normalized prompt against a fixed
phrase set — never a substring or per-word test — so a real ticket key that
happens to look like a greeting word (e.g. `HI-1`) or a genuine operation
prompt ("update HI-1 status") is never misclassified; see
[`docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md`](solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md)
for the general specific-before-generic principle this sidesteps by
construction.

**Unclassifiable-prompt fallback (R8, `@jira` only).** The old bare
`"Unrecognised operation."` message (the `default:` case of `@jira`'s
operation switch) is replaced with a short, helpful line plus follow-up
chips carrying example prompts — `@bitbucket` has no equivalent fallback to
reroute, since it has no LLM intent classifier to bypass, only a PR-URL
match, and its existing "Point me at a PR to review" guidance already covers
a non-greeting, non-URL prompt.

**KTD14.** Both the greeting response and the unclassifiable-prompt fallback
deliver their example prompts *only* as follow-up chips, capped at 2-3 and
phrased as literal next prompts a user could send — never duplicated as a
bulleted list in the response's own markdown.

## Getting-Started walkthrough: Jira

`contributes.walkthroughs` in `package.json` declares a "Ticket Sidekick:
Jira" walkthrough (id `ticket-sidekick.jiraGettingStarted`) that takes a new
user from zero Jira config to a real first ticket. Every step completes on
real extension state via VS Code's native `completionEvents` — never a
static checklist a user has to tick off by hand (R12). Step markdown bodies
live in `walkthroughs/jira/*.md`; each links (or runs) the real
setting/command it describes.

| # | Step id | What it asks for | Completion signal |
| --- | --- | --- | --- |
| 1 | `jiraBaseUrl` | `ticketSidekick.jira.baseUrl` setting | `onSettingChanged:ticketSidekick.jira.baseUrl` |
| 2 | `jiraCredentials` | A Data Center PAT or Cloud email+API token, via `ticket-sidekick.setDataCenterToken` / `ticket-sidekick.configureCloud` | `onContext:ticketSidekick.jiraCredentialsSet` (U1's context key, kept in sync in `extension.ts`) |
| 3 | `jiraDefaultProject` | `ticketSidekick.jira.defaultProject` setting | `onSettingChanged:ticketSidekick.jira.defaultProject` |
| 4 | `jiraWorkflow` | Running `@jira discover workflow <PROJ> <IssueType>` | `onContext:ticketSidekick.workflowViewed` — set in `handleDiscoverWorkflow` (`workflowHandler.ts`) right after the workflow graph is actually cached, not on an attempted-but-empty sample |
| 5 | `jiraFirstTicket` | Generating a template (`@jira generate a template`) and creating a ticket from it, or `@jira create` directly | `onContext:ticketSidekick.firstTicketCreated` — set at every real `ticketService.createTicket()` success point reachable from chat: `contentHandler.ts`'s `createTicket`-operation branch (backs the `createHandler.ts` flow) and `templateGenerationHandler.ts`'s `createFirstTicket()` |

**First-touch auto-open (KTD11).** `extension.ts`'s `activate()` opens this
walkthrough automatically once, guarded by the `globalState` flag
`ticketSidekick.jiraWalkthroughSeen` — set the first time `activate()` runs
and never re-checked false afterward, so the walkthrough never reopens on
a later VS Code start. The Bitbucket walkthrough (a separate contribution,
added in a later unit) does not auto-open.

Each step's button opens Copilot Chat pre-filled with the relevant `@jira`
query via `workbench.action.chat.open` (the same command
`extension.ts`'s `.eml`/Veracode/Waltz import commands already use to open
chat with a fixed query), or runs the credential-setup command directly.
