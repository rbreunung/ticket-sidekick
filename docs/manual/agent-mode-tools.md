# Agent Mode Tools

Part of `@bitbucket` — lets GitHub Copilot's Agent Mode work with Bitbucket directly, without you typing `@bitbucket`. See the main [README](../../README.md) for setup first.

The Jira tools are on Ticket Sidekick's MCP server, which works in Agent Mode and in Copilot-harness chats alike; see [Jira Tools for Copilot Chats](copilot-tools.md). This page lists the Bitbucket tools.

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
- **No full PR review as a tool.** For a complete review, paste the PR link into `@bitbucket` chat — see [Bitbucket PR Review](bitbucket-pr-review.md).
