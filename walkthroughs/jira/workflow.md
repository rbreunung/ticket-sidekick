See the statuses a ticket can move to. The first time, Ticket Sidekick discovers the project's workflow for that issue type by sampling real tickets, and keeps it in `.jira-workflow-cache.json`; moves and cleanup rules follow it later.

[Show the workflow of a ticket](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%2Fts-jira%20workflow%20%3CKEY%3E%22%2C%22isPartialQuery%22%3Atrue%7D%5D)

In the chat box that opens, replace `<KEY>` with a ticket key, e.g. `/ts-jira workflow PROJ-123`. This step completes once the workflow tool has answered.
