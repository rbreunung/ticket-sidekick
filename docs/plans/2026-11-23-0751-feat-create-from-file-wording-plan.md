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

- **Objective:** A user who asks, typed or in their own words, to create Jira tickets from an email, a Veracode report or a Waltz OSS report always reaches the board that does that work, and never gets a dead-end help screen or a hand-written ticket that skips the board.
- **Means:** `/ts-jira create` becomes the documented entry point with `import <kind>` kept as an alias (R1 to R5, KTD1). `/ts-jira-create` hands file-based requests to the board (R6, R7, KTD3). The board gets the visible name "Jira Import Board" (R8 to R10, KTD4).
- **Product authority:** The maintainer's decisions in the brainstorm and planning conversation, recorded under Key Decisions.
- **Open blockers:** None.
- **Execution profile:** One pull request. Skill text, the tool description, `package.json`, two board files and the docs change together, and the guard tests check them as a set.
- **Stop conditions:** Stop and ask when a guard test can only pass by weakening a rule it states (the five router cases, the no-skill-name rule), rather than by matching the new wording.

---

## Product Contract

Product Contract preservation: changed: R4, R5, AE3. During planning the maintainer decided that a bare `/ts-jira create` shows every way to create instead of the unknown-command reply, because the router sees `create` as a known command. Everything else is unchanged.

### Summary

`/ts-jira create from <email|veracode|waltz> [PATH ...]` opens the import board and becomes the form the help and the manual teach, with `import <kind>` still working the same way. A bare `/ts-jira create` lists every way to create a ticket. In Agent mode, `/ts-jira-create` sends any request that comes with an `.eml`, Veracode `.xml` or Waltz `.xlsx` file to that board instead of drafting a ticket. The board is called the Jira Import Board wherever users meet its name.

### Problem Frame

The user typed `/ts-jira create from email` because that is how they think of the task. `create` is not a `/ts-jira` command, so the router printed the full help text (`skills/ts-jira/SKILL.md`, case 3). The help names `import <kind>`, but nothing connects "create" to it.

The plain-language path fails more quietly. `/ts-jira-create` is the one skill Copilot starts on its own, and its description claims every request to "create, open, file or raise a Jira ticket". With an `.eml` attached, Copilot can read the email and draft one ticket by hand. That skips what only the board does: boilerplate cleanup with consent, attachment and inline-image upload, and the likely-repeat check; for reports, also the dedup, the folding and the Due Dates. No skill mentions email or reports today.

### Key Decisions

- **`create from <kind>` is the documented form, `import <kind>` the alias.** It matches how users describe the task, and the alias keeps existing habits and prompts working. (session-settled: user-directed — chosen over keeping `import` as the main form with `create from` as a secondary alias: the user wants the natural wording to lead.) Governs R1, R3, R11.
- **All three kinds, not only email.** One rule for every file the board reads. (session-settled: user-directed — chosen over an email-only alias: consistency across kinds.) Governs R1, R6.
- **Same consent rule as `import email`.** The alias is the same command, so attaching emails counts as agreeing to the model check in both forms. (session-settled: user-approved — chosen over always asking: two forms of one command must not behave differently.) Governs R2.
- **A bare `create` shows every create option.** It answers with one help page that names the guided chat create and the three `create from <kind>` forms. (session-settled: user-directed — chosen over showing only the `create from <kind>` help line like a bare `import`: the user wants one place that lists all ways to create.) Governs R4, R5.
- **Pasted email text stays with the guided create.** The board reads only `.eml` files, so text in the chat has nowhere else to go. (session-settled: user-approved — chosen over asking for the `.eml` or refusing.) Governs R7.
- **Rename to "Jira Import Board", in the UI and the docs only.** The user picked the name. Internal ids stay so keybindings, stored sessions and older prompts keep working. Tab titles that name a file, Output-channel log lines and code comments keep their wording. (session-settled: user-directed — chosen over keeping "import board" unchanged, renaming only the command title, prefixing every tab, or renaming the log lines too.) Governs R8, R9.

