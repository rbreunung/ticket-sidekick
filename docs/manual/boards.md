# Boards

A **board** is a page Ticket Sidekick opens in its own editor tab: a large table, or a piece of work in progress. The extension reads Jira and fills the page itself. When Copilot opens a board for you, it learns only whether the board opened, never what is on it.

| Board | Ask Copilot | Typed command | Command Palette |
| --- | --- | --- | --- |
| Security report | "show the security report for PROJ" | `/ts-jira security-report [PROJECT]` | `Ticket Sidekick: Open security report` |
| Ticket list | "show my open bugs", "move my done tickets to Closed" | `/ts-jira search <JQL or filter>` | `Ticket Sidekick: Open ticket list` |
| Cleanup (a ticket list loaded from a cleanup rule) | "run the cleanup Close released bugs" | `/ts-jira cleanup <rule> [in VERSION]` | `Ticket Sidekick: Run a cleanup rule` |
| Stored sessions | "show the stored sessions" | `/ts-jira sessions` | `Ticket Sidekick: Open stored sessions` |
| Import (Veracode or OSS report) | "import this Veracode report", with the file's path or the file dragged into the chat | `/ts-jira import <veracode or waltz> [PATH]` | `Ticket Sidekick: Open import board` |
| Pull request review | | | `Ticket Sidekick: Review a pull request` |

## What you need

- **Jira set up**, as described in the [README](../../README.md). There is nothing else to configure: no server, no port and no proxy setting.
- **For the Command Palette: nothing else.** The board commands work without Copilot.
- **For asking Copilot: Agent mode.** Copilot opens a board through the `jira_open_board` tool; see [Jira Tools for Copilot Chats](copilot-tools.md).

`Ticket Sidekick: Open import board` opens the import's start screen; see [Import board](#import-board).

`Ticket Sidekick: Open ticket list` asks for a JQL query; type `filter:` and a saved filter's id or name to open a filter instead. `Ticket Sidekick: Run a cleanup rule` lets you pick a rule from `.jira-templates.json` and, optionally, a fix version.

## Security report

The report lists a project's unresolved Veracode and Waltz tickets by Fix Version, in release-date order, followed by the tickets not assigned to a release. Each row shows the source, the item, its rating, the ticket with its status, the Due Date and a flag: **Overdue**, or **Due before release** when the Due Date falls before the Fix Version's release date.

- **Project.** Without a project the report uses `ticketSidekick.jira.defaultProject`. A text that is not a project key is refused, never replaced by the default project.
- **Filters and sort.** Filter by release, flag and tool, and click a column title to sort; a second click turns the order around, a third takes it off. **Clear filters** resets both.
- **Save.** **Save full report as CSV** and **Save full report as Excel** always write the whole report of the reading shown, through VS Code's save dialog, in the same format as the import board's overview export. The CSV separator is `ticketSidekick.jira.overviewCsvDelimiter`.
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

## Import board

The import board turns a Veracode Detailed Report (`.xml`), a Waltz OSS Report (`.xlsx`) or one or more `.eml` emails into Jira tickets. It replaces the `@jira` imports and their Command Palette commands. The import rules are the same as before: which findings fold into one ticket, the labels, the Due Dates, rewrite, the ticket merge, the accepted list, and for emails the boilerplate cleanup with its consent. They are described in [Report Imports](report-imports.md).

### Opening an import

