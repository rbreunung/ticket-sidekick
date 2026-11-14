# Jira Templates and Cleanup Rules

> **Note.** `.jira-templates.json` is used by the Copilot tools too (`jira_create_ticket`, `jira_list_templates`, `/ts-jira-create`). The `@jira` commands on this page (generating a template from a ticket, `@jira cleanup`) belong to the deprecated chat participant and stay until the tools and the ticket list board cover them; see [Jira Tools for Copilot Chats](copilot-tools.md).

Part of `@jira` — `.jira-templates.json` defines per-application templates with guided description collection, plus named cleanup rules for bulk status transitions. See the main [README](../../README.md) for setup and core commands first.

## Templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions.

### Generating a template from a ticket

You don't have to hand-write `.jira-templates.json` from scratch. In a Copilot chat, type:

```text
/ts-jira-template PROJ-123 Billing Bug
```

Without a name, Copilot asks you for one. The `jira_create_template` tool reads PROJ-123 and copies its issue type and the values of its template-shaped fields (priority, labels, components, sprint, team; never summary, description, status, reporter or other per-ticket fields). Fields that are empty on the ticket, or hidden by `ticketSidekick.jira.hiddenDisplayFields`, are left out.

Before anything is saved, VS Code shows a confirmation with the name, the issue type and every field with its value:

```text
Saved as:   Billing Bug
Issue type: Bug
Fields:     priority: High
            labels: billing
```

That confirmation is the only review: approve it and the template is added to `.jira-templates.json`, with the rest of the file kept as it is. To leave out a field, remove it from the file afterwards. The answer ends with the `/ts-jira-create` command that creates a ticket from the new template.

**Name collisions:** an existing template is never replaced. When the name is taken, the new template is saved as `Billing Bug (2)`, `Billing Bug (3)` and so on, and the confirmation names the one used. A `.jira-templates.json` that cannot be read (for example invalid JSON) is never written over.

### Template examples

**Minimal — pre-populated fields:**

```json
{
  "templates": [
    {
      "name": "Billing Bug",
      "issueType": "Bug",
      "defaultFields": {
        "priority": { "name": "High" },
        "labels": ["billing"],
        "components": [{ "name": "Backend" }]
      }
    }
  ]
}
```

**With resolved fields and guided description sections:**

```json
{
  "templates": [
    {
      "name": "Billing Bug",
      "issueType": "Bug",
      "defaultFields": {
        "priority": { "name": "High" },
        "labels": ["billing"]
      },
      "resolveFields": {
        "assignee": { "type": "user", "name": "Jane Smith" },
        "customfield_10020": { "type": "sprint", "name": "Sprint 42" },
        "customfield_10050": [{ "type": "team", "id": "billing-team-id" }]
      },
      "descriptionSections": [
        "Steps to reproduce",
        "Expected behavior",
        "Actual behavior"
      ]
    }
  ]
}
```

### Cleanup rule examples

**Basic — close a ticket type to a target state:**

```json
{
  "cleanupRules": [
    {
      "name": "Close billing bugs",
      "project": "BILLING",
      "issueType": "Bug",
      "targetState": "Done",
      "resolution": "Fixed"
    }
  ]
}
```

**With subtasks and version filter:**

```json
{
  "cleanupRules": [
    {
      "name": "Close released bugs",
      "project": "BILLING",
      "issueType": "Bug",
      "targetState": "Done",
      "resolution": "Fixed",
      "closeSubtasks": true,
      "subtaskTargetState": "Closed",
      "subtaskResolution": "Fixed",
      "fixVersionFilter": "released"
    }
  ]
}
```

**With a wildcard version pattern and extra JQL filter:**

```json
{
  "cleanupRules": [
    {
      "name": "Close Release-series bugs",
      "project": "BILLING",
      "issueType": "Bug",
      "targetState": "Done",
      "resolution": "Fixed",
      "fixVersionPattern": "Release*",
      "jql": "assignee is not EMPTY"
    }
  ]
}
```

