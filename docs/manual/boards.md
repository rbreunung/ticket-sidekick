# Boards

A **board** is a page Ticket Sidekick opens in its own editor tab: a large table, or a piece of work in progress. The extension reads Jira and fills the page itself. When Copilot opens a board for you, it learns only whether the board opened, never what is on it.

| Board | Ask Copilot | Typed command | Command Palette |
| --- | --- | --- | --- |
| Security report | "show the security report for PROJ" | `/ts-jira security-report [PROJECT]` | `Ticket Sidekick: Open security report` |
| Ticket list | "show my open bugs", "move my done tickets to Closed" | `/ts-jira search <JQL or filter>` | `Ticket Sidekick: Open ticket list` |
| Cleanup (a ticket list loaded from a cleanup rule) | "run the cleanup Close released bugs" | `/ts-jira cleanup <rule> [in VERSION]` | `Ticket Sidekick: Run a cleanup rule` |
| Stored sessions | "show the stored sessions" | `/ts-jira sessions` | `Ticket Sidekick: Open stored sessions` |

## What you need

- **Jira set up**, as described in the [README](../../README.md). There is nothing else to configure: no server, no port and no proxy setting.
- **For the Command Palette: nothing else.** The board commands work without Copilot.
- **For asking Copilot: Agent mode.** Copilot opens a board through the `jira_open_board` tool; see [Jira Tools for Copilot Chats](copilot-tools.md).

`Ticket Sidekick: Open ticket list` asks for a JQL query; type `filter:` and a saved filter's id or name to open a filter instead. `Ticket Sidekick: Run a cleanup rule` lets you pick a rule from `.jira-templates.json` and, optionally, a fix version.

## Security report

The report lists a project's unresolved Veracode and Waltz tickets by Fix Version, in release-date order, followed by the tickets not assigned to a release. Each row shows the source, the item, its rating, the ticket with its status, the Due Date and a flag: **Overdue**, or **Due before release** when the Due Date falls before the Fix Version's release date.

- **Project.** Without a project the report uses `ticketSidekick.jira.defaultProject`. A text that is not a project key is refused, never replaced by the default project.
- **Filters and sort.** Filter by release, flag and tool, and click a column title to sort; a second click turns the order around, a third takes it off. **Clear filters** resets both.
- **Save.** **Save full report as CSV** and **Save full report as Excel** always write the whole report of the reading shown, through VS Code's save dialog, in the same format as the import `export` replies. The CSV separator is `ticketSidekick.jira.overviewCsvDelimiter`.
- **Refresh** reads Jira again. Filters and sort stay.

## Ticket list

The ticket list shows the tickets of a JQL query or of a saved filter (by id or name), up to 300, 50 to a page, with ticket, summary, status, type, assignee and priority. Click a column title to sort. When more than 300 tickets match, the board says so: narrow the query to see the rest.

Copilot opens this board whenever you ask to see a list of tickets or to change more than one ticket. It does not list the tickets in chat, and it does not get them: the answer says only that the board opened. Ask a question about tickets ("how many open bugs do I have?") and Copilot answers in chat from its own search instead.

- **Narrowing.** Ask for a fix version, a sprint, an assignee ("me" for yourself) or your team ("my team's open bugs", using `ticketSidekick.jira.myTeamJql`), and Copilot opens the board on the narrowed query; the query is shown under the title. A name that matches more than one version or sprint is named back in chat, and nothing opens.
- **Extra columns.** A list shows one more column for each field id in `ticketSidekick.jira.searchFields`. A list opened with a proposed move, and a cleanup, shows `ticketSidekick.jira.cleanupFields` instead.

**Changing several tickets**

