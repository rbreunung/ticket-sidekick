# Jira Copilot

Manage Jira tickets with GitHub Copilot Chat — without leaving VS Code.

## Prerequisites

- VS Code 1.90 or later
- GitHub Copilot extension installed and signed in
- Jira 10 Data Center **or** any Jira Cloud instance

## Setup

### 1. Set the Jira base URL

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and add:

```json
"jiraCopilot.baseUrl": "https://jira.mycompany.com"
```

For Jira Cloud: `"https://your-org.atlassian.net"`

### 2. Set your auth type (Cloud only)

```json
"jiraCopilot.authType": "cloud"
```

Omit this setting for Data Center (default).

### 3. Store your credentials

**Data Center:** Open the Command Palette (`Ctrl+Shift+P`) → `Jira Copilot: Set Personal Access Token`

**Cloud:** Open the Command Palette → `Jira Copilot: Configure Cloud Credentials`
(You will need your Atlassian email and an API token from id.atlassian.com)

## Usage

Open GitHub Copilot Chat and use `@jira`:

| What you type | What happens |
| --- | --- |
| `@jira show me PROJ-123` | Displays ticket details |
| `@jira summarise this ticket` | Shows current branch ticket |
| `@jira create a bug: login times out` | Creates a new ticket (asks for project and type if missing) |
| `@jira create Story in VSJI: add dark mode` | Creates a ticket with project and type from the prompt |
| `@jira set priority to High` | Updates priority on current branch ticket |
| `@jira assign this to jane.doe` | Assigns ticket (searches by name) |
| `@jira comment that the fix is in PR #42` | Adds a comment |
| `@jira find open bugs assigned to me` | Runs JQL search |
| `@jira check required fields on PROJ-123` | Validates required fields |

### Ticket detection

If you don't name a ticket, the plugin reads your current git branch. A branch named `feature/PROJ-123-my-work` will automatically use `PROJ-123`.

### Optional: default project

```json
"jiraCopilot.defaultProject": "VSJI"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

### Optional: required fields

```json
"jiraCopilot.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

## Getting a free Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `jiraCopilot.baseUrl` to `https://<you>.atlassian.net` and `jiraCopilot.authType` to `"cloud"`
4. Run `Jira Copilot: Configure Cloud Credentials`
