# Jira Tools for Copilot Chats (MCP)

Part of `@jira` — gives Copilot chats that cannot use `@jira` a set of Jira tools and three skills: a developer brief, a guided ticket create and `/ts-jira`, which runs a Jira command you type. See the main [README](../../README.md) for the Jira setup first.

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

### Tools that read Jira

These change nothing in Jira. `jira_workflow` and `jira_load_ticket` write local files in the first workspace folder.

| Tool | What it does | Inputs |
| --- | --- | --- |
| `jira_check_connection` | Checks the Jira connection: base URL, auth type, whether a token is stored, and the signed-in user, or what is missing or wrong. Gives the same answer as `@jira check` | none |
| `jira_view_ticket` | Shows one ticket in full: the fields your display settings choose (`ticketSidekick.jira.additionalDisplayFields`, `ticketSidekick.jira.hiddenDisplayFields`), the whole description, the attachments with name, size and type, and the comments, newest first, up to 100 | `ticketKey` (optional: without it, the key in the current git branch of the first workspace folder is used, and the answer names that folder and branch) |
| `jira_find_tickets` | Finds tickets by JQL or by a saved filter, 50 per page, with the columns from `ticketSidekick.jira.searchFields`. "My team" means the team JQL in `ticketSidekick.jira.myTeamJql` | `jql` or `filter` (a saved filter's id or name); optional `fixVersion`, `sprint`, `assignee` (`me` for you), `myTeam`, and `page` to read the next page |
| `jira_list_my_filters` | Lists your favourite and own saved filters, each once, with name and id | none |
| `jira_workflow` | Lists the statuses a ticket can be moved to from its current status, with the transitions that lead there. When no workflow is cached for the ticket's project and issue type, it learns it from Jira and saves it to `.jira-workflow-cache.json`, the same cache `@jira` uses | `ticketKey`; optional `refresh` to learn the workflow again |
| `jira_list_fields` | Lists every field of a ticket with its name, id and current value, custom fields included. Without a ticket, for a project and an issue type, lists the fields that type can take when a ticket is created, with name, id and whether Jira requires each. Use it to find a field id for `ticketSidekick.jira.additionalDisplayFields` or a template | `ticketKey`, or `projectKey` and `issueType` |
| `jira_check_required_fields` | Checks a ticket against the fields listed in `ticketSidekick.jira.requiredFields` and names the empty ones | `ticketKey` |
| `jira_open_board` | Opens a board in its own editor tab: the security report of a project, a ticket list for a JQL query or saved filter, or the stored sessions. For a ticket list, Copilot can pass a change you asked for, which the board shows as proposed. The answer says only whether the board opened; see [Boards](boards.md) | `board` (`security-report`, `ticket-list` or `sessions`); `project` for the security report; `jql` or `filter`, and optionally `change`, for a ticket list |
| `jira_list_templates` | Lists the templates in your workspace's `.jira-templates.json`, each with its issue type, the field values it sets and its description sections | none |
| `jira_load_ticket` | Downloads a ticket into `.jira-context/<KEY>/` in the first workspace folder, like `@jira load`: `ticket.md`, `comments.md` and the text, image, document and archive attachments. It names every file it wrote by its full path and every attachment it skipped, with its size and the reason. Files over 100 MB are never downloaded. An attachment that has not finished downloading after 2 minutes is listed as skipped (download failed), and everything else is still written. The skipped attachments that can still be fetched are numbered, and Copilot asks you which to download: answer with numbers such as `1, 3`, or `all`, and it loads them | `ticketKey` (optional, as for `jira_view_ticket`); optional `attachments`, a list of attachment names to download as well, including ones the default filter skips |

### Tools that change Jira

Copilot asks you before each of these runs (see [Approvals](#approvals)). Free text is written as Markdown and reaches Jira as wiki markup, as from `@jira`. If Jira does not answer within 30 seconds, the tool says the change may still have been saved and asks Copilot to look at the ticket before trying again; the same call within the next minute is skipped, so it is not sent twice. A call Jira refused can be retried at once.

| Tool | What it does | Inputs |
| --- | --- | --- |
| `jira_move_ticket` | Moves a ticket to a status, in one transition or along several. When no path is known yet, it learns the workflow from Jira first and saves it to `.jira-workflow-cache.json`. The answer names the status the ticket came from and each transition taken. A move that stops partway is reported as failed, with the status the ticket was last confirmed in and the step that failed, and is not retried; when a step got no answer in time, it says the step may still go through. The same move asked for again within a minute is skipped | `ticketKey`, `targetStatus`; optional `resolution` for a last step that asks for one |
| `jira_create_ticket` | Creates one ticket, preferably from a template in `.jira-templates.json`, and lists the template fields it applied. It never guesses the issue type: without one and without a template that sets one, it lists the project's issue types and creates nothing. The same ticket asked for again within a minute is skipped | `projectKey`, `summary`; `templateName` or `issueType`; optional `description` (Markdown) |
| `jira_add_comment` | Adds a comment. The same comment on the same ticket within a minute is skipped, so a repeated call does not post it twice | `ticketKey`, `comment` (Markdown) |
| `jira_update_field` | Sets one field, named by display name or id: summary, description, priority, assignee, labels, components, fix version, sprint, or any other field such as a custom field. For a list field, `operation` `add` or `remove` changes single values and keeps the rest. It quotes the value the field had before. A field name it does not find, or a sprint name that matches none or several sprints, changes nothing. The same value for the same field within a minute is skipped | `ticketKey`, `fieldName`, `value` (the description as Markdown; list values comma-separated; assignee a name, an email or `me`; a sprint by name); optional `operation` (`set`, `add`, `remove`) |
| `jira_upload_attachment` | Attaches a file to a ticket. Only files inside an open workspace folder are accepted, wherever that folder is; a file in a hidden folder such as `.config` (also when the workspace folder itself is one, lies inside one or links into one), a symlink that points out of the workspace and a file over 25 MB are refused. The same file to the same ticket within a minute is skipped | `ticketKey`, `filePath` (absolute, or relative to the first workspace folder) |

## Skills

A skill is a set of instructions Copilot follows, using the tools above. Type its name as a slash command in a Copilot chat. `/ts-jira` and `/ts-jira-brief` run only when you type them, so Copilot never starts one in place of another request. `/ts-jira-create` also starts by itself when you ask for a new ticket in your own words, so a new ticket goes through a template and a draft. For everything else, just ask and Copilot calls the tools directly.

| Skill | What it does |
| --- | --- |
| `/ts-jira-brief` | Writes a developer brief of one ticket, e.g. `/ts-jira-brief PROJ-123`. It reads the ticket with `jira_view_ticket`, loads it with `jira_load_ticket` and reads the attachments that matter; when the load skipped some, it shows you their numbered list and asks which to download before it writes. It writes eight sections: problem or goal; context; steps to reproduce with expected and actual result; acceptance criteria; decisions and findings from comments, with author and date; current state; open questions and missing information; and the sources it used. A section the ticket does not cover says "not stated in the ticket", acceptance criteria it worked out itself are marked "(derived)", and it lists the attachments it could not read |
| `/ts-jira-create` | Creates one ticket with you, e.g. `/ts-jira-create a bug for the failing login in PROJ`. It looks for a template in `.jira-templates.json` that fits, asks only for what it cannot tell from your request (such as the project or, without a template, the issue type), drafts the summary and the description, shows you the draft and creates the ticket with `jira_create_ticket` once you agree |
| `/ts-jira` | Runs one Jira command you type, without Copilot choosing the tool: `/ts-jira load PROJ-123`, `/ts-jira view`, `/ts-jira search project = PROJ AND status = Open`, `/ts-jira comment PROJ-123 Fixed in build 42`, `/ts-jira move PROJ-123 Done`, and `filters`, `field`, `fields`, `check-fields`, `workflow`, `templates`, `upload`, `check`. `search`, `security-report` and `sessions` open a board in its own editor tab instead of answering in chat; see [Boards](boards.md). `/ts-jira help brief` and `/ts-jira help create` explain the two skills below and what to do without them. Without a ticket key, `load` and `view` use the ticket of your git branch. `/ts-jira` alone or `/ts-jira help` lists the commands, `/ts-jira help load` shows the help of one command without running it, and a command missing its ticket key or text shows its help line instead of running. Copilot only runs it when you type it, so it never gets in the way of plain requests |

## Approvals

Copilot decides when to ask you before a tool runs, from its own tool-approval settings; Ticket Sidekick adds no confirmation of its own. The tools that only read Jira are marked as read-only, so Copilot knows they change nothing. Any tool on this server that changes Jira is marked as such and is approved through Copilot's own tool approval, which shows the tool's arguments. If you set Copilot to approve tools automatically, they run without asking.

## When the MCP server is blocked

An organisation can limit which MCP servers Copilot may start. Ticket Sidekick's server then stays stopped: **MCP: List Servers** shows it in an error state, and `Ticket Sidekick: Copy MCP diagnostics` quotes VS Code's log line "MCP server 'Ticket Sidekick' is blocked by policy".

Set `ticketSidekick.jira.toolsFrom` to `"extension"`. Copilot then gets the same Jira tools from the extension itself, with the same names, inputs and answers, and the `/ts-jira` commands and skills work as described on this page. Tools that change Jira ask first and show every value they are about to write. The boards keep working either way, also from the Command Palette; see [Boards](boards.md).

## Diagnostics

Run `Ticket Sidekick: Copy MCP diagnostics` from the Command Palette. It copies a report to the clipboard: server state, whether it is offered and why not, request and tool-call counts, the proxy-related settings, the `chat.mcp.*` and sandbox settings, and whether the key turns up in stored files. Every key and token is removed. It leaves out tool arguments and your Jira base URL, and of `http.noProxy` it lists only the loopback entries and counts the rest. Folders and files under your home folder appear with `~`. The search for stored keys stops after 512 MB of files, and you can cancel it from the notification; either way the report is still copied and says the search is incomplete.

The `chat.mcp.*` and sandbox settings appear as they are, so a sandbox allow-list can name internal hosts: read the report once before you send it on.

## Troubleshooting

- **The tools do not show up.** Check that `http.noProxy` contains `127.0.0.1` exactly and that you run VS Code 1.101 or later.
- **The Jira tools stop answering after you changed `http.noProxy` or reloaded the window.** Start a new chat. If that does not help, run `Ticket Sidekick: Copy MCP diagnostics` and send the report; read it first, since it shows the `chat.mcp.*` and sandbox settings as they are.
- **Load answers that `.jira-context/<KEY>` or its `attachments` folder is a link.** Load never writes through a link inside a ticket's folder, since a link planted there (for example by a cloned repository) could redirect its writes outside the workspace. Delete that link and load again. `.jira-context` itself may be a link, for example to another disk.
- **A tool answers with a setup step.** Jira is not configured yet, or the token is missing: follow the step, or run `@jira check` in a Local chat.

## Manual checklist for a Copilot chat

Use this after installing a new build, in a chat that runs in the Copilot harness, with Jira configured and `127.0.0.1` in `http.noProxy`:

1. Ask "check my Jira connection": `jira_check_connection` answers with your base URL and user.
2. Ask "show PROJ-123" (one of your tickets): `jira_view_ticket` answers with its fields, description, attachments and comments. On a branch named after a ticket, ask "show the ticket of this branch": the answer names the folder and branch it used.
3. Ask "list my Jira filters", then "run the filter <one of them>": `jira_list_my_filters` and `jira_find_tickets` answer.
4. Ask "find open bugs in PROJ with JQL": `jira_find_tickets` answers with a table.
5. Ask "which statuses can PROJ-123 move to?": `jira_workflow` answers.
6. Ask "list the Jira templates": `jira_list_templates` answers (or says the workspace has none).
7. Ask "load PROJ-123": `jira_load_ticket` writes `.jira-context/PROJ-123/` and names the files. On a ticket with a binary attachment (for example a `.bin` or `.dat` file), Copilot shows a numbered list of the skipped ones and asks which to download; answer `all`, and they appear in `.jira-context/PROJ-123/attachments/`.
8. Type `/ts-jira-brief PROJ-123`: the brief has all eight sections, and its sources list the comments and attachments it used.
9. Ask "add the comment 'Checked in the Copilot chat' to PROJ-123": Copilot asks first, then `jira_add_comment` adds it. Ask the same again at once: the answer says it was skipped.
10. Ask "set the priority of PROJ-123 to High": `jira_update_field` asks first and quotes the previous priority.
11. Ask "move PROJ-123 to <a status two steps away>": `jira_move_ticket` asks first and names both transitions.
12. Ask "create a ticket in PROJ from the template <one of yours> with the summary 'Checklist ticket'": `jira_create_ticket` asks first and lists the template fields it applied. Delete the ticket afterwards.
13. Ask "attach README.md to PROJ-123": `jira_upload_attachment` asks first and uploads it. Ask to attach a file from outside the workspace: it is refused.
14. Type `/ts-jira-create a task in PROJ to update the onboarding guide`: it picks or asks for a template, shows the draft and creates the ticket only after you agree. Delete the ticket afterwards.
15. Type `/ts-jira`: it lists the commands. Type `/ts-jira load PROJ-123`: it loads the ticket with `jira_load_ticket`, without asking which skill to use.
16. Open the chat's tool list: no Jira capability is listed twice, for example both a comment tool from this server and one from Agent Mode.