1. Select the tickets with their checkboxes, or **Select all**. The selection holds across pages.
2. Choose one change: **Move to status** (with an optional resolution) or **Set field** (a field's name or id, how to change it, and a value), then **Set change**. For a list field such as labels or components, **Add value** and **Remove value** change one value and keep the others; **Set to** replaces the whole value.
3. **Preview** lists exactly what will be written to each selected ticket. Nothing is written yet.
4. **Apply** writes. When the change touches more than one ticket, or closes a ticket, VS Code asks you to confirm in its own dialog first; the dialog names every selected ticket, on every page.

After Apply the board reads the list again and shows a result per ticket: **Done**, **Failed** with Jira's reason, or **Not written**.

- **A change Copilot proposed.** When you asked for a change in chat ("move my done tickets to Closed"), the board opens with that change filled in, marked "Proposed by Copilot", and every row selected. Check it, deselect rows, then preview and apply. Copilot cannot apply it. A list opened with a proposed move applies the selected tickets **of the page in view** only, like a cleanup.
- **Out of date.** When the board finds that tickets changed in Jira, left the query or newly match it, it says it is out of date and you can only page until you press **Refresh**. Refresh shows the tickets as they are now and keeps your selection of every ticket still listed.
- **Jira is the truth.** Before writing, the board reads each ticket again. A ticket that changed in Jira since the board read it is not written to; it is listed under the title with its stored and its current status, until you press **Drop**.
- **Moves** use a direct transition when there is one, else the workflow path Ticket Sidekick has cached for the project and issue type, discovering it once if needed.
- **Fields** are set as the `jira_update_field` tool sets them: any field by its display name or id, a sprint by its name, a list field from comma-separated values.

## Cleanup

A cleanup is the ticket list loaded from a rule in the `cleanupRules` of `.jira-templates.json` ([Templates and cleanup rules](jira-templates-and-cleanup-rules.md)). Start it with "run the cleanup Close released bugs", `/ts-jira cleanup "Close released bugs"` or `Ticket Sidekick: Run a cleanup rule`.

- **Which tickets.** The rule's project and issue type, not yet in its target status and unresolved, with the rule's fix version filter and extra JQL. Add `in VERSION` to use another fix version: `released`, `unreleased`, a pattern with `*` such as `Release*`, or a version name; put the name in double quotes (`in "released"`) for a version that is called that. A rule whose own name contains " in " is still found: the longest rule name the request starts with wins, and what follows is the version.
- **Incomplete rules.** A rule without `name`, `project`, `issueType` or `targetState` is not run. Asking for it says which field is missing, and the Command Palette command lists only complete rules and names the skipped ones.
- **Rows.** Every ticket starts selected and shows the status it moves to. With `closeSubtasks`, each ticket's open subtasks are listed beneath it with their own target status and resolution. You select tickets only; their subtasks follow.
- **Paths.** When the board loads, it works out a path through the workflow for every ticket, discovering the workflow once when none is cached. A ticket without a path, or with a subtask without one, shows the reason and cannot be selected.
- **Resolution.** A resolution is sent only with a move to a final status: one in Jira's Done category, read with the workflow (in a workflow cached before that, a status named like Done, Resolved, Closed, Won't Fix, Rejected or Cancelled). When the rule moves tickets to a final status and names no resolution, choose one on the board, or **No resolution**, before you preview. A move Jira refuses with a resolution is tried once more without one.
- **Applying.** A cleanup applies the selected tickets **of the page in view**. The moved tickets leave the list, so the next ones move up onto the same page, still selected: check them and apply again for the rest. Subtasks move before their ticket. When a subtask is not moved, its ticket stays as it is and its result names the subtask.
- **The rule is read again** on every load and Refresh, so an edit to `.jira-templates.json` shows on the next Refresh. A cleanup asked for again with the same rule and fix version continues its board.

## How a board keeps its data

Every board shows a **session**: the data it read and what you set on the board. The page itself holds nothing.

- **As of.** The line under the title says when the data was read. Jira, Bitbucket and report files stay the truth; the session is a cache of them.
- **Opening again.** Asking for the same thing again (the same project, query or filter) continues its session. The board appears at once with the stored data, then checks the source in the background and updates.
- **After a restart.** VS Code brings a board's tab back with the window, and the board shows its stored session, marked "restored session", then checks the source.
- **If the check fails.** The stored data stays on show, with a line saying the check failed and when the data is from. A board that writes applies nothing until a check passes: it offers paging and **Refresh** only.
- **Discard session** on a board deletes its session.

## Stored sessions

Sessions are kept in VS Code's storage for the workspace, outside your repository. They hold what the board shows: for the security report the keys, summaries and Due Dates of open vulnerabilities, for a ticket list its rows, your selection and the chosen change. They never hold credentials.

- `/ts-jira sessions` opens a board listing every stored session with its source, when its data was read, when it was last used and its size, with **Reopen**, **Delete** and **Delete all**.
- A session not used for `ticketSidekick.sessions.retentionDays` days (default 14) is deleted.
- `Ticket Sidekick: Clear stored sessions` in the Command Palette deletes all sessions of the workspace.
- After an update of Ticket Sidekick that changes a board's stored format, the old session is discarded and the board says so. Nothing in Jira is affected.
- A session too large to store works until VS Code closes; the board says it will not survive a restart.

## Limits

- A board belongs to the VS Code window that opened it and shows that window's workspace sessions.
- The Veracode, Waltz and email imports and the pull request review have no board yet. Until they do, they run in the deprecated `@jira` and `@bitbucket` chat participants.
