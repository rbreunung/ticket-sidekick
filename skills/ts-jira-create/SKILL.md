---
name: ts-jira-create
description: Creates one Jira ticket with you, step by step, from a workspace template where one fits. Type /ts-jira-create and what the ticket is about.
disable-model-invocation: true
argument-hint: <what the ticket is about>
---

# Create a Jira ticket

Create one ticket together with the user. Ask only for what you cannot take from the request or the conversation.

## Steps

1. Call `jira_list_templates`. If a template fits the request, use it and tell the user which one. If several could fit, ask the user to pick one, naming each with its issue type. If none fits or there are none, go on without a template.
2. Work out the project key, and the issue type when there is no template. Ask the user for each one you cannot tell from the request. Never pick an issue type yourself.
3. Draft the summary (one line) and the description, as Markdown. With a template, use its description sections as headings and fill each from the request; leave a section you cannot fill as a short question to the user rather than inventing content.
4. Show the user the project, the template or issue type, the summary and the description, and ask whether to create it or what to change. Apply each change and show the draft again until the user agrees.
5. Call `jira_create_ticket` with the agreed values: `templateName` when you use a template, otherwise `issueType`. Give the user the new ticket's key and link from the answer, and the template fields it says were applied.
