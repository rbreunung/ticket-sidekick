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

### Generalised field updates

`@jira set <field> to <value>` works for **any** editable Jira field — built-in fields,
custom fields, and sprint.

**Field name matching** is fuzzy: the plugin tries an exact match first, then prefix, then
substring. If multiple fields match, a numbered disambiguation list is shown. Use field
IDs (e.g. `customfield_10500`) for an exact, unambiguous match.

**Array operations** let you add to or remove from multi-value fields without overwriting
existing entries:

| What you type | Effect |
| --- | --- |
| `@jira set labels to backend, urgent` | Replace entire labels array |
| `@jira add frontend to labels` | Append `frontend`, deduplicate |
| `@jira remove backend from labels` | Remove `backend` from the array |

**Sprint fields** are resolved by fuzzy name match against active and future sprints in the
project. If multiple sprints match, a numbered list is shown.

**Preview before writing:** every field update streams a confirm screen before writing.
Reply **`ok`** to apply, **`(c)`** to cancel, or give an adjustment instruction.

**Scope:** if your last search returned multiple tickets, the plugin asks whether to apply
to the current ticket or all N results from the search.

**Spell check on demand:** run `@jira spell check PROJ-123` to check and correct spelling and grammar on a ticket's description. The corrected version is shown as a preview before applying.

