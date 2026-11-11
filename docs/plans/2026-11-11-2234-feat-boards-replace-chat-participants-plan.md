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

## Goal Capsule

- **Objective:** A developer does all Ticket Sidekick work in a Copilot chat: searches, cleanup, bulk edits, report imports and PR reviews included. Nothing needs `@jira`, `@bitbucket` or the Local harness any more.
- **Means:** Three boards on the canvas foundation of the security report (ticket list, import, PR review), Bitbucket tools on the MCP server, and two new `/ts-jira` commands. Each release deletes the participant flows it replaces.
- **Product authority:** The decisions in this Product Contract, made by the maintainer. Where this plan and `docs/architecture/copilot-harness-migration.md` disagree, this plan wins.
- **Open blockers:** None for planning. Implementation starts only after the security report canvas is merged to `main` (R31).

---

## Product Contract

### Summary

Three boards open as canvas tabs from a Copilot chat and replace the remaining `@jira` and `@bitbucket` flows: a ticket list board, an import board for Veracode, Waltz and email, and a PR review board.
They ship in that order. Each release deletes the participant flows it replaces, and after the third no chat participant is left.

### Problem Frame

Release 0.9.0 moved the single-ticket Jira work to MCP tools and skills. The larger workflows still exist only as `@jira` and `@bitbucket`: searches shown to the user, cleanup and bulk edits, the three report imports, and the PR review.
Chat participants do not run in the Copilot harness, which VS Code uses for new chats. A developer in a Copilot chat therefore has to switch harness for the larger work, and an organisation can turn the Local harness off altogether.

About 15,000 lines of participant and handler code are carried next to the new surface. Every user-facing change has to consider both.

### Key Decisions

Carried in from the security report canvas plan:

- **In Copilot chats, talk and decisions stay in chat and a large artifact opens as a canvas tab.** (session-settled: user-directed — chosen over a one-off exception for the security report: later boards build on the rule instead of asking again.) Governs R1.
- **A write started on a canvas needs a preview and a second Apply click.** (session-settled: user-directed — chosen over the VS Code modal for every write: no second prompt after a deliberate click.) Governs R3.
- **Only the window whose folder holds the chat's folder serves a board.** (session-settled: user-directed — chosen over any running window: workspace settings belong to their workspace.) Governs R6.
- **Boards ship inside the extension as an agent plugin.** (session-settled: user-approved — chosen over an install command that copies a launcher: no install step and no version drift.) Governs R1.

Made for this plan:

- **One plan covers everything still participant-only.** (session-settled: user-approved — chosen over separate plans per area: the shared rules are decided once.)
- **Each participant flow is deleted in the release that ships its replacement.** (session-settled: user-directed — chosen over freezing the participants and removing them last, and over keeping them as a fallback: no code is carried twice.) Governs R32, R33.
- **A board needs a canvas; there is no other surface.** (session-settled: user-directed — chosen over the same page in a plain editor tab, and over a reduced flow in chat: a web check found canvases being built out, not wound down.) Governs R2.
- **The experimental canvas API is a recorded risk with no extra safeguard.** (session-settled: user-directed — chosen over re-running the checklist against VS Code Insiders before each release, and over an automated canvas start test.)
- **All ticket lists shown to the user go on a canvas, built once as a general ticket list board.** (session-settled: user-directed — chosen over bulk review in chat with one batch tool.) Governs R7 to R9.
- **The agent keeps its find tool for its own lookups and for questions.** (session-settled: user-approved — chosen over removing the tool, and over a board for bulk work only.) Governs R12.
- **The agent may fill in the query and a proposed change, never the row choice.** (session-settled: user-approved — chosen over query only, and over a selection made by the model.) Governs R10.
- **A proposed change is not restored after a restart.** A change the model proposed should not reappear unseen. Governs R13.
- **An import is driven on the board only; the agent opens it and learns whether that worked.** (session-settled: user-approved — chosen over agent actions on the board, and over chat-driven imports with a read-only board: no report data reaches the model.) Governs R17.
- **An import board keeps every action of today's review screens.** (session-settled: user-approved — chosen over dropping export, and over a core-first release.) Governs R16.
- **An import starts on the board, with an optional path from chat or from a file dragged into the chat.** (session-settled: user-directed — chosen over board-only file choice and over keeping the Command Palette commands.) Governs R14, R15, R34.
- **Import boards store nothing and are never reopened automatically.** (session-settled: user-directed — chosen over keeping unapplied choices, and over keeping the whole session.) Governs R4, R19.
- **The ticket list board repairs itself after a restart; the review board closes.** (session-settled: user-approved — chosen over closing both and over repairing both: a restored review would spend model tokens unasked.) Governs R13, R26.
- **Review findings are on the board, and the agent can read them on request.** (session-settled: user-approved — chosen over a board the agent cannot read, and over findings in chat with no canvas.) Governs R21, R22.
- **The PR review keeps all of today's features.** (session-settled: user-approved — chosen over an extra Explain control on the board, and over one review mode.) Governs R20, R21.
- **The extension makes its own review calls with a model named in a setting.** (session-settled: user-approved — chosen over a model the Copilot runtime picks, and over the chat agent reviewing by itself: the pipeline and the token counters stay as they are.) Governs R24.
- **The email boilerplate check has its own model setting.** (session-settled: user-directed — chosen over one model setting for all calls, and over dropping the model check.) Governs R25.
- **Bitbucket mirrors the Jira shape: MCP tools and a `/ts-bitbucket` command.** (session-settled: user-approved — chosen over review-only tools, and over leaving the three Agent Mode tools where they are.) Governs R27.
- **Drafting text on an existing ticket gets no replacement.** (session-settled: user-approved — chosen over a show-first rule in the skills: the write tools' approval dialog shows the final text.) Governs R30.
- **Order: ticket list board, import board, review board.** (session-settled: user-approved — chosen over review first and over imports first: the list board establishes the shared parts the import board reuses.) Governs R32.
- **Step 1 also removes every `@jira` flow that 0.9.0 already replaced.** Deleting each flow when its replacement exists applies to those as well. Governs R33.
- **`@jira /security-report` is removed in step 1.** (session-settled: user-approved — chosen over removal with the imports or with `@jira` itself.) Governs R33.
- **Each step is a preview release first.** (session-settled: user-approved — chosen over a checklist before merge, and over automated tests only.) Governs R35.
- **The minimum VS Code version rises in step 1.** (session-settled: user-directed — chosen over raising it with the last step, and over keeping the floor and showing a notice.) Governs R36.
- **The Output Channel is the only record of board writes.** (session-settled: user-approved — chosen over a result list on the board and over a journal file: nothing new is stored.) Governs R5.

### Actors

- A1. Developer: asks for a list, an import or a review in a Copilot chat, then works on the board.
- A2. Copilot agent: opens boards, passes what the developer said, reads review findings on request, calls tools.
- A3. Extension: serves every board page, reads and writes Jira and Bitbucket, runs the review.

### Requirements

**Rules for every board**

- R1. Each board of this plan is a canvas that the agent opens from a Copilot chat and whose page the extension serves, on the canvas foundation the security report canvas introduced.
- R2. When a canvas cannot open, because canvases are off or `127.0.0.1` is missing from `http.noProxy`, the command answers with one message that names the missing setting and how to turn it on.
- R3. Every write from a board shows a preview of exactly what will be written and runs only after a second Apply click.
- R4. A board stores nothing on disk: no rows, no choices, no findings.
- R5. Every board write is logged to the "Ticket Sidekick" Output Channel with its ticket or PR, action and outcome.
- R6. Only the window whose folder holds the chat's folder serves a board.

**Ticket list board**

- R7. A search by JQL or saved filter, a cleanup, or a bulk change the developer asks for opens the ticket list board with one row per ticket.
- R8. The developer selects rows and applies a bulk transition or a bulk field update under R3; the board shows the result per ticket.
- R9. Cleanup is the ticket list board loaded from the `cleanupRules` in `.jira-templates.json`, with the same rules and extra fields as today's cleanup review.
- R10. The agent may open the board with a query and a proposed change, a target status or a field and value. The board then opens with all matching rows selected and the change filled in.
- R11. The agent learns only whether the board opened, never the rows.
- R12. The agent keeps its find tool for its own lookups and for questions the developer asks about tickets.
- R13. After a VS Code restart a restored ticket list board comes back as a working page with a fresh Jira reading, no selection and no proposed change, or is closed when its window does not return.

**Import board**

- R14. The import board opens on a start screen where the developer chooses the kind (Veracode, Waltz, email) and the report file or files.
- R15. A workspace path typed in chat, or a file dragged into the chat, opens the board already loaded. Report content goes from the file to the extension and never through the model.
- R16. Every action of today's import review screens exists as a board control with the same rules and results: create, merge and unmerge rows, accept and unaccept CVEs and components (Waltz), add rows to an existing ticket as comment or rewrite, the per-row actions on already-ticketed items, merge tickets, stale close, search, and export.
- R17. The agent only opens the import board and learns whether that worked. It has no actions on the board and sees no report data.
- R18. The email kind keeps the boilerplate cleanup step with its consent before any email text goes to a model. It has two outcomes: create tickets, or add one email as a comment to an existing ticket.
- R19. An import board that VS Code brings back after a restart is closed. A new import starts from the report file and Jira, and tickets already created appear as already ticketed.

**PR review board**

- R20. A review runs with today's pipeline and features: quick, smart and deep modes, the optional requirements pass against the Jira ticket with its opt-in, and an upfront question or goal.
- R21. The board shows the verified findings exactly as computed, ordered by severity, with controls to add a note, copy for Teams, and post a comment under R3, plus the token usage of the run.
- R22. The agent gets a short result (counts and verdict) and can read individual findings on request, so explain and goal questions are answered in chat.
- R23. A comment the agent posts on its own goes through the tool approval dialog, not through the board.
- R24. A setting names the model for the review passes. When it is empty, the first review asks the developer to pick from the models available to them and remembers the choice. The monthly token counters keep their per-model split.
- R25. A second setting names the model for the email boilerplate check and falls back to the review model when empty.
- R26. A review board that VS Code brings back after a restart is closed.
- R27. Bitbucket offers MCP tools to read a PR, read its diff, post a comment and read review findings, and a typed `/ts-bitbucket` command with `review <url> [quick|smart|deep]`, `check`, `usage` and `help`. A plain request with a PR link also starts a review.

**New `/ts-jira` commands**

- R28. `/ts-jira spell-check KEY` has the agent propose a corrected summary and description, written with the existing update tool after approval.
- R29. `/ts-jira template KEY` builds a template entry from the ticket's fields with today's deterministic logic and adds it to `.jira-templates.json` after the developer confirms.
- R30. The preview-and-refine session for descriptions and comments is dropped without a replacement.

**Delivery and removal**

- R31. Implementation starts after the security report canvas, including its page and `/ts-jira security-report`, is merged to `main`.
- R32. The work ships in three steps, in this order: ticket list board with R28 and R29, import board, PR review board with R27.
- R33. Each step deletes the participant flows it replaces. Step 1 removes every `@jira` flow except the imports, including `/security-report`. Step 2 removes the imports and `@jira` itself. Step 3 removes `@bitbucket` and the three Bitbucket Agent Mode tools.
- R34. Step 2 removes the three Command Palette import commands.
- R35. Each step first goes out on the preview channel with the old flows already removed. It becomes a normal release only after a written manual checklist passes on the maintainer's managed machine, with proxy, canvases and real Jira and Bitbucket Data Center.
- R36. Step 1 raises the minimum VS Code version to one that has MCP server providers and canvases.
- R37. After step 3 no participant, `@jira` help screen, follow-up chip, disambiguation entry or Local harness support remains, and both walkthroughs describe the Copilot chat.
- R38. Each step updates the README tables and the user manual pages for what it adds and removes.

### Key Flows

- F1. Bulk change from chat
  - **Trigger:** A1 asks "move my done tickets to Closed".
  - **Actors:** A1, A2, A3
  - **Steps:** A2 opens the ticket list board with the query and the proposed status. A3 reads Jira and shows the rows, all selected. A1 deselects rows, opens the preview and clicks Apply. A3 transitions the tickets and shows the result per ticket.
  - **Outcome:** The tickets are moved; the chat holds no ticket rows.
  - **Covered by:** R3, R7, R8, R10, R11
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

- AE1. **Covers R2.** Given `chat.canvases.enabled` is off, when the developer types `/ts-jira search assignee = currentUser()`, then the answer is one message naming that setting and how to turn it on, and no ticket list appears in chat.
- AE2. **Covers R10, R3.** Given the agent opened the ticket list board with the status "Closed" proposed for 12 tickets, when the developer deselects 2 rows and clicks Apply after the preview, then 10 tickets are transitioned and the board shows 10 results.
- AE3. **Covers R13.** Given a ticket list board with a proposed change and 5 selected rows, when VS Code restarts and the board comes back, then it shows a fresh reading with nothing selected and no change filled in.
- AE4. **Covers R19.** Given a Waltz import with 3 tickets created and 2 unapplied merges, when VS Code restarts, then the board is closed. When the developer imports the same report again, then the 3 tickets appear as already ticketed and the merges are gone.
- AE5. **Covers R15, R17.** Given a report dragged into the chat, when the board opens loaded, then the agent's result says only that the board opened.
- AE6. **Covers R24.** Given the review model setting is empty, when the first review starts, then the developer is asked to pick a model, and the next review does not ask again.
- AE7. **Covers R25.** Given the email model setting is empty and the review model is set, when the developer consents to the boilerplate check, then the check runs with the review model.
- AE8. **Covers R26.** Given a review board was open, when VS Code restarts, then the board is closed and no review runs.
- AE9. **Covers R33, R35.** Given step 1 is out as a preview, when a colleague on the stable channel types `@jira search`, then it still works until the step becomes a normal release.

### Success Criteria

- The maintainer's daily ticket and PR work, bulk cleanup and report imports included, is done in Copilot chats on the managed machine without switching to the Local harness.
- After step 3 the repository holds no participant code and no test or document that describes one as current behaviour.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers the three boards, the Bitbucket tools, the two `/ts-jira` commands and the removal of both participants. The breakdown below is the current understanding, not a committed roadmap.

- Security report canvas (`docs/plans/2026-11-09-2237-feat-security-report-canvas-plan.md`, on its feature branch).
  - This plan depends on its canvas foundation, its shared look and its restart repair, and starts after it is merged.
- Jira tools over MCP, released in 0.9.0 (`docs/plans/2026-11-05-2037-feat-jira-mcp-tools-copilot-harness-plan.md`).
  - Shares the MCP server, the `/ts-jira` command and the approval dialog this plan builds on.
- Later candidates, not planned here: agent actions on the import board, Copilot CLI and the GitHub Copilot app as hosts, remote canvases.
  - Each can proceed independently of this plan once the boards exist.

### Scope Boundaries

- Deferred: agent actions on the import board, such as reading counts or preparing an action.
- Deferred: Copilot CLI and the GitHub Copilot app as hosts of the boards and tools.
- Deferred: remote canvases, where the agent host runs on another machine.
- Not in this work: a journal or audit file of decisions and writes, as `docs/architecture/copilot-harness-migration.md` proposes.
- Not in this work: a fallback surface without canvases. Considered and not built: the same page in a plain editor tab; a stable VS Code release that breaks canvas opening with no fix announced would reopen it.
- Not in this work: keeping unapplied import choices across a restart.
- Not in this work: an Explain control on the review board, or a show-first rule for drafted text.
- Not in this work: pointer commands in the Command Palette for imports.
- Not in this work: any change to the security report canvas itself.

### Dependencies / Assumptions

- Canvases are a Preview feature and their API is experimental. A VS Code update may break all three boards at once; this is accepted without a safeguard.
- The canvas program runs again when a session resumes and can close or reopen its canvases. The security report plan lists this as not yet observed.
- VS Code's Language Model API can be called by the extension outside a chat participant, as its documentation states.
- A file dragged into a Copilot chat reaches the agent as a path it can pass on when it opens a canvas. This is not yet observed.
- A canvas open request can carry the query, proposed change or report path the agent passes.
- Colleagues on the stable channel keep the old flows only until each step becomes a normal release; afterwards a machine without canvases or the `http.noProxy` entry can do single-ticket work only.

### Outstanding Questions

Deferred to Planning:

- Which VS Code version becomes the minimum in step 1.
- Whether Jira and Bitbucket share one MCP server or get one each.
- Whether a dragged or typed report path outside the workspace folder is accepted.
- How the review board shows progress while a long review runs, and whether it opens before or after the passes finish.
- Whether the organisation plans to turn the Local harness off, and when. It changes urgency, not scope.

### Sources / Research

- `docs/architecture/copilot-harness-migration.md`: current design, what the Copilot harness no longer supports, the options, and the decision log D1 to D6.
- `docs/plans/2026-11-09-2237-feat-security-report-canvas-plan.md` (branch `feat/2026-11-09-2237-feat-security-report-canvas-plan-pr1`): the canvas rule, the foundation units and the restart repair.
- `src/participant/session/jiraCommands.ts`: the catalog of `@jira` commands, used here as the list of flows to replace.
- `docs/report-import.md`, `docs/jira-flows.md`, `docs/review-process.md`: today's behaviour that R9, R16 and R20 keep.
- `skills/ts-jira/SKILL.md`: the typed command router R27 to R29 extend or mirror.
- VS Code release notes [1.142](https://code.visualstudio.com/updates/v1_142), [1.143](https://code.visualstudio.com/updates/v1_143), [1.145](https://code.visualstudio.com/updates/v1_145) and [1.146 Insiders](https://code.visualstudio.com/updates/v1_146): canvases arrived as Preview and gained opening from New Chat, remote canvases, pinning and restore after reload. No deprecation signal and no general-availability date were found.
- microsoft/vscode issues [#340508](https://github.com/microsoft/vscode/issues/340508) and [#344999](https://github.com/microsoft/vscode/issues/344999): open canvas restore and refresh problems.
