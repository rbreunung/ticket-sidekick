# Migration status: from chat participants to tools and boards

Last updated: 2026-11-16.

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
| **Deprecated** | The `@bitbucket` chat participant. It runs the pull request review until the review board exists and gets bug fixes only. `@jira` was removed on 2026-11-16 |
| **Removed, not coming back without a new decision** | The MCP server, the `ticketSidekick.jira.toolsFrom` setting, VS Code canvases, the agent plugin, the local HTTP server and its `http.noProxy` requirement |

## 2. What is done

| Area | State |
| --- | --- |
| Single-ticket Jira work | 16 tools: check connection, view, find, list filters, workflow, list templates, list fields, check required fields, load, move, create, comment, update any field (set, add, remove), upload, correct a description, create a template from a ticket |
| Opening boards | `jira_open_board` tool (with cleanup rules, fix version, sprint, assignee and team narrowing, and the import board with a report kind and path, or emails with their paths), five Command Palette commands, `/ts-jira search`, `cleanup`, `security-report`, `sessions`, `import` |
| Skills | `/ts-jira` (typed commands), `/ts-jira-create`, `/ts-jira-brief`, `/ts-jira-spell-check`, `/ts-jira-template` |
| Removed `@jira` flows | Every Step 1 flow: create, view, summarize, show fields, check required fields, comments, field, move, load, upload, workflow, check, search, filters, bulk transition, bulk field update, cleanup, `/security-report`, the description and comment preview, spell check and template generation. `@jira` has no slash command left. The Veracode and Waltz imports and their two Command Palette commands followed on 2026-11-15. On 2026-11-16 the email import, its Command Palette command, the `ticketSidekick.jira.showConnectionInfo` setting and `@jira` itself were removed ([`../plans/2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md`](../plans/2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md)) |
| Session model | Sessions stored per workspace, shown from cache and checked in the background, conflicts, single-use write plans, native confirmation for risky writes, expiry and a clear command; on every board a save after each write of an Apply, Apply progress with the controls locked, a rebuild from the stored recipe after an update that changes the stored format (`revalidate`), a `prepare` read before a plan's preview, and `relocate` to give a session a new source |
| Boards | Security report (filters, sort, CSV and Excel export), ticket list (search, 50 rows a page up to 300, `searchFields`/`cleanupFields` columns, bulk move, bulk field update with add and remove, cleanup by `cleanupRules` with nested subtasks, an out-of-date state that offers only Refresh), stored sessions, the import board for Veracode and Waltz reports (start screen with the template settings, tabs New, Already ticketed, Stale and Accepted, the ticket merge tab with its resumable run, per-tab out-of-date marks, Pick the file again, search, CSV and Excel export) and for emails (several `.eml` files, the boilerplate cleanup with the model check as a previewed step, the model pick and check, likely repeats by subject, a ticket or a comment per email with the attachments read from the file at the write). Close discards a board's session and closes its tab |
| Documentation | README, manual, `CLAUDE.md`, glossary, architecture page and plan describe tools and boards as current, `@jira` as removed and `@bitbucket` as deprecated |

## 3. Open points

Ordered as the plan orders its steps. "Blocks removal of" names the participant flow that has to stay until the point is closed.

### Step 1: finish the Jira side

O1, O2 and O5 are closed by [`../plans/2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md`](../plans/2026-11-14-1257-feat-ticket-list-parity-and-step1-removal-plan.md). Reading more than 300 tickets and a side-by-side conflict view were dropped as gaps there: `@jira` read 50 tickets and never noticed a changed one. A cleanup applies one page at a time (KL27), and a subtask created after the board loaded is not listed (KL28).

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O6 | Manual checklist: the Step 1 part is written in [`manual-checklist.md`](manual-checklist.md); run it on the managed machine against the preview build | R35 | — |

### Step 2: imports

Done. The Veracode and Waltz kinds are closed by [`../plans/2026-11-14-1641-feat-import-board-veracode-waltz-parity-plan.md`](../plans/2026-11-14-1641-feat-import-board-veracode-waltz-parity-plan.md); O7, O8 and O11, and the email parts of O9 and O10, by [`../plans/2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md`](../plans/2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md). The board's model call outside a chat request was confirmed on the managed machine (Q1). What is left of O9 and O10 belongs to the review board:

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O9 | The review passes read `ticketSidekick.bitbucket.reviewModel` and ask for a model on the review board when it is empty; the setting and the email check's pick already exist | R24 | — |
| O10 | The review board's prompts (model pick, requirements-pass choice) happen on the board, before any model call; the email consent already does | R45 | — |
| O21 | Run the email part of the [manual checklist](manual-checklist.md) on the preview build on the managed machine | R35 | — |