- **Command Palette.** `Ticket Sidekick: Open import board` opens the start screen. Pick **Veracode**, **Waltz OSS** or **Email**, then **Choose file…** (for emails, **Choose emails…**, which takes several `.eml` files). The start screen reads the report at once and says how many items pass your filter settings. A file that is too large, cannot be read or has no matching item is named with the reason, and the import cannot be opened.
- **Template.** The template comes from `ticketSidekick.veracode.template`, `ticketSidekick.waltz.template` or `ticketSidekick.email.template`. When the setting is empty, or names a template that is no longer in `.jira-templates.json`, the start screen asks for a template and saves your choice to the setting. The next import of that kind does not ask again. The issue type comes from the template. When the template names none, pick one of the project's issue types; when Jira cannot list them, type it.
- **Project.** The project is `ticketSidekick.jira.defaultProject`. When it is empty, is not a project key, or Jira does not know it, the start screen asks for it: type the project key, or start typing and choose from the projects Jira shows you. A typed key is checked with Jira, so it works even when the list is long or cut short. The project is saved to the setting, so the next import does not ask, and the tools and other boards use it too. When Jira's project list cannot be read, the start screen says so and you type the key; **Open Setting** is always there too.
- **Jira not set up.** The start screen shows how to set up Jira instead of **Open**.
- **Email: the model of the check.** For an email import the start screen shows the model the boilerplate check uses, lets you pick one (saved to `ticketSidekick.email.checkModel`) and confirms with one short call, without email text, that the model answers.
- **From Copilot.** In Agent mode, ask for the import with the report's path, or drag the file into the chat ("import this Veracode report"), or type `/ts-jira import veracode reports/scan.xml` (for emails, `/ts-jira import email` with the `.eml` paths or the emails attached; attaching them counts as agreeing to the model check). The board opens with the report loaded when the file reads and the template and project settings are complete. Otherwise the start screen opens with the kind and the file filled in. Copilot learns only whether the board opened.
- **The same file again.** The same report file in the same project opens the stored import, with the template it was started with. The start screen then offers **Open stored import** and **Start over**. Start over discards the stored import and starts again with the template now in the setting. When a new scan was saved over that file, the stored import reads it and asks again for a decision on every row, also on tickets it wrote for the earlier scan.

### The tabs

The line at the top names the report kind, the file, the project, the template and the issue type. Below it is one tab per group, each with its row count: **New**, **Already ticketed**, **Stale**, and for Waltz **Accepted**. Each tab has its own filter, its own controls and its own Preview and Apply, so a preview never mixes groups. The board opens on the first tab with work left. A tab shows all its rows, without pages.

**New**: findings (Veracode) or components (Waltz) without a ticket.

- The **Create** checkbox puts a row in the create. **Select all** and **Select none** set every row.
- **Merge selected** folds the selected rows into one ticket, and **Unmerge** splits them again. A merge stays on the board until you unmerge it or create the ticket.
- **Preview create** lists the tickets to create. A Veracode ticket gets its Due Date from `ticketSidekick.veracode.slaDays`. When Jira refuses the Due Date field, the ticket is created without it and its result says so.
- **Add selected to ticket**: type a ticket key, choose **as a comment** or **as a rewrite**, then **Preview add…**. The preview reads the ticket first and shows its summary and status. It warns when the ticket is resolved, and for a rewrite it lists the findings the ticket records that the rewrite drops. A comment adds the labels and one comment; it does not settle that ticket's rows on Already ticketed.
- Waltz only: **Preview accept CVEs of selected…** and **Preview accept components of selected…**, with an optional reason. CVEs can be accepted from New rows only.

**Already ticketed**: report items that already have a ticket.