### Requirements

**Typed command (`/ts-jira`)**

- R1. `/ts-jira create from <kind> [PATH ...]`, with kind `email`, `veracode` or `waltz`, makes exactly the call `/ts-jira import <kind> [PATH ...]` makes today, with the same arguments.
- R2. For `email`, attached emails count as agreeing to the model check in `create from email` exactly as in `import email`; typed paths do not.
- R3. `/ts-jira import <kind> [PATH ...]` keeps working unchanged.
- R4. A bare `/ts-jira create` and `/ts-jira help create` give the same answer: a page naming the guided chat create and `create from email`, `create from veracode` and `create from waltz`.
- R5. `/ts-jira create from <unknown kind>` gets the same answer `/ts-jira import <unknown kind>` gets today.

**Agent mode (`/ts-jira-create`)**

- R6. When the request comes with, or names, an `.eml`, a Veracode `.xml` or a Waltz `.xlsx` file, `/ts-jira-create` drafts and creates nothing and opens the Jira Import Board for that kind and those files, with the same consent rule as R2.
- R7. A request whose email text is pasted into the chat, with no `.eml` file, still goes through the guided create as today.

**Board name**

- R8. Every place users meet the board's name says "Jira Import Board": the Command Palette title (`Ticket Sidekick: Open Jira Import Board`), the start screen's tab and heading, setting descriptions, the `jira_open_board` tool description and answers, the walkthrough and the user manual.
- R9. The command id, the tool's `board: import` value, the session kind and stored sessions stay as they are; a session or start screen stored before the rename reopens.
- R10. Every link in the repository to the manual's board section points to the renamed heading.

**Docs**

- R11. The README command text, `docs/manual/copilot-tools.md`, `docs/manual/report-imports.md` and `docs/manual/boards.md` lead with `create from <kind>` and say that it opens the Jira Import Board, naming `import <kind>` as the alias.

### Acceptance Examples

- AE1. **Covers R1, R2.** **Given** two `.eml` files attached to the message, **when** the user types `/ts-jira create from email`, **then** the Jira Import Board opens with both emails loaded and the model check counted as agreed, as it does for `/ts-jira import email` today.
- AE2. **Covers R1.** **Given** a workspace with `reports/scan.xml`, **when** the user types `/ts-jira create from veracode reports/scan.xml`, **then** the board opens on that Veracode report.
- AE3. **Covers R4, R5.** **When** the user types `/ts-jira create`, **then** they get the page listing the guided create and the three `create from <kind>` forms. **When** they type `/ts-jira create from jenkins`, **then** they get the answer `/ts-jira import jenkins` gives today.
- AE4. **Covers R6.** **Given** a Waltz `.xlsx` dragged into an Agent-mode chat, **when** the user writes "create tickets from this report", **then** Copilot opens the Jira Import Board for kind `waltz` and creates no ticket itself.
- AE5. **Covers R7.** **When** the user pastes an email's text and asks for a ticket, **then** `/ts-jira-create` runs its usual template, draft and confirm steps.
- AE6. **Covers R9.** **Given** an unfinished import stored before the update, **when** VS Code restarts after the update, **then** the board comes back with its work.

### Scope Boundaries

- Other natural phrasings (`new`, `create ticket`, `make`) are not added.
- The Jira Import Board's behaviour, tabs and rules do not change.
- `/ts-jira-create` gets no import logic of its own; it only hands over.
- The `jira_open_board` parameters, the command id and the session kind do not change.
- Considered and not built: a check in `jira_create_ticket` that refuses a description that looks like an imported email. It would be heuristic, could refuse real tickets, and nobody asked for it. Revisit if Copilot is seen drafting email tickets by hand despite R6.
- Considered and not built: keeping the old `#import-board` anchor with a hidden HTML anchor. The manual stays plain Markdown, and every in-repo link is updated (R10). An external bookmark to the old anchor lands at the top of `boards.md`.

