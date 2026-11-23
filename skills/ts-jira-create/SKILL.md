---
name: ts-jira-create
description: Creates one Jira ticket with the user, step by step, from a workspace template where one fits, showing the draft before creating it. Use when asked to create, open, file or raise a Jira ticket, bug or story. Not for showing, loading, searching or changing existing tickets. Not for tickets from attached or named .eml, Veracode .xml or Waltz .xlsx files, which open the Jira Import Board.
argument-hint: <what the ticket is about>
---

# Create a Jira ticket

Create one ticket together with the user. Ask only for what you cannot take from the request or the conversation.

## Steps

0. If the user asks for tickets made from attached or named `.eml` emails, a Veracode Detailed Report (`.xml`) or a Waltz OSS Report (`.xlsx`), draft and create nothing. Call `jira_open_board` with board `import`, kind `email`, `veracode` or `waltz`, and the files: for emails every path as `paths`, with `dragged` true when the user attached them to the message; for a report the path as `path`. Reply with only the status the tool returns, and stop. Email text pasted into the chat, with no file, is not such a request, and neither is a file that is only the subject of the ticket, such as a bug in `pom.xml`: go on with step 1.
1. Call `jira_list_templates`. If a template fits the request, use it and tell the user which one. If several could fit, ask the user to pick one, naming each with its issue type. If none fits or there are none, go on without a template.
2. Work out the project key, and the issue type when there is no template. Ask the user for each one you cannot tell from the request. Never pick an issue type yourself.
3. Draft the summary (one line) and the description, as Markdown. With a template, use its description sections as headings and fill each from the request; leave a section you cannot fill as a short question to the user rather than inventing content.
4. Show the user the project, the template or issue type, the summary and the description, and ask whether to create it or what to change. Apply each change and show the draft again until the user agrees.
5. Call `jira_create_ticket` with the agreed values: `templateName` when you use a template, otherwise `issueType`. Give the user the new ticket's key and link from the answer, and the template fields it says were applied.
