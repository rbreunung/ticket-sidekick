/ts-jira-template <KEY> [name]   save a new ticket template built from a ticket

Use it to turn a ticket you like into a template for the next ones. It copies the ticket's issue type and its template fields (priority, labels, components, sprint, team) into a new entry in .jira-templates.json. Fields that are empty on the ticket are left out. Without a name it asks you for one; when the name is taken, the new template is saved as "<name> (2)" and no template is replaced. The confirmation lists every field it saves; remove one you do not want from the file afterwards.

Example: /ts-jira-template PROJ-123 Payments bug

Copilot runs /ts-jira-template only when you type it.

Without it: add the entry to .jira-templates.json by hand; /ts-jira fields PROJ-123 lists the ticket's fields with their ids and values.
