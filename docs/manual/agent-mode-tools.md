# Agent Mode Tools

Every tool Ticket Sidekick gives GitHub Copilot's Agent mode, with the name to reference it by. The Bitbucket tools are described here; the Jira tools are listed [at the end of this page](#jira-tools) and described in [Jira Tools for Copilot Chats](copilot-tools.md). See the main [README](../../README.md) for setup first.

## How to use them

In Copilot Chat's **Agent** mode, ask for what you want in your own words, e.g. "Show me the diff of this pull request" or "Post a comment on the PR saying the fix looks good". Copilot picks the tools it needs. You can also name a tool in your prompt with `#`, e.g. `#bitbucketGetPullRequest`.

The Bitbucket tools only show up once your Bitbucket credentials are set. If one is called before that, it answers with the setup step that is missing.

## Tools that only read

These run without asking.

| Tool | Reference | What it does |
| --- | --- | --- |
| `bitbucket_getPullRequest` | `#bitbucketGetPullRequest` | Shows a pull request's title, description, author and target branch |
| `bitbucket_getPullRequestDiff` | `#bitbucketGetPullRequestDiff` | Shows a pull request's diff |

## Tools that change something

This shows a confirmation with the exact comment text before it runs. Nothing happens until you approve it.

| Tool | Reference | What it does |
| --- | --- | --- |
| `bitbucket_postComment` | `#bitbucketPostComment` | Posts a comment on a pull request (a general comment, not tied to a line) |

## Good to know

- **One pull request at a time.** Each tool works on a single pull request.
- **No accidental duplicates.** If Copilot repeats the same comment within a minute, the repeat is skipped. A retry after a real failure still goes through.
- **Auto-approve skips the confirmation.** If you turned on VS Code's `chat.tools.autoApprove`, the comment tool runs without asking. It still checks its own inputs.
- **No full PR review as a tool yet.** A complete review still runs in the deprecated `@bitbucket` chat participant: paste the PR link there — see [Bitbucket PR Review](bitbucket-pr-review.md). A review board is planned to replace it.

## Jira tools

The Jira tools are offered the same way. What each does and which inputs it takes is described in [Jira Tools for Copilot Chats](copilot-tools.md).

A tool marked "asks first" shows a confirmation with every value it is about to write, and nothing happens until you approve it. The others only read, or open a board.

| Tool | Reference | Before it runs |
| --- | --- | --- |
| `jira_check_connection` | `#jiraCheckConnection` | reads |
| `jira_view_ticket` | `#jiraViewTicket` | reads |
| `jira_find_tickets` | `#jiraFindTickets` | reads |
| `jira_list_my_filters` | `#jiraListMyFilters` | reads |
| `jira_workflow` | `#jiraWorkflow` | reads |
| `jira_list_templates` | `#jiraListTemplates` | reads |
| `jira_load_ticket` | `#jiraLoadTicket` | asks first |
| `jira_move_ticket` | `#jiraMoveTicket` | asks first |
| `jira_create_ticket` | `#jiraCreateTicket` | asks first |
| `jira_add_comment` | `#jiraAddComment` | asks first |
| `jira_update_field` | `#jiraUpdateField` | asks first |
| `jira_correct_description` | `#jiraCorrectDescription` | asks first |
| `jira_upload_attachment` | `#jiraUploadAttachment` | asks first |
| `jira_list_fields` | `#jiraListFields` | reads |
| `jira_check_required_fields` | `#jiraCheckRequiredFields` | reads |
| `jira_open_board` | `#jiraOpenBoard` | reads |