- The tab opens on **Changed**: the rows whose findings changed since their ticket was written, and the tickets that have no Due Date yet (marked "No Due Date"). **Unchanged** and **All** show the other rows. Each filter shows its count.
- Each row shows its ticket with status, the finding, what changed, and its action: **rewrite**, **leave**, or **new ticket** when every ticket of the item is resolved. What each does is in [Report Imports](report-imports.md#reviewing-an-import).
- When a finding has more than one open ticket, the Ticket cell names the others under "also open:" (up to three, then a count). A changed date shows the ticket's recorded date next to the report's, for example `Planned date none → 2026-12-15`; a Veracode ticket without a Due Date shows `Due Date missing → <date>`.
- **Set all shown to** changes the action of the rows the filter shows, and no other row. **Preview changes…** writes the action of every row, shown or not.
- A rewrite rebuilds the whole ticket, so the rows of one ticket are all on **rewrite** or none of them; the preview refuses a mix and names the rows.
- A ticket that changed in Jira since the board read it is not written to. Its result says so, and the board lists it with its stored and current state until you drop it. When the board could not read the tickets' update times, it says so above the tabs, and Already ticketed writes nothing until a **Refresh** reads them.
- Pick rows with their checkboxes for a ticket merge (below). Waltz only: **Preview accept components of picked…**.

**Stale**: open tickets whose finding is no longer in the report.

- Check the tickets to close. For each issue type among them, choose **Move to**: your matching cleanup rules first, then every status the workflow can reach. A closing status that no rule gives a resolution also asks for a **Resolution**. One Apply closes the tickets of every issue type that has its answers.
- A ticket without a discovered workflow cannot be checked, and its row says why; `/ts-jira workflow <KEY>` discovers it.
- When the search for stale tickets fails, the tab says so and the other tabs still work.

**Accepted** (Waltz only): the entries of `.jira-oss-accepted.json`, with **Unaccept…** for a CVE and **Unaccept component…** for a whole component. When the list hid anything from this report, a line above the tabs says how much, for example "2 accepted CVEs hidden · 1 accepted component hidden". When the file cannot be read in full, accept and unaccept are refused with the warning and the file is left alone.

### Preview, Apply and the VS Code dialog

- Every change is a preview first, then **Apply**. VS Code asks in its own dialog when the change writes more than one ticket or closes a ticket. Accept, unaccept and **Reload report** write nothing to Jira and ask no dialog.
- One Apply writes at most 50 tickets. The preview says how many remain for the next Apply. A rewrite of one ticket is never split between two Applies.
- While an Apply runs, the board shows its progress and disables every control except the tabs. Each finished write is saved at once; see [How a board keeps its data](#how-a-board-keeps-its-data).
- Each row then shows its result: created or written, **Failed** with the reason, or **Not written**.

### Ticket merge

On Already ticketed, pick the rows of the tickets to merge and choose the ticket to keep, from the picked ones or by typing its key. **Preview merge tickets…** reads the tickets and shows the steps, the warnings and any missing Jira pieces. Apply always asks the VS Code dialog, then opens a **Ticket merge** tab that lists each step with its status. A Waltz merge rewrites the kept ticket; a Veracode merge closes the others. See [Merging tickets](report-imports.md#merging-tickets).

- **A failed step** stops the merge. **Retry…** runs it again, **Ignore…** skips it and goes on, **Stop…** ends the merge. Each is a preview and an Apply.
- **Before the closes**, choose the target status and, where asked, the resolution for every issue type of the tickets to close. Then **Preview close…**: one Apply closes them all.
- **While the merge is unfinished**, Apply on every other tab is refused. You can still make your choices there.
- **When the merge ends**, the tab lists the steps that were not done and the tickets Jira closed without their resolution. **Acknowledge and close this tab** closes it.
- **After a restart** the merge tab comes back with its finished, failed and waiting steps and its open question.

### Out of date and Refresh

The board checks the report file and Jira when it opens, after a restart and when you press **Refresh**.

- A tab whose rows changed, and on which you have no unfinished choices, shows the new reading at once. The board's own writes never count as a change, also after a restart.
- A tab with unfinished choices is marked **out of date** and offers only **Refresh**. Unfinished choices are New rows left out or merged, actions you changed on Already ticketed, checked Stale tickets, and a running ticket merge.
- **Refresh** keeps every choice whose rows still exist and lists the choices it dropped, each with the reason. **Dismiss** hides that list.
- The same happens after **Unaccept** and after a ticket merge ends.
- **Refresh during a ticket merge** reads every tab except Already ticketed, which stays on the reading the merge started from and stays marked until the merge ends.
- **Reload report…** reads the report file and Jira again, and also picks up edits to `.jira-oss-accepted.json`. Its preview lists each unfinished choice as "kept if the row is still in the report, dropped otherwise"; after Apply the dropped ones are named.

### When something is missing

- **The report file was moved or deleted.** The board keeps showing what it read, and refuses every write. **Pick the file again…** opens the file dialog; your choices stay. When another stored import already uses the picked file, the board refuses and names it.
- **The search for existing tickets failed.** The board keeps showing what it read and writes nothing until a check passes; press **Refresh** once Jira answers. A partial search could show items as New that already have a ticket.
- **The search for stale tickets failed.** Only the Stale tab is unavailable.

### Search and export

- **Search matched tickets** lists the open tickets this import matched whose summary contains the text. It makes no Jira call; for another ticket, type its key in **Add selected to ticket**.
- **Save overview as CSV…** and **Save overview as Excel…** save this report's overview by Fix Version, with the due-date columns, as described in [Report Imports](report-imports.md#security-report-open-veracode-and-waltz-tickets-by-release). It is built from the reading the board shows, with no new Jira read, so a stale ticket the board closed is left out. The CSV separator is `ticketSidekick.jira.overviewCsvDelimiter`. An overview with no rows is saved as a file with the header row only.

### Finished

When no tab has work left, the board says there is nothing left to do and offers **Close**. The import stays, with export and **Reload report**, until you close it or it expires after `ticketSidekick.sessions.retentionDays`.

## How a board keeps its data

Every board shows a **session**: the data it read and what you set on the board. The page itself holds nothing.

- **As of.** The line under the title says when the data was read. Jira, Bitbucket and report files stay the truth; the session is a cache of them.
- **Opening again.** Asking for the same thing again (the same project, query or filter) continues its session. The board appears at once with the stored data, then checks the source in the background and updates.
- **After a restart.** VS Code brings a board's tab back with the window, and the board shows its stored session, marked "restored session", then checks the source.
- **If the check fails.** The stored data stays on show, with a line saying the check failed and when the data is from. A board that writes applies nothing until a check passes: it offers paging and **Refresh** only.
- **While Apply runs** the board shows its progress and disables every control except its tabs. Each finished write is saved at once, so a board brought back after VS Code closed in the middle of an Apply shows the finished tickets as done, and the next preview covers only the rest.
- **Close** on a board deletes its session and closes its tab. Closing the tab with its × keeps the session, so the board opens again where you left it.

## Stored sessions

Sessions are kept in VS Code's storage for the workspace, outside your repository. They hold what the board shows: for the security report the keys, summaries and Due Dates of open vulnerabilities, for a ticket list its rows, your selection and the chosen change, for an import the report's rows, the matched tickets, your choices and a running ticket merge. They never hold credentials.

- `/ts-jira sessions` opens a board listing every stored session with its source, when its data was read, when it was last used and its size, with **Reopen**, **Delete** and **Delete all**.
- A session not used for `ticketSidekick.sessions.retentionDays` days (default 14) is deleted.
- `Ticket Sidekick: Clear stored sessions` in the Command Palette deletes all sessions of the workspace.
- After an update of Ticket Sidekick that changes a board's stored format, the board is built again from what it was opened with (its project, query, filter, cleanup rule or report file) and says it was rebuilt after an update. Your earlier choices on it are not kept. A board whose source no longer holds (for example a deleted cleanup rule) is discarded and says so. Nothing in Jira is affected.
- A session too large to store works until VS Code closes; the board says it will not survive a restart.

## Limits

- A board belongs to the VS Code window that opened it and shows that window's workspace sessions.
- The pull request review has no board yet. Until it does, it runs in the deprecated `@bitbucket` chat participant.
- The same import open in two VS Code windows is not locked. The search for tickets that already exist, the check of each ticket before it is written and the out-of-date mark catch most collisions, but not all: work on one import in one window.
