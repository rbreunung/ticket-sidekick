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
