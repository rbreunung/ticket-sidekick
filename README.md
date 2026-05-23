# Ticket Sidekick

Two independent GitHub Copilot Chat participants — use one or both:

- **`@jira`** — manage Jira tickets in natural language (create, read, update, comment, bulk transitions, create from email)
- **`@bitbucket`** — review Bitbucket pull requests with structured AI analysis and multi-turn follow-ups

Neither participant requires the other to be configured.

---

## @jira — Jira

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

### Core commands

Open GitHub Copilot Chat and use `@jira`:

| What you type | What happens |
| --- | --- |
| `@jira show PROJ-123` | Full ticket: all non-null fields in a metadata table, formatted description, one-line comment summaries |
| `@jira load PROJ-123` | Download full ticket context into `.jira-context/PROJ-123/` — `ticket.md`, `comments.md`, and attachments — so the AI can reason over them alongside your code |
| `@jira show fields on PROJ-123` | Table of every field: name, ID, and current value — use to discover IDs for `additionalDisplayFields` |
| `@jira summarize PROJ-123` | Same fields as `show`, but description + comments replaced by a one-paragraph AI synthesis |
| `@jira show comments` | Full formatted comment bodies numbered — use when you want to read the actual text |
| `@jira what do the comments say about the login bug?` | LLM synthesis filtered to a topic |
| `@jira create a bug: login times out` | Creates a new ticket (asks for project and type if missing) |
| `@jira create Story in VSJI: add dark mode` | Creates a ticket with project and type from the prompt |
| `@jira set priority to High` | Updates any field by name (exact or fuzzy-matched) on the current branch ticket |
| `@jira set labels to backend, urgent` | Replaces entire array field (comma-separated) |
| `@jira add frontend to labels` | Appends to an array field, deduplicates |
| `@jira remove backend from labels` | Removes items from an array field |
| `@jira set sprint to Sprint 4` | Sets sprint field — fuzzy-matched by name, resolved to sprint ID |
| `@jira set customfield_10500 to ASL QRF` | Updates any custom field by ID |
| `@jira assign this to jane.doe` | Assigns ticket (searches Jira by display name) |
| `@jira assign to me` | Assigns ticket to the currently logged-in user |
| `@jira update the description based on our conversation` | Generates a new description from context — shows preview before posting |
| `@jira comment that the fix is in PR #42` | Adds a comment |
| `@jira move to Done` | Transitions the current ticket to a target status |
| `@jira move to Cancelled with resolution "Not a Bug"` | Transitions and sets a resolution in one step |
| `@jira find open bugs assigned to me` | Runs JQL search |
| `@jira check required fields on PROJ-123` | Validates required fields |
| `@jira check` | Tests the connection and shows active configuration |
| `@jira create from email` | Create a Jira ticket from an Outlook email |

### Reading tickets

#### Show vs summarize

There are two distinct ways to read a ticket:

| Command | What you get |
| --- | --- |
| `@jira show PROJ-123` | All non-null fields in a metadata table, multi-line fields (description, rich-text custom fields) in their own sections, and numbered one-line comment summaries |
| `@jira summarize PROJ-123` | Same fields, but description and comments replaced by a one-paragraph AI synthesis |

And two ways to read comments:

| Command | What you get |
| --- | --- |
| `@jira show comments` | Full comment bodies numbered — Markdown-rendered, separated by dividers |
| `@jira what do comments say about X?` | AI synthesis filtered to the topic you named |

After seeing numbered comments you can always ask to view one in full:

```text
3
show comment 2
comment 4
```

If a ticket has more than 20 comments the response ends with an offer to load the rest:

```text
… 5 older comment(s) not shown. Reply "load all" to include them.
```

Reply **`load all`** to fetch up to 100 comments. For `show comments` the full bodies are rendered; for synthesised views the summary is regenerated over all comments.

#### Loading ticket context

