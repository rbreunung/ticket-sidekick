# Jira Templates and Cleanup Rules

`.jira-templates.json` defines per-application ticket templates and named cleanup rules. The Copilot tools create tickets from the templates (`jira_list_templates`, `jira_create_ticket`, `/ts-jira-create`, `/ts-jira-template`), and the ticket list board runs the cleanup rules; see [Jira Tools for Copilot Chats](copilot-tools.md) and [Boards](boards.md#cleanup). The Veracode, Waltz and email imports of `@jira` use the templates too. See the main [README](../../README.md) for setup first.

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
| `name` | yes | — | Rule identifier — used in `/ts-jira cleanup "name"`, "run the cleanup name" and `Ticket Sidekick: Run a cleanup rule` |
| `project` | yes | — | Jira project key — always anchors the search query and workflow graph lookup |
| `issueType` | yes | — | Issue type — always anchors the query; use the exact Jira name (e.g. `Bug`, `Story`) |
| `targetState` | yes | — | Destination Jira status name (e.g. `Done`, `Closed`) |
| `resolution` | no | — | Resolution applied to parent ticket transitions (e.g. `Fixed`, `Won't Fix`) |
| `subtaskResolution` | no | same as `resolution` | Resolution applied to subtask transitions — falls back to `resolution` if omitted |
| `subtaskTargetState` | no | same as `targetState` | Destination status for subtask transitions — falls back to `targetState` if omitted |
| `closeSubtasks` | no | `false` | When `true`, open subtasks are listed beneath their parent and transitioned before it |
| `jql` | no | — | Extra JQL filter ANDed onto the base query — write only the additional conditions; `project`, `issueType`, and `status` are always included |
| `fixVersionFilter` | no | — | `"released"` or `"unreleased"` — adds `fixVersion in releasedVersions()` / `fixVersion in unreleasedVersions()` to the query |
| `fixVersionPattern` | no | — | Glob-style pattern (e.g. `"Release*"`) — adds `fixVersion ~ "pattern"` to the query (requires Jira 11+ / modern Data Center) |

> **Note:** `project` and `issueType` are always prepended to the effective JQL even when `jql` is set — they are never replaced. The `jql` field adds extra conditions such as `sprint in openSprints()`.
>
> `fixVersionFilter` and `fixVersionPattern` are mutually exclusive in a rule — `fixVersionFilter` takes precedence if both are set. A fix version given when the cleanup starts (`in 3.2`, `in released` or `in Release*`) always wins over the rule setting.

### Version filter examples

```json
{ "fixVersionFilter": "released" }
```
→ `AND fixVersion in releasedVersions()`

```json
{ "fixVersionPattern": "Release*" }
```
→ `AND fixVersion ~ "Release*"`

You can also give a fix version when the cleanup starts, without touching the rule:

```text
/ts-jira cleanup "Close released bugs" in released
/ts-jira cleanup "Close released bugs" in Release*
/ts-jira cleanup "Close released bugs" in 3.2
/ts-jira cleanup "Close released bugs" in "released"
```

The last example (`"released"` in double quotes) targets a Jira version literally named _released_ — it does **not** use `releasedVersions()`. `Ticket Sidekick: Run a cleanup rule` asks for the same value after you pick the rule.

### What the cleanup board does

| Started with | JQL used | Resolution |
|---|---|---|
| `/ts-jira cleanup "Name"` | base + the rule's fix version + `rule.jql` if set | `rule.resolution`; chosen on the board when the target closes tickets and the rule names none |
| `/ts-jira cleanup "Name" in 3.2` | base + `fixVersion = "3.2"` + `rule.jql` | same |
| `/ts-jira cleanup "Name" in released` | base + `fixVersion in releasedVersions()` + `rule.jql` | same |
| `/ts-jira cleanup "Name" in unreleased` | base + `fixVersion in unreleasedVersions()` + `rule.jql` | same |
| `/ts-jira cleanup "Name" in Release*` | base + `fixVersion ~ "Release*"` + `rule.jql` | same |

The base query always includes `AND resolution is EMPTY` — tickets that were previously resolved (even if since reopened) are automatically excluded. The board lists the tickets 50 to a page and applies the selected tickets of the page in view; see [Boards → Cleanup](boards.md#cleanup).

To close tickets without a rule, ask Copilot ("close the PROJ bugs in fix version 3.2"): it opens the ticket list with the move proposed, and you apply it a page at a time.

### Creating a ticket from a template

When you create a ticket with `/ts-jira-create` (or ask Copilot in Agent mode to create one), Copilot lists your templates with `jira_list_templates` and uses the one that fits, or asks you to pick. Using a template:

- Sets the fields from `defaultFields` and the resolved `resolveFields` entries
- Uses each `descriptionSections` entry as a heading of the drafted description, filled from your request; a section Copilot cannot fill becomes a short question to you
- Shows the draft before anything is created

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
