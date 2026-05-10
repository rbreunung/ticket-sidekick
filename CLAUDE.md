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
| `src/utils/branchParser.ts` | Extracts ticket ID from git branch name |

## Running tests

```bash
npm test          # Vitest unit tests (no VS Code required)
npm run compile   # TypeScript type check
npm run test:e2e  # @vscode/test-electron participant tests (requires VS Code)
```

## Adding a new Jira operation

1. Add method to `IJiraClient` interface
2. Implement in `JiraApiClient` (real HTTP)
3. Implement in `MockJiraClient` (fixture return)
4. Add a fixture file to `src/test/fixtures/` matching real Jira v3 API shape
5. Implement in `TicketService` (business logic)
6. Write tests in `TicketService.test.ts` first, then implement
7. Add intent routing in `JiraParticipant.ts`

## Jira API

- Base path: `<baseUrl>/rest/api/3/`
- Data Center auth: `Authorization: Bearer <PAT>`
- Cloud auth: `Authorization: Basic base64(email:apiToken)`
- Description fields use Atlassian Document Format (ADF) — wrap plain text with `wrapInAdf()` in TicketService

## Branch ticket detection

Regex: `[A-Z][A-Z0-9]+-\d+` applied to `git branch --show-current` output.
Example: `feature/PROJ-123-add-login` → `PROJ-123`

## Ticket creation flow

`createTicket` in `JiraParticipant` resolves missing mandatory fields interactively:

1. **Project key** — from prompt, then `jiraCopilot.defaultProject` setting, then `showInputBox`
2. **Summary** — from prompt (LLM extraction), then `showInputBox`
3. **Issue type** — from prompt, then `showQuickPick` populated from `GET /rest/api/3/project/{key}` (subtasks filtered out)

API endpoint: `POST /rest/api/3/issue` with `{ fields: { project: { key }, summary, issuetype: { name } } }`

## Credentials

Always stored in `vscode.ExtensionContext.secrets` (VS Code SecretStorage, OS-encrypted).
Never in `settings.json`. Key: `jira-copilot.token`.
