# Settings Reference

Full `ticketSidekick.*` settings for both `@jira` and `@bitbucket`. See the main [README](../../README.md) for setup and core commands first.

## Jira settings reference

| Setting | Key | Default |
| --- | --- | --- |
| Base URL | `ticketSidekick.jira.baseUrl` | _(required)_ |
| Auth type | `ticketSidekick.jira.authType` | `"datacenter"` |
| Default project | `ticketSidekick.jira.defaultProject` | _(empty)_ |
| Sprint board ID | `ticketSidekick.jira.sprintBoardId` | _(auto)_ |
| Required fields | `ticketSidekick.jira.requiredFields` | `[]` |
| Always-show fields | `ticketSidekick.jira.additionalDisplayFields` | `[]` |
| Search result columns | `ticketSidekick.jira.searchFields` | `[]` |
| Cleanup review columns | `ticketSidekick.jira.cleanupFields` | `[]` |
| Team JQL | `ticketSidekick.jira.myTeamJql` | _(empty)_ |
| Hidden fields | `ticketSidekick.jira.hiddenDisplayFields` | _(see below)_ |
| Connection info banner | `ticketSidekick.jira.showConnectionInfo` | `false` |

Settings for email, Veracode and OSS report imports are listed under [Report import settings](#report-import-settings) below.

**Optional: default project**

```json
"ticketSidekick.jira.defaultProject": "PROJ"
```

When set, the `create` command skips the project input box and uses this key automatically. You can still override it by including a project key in your prompt.

**Optional: sprint board ID**

```json
"ticketSidekick.jira.sprintBoardId": 12345
```

Sprint lookups automatically search all Scrum boards for the project, skipping Kanban boards. Set this only if your project has multiple Scrum boards and the wrong one is selected. Find the board ID in the URL:

- Modern Jira: `.../jira/software/projects/PROJ/boards/12345`
- Data Center RapidBoard: `.../jira/secure/RapidBoard.jspa?rapidView=12345` (use the `rapidView` value)

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

**Optional: search result columns**

By default `@jira find …` shows Key, Summary, Status, and Assignee. Add field IDs to `searchFields` to append them as extra columns in the results table:

```json
"ticketSidekick.jira.searchFields": ["priority", "customfield_10020"]
```

Run `@jira show fields on PROJ-123` to discover field IDs. Values render the same way as in `@jira show`.

**Optional: cleanup review columns**

By default the review screen of `@jira run cleanup …` and other bulk transitions lists each ticket's type, key, summary, current and target status, and the resolution when one is set. Add field IDs to `cleanupFields` to show them as extra columns, so you can check e.g. the fix version before confirming:

```json
"ticketSidekick.jira.cleanupFields": ["fixVersions", "priority"]
```

Subtasks in the batch get their own values for these columns. Run `@jira show fields on PROJ-123` to discover field IDs.

**Optional: team JQL**

```json
"ticketSidekick.jira.myTeamJql": "project = BACKEND AND assignee in membersOf(\"backend-team\")"
```

A JQL fragment that describes your team's tickets. When a search mentions "my team" or "our team" (e.g. `@jira open bugs for my team`), `@jira` combines this fragment with the rest of your request. If the request adds no other conditions, only unresolved tickets are listed. If the setting is empty, `@jira` tells you to set it instead of guessing.

**Optional: hidden fields**

By default `@jira show` already omits several noisy system fields (e.g. `statusCategory`, `watches`, `votes`). To suppress additional fields, add their IDs to `hiddenDisplayFields`. Fields listed in `additionalDisplayFields` always override this list.

```json
"ticketSidekick.jira.hiddenDisplayFields": ["customfield_10900", "workratio"]
```

**Optional: Jira connection info banner**

```json
"ticketSidekick.jira.showConnectionInfo": true
```

When enabled, every `@jira` response starts with an italic line showing the active base URL, API version, and auth type. Useful during initial setup or when switching between instances. Off by default.

## Report import settings

| Setting | Key | Default |
| --- | --- | --- |
| Delete .eml after import | `ticketSidekick.email.deleteEmlAfterImport` | `false` |
| Email batch size limit (MB) | `ticketSidekick.email.maxBatchSizeMB` | `150` |
| Email boilerplate patterns | `ticketSidekick.email.boilerplatePatterns` | `[]` |
| Veracode min severity | `ticketSidekick.veracode.minSeverity` | `4` |
| Veracode included statuses | `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` |
| Veracode report size limit (MB) | `ticketSidekick.veracode.maxReportSizeMB` | `50` |
| OSS report min vulnerability rating | `ticketSidekick.waltz.minVulnRating` | `"High"` |
| OSS report included remediation actions | `ticketSidekick.waltz.includeRemediationActions` | `["", "Remediate"]` |
| OSS report size limit (MB) | `ticketSidekick.waltz.maxReportSizeMB` | `50` |

What the filter settings do is described with each import in [Report Imports](report-imports.md).

**Optional: size limits**

```json
"ticketSidekick.veracode.maxReportSizeMB": 120
```

Each importer rejects a file larger than its limit before reading it. For an email batch the limit applies to all selected `.eml` files together. Raise it if a real report is rejected as too large: Veracode and OSS report limits can be set from 1 to 200 MB, the email batch limit from 1 to 500 MB. A value outside that range, or not a number, falls back to the default.

**Optional: email boilerplate patterns**

```json
"ticketSidekick.email.boilerplatePatterns": [
  { "kind": "footer", "start": "CONFIDENTIALITY NOTICE:", "end": "Registered office Frankfurt am Main." },
  { "kind": "signature", "start": "Best regards" }
]
```

Known confidentiality headers, legal footers and signatures to remove from imported emails, in every message of the thread. `kind` is `header`, `footer` or `signature`; `start` and `end` are plain text (not regular expressions), matched ignoring case, extra spaces and bold/italic. With `end`, the block runs through the line containing it. Without `end`, a header covers the line(s) its start phrase is on — add an `end` for multi-line headers — and a footer or signature runs until the next matched block, the next quoted message or the end of the message, at most 40 lines. A stripped signature keeps the author's name when one can be recognized. Entries with an unknown `kind` or an empty `start` are ignored. This setting can only be set in your user settings, not in a workspace's `.vscode/settings.json`.

## Bitbucket settings reference

| Setting | Key | Default |
| --- | --- | --- |
| Auth type | `ticketSidekick.bitbucket.authType` | `"datacenter"` |
| Base URL (DC only) | `ticketSidekick.bitbucket.baseUrl` | _(empty)_ |
| Connection info banner | `ticketSidekick.bitbucket.showConnectionInfo` | `false` |
| Review instructions | `ticketSidekick.bitbucket.reviewInstructions` | _(empty)_ |
| Model context tokens | `ticketSidekick.bitbucket.modelContextTokens` | _(auto-detected)_ |
| Context budget ratio | `ticketSidekick.bitbucket.contextBudgetRatio` | `0.7` |
| Review mode | `ticketSidekick.bitbucket.reviewMode` | `"standard"` |
| Review exclude patterns | `ticketSidekick.bitbucket.reviewExcludePatterns` | `[]` |
| Diff context lines | `ticketSidekick.bitbucket.reviewContextLines` | `12` |
| Confidence threshold | `ticketSidekick.bitbucket.confidenceThreshold` | `0.7` |
| Detailed diagnostics | `ticketSidekick.bitbucket.detailedDiagnostics` | `false` |
| Show token usage | `ticketSidekick.bitbucket.showTokenUsage` | `false` |

**Optional: Bitbucket connection info banner**

```json
"ticketSidekick.bitbucket.showConnectionInfo": true
```

When enabled, every `@bitbucket` response (except `check`) starts with an italic line showing the active base URL, API version, and auth type. Off by default.

**Optional: custom review instructions**

```json
"ticketSidekick.bitbucket.reviewInstructions": "This project follows Google Style Guide. Focus on security issues and ignore minor style suggestions."
```

Additional instructions appended to the built-in PR review prompt. Use this to add project-specific guidance the model should apply on every review. The built-in grounding rules and output format are always included — this setting only adds extra guidance, it can't remove them.

Some examples of what works well here:

```text
"This project follows the Google Style Guide."
"Focus on security issues only, ignore style/naming."
"This is a prototype — skip suggestions about test coverage."
"Pay extra attention to off-by-one errors in pagination code."
```

**Optional: diff context lines**

```json
"ticketSidekick.bitbucket.reviewContextLines": 6
```

How many unchanged lines (0–100) the review asks Bitbucket for around each change. The default of 12 usually includes the surrounding function, so the model reasons about real code instead of guessing. Lower it to save tokens on large PRs, see [Reducing token usage on large PRs](bitbucket-pr-review.md#reducing-token-usage-on-large-prs).

**Optional: confidence threshold**

```json
"ticketSidekick.bitbucket.confidenceThreshold": 0.8
```

The model rates its confidence in each finding from 0 to 1. At or above this threshold the confidence is shown in bold; below it the number is shown plain, and a copied review (`@bitbucket copy`) marks the finding "(low confidence)". A low-confidence finding is never hidden or removed — it stays in its severity table.

**Optional: detailed diagnostics**

```json
"ticketSidekick.bitbucket.detailedDiagnostics": true
```

When enabled, each review also writes one structured run record to the **Ticket Sidekick** output channel (**View → Output**): the run's configuration, every model call, and how many findings were kept or dropped at each step and why. It is one copy-pasteable block, useful for comparing two runs or attaching to a bug report. Off by default.

**Optional: token usage line**

```json
"ticketSidekick.bitbucket.showTokenUsage": true
```

When enabled, every `@bitbucket` answer ends with one line such as `Tokens: 41,230 in · 6,840 out · claude-sonnet-4.5`. A review also shows its budget. Counts come from the editor's tokenizer for the selected model, so they are approximate and can differ from provider billing; a `~` marks a figure that had to be estimated. Off by default. Usage is recorded for [`@bitbucket usage`](bitbucket-pr-review.md#token-usage) whether or not this line is shown.

**Using a local model:** `@bitbucket` works with any model available in GitHub Copilot Chat, including local models via [Ollama](https://ollama.com). Use a model with at least 16k context (32k+ recommended for large PRs).