`@jira load PROJ-123` downloads the complete ticket into `.jira-context/PROJ-123/` in your workspace root:

```
.jira-context/
  PROJ-123/
    ticket.md       ← all fields in the same layout as @jira show, plus an attachment index
    comments.md     ← every comment in full, chronological order
    attachments/
      screenshot.png
      error.log
      report.pdf
```

Once loaded, your AI assistant (GitHub Copilot, Cursor, etc.) can read these files directly during coding sessions — no additional prompting required.

| File type | Criterion | Action |
| --- | --- | --- |
| Text / source | `text/*` MIME type or known text extension | Downloaded |
| Images | `image/*` MIME type | Downloaded |
| Documents | `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf`, `.csv` | Downloaded |
| Archives | `.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.7z`, `.rar`, `.jar`, `.war`, `.ear` | Downloaded |
| Oversized | File larger than 100 MB | Skipped — listed in `ticket.md` with size |
| Unknown binary | Any other MIME type not covered above | Skipped — listed in `ticket.md` with size |

Up to three attachments are downloaded in parallel.

When a load completes with skipped attachments, the response shows a numbered list — reply with a number to download that file on demand.

`.jira-context/` is automatically added to `.gitignore` at your workspace root the first time you run `@jira load`.

#### Ticket detection

If you don't name a ticket, the plugin resolves it in this order:

1. Explicit key in your prompt (`PROJ-123`)
2. Current git branch — `feature/PROJ-123-my-work` → `PROJ-123`
3. Last ticket referenced earlier in the chat session
4. Input box — the plugin asks you

This means you can `@jira show PROJ-123`, then immediately follow up with `@jira add a comment: done` without repeating the key.

#### Descriptions and comments — rich formatting

Descriptions and comments are rendered as Markdown. Jira wiki markup (bold, italic, monospace, code blocks, bullet lists) and legacy ADF content are both converted automatically — no configuration required.

### Creating tickets

Running `@jira create` starts a guided flow:

1. **Template** — if `.jira-templates.json` is present, a numbered list is shown in chat. Pick by number, name, or reply **`n`** for no template. Reply **`c`** to cancel.
2. **Summary** — extracted from your prompt if provided; otherwise the plugin asks in chat. Providing the summary upfront is usually faster.
3. **Issue type** — taken from the template or your prompt. If neither provides one, the plugin shows a numbered list of issue types for the project.
4. **Description sections** — if the chosen template defines `descriptionSections`, the plugin asks each question in sequence, building the description incrementally.

**Examples:**

```text
@jira create a bug
```
→ Template list shown. After picking a template, the plugin asks "What should the **summary** be?"

```text
@jira create a bug: stale loans not returning after grace period
```
→ Template list shown. Summary is extracted from the prompt — no additional question.

```text
@jira create Story in VSJI: dark mode — assign to jane.doe, components Backend
```
→ Project key `VSJI`, issue type `Story`, summary, assignee, and components all parsed from the prompt.

You can include these directly in the create prompt and the plugin will extract them without asking:

| In your prompt | What it sets |
| --- | --- |
| `assign to me` / `assign to <name>` | Assignee (resolved via Jira user search) |
| `components Backend, API` | Components field |

### Field updates

`@jira set <field> to <value>` works for **any** editable Jira field — built-in fields, custom fields, and sprint.

**Field name matching** is fuzzy: the plugin tries an exact match first, then prefix, then substring. If multiple fields match, a numbered disambiguation list is shown. Use field IDs (e.g. `customfield_10500`) for an exact, unambiguous match.

**Array operations** let you add to or remove from multi-value fields without overwriting existing entries:

| What you type | Effect |
| --- | --- |
| `@jira set labels to backend, urgent` | Replace entire labels array |
| `@jira add frontend to labels` | Append `frontend`, deduplicate |
| `@jira remove backend from labels` | Remove `backend` from the array |

**Sprint fields** are resolved by fuzzy name match against active and future sprints in the project. If multiple sprints match, a numbered list is shown.

