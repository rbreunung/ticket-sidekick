# Jira Copilot — Agent Context

## What this is

A VS Code extension that exposes a `@jira` GitHub Copilot Chat participant. Users manage Jira tickets (create, read, edit fields, comment, search) in natural language without leaving VS Code.

## Architecture (three layers — never skip)

```text
JiraParticipant → TicketService → IJiraClient (interface)
                                       ↓
                               JiraApiClient (production HTTP)
                               MockJiraClient (test fixture returns)
```

**Rule:** `TicketService` imports `IJiraClient` only — never `JiraApiClient` directly. This is the test seam that makes all business logic testable without a real Jira instance.

## Key files

| File | Responsibility |
| --- | --- |
| `src/jira/IJiraClient.ts` | All shared types + IJiraClient interface |
| `src/jira/JiraApiClient.ts` | Real HTTP; builds auth header from authType |
| `src/services/TicketService.ts` | All business logic; depends on IJiraClient |
| `src/services/ConfigService.ts` | VS Code settings + SecretStorage |
| `src/participant/JiraParticipant.ts` | Chat handler + intent parsing via VS Code LM API |
| `src/participant/sessionState.ts` | VS Code-free pure helpers and multi-turn session types — all unit-testable by Vitest |
| `src/templates/TemplateService.ts` | Reads `.jira-templates.json` from workspace root; returns `JiraTemplate[]` |
| `src/templates/FieldResolver.ts` | Resolves `resolveFields` entries by name (API lookup) or id (pass-through) |
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron participant tests (requires VS Code)
```

**`npm test` must be green before every commit.** Run `npm run compile` to catch TypeScript errors first.

## Testing

Write tests for **user-facing use cases**, not internal mechanics. A test should read like a scenario: given this input, what does the user get back? Cover the happy path and the main failure case for every new feature.

`JiraParticipant.ts` imports `vscode` and cannot be loaded by Vitest. Keep pure logic (string extraction, data formatting) in `sessionState.ts` or `TicketService.ts` so it can be unit-tested. VS Code-dependent glue code is covered by the e2e suite only.

## Adding a new Jira operation

1. Add method to `IJiraClient` interface
2. Implement in `JiraApiClient` (real HTTP)
3. Implement in `MockJiraClient` (fixture return)
4. Add a fixture file to `src/test/fixtures/` matching real Jira v3 API shape
5. Write failing tests in `TicketService.test.ts`
6. Implement in `TicketService` (business logic) until tests pass
7. Add intent routing in `JiraParticipant.ts`
8. If the new operation introduces any pure extraction/transformation logic, put it in `sessionState.ts` and test it in `JiraParticipant.test.ts`

## Jira API

- Base path: `<baseUrl>/rest/api/3/`
- Data Center auth: `Authorization: Bearer <PAT>`
- Cloud auth: `Authorization: Basic base64(email:apiToken)`
- Description fields use Atlassian Document Format (ADF) — wrap plain text with `wrapInAdf()` in TicketService
- Agile API base path: `<baseUrl>/rest/agile/1.0/` — used for sprint resolution (`getSprintByName`)
- Teams API base path: `<baseUrl>/rest/teams/1.0/` — used for Data Center team resolution (`getTeamByName`); Cloud does not support team lookup by name, use `id` in the template instead

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Multi-turn session state

Multi-turn flows store structured state in `vscode.ExtensionContext.workspaceState` and embed a compact HTML tag in the response as an expiry signal. On the next turn, the handler checks whether the tag appears in the **last** assistant response; if it does, it reads from `workspaceState`. If the user moved on (different response is last), the tag is absent and the session is silently ignored.

| Session | workspaceState key | Tag in response |
| --- | --- | --- |
| `TemplateSelectionSession` | `jira.session.templateSelection` | `<!-- jira:selecting-template -->` |
| `IssueTypeSelectionSession` | `jira.session.typeSelection` | `<!-- jira:selecting-type -->` |
| `CreationSession` | `jira.session.creating` | `<!-- jira:creating -->` |
| `ContentSession` | `jira.session.previewing` | `<!-- jira:previewing -->` |
| `MoreCommentsSession` | `jira.session.moreComments` | `<!-- jira:more-comments -->` |

Detection order in the handler: template selection → issue type selection → creation → content → more-comments → intent parse.

## Ticket creation flow

`handleCreateTicket` in `JiraParticipant` resolves missing mandatory fields interactively:

1. **Template** — chat-native numbered list streamed from `.jira-templates.json`; user replies with number, name, `(n)` / `"no template"` to skip, or `(c)` to cancel entirely; unrecognised reply re-presents the list; template load errors surface as chat messages and fall through to templateless creation
2. **Project key** — from prompt, then `jiraCopilot.defaultProject` setting, then `showInputBox`
3. **Summary** — from prompt (LLM extraction), then `showInputBox`
4. **Issue type** — from template `issueType` field or prompt (LLM extraction); if neither is present, chat-native numbered list via `IssueTypeSelectionSession` (subtasks filtered out); `(c)` to cancel; fallback to `showInputBox` if no types can be fetched from `GET /rest/api/3/project/{key}`

If a template is chosen:

- `FieldResolver.resolve(defaultFields, resolveFields)` maps any `name`-based specs to Jira field values via API lookups; `id`-based specs pass through directly; array entries produce array results
- `descriptionSections` (optional) drives a multi-turn Q&A via `CreationSession`; if absent or empty, ticket is created directly
- When all sections are answered `finishTicketCreation` assembles the description and calls `TicketService.createTicket`
- Field resolution + section handling are in `continueAfterIssueType`, called from both `handleCreateTicket` and the issue type session handler

API endpoint: `POST /rest/api/3/issue` with `{ fields: { project: { key }, summary, issuetype: { name }, ...additionalFields } }`

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

## Credentials

Always stored in `vscode.ExtensionContext.secrets` (VS Code SecretStorage, OS-encrypted).
Never in `settings.json`. Key: `jira-copilot.token`.
