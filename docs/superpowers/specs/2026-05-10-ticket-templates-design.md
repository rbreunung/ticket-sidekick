# Ticket Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow teams to define per-application ticket templates in a workspace file, with default field values, custom field resolution, and guided multi-turn description collection via the `@jira` chat participant.

**Architecture:** A new `TemplateService` reads `.jira-templates.json` from the workspace root. A new `FieldResolver` resolves named fields (sprint, team, user) to Jira API-ready values before ticket creation. The existing multi-turn creation flow in `JiraParticipant` is extended to collect required description sections one question per round-trip, carrying state in a hidden HTML comment embedded in each assistant response.

**Tech Stack:** TypeScript, VS Code Extension API, Jira REST API v3, Jira Agile REST API v1, Atlassian Teams API (Cloud) / Jira Teams REST API (Data Center)

---

## Template File Format

Templates are defined in `.jira-templates.json` at the workspace root and committed to git. The file is read fresh on each ticket creation — no caching.

```json
{
  "templates": [
    {
      "name": "Billing App Bug",
      "defaultFields": {
        "priority": "High",
        "labels": ["billing"]
      },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "name": "Sprint 5" },
        "customfield_10200": { "type": "team", "name": "Backend Team" }
      },
      "descriptionSections": [
        "Steps to reproduce",
        "Expected behavior",
        "Actual behavior",
        "Environment"
      ]
    },
    {
      "name": "Frontend Story",
      "defaultFields": {
        "priority": "Medium",
        "labels": ["frontend"]
      },
      "resolveFields": {
        "customfield_10020": { "type": "sprint", "id": 42 },
        "customfield_10200": [
          { "type": "team", "id": "abc-team-id" },
          { "type": "team", "id": "def-team-id" }
        ]
      },
      "descriptionSections": [
        "User story",
        "Acceptance criteria",
        "Design link"
      ]
    }
  ]
}
```

### Field rules

**`defaultFields`** — values passed to the Jira API as-is. Can be a string, number, array, or object. The user is responsible for the exact Jira API shape (e.g. `[{ "name": "1.0" }]` for fix versions).

**`resolveFields`** — fields requiring name→ID or ID→API-object conversion before ticket creation. Each entry is either a single resolve spec or an array of resolve specs:

- Single object → resolved to a single Jira API object: `{ "id": resolvedId }`
- Array of objects → each resolved individually, sent as: `[{ "id": id1 }, { "id": id2 }]`

Each resolve spec has:
- `type`: `"sprint"` | `"team"` | `"user"`
- `name` (optional): friendly name — triggers an API lookup at creation time
- `id` (optional): pre-mapped ID — no API call, passed through directly

At least one of `name` or `id` must be provided per spec. If both are present, `id` takes precedence and no API call is made.

**`descriptionSections`** — ordered list of required sections in the ticket description. The LLM checks the user's initial prompt for coverage. Uncovered sections are collected one per chat round-trip.

---

## Creation Flow

### Turn 1 — User initiates

1. Handler checks `ChatContext` history for a `@jira-create` state marker → none found, start fresh.
2. `TemplateService.loadTemplates()` reads `.jira-templates.json`. If the file is absent, skip template selection and use the existing creation flow unchanged.
3. `vscode.window.showQuickPick` presents template names plus a **"Proceed without template"** option at the bottom. Selecting it skips all template logic and falls back to the existing creation flow.
4. Intent parsed for `project`, `summary`, `issueType` (existing flow). Missing mandatory fields are prompted via input box / quick pick as before.
5. `FieldResolver.resolve(template, config)` resolves all `resolveFields` upfront. Results stored in the state marker so no re-resolution occurs on subsequent turns.
6. LM call checks which `descriptionSections` the user's initial prompt already covers. Covered sections are pre-populated in `answers`.
7. If all sections covered → assemble description, create ticket immediately.
8. If sections remain → stream first question, append state marker to response.

### Turns 2..N — Collecting missing sections

1. Handler finds `@jira-create` marker in the last `ChatResponseTurn` from `ChatContext`.
2. Records user's current message as the answer for the section that was last asked (`pending[0]`).
3. Removes answered section from `pending`.
4. If `pending` is empty → assemble description, create ticket, no marker appended.
5. If sections remain → ask next question (`pending[0]`), update marker with new answers.

### Ticket creation (final turn)

- Call `TicketService.createTicket(project, summary, issueType, additionalFields)`.
- `additionalFields` = merged `defaultFields` + resolved `resolveFields` + assembled description.
- `assembleDescription(sections, answers)` formats sections in template order, wraps in ADF.

### Example dialog — Billing App Bug

> **User:** `@jira create a bug — login button on billing page causes a 404 error`
>
> **@jira:** *(quick pick shown → "Billing App Bug" selected)*
> *Using template **Billing App Bug** — defaults: priority High, labels [billing], Sprint 5, team Backend Team.*
> *Your description already covers **Actual behavior**. Two sections still needed.*
>
> **Steps to reproduce** — What are the exact steps to trigger this?

> **User:** `Go to the billing page, click the Login button`

> **@jira:** Got it. Next:
>
> **Expected behavior** — What should happen after clicking Login?

> **User:** `User should be redirected to the main dashboard`

> **@jira:** Last one:
>
> **Environment** — Which browser, OS, or environment did this occur in?

> **User:** `Chrome 124 on Windows 11, production`

> **@jira:** Created **BILLING-456**: Login button on billing page causes a 404 error *(Bug in BILLING)*
> Fields applied: Priority High · Labels billing · Sprint 5 · Team Backend Team

Resulting ticket fields:

| Field | Value |
|---|---|
| Summary | Login button on billing page causes a 404 error |
| Issue type | Bug |
| Priority | High |
| Labels | billing |
| Sprint | Sprint 5 (resolved by name) |
| Team | Backend Team (resolved by name) |

Resulting description (in ADF):
```
**Actual behavior**
Login button on billing page causes a 404 error.

**Steps to reproduce**
Go to the billing page, click the Login button.

**Expected behavior**
User should be redirected to the main dashboard.

**Environment**
Chrome 124 on Windows 11, production.
```

---

## State Marker

A hidden HTML comment appended to each in-progress response. Not visible in the VS Code chat UI (HTML comments are stripped by markdown renderers).

```
<!-- @jira-create:{"template":"Billing App Bug","project":"BILLING","summary":"Login timeout","issueType":"Bug","pending":["Expected behavior","Environment"],"answers":{"Steps to reproduce":"Go to billing page..."},"fields":{"priority":"High","labels":["billing"],"customfield_10020":{"id":42},"customfield_10200":{"id":"backend-team-id"}}} -->
```

Fields:
- `template` — template name (for display only)
- `project`, `summary`, `issueType` — ticket mandatory fields
- `pending` — ordered list of sections still to be collected
- `answers` — map of section name → collected answer
- `fields` — fully resolved field map (merged `defaultFields` + resolved `resolveFields`); computed once in Turn 1

`parseCreationSession(context: vscode.ChatContext): CreationSession | null` scans `context.history` in reverse for the most recent `ChatResponseTurn`, extracts its markdown text, and matches the marker pattern with a regex.

---

## Field Resolution

### `FieldResolver.resolve(template, config)`

For each entry in `resolveFields`:
1. If value is an array → resolve each spec independently, collect into an array.
2. If value is a single object:
   - `id` present → return `{ id }` directly (no API call).
   - `name` present → call the appropriate resolver based on `type`.

Resolution by type:

| type | API (Cloud) | API (Data Center) | Returns |
|---|---|---|---|
| `sprint` | `/rest/agile/1.0/board?projectKeyOrId={key}` → `/board/{id}/sprint?state=active,future` | Same Agile API | `{ id: number }` |
| `team` | Atlassian org API `/gateway/api/public/teams/v1/org/{orgId}/teams` | `/rest/teams/1.0/teams/find?query={name}` | `{ id: string }` |
| `user` | Existing `IJiraClient.findUser(name)` | Same | `{ accountId: string }` |

Team resolution is best-effort. If the Jira instance does not expose a standard teams API (common with older Data Center instances where the team field originates from an unknown plugin), `FieldResolver` returns a descriptive error: `"Could not resolve team '{name}' — use id instead"`. The `id` path is always reliable regardless of field origin.

---

## Architecture & File Changes

### New files

| File | Responsibility |
|---|---|
| `src/templates/TemplateService.ts` | Reads and parses `.jira-templates.json`; exports `JiraTemplate` type |
| `src/templates/FieldResolver.ts` | Resolves `resolveFields` entries to Jira API-ready values |
| `src/test/TemplateService.test.ts` | Tests for file parsing, missing file, invalid JSON |
| `src/test/FieldResolver.test.ts` | Tests for all resolution paths (name, id, array, unsupported type) |
| `src/test/fixtures/sprint-PROJ.json` | Agile API sprint fixture |
| `src/test/fixtures/team-backend.json` | Teams API team fixture |
| `.jira-templates.json` (example) | Example template file committed to repo |

### Modified files

| File | Change |
|---|---|
| `src/jira/IJiraClient.ts` | Add `getSprintByName(projectKey, name)`, `getTeamByName(name, authType)`, extend `createIssue` with optional `additionalFields` |
| `src/jira/JiraApiClient.ts` | Implement new methods; `getTeamByName` branches on `authType` |
| `src/services/TicketService.ts` | `createTicket` accepts `additionalFields`; add `assembleDescription` helper |
| `src/participant/JiraParticipant.ts` | Add `parseCreationSession`, `handleCreateTicket` function; template quick pick at creation start |
| `src/test/mocks/MockJiraClient.ts` | Implement `getSprintByName`, `getTeamByName` with fixture returns |
| `src/test/TicketService.test.ts` | Tests for `assembleDescription`, extended `createTicket` |

---

## Error Handling

- **`.jira-templates.json` absent** — skip template selection, fall back to existing creation flow unchanged.
- **Invalid JSON in template file** — show error in chat: `"Could not parse .jira-templates.json: <parse error>"` and offer `showQuickPick` with `["Proceed without template", "Cancel"]`. Selecting proceed falls back to the existing creation flow.
- **Sprint not found by name** — show error: `"Sprint '{name}' not found in project {key}."` and offer `["Proceed without template", "Cancel"]`.
- **Team not found / API unsupported** — show error: `"Could not resolve team '{name}' — use id instead."` and offer `["Proceed without template", "Cancel"]`.
- **User cancels quick pick or selects Cancel** — `"Cancelled."`.
- **State marker not parseable** — treat as fresh start (no partial state recovery).

---

## Testing

**`TemplateService.test.ts`**
- Returns parsed templates from a valid file
- Returns empty array when file is absent
- Throws with clear message on invalid JSON

**`FieldResolver.test.ts`**
- `id` present → passes through, no API call made
- `name` present → calls correct API method, returns resolved value
- Array of specs → resolves each, returns array
- Unknown type → throws descriptive error
- Team name resolution failure → throws with "use id instead" message

**`TicketService.test.ts`** (additions)
- `assembleDescription` orders sections by template order regardless of collection order
- `createTicket` with `additionalFields` passes them through to `createIssue`

**`JiraParticipant` flow** — covered by existing e2e test infrastructure; unit tests for `parseCreationSession` (marker found, marker absent, malformed marker).