### Sources / Research

- `skills/ts-jira/SKILL.md`: router cases 1 to 5, the help text and the `import <kind>` row.
- `skills/ts-jira/help-create.md`: the page `help create` prints today.
- `skills/ts-jira-create/SKILL.md`: the model-invoked create skill.
- `src/test/skillsGuard.test.ts`: `tableRows` (the command word is the first word of a row), argument-hint and help-line order checks, the fixed text of cases 1 to 5, the rule that the router names no skill, the `help-create.md` checks, and the `/ts-jira-create` description checks.
- `src/tools/jiraTools/openBoard.ts`: keeps its own copy of the start screen title (`IMPORT_START_TITLE = 'Open import'`) and compares the opened title against it to tell the start screen from a loaded board.
- `src/boards/import/startScreen.ts` (`IMPORT_START_TITLE`), `board-pages/import-start/page.js` (the `h1`), `src/boards/boardPanels.ts` (the `'Import board'` fallback title).
- `package.json`: the `ticket-sidekick.openImportBoard` title, the `jira_open_board` descriptions and four setting descriptions naming the import board.
- `walkthroughs/jira/copilot-tools.md`: names "Open import board".

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One new router row, `create [from <kind>] [PATH ...]`, and no new router case.** With a kind, the row makes the `import` row's call. With no kind, it replies with `help-create.md` the way case 2 does. The five cases and their fixed text in `skillsGuard.test.ts` stay as they are, and `tableRows` reads the row's command word as `create`. `<kind>` sits inside an optional bracket, so case 4 (missing argument) never fires for a bare `create`, which then reaches the row. Governs R1, R4. (session-settled: user-directed — chosen over an extra router case for bare `create`: the user asked to keep the router simple.)
- KTD2. **The page that lists every create option is `help-create.md`.** The router may not name a skill (guard test "names no skill"), so only a help page can mention `/ts-jira-create`. The page keeps its first line and the phrases the guard test pins, and adds the three `create from <kind>` forms. Governs R4.
- KTD3. **The Agent-mode hand-off is wording plus a guard test.** `/ts-jira-create`'s description gets a "Not for" clause for `.eml`, Veracode and Waltz files, and a first step that calls `jira_open_board` with board `import` for them. A guard test pins both. (session-settled: user-approved — chosen over a heuristic check inside `jira_create_ticket`.) Governs R6, R7.
- KTD4. **The rename changes strings, never ids.** The start screen title changes in `startScreen.ts` and in the copy in `openBoard.ts` together, so the tool can still tell the start screen from a loaded board. A restored start screen tab is found by its stored kind, not its title (R9). Governs R8, R9.
- KTD5. **`from` is optional in the router.** `create veracode scan.xml` works like `create from veracode scan.xml`. The router takes the first word after `create` that is not `from` as the kind. It costs one clause in the row and saves a dead end for a natural typo. Governs R1.

### Risks

- **Weak-model routing.** The router is read by whatever model serves the chat. A row with an optional part is a little harder to follow than a fixed row. Mitigation: the row states both outcomes in one sentence each, and the existing `cleanup <rule> [in VERSION]` row already uses the same shape.
- **Title compared as a string.** `openBoard.ts` tells the start screen apart by an exact title match. If only one copy changes, the tool reports a loaded board as opened when it was the start screen. U4 changes both copies together and covers this with a test.

---

## Implementation Units

### U1. `/ts-jira create` row and help

**Goal:** `/ts-jira create from <kind>` opens the board like `import`, and a bare `/ts-jira create` lists every create option.

**Requirements:** R1, R2, R3, R4, R5; KTD1, KTD2, KTD5.

**Dependencies:** None.

**Files:**
- `skills/ts-jira/SKILL.md`
- `skills/ts-jira/help-create.md`
- `src/test/skillsGuard.test.ts`