#### Import board parity ledger

What the `@jira` import did and what the import board does with it. The list is built from the reply commands of the removed chat catalog (kept as a list in `src/test/importBoardParity.test.ts`) and the optional capabilities of `ReportImportDescriptor` and `ImportChangeTracking` (`src/imports/descriptor.ts`); `src/test/importBoardParity.test.ts` fails when one of them is missing here. "Carry over" means the board keeps the behaviour with the same rules and results (R16); "Dropped" means a recorded decision not to. Every "Carry over" row is on the import board, the email rows included: the parity test maps each one to the board action or rule that keeps it and to the board scenario test that proves the result, and fails when a row has no such entry. The behaviour is described in [`docs/report-import.md`](../report-import.md). Why this ledger exists: [`docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md`](../solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md).

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
| `email-strip`, `email-keep`, `email-model-check`, `email-rows`, `email-save`, `email-cancel` | Carry over | The email boilerplate cleanup step with its consent; `cancel` is the board's Close |

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

**Rules with no command or capability of their own** (each one mapped by the test like the rows above)

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

#### Review board parity ledger

What `@bitbucket` does and what the review board and the Bitbucket tools do with it. The list is built from the code and docs of the participant, not from memory: the follow-up intents and reply words in `src/participant/reviewSessionState.ts` (`parseFollowUpIntent`, `isEndSessionRequest`, `parseSmartFallbackReply`), the chips of `computeBitbucketFollowups`, the `bitbucket.session.*` keys, every `ticketSidekick.bitbucket.*` setting in `package.json`, the review modes, the slash commands, the rules in [`docs/review-process.md`](../review-process.md), and the `@bitbucket` commits since 2026-11-01 (the only behaviour change among them is the "Jira isn't configured" line naming `/ts-jira check`, which the first step's unavailable-ticket reason replaces). `src/test/reviewBoardParity.test.ts` keeps the list, fails when a behaviour has no row here, and maps every "Carry over" row to the review board action, page request or Bitbucket tool that keeps it and to the scenario test that proves the result. "Carry over" means the board or a tool keeps the behaviour; a typed reply word becomes a board control. "Dropped" means the review board plan's scope or one of its settled decisions leaves it out, named in the note. Both this guard and the import board's stay after `@bitbucket` is removed. Why the ledger exists: [`docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md`](../solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md).

**Follow-up intents and reply words**

| Behaviour | Board | Note |
| --- | --- | --- |
| `explain` | Carry over | `#N <question>`: Explain under the finding, one call with its code, the PR title and description and the upfront question; explaining again replaces the answer |
| `copy` | Carry over | Copy for Teams as plain text, plus Copy as Markdown, for the selected findings or all of them; the typed word goes |
| `add` | Carry over | `add … to review`: select the findings, edit one draft comment each, Post after the native confirmation; inline on a verified line, else on the activity feed; each comment reported, only the failed ones offered again |
| `post it` | Carry over | The comment preview's confirmation is Post's preview and native confirmation |
| `refinement` | Carry over | A refinement instruction in the comment preview is Rewrite with a typed instruction, with Undo |
| `goal` | Carry over | "the goal is …" after a review: change the source or edit the goal, then Re-check runs only the requirements check on the stored diff and replaces the coverage |
| `finding-not-found` | Carry over | An unknown finding number is refused on the board; the read-findings tool names the numbers the review has |
| `diff-question` | Carry over | A general question about the PR: the agent reads the findings and the diff through the tools |
| `follow-up-failure` | Carry over | A failed follow-up or refinement keeps what was there: the earlier explanation or the hand-edited draft stays, with an error line |
| `finding-match` | Dropped | Scope: the extension's call that matches a free-text question to a finding; the agent does it from the findings list |
| `done`, `cancel` | Dropped | Scope: the reply words; a board is left by closing its tab |
| `smart-fallback-reply` | Dropped | Scope: the smart-mode fallback question and its replies `all` and `standard`; a review with no usable recommendation says so and the developer picks passes |

**Follow-up chips**

| Chip | Board | Note |
| --- | --- | --- |
| `chip-check`, `chip-copy`, `chip-add`, `chip-explain`, `chip-check-against-ticket`, `chip-post-it`, `chip-cancel`, `chip-done` | Dropped | Scope: follow-up chips. Each one's action is a board control or a `/ts-bitbucket` command |
| `finding-heading-links` | Dropped | Scope: clickable finding headings in chat; each finding has its own Explain |

**Sessions**

| Session | Board | Note |
| --- | --- | --- |
| `bitbucket.session.review` | Carry over | The review is the board's session: findings, passes run, explanations, drafts, coverage and the reviewed diff survive a restart, and a repeat request opens it |
| `bitbucket.session.commentPreview` | Carry over | Drafts are kept in the session until posted |
| `bitbucket.session.smartFallback` | Dropped | Scope: the smart-mode fallback question |
| `session-continuity` | Dropped | The removal takes out the chat sessions with `@bitbucket` (a settled decision of the plan): expiry through the chat history, a PR link that starts a fresh review over a live session (a repeat request now opens the stored review, also settled), `check` and `usage` keeping a session alive, and `/review` without a link or a lone mode word ending one |

**Slash commands**

| Command | Board | Note |
| --- | --- | --- |
| `/check` | Carry over | `bitbucket_check_connection` (`/ts-bitbucket check`) |
| `/review` | Carry over | `bitbucket_open_review` (`/ts-bitbucket review <url>`, or a plain chat request with a PR link) opens the board; without a link, the Command Palette start screen asks for it |
| `/usage` | Carry over | `bitbucket_token_usage` (`/ts-bitbucket usage`), without Bitbucket credentials |

**Review modes**

| Mode | Board | Note |
| --- | --- | --- |
| `standard` | Carry over | The regular pass every review starts with: pass 1, the budget-aware call with whole files, the requirements check when a source is chosen |
| `smart` | Carry over | The regular pass suggests persona passes from every batch's recommendation; the developer runs the suggestion or picks others |
| `deep` | Carry over | Picking all four persona passes and the critic, now or later |
| `quick` | Dropped | Scope: the quick review (pass 1 without the call with whole files) |
| `mode words` | Dropped | Scope: `review quick`/`smart`/`deep` in the prompt, its keyword priority, and the hands-off deep review from chat |

**Settings**

| Setting | Board | Note |
| --- | --- | --- |
| `ticketSidekick.bitbucket.baseUrl`, `ticketSidekick.bitbucket.authType` | Carry over | Data Center or Cloud, for the board and the tools; the connection check names a malformed base URL first |
| `ticketSidekick.bitbucket.reviewModel` | Carry over | The model every board call uses; asked for and saved on the first step when empty or unavailable |
| `ticketSidekick.bitbucket.reviewInstructions` | Carry over | Added to every review call, the persona passes and the critic |
| `ticketSidekick.bitbucket.modelContextTokens`, `ticketSidekick.bitbucket.contextBudgetRatio` | Carry over | The token budget that sizes the batches |
| `ticketSidekick.bitbucket.reviewContextLines` | Carry over | Context lines asked for with the diff |
| `ticketSidekick.bitbucket.reviewExcludePatterns` | Carry over | Excluded files are not reviewed, and a cut file they match is not fetched |
| `ticketSidekick.bitbucket.confidenceThreshold` | Carry over | Below it a finding is marked low confidence |
| `ticketSidekick.bitbucket.reviewMode` | Dropped | The staged review replaces the modes (a settled decision); the setting is removed with `@bitbucket` |
| `ticketSidekick.bitbucket.showTokenUsage` | Dropped | The board always shows the token usage per pass (the plan's decision on this setting); see `token-footer` |

**Pipeline rules** (from `docs/review-process.md`)

| Rule | Board | Note |
| --- | --- | --- |
| `batches` | Carry over | Files packed against the token budget (setting, model, 60 000) times the ratio and the 24 000-token cap |
| `dc-truncated-diffs` | Carry over | Files a Data Center server cut are fetched one by one and reviewed; a file still cut or not fetched is recorded with the pass |
| `dc-response-shape` | Carry over | The content-free shape line of every Data Center diff response in the output channel |
| `skipped-files` | Carry over | Files with no text change and excluded files are left out and counted |
| `anchor-verification` | Carry over | The line comes from the quoted code, not the model's number; code not found keeps the finding as location unverified; a finding naming a file outside the PR is dropped |
| `reply-parsing` | Carry over | A reply with no usable JSON is retried like a provider error |
| `retry-and-split` | Carry over | Three tries per call, the last one split in half for a batch; a batch that still fails is reported and the others are kept |
| `continuation` | Carry over | A cut-off reply gets one continuation call that lists the findings already reported |
| `whole-file-call` | Carry over | The call with the whole files a batch asked for refines the first findings and retracts one only by its number |
| `context-files` | Carry over | Context files are read at the reviewed commit, within the budget, and later passes see what the regular pass saw |
| `persona-passes` | Carry over | Security, performance, reliability and maintainability, each over every batch |
| `dedupe` | Carry over | Findings on the same line with the same meaning merge: stronger severity, combined sources, the corroboration bump |
| `finding-numbers` | Carry over | Numbers are assigned once per review and never change, so a removed finding leaves a gap (the chat renumbered after each review) |
| `critic` | Carry over | Removes what it cannot confirm, or labels it probably a false alarm when the developer worked on it; checks only unchecked findings |
| `partial-results` | Carry over | A pass with failed batches shows the other batches' findings under a banner |
| `failed-review` | Carry over | No batch readable: a failure banner, no findings, Run again |
| `upfront-question` | Carry over | The question goes into every review call; the agent passes it to the board instead of the prompt syntax (`question:`, `--`, a sentence ending in `?`) |
| `ticket-choice` | Carry over | An explicit key wins over the PR title's, none without a key, the ticket unavailable with a reason while Jira is not configured; the title-key pause (Use / Skip) is the first step, which always stops before Start, and the quick/standard hint chip goes with the chips |
| `ticket-read` | Carry over | The capped ticket text, read with a 20-second guard; a failed read lets the review finish without the check |
| `requirements-call` | Carry over | One call over the whole PR after the findings, the only call that sees ticket text, with at most one extra-file round; an unreadable reply says the check failed |
| `coverage-block` | Carry over | Shown above the findings as plain text |
| `token-meter` | Carry over | Every model call is metered, a frozen host model included, and recorded toward the counters |
| `monthly-counters` | Carry over | Per month and model, the current month and the two before |
| `token-footer` | Carry over | The board shows the token usage per pass |
| `review-completed` | Carry over | The first finished review sets the context key the Bitbucket walkthrough waits for |

### Across all steps

| # | Open point | Note |
| --- | --- | --- |
| O17 | Keyboard and screen reader check of every board control | R46. The built boards use VS Code Elements and plain tables; not yet checked with a screen reader |
| O18 | `@bitbucket` is presented in the chat UI without a deprecation mark | `@jira` is removed, and the Jira walkthrough teaches the tools and boards. `@bitbucket` and the Bitbucket walkthrough still teach the participant |
| O19 | The participant checklist in `CLAUDE.md` ("Adding a new Bitbucket operation") still carries participant steps, marked as deprecated | R48. The Jira checklist no longer routes into `@jira`; drop the Bitbucket steps when `@bitbucket` goes |
| O20 | `docs/onboarding.md`, `docs/jira-flows.md`, `docs/report-import.md` and `docs/review-process.md` describe participant flows, each under a deprecation note | `docs/jira-flows.md` now marks the removed Step 1 flows as removed and keeps their rules as the reference the boards and tools follow, and `docs/report-import.md` does the same for the Veracode and Waltz chat flows, with a section on the import board. Rewrite or delete the rest with the step that removes the flow |

## 4. Open decisions

| # | Decision | Needed before |
| --- | --- | --- |
| Q1 | Answered yes on 2026-11-16: on the managed machine with VS Code 1.146 and the Local harness hidden (`chat.editor.localAgent.enabled: false`; the `vscode.temporaryAllowLocalHarness` policy can only be set by the organisation), the import start screen listed the models, saved the pick and got "The model answered." from a call outside any chat request. Not tested with the organisation policy itself set | — |
| Q2 | Do the Bitbucket tools move into the catalog shape of the Jira tools (`defineTool`, generated `package.json` entries), or stay as they are with one tool added? | O13 |
| Q3 | How the review board shows progress during a long review, and whether it opens before or after the passes finish | O12 |
| Q4 | Whether the organisation plans to turn the Local harness off, and when. It changes urgency, not scope. VS Code 1.146's release notes deprecate the Local harness and announce its removal for February 2027, so the participants stop working then at the latest | — |
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
- `workspaceState` keys of the participant sessions (`bitbucket.session.*`; the `jira.session.*` keys are no longer read since `@jira` went and are left in place)
- The README section "@bitbucket — Bitbucket PR Reviews" as a participant manual; its setup steps move to the top
- The deprecation notes added on 2026-11-13, since nothing deprecated remains to point at
- Guard tests tied to the participants (`importBoardParity.test.ts` with the import board parity ledger, the `@jira` command table in `skillsGuard.test.ts`; `jiraCommandsGuard.test.ts` and `importCommandsGuard.test.ts` went with `@jira`)