**Preview before writing:** every field update streams a confirm screen before writing. Reply **`ok`** to apply, **`(c)`** to cancel, or give an adjustment instruction.

**Scope:** if your last search returned multiple tickets, the plugin asks whether to apply to the current ticket or all N results from the search.

**Spell check on demand:** run `@jira spell check PROJ-123` to check and correct spelling and grammar on a ticket's description. The corrected version is shown as a preview before applying.

### Content generation and preview

When you ask `@jira` to write content rather than provide it directly — for a comment or a description update — the plugin generates a draft and shows it for review before posting:

```text
@jira write a comment summarizing what we agreed on
@jira update the description based on our conversation
@jira draft a comment from the last few messages
```

The draft is streamed to chat. You then reply:

- **`post it`** (or `yes`, `looks good`) — posts the content immediately
- **Any refinement instruction** — regenerates with your feedback applied, shows a new preview
- **`cancel`** (or `never mind`) — discards the draft without posting

If you provide explicit literal text the preview is skipped and the comment is posted directly:

```text
@jira comment: ready for QA, all tests passing
@jira add comment "approved"
```

The plugin infers which mode to use from your phrasing — `"write"`, `"draft"`, `"summarize"`, `"based on our discussion"`, and similar phrases trigger generation. Quoted text or direct statements post literally.

### Transitions and bulk cleanup

#### Transitioning a single ticket

Move a ticket to a target status by name:

```text
@jira move to Done
@jira close this
@jira transition PROJ-123 to In Review
@jira move to Cancelled with resolution "Not a Bug"
```

The plugin resolves the ticket from context (current prompt, git branch, or last referenced key). It then fetches the ticket's available transitions and finds the one whose destination matches the target name (case-insensitive).

If the target state requires multiple hops (e.g. Open → In Review → Done), the plugin falls back to the workflow cache automatically — no extra steps needed as long as you have run `@jira discover workflow` at least once for that project and issue type.

If no path is found, the response lists the directly reachable states from the current status.

**Resolution** — include `with resolution "<name>"` to set the resolution field on the final transition in one command.

#### Workflow discovery (required for bulk transitions)

Before running cleanup rules or bulk status transitions, teach the plugin your Jira workflow:

```text
@jira discover workflow BILLING Bug
```

This samples tickets across all statuses, queries their available transitions, and saves a workflow graph to `.jira-workflow-cache.json` at your workspace root. Re-run whenever your Jira workflow changes.

The plugin uses this graph to find the shortest transition path from each ticket's current status to the target state — for both single-ticket `move` commands and bulk cleanup runs.

> **Tip:** Commit `.jira-workflow-cache.json` to share it with your team so everyone benefits from a single discovery run.

#### Bulk cleanup

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

### Create ticket from Outlook email

```text
@jira create from email
```

**First run — folder picker:** A numbered list of your Outlook mail folders is shown. Reply with the number to select a folder. The choice is saved to VS Code settings (`ticketSidekick.outlook.folderId`) so you don't need to pick again. Clear the setting to re-run the picker.

**Email list:** A numbered list of recent emails from the configured folder. Reply with the number to select an email.

**Preview:** The email subject becomes the ticket summary, the body is converted to Markdown and shown as a preview. If templates are configured in `.jira-templates.json` or the project has multiple issue types, a numbered list is shown — reply with a number to pick a template or type, **post it** to create with the auto-selected type, or **(c)** to cancel.

**Attachments and inline images:** All attachments are uploaded to the created ticket. Inline images (cid: references) are placed as thumbnails in the description.

#### Authentication

`@jira create from email` connects to Microsoft Graph (Mail.Read) to read your Outlook inbox. Three authentication methods are available — choose based on your environment:

