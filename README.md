# Ticket Sidekick

[![CI](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml/badge.svg)](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml)

Jira and Bitbucket inside GitHub Copilot Chat in VS Code:

- **Jira tools for Copilot** — Copilot's agent views, finds, creates, comments on, moves and updates Jira tickets through Ticket Sidekick's tools, or you type a command such as `/ts-jira view PROJ-123`
- **Boards** — ticket lists and the security report open in an editor tab, where you select, preview and apply changes; a board comes back after a restart
- **`@jira` and `@bitbucket` chat participants (deprecated)** — `@jira` now only runs the report imports (emails, Veracode, Waltz), and `@bitbucket` the pull request reviews

> **Deprecation notice.** The `@jira` and `@bitbucket` chat participants are deprecated. `@jira` keeps only the report imports; every other Jira task is done with the Copilot tools, `/ts-jira` commands and boards. Both participants will be removed once the imports and the pull request review have moved to boards. Start with [Copilot tools and boards](#copilot-tools-and-boards).

---

## Copilot tools and boards

This is the current way to use Ticket Sidekick. Set up the Jira connection first ([Setup](#setup) below: base URL and token); nothing else is needed.

### Jira tools

In a Copilot chat in **Agent** mode, ask in your own words ("show me PROJ-123", "add a comment to PROJ-123 saying the fix is deployed") and Copilot calls Ticket Sidekick's Jira tools. They view, find, load, move, create, comment on and update Jira tickets, upload attachments, list filters, fields, workflows and templates, and check the connection. A tool that changes something asks first and shows exactly what it will write.

Five skills sit on top of the tools: `/ts-jira <command>` runs one Jira command you type, e.g. `/ts-jira load PROJ-123` (`/ts-jira help` lists them), `/ts-jira-brief` writes a developer brief of a ticket, `/ts-jira-create` creates a ticket with you, from a template where one fits, `/ts-jira-spell-check` corrects the spelling of a ticket's description, and `/ts-jira-template` saves a new template built from a ticket.

See [Jira Tools for Copilot Chats](docs/manual/copilot-tools.md) for every tool and its inputs, the skills, approvals, troubleshooting and a checklist to try it out. The Bitbucket tools (`bitbucket_*`) are listed in [Agent Mode Tools](docs/manual/agent-mode-tools.md).

### Boards

Larger views open as a **board** in their own editor tab. The security report opens with "the security report for PROJ", `/ts-jira security-report PROJ` or `Ticket Sidekick: Open security report`. A ticket list opens when you ask Copilot to see tickets or to change several of them, with `/ts-jira search <JQL or filter>` or `Ticket Sidekick: Open ticket list`: you select tickets there and move them or set a field after a preview. A cleanup rule from `.jira-templates.json` opens the same board with "run the cleanup Close released bugs", `/ts-jira cleanup <rule> [in VERSION]` or `Ticket Sidekick: Run a cleanup rule`. A board keeps its work in progress as a stored session, so it comes back after a restart; `/ts-jira sessions` or `Ticket Sidekick: Open stored sessions` lists the stored sessions and `Ticket Sidekick: Clear stored sessions` deletes them all. The Command Palette commands work without Copilot. See [Boards](docs/manual/boards.md).

---

## Jira setup

The Jira tools, the boards and the `@jira` imports share this setup.

### Quickstart

1. Set `ticketSidekick.jira.baseUrl` in VS Code settings — Cloud: `https://your-org.atlassian.net`, Data Center: your instance URL
2. Cloud only: also set `ticketSidekick.jira.authType` to `"cloud"` (Data Center is the default, no extra setting needed)
3. Command Palette → `Ticket Sidekick: Set Jira Personal Access Token` (Data Center) or `Ticket Sidekick: Configure Jira Cloud Credentials` (Cloud)

Then type `/ts-jira check` in a Copilot chat to confirm the connection, or ask "show me PROJ-123" in Agent mode to read a ticket.

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

### Good to know

- **Ticket from the branch.** When you name no ticket, viewing and loading use the ticket in the current git branch name: `feature/PROJ-123-my-work` → `PROJ-123`.
- **Workflow cache.** Moves and cleanups follow your Jira workflow. Ticket Sidekick discovers a project's workflow once per issue type when it needs it and keeps it in `.jira-workflow-cache.json` at your workspace root; `/ts-jira workflow <KEY>` shows the statuses a ticket can reach. Commit the file to share it with your team.
- **Formatting.** Descriptions and comments are shown as Markdown; Jira wiki markup and older ADF content are converted automatically.

---

## @jira — report imports (deprecated)

`@jira` now only runs the report imports below. Type `@jira help` (or just `@jira`) for its commands with the extension version; inside a Veracode, Waltz or email import, `help` lists the commands of the screen you are on. Any other request to `@jira` answers with a pointer to `/ts-jira` and Agent mode, where viewing, creating, commenting, moving and searching tickets, cleanup rules and the security report work now.

### Report imports (email, Veracode, Waltz)

Turn a `.eml` email, a Veracode Detailed Report, or a Waltz OSS Report into Jira tickets — creating a new ticket, or adding an email as a comment to an existing one. For OSS reports the tickets also show the remediation dates and carry the Jira Due Date, a newer report refreshes existing tickets with `rewrite` or `new ticket`, and you can reload the report after changing the accepted list. Both Veracode and OSS imports can merge tickets (`merge A5 into A3`): the Already ticketed screen names another open ticket for the same item (`PROJ-1 · also open: PROJ-2`) and closed tickets no longer inflate the count. Veracode tickets get their Jira Due Date from a per-severity day table in the `ticketSidekick.veracode.slaDays` setting; it is set once and never overwritten by a later import. See [Report Imports](docs/manual/report-imports.md) for the full walkthrough and settings.

### Templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions. See [Jira Templates and Cleanup Rules](docs/manual/jira-templates-and-cleanup-rules.md) for how to generate one from an existing ticket, field references, and examples.

### Settings reference

See [Settings Reference → Jira](docs/manual/settings-reference.md#jira-settings-reference) for every `ticketSidekick.jira.*` setting, and [Report import settings](docs/manual/settings-reference.md#report-import-settings) for every `ticketSidekick.email.*` / `ticketSidekick.veracode.*` / `ticketSidekick.waltz.*` setting.

---

## @bitbucket — Bitbucket PR Reviews

> **Deprecated.** `@bitbucket` is being replaced by Copilot tools and a review board. Until the review board exists, it remains the way to run a pull request review.

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
| `@bitbucket usage` | Show input and output tokens per model for the current month and the two before it |
| `@bitbucket <pr-url>` | Full structured review of the PR |
| `@bitbucket review quick <pr-url>` | Review using diffs only — no second-pass file fetch (fewer tokens) |
| `@bitbucket review deep <pr-url>` | Force standard two-pass review regardless of default setting |
| `@bitbucket <pr-url> question: <text>` (or `-- <text>`, or just a sentence ending in `?`) | Review with an upfront focus question — nudges the model toward that concern in every pass |
| `@bitbucket review smart <pr-url> PROJ-123` | Check the PR against Jira ticket PROJ-123 (smart and deep only): a **Requirements coverage** block appears above the findings. If the PR title names a ticket and you don't, the review asks first |
| `@bitbucket review smart <pr-url> no ticket` | Skip the ticket for this review |
| `@bitbucket #2` | Explain finding #2 in detail |
| `@bitbucket #2 is this always a problem?` | Ask a follow-up question about a specific finding |
| `@bitbucket is the change backwards-compatible?` | Ask any general question about the PR — no finding reference needed |
| `@bitbucket copy` (or the **Copy for Teams** chip) | Copy the review to the clipboard as plain text, grouped by severity, ready to paste into a Teams chat |
| `@bitbucket copy #1 #3` | Copy only findings #1 and #3 (without the requirements coverage) |
| `@bitbucket the goal is actually <text>` | After a ticket check, redo the requirements coverage against your own statement of the goal; the findings stay as they are |
| `@bitbucket done` (or the **Done** chip) | End the review session. `c` and `cancel` work too; a new PR URL or any `@jira` request also ends it |
| `@bitbucket #1 #3 add to review` | Preview findings #1 and #3 as comments — reply "post it" to confirm, "(c)" to cancel, or refine |
| `@bitbucket add #1 #2 #3 to review` | Same — numbers can appear anywhere relative to the keywords |
| `@bitbucket add all to review` | Preview all findings as PR comments at once |
| `@bitbucket #2 add to review blocking merge` | Preview with reviewer note "blocking merge" appended — confirm before posting |
| `@bitbucket c` | Exit the current review session |

**Slash commands** — typing `@bitbucket /` lists the same shortcuts:

| Command | Example | What it does |
| --- | --- | --- |
| `@bitbucket /check` | `@bitbucket /check` | Verify your Bitbucket connection and credentials |
| `@bitbucket /review` | `@bitbucket /review https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42` | Review a pull request |
| `@bitbucket /usage` | `@bitbucket /usage` | Show token usage per model for recent months |

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

For the Jira tools in Copilot chats and the boards, the same Output Channel logs every tool call and every board request that failed — see
[Jira Tools for Copilot Chats](docs/manual/copilot-tools.md#troubleshooting).

## Releasing

Releases are cut by a manually-triggered GitHub Actions workflow (`.github/workflows/release.yml`) — you no longer hand-edit `package.json`. Go to **Actions → Release → Run workflow** and fill in the form:

- **channel** — `release` or `preview`.
- **bump** — `patch` / `minor` / `major`. The workflow runs `npm version <bump>` to compute the new version.
- **version** — optional explicit version (e.g. `0.4.0`) that **overrides** the bump when set.

Both channels do the same thing with that version — they just differ by the pre-release flag:

- The workflow **commits the version bump back to the branch** (commit titled with the bare version, matching the existing convention), creates the GitHub Release + bare tag `X.Y.Z` (auto-generated notes, `.vsix` attached), and publishes to the VS Code Marketplace.
- **release** publishes a normal release; **preview** publishes with `--pre-release` (and marks the GitHub Release as a pre-release) for sideloading/dogfooding.
- A **release**-channel run also captures those generated notes before packaging, strips the "by @author in #PR" attribution, and prepends the result to `CHANGELOG.md` (committed in the same bump commit) — so the version's entry ships inside that release's own `.vsix` and shows up in VS Code's Extensions view Changelog tab. **preview** runs never touch `CHANGELOG.md`. `scripts/backfill-changelog.mjs` seeded the file once with every prior stable release's notes and stays in the repo as a re-runnable regenerator.

Because every run advances and commits the version, the published version line is **strictly increasing** — a version is never reused, so the Marketplace's "no duplicate version" rule can never bite and you never have to bump by hand. (The Marketplace versions must be plain `x.y.z`; the `--pre-release` _flag_ — not a `-preview` suffix — is what marks a pre-release.) The workflow first requires a green `ci-ok` check on the commit being released (the newest one not made by the Actions bot), then runs `npm ci → compile → test`, and will not publish a red build. If CI is still running or red, wait for it and run the workflow again.

> **Branch protection:** require the single `ci-ok` status check on `main` (Settings → Rules → Rulesets). It fails when any build-and-test or e2e job fails, and its name does not change when the Node or OS matrix does. Every release run pushes the bump commit to the target branch (usually `main`) using the built-in `GITHUB_TOKEN`. `GITHUB_TOKEN` cannot be added to a ruleset's bypass list, so when `main` requires checks the bump push needs another identity: create a fine-grained personal access token for this repository with **Contents: read and write** (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens), store it as the repository secret **`RELEASE_PUSH_TOKEN`**, and add the **Repository admin** role to the ruleset's bypass list. The workflow uses that token when the secret exists and falls back to `GITHUB_TOKEN` otherwise. The token expires, so renew it and update the secret when it does; you can also run the workflow from a release branch instead.

**Prerequisite:** add a repository secret **`VSCE_PAT`** — an Azure DevOps Personal Access Token for the `RobertBreunung` publisher with **Marketplace → Manage** scope (Settings → Secrets and variables → Actions). Without it the Marketplace step fails; the `.vsix` is still attached to the GitHub Release.

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