### Cleanup rule fields

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | yes | — | Rule identifier — used in `@jira run cleanup "name"` |
| `project` | yes | — | Jira project key — always anchors the search query and workflow graph lookup |
| `issueType` | yes | — | Issue type — always anchors the query; use the exact Jira name (e.g. `Bug`, `Story`) |
| `targetState` | yes | — | Destination Jira status name (e.g. `Done`, `Closed`) |
| `resolution` | no | — | Resolution applied to parent ticket transitions (e.g. `Fixed`, `Won't Fix`) |
| `subtaskResolution` | no | same as `resolution` | Resolution applied to subtask transitions — falls back to `resolution` if omitted |
| `subtaskTargetState` | no | same as `targetState` | Destination status for subtask transitions — falls back to `targetState` if omitted |
| `closeSubtasks` | no | `false` | When `true`, open subtasks are transitioned before their parent |
| `jql` | no | — | Extra JQL filter ANDed onto the base query — write only the additional conditions; `project`, `issueType`, and `status` are always included |
| `fixVersionFilter` | no | — | `"released"` or `"unreleased"` — adds `fixVersion in releasedVersions()` / `fixVersion in unreleasedVersions()` to the query |
| `fixVersionPattern` | no | — | Glob-style pattern (e.g. `"Release*"`) — adds `fixVersion ~ "pattern"` to the query (requires Jira 11+ / modern Data Center) |

> **Note:** `project` and `issueType` are always prepended to the effective JQL even when `jql` is set — they are never replaced. The `jql` field adds extra conditions such as `sprint in openSprints()`.
>
> `fixVersionFilter` and `fixVersionPattern` are mutually exclusive in a rule — `fixVersionFilter` takes precedence if both are set. A prompt override (`in "v1.2"`, `in released`, or `in "Release*"`) always wins over the rule setting.

### Version filter examples

```json
{ "fixVersionFilter": "released" }
```
→ `AND fixVersion in releasedVersions()`

```json
{ "fixVersionPattern": "Release*" }
```
→ `AND fixVersion ~ "Release*"`

You can also specify a version filter in the prompt without touching the rule:

```text
@jira run cleanup "Close released bugs" in released
@jira run cleanup "Close released bugs" in "Release*"
@jira run cleanup "Close released bugs" in "Release 3.2"
@jira run cleanup "Close released bugs" in "released"
```

The last example (quoted `"released"`) targets a Jira version literally named _"released"_ — it does **not** trigger `releasedVersions()`. Only the unquoted form does.

### Interaction model

| Prompt | JQL used | Resolution |
|---|---|---|
| `@jira run cleanup "Name"` | base + `rule.jql` if set | `rule.resolution`, or prompted if absent |
| `@jira run cleanup "Name" in "v1.2"` | base + `fixVersion = "v1.2"` + `rule.jql` | same |
| `@jira run cleanup "Name" in released` | base + `fixVersion in releasedVersions()` | same |
| `@jira run cleanup "Name" in unreleased` | base + `fixVersion in unreleasedVersions()` | same |
| `@jira run cleanup "Name" in "Release*"` | base + `fixVersion ~ "Release*"` | same |
| `@jira run cleanup "Name" with resolution "Won't Fix"` | same JQL | prompt value overrides rule |
| `@jira close PROJ Bug` | auto-built (matches rule by project + type if available) | prompted if closing to a closed state |
| `@jira close PROJ bugs in "v1.2" with resolution Released` | auto-built + fixVersion | prompt value — no dialog |

The base query always includes `AND resolution is EMPTY` — tickets that were previously resolved (even if since reopened) are automatically excluded.

When you run `@jira create`, the plugin shows a numbered list of your templates. Choosing one:

- Pre-populates custom fields from `defaultFields` and resolved `resolveFields` entries
- Guides you through each `descriptionSections` entry with a follow-up question per turn, building the description incrementally
- Resumes automatically if the conversation is interrupted — session state is preserved in the chat history

**`resolveFields` entries** support two forms:

- `{ "type": "sprint", "name": "Sprint 42" }` — resolves by name via the Jira Agile API
- `{ "type": "team", "id": "abc123" }` — passes the id through directly (no API call)
- `{ "type": "user", "name": "Jane Smith" }` — resolves to `{ accountId }` via user search

Wrap a single entry in an array when the Jira field expects an array value.

**Setting assignee in a template:**

```json
"resolveFields": {
  "assignee": { "type": "user", "name": "Jane Smith" }
}
```

Or with a known `accountId` directly in `defaultFields`:

```json
"defaultFields": {
  "assignee": { "accountId": "5b10a2844c20165700ede21g" }
}
```

**Setting components in a template:**

```json
"defaultFields": {
  "components": [{ "name": "Backend" }, { "name": "API" }]
}
```

**Setting group-picker custom fields (e.g. Team Names) in a template:**

```json
"defaultFields": {
  "customfield_18501": [{ "name": "ASL QRF" }]
}
```

Group-picker fields use `{ "name": "..." }` — no API lookup is needed since the group name is a known string. Put these directly in `defaultFields` rather than `resolveFields`.

You can choose **No template** to create a plain ticket without any template applied.
