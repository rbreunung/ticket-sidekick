# Ticket Sidekick

[![CI](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml/badge.svg)](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml)

Two independent GitHub Copilot Chat participants — use one or both:

- **`@jira`** — manage Jira tickets in natural language (create, read, update, comment, bulk transitions, create from email)
- **`@bitbucket`** — review Bitbucket pull requests with structured AI analysis and multi-turn follow-ups

Neither participant requires the other to be configured.

Every core operation is also exposed as a GitHub Copilot **Agent Mode** tool (`jira_*`, `bitbucket_*`), so an agent can create tickets, update fields, review PRs, and more without the user typing `@jira`/`@bitbucket` at all — see [`docs/onboarding.md`](docs/onboarding.md) for the full tool list and how confirmation works.

---

## @jira — Jira

### Quickstart

1. Set `ticketSidekick.jira.baseUrl` in VS Code settings — Cloud: `https://your-org.atlassian.net`, Data Center: your instance URL
2. Cloud only: also set `ticketSidekick.jira.authType` to `"cloud"` (Data Center is the default, no extra setting needed)
3. Command Palette → `Ticket Sidekick: Set Jira Personal Access Token` (Data Center) or `Ticket Sidekick: Configure Jira Cloud Credentials` (Cloud)

Then open Copilot Chat and try `@jira check` to confirm the connection, or `@jira show PROJ-123` to read a ticket. Full setup details and every command are below.

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
| `@jira create a bug: login times out` | Resolves template and type, then shows a preview — reply **"create it"** to confirm |
| `@jira create Story in VSJI: add dark mode` | Creates a ticket with project and type from the prompt — shows preview before creating |
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
| `@jira check` | Validates the base URL, tests the connection, and shows active configuration |
| `@jira create from email` | Create a Jira ticket from an imported `.eml` file |
| `@jira import veracode report` | Create Jira tickets from a Veracode Detailed Report XML export |
| `@jira generate a template from PROJ-123 called "Billing Bug"` | Generate a reusable `.jira-templates.json` template from a reference ticket's fields — reviewed and confirmed before saving |
| `@jira upload the report to PROJ-123` | Attach one or more local files to a ticket — shows a confirmation before uploading |

### Reading tickets

#### Show vs summarize

There are two distinct ways to read a ticket:

| Command | What you get |
| --- | --- |
| `@jira show PROJ-123` | All non-null fields in a metadata table, multi-line fields (description, rich-text custom fields) in their own sections, numbered one-line comment summaries, linked issues, and web links |
| `@jira summarize PROJ-123` | Same fields, but description and comments replaced by a one-paragraph AI synthesis |

The ticket key in the heading is a clickable link to the ticket in your browser. Search results (`@jira find …`) also produce clickable keys in the results table.

`@jira show` appends two additional sections when data is present:

- **Linked Issues** — every issue link (`blocks`, `is blocked by`, `relates to`, etc.) with linked ticket key, summary, and status
- **Web Links** — remote links attached to the ticket (Confluence pages, external documents, etc.)

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
    ticket.md       ← all fields in the same layout as @jira show, plus linked issues, web links, and attachment index
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

When a load completes with skipped attachments, the response shows a numbered list. To download on demand:

```text
1              ← download attachment #1
download 1     ← same
1 2 3          ← download attachments #1, #2, and #3 in one reply
download 1 3   ← same, with keyword prefix
```

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
5. **Preview** — a full ticket card is shown: summary, issue type, project, template (if any), and description. Reply **"create it"** (or `yes`, `ok`, `confirm`) to create the ticket. Reply with a refinement instruction to adjust the description and see a new preview. Reply **`c`** to cancel.

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

When you ask `@jira` to write content — for a new ticket, a comment, or a description update — the plugin shows a preview before posting:

