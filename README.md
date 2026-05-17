# Ticket Sidekick

Two independent GitHub Copilot Chat participants — use one or both:

- **`@jira`** — manage Jira tickets in natural language (create, read, update, comment, bulk transitions)
- **`@bitbucket`** — review Bitbucket pull requests with structured AI analysis and multi-turn follow-ups

Neither participant requires the other to be configured.

---

## Jira

### Prerequisites

- VS Code 1.90 or later with GitHub Copilot extension
- Jira Data Center (v8+) **or** any Jira Cloud instance

### Setup

#### 1. Set the Jira base URL

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and add:

```json
"ticketSidekick.jira.baseUrl": "https://jira.mycompany.com"
```

For Jira Cloud: `"https://your-org.atlassian.net"`

#### 2. Set your auth type (Cloud only)

```json
"ticketSidekick.jira.authType": "cloud"
```

Omit this setting for Data Center (default).

#### 3. Store your credentials

**Data Center:** Open the Command Palette (`Ctrl+Shift+P`) → `Ticket Sidekick: Set Jira Personal Access Token`

**Cloud:** Open the Command Palette → `Ticket Sidekick: Configure Jira Cloud Credentials`
(You will need your Atlassian email and an API token from id.atlassian.com)

### Usage

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
| `@jira check` | Tests the connection and shows active configuration |

### Ticket detection

If you don't name a ticket, the plugin resolves it in this order:

1. Explicit key in your prompt (`PROJ-123`)
2. Current git branch — `feature/PROJ-123-my-work` → `PROJ-123`
3. Last ticket referenced earlier in the chat session
4. Input box — the plugin asks you

This means you can `@jira show PROJ-123`, then immediately follow up with `@jira add a comment: done` without repeating the key.

### Optional: default project

```json
"ticketSidekick.jira.defaultProject": "VSJI"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

### Optional: required fields

```json
"ticketSidekick.jira.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

### Optional: Jira API version

```json
"ticketSidekick.jira.apiVersion": 2
```

Default is `3`. Set to `2` if your Data Center instance does not expose `/rest/api/3` (common on Jira versions before 8.4). On API v2, descriptions and comments are sent as plain text instead of Atlassian Document Format.

### Optional: connection info banner

```json
"ticketSidekick.jira.showConnectionInfo": true
```

When enabled, every `@jira` response starts with an italic line showing the active base URL, API version, and auth type. Useful during initial setup or when switching between instances. Off by default.

### Optional: ticket templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions.

```json
{
  "templates": [
    {
      "name": "Billing App Bug",
      "issueType": "Bug",
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
  ],
  "cleanupRules": [
    {
      "name": "Close released bugs",
      "project": "BILLING",
      "issueType": "Bug",
      "targetState": "Done",
      "resolution": "Fixed",
      "closeSubtasks": true
    }
  ]
}
```

When you run `@jira create`, the plugin shows a numbered list of your templates. Choosing one:

- Pre-populates custom fields from `defaultFields` and resolved `resolveFields` entries
- Guides you through each `descriptionSections` entry with a follow-up question per turn, building the description incrementally
- Resumes automatically if the conversation is interrupted — session state is preserved in the chat history

**`resolveFields` entries** support two forms:

- `{ "type": "sprint", "name": "Sprint 42" }` — resolves by name via the Jira Agile API
- `{ "type": "team", "id": "abc123" }` — passes the id through directly (no API call)

Wrap a single entry in an array when the Jira field expects an array value.

You can choose **No template** to create a plain ticket without any template applied.

### Workflow discovery (required for bulk transitions)

Before running cleanup rules or bulk status transitions, teach the plugin your Jira workflow:

```text
@jira discover workflow BILLING Bug
```

This samples tickets across all statuses, queries their available transitions, and saves a workflow graph to `.jira-workflow-cache.json` at your workspace root. Re-run whenever your Jira workflow changes.

The plugin uses this graph to find the shortest transition path from each ticket's current status to the target state.

> **Tip:** Commit `.jira-workflow-cache.json` to share it with your team so everyone benefits from a single discovery run.

### Bulk cleanup

Run a named cleanup rule to transition a batch of tickets to a target state:

```text
@jira run cleanup "Close released bugs"
```

Or target a specific fix version ad-hoc:

```text
@jira close BILLING bugs in "Release 3.2"
```

The plugin:

1. Searches for matching open tickets (and their open subtasks if `closeSubtasks` is true)
2. Asks for a resolution once if the rule has no `resolution` configured and the target state is a closed state
3. Shows a review screen listing every ticket and the transition path it will follow

On the review screen, reply:

- **`ok`** — execute all transitions
- **`(c)`** or **`cancel`** — abort the entire run
- **ticket number(s)** — skip those tickets (e.g. `123` or `123 456`); skipping a subtask also skips its parent; skipping a parent also skips all its subtasks

Execution streams one confirmation line per ticket. Failures are reported at the end without stopping the rest of the batch.

---

## Bitbucket

### Prerequisites

- VS Code 1.90 or later with GitHub Copilot extension
- Bitbucket Data Center **or** Bitbucket Cloud

### Setup

#### 1. Set the auth type

Open VS Code settings and set:

```json
"ticketSidekick.bitbucket.authType": "datacenter"
```

Use `"cloud"` for Bitbucket Cloud. Default is `"datacenter"`.

#### 2. Set the base URL (Data Center only)

```json
"ticketSidekick.bitbucket.baseUrl": "https://bitbucket.mycompany.com"
```

Leave this unset for Bitbucket Cloud — the plugin connects to `api.bitbucket.org` automatically.

#### 3. Store your credentials

**Data Center:** Command Palette → `Ticket Sidekick: Set Bitbucket Personal Access Token`

**Cloud:** Command Palette → `Ticket Sidekick: Configure Bitbucket Cloud Credentials`

You will be prompted for an API token. Create one at `bitbucket.org → Personal settings → API tokens` with at minimum:

| Scope | Required for |
| --- | --- |
| Repositories: Read | Fetching file contents for review context |
| Pull requests: Read | PR metadata and diff |
| Account: Read | (optional) shows your username in `@bitbucket check` |

> **Note:** Bitbucket Cloud API tokens are different from Atlassian API tokens. The Atlassian API token (used for Jira Cloud) will not work here. As of September 2025, Bitbucket App Passwords have been replaced by scoped API tokens.

### Usage

Open GitHub Copilot Chat and use `@bitbucket`:

| What you type | What happens |
| --- | --- |
| `@bitbucket check` | Tests the connection and shows active configuration |
| `@bitbucket <PR URL>` | Fetches the PR and delivers a full code review |
| `@bitbucket #2` | Asks a follow-up question about finding #2 from the last review |
| `@bitbucket explain the SQL injection issue` | Natural language follow-up — resolves to the matching finding automatically |
| `@bitbucket can finding #3 be downgraded if X?` | Deeper explanation with conditions and concrete code suggestions |

### PR review

Paste any pull request URL into the chat:

```text
@bitbucket https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
```

Trailing segments like `/overview`, `/diff`, or `/commits` are stripped automatically.

The plugin:

1. Fetches PR metadata and the full unified diff
2. Reads changed files from your local workspace first; falls back to the Bitbucket API for files not present locally
3. Sends a structured prompt to the LLM for a first-pass review
4. If the LLM identifies files it needs for additional context, fetches up to 5 more files and re-analyses (two-pass review)
5. Streams a structured report organised by file, with numbered findings and severity badges

Example output:

```
## PR #42 — Add OAuth login flow
_by Jane Smith → main · 3 files changed_

2 🔴 critical · 1 🟡 warning · 3 🔵 suggestions

---

**📄 src/auth/login.ts**
**#1** 🔴 `L42` SQL injection — user input passed directly to query string
→ Use parameterised queries or an ORM query builder.

---

**📄 src/auth/tokenStore.ts**
**#2** 🔴 `L18` Token stored in localStorage — readable by any script on the page
→ Switch to httpOnly cookies with Secure flag.
**#3** 🔵 `L31` No encryption at rest for persisted token
→ Consider encrypting before writing to storage.

---

_Reply **#2** or describe a finding to ask a follow-up._
```

### Follow-up questions

After a review, the session stays active for multi-turn follow-ups. You can reference a finding by number or describe it in natural language:

```text
@bitbucket #2 is this always a problem or only if the site has third-party scripts?
@bitbucket can the localStorage finding be downgraded if we have a strict CSP?
@bitbucket explain the SQL injection issue in more detail
```

The plugin resolves natural language references by asking the LLM to match your question to the most relevant finding. Each follow-up response includes a deeper explanation, conditions under which the issue could be acceptable, and concrete code change suggestions.

Starting a new PR review clears the previous session automatically.

---

---

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
