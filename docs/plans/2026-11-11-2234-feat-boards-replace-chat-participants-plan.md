---
title: "Boards Replace the Chat Participants - Plan"
type: feat
date: 2026-11-11
topic: boards-replace-chat-participants
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Boards Replace the Chat Participants - Plan

> **Direction as of 2026-11-13, binding for all further planning:** Ticket Sidekick is built on **extension tools** (VS Code language model tools) and **editor views** (boards as webviews in editor tabs). The MCP server, the `ticketSidekick.jira.toolsFrom` setting, the canvas program, the agent plugin and the local HTTP server have been **removed from the code**. `@jira` and `@bitbucket` are **deprecated** and are removed when the import and review boards exist. Requirements and decisions below that mention MCP, canvases or `http.noProxy` are marked Replaced or Withdrawn. The built design is in [`docs/architecture/boards-and-sessions.md`](../architecture/boards-and-sessions.md), and what is done and still open in [`docs/architecture/migration-status.md`](../architecture/migration-status.md).

## Goal Capsule

- **Objective:** A developer does all Ticket Sidekick work in a Copilot chat: searches, cleanup, bulk edits, report imports and PR reviews included. Nothing needs `@jira`, `@bitbucket` or the Local harness any more.
- **Means:** A session model in the extension with a cache on disk, and on it boards shown as editor views (webviews in editor tabs): the security report, a ticket list board, an import board and a PR review board. The Jira and Bitbucket tools reach Copilot as VS Code language model tools ("extension tools"), and only that way: there is no MCP server and no canvas. `@jira` and `@bitbucket` are deprecated from now on, and each release deletes the participant flows it replaces.
- **Product authority:** The decisions in this Product Contract, made by the maintainer. Where this plan and `docs/architecture/copilot-harness-migration.md` disagree, this plan wins.
- **Open blockers:** None for planning. Board code starts only after the maintainer approved the architecture page (R47).

---

## Product Contract

### Summary

Boards open as editor tabs, asked for in a Copilot chat or from the Command Palette, and replace the remaining `@jira` and `@bitbucket` flows: a ticket list board, an import board for Veracode, Waltz and email, and a PR review board.
Each board shows a session that the extension owns and caches on disk, so a reload or restart reconnects to the same work. The security report runs on the same model.
The boards ship in that order. Each release deletes the participant flows it replaces, and after the third no chat participant is left.

### Problem Frame

Release 0.9.0 moved the single-ticket Jira work to tools and skills (over an MCP server then; the same tools are extension tools now). The larger workflows still exist only as `@jira` and `@bitbucket`: searches shown to the user, cleanup and bulk edits, the three report imports, and the PR review.
Chat participants do not run in the Copilot harness, which VS Code uses for new chats. A developer in a Copilot chat therefore has to switch harness for the larger work, and an organisation can turn the Local harness off altogether.

About 15,000 lines of participant and handler code are carried next to the new surface. Every user-facing change has to consider both.

A participant kept each multi-turn flow's state in `workspaceState` and showed it as chat text. A board replaces the text, but not the place where that state lives. Without one, a board loses unapplied work on every reload, and a half-finished ticket merge loses the record of which steps already ran.

### Key Decisions

Carried in from the security report canvas plan (`docs/plans/2026-11-09-2237-feat-security-report-canvas-plan.md`):

- **In Copilot chats, talk and decisions stay in chat and a large artifact opens in its own tab.** (session-settled: user-directed — chosen over a one-off exception for the security report: later boards build on the rule instead of asking again.) Governs R1. The tab is an editor tab; see "One route" below.
- **Only the window whose folder holds the chat's folder serves a board.** (session-settled: user-directed — chosen over any running window: workspace settings belong to their workspace.) Governs R6. With editor tabs this holds by construction: the window that opens the tab serves it.
- **(Withdrawn) Boards ship inside the extension as an agent plugin.** The canvas program and the plugin were removed on 2026-11-13; see "One route" below.

Carried in from `docs/architecture/copilot-harness-migration.md` (D4):

- **A write started on a board needs a preview and a second Apply click.** (session-settled: user-directed — chosen over the VS Code modal for every write: no second prompt after a deliberate click.) Governs R3. R39 narrows it for this plan.

Made for this plan:

- **One plan covers everything still participant-only.** (session-settled: user-approved — chosen over separate plans per area: the shared rules are decided once.)
- **Each participant flow is deleted in the release that ships its replacement.** (session-settled: user-directed — chosen over freezing the participants and removing them last, and over keeping them as a fallback: no code is carried twice.) Governs R32, R33.
- **One route: extension tools and editor views. The MCP server, the tools-route setting, the canvas program, the agent plugin and the local HTTP server are removed.** (session-settled: user-directed — chosen over keeping MCP and extension tools side by side behind a setting, and over keeping the canvas program built for later: the maintainer tested the extension tools and editor tabs locally, an organisation's Copilot policy blocked the MCP server, VS Code 1.146 did not register an extension's canvas, and a second route is a switch to operate and a source of confusion for later planning.) Governs R1, R2, R62. This replaces the two entries marked "(Replaced)" below.
- **A board page is loaded by its editor tab and talks to the extension over the webview's message channel.** (session-settled: user-approved — chosen over keeping the local server only to serve board pages: with MCP and canvases gone the server, its keys and the `http.noProxy` requirement had no other purpose.) Governs R1, R2.
- **`@jira` and `@bitbucket` are deprecated now and documented as deprecated.** (session-settled: user-directed — chosen over marking them only when they are removed: every document names the tools and boards as the current way, so a later planning session does not build on the participants.) Governs R37, R51.
- **(Replaced) A board's page is hosted in an editor tab the extension opens; canvases are switched off until VS Code delivers them reliably.** Replaced by "One route" above: the editor tab stays, the canvas route is removed instead of switched off.
- **(Replaced) The tools reach Copilot over MCP or as extension tools, chosen by a setting.** Replaced by "One route" above.
- **(Replaced) A board needs a canvas; there is no other surface.** (session-settled: user-directed — chosen over the same page in a plain editor tab, and over a reduced flow in chat: a web check found canvases being built out, not wound down.) Governs R2.
- **(Withdrawn) The experimental canvas API is a recorded risk with no extra safeguard.** No canvas is used.
- **All ticket lists shown to the user go on a board, built once as a general ticket list board.** (session-settled: user-directed — chosen over bulk review in chat with one batch tool.) Governs R7 to R9.
- **The agent keeps its find tool for its own lookups and for questions.** (session-settled: user-approved — chosen over removing the tool, and over a board for bulk work only.) Governs R12.
- **The agent may fill in the query and a proposed change, never the row choice.** (session-settled: user-approved — chosen over query only, and over a selection made by the model.) Governs R10.
- **A change the agent proposed is part of the session and is restored with it.** It stays marked as proposed until the developer applies or removes it. Governs R10.
- **An import is driven on the board only; the agent opens it and learns whether that worked.** (session-settled: user-approved — chosen over agent actions on the board, and over chat-driven imports with a read-only board: the board keeps large report tables out of the chat's context.) Governs R17.
- **An import board keeps every action of today's review screens.** (session-settled: user-approved — chosen over dropping export, and over a core-first release.) Governs R16.
- **An import starts on the board, with an optional path from chat or from a file dragged into the chat.** (session-settled: user-directed — chosen over board-only file choice and over keeping the Command Palette commands.) Governs R14, R15, R34.
- **The extension owns a session per board run; the page is a view of it.** (session-settled: user-approved — chosen over state kept in the page, and over rebuilding from the sources on every load: reload, reopened tab and restart reconnect to the same work, and every action is checked in the extension.) Governs R51, R52.
- **A session is stored in full.** (session-settled: user-directed — chosen over storing only working state and review findings, which would keep vulnerability rows off disk: every board can then show the stored state next to the fresh one.) Governs R53, R56.
- **The stored session is a cache; Jira, Bitbucket and the report file stay the truth.** (session-settled: user-approved — chosen over checking only on Refresh, and over reading fresh before showing anything.) Governs R55, R57.
- **One session per source, with expiry, a clear command and a sessions board.** (session-settled: user-directed — chosen over no list, over deleting a session when its tab closes, and over keeping sessions until cleared.) Governs R54, R58, R60.
- **The sessions list is its own small board.** (session-settled: user-approved — chosen over a tool answer in chat, and over a VS Code quick pick.) Governs R60.
- **The security report is finished inside this plan, on the session model.** (session-settled: user-directed — chosen over merging its branch first and aligning later, and over leaving it sessionless.) Governs R31, R61.
- **A dragged report is accepted with its cost.** (session-settled: user-approved — chosen over dropping the drag entry, and over excluding email: the board exists to save context, not to hide reports from the model.) Governs R15.
- **Bulk, closing and Bitbucket writes from a board also need a native VS Code confirmation.** (session-settled: user-approved — chosen over a dialog for every board write, over accepting the risk, and over leaving the mechanism to planning: a script running in a board page must not be able to complete a risky write by itself.) Governs R39.
- **Lists and multi-ticket changes go to the board, by instruction.** (session-settled: user-approved — chosen over write tools that refuse a run of changes, and over typed commands only.) Governs R44.
- **Mid-run prompts are steps on the board.** (session-settled: user-approved — chosen over native VS Code pickers, and over asking in chat before the board opens.) Governs R24, R25, R45.
- **Repeated emails are found by searching Jira for the subject.** (session-settled: user-directed — chosen over remembering which files produced a ticket, and over a warning only.) Governs R43.
- **Review findings are on the board, and the agent can read them on request.** (session-settled: user-approved — chosen over a board the agent cannot read, and over findings in chat with no canvas.) Governs R21, R22.
- **The PR review keeps all of today's features.** (session-settled: user-approved — chosen over an extra Explain control on the board, and over one review mode.) Governs R20, R21.
- **The extension makes its own review calls with a model named in a setting.** (session-settled: user-approved — chosen over a model the Copilot runtime picks, and over the chat agent reviewing by itself: the pipeline and the token counters stay as they are.) Governs R24.
- **The email boilerplate check has its own model setting.** (session-settled: user-directed — chosen over one model setting for all calls, and over dropping the model check.) Governs R25.
- **Bitbucket mirrors the Jira shape: extension tools and a `/ts-bitbucket` command.** (session-settled: user-approved — chosen over review-only tools, and over leaving the three Agent Mode tools as they are.) Governs R27.
- **Drafting text on an existing ticket gets no replacement.** (session-settled: user-approved — chosen over a show-first rule in the skills: the write tools' approval dialog shows the final text.) Governs R30.
- **Order: ticket list board, import board, review board.** (session-settled: user-approved — chosen over review first and over imports first: the list board establishes the shared parts the import board reuses.) Governs R32.
- **Step 1 closes the gaps 0.9.0 left, then removes every `@jira` flow except the imports.** (session-settled: user-approved — chosen over dropping any-field updates and the field commands, and over keeping `@jira` for them until step 2.) Governs R33, R40 to R42.
- **Fields can be listed per ticket and per project and issue type.** (session-settled: user-directed — chosen over per ticket only, and over every field of the Jira instance.) Governs R41.
- **`@jira /security-report` is removed in step 1.** (session-settled: user-approved — chosen over removal with the imports or with `@jira` itself.) Governs R33.
- **Every release of the migration is a preview; the one normal release comes at the end.** (session-settled: user-directed — chosen over a normal release after each step and over a hotfix branch for the stable channel: colleagues are not interrupted, and work in the middle of a branch never has to stop for a release. Amended on 2026-11-14 by [`2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md`](2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md); it replaced "each step is a preview release first".) Governs R35.
- **(Withdrawn, see R36.) The minimum VS Code version rises in step 1.** (session-settled: user-directed — chosen over raising it with the last step, and over keeping the floor and showing a notice.) Governs R36.
- **The target architecture is documented and approved before any board code.** (session-settled: user-directed — chosen over writing the page while step 1 is built, over rewriting the migration document, and over a folder of separate decision records: the design is settled in advance and later feature work reads one page.) Governs R47 to R49.
- **The work ends with a full documentation review.** (session-settled: user-directed.) Governs R50.
- **The Output Channel is the only record of board writes.** (session-settled: user-approved — chosen over a result list on the board and over a journal file: no separate audit record is kept.) Governs R5.

### Actors

- A1. Developer: asks for a list, an import or a review in a Copilot chat, then works on the board.
- A2. Copilot agent: opens boards, passes what the developer said, reads review findings on request, calls tools.
- A3. Extension: serves every board page, reads and writes Jira and Bitbucket, runs the review.

### Requirements

**Rules for every board**

- R1. Each board of this plan is an editor view: a webview in an editor tab that the extension opens when the agent calls the open-board tool or the developer runs a Command Palette command. The tab loads its page from the extension's own files and exchanges messages with the extension; no local server, port or key is involved.
- R2. When a board cannot open, the answer names the cause, for example Jira not being set up or a text that is not a project key. A board needs no proxy setting and no MCP server, and the Command Palette commands work without Copilot.
- R3. Every write from a board shows a preview of exactly what will be written and runs only after a second Apply click.
- R4. A page holds no state of its own. Everything it shows comes from its session (R51).
- R5. Every board write is logged to the "Ticket Sidekick" Output Channel with its ticket or PR, action and outcome.
- R6. A board is served by the VS Code window that opened its tab, with that window's settings and sessions.
- R39. A board write that changes more than one ticket, closes a ticket or posts to Bitbucket also needs a native VS Code confirmation, so nothing running in a board page can complete such a write by itself.
- R45. A prompt that belongs to a board run is a step on that board: the first model pick, the requirements-pass choice and the email consent. No model call starts before the choice, and the board shows afterwards which model ran.
- R46. Every board control, row selection, preview and Apply works by keyboard with a visible focus order, and results are exposed as text a screen reader announces.

**Sessions and the cache**

- R51. Each board run is a session with an ID that the extension owns. The page displays the session and sends actions; the extension applies and checks every action.
- R52. A session holds its recipe (report path, query, PR link or project), the data derived from the sources, and the developer's working state: choices, selections, the current screen, and runs in progress with their finished and pending steps.
- R53. A session is stored in full in the extension's storage for the workspace. It is never written into the repository and never holds credentials.
- R54. There is one session per source. Opening the same report file, query, PR or project again continues its session.
- R55. A board opens at once from the stored session with a line saying when its data was read, then reads the sources in the background; Refresh does the same on demand. A PR review is never run again automatically; the board only marks that the PR has moved.
- R56. Where the stored session and the fresh reading differ, the board can show both, marks each conflict, and lets the developer resolve or drop each one.
- R57. Every Apply first reads again the tickets or PR it is about to change and refuses the ones that changed since the board last read them.
- R58. A session is deleted when the developer finishes or discards it, when it has not been used for a number of days set in a setting (default 14), or by the command "Ticket Sidekick: Clear stored sessions".
- R59. A stored session whose format does not match the running extension is discarded with a notice and never migrated.
- R60. `/ts-jira sessions` opens a sessions board: one row per stored session with source, kind, age and size, with Reopen, Delete and Delete all. The agent learns only whether it opened.
- R61. The security report board runs on the same model: one session per project, opened from the cache under R55, with its filters and sort kept as working state.
- R62. Every tool is offered to Copilot as a VS Code language model tool (an "extension tool") from one catalog, and in no other way: there is no MCP server and no setting that chooses a route. A tool that is not read-only asks first and shows what it will write.
- R63. Each board can be opened from the Command Palette without Copilot.

**Ticket list board**

- R7. A search by JQL or saved filter, a cleanup, or a bulk change the developer asks for opens the ticket list board with one row per ticket.
- R8. The developer selects rows and applies a bulk transition or a bulk field update under R3; the board shows the result per ticket.
- R9. Cleanup is the ticket list board loaded from the `cleanupRules` in `.jira-templates.json`, with the same rules and extra fields as today's cleanup review.
- R10. The agent may open the board with a query and a proposed change, a target status or a field and value. The board then opens with all matching rows selected and the change filled in and marked as proposed.
- R11. The agent learns only whether the board opened, never the rows.
- R12. The agent keeps its find tool for its own lookups and for questions the developer asks about tickets.
- R44. The tool descriptions and skills tell the agent to open the board for a request to see a ticket list or to change more than one ticket, and not to list rows in chat or change tickets one by one. Where no board can open, a plain request gets the message of R2 as well.
- R13. VS Code brings a board's tab back after a restart or reload, and the board reconnects to its session and shows it under R55. A tab whose stored state is not a board's is closed.

**Import board**

- R14. The import board opens on a start screen where the developer chooses the kind (Veracode, Waltz, email) and the report file or files.
- R15. A workspace path typed in chat, or a file dragged into the chat, opens the board already loaded, by way of the open-board tool. The board itself never puts report content into the chat. A dragged text report is sent to the model once as an attachment, and for an email the drag counts as consent to that.
- R16. Every action of today's import review screens exists as a board control with the same rules and results: create, merge and unmerge rows, accept and unaccept CVEs and components (Waltz), add rows to an existing ticket as comment or rewrite, the per-row actions on already-ticketed items, merge tickets, stale close, search, export, and reload report. The same holds for the rules that have no control of their own: the Veracode SLA Due Date on create, new ticket and rewrite and the flag for open tickets without one, the Waltz rewrite Due Date, the out-of-date marking after `unaccept` and a ticket merge, and a drained email import finishing without a `done`. The chat-only parts (the Commands line, help, paging words, `show`, `open`, `back`) are dropped. The full list is the import board parity ledger in `docs/architecture/migration-status.md`.
- R17. The agent only opens the import board and learns whether that worked. It has no actions on the board and gets no report data from it.
- R18. The email kind keeps the boilerplate cleanup step with its consent before any email text goes to a model. It has two outcomes: create tickets, or add one email as a comment to an existing ticket.
- R19. A restored import board continues its session: unapplied choices and a half-finished merge run with its finished and pending steps are still there.
- R43. Before it creates tickets from emails, the board searches the project for tickets whose summary matches an email's subject and marks likely repeats. The developer decides for each one.

**PR review board**

- R20. A review runs with today's pipeline and features: quick, smart and deep modes, the optional requirements pass against the Jira ticket with its opt-in, and an upfront question or goal.
- R21. The board shows the verified findings exactly as computed, ordered by severity, with controls to add a note, copy for Teams, and post a comment under R3, plus the token usage of the run.
- R22. The agent gets a short result (counts and verdict) and can read individual findings on request, so explain and goal questions are answered in chat.
- R23. A comment the agent posts on its own goes through the tool approval dialog, not through the board.
- R24. A setting names the model for the review passes. When it is empty, the first review asks the developer to pick from the models available to them and writes the choice to that setting. The setting and its pick step ship in step 2. The monthly token counters keep their per-model split.
- R25. A second setting names the model for the email boilerplate check and falls back to the review model when empty. With both empty, the check asks for a model as R24 does.
- R26. Review findings are part of the review's session. A restored review board shows them without running the review again, and the agent can still read them.
- R27. Bitbucket offers tools to read a PR, read its diff, post a comment and read review findings, as extension tools like the Jira tools (R62), and a typed `/ts-bitbucket` command with `review <url> [quick|smart|deep]`, `check`, `usage` and `help`. A plain request with a PR link also starts a review.

**New `/ts-jira` commands**

- R28. `/ts-jira-spell-check KEY` has the agent propose numbered spelling and grammar corrections of the description only; a tool applies the approved ones to the description as Jira stores it. (Amended 2026-11-14: a skill of its own, description only, a dedicated tool instead of the update tool; see [`2026-11-14-1009-feat-spell-check-and-template-skills-plan.md`](2026-11-14-1009-feat-spell-check-and-template-skills-plan.md).)
- R29. `/ts-jira-template KEY` builds a template entry from the ticket's fields with today's deterministic logic and adds it to `.jira-templates.json` after the developer confirms; a taken name gets the next free number. (Amended 2026-11-14: a skill of its own, from a ticket only, no-ticket mode dropped; see [`2026-11-14-1009-feat-spell-check-and-template-skills-plan.md`](2026-11-14-1009-feat-spell-check-and-template-skills-plan.md).)
- R30. The preview-and-refine session for descriptions and comments is dropped without a replacement.
- R40. The update tool sets any field by display name or ID, custom fields and sprint included, and can add or remove single values of a list field.
- R41. `/ts-jira fields KEY` lists every field of a ticket with name, ID and current value. Without a key, for a project and issue type, it lists the fields that type can take with name, ID and whether each is required.
- R42. `/ts-jira check-fields KEY` checks the ticket against `ticketSidekick.jira.requiredFields`, as `check required fields` does today.

**Delivery and removal**

- R31. This plan takes over the security report from its branch: the page content and shared look built there are reused, and its page is built on the session model (R61) instead of that plan's sessionless page. That branch's local server and canvas foundation are not used.
- R32. The work ships in three steps, in this order, after the architecture page of R47 and a foundation step with the session model, the security report board and the sessions board (R51 to R61): ticket list board with R28, R29 and R40 to R42, import board, PR review board with R27.
- R33. Each step deletes the participant flows it replaces. Step 1 removes every `@jira` flow except the imports, including `/security-report`, each only once its row in the Replacement Map is in place. Step 2 removes the imports and `@jira` itself. Step 3 removes `@bitbucket` and the three Bitbucket Agent Mode tools.
- R34. Step 2 removes the three Command Palette import commands.
- R35. Every step goes out on the preview channel only, with the old flows already removed, and the stable channel stays on its current version with no hotfix release until the whole migration is done. Each step adds its part to a written manual checklist and runs it on the preview build on the maintainer's managed machine, with proxy, the organisation's Copilot policies and real Jira and Bitbucket Data Center; the one normal release at the end reruns the whole checklist.
- R36. (Withdrawn.) The minimum VS Code version stays at 1.95, the first with language model tools; no MCP server provider is needed.
- R37. After step 3 no participant, `@jira` help screen, follow-up chip, disambiguation entry or Local harness support remains, and both walkthroughs describe the Copilot chat.
- R38. Each step updates the README tables and the user manual pages for what it adds and removes.

**Architecture and documentation**

- R47. A new page under `docs/architecture/` describes the target design: the layers, what a board is, how a board's page, server routes, tools and skills fit together, the rules every board follows, and how state, restore and model calls work. It is merged, after the maintainer's approval, as its own change before any board code.
- R48. `CLAUDE.md` and the architecture page carry "adding a board", "adding a tool" and "adding a skill" checklists, which replace the participant checklists as the participants go. Each step keeps the page of R47 and these checklists current.
- R49. Each architecture decision of this work is recorded in the decision table of `docs/architecture/boards-and-sessions.md` and, with the rejected alternatives and the reason, in the decision log of `docs/architecture/copilot-harness-migration.md`, continued from D7. That document is a historical record, marked as superseded where it describes MCP, canvases or the local server.
- R50. Step 3 ends with a review of every developer and user document: `CLAUDE.md`, `CONCEPTS.md`, `STRATEGY.md`, `README.md`, `docs/manual/`, the domain documents, `docs/onboarding.md`, `docs/solutions/` and `docs/known-limitations.md`. Afterwards none describes `@jira`, `@bitbucket` or a participant mechanism as current behaviour. Plans under `docs/plans/` are historical and stay as they are.

### Replacement Map

Every `@jira` and `@bitbucket` command, with what replaces it and the step that removes it.

| Today | Replacement | Removed in |
| --- | --- | --- |
| `@jira` create | `/ts-jira-create`, create tool (0.9.0) | Step 1 |
| `@jira` view, summarize | View tool (0.9.0) | Step 1 |
| `@jira` show fields | R41 | Step 1 |
| `@jira` check required fields | R42 | Step 1 |
| `@jira` comment, show comments | Comment and view tools (0.9.0) | Step 1 |
| `@jira` field | Update tool extended by R40 | Step 1 |
| `@jira` move | Move tool (0.9.0) | Step 1 |
| `@jira` search, filters | Ticket list board (R7, R63), find tool (R12) | Step 1 |
| `@jira` bulk transition, bulk field update | Ticket list board (R8) | Step 1 |
| `@jira` cleanup | Ticket list board (R9) | Step 1 |
| `@jira` load, upload, workflow, check | Load, upload, workflow and connection tools (0.9.0) | Step 1 |
| `@jira` spell check | `/ts-jira-spell-check`, `jira_correct_description` (R28) | Step 1 |
| `@jira` template generation | `/ts-jira-template`, `jira_create_template` (R29) | Step 1 |
| `@jira /security-report` | Security report board | Step 1 |
| `@jira` description and comment preview | Dropped (R30) | Step 1 |
| `@jira` help | `/ts-jira help` | Step 2 |
| `@jira` Veracode, Waltz and email import, email as comment | Import board (R14 to R19, R43) | Step 2 |
| Command Palette import commands | Import board start screen (R14) | Step 2 |
| `@bitbucket` review and follow-ups | Review board (R20 to R26) | Step 3 |
| `@bitbucket` check, usage | `/ts-bitbucket check`, `usage` (R27) | Step 3 |
| Bitbucket Agent Mode tools | The same tools plus read-findings, in the catalog shape of the Jira tools (R27) | Step 3 |

### Key Flows

- F1. Bulk change from chat
  - **Trigger:** A1 asks "move my done tickets to Closed".
  - **Actors:** A1, A2, A3
  - **Steps:** A2 opens the ticket list board with the query and the proposed status. A3 reads Jira and shows the rows, all selected. A1 deselects rows, opens the preview, clicks Apply and confirms the VS Code dialog. A3 transitions the tickets and shows the result per ticket.
  - **Outcome:** The tickets are moved; the chat holds no ticket rows.
  - **Covered by:** R3, R7, R8, R10, R11, R39
- F2. Report import
  - **Trigger:** A1 drags a Veracode report into the chat and asks to import it, or types `/ts-jira import`.
  - **Actors:** A1, A2, A3
  - **Steps:** A2 opens the import board, with the path when one was given. A3 parses the report and runs the dedup search. A1 works through new, already ticketed and stale items with the board controls, each write under R3.
  - **Outcome:** Tickets are created, updated or closed as chosen; the agent knows only that the board opened.
  - **Covered by:** R14 to R18
- F3. PR review with a follow-up
  - **Trigger:** A1 types `/ts-bitbucket review <url> deep`.
  - **Actors:** A1, A2, A3
  - **Steps:** A3 runs the review with the model of R24 and shows the findings on the board. A2 reports counts and verdict in chat. A1 asks "explain finding 3"; A2 reads that finding and answers. A1 posts a comment from the board under R3.
  - **Outcome:** The findings stay on the board as computed; the discussion happens in chat.
  - **Covered by:** R20 to R24

### Acceptance Examples

- AE1. **Covers R2.** Given Jira is not set up, when the developer types `/ts-jira search assignee = currentUser()`, then the answer names the missing setup step, and no ticket list appears in chat. Given a machine with no `http.noProxy` entry and an organisation that blocks MCP servers, when the developer runs `Ticket Sidekick: Open ticket list` with Jira set up, then the board opens.
- AE2. **Covers R10, R3.** Given the agent opened the ticket list board with the status "Closed" proposed for 12 tickets, when the developer deselects 2 rows and clicks Apply after the preview, then 10 tickets are transitioned and the board shows 10 results.
- AE3. **Covers R13, R55.** Given a ticket list board with a proposed change and 5 selected rows, when VS Code restarts and the board comes back, then it shows the same rows, selection and proposed change at once with the time they were read, and then checks Jira in the background.
- AE4. **Covers R19, R56.** Given a Waltz import with 3 tickets created, 2 unapplied merges and a merge run stopped after its second step, when VS Code restarts and the board comes back, then the merges and the run are still there. Given a colleague closed one of the merge targets meanwhile, then that merge is marked as a conflict the developer resolves or drops.
- AE5. **Covers R15, R17.** Given a report path typed in chat, when the board opens loaded, then the agent's result says only that the board opened and the chat holds no report content.
- AE6. **Covers R24.** Given the review model setting is empty, when the first review starts, then the developer is asked to pick a model, and the next review does not ask again.
- AE7. **Covers R25.** Given the email model setting is empty and the review model is set, when the developer consents to the boilerplate check, then the check runs with the review model.
- AE8. **Covers R26.** Given a review board was open, when VS Code restarts and the board comes back, then it shows the same findings, no review runs, and "explain finding 3" still works in chat.
- AE10. **Covers R39.** Given a preview of 10 transitions, when the developer clicks Apply, then a VS Code dialog asks to confirm and nothing is written before it is accepted. Given a page request to apply that plan, when no dialog is accepted, then nothing is written.
- AE11. **Covers R43.** Given an email whose subject matches the summary of an existing ticket in the project, when the email board lists it, then it is marked as a likely repeat with that ticket's key and is not selected for creation.
- AE13. **Covers R57.** Given 10 selected tickets of which one was moved in Jira after the board read it, when the developer applies a transition, then 9 tickets are moved and the tenth is refused with the reason.
- AE14. **Covers R58, R59.** Given a session last used 15 days ago and the default setting, when the extension starts, then that session is deleted. Given a session stored by an older format, when its board is opened, then a notice says it was discarded and the board starts from the sources.
- AE15. **Covers R54.** Given an unfinished import of `report.xml`, when the developer asks to import `report.xml` again, then the existing session opens with its choices.
- AE12. **Covers R44, R2.** Given the board cannot open, when the developer asks in plain words to move five tickets to Closed, then the answer is the message of R2 and no ticket is moved.
- AE9. **Covers R33, R35.** Given step 1 is out as a preview, when a colleague on the stable channel types `@jira search`, then it still works, because no normal release ships before the whole migration is done.

### Success Criteria

- The maintainer's daily ticket and PR work, bulk cleanup and report imports included, is done in Copilot chats on the managed machine without switching to the Local harness.
- After step 3 the repository holds no participant code and no test or document that describes one as current behaviour.
- A contributor who starts a new feature after step 3 can place it, as a tool, a skill or a board, from the architecture page and the `CLAUDE.md` checklists alone.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers the three boards, the Bitbucket tools and `/ts-bitbucket` command, the two `/ts-jira` commands and the removal of both participants. The breakdown below is the current understanding, not a committed roadmap.

- Security report canvas plan (`docs/plans/2026-11-09-2237-feat-security-report-canvas-plan.md`, on its feature branch).
  - This plan takes over that work (R31): it keeps the local server, the shared look and the page's content, hosts the page in an editor tab, and replaces "nothing is stored, rebuilt fresh" (its R8, R11, R13) with the session model.
- Jira tools over MCP, released in 0.9.0 (`docs/plans/2026-11-05-2037-feat-jira-mcp-tools-copilot-harness-plan.md`). Superseded as a transport: the same tool catalog is now registered as extension tools.
  - This plan keeps its tool catalog, the `/ts-jira` command and the skills; its MCP server is removed.
- Later candidates, not planned here: agent actions on the import board, Copilot CLI and the GitHub Copilot app as hosts.
  - Each can proceed independently of this plan once the boards exist.

### Scope Boundaries

- Deferred: agent actions on the import board, such as reading counts or preparing an action.
- Deferred: Copilot CLI and the GitHub Copilot app as hosts of the boards and tools.
- Not in this work, and not kept ready: an MCP server and VS Code canvases. Both were built and removed (2026-11-13). Bringing either back would be a new decision with a new plan, not a switch.
- Not in this work: a journal or audit file of decisions and writes, as `docs/architecture/copilot-harness-migration.md` proposes.
- Not in this work: a board in chat as text. A board needs its editor tab; the Command Palette commands open it where Copilot cannot.
- Not in this work: migrating a stored session from an older format (R59), or sharing sessions between machines or workspaces.
- Not in this work: an Explain control on the review board, or a show-first rule for drafted text.
- Not in this work: pointer commands in the Command Palette for imports.

### Dependencies / Assumptions

- Editor tabs (webview panels) and Command Palette commands are stable VS Code extension API and are not part of what VS Code is deprecating.
- VS Code restores a board's tab after a restart and hands back the state the tab stored. This is unit-tested against a stubbed VS Code and not yet observed in a real restart.
- VS Code's Language Model API can be called by the extension outside a chat participant, as its documentation states.
- A file dragged into a Copilot chat reaches the agent with a path it can pass to the open-board tool. This is not yet observed.
- Extension tools stay allowed by the organisation's Copilot policy. This held on the maintainer's company machine in November 2026, where the same policy blocked the extension's MCP server; an organisation could restrict extension tools too, and then only the Command Palette boards remain.
- Model access is checked on the managed machine at the start of step 2: the extension can call a model outside a chat participant, also with the Local harness disallowed. If it cannot, the review design is reopened before `@bitbucket` is removed.
- Boards and tools need nothing from the network setup of the machine: no local server, no `http.noProxy` entry.
- Colleagues on the stable channel keep the deprecated flows only until each step becomes a normal release.

### Outstanding Questions

Deferred to Planning:

- Which VS Code version becomes the minimum in step 1.
- Whether the Bitbucket tools move into the catalog shape of the Jira tools (`defineTool`, generated `package.json` entries) or stay as they are with one tool added.
- Whether a dragged or typed report path outside the workspace folder is accepted.
- How the review board shows progress while a long review runs, and whether it opens before or after the passes finish.
- The ticket list board's columns, sorting, and its empty, error and partial-failure states with a retry.
- How the import board lays out its groups and its multi-step actions: stale close, merge, add to ticket.
- How a bulk field value is entered for different field types.
- How a conflict is shown and resolved on each board, within R56.
- How large a stored session may grow, and what happens at the limit.
- How the native confirmation of R39 is tied to the previewed write, so the dialog names exactly what Apply will do.
- Whether the organisation plans to turn the Local harness off, and when. It changes urgency, not scope.

### Sources / Research

- `docs/architecture/boards-and-sessions.md`: the built design.
- `docs/architecture/copilot-harness-migration.md` (historical): the design before this work, what the Copilot harness no longer supports, the options, and the decision log.
- `docs/plans/2026-11-09-2237-feat-security-report-canvas-plan.md` (branch `feat/2026-11-09-2237-feat-security-report-canvas-plan-pr1`): the canvas rule, the foundation units and the restart repair.
- `src/participant/session/jiraCommands.ts`: the catalog of `@jira` commands, used here as the list of flows to replace.
- `docs/report-import.md`, `docs/jira-flows.md`, `docs/review-process.md`: today's behaviour that R9, R16 and R20 keep.
- `skills/ts-jira/SKILL.md`: the typed command router R27 to R29 extend or mirror.
- VS Code release notes [1.142](https://code.visualstudio.com/updates/v1_142), [1.143](https://code.visualstudio.com/updates/v1_143), [1.145](https://code.visualstudio.com/updates/v1_145) and [1.146 Insiders](https://code.visualstudio.com/updates/v1_146): canvases arrived as Preview and gained opening from New Chat, remote canvases, pinning and restore after reload. No deprecation signal and no general-availability date were found.
- microsoft/vscode issues [#340508](https://github.com/microsoft/vscode/issues/340508) and [#344999](https://github.com/microsoft/vscode/issues/344999): open canvas restore and refresh problems.
