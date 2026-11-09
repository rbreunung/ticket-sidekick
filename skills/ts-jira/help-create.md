/ts-jira-create <what the ticket is about>   create a ticket with you, step by step

Use it when you want help writing the ticket. It looks for a fitting template in .jira-templates.json, asks only for what your request leaves open (such as the project, or the issue type when there is no template), drafts the summary and the description from the template's sections, shows you the draft and creates the ticket when you agree.

Example: /ts-jira-create a bug for the failing login in PROJ

Copilot also starts it by itself when you ask for a new ticket in your own words, e.g. "create a bug for the failing login in PROJ", so a new ticket goes through a template and a draft either way.

Without it: Copilot can call the create ticket tool directly with a template or issue type you name. The tool never guesses the issue type, and Copilot asks you before it creates anything.
