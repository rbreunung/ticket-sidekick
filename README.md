# Ticket Sidekick

[![CI](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml/badge.svg)](https://github.com/rbreunung/ticket-sidekick/actions/workflows/ci.yml)

Jira and Bitbucket inside GitHub Copilot Chat in VS Code:

- **Jira tools for Copilot** — Copilot's agent views, finds, creates, comments on, moves and updates Jira tickets through Ticket Sidekick's tools, or you type a command such as `/ts-jira view PROJ-123`
- **Boards** — ticket lists, the security report and the imports of Veracode reports, OSS reports and emails open in an editor tab, where you select and apply changes (one click, with the button naming what it writes); a board comes back after a restart
- **Pull request review** — a Bitbucket pull request is reviewed on its own board: a regular pass first, then the extra passes you pick, with a discussion per finding, editable comments posted to Bitbucket, and Copy for Teams

> **`@jira` and `@bitbucket` are gone.** Every task runs from a Copilot chat with the Jira and Bitbucket tools and the `/ts-jira` and `/ts-bitbucket` commands, or on a board. Start with [Copilot tools and boards](#copilot-tools-and-boards).

---

## Copilot tools and boards

This is the current way to use Ticket Sidekick. Set up the Jira connection first ([Setup](#setup) below: base URL and token); nothing else is needed.

### Jira tools

In a Copilot chat in **Agent** mode, ask in your own words ("show me PROJ-123", "add a comment to PROJ-123 saying the fix is deployed") and Copilot calls Ticket Sidekick's Jira tools. They view, find, load, move, create, comment on and update Jira tickets, upload attachments, list filters, fields, workflows and templates, and check the connection. A tool that changes something asks first and shows exactly what it will write.

Five skills sit on top of the tools: `/ts-jira <command>` runs one Jira command you type, e.g. `/ts-jira load PROJ-123` (`/ts-jira help` lists them), `/ts-jira-brief` writes a developer brief of a ticket, `/ts-jira-create` creates a ticket with you, from a template where one fits, `/ts-jira-spell-check` corrects the spelling of a ticket's description, and `/ts-jira-template` saves a new template built from a ticket.

See [Jira Tools for Copilot Chats](docs/manual/copilot-tools.md) for every tool and its inputs, the skills, approvals, troubleshooting and a checklist to try it out. The Bitbucket tools (`bitbucket_*`) are listed in [Agent Mode Tools](docs/manual/agent-mode-tools.md).

### Bitbucket tools

Copilot's agent reads a pull request and its diff, posts a general comment after a confirmation, opens the review board and reads a review's findings through the Bitbucket tools. `/ts-bitbucket <command>` runs one Bitbucket command you type: `review <link> [PROJ-123] [text]`, `check`, `usage` and `help`. Set up the Bitbucket connection first ([Bitbucket setup](#bitbucket-setup)).

### Boards

Larger views open as a **board** in their own editor tab. The security report opens with "the security report for PROJ", `/ts-jira security-report PROJ` or `Ticket Sidekick: Open security report`. A ticket list opens when you ask Copilot to see tickets or to change several of them, with `/ts-jira search <JQL or filter>` or `Ticket Sidekick: Open ticket list`: you select tickets there and move them or set a field after a preview. A cleanup rule from `.jira-templates.json` opens the same board with "run the cleanup Close released bugs", `/ts-jira cleanup <rule> [in VERSION]` or `Ticket Sidekick: Run a cleanup rule`. A Veracode Detailed Report, a Waltz OSS Report or one or more `.eml` emails are imported on the Jira Import Board: `Ticket Sidekick: Open Jira Import Board`, `/ts-jira create from <veracode, waltz or email> [PATH ...]` (`/ts-jira import <kind>` is the same command), or ask Copilot with the files' paths or with the emails attached. A board keeps its work in progress as a stored session, so it comes back after a restart; `/ts-jira sessions` or `Ticket Sidekick: Open stored sessions` lists the stored sessions and `Ticket Sidekick: Clear stored sessions` deletes them all. A Bitbucket pull request is reviewed on the review board: `Ticket Sidekick: Review a pull request`, `/ts-bitbucket review <link>`, or ask Copilot with the link (see [Pull Request Review](docs/manual/bitbucket-pr-review.md)). The Command Palette commands work without Copilot. See [Boards](docs/manual/boards.md).

---

## Jira setup

The Jira tools and the boards share this setup.

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

## Report imports

### The Jira Import Board: Veracode reports, OSS reports and emails

`Ticket Sidekick: Open Jira Import Board` opens a start screen: pick Veracode, Waltz OSS or Email and the report file or the `.eml` files. The template comes from `ticketSidekick.veracode.template`, `ticketSidekick.waltz.template` or `ticketSidekick.email.template`, preselected on the start screen, where you can pick another template for the import or tick Set as default to save it, and asked for and saved when empty; the project is `ticketSidekick.jira.defaultProject`, asked for (typed, or chosen from Jira's projects) and saved the same way when it is empty or wrong. The board shows the report's groups as tabs (New, Already ticketed, Stale, and Accepted for OSS reports), each with its own preview and Apply. You can fold findings into one ticket, add them to an existing ticket, refresh existing tickets with `rewrite` or `new ticket`, close stale tickets, merge tickets, accept OSS CVEs and components, and save the overview as CSV or Excel. Veracode tickets get their Jira Due Date from the per-severity day table in `ticketSidekick.veracode.slaDays`; OSS tickets from the report's remediation dates. An unfinished import, including a half-done ticket merge, comes back after a restart. See [Boards → Jira Import Board](docs/manual/boards.md#jira-import-board) and [Report Imports](docs/manual/report-imports.md).

An email import starts with the boilerplate cleanup: your patterns from `ticketSidekick.email.boilerplatePatterns` find confidentiality headers, legal footers and signatures first. Emails they do not match can be checked by a language model, but only after you preview that check, which names every email it sends and the model, and apply it; the model is `ticketSidekick.email.checkModel`, picked on the board when it is empty. You then strip or keep what was found. Each email becomes a new ticket with its attachments, or a comment on an existing ticket; an email whose subject is already a ticket's summary is marked as a likely repeat and offers to be added to that ticket. See [Report Imports](docs/manual/report-imports.md).

The `@jira` chat participant, its email import and the commands "Create Jira ticket from email (.eml)", "Create Jira tickets from Veracode report (.xml)" and "Create Jira tickets from OSS report (.xlsx)" are gone.

### Templates and cleanup rules

Create a `.jira-templates.json` file in your workspace root to define per-application templates with default fields and guided description collection, plus named cleanup rules for bulk status transitions. See [Jira Templates and Cleanup Rules](docs/manual/jira-templates-and-cleanup-rules.md) for how to generate one from an existing ticket, field references, and examples.

### Settings reference

See [Settings Reference → Jira](docs/manual/settings-reference.md#jira-settings-reference) for every `ticketSidekick.jira.*` setting, and [Report import settings](docs/manual/settings-reference.md#report-import-settings) for every `ticketSidekick.email.*` / `ticketSidekick.veracode.*` / `ticketSidekick.waltz.*` setting.

---

## Bitbucket setup

### Quickstart

1. Set `ticketSidekick.bitbucket.authType` to `"datacenter"` (default) or `"cloud"`
2. Data Center only: also set `ticketSidekick.bitbucket.baseUrl` (Cloud talks to `api.bitbucket.org` automatically — leave unset)
3. Command Palette → `Ticket Sidekick: Set Bitbucket Personal Access Token` (Data Center) or `Ticket Sidekick: Configure Bitbucket Cloud Credentials` (Cloud)

Then type `/ts-bitbucket check` in a Copilot chat to confirm the connection, and open a review with `Ticket Sidekick: Review a pull request`. Full setup details are below.

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
| Pull requests: Write | Posting findings as PR comments (**Post** on the review board) |
| Account: Read | (optional) shows your username in `/ts-bitbucket check` |

> **Note:** Bitbucket App Passwords use `Authorization: Basic` — they are not the same as Atlassian API tokens (used for Jira Cloud). Using an Atlassian API token here will fail with 401.

Run `/ts-bitbucket check` after setup to confirm the connection and see which account is active.

### Reviewing a pull request

| How | What happens |
| --- | --- |
| `Ticket Sidekick: Review a pull request` | Asks for the pull request link and opens its review board |
| `/ts-bitbucket review <pr-url> [PROJ-123] [text]` | Opens the review board; a Jira key and the rest of the text become the background for the reviewer |
| Paste the link in Agent mode and ask for a review | Copilot opens the same board |
| `/ts-bitbucket check` | Tests the connection and shows the active configuration |
| `/ts-bitbucket usage` | Shows input and output tokens per model for the current month and the two before it |

The board stops on its first step: the review model and one background for the reviewer (a Jira ticket, your own text or none). **Start** runs the regular pass, and findings appear as each batch finishes; you then keep the findings, run the suggested extra passes or pick any of them, now or later, and the picked passes run at the same time. Each finding can be discussed on the board or in Copilot Chat, drafted as a comment, posted to Bitbucket after a confirmation, or copied for Teams or as Markdown. Ask Copilot about a finished review ("explain finding 2") and it reads the findings with `bitbucket_read_findings`. See [Pull Request Review](docs/manual/bitbucket-pr-review.md) for the whole review, including token-usage tuning for large pull requests.

### Settings reference

See [Settings Reference → Bitbucket](docs/manual/settings-reference.md#bitbucket-settings-reference) for every `ticketSidekick.bitbucket.*` setting.

---

## Troubleshooting

The Jira and Bitbucket tools and the boards log diagnostic detail beyond what's shown in
chat or on a board to a shared VS Code output channel: **View → Output → "Ticket
Sidekick"**.

For reviews on the review board specifically, this includes: each pass's
configuration and the model in use, every model call that failed
(including ones that succeeded on a retry), which files or findings were
in that attempt, and the raw error. If a review, an Explain or a Rewrite
ever shows a failure message, check this channel first — it
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

- The workflow first records the version in git: it commits the version bump (titled with the bare version, matching the existing convention), pushes the bare tag `X.Y.Z`, and merges the bump into the branch. If the branch moved during the run (a PR merged meanwhile), it fetches the branch, merges again and retries the push, up to five times. Then it builds the `.vsix` from that tagged commit, publishes it to the VS Code Marketplace, and creates the GitHub Release on the tag (auto-generated notes, `.vsix` attached). The Marketplace publish comes last, so a failure before it publishes nothing; the tag stays, and the next run uses a new version.
- **release** publishes a normal release; **preview** publishes with `--pre-release` (and marks the GitHub Release as a pre-release) for sideloading/dogfooding.
- A **release**-channel run also captures those generated notes before packaging, strips the "by @author in #PR" attribution, and prepends the result to `CHANGELOG.md` (committed in the same bump commit) — so the version's entry ships inside that release's own `.vsix` and shows up in VS Code's Extensions view Changelog tab. **preview** runs never touch `CHANGELOG.md`. `scripts/backfill-changelog.mjs` seeded the file once with every prior stable release's notes and stays in the repo as a re-runnable regenerator.

Because every run advances and commits the version, the published version line is **strictly increasing** — a version is never reused, so the Marketplace's "no duplicate version" rule can never bite and you never have to bump by hand. (The Marketplace versions must be plain `x.y.z`; the `--pre-release` _flag_ — not a `-preview` suffix — is what marks a pre-release.) Before packaging, the workflow also checks whether the version is taken, meaning already on the Marketplace or already tagged. A bump that lands on a taken version skips forward to the next free patch version with a warning (for example, 0.9.3 is on the Marketplace but `main` still says 0.9.2, so a patch bump gives 0.9.4), so a run that published but could not record the bump heals itself. An explicit **version** that is taken stops the run instead. Only one release run goes at a time. The workflow first requires a green `ci-ok` check on the commit being released (the newest one not made by the Actions bot), then runs `npm ci → compile → test`, and will not publish a red build. If CI is still running or red, wait for it and run the workflow again. CI runs for pull requests to `main` and pushes to `main`, so to release a preview from a branch, open a pull request for it (a draft is enough) or run the **CI** workflow on the branch by hand (Actions → CI → Run workflow) and release once it is green.

> **Branch protection:** require the single `ci-ok` status check on `main` (Settings → Rules → Rulesets). It fails when any build-and-test or e2e job fails, and its name does not change when the Node or OS matrix does. Every release run pushes the bump commit to the target branch (usually `main`) using the built-in `GITHUB_TOKEN`. `GITHUB_TOKEN` cannot be added to a ruleset's bypass list, so when `main` requires checks the bump push needs another identity: create a fine-grained personal access token for this repository with **Contents: read and write** (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens), store it as the repository secret **`RELEASE_PUSH_TOKEN`**, and add the **Repository admin** role to the ruleset's bypass list. The workflow uses that token when the secret exists and falls back to `GITHUB_TOKEN` otherwise. The token expires, so renew it and update the secret when it does; you can also run the workflow from a release branch instead.

**Prerequisite:** add a repository secret **`VSCE_PAT`** — an Azure DevOps Personal Access Token for the `RobertBreunung` publisher with **Marketplace → Manage** scope (Settings → Secrets and variables → Actions). Without it the Marketplace step fails: the tag and the bump are already pushed, but nothing is published and no GitHub Release is created, so add the secret and release the next version.

## Getting a free Jira Cloud test instance

1. Create a free account at [atlassian.com](https://www.atlassian.com)
2. Generate an API token at id.atlassian.com/manage-profile/security/api-tokens
3. Set `ticketSidekick.jira.baseUrl` to `https://<you>.atlassian.net` and `ticketSidekick.jira.authType` to `"cloud"`
4. Run `Ticket Sidekick: Configure Jira Cloud Credentials`
