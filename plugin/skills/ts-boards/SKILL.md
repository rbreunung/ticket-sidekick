---
name: ts-boards
description: Lists the Ticket Sidekick boards (security report, ticket list, stored sessions) and says how to open each. Use when the user asks which Ticket Sidekick boards or canvases exist.
---

Ticket Sidekick shows larger views as boards: canvases that open in their own editor tab. The extension reads Jira and fills the page itself. You only open the canvas and get back whether it opened.

| Board | Canvas id | Input |
| --- | --- | --- |
| Security report of a Jira project | `security-report` | `project`: the project key; leave out for the default project |
| Ticket list for a JQL query or saved filter, with bulk move and field update | `ticket-list` | `jql` or `filter`; optional `change` the user asked for |
| Stored sessions of this workspace | `sessions` | none |

Rules:

- To open a board, open its canvas with the input above and reply with only the status it returns.
- Never build a board's content yourself from other tools, and never list a board's tickets in chat.
- If the canvas is not registered or cannot be opened, say so plainly and name the status or error you got. Do not guess the reason.