| Setting value | How it works | Use when |
| --- | --- | --- |
| `"vscode-microsoft"` *(default)* | VS Code built-in Microsoft sign-in | Personal Microsoft accounts or permissive tenants |
| `"azure-cli"` | Gets a token via Azure CLI (`az`) | Corporate Entra ID — `az` is installed and `az login` has been done |
| `"token"` | You provide a static bearer token | No `az` available; token expires in ~1 hour |

**Default — VS Code Microsoft sign-in:**
No configuration needed. On first use VS Code prompts for Microsoft account sign-in. If your corporate tenant blocks this (error `AADSTS65002`), switch to `azure-cli`.

**Azure CLI (recommended for corporate Entra ID):**

1. Install [Azure CLI](https://aka.ms/installazurecli)
2. Run `az login` in your terminal (one-time setup; `az` handles token refresh automatically)
3. Set in VS Code settings:
   ```json
   "ticketSidekick.outlook.authProvider": "azure-cli"
   ```

**Static token (last resort):**

1. Set `"ticketSidekick.outlook.authProvider": "token"` in VS Code settings
2. Go to [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer), sign in with your work account, and copy the **Access token** from the token panel
3. Run Command Palette (`Ctrl+Shift+P`) → `Ticket Sidekick: Set Outlook Access Token` and paste the token

> **Note:** Static tokens expire in ~1 hour. You will need to repeat step 2–3 each session.

#### Outlook settings

| Setting | Key | Default |
| --- | --- | --- |
| Auth provider | `ticketSidekick.outlook.authProvider` | `"vscode-microsoft"` |
| Folder ID | `ticketSidekick.outlook.folderId` | _(empty — shows picker on first use)_ |
| Email list size | `ticketSidekick.outlook.emailListSize` | `10` |

### Create ticket from Outlook email — OWA bridge (Tampermonkey)

Use this approach when the Microsoft Graph API is blocked by your corporate tenant.

**How it works:** A browser userscript captures the open email in OWA (subject, body,
inline images, attachments) and saves everything to a local handover folder. VS Code
reads the folder and opens the ticket creation preview automatically.

**One-time setup:**

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Microsoft Edge
   (Edge recommended — subdirectory download support confirmed on Chromium).
2. In VS Code settings, set:
   - `ticketSidekick.outlook.owaUrl` — your OWA URL
     (default: `https://outlook.office.com`; corporate: use your tenant URL; Hotmail/Outlook.com: use `https://outlook.live.com`)
   - `ticketSidekick.email.handoverFolder` — path where VS Code reads email files
     (default: `~/Downloads/`; must match Edge's configured downloads location)
   - `ticketSidekick.jira.defaultProject` — Jira project key for new tickets
3. Run **Command Palette → Ticket Sidekick: Export OWA Userscript for Tampermonkey**
4. Copy the generated script into Tampermonkey (New Script → paste → Save)

**Per-email workflow:**

1. Open an email in OWA
2. Click **📋 To Ticket** in the reading pane toolbar
   (or **📋✨ To Ticket (Clean)** to strip the corporate footer/signature via AI)
3. VS Code focuses automatically and shows a preview of the Jira ticket
4. Pick a number to apply a template or choose an issue type, reply **post it** to create with the auto-selected type, or **(c)** to cancel

Inline images are uploaded as Jira attachments and embedded as thumbnails at their
original position in the description. File attachments are uploaded to the ticket.
The local handover files are deleted automatically after the ticket is created.
Handover files older than 24 hours are cleaned up on the next use.

**Settings reference:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.outlook.owaUrl` | `https://outlook.office.com` | OWA base URL used when generating the userscript |
| `ticketSidekick.email.handoverFolder` | `~/Downloads/` | Folder VS Code reads email files from |
| `ticketSidekick.email.cleanupModel` | `gpt-5-mini` | VS Code LM model family for footer removal |

**Troubleshooting:**

- _VS Code says "timed out waiting for email.json"_ — the handover folder path in VS Code
  settings doesn't match where Edge saves downloads. Check `ticketSidekick.email.handoverFolder`.
- _VS Code says "Handover manifest version mismatch"_ — the installed Tampermonkey script is
  outdated. Re-export the userscript from VS Code and reinstall it in Tampermonkey.
- _Button doesn't appear in OWA_ — the userscript `@match` URL may not cover your OWA
  address. Re-export the script after correcting `ticketSidekick.outlook.owaUrl`.
- _OWA DOM changed after a Microsoft update_ — re-export and reinstall the userscript.

### Templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions.

```json
{
  "templates": [
    {
      "name": "Billing App Bug",
      "issueType": "Bug",
      "defaultFields": {
        "priority": { "name": "High" },
        "labels": ["billing"],
        "components": [{ "name": "Backend" }],
        "versions": [{ "name": "Release 3.2" }]
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

### Settings reference

| Setting | Key | Default |
| --- | --- | --- |
| Base URL | `ticketSidekick.jira.baseUrl` | _(required)_ |
| Auth type | `ticketSidekick.jira.authType` | `"datacenter"` |
| Default project | `ticketSidekick.jira.defaultProject` | _(empty)_ |
| Required fields | `ticketSidekick.jira.requiredFields` | `[]` |
| Always-show fields | `ticketSidekick.jira.additionalDisplayFields` | `[]` |
| Connection info banner | `ticketSidekick.jira.showConnectionInfo` | `false` |
| Outlook auth provider | `ticketSidekick.outlook.authProvider` | `"vscode-microsoft"` |
| Outlook folder ID | `ticketSidekick.outlook.folderId` | _(empty)_ |
| Outlook email list size | `ticketSidekick.outlook.emailListSize` | `10` |
| OWA userscript URL | `ticketSidekick.outlook.owaUrl` | `"https://outlook.office.com"` |
| OWA handover folder | `ticketSidekick.email.handoverFolder` | `~/Downloads/` |
| OWA cleanup model | `ticketSidekick.email.cleanupModel` | `"gpt-5-mini"` |

**Optional: default project**

```json
"ticketSidekick.jira.defaultProject": "PROJ"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

**Optional: required fields**

```json
"ticketSidekick.jira.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

**Optional: always-show fields**

By default `@jira show` omits fields that are null. Add field IDs to `additionalDisplayFields` to always show them (as `_Not set_` when empty). Run `@jira show fields on PROJ-123` to discover available field IDs.

```json
"ticketSidekick.jira.additionalDisplayFields": ["customfield_10020", "customfield_10500"]
```

**Optional: Jira connection info banner**

```json
"ticketSidekick.jira.showConnectionInfo": true
```

When enabled, every `@jira` response starts with an italic line showing the active base URL, API version, and auth type. Useful during initial setup or when switching between instances. Off by default.

---

## @bitbucket — Bitbucket PR Reviews

### Prerequisites

- VS Code 1.90 or later with GitHub Copilot extension
- Bitbucket Data Center **or** Bitbucket Cloud

### Setup

#### 1. Set the auth type

Open VS Code settings (`Ctrl+,` / `Cmd+,`) and add:

```json
"ticketSidekick.bitbucket.authType": "datacenter"
```

Use `"cloud"` for Bitbucket Cloud. Default is `"datacenter"`.

#### 2. Set the base URL (Data Center only)

```json
"ticketSidekick.bitbucket.baseUrl": "https://bitbucket.mycompany.com"
```

Leave this unset for Bitbucket Cloud — the plugin connects to `api.bitbucket.org` automatically.

#### 3. Store your Bitbucket credentials

**Data Center:** Command Palette (`Ctrl+Shift+P`) → `Ticket Sidekick: Set Bitbucket Personal Access Token`

Generate a Personal Access Token in Bitbucket Data Center at `Profile → Manage account → Personal access tokens`. Grant at minimum **Repositories: Read** and **Pull requests: Read** (add **Pull requests: Write** if you want to post findings as PR comments).

**Cloud:** Command Palette → `Ticket Sidekick: Configure Bitbucket Cloud Credentials`

You will be prompted for your Bitbucket **username** and an **App Password**. Create an App Password at `bitbucket.org → Personal settings → App passwords` with at minimum:

| Scope | Required for |
| --- | --- |
| Repositories: Read | Fetching file contents for review context |
| Pull requests: Read | PR metadata and diff |
| Pull requests: Write | Posting findings as PR comments (`add to review`) |
| Account: Read | (optional) shows your username in `@bitbucket check` |

> **Note:** Bitbucket App Passwords use `Authorization: Basic` — they are not the same as Atlassian API tokens (used for Jira Cloud). Using an Atlassian API token here will fail with 401.

Run `@bitbucket check` after setup to confirm the connection and see which account is active.

### PR review

Paste any pull request URL into the chat:

```text
@bitbucket https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
@bitbucket https://bitbucket.org/myworkspace/myrepo/pull-requests/7
```

Trailing segments like `/overview`, `/diff`, or `/commits` are stripped automatically.

The plugin:

1. Fetches PR metadata and the full unified diff
2. Splits the changed files into batches of 10 so each LLM call stays within context limits — large PRs are reviewed completely rather than truncated
3. For each batch: sends a structured diff-only prompt and, if the LLM requests additional context files, fetches up to 5 and re-analyses (two-pass review per batch)
4. Merges all findings across batches and streams a single structured report ordered by file, with numbered findings and severity badges

Example output:

```text
## PR #42 — Add OAuth login flow
_by Jane Smith → main · 3 files changed_

2 🔴 critical · 1 🟡 warning · 3 🔵 suggestions

---

**📄 src/auth/login.ts**
**#1** 🔴 `L42` SQL injection — user input concatenated into query string
→ Use parameterised queries or a query builder instead.
```

### Follow-ups and posting comments

After a review, the session stays active for multi-turn follow-ups. Reference a finding by number or describe it in natural language:

```text
@bitbucket #2 is this always a problem or only if the site has third-party scripts?
@bitbucket can the localStorage finding be downgraded if we enforce a strict CSP?
@bitbucket explain the SQL injection issue and show a fixed version
```

Push selected findings back to Bitbucket as PR comments:

```text
@bitbucket #2 #3, #5 add to review
@bitbucket #1 add to review this is blocking merge
```

Any text after the `add to review` keywords becomes a brief reviewer note appended to each comment. When a finding has a line number the comment is anchored inline on that diff line; otherwise it appears in the PR activity feed.

> **Note (Bitbucket Cloud):** Posting comments requires the **Pull requests: Write** scope on your App Password. See the setup section above.

### Settings reference

| Setting | Key | Default |
| --- | --- | --- |
| Auth type | `ticketSidekick.bitbucket.authType` | `"datacenter"` |
| Base URL (DC only) | `ticketSidekick.bitbucket.baseUrl` | _(empty)_ |
| Connection info banner | `ticketSidekick.bitbucket.showConnectionInfo` | `false` |
| Review instructions | `ticketSidekick.bitbucket.reviewInstructions` | _(empty)_ |

**Optional: Bitbucket connection info banner**

```json
"ticketSidekick.bitbucket.showConnectionInfo": true
```

When enabled, every `@bitbucket` response (except `check`) starts with an italic line showing the active base URL, API version, and auth type. Off by default.

**Optional: custom review instructions**

```json
"ticketSidekick.bitbucket.reviewInstructions": "This project follows Google Style Guide. Focus on security issues and ignore minor style suggestions."
```

Additional instructions appended to the built-in PR review prompt. Use this to add project-specific guidance the model should apply on every review.

**Using a local model:** `@bitbucket` works with any model available in GitHub Copilot Chat, including local models via [Ollama](https://ollama.com). Use a model with at least 16k context (32k+ recommended for large PRs).

---

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
