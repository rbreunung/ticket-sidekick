# Agent Mode Tools

Part of both `@jira` and `@bitbucket` — lets GitHub Copilot's Agent Mode work with Jira and Bitbucket directly, without you typing `@jira` or `@bitbucket`. See the main [README](../../README.md) for setup first.

## How to use them

In Copilot Chat's **Agent** mode, ask for what you want in your own words, e.g. "Read PROJ-123 and fix the bug it describes" or "Add a comment to PROJ-123 saying the fix is in review". Copilot picks the tools it needs. You can also name a tool in your prompt with `#`, e.g. `#jiraGetTicket PROJ-123`.

The Jira tools only show up once your Jira credentials are set, and the Bitbucket tools once your Bitbucket credentials are set. If one is called before that, it answers with the setup step that is missing.

## Tools that only read

These run without asking.

| Tool | Reference | What it does |
| --- | --- | --- |
| `jira_getTicket` | `#jiraGetTicket` | Shows a ticket's fields, description and attachment names |
| `jira_searchTickets` | `#jiraSearchTickets` | Searches tickets with a JQL query |
| `jira_getComments` | `#jiraGetComments` | Shows a ticket's comments, newest first |
| `jira_listTemplates` | `#jiraListTemplates` | Lists the templates in your workspace's `.jira-templates.json` |
| `jira_discoverWorkflow` | `#jiraDiscoverWorkflow` | Learns a project's workflow for one issue type, like `@jira discover workflow` |
| `jira_listMyFilters` | `#jiraListMyFilters` | Lists your favourite and own saved Jira filters |
| `jira_searchByFilter` | `#jiraSearchByFilter` | Runs a saved filter, optionally narrowed by fix version, sprint or assignee |
| `bitbucket_getPullRequest` | `#bitbucketGetPullRequest` | Shows a pull request's title, description, author and target branch |
| `bitbucket_getPullRequestDiff` | `#bitbucketGetPullRequestDiff` | Shows a pull request's diff |

## Tools that change something

Each of these shows a confirmation naming the exact change before it runs, e.g. the comment text, or a field's current and new value (`Critical → High`). Nothing happens until you approve it.

| Tool | Reference | What it does |
| --- | --- | --- |
| `jira_addComment` | `#jiraAddComment` | Adds a comment to a ticket |
| `jira_updateField` | `#jiraUpdateField` | Changes one field on one ticket: summary, description, priority, assignee, labels, components or fix version |
| `jira_createTicket` | `#jiraCreateTicket` | Creates a ticket, optionally from one of your templates |
| `jira_transitionTicket` | `#jiraTransitionTicket` | Moves a ticket to a new status, optionally setting a resolution |
| `jira_loadTicket` | `#jiraLoadTicket` | Downloads a ticket's description, comments and attachments into `.jira-context/<key>/`, like `@jira load` |
| `jira_downloadAttachment` | `#jiraDownloadAttachment` | Downloads one named attachment, including one `jira_loadTicket` skipped |
| `jira_uploadAttachment` | `#jiraUploadAttachment` | Uploads a local file to a ticket |
| `bitbucket_postComment` | `#bitbucketPostComment` | Posts a comment on a pull request (a general comment, not tied to a line) |

## Good to know

- **One ticket at a time.** Each tool changes a single ticket or pull request. For bulk changes, use `@jira run cleanup` or other bulk commands in chat.
- **No guessed issue type.** If `jira_createTicket` gets neither an issue type nor a template that sets one, it creates nothing and returns the project's issue types to choose from.
- **No accidental duplicates.** If Copilot repeats the same create, comment or upload within a minute, the repeat is skipped. A retry after a real failure still goes through.
- **Uploads stay inside your home folder.** `jira_uploadAttachment` only accepts files under your home directory and refuses hidden folders such as `~/.ssh`.
- **Auto-approve skips the confirmation.** If you turned on VS Code's `chat.tools.autoApprove`, the tools that change something run without asking. They still check their own inputs.
- **No full PR review as a tool.** For a complete review, paste the PR link into `@bitbucket` chat — see [Bitbucket PR Review](bitbucket-pr-review.md).
- **No memory between calls.** Where chat would show a pick list (for example, several filters with the same name), a tool returns the candidates as text for Copilot to choose from in its next call.
