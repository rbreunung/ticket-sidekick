/ts-jira-create <what the ticket is about>   create a ticket with you, step by step

Use it when you want help writing the ticket. It looks for a fitting template in .jira-templates.json, asks only for what your request leaves open (such as the project, or the issue type when there is no template), drafts the summary and the description from the template's sections, shows you the draft and creates the ticket when you agree.

Example: /ts-jira-create a bug for the failing login in PROJ

Without it: ask Copilot plainly, e.g. "create a Bug in PROJ: Login fails on Safari", and it calls the create ticket tool directly. Quicker when you already know the project, the template or issue type, and the summary. The tool never guesses the issue type, and Copilot asks you before it creates anything.

Copilot runs /ts-jira-create only when you type it.
