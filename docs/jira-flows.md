# Jira Feature Flows

> **Removed surface.** `@jira` was removed on 2026-11-16 with its email import, its help screen and its sessions. Veracode and Waltz reports moved to the import board (`src/boards/import/`) on 2026-11-15 and emails on 2026-11-16; every other Jira task runs from a tool, a `/ts-jira` skill or a board. New work is built as extension tools and boards; see [`docs/architecture/boards-and-sessions.md`](architecture/boards-and-sessions.md). The imports are documented in [`docs/report-import.md`](report-import.md).

The removed participant's code (`src/participant/`) is gone; the cleanup rules the ticket list board keeps live in `src/boards/ticketList/`, and the default-project notice in `src/services/defaultProjectNotice.ts`.

## Where the removed flows went

| Removed `@jira` flow | Now |
| --- | --- |
| create, with templates and section questions | `/ts-jira-create` and `jira_create_ticket` |
| view, summarize, show fields, check required fields, comments | `jira_view_ticket`, `jira_list_fields`, `jira_check_required_fields`, `jira_add_comment` |
| field, move, load, upload, workflow, check | `jira_update_field`, `jira_move_ticket`, `jira_load_ticket`, `jira_upload_attachment`, `jira_workflow`, `jira_check_connection` |
| search, filters, narrowing by fix version, sprint, assignee and team | `jira_find_tickets`, `jira_list_my_filters`, and the ticket list board through `jira_open_board` |
| bulk transition, bulk field update | the ticket list board |
| cleanup by `cleanupRules` | the ticket list board loaded from a rule (`src/boards/ticketList/cleanupSource.ts`) |
| `/security-report` | the security report board |
| Veracode and Waltz report imports, with their two Command Palette commands | the import board (`Ticket Sidekick: Open Jira Import Board`, `jira_open_board` with board `import`); see [`docs/report-import.md`](report-import.md#import-board-veracode--waltz) |
| description and comment preview | dropped |

The rules the cleanup board keeps from `@jira run cleanup` are below.

## Bulk cleanup rules

The ticket list board runs these rules (`src/boards/ticketList/cleanupSource.ts` for the query, subtasks and paths, `kind.ts` for selection and Apply). `cleanupRules` in `.jira-templates.json` define named rules:

- `name`, `project`, `issueType`, `targetState` — required; `checkCleanupRules` (`cleanupSource.ts`) sets aside a rule missing one, `lookupCleanupRule` refuses it with the missing field, and the Command Palette picker lists only complete rules
- `resolution` — optional; sent only with a move to a final status (`isFinalStatus` in `src/utils/finalStatus.ts`: Jira's Done category from `getDoneStatuses`, cached as `doneStatuses` in `.jira-workflow-cache.json`, else the shared name list). If omitted and the target is final, a resolution (or none) is chosen on the board before Apply; a move refused with a resolution is retried once without one
- `subtaskResolution` — resolution for subtask transitions; falls back to `resolution` if omitted
- `subtaskTargetState` — target status for subtasks; falls back to `targetState` if omitted
- `closeSubtasks` — if true, the parents' open subtasks are read a hundred parents per query (`parent in (...)`), listed beneath their parent and moved before it
- `fixVersionFilter` — `"released"` or `"unreleased"`; adds `fixVersion in releasedVersions()` / `unreleasedVersions()` to the JQL
- `fixVersionPattern` — glob pattern (e.g. `"Release*"`); adds `fixVersion ~ "pattern"` (Jira 11+ / modern DC); mutually exclusive with `fixVersionFilter`
- `jql` — extra JQL ANDed onto the base query; `project`, `issueType`, the target status and `resolution is EMPTY` are always anchored; extra JQL with `ORDER BY` is left out and the board says so

Fix version override: `in VERSION` (`fixVersion` on `jira_open_board`) wins over the rule's fields — `released` / `unreleased` (JQL functions), a value with `*` (pattern), or a version name; a name in double quotes (`"released"`) is always a version of that name.

Start: `/ts-jira cleanup "rule name" [in VERSION]`, a plain request, or `Ticket Sidekick: Run a cleanup rule`. The text is matched exactly first; otherwise the longest known rule name followed by ` in ` wins and the rest is the fix version, so a rule named with " in " is still found. A board opened with a proposed move ("close the PROJ bugs in 3.2") is the ad-hoc form; it has no subtasks but applies page by page too.

When the board loads, every row gets its target status and a path through the cached workflow, discovering the workflow once per issue type when none is cached. A parent cannot be selected when it has no path, when one of its subtasks has none, or when its chunk of the subtask search reached the read limit (some open subtasks could not be listed). Only parents are selected; their subtasks follow.

`ticketSidekick.jira.cleanupFields` adds one column per configured field to a cleanup board and to a list opened with a proposed move, for parent and subtask rows, in place of `ticketSidekick.jira.searchFields`. Values are rendered as plain text by `renderFieldValue`; a configured field ID that matches no known field logs one warning to the "Ticket Sidekick" Output Channel per read. `ticketSidekick.jira.securityReportFields` adds columns after the always-shown Assignee to the security report, the import board's Already ticketed tab and both overview exports through the shared resolver in `src/services/extraColumns.ts`; an unknown id is skipped there rather than kept. The extra columns of the ticket list and those sort in natural order (`src/utils/naturalCompare.ts`).

Apply writes the selected parents of the page in view, after the R39 native confirmation: subtasks first, then the parent; a parent whose subtask was not moved stays as it is and its result names the subtask. Each ticket is read again first and one that changed since the board read it is not written to. After Apply the rule's query no longer lists the moved tickets, so the next ones move up onto the same page, still selected.

## Jira sessions

There are no Jira chat sessions any more. They went with `@jira` on 2026-11-16, and a value an older build left under one of their `workspaceState` keys (`jira.session.*`) is never read. Multi-step Jira work is a board's session: the ticket list board's session and the import board's session (email, Veracode and Waltz) are described in [`docs/architecture/boards-and-sessions.md`](architecture/boards-and-sessions.md) and [`docs/report-import.md`](report-import.md#import-board-veracode--waltz). The clickable replies, the confirm and cancel words and the per-row toggle links of the chat went with them; a board has controls instead.
