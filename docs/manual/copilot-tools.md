# Jira Tools for Copilot Chats (MCP)

Part of `@jira` — gives Copilot chats that cannot use `@jira` a set of Jira tools and a developer-brief skill. See the main [README](../../README.md) for the Jira setup first.

## What it is and when it runs

Chats that run in VS Code's **Copilot harness** cannot use the `@jira` participant. For them Ticket Sidekick runs a small MCP server inside VS Code and offers it to VS Code as the **Ticket Sidekick** MCP server. Copilot finds its tools by itself; you ask in your own words, e.g. "show me PROJ-123" or "find my team's open bugs".

- It needs VS Code 1.101 or later.
- It listens only on `127.0.0.1`, on a random port, and accepts only requests that carry a key which changes at every VS Code start.
- It starts when VS Code starts, as long as the `http.noProxy` entry below is there. Jira does not need to be configured for it to run: a tool called before setup answers with the step that is missing.

## The `http.noProxy` requirement

The server runs only while the VS Code setting `http.noProxy` contains the entry `127.0.0.1`, exactly that: an entry with a port, such as `127.0.0.1:8080`, does not count. Without it, Copilot could send these local requests to your network proxy.

```json
"http.noProxy": ["127.0.0.1"]
```

Ticket Sidekick never changes the setting itself. Until you add the entry, every VS Code start shows a notice with an **Open Setting** button, and the Jira Getting-Started walkthrough has a step for it. Adding the entry starts the server and removing it stops the server, without a restart.

## The tools

All of these read Jira and change nothing there. `jira_workflow` and `jira_load_ticket` write local files in the first workspace folder.

| Tool | What it does | Inputs |
| --- | --- | --- |
| `jira_check_connection` | Checks the Jira connection: base URL, auth type, whether a token is stored, and the signed-in user, or what is missing or wrong. Gives the same answer as `@jira check` | none |
| `jira_view_ticket` | Shows one ticket in full: the fields your display settings choose (`ticketSidekick.jira.additionalDisplayFields`, `ticketSidekick.jira.hiddenDisplayFields`), the whole description, the attachments with name, size and type, and the comments, newest first, up to 100 | `ticketKey` (optional: without it, the key in the current git branch of the first workspace folder is used, and the answer names that folder and branch) |
| `jira_find_tickets` | Finds tickets by JQL or by a saved filter, 50 per page, with the columns from `ticketSidekick.jira.searchFields`. "My team" means the team JQL in `ticketSidekick.jira.myTeamJql` | `jql` or `filter` (a saved filter's id or name); optional `fixVersion`, `sprint`, `assignee` (`me` for you), `myTeam`, and `page` to read the next page |
| `jira_list_my_filters` | Lists your favourite and own saved filters, each once, with name and id | none |
| `jira_workflow` | Lists the statuses a ticket can be moved to from its current status, with the transitions that lead there. When no workflow is cached for the ticket's project and issue type, it learns it from Jira and saves it to `.jira-workflow-cache.json`, the same cache `@jira` uses | `ticketKey`; optional `refresh` to learn the workflow again |
| `jira_list_templates` | Lists the templates in your workspace's `.jira-templates.json`, each with its issue type, the field values it sets and its description sections | none |
| `jira_load_ticket` | Downloads a ticket into `.jira-context/<KEY>/` in the first workspace folder, like `@jira load`: `ticket.md`, `comments.md` and the text, image, document and archive attachments. It names every file it wrote by its full path and every attachment it skipped, with its size and the reason. Files over 100 MB are never downloaded. An attachment that has not finished downloading after 2 minutes is listed as skipped (download failed), and everything else is still written | `ticketKey` (optional, as for `jira_view_ticket`); optional `attachments`, a list of attachment names to download as well, including ones the default filter skips |

The Jira tools that change a ticket (comment, update a field, create, move, upload) are still Agent Mode tools for now — see [Agent Mode Tools](agent-mode-tools.md).

## Skills

A skill is a set of instructions Copilot follows, using the tools above. Type its name as a slash command in a Copilot chat, or just ask, and Copilot picks it by itself.

| Skill | What it does |
| --- | --- |
| `/jira-brief` | Writes a developer brief of one ticket, e.g. `/jira-brief PROJ-123`. It reads the ticket with `jira_view_ticket`, loads the attachments that matter with `jira_load_ticket`, and writes eight sections: problem or goal; context; steps to reproduce with expected and actual result; acceptance criteria; decisions and findings from comments, with author and date; current state; open questions and missing information; and the sources it used. A section the ticket does not cover says "not stated in the ticket", acceptance criteria it worked out itself are marked "(derived)", and it lists the attachments it could not read |

## Approvals

Copilot decides when to ask you before a tool runs, from its own tool-approval settings; Ticket Sidekick adds no confirmation of its own. The tools that only read Jira are marked as read-only, so Copilot knows they change nothing. Any tool on this server that changes Jira is marked as such and is approved through Copilot's own tool approval, which shows the tool's arguments. If you set Copilot to approve tools automatically, they run without asking.

## Diagnostics

Run `Ticket Sidekick: Copy MCP diagnostics` from the Command Palette. It copies a report to the clipboard: server state, whether it is offered and why not, request and tool-call counts, the proxy-related settings, the `chat.mcp.*` and sandbox settings, and whether the key turns up in stored files. Every key and token is removed. It leaves out tool arguments and your Jira base URL, and of `http.noProxy` it lists only the loopback entries and counts the rest. Folders and files under your home folder appear with `~`. The search for stored keys stops after 512 MB of files, and you can cancel it from the notification; either way the report is still copied and says the search is incomplete.

The `chat.mcp.*` and sandbox settings appear as they are, so a sandbox allow-list can name internal hosts: read the report once before you send it on.

## Troubleshooting

- **The tools do not show up.** Check that `http.noProxy` contains `127.0.0.1` exactly and that you run VS Code 1.101 or later.
- **The Jira tools stop answering after you changed `http.noProxy` or reloaded the window.** Start a new chat. If that does not help, run `Ticket Sidekick: Copy MCP diagnostics` and send the report; read it first, since it shows the `chat.mcp.*` and sandbox settings as they are.
- **A tool answers with a setup step.** Jira is not configured yet, or the token is missing: follow the step, or run `@jira check` in a Local chat.

## Manual checklist for a Copilot chat

Use this after installing a new build, in a chat that runs in the Copilot harness, with Jira configured and `127.0.0.1` in `http.noProxy`:

1. Ask "check my Jira connection": `jira_check_connection` answers with your base URL and user.
2. Ask "show PROJ-123" (one of your tickets): `jira_view_ticket` answers with its fields, description, attachments and comments. On a branch named after a ticket, ask "show the ticket of this branch": the answer names the folder and branch it used.
3. Ask "list my Jira filters", then "run the filter <one of them>": `jira_list_my_filters` and `jira_find_tickets` answer.
4. Ask "find open bugs in PROJ with JQL": `jira_find_tickets` answers with a table.
5. Ask "which statuses can PROJ-123 move to?": `jira_workflow` answers.
6. Ask "list the Jira templates": `jira_list_templates` answers (or says the workspace has none).
7. Ask "load PROJ-123": `jira_load_ticket` writes `.jira-context/PROJ-123/` and names the files.
8. Type `/jira-brief PROJ-123`: the brief has all eight sections, and its sources list the comments and attachments it used.
9. Open the chat's tool list: no Jira capability is listed twice, for example both a view tool from this server and one from Agent Mode.
