---
name: ts-jira-template
description: Saves a new ticket template to .jira-templates.json, built from one Jira ticket's issue type and template fields. Type /ts-jira-template PROJ-123 "Payments bug".
disable-model-invocation: true
argument-hint: <ticket key> [template name]
---

# Create a ticket template from a Jira ticket

Save one new template, built from a ticket the user names, to the workspace's `.jira-templates.json`.

## Steps

1. Take the ticket key from what the user typed. If there is none, ask for it and wait.
2. Take the template name from what the user typed. If there is none, ask the user for the name and wait. Do not make one up.
3. Call `jira_create_template` once with the ticket key and the name. The confirmation the user sees lists everything it saves; do not show the fields yourself first.
4. Show the tool's answer as it is, including its last line on how to create a ticket from the template. Ask nothing after the save.