**Approach:**
1. Add a table row `create [from <kind>] [PATH ...]`. With a kind, it makes the same `jira_open_board` call as the `import` row, with the same path, paths and `dragged` rules. With no kind, it calls no tool and replies with the text of `help-create.md`.
2. Add the matching help line and the argument-hint entry in the same position, so the order checks pass. Put `create` directly before `import`, and describe `import <kind>` in its help line as the same as `create from <kind>`.
3. Extend `help-create.md` with the three `create from <kind>` forms, which open the Jira Import Board. Keep its first line, its `Example:` and `Without it:` lines and the pinned phrases.

**Patterns to follow:** The `import` row for the call and the `cleanup <rule> [in VERSION]` row for an optional part.

**Test scenarios:**
- The router table maps `create` and `import` to the same tool, and the existing "row for every tool" check still passes.
- The argument hint and the help lines list `create` in the same position as the table.
- Cases 1 to 5 keep their exact text.
- The router still names no skill.
- Covers AE3. `help-create.md` names `/ts-jira-create` and each of `create from email`, `create from veracode` and `create from waltz`, and still passes the existing help-page checks.
- The `create` row says that with no kind it replies with `help-create.md`, and the `import` row is unchanged.

These guards check the skill text, not how a model follows it. AE1, AE2 and AE5 are checked by hand in a chat (see the Verification Contract).

**Verification:** `npm test` passes with the extended `skillsGuard.test.ts`.

### U2. `/ts-jira-create` hands file requests to the board

**Goal:** In Agent mode, a ticket request that comes with an `.eml`, a Veracode `.xml` or a Waltz `.xlsx` file opens the Jira Import Board instead of a drafted ticket.

**Requirements:** R6, R7; KTD3.

**Dependencies:** None.

**Files:**
- `skills/ts-jira-create/SKILL.md`
- `src/test/skillsGuard.test.ts`

**Approach:**
1. Add a "Not for" clause to the description for requests that come with `.eml`, Veracode `.xml` or Waltz `.xlsx` files, keeping both phrases the test already pins.
2. Add a step 0 before the template lookup. For such files, call `jira_open_board` with board `import`, the kind and the paths, and `dragged` true for attached emails. Then reply with the tool's status and stop. Email text pasted into the chat continues with step 1.

**Patterns to follow:** The `jira_open_board` import parameters as `skills/ts-jira/SKILL.md` describes them.

**Test scenarios:**
- Covers AE4. The description contains the new "Not for" clause naming `.eml`, Veracode and Waltz files.
- The hand-off step comes before `jira_list_templates`, so the existing order check (templates before create) still holds.
- Covers AE5. The skill says pasted email text without a file continues with the guided steps.
- The skill is still model-invocable (no `disable-model-invocation`).

**Verification:** `npm test` passes; the hand check in the Verification Contract shows the board opening for a dragged `.xlsx`.

### U3. Rename in the manifest, the tool and the walkthrough

**Goal:** VS Code's own surfaces and Copilot's tool text say "Jira Import Board".

**Requirements:** R8, R9; KTD4.

**Dependencies:** None.

