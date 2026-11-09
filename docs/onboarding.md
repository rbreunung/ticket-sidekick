# Onboarding

How a first-time user of Ticket Sidekick discovers what the extension can do
and gets to a working first ticket or PR review without reading the README
first.

## Jira tools

Every Jira tool an agent calls comes from the extension's MCP server; `package.json` declares no Jira Agent Mode tool, so no Jira capability is offered twice.

- **The tools** read (`jira_check_connection`, `jira_view_ticket`, `jira_find_tickets`, `jira_list_my_filters`, `jira_workflow`, `jira_list_templates`, `jira_load_ticket`) or change a ticket (`jira_move_ticket`, `jira_create_ticket`, `jira_add_comment`, `jira_update_field`, `jira_upload_attachment`). Their definitions live in [`src/mcp/jiraTools/`](../src/mcp/jiraTools/) (`catalog.ts` lists them; `toolNames.ts` holds the names any message text uses). See [`docs/architecture/copilot-harness-migration.md`](architecture/copilot-harness-migration.md) for the design and [`docs/manual/copilot-tools.md`](manual/copilot-tools.md) for the user-facing list; a new MCP tool needs a row there (`src/test/userDocsSync.test.ts` checks the catalog against it).
- **Skills** (`contributes.chatSkills`, from `skills/<name>/SKILL.md`) build on the tools: `/ts-jira-brief` writes a developer brief of a ticket, `/ts-jira-create` creates one with the user, and `/ts-jira <command>` runs one tool the user names; `/ts-jira help brief` and `help create` print `help-brief.md` and `help-create.md` from its folder, so the other skills' names stay out of the router's own text. `/ts-jira-brief` and `/ts-jira` are explicit-only (`disable-model-invocation: true`), since a model without thinking ran a model-invocable brief skill in place of other requests; `/ts-jira-create` stays model-invocable on purpose, so a plain request for a new ticket goes through a template and a draft instead of a bare create. `src/test/mcpSkillsGuard.test.ts` keeps every contributed skill naming only catalog tools, with a frontmatter `name` equal to its folder, and model invocation off exactly for the `ts-` skills other than `ts-jira-create`.

Every tool is thin glue over the same `TicketService` (→ `IJiraClient` → `JiraApiClient`), `WorkflowService` and `TemplateService` the chat participant uses, so a tool call gets the same business logic and safeguards a chat command does. All of them run their Jira work through `runJiraTool` (`src/mcp/jiraTools/runJiraTool.ts`): without a configured Jira they answer with `buildJiraNotConfiguredMessage(config)`; each Jira request has a time limit; a failure reaches the agent as the HTTP status and a short reason only, while the full error is logged under the `mcp.tools` scope.

### Approvals

The harness decides when to ask before a tool runs, from each tool's annotations; the extension adds no confirmation of its own. Tools that only read Jira carry `readOnlyHint`, the five that change Jira carry `destructiveHint`, and load ticket carries neither, since it writes only local files. Because the harness approval shows only the arguments, the write tools report what they changed: move ticket names the status it came from and each transition, update field quotes the previous value, and create ticket lists the template fields it applied. Every tool is also visible to the model only, so an inline view (MCP App) cannot call a write tool past that approval; only a tool marked for apps, such as the load panel's, can be called from a view.

### Safeguards for agent-supplied input

- **Ticket keys** are checked with `isSafePathSegment()` ([`src/tools/pathSafety.ts`](../src/tools/pathSafety.ts)) before use, since they are put into request URLs and local paths.
- **Uploads** accept only a file that, with symlinks resolved, lies inside an open workspace folder, with no dotfile or dotfolder segment, up to 25 MB. An agent-supplied path is otherwise a way to send an arbitrary local file to Jira. `@jira upload` keeps its own home-folder rule (`isAllowedUploadPath()`).
- **Duplicate writes** ([`src/tools/recentCallGuard.ts`](../src/tools/recentCallGuard.ts), through `writeGuard.ts`): create ticket, add comment and upload attachment create something new per call, so the same call repeated within a minute is skipped. The guard lives in the tools' long-lived dependencies, since each MCP request gets a new server. A call that wrote nothing releases its claim at once, so a real retry goes through; a write that timed out keeps it, since Jira may still have made the change, and its answer says so.
- **Never-guess issue type:** without an issue type or a template that sets one, create ticket lists the project's issue types (`TicketService.getIssueTypes`) and creates nothing. See [`docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md`](solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md) for the failure mode this must not repeat.
- **Moves that stop partway:** each step of a move is a real Jira write, so a failed step leaves the ticket at an intermediate status. Move ticket reports where it landed and never retries. When no path is known, it discovers the workflow once (`discoverAndCacheWorkflow`) and tries again; the chat `transition` operation shares the same `resolveAndApplyTransition()` ([`src/services/WorkflowService.ts`](../src/services/WorkflowService.ts)).

### No session memory

Unlike `@jira` chat's multi-turn session types (see [`docs/jira-flows.md`](jira-flows.md#jira-sessions)), tools carry no session state between calls. Write tools take a fully specified ticket or project key; only view ticket and load ticket fall back to the key in the current git branch.

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

