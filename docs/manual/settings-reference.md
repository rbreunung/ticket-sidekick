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
| Hidden fields | `ticketSidekick.jira.hiddenDisplayFields` | _(see below)_ |
| Connection info banner | `ticketSidekick.jira.showConnectionInfo` | `false` |
| Delete .eml after import | `ticketSidekick.email.deleteEmlAfterImport` | `false` |
| Veracode min severity | `ticketSidekick.veracode.minSeverity` | `4` |
| Veracode included statuses | `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` |

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

**Using a local model:** `@bitbucket` works with any model available in GitHub Copilot Chat, including local models via [Ollama](https://ollama.com). Use a model with at least 16k context (32k+ recommended for large PRs).