### Ticket creation

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
@jira create a ticket stale loans not returning - assign to me
```
→ Template list shown. Summary and assignee extracted from the prompt in one step.

```text
@jira create Story in VSJI: dark mode — assign to jane.doe, components Backend
```
→ Project key `VSJI`, issue type `Story`, summary, assignee, and components all parsed from the prompt.

You can include these directly in the create prompt and the plugin will extract them without asking:

| In your prompt | What it sets |
| --- | --- |
| `assign to me` / `assign to <name>` | Assignee (resolved via Jira user search) |
| `components Backend, API` | Components field |

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

### Descriptions and comments — rich formatting

Descriptions and comments are rendered as Markdown. Jira wiki markup (bold, italic, monospace, code blocks, bullet lists) and legacy ADF content are both converted automatically — no configuration required.

### Show vs summarize

There are two distinct ways to read a ticket:

| Command | What you get |
| --- | --- |
| `@jira show PROJ-123` | All non-null fields in a metadata table, multi-line fields (description, rich-text custom fields) in their own sections, and numbered one-line comment summaries |
| `@jira summarize PROJ-123` | Same fields, but description and comments replaced by a one-paragraph AI synthesis |

`@jira show` previously displayed seven hardcoded fields. It now renders every
non-null field returned by Jira — custom fields, dates, sprint, attachments, and
any other metadata the ticket carries.

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

Reply **`load all`** to fetch up to 100 comments. For `show comments` the full bodies are rendered; for synthesized views the summary is regenerated over all comments.

### Loading ticket context

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

#### What gets downloaded

| File type | Criterion | Action |
| --- | --- | --- |
| Text / source | `text/*` MIME type or known text extension | Downloaded |
| Images | `image/*` MIME type | Downloaded |
| Documents | `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf`, `.csv` | Downloaded |
| Archives | `.zip`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.7z`, `.rar`, `.jar`, `.war`, `.ear` | Downloaded |
| Oversized | File larger than 100 MB | Skipped — listed in `ticket.md` with size |
| Unknown binary | Any other MIME type not covered above | Skipped — listed in `ticket.md` with size |

Up to three attachments are downloaded in parallel.

#### Downloading skipped attachments on demand

When a load completes with skipped attachments, the response shows a numbered list:

```text
Skipped attachments:

1. `heap-dump.bin` — 120.0 MB (application/octet-stream) — over 100 MB size limit
2. `mystery.xyz` — 4 KB (application/xyz) — unknown binary format

Reply with a number to download it anyway.
```

Reply with a number (`1`, `2`, …) and the plugin downloads that file into `attachments/`. If more remain, the list is shown again with updated numbers. You can download them one at a time until all are saved.

#### Inline attachment links

Any attachment references in the description or comments (Jira wiki markup `!filename!` or `[^filename]`) are rewritten in the generated Markdown files to point to the local `attachments/` path for downloaded files, and to the original Jira URL for skipped ones.

#### gitignore

`.jira-context/` is automatically added to `.gitignore` at your workspace root the first time you run `@jira load`. The folder is local to your machine — do not commit it.

### Ticket detection

If you don't name a ticket, the plugin resolves it in this order:

1. Explicit key in your prompt (`PROJ-123`)
2. Current git branch — `feature/PROJ-123-my-work` → `PROJ-123`
3. Last ticket referenced earlier in the chat session
4. Input box — the plugin asks you

This means you can `@jira show PROJ-123`, then immediately follow up with `@jira add a comment: done` without repeating the key.

### Optional: default project

```json
"ticketSidekick.jira.defaultProject": "PROJ"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

### Optional: required fields

```json
"ticketSidekick.jira.requiredFields": ["assignee", "priority", "fixVersions"]
```

Used by the `check required fields` command.

### Optional: always-show fields

By default `@jira show` omits fields that are null. Add field IDs to
`additionalDisplayFields` to always show them (as `_Not set_` when empty). Run
`@jira show fields on PROJ-123` to discover available field IDs.

```json
"ticketSidekick.jira.additionalDisplayFields": ["customfield_10020", "customfield_10500"]
```

### Optional: Jira connection info banner

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

### Transitioning a single ticket

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

### Workflow discovery (required for bulk transitions)

Before running cleanup rules or bulk status transitions, teach the plugin your Jira workflow:

```text
@jira discover workflow BILLING Bug
```

This samples tickets across all statuses, queries their available transitions, and saves a workflow graph to `.jira-workflow-cache.json` at your workspace root. Re-run whenever your Jira workflow changes.

The plugin uses this graph to find the shortest transition path from each ticket's current status to the target state — for both single-ticket `move` commands and bulk cleanup runs.

**Cache preservation:** if a status has no tickets at discovery time, the plugin keeps its previously cached transitions rather than dropping them. Only statuses with no tickets *and* no prior cache entry are marked as unsampled.

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

### Bitbucket prerequisites

- VS Code 1.90 or later with GitHub Copilot extension
- Bitbucket Data Center **or** Bitbucket Cloud

### Bitbucket setup

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

### Bitbucket usage

Open GitHub Copilot Chat and use `@bitbucket`:

| What you type | What happens |
| --- | --- |
| `@bitbucket check` | Tests the connection and shows active configuration |
| `@bitbucket <PR URL>` | Fetches the PR and delivers a full code review |
| `@bitbucket #2` | Follow-up question about finding #2 from the last review |
| `@bitbucket explain the SQL injection issue` | Natural language follow-up — resolves to the matching finding automatically |
| `@bitbucket can finding #3 be downgraded if X?` | Deeper explanation with conditions and concrete code suggestions |
| `@bitbucket #2 #3, #5 add to review` | Post selected findings as PR comments (inline on the diff line when available) |
| `@bitbucket #1 add to review this blocks merge` | Post finding #1 as a comment; the trailing text becomes a reviewer note |

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

The chat shows progress for large PRs:

```text
Fetching PR…
Analysing files 1–10 of 33 · batch 1/4…
Analysing files 11–20 of 33 · batch 2/4…
Analysing files 21–30 of 33 · batch 3/4…
Analysing files 31–33 of 33 · batch 4/4…
```

Example output:

```text
## PR #42 — Add OAuth login flow
_by Jane Smith → main · 3 files changed_

2 🔴 critical · 1 🟡 warning · 3 🔵 suggestions

---

**📄 src/auth/login.ts**
**#1** 🔴 `L42` SQL injection — user input concatenated into query string
→ Use parameterised queries or a query builder instead.

---

**📄 src/auth/tokenStore.ts**
**#2** 🔴 `L18` Token stored in localStorage — readable by any same-origin script
→ Switch to an httpOnly cookie with the Secure flag.
**#3** 🔵 `L31` No encryption at rest for the persisted token
→ Consider encrypting before writing to storage.

---

_Reply **#1** or describe a finding to ask a follow-up. To post findings as PR comments: **#2 #3 add to review**._
```

### Follow-up questions

After a review, the session stays active for multi-turn follow-ups. Reference a finding by number or describe it in natural language:

```text
@bitbucket #2 is this always a problem or only if the site has third-party scripts?
@bitbucket can the localStorage finding be downgraded if we enforce a strict CSP?
@bitbucket explain the SQL injection issue and show a fixed version
```

The plugin resolves natural language references by asking the LLM to match your question to the most relevant finding. Each follow-up response includes a deeper explanation, the conditions under which the issue could be acceptable, and concrete code change suggestions.

### Posting findings as PR comments

After a review, you can push selected findings back to Bitbucket as PR comments:

```text
@bitbucket #2 #3, #5 add to review
@bitbucket #1 add to review this is blocking merge
```

Any text after the `add to review` keywords becomes a brief reviewer note appended to each comment. When a finding has a line number the comment is anchored inline on that diff line; otherwise it appears in the PR activity feed. If the LLM produced a short code fix example for the finding, it is included with language-appropriate code formatting.

The session remains active after posting — you can still ask follow-up questions about findings you did not post.

> **Note (Bitbucket Cloud):** Posting comments requires the **Pull requests: Write** scope on your App Password in addition to the Read scope needed for reviews. See the setup section above.

Starting a new PR review clears the previous session automatically.

### Using a local model

The `@bitbucket` participant works with any model available in GitHub Copilot Chat, including local models via tools such as [Ollama](https://ollama.com). To get reliable results from smaller models:

- Use a model with **at least 16k context** (32k+ recommended for PRs with large diffs)
- Models quantised to Q4 or higher produce better JSON compliance than Q2/Q3
- If a review fails with a JSON error, the error message shows the raw model output — use it to decide whether to retry or switch to a larger model

The batch size is currently fixed at 10 files per LLM call. If your local model has a smaller context window and individual diffs are large, you can reduce this by changing the `CHUNK_SIZE` constant near the top of `src/participant/BitbucketParticipant.ts`.

### Optional: Bitbucket connection info banner

```json
"ticketSidekick.bitbucket.showConnectionInfo": true
```

When enabled, every `@bitbucket` response (except `check`) starts with an italic line showing the active base URL, API version, and auth type. Off by default.

### Optional: custom review instructions

```json
"ticketSidekick.bitbucket.reviewInstructions": "This project follows Google Style Guide. Focus on security issues and ignore minor style suggestions."
```

Additional instructions appended to the built-in PR review prompt. Use this to add project-specific guidance the model should apply on every review. The built-in grounding rules and JSON output format are always included — this setting only adds to them.

Examples:

```text
"Focus on security vulnerabilities only, ignore style and naming."
"This is a Python Django project — flag missing input validation on views."
"Treat all SQL strings as potential injection vectors regardless of the ORM used."
```

---

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