The bulk-update-review session is the other exception: its own reply parser
recognizes bare generic words (`skip <keys>`) that could coincidentally be
the leftover prompt text of an unrelated `/comment`/`/field`/etc. command
(e.g. `/comment skip PROJ-1, moving on`). That session step only fires when
`request.command` is unset — an explicit slash command is an unambiguous
"this is a new operation" signal, and the pending session is left untouched
(not cleared), so it's still there to resume on the next ordinary-text
reply.

| Command | Target flow | `sampleRequest` |
| --- | --- | --- |
| `/check` | Connection check (`config`/`connection` special-case) | `check` |
| `/create` | `createTicket` — multi-turn ticket creation | `create a bug in PROJ: login fails after password reset` |
| `/view` | `getTicket` — show a ticket's fields, description, comments | `view PROJ-123` |
| `/comment` | `addComment` | `PROJ-123 thanks, looks good to merge` |
| `/field` | `updateField` | `PROJ-123 set priority to High` |
| `/move` | `transition` | `PROJ-123 to In Progress` |
| `/search` | `searchJql` | `my open bugs in PROJ` |
| `/load` | `loadTicket` — download description/comments/attachments into `.jira-context/<key>/` | `load PROJ-123` |

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
it; after a PR review: add findings to review, explain finding #1 (or, in a
quick/standard review whose title names a Jira ticket, **Check against KEY**,
which re-runs it as smart), and Copy for Teams (the only chip after a review
with no findings) (R6).

**End-session chips.** `@bitbucket` also derives chips from the session kind
in `result.metadata.bitbucketSession` (Done, Post it, Cancel — see
[`docs/review-process.md`](review-process.md#follow-ups)), appended after the
action chips and outside their cap of three, so a finished review shows up to
four chips.

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

For `@jira`, every phrase in that set prints the same single help screen: the tool name and version (read from
`context.extension.packageJSON` when the help is shown, `unknown` when missing) and every command and flow in groups,
built from the catalog in `src/participant/session/jiraCommands.ts`. There is no separate greeting. The catalog follows
the import screens' help conventions (`importCommands.ts`), and `src/test/jiraCommandsGuard.test.ts` fails when a slash
command in `package.json` or an intent operation has no entry. The suggestion chips below the screen are unchanged.

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
bulleted list in the response's own markdown. The `@jira` help screen lists
commands, not example prompts to click, so the rule still holds.

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
| 6 | `jiraCopilotTools` | Adding `127.0.0.1` to `http.noProxy`, so the MCP server for Copilot-harness chats starts (`src/mcp/register.ts`); the extension never writes the setting | `onSettingChanged:http.noProxy` |

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

## Getting-Started walkthrough: Bitbucket

`contributes.walkthroughs` in `package.json` also declares a second, separate
"Ticket Sidekick: Bitbucket" walkthrough (id
`ticket-sidekick.bitbucketGettingStarted`) — a sibling entry to the Jira one
above, not merged into it (KTD10). It takes a new user from zero Bitbucket
config to a real first PR review, with the same rule as Jira's: every step
completes on real extension state via VS Code's native `completionEvents`,
never a static checklist (R12). Step markdown bodies live in
`walkthroughs/bitbucket/*.md`; each links (or runs) the real setting/command
it describes.

| # | Step id | What it asks for | Completion signal |
| --- | --- | --- | --- |
| 1 | `bitbucketBaseUrl` | `ticketSidekick.bitbucket.baseUrl` setting (Data Center only) | `onContext:ticketSidekick.bitbucketCredentialsSet` |
| 2 | `bitbucketCredentials` | A Data Center PAT or Cloud username+App Password, via `ticket-sidekick.setBitbucketDataCenterToken` / `ticket-sidekick.configureBitbucketCloud` | `onContext:ticketSidekick.bitbucketCredentialsSet` (U1's context key, kept in sync in `extension.ts`) |
| 3 | `bitbucketFirstReview` | Reviewing a real PR (`@bitbucket <pr-url>`) | `onContext:ticketSidekick.firstReviewCompleted` — set in `BitbucketParticipant.ts` right at the real review-completion success point (colocated with the `reviewState` follow-up-chip metadata U5 already sets there), never on an aborted or failed run |

**Base URL step's completion signal (KTD9).** Data Center needs
`ticketSidekick.bitbucket.baseUrl` set; Cloud needs no base URL at all — it
always talks to the fixed `api.bitbucket.org` host. Rather than add a new
context-key listener to distinguish the two, this step reuses the existing
`ticketSidekick.bitbucketCredentialsSet` signal: `ConfigService.isBitbucketConfigured()`
(U1's gate, already backing that key) already requires `baseUrl` **and**
`token` for Data Center but only `token` for Cloud, so the moment that key
goes true, a Data Center user's base URL is genuinely set and a Cloud user's
(inapplicable) base-URL step correctly completes alongside credentials —
with no separate signal to invent or keep in sync.

**Never auto-opened (KTD11).** Unlike the Jira walkthrough, this one has no
`globalState`-guarded auto-open block in `extension.ts` — it's reachable only
from VS Code's Get Started page, by design.

Each step's button opens Copilot Chat pre-filled with the relevant
`@bitbucket` query via `workbench.action.chat.open`, or runs the
credential-setup command directly — same mechanism as the Jira walkthrough.
