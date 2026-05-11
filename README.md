# Ticket Sidekick

Manage Jira tickets with GitHub Copilot Chat — without leaving VS Code.

## Prerequisites

- VS Code 1.90 or later
- GitHub Copilot extension installed and signed in
- Jira 10 Data Center **or** any Jira Cloud instance

## Setup

### 1. Set the Jira base URL

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and add:

```json
"ticketSidekick.baseUrl": "https://jira.mycompany.com"
```

For Jira Cloud: `"https://your-org.atlassian.net"`

### 2. Set your auth type (Cloud only)

```json
"ticketSidekick.authType": "cloud"
```

Omit this setting for Data Center (default).

### 3. Store your credentials

**Data Center:** Open the Command Palette (`Ctrl+Shift+P`) → `Ticket Sidekick: Set Personal Access Token`

**Cloud:** Open the Command Palette → `Ticket Sidekick: Configure Cloud Credentials`
(You will need your Atlassian email and an API token from id.atlassian.com)

## Usage

Open GitHub Copilot Chat and use `@jira`:

| What you type | What happens |
| --- | --- |
| `@jira show me PROJ-123` | Displays ticket details including comments |
| `@jira summarise this ticket` | Shows current branch ticket |
| `@jira does it have comments?` | Follow-up on the last ticket shown — no need to repeat the key |
| `@jira create a bug: login times out` | Creates a new ticket (asks for project and type if missing) |
| `@jira create Story in VSJI: add dark mode` | Creates a ticket with project and type from the prompt |
| `@jira set priority to High` | Updates priority on current branch ticket |
| `@jira assign this to jane.doe` | Assigns ticket (searches by name) |
| `@jira comment that the fix is in PR #42` | Adds a comment |
| `@jira find open bugs assigned to me` | Runs JQL search |
| `@jira check required fields on PROJ-123` | Validates required fields |

### Ticket detection

If you don't name a ticket, the plugin resolves it in this order:

1. Explicit key in your prompt (`PROJ-123`)
2. Current git branch — `feature/PROJ-123-my-work` → `PROJ-123`
3. Last ticket referenced earlier in the chat session
4. Input box — the plugin asks you

This means you can `@jira show PROJ-123`, then immediately follow up with `@jira add a comment: done` without repeating the key.

### Optional: default project

```json
"ticketSidekick.defaultProject": "VSJI"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

### Optional: required fields

```json
"ticketSidekick.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

### Optional: ticket templates

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection.

```json
[
  {
    "name": "Billing App Bug",
    "defaultFields": {
      "priority": { "name": "High" },
      "labels": ["billing"]
    },
    "resolveFields": {
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
```

When you run `@jira create`, the plugin shows a quick-pick list of your templates. Choosing one:

- Pre-populates custom fields from `defaultFields` and resolved `resolveFields` entries
- Guides you through each `descriptionSections` entry with a follow-up question per turn, building the description incrementally
- Resumes automatically if the conversation is interrupted — session state is preserved in the chat history

**`resolveFields` entries** support two forms:

- `{ "type": "sprint", "name": "Sprint 42" }` — resolves by name via the Jira Agile API
- `{ "type": "team", "id": "abc123" }` — passes the id through directly (no API call)

Wrap a single entry in an array when the Jira field expects an array value.

You can choose **No template** to create a plain ticket without any template applied.

## Getting a free Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Cloud Credentials`
