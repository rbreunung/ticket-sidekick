# Migration status: from chat participants to tools and boards

Last updated: 2026-11-14.

This page says where the migration stands and what is still open. It is the working list; the other documents hold the detail:

- **Design as built:** [`boards-and-sessions.md`](boards-and-sessions.md)
- **Requirements (R-numbers below):** [`../plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](../plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md)
- **History, superseded:** [`copilot-harness-migration.md`](copilot-harness-migration.md) and the plans dated 2026-11-05 and 2026-11-09

Update this page in every change that closes or adds an open point.

**Release rule for the whole migration.** Every release made while the migration runs is a **preview** (`channel: preview`). The stable channel stays on its current version, with no hotfix release, until the whole migration is done and tested, so colleagues are not interrupted and work in the middle of a branch never has to stop for a release. Each step adds its part to the [manual checklist](manual-checklist.md) and runs it on the preview build; the one normal release at the end reruns the whole checklist. This replaces "each step is a preview release first" in the boards plan (R35, AE9).

---

## 1. Direction

| | |
| --- | --- |
| **Build on** | Extension tools (VS Code language model tools), the `/ts-jira` skills, and boards (webviews in editor tabs that show a session the extension owns) |
| **Deprecated** | The `@jira` and `@bitbucket` chat participants. They run what has no tool or board yet and get bug fixes only |
| **Removed, not coming back without a new decision** | The MCP server, the `ticketSidekick.jira.toolsFrom` setting, VS Code canvases, the agent plugin, the local HTTP server and its `http.noProxy` requirement |

## 2. What is done

| Area | State |
| --- | --- |
| Single-ticket Jira work | 16 tools: check connection, view, find, list filters, workflow, list templates, list fields, check required fields, load, move, create, comment, update any field (set, add, remove), upload, correct a description, create a template from a ticket |
| Opening boards | `jira_open_board` tool (with cleanup rules and fix version, sprint, assignee and team narrowing), four Command Palette commands, `/ts-jira search`, `cleanup`, `security-report`, `sessions` |
| Skills | `/ts-jira` (typed commands), `/ts-jira-create`, `/ts-jira-brief`, `/ts-jira-spell-check`, `/ts-jira-template` |
| Removed `@jira` flows | Every Step 1 flow: create, view, summarize, show fields, check required fields, comments, field, move, load, upload, workflow, check, search, filters, bulk transition, bulk field update, cleanup, `/security-report`, the description and comment preview, spell check and template generation. `@jira` has no slash command left and runs only the report imports; any other request gets a notice pointing to `/ts-jira` and Agent mode |
| Session model | Sessions stored per workspace, shown from cache and checked in the background, conflicts, single-use write plans, native confirmation for risky writes, expiry and a clear command |
| Boards | Security report (filters, sort, CSV and Excel export), ticket list (search, 50 rows a page up to 300, `searchFields`/`cleanupFields` columns, bulk move, bulk field update with add and remove, cleanup by `cleanupRules` with nested subtasks, an out-of-date state that offers only Refresh), stored sessions |
| Documentation | README, manual, `CLAUDE.md`, glossary, architecture page and plan describe tools and boards as current and the participants as deprecated |

## 3. Open points

Ordered as the plan orders its steps. "Blocks removal of" names the participant flow that has to stay until the point is closed.

### Step 1: finish the Jira side

O1, O2 and O5 are closed by [`../plans/2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md`](../plans/2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md). Reading more than 300 tickets and a side-by-side conflict view were dropped as gaps there: `@jira` read 50 tickets and never noticed a changed one. A cleanup applies one page at a time (KL27).

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O6 | Manual checklist: the Step 1 part is written in [`manual-checklist.md`](manual-checklist.md); run it on the managed machine against the preview build | R35 | — |

### Step 2: imports

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O7 | Import board: start screen, Veracode, Waltz and email kinds on the session model, and everything marked "Carry over" in the [import board parity ledger](#import-board-parity-ledger) below: every review-screen action as a board control (create, merge and unmerge, accept and unaccept, add to ticket, the Already-ticketed actions including rewrite, stale close, ticket merge with its resumable run, search, export with due-date columns, reload report), the Due Date rules (Veracode SLA Due Date on create, new ticket and rewrite, the backfill flag, the Waltz rewrite Due Date), the out-of-date marking after `unaccept` and a ticket merge, and a drained email import finishing on its own | R14 to R19 | `@jira` imports, the three Command Palette import commands |
| O8 | Email kind: boilerplate cleanup with consent as a board step; "add one email as a comment"; search for tickets matching an email's subject before creating | R18, R43 | `@jira` email import, email as comment |
| O9 | Model settings: one for the review passes, one for the email check, with a pick step when empty | R24, R25 | — |
| O10 | Prompts that belong to a board run happen on the board, before any model call | R45 | — |
| O11 | Remove the imports, the import commands, `@jira` itself and its help screen | R33, R34 | — |

#### Import board parity ledger

What the `@jira` import does today and what the import board does with it. The list is built from the reply commands (`IMPORT_COMMAND_ENTRIES` in `src/participant/session/importCommands.ts`) and the optional capabilities of `ReportImportDescriptor` and `ImportChangeTracking` (`src/participant/jira/reportImportTypes.ts`); `src/test/importBoardParity.test.ts` fails when one of them is missing here. "Carry over" means the board keeps the behaviour with the same rules and results (R16); "Dropped" means a recorded decision not to. The behaviour is described in [`docs/report-import.md`](../report-import.md). Why this ledger exists: [`docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md`](../solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md).

**Reply commands**

| Command (catalog id) | Board | Note |
| --- | --- | --- |
| `toggle-rows`, `bulk` | Carry over | Including and excluding New rows, one by one or all |
| `create` | Carry over | Including the batch cap and the resume message |
| `fold` | Carry over | Merge and unmerge New rows; add rows to an existing ticket as comment or rewrite |
| `accept-cve`, `accept-component`, `accepted-list` | Carry over | Waltz: accept, unaccept and list accepted CVEs and components; accepted items stay off New and Already ticketed |
| `row-action`, `all-action`, `run` | Carry over | Already-ticketed actions per row and for all rows, then apply; a rewrite is all-or-none per target ticket |
| `merge-tickets` | Carry over | Both modes (Waltz rewrite, Veracode close) with the resumable run, `retry` and `ignore` |
| `toggle-stale`, `close` | Carry over | Mark stale tickets, then issue type, target status and resolution |
| `search` | Carry over | Over the tickets the review matched, with no Jira call |
| `export` | Carry over | Overview by Fix Version, CSV and Excel, with the due-date columns |
| `reload` | Carry over | Re-read the report file and refresh the review after a confirmation |
| `show` | Dropped | The board always shows its current screen |
| `paging` | Dropped | The words go; the board pages or scrolls as it likes. The rule that row actions and `apply` read every row, not only the visible page, carries over |
| `open`, `exit` | Dropped | Groups are on the board at once; finishing is covered by "a drained import finishes" below |
| `help` | Dropped | Board controls carry their own labels; the Commands line, help link and help after a refused reply go with it |
| `email-strip`, `email-keep`, `email-model-check`, `email-rows`, `email-save`, `email-cancel` | Carry over | The email boilerplate cleanup step with its consent (O8, R18) |

**Importer capabilities**

| Capability | Board | Note |
| --- | --- | --- |
| `fileFilter`, `filePickerTitle`, `parseAndFilter` | Carry over | The start screen's file choice and report parsing (R14) |
| `searchLabelOf`, `dedupKeyOf`, `labelToDedupKey` | Carry over | The dedup search that fills Already ticketed |
| `afterCreate` | Carry over | Email: attachment upload after a ticket is created; a failure is a warning, not a failed row |
| `onIssueTypeFetchFailed` | Carry over | The warning when the project's issue types cannot be read |
| `stale` | Carry over | The Stale group |
| `changeTracking` | Carry over | Change detection on Already-ticketed rows |
| `deriveActions`, `actionLabels` | Carry over | Veracode and Waltz offer `rewrite`, `leave` and `new ticket` (Waltz's word for follow-up) |
| `readsTargetDescriptions`, `reportKeysOf` | Carry over | Reading the target tickets' descriptions and the dropped-member pass |
| `dueDateBackfill` | Carry over | Veracode: an open ticket without a Due Date is flagged for a rewrite |
| `recordLabelsOf`, `removeLabelPrefix`, `buildUpdateComment`, `rewriteSummary` | Carry over | The record labels, rating-label swap, update comment and summary rewrite of an Already-ticketed write |
| `fold` | Carry over | See the `fold` command above |
| `accepted` | Carry over | See the accept commands above |
| `ticketMerge` | Carry over | See `merge-tickets` and `reload` above, plus the refresh after `unaccept` |
| `overviewExport` | Carry over | See `export` above |
| `rewriteDueDate`, `dueDateNote` | Carry over | The Due Date a rewrite writes: Veracode sets it once and only moves it earlier, Waltz takes the regenerated group's date; the result line names it |

**Rules with no command or capability of their own** (not checked by the test)

| Rule | Board | Note |
| --- | --- | --- |
| Veracode SLA Due Date on create and new ticket (`ticketSidekick.veracode.slaDays`) | Carry over | Written by `buildTicketFields`/`buildFollowUp`; feeds the security report's overdue and due-before-release flags |
| A Due Date Jira refuses is dropped and the write repeated once | Carry over | `optionalFields` and `droppedFields` |
| A drained import finishes without `done` | Carry over | `isNewGroupDrained()`: after `create tickets`, when no New row is left and the importer has no `overviewExport`, `accepted` or `ticketMerge` (in practice email), the import ends in the same step |
| Screens out of date after `unaccept` or a ticket merge | Carry over | Refresh at once when no choice is unfinished, otherwise mark out of date (`hasUnfinishedChoices`) |
| The accepted list is never written over a file that could not be read in full | Carry over | `AcceptedListService` |
| Report and batch size limits | Carry over | `ticketSidekick.<kind>.maxReportSizeMB`/`maxBatchSizeMB` |

### Step 3: Bitbucket

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O12 | Review board: today's pipeline (quick, smart, deep, requirements pass), findings with note, copy for Teams and post comment, token usage, findings kept in the session | R20, R21, R26 | `@bitbucket` review and follow-ups |
| O13 | `bitbucket_read_findings` tool, so explain and goal questions are answered in chat | R22 | `@bitbucket` follow-ups |
| O14 | `/ts-bitbucket` skill: `review`, `check`, `usage`, `help` | R27 | `@bitbucket check`, `usage` |
| O15 | Remove `@bitbucket`, `src/participant/`, the `chatParticipants` contribution, follow-up chips, disambiguation entries and the participant walkthrough steps | R33, R37 | — |
| O16 | Final review of every developer and user document | R50 | — |

### Across all steps

| # | Open point | Note |
| --- | --- | --- |
| O17 | Keyboard and screen reader check of every board control | R46. The built boards use VS Code Elements and plain tables; not yet checked with a screen reader |
| O18 | `@bitbucket` is presented in the chat UI without a deprecation mark | `@jira`'s description now says "Deprecated" and names the imports, and the Jira walkthrough teaches the tools and boards. `@bitbucket` and the Bitbucket walkthrough still teach the participant |
| O19 | The participant checklist in `CLAUDE.md` ("Adding a new Bitbucket operation") still carries participant steps, marked as deprecated | R48. The Jira checklist no longer routes into `@jira`; drop the Bitbucket steps when `@bitbucket` goes |
| O20 | `docs/onboarding.md`, `docs/jira-flows.md`, `docs/report-import.md` and `docs/review-process.md` describe participant flows, each under a deprecation note | `docs/jira-flows.md` now marks the removed Step 1 flows as removed and keeps their rules as the reference the boards and tools follow. Rewrite or delete the rest with the step that removes the flow |

## 4. Open decisions

| # | Decision | Needed before |
| --- | --- | --- |
| Q1 | Can the extension call a language model outside a chat participant on the managed machine, also with the Local harness disallowed? The review board and the email check depend on it | O12, O8. If not, the review design is reopened before `@bitbucket` is removed |
| Q2 | Do the Bitbucket tools move into the catalog shape of the Jira tools (`defineTool`, generated `package.json` entries), or stay as they are with one tool added? | O13 |
| Q3 | How the review board shows progress during a long review, and whether it opens before or after the passes finish | O12 |
| Q4 | Whether the organisation plans to turn the Local harness off, and when. It changes urgency, not scope | — |
| Q5 | Mark the participants as deprecated in the chat UI now (O18), or only in the documentation? | Next release |

## 5. Not verified

| # | What | Why it is open |
| --- | --- | --- |
| V1 | A VS Code restart with a board open, in a real VS Code | The restore path is unit-tested against a stubbed VS Code only |
| V2 | Copilot choosing the tools and opening a board in a live chat, with this build | Confirmed by the maintainer on an earlier build of this branch; the smoke suite calls the tools directly |
| V3 | Boards against real Jira Data Center data | Needs real credentials (KL26) |
| V4 | The organisation's Copilot policy keeps allowing extension tools | Held on the managed machine in November 2026; if it changes, only the Command Palette boards remain |

## 6. Removal checklist for the end of the migration

When O5, O11 and O15 are done, none of the following is left:

- `src/participant/` and its tests
- `contributes.chatParticipants`, their slash commands and disambiguation entries in `package.json`
- The three import commands in the Command Palette
- `workspaceState` keys of the participant sessions (`jira.session.*`, `bitbucket.session.*`)
- The README sections "@jira — Jira" and "@bitbucket — Bitbucket PR Reviews" as participant manuals; their setup steps move to the top
- The deprecation notes added on 2026-11-13, since nothing deprecated remains to point at
- Guard tests tied to the participants (`jiraCommandsGuard.test.ts`, `importCommandsGuard.test.ts`, `importBoardParity.test.ts` with the import board parity ledger, the `@jira` command table in `skillsGuard.test.ts`)
