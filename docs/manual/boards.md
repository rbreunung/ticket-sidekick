# Boards in Copilot Chats

A **board** is a page Ticket Sidekick opens in its own editor tab when you ask for it in a Copilot chat. Talk stays in the chat; a large table or a piece of work in progress goes on a board. The extension reads Jira and fills the page itself, so the chat model sees only whether the board opened.

Boards available now:

| Board | Ask for it | Typed command |
| --- | --- | --- |
| Security report | "show the security report for PROJ" | `/ts-jira security-report [PROJECT]` |
| Ticket list | "show my open bugs", "move my done tickets to Closed" | `/ts-jira search <JQL or filter>` |
| Stored sessions | "show the stored sessions" | `/ts-jira sessions` |

## What you need

- **Canvases turned on.** Boards are VS Code canvases, a Preview feature of Copilot chats: set `chat.canvases.enabled`, where your organisation allows it. While it is off, Ticket Sidekick shows a notice at every VS Code start. The extension never changes the setting.
- **`127.0.0.1` in `http.noProxy`.** The extension serves the page from this computer; see [Jira Tools for Copilot Chats](copilot-tools.md).
- **A chat in the project's window.** A board is served by the VS Code window whose workspace folder holds the chat's folder, so it uses that workspace's settings. A chat in a window without a folder cannot open one.

When a board cannot open, the chat answer names the reason.

## Security report

The report lists a project's unresolved Veracode and Waltz tickets by Fix Version, in release-date order, followed by the tickets not assigned to a release. Each row shows the source, the item, its rating, the ticket with its status, the Due Date and a flag: **Overdue**, or **Due before release** when the Due Date falls before the Fix Version's release date.

- **Project.** Without a project the report uses `ticketSidekick.jira.defaultProject`. A text that is not a project key is refused, never replaced by the default project.
- **Filters and sort.** Filter by release, flag and tool, and click a column title to sort; a second click turns the order around, a third takes it off. **Clear filters** resets both.
- **Save.** **Save full report as CSV** and **Save full report as Excel** always write the whole report of the reading shown, through VS Code's save dialog, in the same format as the import `export` replies. The CSV separator is `ticketSidekick.jira.overviewCsvDelimiter`.
- **Refresh** reads Jira again. Filters and sort stay.

## Ticket list

The ticket list shows the tickets of a JQL query or of a saved filter (by id or name), up to 300, with ticket, summary, status, type, assignee and priority. Click a column title to sort.

Copilot opens this board whenever you ask to see a list of tickets or to change more than one ticket. It does not list the tickets in chat, and it does not get them: the answer says only that the board opened. Ask a question about tickets ("how many open bugs do I have?") and Copilot answers in chat from its own search instead.

**Changing several tickets**

1. Select the tickets with their checkboxes, or **Select all**.
2. Choose one change: **Move to status** (with an optional resolution) or **Set field** (a field's name or id, and a value), then **Set change**.
3. **Preview** lists exactly what will be written to each selected ticket. Nothing is written yet.
4. **Apply** writes. When the change touches more than one ticket, or closes a ticket, VS Code asks you to confirm in its own dialog first.

After Apply the board reads the list again and shows a result per ticket: **Done**, **Failed** with Jira's reason, or **Not written**.

- **A change Copilot proposed.** When you asked for a change in chat ("move my done tickets to Closed"), the board opens with that change filled in, marked "Proposed by Copilot", and every row selected. Check it, deselect rows, then preview and apply. Copilot cannot apply it.
- **Jira is the truth.** Before writing, the board reads each ticket again. A ticket that changed in Jira since the board read it is not written to; it is listed under the title with its stored and its current status, until you press **Drop**. The same happens when a restored list is checked: a selected ticket that changed or left the list is taken out of the selection and named.
- **Moves** use a direct transition when there is one, else the workflow path Ticket Sidekick has cached for the project and issue type, discovering it once if needed.
- **Fields** summary, description, priority, assignee, labels, components and fix version are set as the `jira_update_field` tool sets them. Any other field is found by its display name or id.

Cleanup by the `cleanupRules` of `.jira-templates.json` is not on this board yet; use `@jira cleanup` in a Local chat until it is.

## How a board keeps its data

Every board shows a **session**: the data it read and what you set on the board. The page itself holds nothing.

- **As of.** The line under the title says when the data was read. Jira, Bitbucket and report files stay the truth; the session is a cache of them.
- **Opening again.** Asking for the same thing again (the same project, query or filter) continues its session. The board appears at once with the stored data, then checks the source in the background and updates.
- **After a restart.** A board that VS Code brings back shows its stored session, marked "restored session", and checks the source. If its window does not come back within about 30 seconds, the tab is closed; the session stays stored.
- **If the check fails.** The stored data stays on show, with a line saying the check failed and when the data is from.
- **Discard session** on a board deletes its session.

## Stored sessions

Sessions are kept in VS Code's storage for the workspace, outside your repository. They hold what the board shows: for the security report the keys, summaries and Due Dates of open vulnerabilities, for a ticket list its rows, your selection and the chosen change. They never hold credentials.

- `/ts-jira sessions` opens a board listing every stored session with its source, when its data was read, when it was last used and its size, with **Reopen**, **Delete** and **Delete all**.
- A session not used for `ticketSidekick.sessions.retentionDays` days (default 14) is deleted.
- `Ticket Sidekick: Clear stored sessions` in the Command Palette deletes all sessions of the workspace.
- After an update of Ticket Sidekick that changes a board's stored format, the old session is discarded and the board says so. Nothing in Jira is affected.
- A session too large to store works until VS Code closes; the board says it will not survive a restart.

## Limits

- Canvases are a Preview feature. A VS Code update can change them.
- A board works only in a Copilot chat in VS Code on this computer, not in Copilot CLI, the GitHub Copilot app or a remote agent host.
