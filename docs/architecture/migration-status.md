# Migration status: from chat participants to tools and boards

Last updated: 2026-11-13.

This page says where the migration stands and what is still open. It is the working list; the other documents hold the detail:

- **Design as built:** [`boards-and-sessions.md`](boards-and-sessions.md)
- **Requirements (R-numbers below):** [`../plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](../plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md)
- **History, superseded:** [`copilot-harness-migration.md`](copilot-harness-migration.md) and the plans dated 2026-11-05 and 2026-11-09

Update this page in every change that closes or adds an open point.

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
| Single-ticket Jira work | 14 tools: check connection, view, find, list filters, workflow, list templates, list fields, check required fields, load, move, create, comment, update any field (set, add, remove), upload |
| Opening boards | `jira_open_board` tool, three Command Palette commands, `/ts-jira search`, `security-report`, `sessions` |
| Skills | `/ts-jira` (typed commands), `/ts-jira-create`, `/ts-jira-brief` |
| Session model | Sessions stored per workspace, shown from cache and checked in the background, conflicts, single-use write plans, native confirmation for risky writes, expiry and a clear command |
| Boards | Security report (filters, sort, CSV and Excel export), ticket list (search, bulk move, bulk field update), stored sessions |
| Documentation | README, manual, `CLAUDE.md`, glossary, architecture page and plan describe tools and boards as current and the participants as deprecated |

## 3. Open points

Ordered as the plan orders its steps. "Blocks removal of" names the participant flow that has to stay until the point is closed.

### Step 1: finish the Jira side

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O1 | Cleanup on the ticket list board: load the board from the `cleanupRules` of `.jira-templates.json`, with the rules' extra fields | R9 | `@jira cleanup` |
| O2 | Ticket list board parity: columns from `ticketSidekick.jira.searchFields`; narrowing by fix version, sprint, assignee and team JQL; more than 300 tickets; add or remove single values of a list field; resolving a conflict side by side instead of only dropping it | R7, R8, KL25 | `@jira search`, bulk transition, bulk field update |
| O3 | `/ts-jira spell-check KEY` | R28 | `@jira spell check` |
| O4 | `/ts-jira template KEY` (template entry from a ticket's fields) | R29 | `@jira` template generation |
| O5 | Remove every `@jira` flow that has a replacement, each only once its row in the plan's Replacement Map is in place: create, view, summarize, show fields, check required fields, comment, field, move, load, upload, workflow, check, search, filters, `/security-report`, and the description and comment preview (dropped by R30) | R33 | — |
| O6 | Written manual checklist for step 1, run on the managed machine before the normal release | R35 | — |

### Step 2: imports

| # | Open point | Requirement | Blocks removal of |
| --- | --- | --- | --- |
| O7 | Import board: start screen, Veracode, Waltz and email kinds on the session model, every review-screen action as a board control (create, merge and unmerge, accept and unaccept, add to ticket, rewrite, stale close, ticket merge with its resumable run, export) | R14 to R19 | `@jira` imports, the three Command Palette import commands |
| O8 | Email kind: boilerplate cleanup with consent as a board step; "add one email as a comment"; search for tickets matching an email's subject before creating | R18, R43 | `@jira` email import, email as comment |
| O9 | Model settings: one for the review passes, one for the email check, with a pick step when empty | R24, R25 | — |
| O10 | Prompts that belong to a board run happen on the board, before any model call | R45 | — |
| O11 | Remove the imports, the import commands, `@jira` itself and its help screen | R33, R34 | — |

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
| O18 | Chat UI still presents the participants without a deprecation mark | The `chatParticipants` descriptions in `package.json` and the Jira walkthrough pages under `walkthroughs/jira/` still teach `@jira`. Decide whether to mark them now or leave them until removal |
| O19 | Participant checklists in `CLAUDE.md` ("Adding a new Jira operation", "Adding a new Bitbucket operation") still carry participant steps, marked as deprecated | R48. Drop the steps when the participants go |
| O20 | `docs/onboarding.md`, `docs/jira-flows.md`, `docs/report-import.md` and `docs/review-process.md` describe participant flows, each under a deprecation note | Rewrite or delete with the step that removes the flow; the parsers, builders and services they describe are reused by the boards |

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
- Guard tests tied to the participants (`jiraCommandsGuard.test.ts`, the `@jira` command table in `skillsGuard.test.ts`)