**Files:**
- `package.json` (the command title and four setting descriptions, edited by hand)
- `src/tools/jiraTools/openBoard.ts` (the tool description, its parameter descriptions and the two "Not opened" answers; `package.json`'s `languageModelTools` entry is generated from these by the sync step, never edited by hand)
- `walkthroughs/jira/copilot-tools.md`
- `src/test/toolManifest.test.ts` (unchanged, runs after the sync)

**Approach:**
1. Change the visible strings to "Jira Import Board", and the command title to `Ticket Sidekick: Open Jira Import Board`.
2. Run `node scripts/sync-tools.mjs`, so the `contributes.languageModelTools` entry matches the catalog.
3. Leave the command id, the `board` enum value `import` and every log line as they are.

**Test scenarios:**
- `toolManifest.test.ts` passes after the sync.
- `bundleSmoke.test.ts` and the e2e suite still find every declared command by its id.
- `userDocsSync.test.ts` ("names every Command Palette command by its title") fails until U5 names the new title in the docs, so U3 and U5 land in the same PR.

**Verification:** `npm run compile` and `npm test` pass.

### U4. Rename the start screen

**Goal:** The start screen's tab and heading say "Jira Import Board", and the open-board tool still tells the start screen apart from a loaded board.

**Requirements:** R8, R9; KTD4.

**Dependencies:** None.

**Files:**
- `src/boards/import/startScreen.ts` (`IMPORT_START_TITLE`)
- `src/tools/jiraTools/openBoard.ts` (its copy of the title)
- `board-pages/import-start/page.js` (the `h1`)
- `src/boards/boardPanels.ts` (the `'Import board'` fallback title)
- `src/test/boardPanels.test.ts`, `src/test/jiraReadTools.test.ts` (where the old title is asserted)

**Approach:**
1. Set the start screen title and heading to "Jira Import Board" in every copy listed above.
2. Update the tests that assert the old title.
3. Keep the restore path keyed on the stored kind.

**Test scenarios:**
- Opening the start screen for a Waltz file returns the title "Jira Import Board".
- The open-board tool, given the start screen's new title, answers that the report was not loaded, as it did with the old title.
- Covers AE6. A start screen tab restored with the old stored title "Open import" reopens as the start screen.
- A loaded board keeps its "<Kind> import: <file>" tab title.

**Verification:** `npm test` passes; `boardPanels.test.ts` and `jiraReadTools.test.ts` cover the start screen and tool cases.

### U5. User manual, README and links

**Goal:** The docs teach `create from <kind>` and call the board the Jira Import Board, and no in-repo link is left broken.

**Requirements:** R10, R11.

**Dependencies:** U1, U3 (the docs describe their final wording).

**Files:**
- `README.md`
- `docs/manual/boards.md` (heading "Jira Import Board", the boards table row, "From Copilot")
- `docs/manual/report-imports.md`
- `docs/manual/copilot-tools.md`
- Every file linking to `boards.md#import-board`: `CLAUDE.md`, `docs/jira-flows.md`, `docs/report-import.md`, `docs/architecture/boards-and-sessions.md` and the files above
- `docs/architecture/migration-status.md`, only if this closes or adds an open point

**Approach:**
1. Rewrite the command examples to `create from <kind>` and mention `import <kind>` once per page as the alias.
2. Rename the heading, then point every `#import-board` link at the new anchor (`#jira-import-board`).
3. Rename "Open import board" to "Open Jira Import Board" wherever the command is named.

**Test scenarios:**
- `userDocsSync.test.ts` passes: every Command Palette title and slash command is still named in the README and the manual.
- Test expectation for the links: none. No test checks anchors. Verify with a repository search that `#import-board` no longer appears.

**Verification:** `npm test` passes, and a search for `#import-board` and for "Open import board" finds nothing outside `docs/plans/`.

---

## Verification Contract

| Gate | Command or check | Applies to |
|---|---|---|
| Type check | `npm run compile` | U3, U4 |
| Unit tests | `npm test` (guards, manifest, docs sync, board tests) | All |
| Tool manifest | `node scripts/sync-tools.mjs` leaves no diff | U3 |
| Smoke | `xvfb-run -a npm run test:e2e` (activation, every declared command id) | U3, U4 |
| Hand check in a chat | `/ts-jira create`, `/ts-jira create from email` with an attached `.eml`, and "create tickets from this report" with a dragged `.xlsx` in Agent mode | U1, U2 |
| Link sweep | Repository search for `#import-board` and "Open import board" finds only `docs/plans/` | U5 |

The hand check needs Copilot and is not covered by CI. Report its outcome in the PR description, or say it was not run.

## Definition of Done

- All requirements R1 to R11 hold, and AE1 to AE6 behave as written.
- Every gate in the Verification Contract passes, or the PR says which gate was not run and why.
- The command id, the `board: import` value and the session kind are unchanged.
- No leftover code or text from an abandoned approach remains in the diff.
