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
| `src/participant/sessionState.ts` | VS Code-free state helpers: `CreationSession`, `extractCreationSessionFromText`, `extractLastTicketFromText` |
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

## Ticket creation flow

`handleCreateTicket` in `JiraParticipant` resolves missing mandatory fields interactively:

1. **Template** — `showQuickPick` from `.jira-templates.json` in workspace root; user may choose "No template" or dismiss if the file is absent or broken
2. **Project key** — from prompt, then `jiraCopilot.defaultProject` setting, then `showInputBox`
3. **Summary** — from prompt (LLM extraction), then `showInputBox`
4. **Issue type** — from prompt, then `showQuickPick` populated from `GET /rest/api/3/project/{key}` (subtasks filtered out)

If a template is chosen:

- `FieldResolver.resolve(defaultFields, resolveFields)` maps any `name`-based specs to Jira field values via API lookups; `id`-based specs pass through directly; array entries produce array results
- `descriptionSections` drives a multi-turn Q&A: the participant asks for one pending section per reply, embedding a hidden `<!-- @jira-create:{json} -->` marker in each response
- On the next user reply the session is recovered from `ChatContext` history via `extractCreationSessionFromText`
- When all sections are answered `finishTicketCreation` calls `TicketService.createTicket` with the assembled description and resolved fields

API endpoint: `POST /rest/api/3/issue` with `{ fields: { project: { key }, summary, issuetype: { name }, ...additionalFields } }`

## Comment display

`TicketService.getTicket` (and therefore `@jira show`) includes a **Comments** section in the output.
`JiraIssue.fields.comment.comments` is fetched and formatted by `formatComments()` in `TicketService`.
Each comment shows author display name, date (YYYY-MM-DD), and body extracted from ADF.

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
