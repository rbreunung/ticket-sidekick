# Jira Copilot VS Code Plugin — Design Spec

**Date:** 2026-05-09  
**Status:** Approved

## Context

Developers spend significant time context-switching between their editor and Jira to read, update, and comment on tickets. The goal is to eliminate that switch by bringing Jira interaction directly into VS Code via GitHub Copilot Chat. The plugin exposes a `@jira` chat participant so users can manage tickets in natural language without leaving their editor.

The primary target is self-hosted Jira 10 (Data Center) with Personal Access Token auth. Jira Cloud is also supported from the start — same REST API v3 endpoints, different auth header — so the developer can use a free Atlassian Cloud account for early testing before touching the company server.

The plugin must be fully testable by an AI agent without access to a live Jira instance.

---

## Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Copilot integration model | Chat Participant (`@jira`) | User controls invocation; supports complex multi-step agentic tasks like JQL-based reviews |
| Architecture | Service layer | JiraApiClient sits behind an interface, enabling full test coverage with no real Jira |
| Ticket context | Branch auto-detect + explicit override | Regex on git branch name covers the common case; explicit ticket ID always wins |
| Edit scope (Phase 1) | Field updates | summary, description, priority, assignee, labels, fix version |
| Edit scope (Phase 2) | Status transitions | Separate Jira endpoint and transition-specific logic — natural follow-on |
| Jira deployment targets | Data Center + Cloud | Same REST API v3 endpoints; only auth header differs — one setting switches modes |
| Language | TypeScript strict mode | Required by VS Code API type definitions; catches interface mismatches at compile time |
| Test runner | Vitest (unit) + @vscode/test-electron (integration) | Vitest needs no VS Code process; electron runner only for participant layer |

---

## Architecture

Three layers plus a config service, each with one responsibility.

```
JiraParticipant       — receives chat messages, parses intent via VS Code LM API, routes to TicketService
    ↓
TicketService         — business logic: orchestration, validation, formatting, error handling
    ↓
IJiraClient           — interface (the test seam)
    ├── JiraApiClient     (production: real HTTP + auth header)
    └── MockJiraClient    (tests: returns fixture JSON)

ConfigService         — reads baseUrl and authType from VS Code settings, credentials from SecretStorage
```

### Why the interface matters

`TicketService` depends on `IJiraClient`, not on `JiraApiClient`. In production the real client is injected; in tests `MockJiraClient` is injected. `TicketService` is identical in both cases. This means all business logic is unit-testable with zero network calls and zero Jira access.

---

## File Structure

```
src/
  extension.ts                  — activate(): registers participant, commands, config
  participant/
    JiraParticipant.ts          — onMessage handler, intent parsing, branch detection fallback
  services/
    TicketService.ts            — read, edit fields, comment, JQL search, validate
    ConfigService.ts            — baseUrl + authType from settings, credentials from SecretStorage
  jira/
    IJiraClient.ts              — interface: getIssue, updateIssue, addComment, searchJql, getTransitions, executeTransition
    JiraApiClient.ts            — implements IJiraClient; builds auth header based on authType
  utils/
    branchParser.ts             — extractTicketId(branchName: string): string | null
src/test/
  TicketService.test.ts
  branchParser.test.ts
  JiraApiClient.test.ts
  participant/
    JiraParticipant.test.ts
  fixtures/
    ticket-PROJ-123.json        — realistic Jira v3 issue response
    ticket-not-found.json       — 404 error shape
    search-results.json         — JQL search response (multiple issues)
    transitions-PROJ-123.json   — available transitions (Phase 2 fixture, created now)
  mocks/
    MockJiraClient.ts           — implements IJiraClient, returns fixtures
```

---

## Operations

### Phase 1 (MVP)

| Operation | Example prompts | Jira API endpoint |
| --- | --- | --- |
| Read ticket | `@jira show me PROJ-123` / `@jira summarise this ticket` | `GET /rest/api/3/issue/{id}` |
| Add comment | `@jira comment on PROJ-123 that the fix is in PR #42` | `POST /rest/api/3/issue/{id}/comment` |
| Edit fields | `@jira set priority to High` / `@jira assign this to jane.doe` | `PUT /rest/api/3/issue/{id}` |
| JQL search | `@jira find open bugs assigned to me` / `@jira review sprint tickets against our DoD` | `POST /rest/api/3/issue/search` |
| Validate ticket | `@jira check required fields on PROJ-123` | `GET /rest/api/3/issue/{id}` |

Editable fields (Phase 1): `summary`, `description`, `priority`, `assignee`, `labels`, `fixVersions`.

Required field names for validation are defined in extension settings (`jiraCopilot.requiredFields`), defaulting to `[]`. When empty, the validate operation responds with a message instructing the user to configure required fields.

### Phase 2

**Status transition** — `@jira move PROJ-123 to In Review`

Fetches available transitions (`GET /rest/api/3/issue/{id}/transitions`), matches the user's intent to one, then executes it (`POST /rest/api/3/issue/{id}/transitions`). Transitions may require additional fields (e.g. resolution) — the participant prompts for these if needed.

---

## Ticket Context Resolution

When a ticket ID is not explicitly mentioned in the message:

1. Run `git branch --show-current` in the workspace root
2. Apply regex `[A-Z][A-Z0-9]+-\d+` to extract a ticket ID (e.g. `PROJ-123` from `feature/PROJ-123-add-login`)
3. If found: use it and tell the user which ticket was inferred
4. If not found: ask the user "Which ticket are you referring to?"

