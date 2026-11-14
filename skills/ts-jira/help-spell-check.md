/ts-jira-spell-check <KEY>   check and correct the spelling of a ticket's description

Use it when a description needs proofreading. It reads the ticket, lists each spelling or grammar mistake as a numbered "before → after" line, and waits. Approve them all or drop some by number ("skip 2"); only the approved corrections are written, and the rest of the description, formatting, code and links included, stays exactly as it is. Code, monospace and link targets are never corrected.

Example: /ts-jira-spell-check PROJ-123

Copilot runs /ts-jira-spell-check only when you type it.

Without it: /ts-jira view PROJ-123 shows the description, and /ts-jira field PROJ-123 description <text> replaces the whole description with text you write.
