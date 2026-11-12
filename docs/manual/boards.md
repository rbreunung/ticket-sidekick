# Boards in Copilot Chats

A **board** is a page Ticket Sidekick opens in its own editor tab when you ask for it in a Copilot chat. Talk stays in the chat; a large table or a piece of work in progress goes on a board. The extension reads Jira and fills the page itself, so the chat model sees only whether the board opened.

Boards available now:

| Board | Ask for it | Typed command |
| --- | --- | --- |
| Security report | "show the security report for PROJ" | `/ts-jira security-report [PROJECT]` |
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

## How a board keeps its data

Every board shows a **session**: the data it read and what you set on the board. The page itself holds nothing.

- **As of.** The line under the title says when the data was read. Jira, Bitbucket and report files stay the truth; the session is a cache of them.
- **Opening again.** Asking for the same thing again (the same project) continues its session. The board appears at once with the stored data, then checks the source in the background and updates.
- **After a restart.** A board that VS Code brings back shows its stored session, marked "restored session", and checks the source. If its window does not come back within about 30 seconds, the tab is closed; the session stays stored.
- **If the check fails.** The stored data stays on show, with a line saying the check failed and when the data is from.
- **Discard session** on a board deletes its session.

## Stored sessions

Sessions are kept in VS Code's storage for the workspace, outside your repository. They hold what the board shows, which for the security report means ticket keys, summaries and Due Dates of open vulnerabilities. They never hold credentials.

- `/ts-jira sessions` opens a board listing every stored session with its source, when its data was read, when it was last used and its size, with **Reopen**, **Delete** and **Delete all**.
- A session not used for `ticketSidekick.sessions.retentionDays` days (default 14) is deleted.
- `Ticket Sidekick: Clear stored sessions` in the Command Palette deletes all sessions of the workspace.
- After an update of Ticket Sidekick that changes a board's stored format, the old session is discarded and the board says so. Nothing in Jira is affected.
- A session too large to store works until VS Code closes; the board says it will not survive a restart.

## Limits

- Canvases are a Preview feature. A VS Code update can change them.
- A board works only in a Copilot chat in VS Code on this computer, not in Copilot CLI, the GitHub Copilot app or a remote agent host.