```text
@jira create a bug: login times out after entering password
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

### Uploading attachments

Attach one or more local files to a ticket directly from chat:

```text
@jira upload the report to PROJ-123
@jira upload screenshot.png
```

The file is resolved in this order:

1. An explicit path in your prompt (workspace-relative or absolute)
2. A file attached to the chat message (all attachments, if you attach more than one)
3. Your active editor's file
4. A multi-select file picker, if none of the above apply

The ticket is resolved the same way as everywhere else: a key in your prompt, then a key embedded in the filename, then the last ticket referenced in the session — if none of those match, the plugin asks which ticket before continuing.

Before anything uploads, a confirmation lists every file (name, size, full source path) and the target ticket:

```text
Upload the following to PROJ-123?

- **report.pdf** (2.1 MB) — `/Users/jane/Downloads/report.pdf`

Confirm · Cancel
```

Reply **"confirm"** to upload, **"cancel"** to discard. Each file reports its own success or failure — one failed upload in a batch doesn't stop the rest. Files over the 25 MB limit are rejected up front with a clear message and nothing is uploaded.

For security, an explicit path you type must resolve inside your home directory and may not pass through a dotfile or dot-directory segment (e.g. `~/.ssh`, `~/.aws`) — files attached via the chat picker or your active editor aren't affected by this restriction.

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

More examples:

```text
@jira close BILLING bugs with resolution Fixed
@jira run cleanup "Close released bugs" with resolution "Won't Fix"
@jira run cleanup "Close released bugs" in released
@jira run cleanup "Close released bugs" in "Release*"
```

The plugin:

1. Builds the effective JQL and shows it as a **scope preview** (including ticket count) before executing
2. Searches for tickets matching the scope — tickets that already have a resolution set are automatically excluded
3. If `closeSubtasks` is true, fetches all open subtasks in a single query (also excluding pre-resolved ones)
4. Asks for a resolution once if neither the rule nor your prompt provides one and the target state is a closed state
5. Shows a review screen listing every ticket and subtask, the transition path each will follow, and the resolution that will be applied

On the review screen, reply:

- **`ok`** — execute all transitions
- **`(c)`** or **`cancel`** — abort the entire run
- **ticket number(s)** — skip those tickets (e.g. `123` or `123 456`); skipping a subtask also skips its parent; skipping a parent also skips all its subtasks

Execution streams one confirmation line per ticket. Failures are reported at the end without stopping the rest of the batch.

### Report imports (email, Veracode, Waltz)

Turn a `.eml` email, a Veracode Detailed Report, or a Waltz OSS Report into Jira tickets — creating a new ticket, or adding an email as a comment to an existing one. See [Report Imports](docs/manual/report-imports.md) for the full walkthrough and settings.

### Templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions. See [Jira Templates and Cleanup Rules](docs/manual/jira-templates-and-cleanup-rules.md) for how to generate one from an existing ticket, field references, and examples.

### Settings reference

See [Settings Reference → Jira](docs/manual/settings-reference.md#jira-settings-reference) for every `ticketSidekick.jira.*` / `ticketSidekick.email.*` / `ticketSidekick.veracode.*` setting (Waltz settings are documented alongside the OSS report import in [Report Imports](docs/manual/report-imports.md)).

---

## @bitbucket — Bitbucket PR Reviews

### Quickstart

1. Set `ticketSidekick.bitbucket.authType` to `"datacenter"` (default) or `"cloud"`
2. Data Center only: also set `ticketSidekick.bitbucket.baseUrl` (Cloud talks to `api.bitbucket.org` automatically — leave unset)
3. Command Palette → `Ticket Sidekick: Set Bitbucket Personal Access Token` (Data Center) or `Ticket Sidekick: Configure Bitbucket Cloud Credentials` (Cloud)

Then open Copilot Chat and run `@bitbucket check` to confirm the connection, or paste a PR URL to start a review. Full setup details and every command are below.

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

### Core commands

| What you type | What happens |
| --- | --- |
| `@bitbucket check` | Test connection and show active configuration |
| `@bitbucket <pr-url>` | Full structured review of the PR |
| `@bitbucket review quick <pr-url>` | Review using diffs only — no second-pass file fetch (fewer tokens) |
| `@bitbucket review deep <pr-url>` | Force standard two-pass review regardless of default setting |
| `@bitbucket <pr-url> question: <text>` (or `-- <text>`) | Review with an upfront focus question — nudges the model toward that concern in every pass |
| `@bitbucket #2` | Explain finding #2 in detail |
| `@bitbucket #2 is this always a problem?` | Ask a follow-up question about a specific finding |
| `@bitbucket is the change backwards-compatible?` | Ask any general question about the PR — no finding reference needed |
| `@bitbucket #1 #3 add to review` | Preview findings #1 and #3 as comments — reply "post it" to confirm, "(c)" to cancel, or refine |
| `@bitbucket add #1 #2 #3 to review` | Same — numbers can appear anywhere relative to the keywords |
| `@bitbucket add all to review` | Preview all findings as PR comments at once |
| `@bitbucket #2 add to review blocking merge` | Preview with reviewer note "blocking merge" appended — confirm before posting |
| `@bitbucket c` | Exit the current review session |

