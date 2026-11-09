# Agent Mode Tools

Part of both `@jira` and `@bitbucket` — lets GitHub Copilot's Agent Mode work with Jira and Bitbucket directly, without you typing `@jira` or `@bitbucket`. See the main [README](../../README.md) for setup first.

The Jira tools that read — view, find, saved filters, workflow, templates and load — moved to Ticket Sidekick's MCP server; see [Jira Tools for Copilot Chats](copilot-tools.md). This page lists the Jira tools that change a ticket, and the Bitbucket tools.

## How to use them

In Copilot Chat's **Agent** mode, ask for what you want in your own words, e.g. "Read PROJ-123 and fix the bug it describes" or "Add a comment to PROJ-123 saying the fix is in review". Copilot picks the tools it needs. You can also name a tool in your prompt with `#`, e.g. `#jiraAddComment PROJ-123 Fix is in review`.

The Jira tools only show up once your Jira credentials are set, and the Bitbucket tools once your Bitbucket credentials are set. If one is called before that, it answers with the setup step that is missing.

## Tools that only read

These run without asking.

| Tool | Reference | What it does |
| --- | --- | --- |
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
| `jira_uploadAttachment` | `#jiraUploadAttachment` | Uploads a local file to a ticket |
| `bitbucket_postComment` | `#bitbucketPostComment` | Posts a comment on a pull request (a general comment, not tied to a line) |

## Good to know

- **One ticket at a time.** Each tool changes a single ticket or pull request. For bulk changes, use `@jira run cleanup` or other bulk commands in chat.
- **No guessed issue type.** If `jira_createTicket` gets neither an issue type nor a template that sets one, it creates nothing and returns the project's issue types to choose from. Copilot finds your templates with `jira_list_templates` from the MCP server.
- **Moves that need several steps.** `jira_transitionTicket` uses the workflow cached in the workspace to move a ticket through several statuses. When none is cached, it says so, and `jira_workflow` from the MCP server learns the workflow.
- **No accidental duplicates.** If Copilot repeats the same create, comment or upload within a minute, the repeat is skipped. A retry after a real failure still goes through.
- **Uploads stay inside your home folder.** `jira_uploadAttachment` only accepts files under your home directory and refuses hidden folders such as `~/.ssh`.
- **Auto-approve skips the confirmation.** If you turned on VS Code's `chat.tools.autoApprove`, the tools that change something run without asking. They still check their own inputs.
- **No full PR review as a tool.** For a complete review, paste the PR link into `@bitbucket` chat — see [Bitbucket PR Review](bitbucket-pr-review.md).
- **No memory between calls.** Where chat would ask you to pick (for example, which issue type to use), a tool returns the choices as text for Copilot to choose from in its next call.
