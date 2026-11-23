---
title: "Create From File Wording and Jira Import Board Name - Plan"
type: feat
date: 2026-11-23
topic: create-from-file-wording
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Create From File Wording and Jira Import Board Name - Plan

## Goal Capsule

- **Objective:** A user who asks, typed or in their own words, to create Jira tickets from an email, a Veracode report or a Waltz OSS report always reaches the board that does that work, and never gets a help screen or a hand-written ticket that skips the board.
- **Means:** `/ts-jira create from <kind>` becomes the documented command, with `import <kind>` kept as an alias (R1 to R4). `/ts-jira-create` hands file-based requests to the board (R5 to R7). The board gets the visible name "Jira Import Board" (R8 to R10).
- **Product authority:** The maintainer's decisions in this conversation, recorded under Key Decisions.
- **Open blockers:** None.

---

## Product Contract

### Summary

`/ts-jira create from <email|veracode|waltz> [PATH ...]` opens the import board and becomes the form the help and the manual teach, with `import <kind>` still working the same way. In Agent mode, `/ts-jira-create` sends any request that comes with an `.eml`, Veracode `.xml` or Waltz `.xlsx` file to that board instead of drafting a ticket. The board is called the Jira Import Board everywhere users read its name.

### Problem Frame

The user typed `/ts-jira create from email` because that is how they think of the task. `create` is not a `/ts-jira` command, so the router printed the full help text (`skills/ts-jira/SKILL.md`, case 3). The help names `import <kind>`, but nothing connects "create" to it.

The plain-language path has a quieter failure. `/ts-jira-create` is the one skill Copilot starts on its own, and its description claims every request to "create, open, file or raise a Jira ticket". With an `.eml` attached, Copilot can read the email and draft one ticket by hand. That skips what only the board does: boilerplate cleanup with consent, attachment and inline-image upload, the likely-repeat check, and for reports the dedup, folding and Due Dates. No skill mentions email or reports today.

### Key Decisions

- **`create from <kind>` is the documented form, `import <kind>` the alias.** It matches how users describe the task, and the alias keeps existing habits and prompts working. (session-settled: user-directed — chosen over keeping `import` as the main form with `create from` as a secondary alias: the user wants the natural wording to lead.) Governs R1, R3, R4.
- **All three kinds, not only email.** One rule for every file the board reads. (session-settled: user-directed — chosen over an email-only alias: consistency across kinds.) Governs R1, R5.
- **Same consent rule as `import email`.** The alias is the same command, so attaching emails counts as agreeing to the model check in both forms. (session-settled: user-approved — chosen over always asking: two forms of one command must not behave differently.) Governs R2.
- **Pasted email text stays with the guided create.** The board reads only `.eml` files, so text in the chat has nowhere else to go. (session-settled: user-approved — chosen over asking for the `.eml` or refusing.) Governs R6.
- **Rename the board to "Jira Import Board", visible text only.** The user picked the name. Internal ids stay so keybindings, stored sessions and older prompts keep working. (session-settled: user-directed — chosen over keeping "import board" unchanged or renaming only the command title.) Governs R8, R9, R10.

### Requirements

**Typed command (`/ts-jira`)**

- R1. `/ts-jira create from <kind> [PATH ...]`, with kind `email`, `veracode` or `waltz`, makes exactly the call `/ts-jira import <kind> [PATH ...]` makes today, with the same arguments.
- R2. For `email`, attached emails count as agreeing to the model check in `create from email` exactly as in `import email`; typed paths do not.
- R3. `/ts-jira import <kind> [PATH ...]` keeps working unchanged.
- R4. The help text lists `create from <kind> [PATH ...]` as the command and names `import <kind>` as the same command. `help create` still describes `/ts-jira-create` and adds one line pointing to `create from <kind>` for emails and reports.
- R5. Any other `create ...` line, such as `create` alone or an unknown kind, behaves as an unknown command does today.

**Agent mode (`/ts-jira-create`)**

- R6. When the request comes with, or names, an `.eml`, a Veracode `.xml` or a Waltz `.xlsx` file, `/ts-jira-create` drafts and creates nothing and opens the Jira Import Board for that kind and those files, with the same consent rule as R2.
- R7. A request whose email text is pasted into the chat, with no `.eml` file, still goes through the guided create as today.

**Board name**

- R8. Every place users read the board's name says "Jira Import Board": the Command Palette title (`Ticket Sidekick: Open Jira Import Board`), the board's own tab and headings, the sessions board, setting descriptions, the `jira_open_board` tool description and the user manual.
- R9. The command id, the tool's `board: import` value, the session kind and stored sessions stay as they are; a session stored before the rename reopens.
- R10. Links into the manual's board section keep resolving after its heading is renamed.

**Docs**

- R11. The README command table, `docs/manual/copilot-tools.md`, `docs/manual/report-imports.md` and `docs/manual/boards.md` lead with `create from <kind>` and say that it opens the Jira Import Board, naming `import <kind>` as the alias.

### Acceptance Examples

- AE1. **Covers R1, R2.** **Given** two `.eml` files attached to the message, **when** the user types `/ts-jira create from email`, **then** the Jira Import Board opens with both emails loaded and the model check counted as agreed, as it does for `/ts-jira import email` today.
- AE2. **Covers R1.** **Given** a workspace with `reports/scan.xml`, **when** the user types `/ts-jira create from veracode reports/scan.xml`, **then** the board opens on that Veracode report.
- AE3. **Covers R5.** **When** the user types `/ts-jira create` or `/ts-jira create from jenkins`, **then** they get the same reply an unknown command gets today.
- AE4. **Covers R6.** **Given** a Waltz `.xlsx` dragged into an Agent-mode chat, **when** the user writes "create tickets from this report", **then** Copilot opens the Jira Import Board for kind `waltz` and creates no ticket itself.
- AE5. **Covers R7.** **When** the user pastes an email's text and asks for a ticket, **then** `/ts-jira-create` runs its usual template, draft and confirm steps.
- AE6. **Covers R9.** **Given** an unfinished import stored before the update, **when** VS Code restarts after the update, **then** the board comes back with its work and shows the name Jira Import Board.

### Scope Boundaries

- Other natural phrasings (`new`, `create ticket`, `make`) are not added.
- The Jira Import Board's behaviour, tabs and rules do not change.
- `/ts-jira-create` gets no import logic of its own; it only hands over.
- The `jira_open_board` tool parameters and the command id do not change.

### Outstanding Questions

**Deferred to Planning**

- Whether R6 is enforced only by `/ts-jira-create`'s instructions, or also by a guard in `src/test/skillsGuard.test.ts`.
- How R10 keeps old links working (an extra anchor, or updating every link in the repo).
- Whether the e2e and bundle smoke tests read the command title and need updating with R8.

### Sources / Research

- `skills/ts-jira/SKILL.md`: router cases 1 to 5 and the `import <kind>` row this work extends.
- `skills/ts-jira-create/SKILL.md`: the model-invoked create skill, whose description claims all create requests.
- `package.json`: the `ticket-sidekick.openImportBoard` command title and the `jira_open_board` tool and setting descriptions that name the board (about 48 visible mentions in `package.json`, `src` and `board-pages`, and about 23 in `README.md` and `docs/manual/`).
- `src/test/skillsGuard.test.ts` and `src/test/userDocsSync.test.ts`: the guards that check `/ts-jira` rows and the manual against the catalog.
- `docs/architecture/migration-status.md`: to be updated if this closes or adds an open point.