### PR review

Paste any pull request URL into the chat to get a structured, multi-pass review — with an optional upfront focus question, multi-turn follow-ups, and the ability to post selected findings back to Bitbucket as PR comments. See [Bitbucket PR Review](docs/manual/bitbucket-pr-review.md) for the full walkthrough, including token-usage tuning for large PRs.

### Settings reference

See [Settings Reference → Bitbucket](docs/manual/settings-reference.md#bitbucket-settings-reference) for every `ticketSidekick.bitbucket.*` setting.

---

## Troubleshooting

Both `@jira` and `@bitbucket` log diagnostic detail beyond what's shown in
chat to a shared VS Code output channel: **View → Output → "Ticket
Sidekick"**.

For `@bitbucket` reviews specifically, this includes: the model in use
(vendor/family/id/version) for the review, every LLM call that failed
(including ones that succeeded on a retry), the call site and which files
or findings were in that attempt, and the raw error. If a review or
follow-up ever shows a failure message, check this channel first — it
usually explains whether it was a one-off provider hiccup (worth just
retrying) or something more persistent.

## Releasing

Releases are cut by a manually-triggered GitHub Actions workflow (`.github/workflows/release.yml`) — you no longer hand-edit `package.json`. Go to **Actions → Release → Run workflow** and fill in the form:

- **channel** — `release` or `preview`.
- **bump** — `patch` / `minor` / `major`. The workflow runs `npm version <bump>` to compute the new version.
- **version** — optional explicit version (e.g. `0.4.0`) that **overrides** the bump when set.

Both channels do the same thing with that version — they just differ by the pre-release flag:

- The workflow **commits the version bump back to the branch** (commit titled with the bare version, matching the existing convention), creates the GitHub Release + bare tag `X.Y.Z` (auto-generated notes, `.vsix` attached), and publishes to the VS Code Marketplace.
- **release** publishes a normal release; **preview** publishes with `--pre-release` (and marks the GitHub Release as a pre-release) for sideloading/dogfooding.
- A **release**-channel run also captures those generated notes before packaging, strips the "by @author in #PR" attribution, and prepends the result to `CHANGELOG.md` (committed in the same bump commit) — so the version's entry ships inside that release's own `.vsix` and shows up in VS Code's Extensions view Changelog tab. **preview** runs never touch `CHANGELOG.md`. `scripts/backfill-changelog.mjs` seeded the file once with every prior stable release's notes and stays in the repo as a re-runnable regenerator.

Because every run advances and commits the version, the published version line is **strictly increasing** — a version is never reused, so the Marketplace's "no duplicate version" rule can never bite and you never have to bump by hand. (The Marketplace versions must be plain `x.y.z`; the `--pre-release` _flag_ — not a `-preview` suffix — is what marks a pre-release.) The workflow runs `npm ci → compile → test` first and will not publish a red build.

> **Branch protection:** every run pushes the bump commit to the target branch (usually `main`) using the built-in `GITHUB_TOKEN`. If `main` is protected against direct pushes, either allow the Actions bot to bypass it or run the workflow from a release branch.

**Prerequisite:** add a repository secret **`VSCE_PAT`** — an Azure DevOps Personal Access Token for the `RobertBreunung` publisher with **Marketplace → Manage** scope (Settings → Secrets and variables → Actions). Without it the Marketplace step fails; the `.vsix` is still attached to the GitHub Release.

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
