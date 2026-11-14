Put it all together: turn an example ticket into a reusable ticket template, then create your first ticket from it.

[Create a template from a ticket](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%2Fts-jira-template%20%3CKEY%3E%20%3CNAME%3E%22%2C%22isPartialQuery%22%3Atrue%7D%5D)

Approve the confirmation that lists the template's fields; the answer ends with the `/ts-jira-create` command that creates a ticket from it.

Or skip straight to a direct create:

[Ask @jira to create a ticket directly](command:workbench.action.chat.open?%5B%7B%22query%22%3A%22%40jira%20create%20%3CTYPE%3E%20in%20%3CPROJECT%3E%3A%20%3CSUMMARY%3E%22%2C%22isPartialQuery%22%3Atrue%7D%5D)

This step completes once a ticket is actually created in Jira.