Explicit ticket IDs in the message always take precedence over branch detection.

---

## Authentication & Configuration

### Settings

| Config item | Setting key | Storage | How set |
| --- | --- | --- | --- |
| Jira base URL | `jiraCopilot.baseUrl` | VS Code workspace settings | User edits `settings.json` |
| Auth type | `jiraCopilot.authType` | VS Code workspace settings | `"datacenter"` (default) or `"cloud"` |
| Required fields | `jiraCopilot.requiredFields` | VS Code workspace settings | Array of field names, default `[]` |
| PAT (Data Center) | — | VS Code SecretStorage | Command: `Jira Copilot: Set Personal Access Token` |
| Email (Cloud) | — | VS Code SecretStorage | Command: `Jira Copilot: Configure Cloud Credentials` |
| API token (Cloud) | — | VS Code SecretStorage | Same command as email |

Credentials are never written to `settings.json`. On first use, if any required value is missing, the participant responds with a setup guide rather than a cryptic error.

### Auth header by type

| Auth type | Header format | Credentials needed |
| --- | --- | --- |
| `datacenter` | `Authorization: Bearer <PAT>` | Personal Access Token |
| `cloud` | `Authorization: Basic base64(email:apiToken)` | Atlassian email + API token |

`JiraApiClient` reads `authType` from `ConfigService` and builds the correct header. All other code is identical between the two modes.

**API base path:** `<baseUrl>/rest/api/3/`

### Getting a free Cloud test instance

1. Create a free account at atlassian.com — includes a Jira Cloud instance at `<you>.atlassian.net`
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `jiraCopilot.baseUrl` to `https://<you>.atlassian.net` and `jiraCopilot.authType` to `"cloud"`
4. Run `Jira Copilot: Configure Cloud Credentials` and enter email + API token

---

## Testing Strategy

### Layers and what is tested

| Layer | Test type | What is verified |
| --- | --- | --- |
| `branchParser` | Unit (Vitest) | Regex extracts IDs from standard and non-standard branch formats; returns null when no ID present |
| `TicketService` | Unit (Vitest) | Business logic with `MockJiraClient`; field validation, comment formatting, JQL construction, error paths |
| `JiraApiClient` | Unit (Vitest) | Correct URL construction, auth header format for both modes, HTTP error mapping (401 → auth error, 404 → not found) |
| `JiraParticipant` | Integration (@vscode/test-electron) | Intent parsing, branch fallback, chat output format, missing-config guidance |

### Fixtures

Fixture files in `src/test/fixtures/` match the real Jira REST API v3 response shapes. They are used by `MockJiraClient` and checked into source control. When the Jira API shape changes, update the fixture — not the tests.

### Running tests

```bash
npm test          # Vitest unit tests (no VS Code process)
npm run test:e2e  # @vscode/test-electron integration tests
npm run compile   # TypeScript compile check
```

---

## Initial Files to Create

| File | Purpose |
| --- | --- |
| `package.json` | Extension manifest: name, publisher, activation events, contributes (participant, commands, config), scripts |
| `tsconfig.json` | Strict mode, target ES2022, module CommonJS (required by VS Code extension host) |
| `.vscodeignore` | Excludes `src/`, `src/test/`, `node_modules/` from packaged `.vsix` |
| `.gitignore` | `node_modules/`, `out/`, `*.vsix`, `.env` |
| `CLAUDE.md` | AI agent context: architecture rules, test seam, test commands, Jira API conventions |
| `README.md` | User-facing: prerequisites, setup (settings + credential commands), usage examples |
| `src/extension.ts` | Skeleton `activate()` that registers the participant and configure commands |
| `src/jira/IJiraClient.ts` | Interface definition — created first so all other files can depend on it |

---

## CLAUDE.md Content Guidelines

The `CLAUDE.md` must give an AI agent enough context to implement and test the plugin without a real Jira instance. It must cover:

- Project purpose and one-sentence architecture summary
- The three-layer rule: participant → service → client (never skip layers)
- That `IJiraClient` is the test seam — `TicketService` must never import `JiraApiClient` directly
- How to run tests: `npm test`, `npm run test:e2e`, `npm run compile`
- Fixture location and the instruction to add a new fixture when adding a new API operation
- Jira REST API v3 base path: `<baseUrl>/rest/api/3/`
- Auth header formats: `Bearer <PAT>` for Data Center, `Basic base64(email:apiToken)` for Cloud
- `authType` setting (`"datacenter"` | `"cloud"`) controls which header `JiraApiClient` builds
- Branch name regex for ticket ID extraction: `[A-Z][A-Z0-9]+-\d+`
- Credentials are always stored in VS Code SecretStorage — never in `settings.json`

---

## Verification

Before considering the MVP complete:

- [ ] `npm run compile` exits with no TypeScript errors
- [ ] `npm test` passes all Vitest unit tests
- [ ] `npm run test:e2e` passes participant integration tests
- [ ] `Jira Copilot: Set Personal Access Token` command appears in command palette
- [ ] `Jira Copilot: Configure Cloud Credentials` command appears in command palette
- [ ] `@jira show me PROJ-123` returns formatted ticket output in Copilot Chat
- [ ] `@jira summarise this ticket` on a feature branch with a ticket ID in the name uses the correct ticket
- [ ] `@jira summarise this ticket` on `main` asks the user which ticket to use
- [ ] Missing config (no URL or no credentials) produces a clear setup message, not an error stack
- [ ] Cloud auth (`authType: "cloud"`) sends `Basic` header; Data Center sends `Bearer` header
