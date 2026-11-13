---
title: "Jira Tools over MCP for the Copilot Harness - Plan"
type: feat
date: 2026-11-05
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Jira Tools over MCP for the Copilot Harness - Plan

> **Superseded on 2026-11-13. Historical record only; do not plan against this document.** Ticket Sidekick no longer has an MCP server, a canvas program, an agent plugin or a local HTTP server. The tools are VS Code language model tools ("extension tools") and boards are webviews in editor tabs. The current design is [`docs/architecture/boards-and-sessions.md`](../architecture/boards-and-sessions.md) and the current plan is [`docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](../plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md).

## Goal Capsule

- **Objective:** In a Copilot-harness chat, where `@jira` is not available, a developer can view, find, load, comment on, update, move and create Jira tickets, check the connection, and get a structured developer brief of a ticket, through one set of tools that is never offered twice. `@jira` keeps working unchanged in the Local harness.
- **Means:** an MCP server inside the extension on a key-protected `127.0.0.1` port (KTD1), carrying 12 Jira tools that replace the 14 Agent Mode Jira tools, plus three skills (KTD11). Direction settled in [`docs/architecture/copilot-harness-migration.md`](../architecture/copilot-harness-migration.md), decision log §11.
- **Authority:** Product Contract requirements win on behavior; KTDs win on mechanism; units override neither.
- **Execution profile:** one feature branch, built in three review steps (PR1, PR2, PR3, each a pull request into the feature branch, merged in order; see Implementation Units), then one merge of the feature branch into `main`. `main` therefore never holds a half-moved tool set and stays releasable throughout. Each moved tool is removed as an Agent Mode tool in the same step that adds it to MCP, so no state offers a tool twice. The feature branch starts from `main`, not from the prototype branch; it brings along the architecture document and the two plans, but not `src/prototype/` or the prototype manual page.
- **Stop conditions:** stop and ask if a moved tool cannot keep a safeguard its Agent Mode version has (for example the never-guess issue type or the duplicate-comment guard), if VS Code refuses the MCP server definition the extension provides, or if the manual checklist fails on a managed Mac or a managed Windows machine.
- **Finished by:** `ce-work` implements, verifies and opens each PR into the feature branch; the user reviews and merges them, runs the manual checklist with a `.vsix` built from the feature branch on a managed Mac and a managed Windows machine, and then merges the feature branch into `main`.

---

## Product Contract

### Summary

The extension runs its own MCP server on `127.0.0.1` whenever `127.0.0.1` is in `http.noProxy`. It offers 12 Jira tools: view, find, list filters, load, move, workflow, check connection, list templates, create, comment, update field and upload attachment. The 14 Jira Agent Mode tools are removed as their replacements land. Two skills, `/ts-jira-brief` and `/ts-jira-create`, add the workflows a tool description cannot carry. When load ticket skips attachments it could still fetch, the agent shows them to the user as a numbered list to pick from. Users without the proxy entry are told at every start how to enable the tools.

### Problem Frame

VS Code now defaults new chats to the Copilot harness, where chat participants are not supported, so `@jira` only works in the Local harness. The extension's Agent Mode tools do work there, but they would sit next to the MCP server the architecture decided on, offering the model every capability twice and paying for both in the prompt. The prototype showed that MCP over a key-protected loopback port works in the Copilot harness once `127.0.0.1` bypasses the network proxy, and that without that entry the Copilot runtime sends local requests to a corporate proxy.

### Key Decisions

- **MCP is the only surface for Jira tools; moved tools are removed as Agent Mode tools.** Governs R1, R2. (session-settled: user-directed — chosen over keeping Agent Mode tools as a fallback or switching between both: no capability may be offered to the model twice.)
- **The server starts automatically whenever `127.0.0.1` is in `http.noProxy`.** Governs R3, R4. (session-settled: user-directed — chosen over an opt-in setting or the prototype's per-session start.)
- **Users without the proxy entry get a notice at every VS Code start and an onboarding step.** Governs R5. (session-settled: user-directed — chosen over a one-time notice or documentation only.)
- **The prototype's server core and its diagnostic report move into the product; the canvas, launcher and per-session commands stay on the prototype branch.** Governs R6, R26. (session-settled: user-directed — chosen over merging the whole prototype branch or porting the core alone.)
- **Writes are approved through the harness's tool approval only.** Governs R7. (session-settled: user-directed — chosen over an extension-owned modal or MCP elicitation; users who auto-approve tools get no extra confirmation. Changes the prototype's D4 for agent-initiated writes.)
- **View returns the whole ticket; a developer brief is a skill on top.** Governs R9, R22. (session-settled: user-directed — chosen over comment switches or a concise/full option.)
- **Search is one find tool plus a separate filter list; the search rules live in the find tool's description.** Governs R10, R11. (session-settled: user-directed — chosen over three tools or a /jira-search skill.)
- **Load always behaves the same; a list only adds attachments.** Governs R12. (session-settled: user-directed — chosen over a list that fetches attachments only, or two tools.)
- **Move discovers the workflow by itself; a separate workflow tool answers reachable statuses.** Governs R13, R14. (session-settled: user-directed — chosen over discovery as a mandatory separate step.)
- **Check connection is a new tool; the branch ticket is built into view and load.** Governs R15, R16. (session-settled: user-directed — chosen over a separate branch tool or a combined status tool.)
- **Templates, create, comment, update field and upload stay separate tools.** Governs R17, R18. (session-settled: user-directed — chosen over merging them, which would trigger approval prompts for reads or blur approvals.)
- **Free text is written as Markdown and converted to Jira wiki markup, as `@jira` does.** Governs R19. (session-settled: user-directed — chosen over tools that take wiki markup as today.)
- **Three skills under one prefix: the explicit-only `/ts-jira-brief` and `/ts-jira` command router, and `/ts-jira-create`, which the agent also starts by itself.** Governs R21, R22, R23, R35. (session-settled: user-directed — chosen over one model-invocable skill per `@jira` command and over MCP prompts, which the Copilot harness does not offer. The router was added after a plain "load ticket" request ran the brief skill, and was chosen over MCP server instructions, which the Copilot harness includes only for allowlisted servers, and over one explicit-only skill per command. The brief skill and the router became explicit-only after a model without thinking kept running a model-invocable skill in place of `/ts-jira`, chosen over hardening the wording further or requiring thinking, which a skill cannot enforce. `/ts-jira-create` stays model-invocable so a plain request for a new ticket goes through a template and a draft rather than a bare create, accepting that a model without thinking may sometimes start it unasked; its draft step and Copilot's approval keep that from creating a ticket. The `ts-` prefix keeps the skills from clashing with other extensions' skills, and the router names no other skill: `help brief` and `help create` print help files from its folder.)
- **Tests add an e2e check through VS Code's own MCP client; a real-Jira e2e is a follow-up.** Governs R27, R28. (session-settled: user-directed — chosen over an activation-only e2e or including the real-Jira workflow in this phase.)
- **The user picks skipped attachments to fetch after the load answer, from a numbered list the agent shows.** Governs R30, R31. (session-settled: user-directed — chosen over an inline panel with Load buttons, which VS Code attaches to every load result and which, after a window reload in the Copilot harness, shows a loading error until the MCP server reconnects; also over a question during the load or leaving it to the agent.)
- **The agent is not told separately what was loaded; it learns it from the answer of the load it makes.** Governs R31. (session-settled: user-directed — chosen over a context note from a panel, which the Copilot harness drops: VS Code passes a generic text attachment from an MCP App on to Local agents only.)
- **A write Jira does not answer within 30 seconds is reported as possibly saved.** Governs R29. (session-settled: user-directed — chosen over no time limit on writes, which leaves a hung call without feedback, or a 2-minute limit, which surfaces a hang later.)

### Requirements

**Server and surface**

- R1. All Jira tools available to agents are served by the extension's MCP server; after this work, no Jira Agent Mode tool (`contributes.languageModelTools` entry starting with `jira_`) exists.
- R2. At no merged state is the same Jira capability offered both as an MCP tool and as an Agent Mode tool.
- R3. The MCP server runs on `127.0.0.1` with a random port and a random per-start bearer key, and is offered to VS Code only while `127.0.0.1` is in `http.noProxy`.
- R4. The server starts at activation when the entry is present, stops when it is removed, starts again when it is added, and refuses MCP requests whenever the entry is missing; it does not depend on Jira being configured.
- R5. While the entry is missing, every VS Code start on a version with the MCP provider API (1.101 or later) shows a notice that explains what the entry is for and offers to open the setting, and the Jira onboarding walkthrough has a step for it.
- R6. Every request passes the ported request guard: exact `Host` `127.0.0.1:<port>`, no foreign `Origin`, and the bearer key, before any Jira call; no response or log line contains the key or a Jira token.
- R7. Write tools are marked as destructive, and the tools that only read Jira (view, find, list filters, workflow, check connection, list templates) as read-only; load ticket carries neither marking, since it writes local files. The harness asks before each write and shows the tool's arguments; the extension adds no confirmation of its own. Because that approval shows only the arguments, not the values the extension looks up, list templates shows each template's default fields, and the results of create, update field and move report what changed: the previous value, the previous status and the template fields applied.

**The 12 tools**

- R8. The tools are: view ticket, find tickets, list my filters, load ticket, move ticket, workflow, check connection, list templates, create ticket, add comment, update field, upload attachment.
- R9. View ticket returns the fields defined by the display settings (`additionalDisplayFields`, `hiddenDisplayFields`), the full description, all comments newest first up to 100 with a note when there are more, and the attachments with name, size and type.
- R10. Find tickets takes either JQL or a saved filter (id or name), with optional narrowing by fix version, sprint, assignee and the team JQL, supports paging, and shows the columns from `searchFields`.
- R11. Find tickets' description tells the agent that "my team" means the `myTeamJql` setting and to prefer a matching saved filter over new JQL; list my filters returns the user's favourite and owned filters.
- R12. Load ticket always writes `ticket.md`, `comments.md` and the eligible attachments into `.jira-context/<KEY>/`, reports the files it wrote as absolute paths, lists every skipped attachment with size and reason, and additionally downloads attachments named in an optional list without the type filter; the size limit still applies.
- R13. Move ticket moves a ticket to a target status, directly or along a workflow path; it discovers the workflow itself when no workflow is cached or the cached one has no path to the target. A move that stops partway is reported with the status the ticket landed in and is never retried.
- R14. Workflow lists the statuses a ticket can reach, discovering the workflow by itself when nothing usable is cached, and refreshes the workflow cache on request. It stays marked read-only: its only write is the local workflow cache, never Jira.
- R15. Check connection reports base URL, auth type, token presence and the signed-in user, or a setup hint naming what is wrong; it gives the same answer as `@jira check`.
- R16. View ticket and load ticket take the ticket key as optional; without one they use the key in the current git branch of the first workspace folder and name that folder and branch in the result, or say that the branch holds no key. Write tools always require an explicit key.
- R17. List templates returns the workspace templates; create ticket creates one ticket, prefers a template over a bare issue type, and never guesses an issue type.
- R18. Add comment, update field and upload attachment keep today's behavior: the duplicate-comment guard, the supported field list with name resolution, and the size limit. Upload accepts only files that, after resolving symlinks, lie inside an open workspace folder (wherever that folder is) and have no dotfile or dotfolder segment; this deliberately narrows today's home-folder rule for MCP, while `@jira upload` keeps today's rule.
- R19. Free-text inputs (comment text, create description, update-field text values) are taken as Markdown and sent to Jira as wiki markup through the same conversion `@jira` uses.
- R20. Every tool that fails because Jira is not configured answers with the setup hint `@jira` gives, never a raw error.
- R29. When a Jira call fails, a tool tells the agent only the HTTP status and a short reason, capped in length, never Jira's or a proxy's response body; the full error text goes to the Ticket Sidekick Output channel for diagnosis. Every Jira call made by an MCP tool times out after about 30 seconds and answers that Jira did not respond in time, except an attachment download, which times out after about 2 minutes and fails only that file. A write that times out is answered with a warning that the change may still have been saved and that the ticket should be checked before trying again, and an identical write within the following minute is skipped.

**Skipped attachments**

- R30. When load ticket skips at least one attachment that a second request could fetch (a type not downloaded by default, or a failed download), its answer lists those attachments numbered, each name once, and lists too-large and unsafe-name skips apart, without numbers, with their reason.
- R31. The answer tells the agent to show the user the numbered list as written, ask which to download (numbers, or all), and then call load ticket with the chosen names; it does not download them without asking unless the user's request already named them.

**Skills**

- R21. The extension contributes three skills: `/ts-jira-brief` and `/ts-jira`, which run only when the user types them, and `/ts-jira-create`, which the agent also starts by itself when the user asks for a new ticket; none repeats what a tool description already says.
- R22. `/ts-jira-brief` produces a developer brief with eight sections in order: problem or goal, context, steps to reproduce with expected and actual result, acceptance criteria, decisions and findings from comments with author and date, current state, open questions and missing information, and sources used. A section the ticket does not cover says "not stated in the ticket"; derived acceptance criteria are marked as derived; it reads relevant attachments through load ticket and lists those it could not read.
- R23. `/ts-jira-create` guides template choice, asks only for missing fields, shows the drafted summary and description, then calls create ticket.
- R35. `/ts-jira <command> <arguments>` runs only when the user types it and maps each command (load, view, search, filters, comment, field, move, workflow, templates, upload, check) to one tool and names no skill; without a command, with `help [command]`, with an unknown command or with a missing required argument it shows its help, or the command's help line, and calls no Jira tool. `help brief` and `help create` print a page on `/ts-jira-brief` and `/ts-jira-create`: what each is for, an example, and what to do without it; the router's own text names no skill.

**Diagnostics and documentation**

- R24. Every former basic `@jira` command (`view`, `load`, `search`, `comment`, `field`, `move`, `create`, `check`) maps to at least one tool or skill.
- R25. The user manual documents the MCP tools, the three skills, the `http.noProxy` requirement and a manual chat checklist; the Agent Mode tools page keeps only the Bitbucket tools.
- R26. A command copies a diagnostic report of the MCP server (state, whether it is offered, request counts, Host and Origin values seen, MCP settings, and the stored-key search) with every key and token removed.

**Tests**

- R27. Each tool has an integration test over a real loopback socket against the mock Jira client; a guard test fails when a skill names a tool that does not exist or a basic `@jira` command has no tool or skill; the docs-sync test checks the MCP tool list instead of Jira Agent Mode tools.
- R28. The CI e2e job checks, in a real VS Code, that VS Code's own MCP client connects to the server, lists the tools and calls check connection, and that the tools disappear when the proxy entry is removed.

### Acceptance Examples

- AE1. **Covers R4, R5.** Given VS Code 1.101 or later and `http.noProxy` lacking `127.0.0.1`, when VS Code starts, then no server listens, no MCP server is offered, and the notice appears; when the user adds the entry, the server starts and the tools appear without a restart.
- AE2. **Covers R16.** Given the branch `feature/PROJ-123-login`, when the agent calls view ticket without a key, then it returns PROJ-123 and states that the key came from the branch; on `main` it answers that the branch holds no key.
- AE3. **Covers R12.** Given a ticket with `heap-dump.bin` (binary) and `log.txt`, when load runs without a list, then `log.txt` is written and `heap-dump.bin` is listed as skipped; with `["heap-dump.bin"]` both are written, along with `ticket.md` and `comments.md`.
- AE4. **Covers R13.** Given no cached workflow and a target two transitions away, when move ticket runs, then it discovers the workflow, moves through both steps and names them in its result.
- AE5. **Covers R19.** Given a comment written with a Markdown heading, a list and a table, when add comment runs, then Jira receives `h2.`, `*` list items and a `||`-headed table.
- AE6. **Covers R20.** Given no Jira token, when any tool runs, then it answers with the setup hint naming the missing token.
- AE7. **Covers R22.** Given a ticket whose description has no acceptance criteria, when `/ts-jira-brief` runs, then the acceptance criteria section is marked derived or says "not stated in the ticket", and the sources section lists the comments and attachments used.
- AE8. **Covers R30, R31.** Given a ticket with `design.dat` (not downloaded by default), `dump.log` (download failed), `huge.iso` (300 MB) and `../../evil.txt`, when load ticket runs, then its answer numbers `design.dat` and `dump.log`, lists the other two apart with their reasons, and tells the agent to ask the user which to download; when the user answers "all", the agent calls load ticket with both names and they are written into `.jira-context/<KEY>/attachments/`.

### Success Criteria

- The manual checklist passes in a Copilot-harness chat on a managed Mac and a managed Windows machine, each with `127.0.0.1` in `http.noProxy`: every R8 tool answers, all three skills run, and no Jira Agent Mode tool is listed.
- The model's tool list in a Copilot-harness session contains each Jira capability once.

### Scope Boundaries

- Deferred for later: the Bitbucket tools (they stay Agent Mode tools in this phase), the imports, cleanup, `/security-report`, the canvas board and the session engine.
- Deferred for later: switching `@jira`'s own branch lookup to the explicit-folder lookup of KTD7.
- Considered and not built: an Agent Mode fallback when MCP cannot run (rejected: it reintroduces duplicates); a concise/full output switch (rejected: results follow settings); MCP prompts as entry points (not supported by the Copilot harness, per `src/vs/platform/agentHost/test/node/e2e/suites/mcpSideChannelSuite.ts`); an inline panel (MCP App) with Load buttons under the load result, built as a probe and removed: VS Code ties the panel to the tool definition, so every load result gets one, and after a window reload in the Copilot harness each shows a loading error until the server reconnects; its context note did not reach the agent there either (revisit if VS Code attaches views per result and forwards app context notes to the Copilot harness).

### Deferred to Follow-Up Work

- A nightly or on-demand e2e workflow against a real Jira Cloud test site, once the user has created the site and stored a token as a GitHub Actions secret. It covers the shared and Cloud-specific paths, not Data Center specifics.
- Checking the tools with a second VS Code window open and in remote windows (Remote-SSH, WSL, Dev Containers), when a use case needs them.

### Dependencies / Assumptions

- VS Code 1.101 or later for the MCP provider API; the prototype was built and tested against 1.144 with the Copilot harness. On older versions the extension offers no Jira tools to agents; `@jira` still works.
- Users who want the tools add `127.0.0.1` to `http.noProxy` themselves; the extension never writes settings. On the managed Mac and Windows machines in scope, users can edit this setting (confirmed by the user; IT does not lock it).

### Sources / Research

- Decision log and test results: [`docs/architecture/copilot-harness-migration.md`](../architecture/copilot-harness-migration.md) §11; prototype plan [`docs/plans/2026-11-05-1230-feat-copilot-harness-localhost-prototype-plan.md`](2026-11-05-1230-feat-copilot-harness-localhost-prototype-plan.md); prototype code on the branch `claude/intelligent-planck-gue5hu` under `src/prototype/`.
- Today's tools: `src/tools/jiraTools.ts` (14 Jira tools, safeguards), `src/participant/jira/loadHandler.ts` (`loadTicketToWorkspace`, uses `vscode.workspace.fs`), `src/participant/jira/ticketContext.ts` (`resolveTicketFromBranch`, runs `git` without a working directory), `src/participant/JiraParticipant.ts` (`@jira check`), `src/utils/markdownToJiraWiki.ts`.
- VS Code: extension skills via `contributes.chatSkills` (VS Code docs, agent skills); extension skills are synced to the Agent Host (`agentHostLocalCustomizations.ts`); MCP tools are deferred and found through tool search in the Copilot harness (Agent Host `AGENTS.md`); VS Code registers MCP tools with its language-model tool service (`mcpLanguageModelToolContribution.ts`); `workbench.mcp.startServer` (`mcpCommandIds.ts`); an MCP App view is attached to a tool's definition, not to a result (`mcpLanguageModelToolContribution.ts`), and the Copilot harness drops generic text attachments such as an app's context note (`agentHostSessionHandler.ts`, `_convertVariableToAttachment`).

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Product code lives in `src/mcp/`: vscode-free modules plus one glue file, `src/mcp/register.ts`.** The ported modules are the request guard, keys, `http.noProxy` check, localhost server, MCP server builder and report from `src/prototype/`. The prototype branch is not merged; its code is copied and trimmed. Governs the mechanism of R3, R6, R26.
- KTD2. **One bearer key, no canvas key.** The canvas route and its key leave with the canvas (deferred), so the guard only knows `/mcp`. A later canvas phase adds its route back.
- KTD3. **A single tool catalog drives the server, the docs-sync test and the skill guard.** `src/mcp/jiraTools/catalog.ts` exports each tool's name, title, description, input schema, read-only or destructive annotation and handler. The server registers from it, `userDocsSync.test.ts` checks the manual against it, and the skill guard checks skill text against it.
- KTD4. **Handlers reuse today's services and formatters instead of reimplementing them.** `TicketService`, `WorkflowService`, `TemplateService`, `FieldResolver`, `attachmentEligibility`, `pathSafety`, `RecentCallGuard` and the pure message builders in `src/participant/session/toolMessages.ts` stay the single implementation; the MCP handlers are thin, as `jiraTools.ts` is today. Any builder text that names a tool takes the name from the catalog (KTD3), so no message an agent reads points at a removed or renamed tool; skipped attachments are fetched by calling load ticket with their names.
- KTD5. **Tool names keep the `jira_` prefix in snake case** (`jira_view_ticket`, `jira_find_tickets`, …), so a later Bitbucket phase can share the same server without name clashes.
- KTD6. **The load core moves to Node `fs` behind a small writer interface,** so it becomes vscode-free and testable. `@jira load` and the MCP load tool both use it; `.gitignore` handling for `.jira-context/` is kept.
- KTD7. **The branch lookup runs `git branch --show-current` with the first workspace folder as working directory** (`execFile`, no shell, short timeout) and extracts the key with `extractTicketId`. The result names the folder and branch used, so a multi-root mismatch is visible.
- KTD8. **Annotations decide the harness approval:** reads carry `readOnlyHint: true`; Jira writes carry `destructiveHint: true`; load carries neither, since it writes only local files. No extension modal.
- KTD9. **Markdown conversion happens in the handlers** of add comment, create ticket (description) and update field (text values), with `markdownToJiraWiki()`; the tool descriptions say "Markdown".
- KTD10. **The connection check becomes a pure function shared with `@jira check`,** so both give the same answer from the same code.
- KTD11. **Skills are contributed through `contributes.chatSkills`** from `skills/<name>/SKILL.md`, with `name` equal to the folder name; every `ts-` skill except `ts-jira-create` sets `disable-model-invocation: true`, and help pages a skill prints sit as files in its folder, which VS Code syncs to the Copilot harness with the skill.
- KTD12. **The e2e test drives VS Code's own MCP client.** It writes `http.noProxy` and tool auto-approval into the throwaway profile in `src/e2e/runTest.ts`, starts the server through VS Code, waits for the tools in `vscode.lm.tools`, invokes check connection with `vscode.lm.invokeTool`, then removes the entry and expects the tools to disappear. If VS Code does not expose MCP tools to extensions that way, the test is reduced to activation and server lifecycle, and the plan's coverage note says so.
- KTD13. **The diagnostic report becomes `Ticket Sidekick: Copy MCP diagnostics`,** without the prototype's rendezvous and launcher sections, keeping the stored-key search over the Copilot home, VS Code logs and VS Code storage, and adding the restart, client, proxy-evaluation and tool-outcome sections of U5.
- KTD14. **One shared wrapper turns Jira failures into tool answers** for every MCP Jira tool, from the first read tool on: a timeout of about 30 seconds on each Jira read and a longer one (about 2 minutes) on each attachment download, where a download that times out is reported as a failed download for that file only, a short status-and-reason answer for the agent, and the full error logged through `logDiag`. The check connection tool from PR1 moves onto it in the same step.
- KTD15. **Skipped attachments are offered through load ticket's own answer text.** The answer numbers the fetchable skipped attachments with the same fetchable rule that decides what a second request can get (`not-default-type`, `download-failed`), and its closing instruction asks the agent to let the user pick. A number maps back to a name in the same answer, so the agent passes names, never numbers, to load ticket. Governs the mechanism of R30, R31.

### High-Level Technical Design

Components after this work:

```mermaid
flowchart TB
  subgraph Clients
    CH["Copilot-harness chat<br/>(Agent Host)"]
    LA["Local Agent Mode"]
    E2E["CI e2e test<br/>(VS Code's MCP client)"]
  end
  subgraph EXT["Ticket Sidekick extension"]
    REG["src/mcp/register.ts<br/>provider, lifecycle, notice, diagnostics"]
    SRV["Localhost server<br/>guard: Host, Origin, key, noProxy"]
    CAT["Tool catalog<br/>12 Jira tools"]
    SK["Skills<br/>/ts-jira-brief, /ts-jira-create"]
    SVC["TicketService, WorkflowService,<br/>TemplateService, load core"]
    JP["@jira participant<br/>(Local harness, unchanged)"]
    BB["Bitbucket Agent Mode tools<br/>(unchanged this phase)"]
  end
  CH & LA & E2E -->|"HTTP 127.0.0.1 + bearer"| SRV
  REG --> SRV --> CAT --> SVC
  JP --> SVC
  SVC --> JIRA[("Jira DC / Cloud")]
  SK -.instructions.-> CH
```

Server lifecycle:

```mermaid
stateDiagram-v2
  [*] --> Off: activation
  Off --> Running: 127.0.0.1 in http.noProxy
  Off --> Off: entry missing (notice at start)
  Running --> Off: entry removed
  Running --> Off: deactivate
  Running --> Running: Jira config changes (tools re-read config per call)
```


### Output Structure

```text
src/mcp/
  keys.ts  requestGuard.ts  proxyBypass.ts  localhostServer.ts   (ported)
  mcpServer.ts            builds the MCP server from the catalog
  register.ts             vscode glue: provider, lifecycle, notice, diagnostics command
  report.ts               diagnostics report (ported, trimmed)
  branchTicket.ts         key from the current branch
  connectionCheck.ts      shared with @jira check
  jiraTools/
    catalog.ts            the 12 tool definitions
    viewTicket.ts  findTickets.ts  loadTicket.ts  moveTicket.ts  workflow.ts
    templates.ts  createTicket.ts  addComment.ts  updateField.ts  uploadAttachment.ts
skills/
  ts-jira-brief/SKILL.md
  ts-jira-create/SKILL.md
src/test/mcp*.test.ts
```

### Assumptions

- MCP tools served this way appear in VS Code's tool registry under names VS Code derives from the server and tool names; the e2e unit confirms the exact form first (KTD12).

---

## Implementation Units

| U-ID | Title | Main files | Depends on |
| --- | --- | --- | --- |
| U1 | Port the server core | `src/mcp/keys.ts`, `requestGuard.ts`, `proxyBypass.ts`, `localhostServer.ts`, `mcpServer.ts` | — |
| U2 | Server lifecycle and provider | `src/mcp/register.ts`, `src/extension.ts`, `package.json` | U1 |
| U3 | Proxy-entry notice and onboarding step | `src/mcp/register.ts`, `package.json`, `walkthroughs/jira/` | U2 |
| U4 | Check connection tool | `src/mcp/connectionCheck.ts`, `src/mcp/jiraTools/catalog.ts` | U1 |
| U5 | Diagnostics command | `src/mcp/report.ts`, `src/mcp/register.ts` | U2 |
| U6 | E2E through VS Code's MCP client | `src/e2e/runTest.ts`, `src/e2e/suite/*` | U2, U4 |
| U7 | View ticket and branch key | `src/mcp/jiraTools/viewTicket.ts`, `src/mcp/branchTicket.ts` | U4 |
| U8 | Find tickets and list filters | `src/mcp/jiraTools/findTickets.ts` | U4 |
| U9 | Load ticket | `src/mcp/jiraTools/loadTicket.ts`, `src/participant/jira/loadHandler.ts` | U7 |
| U10 | Workflow and list templates | `src/mcp/jiraTools/workflow.ts`, `templates.ts` | U4 |
| U11 | Retire the moved read tools; docs | `src/tools/jiraTools.ts`, `package.json`, `docs/manual/*`, `src/test/userDocsSync.test.ts` | U7–U10 |
| U12 | `/ts-jira-brief` skill and skill guard | `skills/ts-jira-brief/SKILL.md`, `package.json`, `src/test/mcpSkillsGuard.test.ts` | U7, U9 |
| U13 | Markdown conversion for text inputs | `src/mcp/jiraTools/text.ts` | U4 |
| U14 | Write tools | `moveTicket.ts`, `createTicket.ts`, `addComment.ts`, `updateField.ts`, `uploadAttachment.ts` | U10, U13 |
| U15 | Retire the remaining Jira tools; docs | `src/tools/jiraTools.ts`, `package.json`, `docs/manual/*` | U14 |
| U16 | `/ts-jira-create` skill and command coverage | `skills/ts-jira-create/SKILL.md`, `src/test/mcpSkillsGuard.test.ts` | U14, U12 |
| U17 | Numbered list of skipped attachments | `src/mcp/jiraTools/loadTicket.ts`, `src/test/mcpTools.test.ts`, `docs/manual/copilot-tools.md` | U9 |
| U18 | `/ts-jira` command router | `skills/ts-jira/SKILL.md`, `package.json`, `src/test/mcpSkillsGuard.test.ts` | U14, U16 |

### PR1 (into the feature branch): MCP server and check connection

Waits on: nothing.

### U1. Port the server core

- **Goal:** the prototype's security core and server, trimmed to the MCP route, as product code.
- **Requirements:** R3, R6; KTD1, KTD2.
- **Dependencies:** none.
- **Files:** `src/mcp/keys.ts`, `src/mcp/requestGuard.ts`, `src/mcp/proxyBypass.ts`, `src/mcp/localhostServer.ts`, `src/mcp/mcpServer.ts`, `src/test/mcpGuard.test.ts`, `src/test/mcpServer.test.ts`, `package.json` (dependencies `@modelcontextprotocol/sdk`, `zod`).
- **Approach:**
  1. Copy the prototype modules from `src/prototype/` on the prototype branch; drop the canvas route, the canvas key and the plan store.
  2. `mcpServer.ts` builds a stateless MCP server per request from a catalog of tool definitions (KTD3), registering each with its annotations.
  3. The server's `allowMcp` gate calls the `http.noProxy` check on every request.
  4. The `http.noProxy` check counts only the bare `127.0.0.1` entry (a port wildcard only if U6 shows VS Code and the Copilot runtime honour it for every port). An entry such as `127.0.0.1:8080` bypasses the proxy for that port only, so it counts as missing: no start, and the notice appears.
- **Patterns to follow:** the prototype's tests (`prototypeGuard.test.ts`, `prototypeServer.test.ts`, `prototypeProxyBypass.test.ts`), copied and trimmed.
- **Test scenarios:**
  - A request without the bearer key is refused with 401 and reaches no handler.
  - A wrong `Host` (`localhost:<port>`) is refused with 403.
  - A foreign `Origin` is refused with 403.
  - With `allowMcp` false, a valid request is refused with 403 and counted as `mcp-disabled`.
  - The server listens on `127.0.0.1` with a non-zero port and stops accepting after stop.
  - `["127.0.0.1"]` counts as bypassed; `["127.0.0.1:8080"]` does not.
  - A catalog of one test tool is listed and callable through the official MCP client.
- **Verification:** the ported tests pass; no module imports `vscode`.

### U2. Server lifecycle and provider

- **Goal:** the server runs exactly while the proxy entry exists, and VS Code knows about it.
- **Requirements:** R3, R4; KTD1.
- **Dependencies:** U1.
- **Files:** `src/mcp/register.ts`, `src/extension.ts`, `package.json` (`contributes.mcpServerDefinitionProviders`), `src/test/mcpLifecycle.test.ts`.
- **Approach:**
  1. At activation, feature-detect the MCP provider API (prototype `vscodeMcpTypes.ts`); without it, register nothing and log once.
  2. Start the server when `http.noProxy` holds `127.0.0.1`; on `onDidChangeConfiguration` for `http.noProxy`, start or stop accordingly and fire the provider's change event.
  3. The provider returns one HTTP definition (URL plus `Authorization` header) while running, otherwise none; `deactivate` stops the server. It also implements the resolve hook VS Code calls just before connecting (`resolveMcpServerDefinition`, as the prototype does): it returns the current URL and key while running and refuses while stopped, so no client connects with a stale port or key.
  4. Jira configuration is not a start condition: tools read it per call (R20).
  5. Start, stop and refused requests are logged through `logDiag('mcp', …)`; tool calls are logged by tool name and outcome only, never with arguments, keys or tokens.
- **Patterns to follow:** the prototype's `register.ts` and `prototypeLifecycle.test.ts` (per-file `vi.mock('vscode')`).
- **Test scenarios:**
  - Covers AE1. Without the entry, activation starts no server and the provider offers nothing.
  - Covers AE1. Adding the entry starts the server, fires the change event and makes the provider offer one definition with a bearer header.
  - Removing the entry stops the server and the provider offers nothing.
  - A restart of the server yields a different bearer key.
  - After a restart, the resolve hook returns the new port and key, never the old ones; while stopped it refuses.
  - Without the provider API, activation registers nothing and does not throw.
  - Across start, stop and restart, no setting is written.
- **Verification:** lifecycle tests pass; `bundleSmoke.test.ts` still passes.

### U3. Proxy-entry notice and onboarding step

- **Goal:** users without the entry learn at every start why the Jira tools are missing and how to enable them.
- **Requirements:** R5.
- **Dependencies:** U2.
- **Files:** `src/mcp/register.ts`, `package.json` (walkthrough step in `ticket-sidekick.jiraGettingStarted`), `walkthroughs/jira/copilot-tools.md`, `src/test/mcpLifecycle.test.ts`.
- **Approach:** at activation without the entry, and only when the MCP provider API exists (on older VS Code the entry would not help), show a non-modal notice explaining that the Jira tools for Copilot chats need `127.0.0.1` in `http.noProxy` (and why), with **Open Setting**; the walkthrough step explains the same and links the setting.
- **Patterns to follow:** existing walkthrough steps in `package.json` and `walkthroughs/jira/`.
- **Test scenarios:**
  - Covers AE1. Without the entry, activation shows the notice and Open Setting opens `http.noProxy`.
  - With the entry, no notice appears.
  - Without the provider API, no notice appears even when the entry is missing.
- **Verification:** tests pass; the walkthrough lists the new step.

### U4. Check connection tool

- **Goal:** the first MCP tool, and the shared connection check.
- **Requirements:** R8, R15, R20; KTD3, KTD10.
- **Dependencies:** U1.
- **Files:** `src/mcp/connectionCheck.ts`, `src/mcp/jiraTools/catalog.ts`, `src/participant/JiraParticipant.ts` (uses the shared check), `src/test/mcpTools.test.ts`.
- **Approach:**
  1. Move the `@jira check` logic (base-URL validation, `getCurrentUser`, the result table, the failure text) into a pure function returning structured facts plus Markdown.
  2. `@jira check` renders it as today; the tool returns the same Markdown.
- **Execution note:** characterize today's `@jira check` output in a test before moving the code.
- **Test scenarios:**
  - With valid config, the tool reports base URL, auth type, token set and the signed-in user from the mock.
  - Covers AE6. Without a token, the tool answers with the setup hint naming the missing token.
  - With an invalid base URL, the tool answers with the configuration problem text.
  - `@jira check` output is unchanged (characterization).
- **Verification:** tests pass; the catalog holds one tool.

### U5. Diagnostics command

- **Goal:** a support report for proxy and MCP problems at users' sites.
- **Requirements:** R26; KTD13.
- **Dependencies:** U2.
- **Files:** `src/mcp/report.ts`, `src/mcp/register.ts`, `package.json` (command), `src/test/mcpReport.test.ts`.
- **Approach:** port the prototype report without rendezvous and launcher sections; keep server state, offered yes/no with the reason, request counts, Host and Origin values, `chat.mcp.*` and sandbox settings, and the stored-key search. Add, from in-memory counters only:
  1. VS Code and extension versions, and whether the MCP provider API is present.
  2. Server history this session: each start and stop with time and trigger (activation, entry added, entry removed, deactivate), the current port and earlier ports.
  3. Definition handshake: change announcements fired, resolve-hook calls served and refused.
  4. Refused key checks split into "key from an earlier start" (a stale client, recognised by short fingerprints of this session's earlier keys, never the keys) and "unknown key".
  5. MCP clients seen: user-agent and time of last request.
  6. Proxy evaluation: the loopback-related `http.noProxy` entries and why each counts or not; other entries only counted, since they may name internal hosts; whether `http.proxy` is set and system proxy discovery is on (yes/no).
  7. Tool calls per tool: success and failure counts, failures by error class or Jira HTTP status; never arguments or results.
  8. Jira configuration: configured yes/no, auth type, token present yes/no; no base URL.
  Redact keys and tokens at the end.
- **Test scenarios:**
  - A report built from facts containing the key and the Jira token contains neither.
  - The key search reports a planted key by file path only.
  - The report states "offered: no (127.0.0.1 in http.noProxy: no)" when the entry is missing.
  - After a restart, a request with the earlier key is counted as "key from an earlier start", and the report lists both ports.
  - With `127.0.0.1:8080` and an internal host in `http.noProxy`, the report shows the port entry as ignored and the internal host only as a count.
  - A failed tool call appears as its tool name and HTTP status, with no argument text.
- **Verification:** tests pass; the command is documented (R25).

### U6. E2E through VS Code's MCP client

- **Goal:** prove in a real VS Code that VS Code's own MCP client reaches the server and its tools.
- **Requirements:** R28; KTD12.
- **Dependencies:** U2, U4.
- **Files:** `src/e2e/runTest.ts`, `src/e2e/suite/mcp.test.ts`.
- **Approach:**
  1. First confirm the two VS Code details: how `workbench.mcp.startServer` takes its server argument, and how MCP tools are named in `vscode.lm.tools`.
  2. Write `http.noProxy` and tool auto-approval into the throwaway profile's `settings.json` before launch.
  3. Start the server through VS Code, wait for the check tool in `vscode.lm.tools`, invoke it, expect the not-configured hint.
  4. Remove the entry through the configuration API and expect the tool to disappear.
- **Execution note:** if step 1 shows that MCP tools are not exposed to extensions, reduce the test to activation and lifecycle and record that limit in the Verification Contract; do not fake coverage.
- **Test scenarios:**
  - VS Code lists the check tool after the server starts.
  - Invoking it returns the setup hint naming the missing Jira configuration.
  - After removing the entry, the tool is gone from `vscode.lm.tools`.
- **Verification:** `xvfb-run -a npm run test:e2e` passes locally and in the CI `e2e` job.

### PR2 (into the feature branch): Read tools and `/ts-jira-brief`

Waits on: PR1, merge order only.

### U7. View ticket and branch key

- **Goal:** the whole-ticket view, with the key taken from the branch when none is given.
- **Requirements:** R9, R16, R20, R29; KTD4, KTD7.
- **Dependencies:** U4.
- **Files:** `src/mcp/branchTicket.ts`, `src/mcp/jiraTools/viewTicket.ts`, `src/test/mcpTools.test.ts`, `src/test/mcpBranchTicket.test.ts`.
- **Approach:** fields through `TicketService.getTicket` with the display settings as `jira_getTicket` does; comments read in full (`getAllComments`), sorted newest first as the requirements source does, cut to 100, with a note saying how many older ones were left out (the paged reader returns oldest first and cannot be used); attachments with name, size and type; branch key per KTD7 with the source named in the result. Introduce the shared Jira-failure wrapper of KTD14 here (R29), used by every later tool, and move check connection onto it.
- **Test scenarios:**
  - View returns description, all fixture comments newest first and the attachment list.
  - With 150 comments, view shows the newest 100 and says 50 older ones were left out.
  - Without a key, the result names the folder and branch the key came from.
  - Covers AE2. Without a key on `feature/PROJ-123-login`, view returns PROJ-123 and names the branch.
  - Covers AE2. On `main`, view says the branch holds no key.
  - Not configured gives the setup hint.
  - A Jira 502 whose body is an HTML proxy page answers the agent with "HTTP 502" and a short reason, without the page; the full text is in the Output channel.
  - A Jira call that does not answer within the timeout ends the tool call with a timeout answer.
- **Verification:** tests pass.

### U8. Find tickets and list filters

- **Goal:** one search tool and the filter list.
- **Requirements:** R10, R11, R20.
- **Dependencies:** U4.
- **Files:** `src/mcp/jiraTools/findTickets.ts`, `src/test/mcpTools.test.ts`.
- **Approach:** JQL goes through `searchTicketsRaw`; a filter name or id goes through the filter path `jira_searchByFilter` uses today, including narrowing and `myTeamJql`; exactly one of JQL and filter is required; columns from `searchFields`.
- **Test scenarios:**
  - JQL returns the fixture tickets in the configured columns.
  - A filter name resolves to its JQL and applies narrowing by sprint.
  - Giving both JQL and a filter is refused with a clear message.
  - List my filters returns favourites and owned filters, deduplicated.
- **Verification:** tests pass.

### U9. Load ticket

- **Goal:** one load tool with optional extra attachments, on a vscode-free core.
- **Requirements:** R12, R16; KTD6.
- **Dependencies:** U7.
- **Files:** `src/participant/jira/loadCore.ts` (new, vscode-free: the core behind a writer and an optional `onDiag` logger), `src/participant/jira/loadHandler.ts` (keeps only the `@jira load` chat flow and calls the core), `src/mcp/jiraTools/loadTicket.ts`, `src/test/mcpTools.test.ts`, `src/test/loadTicketCore.test.ts`.
- **Approach:** the core writes `ticket.md`, `comments.md` and eligible attachments and returns written and skipped files; an optional list adds named attachments without the type filter, respecting `ATTACHMENT_SIZE_LIMIT`; an attachment whose Jira filename fails `isSafeFilename`, or whose resolved path is not inside `.jira-context/<KEY>/attachments/`, is skipped with the reason "unsafe filename"; written files are reported as absolute paths; `@jira load` keeps its behavior on the same core.
- **Execution note:** first confirm `loadTicketCore.test.ts` passes as it is, then move the core and switch the test's checks from the mocked `vscode.workspace.fs` to an in-memory writer, keeping the same scenarios and expected results.
- **Test scenarios:**
  - Covers AE3. Without a list, the text attachment is written and the binary one is listed as skipped with size and reason.
  - Covers AE3. With `["heap-dump.bin"]`, both are written along with the ticket files.
  - A named attachment that does not exist is reported, and the rest of the load still happens.
  - An attachment over the size limit is reported and not written.
  - Attachments named `../../evil.txt` and `..\..\evil.txt` are skipped as unsafe filenames, nothing is written outside the attachments folder, and the other attachments are still written.
  - Without a key, load uses the branch ticket.
  - The load result names no tool outside the catalog (it points skipped attachments at load ticket, not at a removed download tool).
- **Verification:** tests pass; `@jira load` behaves as before.

### U10. Workflow and list templates

- **Goal:** the two remaining read tools.
- **Requirements:** R14, R17.
- **Dependencies:** U4.
- **Files:** `src/mcp/jiraTools/workflow.ts`, `src/mcp/jiraTools/templates.ts`, `src/test/mcpTools.test.ts`.
- **Approach:** workflow wraps `discoverAndCacheWorkflow` (refresh on request) and lists reachable statuses from the cache for a ticket; list templates wraps `TemplateService` as `jira_listTemplates` does and shows each template's default fields (R7).
- **Test scenarios:**
  - Workflow lists the statuses reachable from the fixture ticket's status.
  - Refresh rediscovers and rewrites the cache.
  - List templates returns the workspace templates with their default fields; a missing file gives the existing "no templates" answer.
- **Verification:** tests pass.

### U11. Retire the moved read tools; docs

- **Goal:** the moved read tools exist only on MCP; the manual says so.
- **Requirements:** R1, R2, R25, R27.
- **Dependencies:** U7, U8, U9, U10.
- **Files:** `src/tools/jiraTools.ts`, `package.json`, `src/test/jiraTools.test.ts`, `src/test/userDocsSync.test.ts`, `docs/manual/agent-mode-tools.md`, `docs/manual/copilot-tools.md`, `README.md`, `docs/onboarding.md`.
- **Approach:**
  1. Remove `jira_getTicket`, `jira_getComments`, `jira_searchTickets`, `jira_searchByFilter`, `jira_listMyFilters`, `jira_loadTicket`, `jira_downloadAttachment`, `jira_discoverWorkflow`, `jira_listTemplates` from `package.json` and their registrations and tests.
  2. Switch the docs-sync check to the MCP catalog for Jira tools; Bitbucket stays on `languageModelTools`.
  3. Add the MCP tools page with the `http.noProxy` requirement, the manual checklist and a troubleshooting note: if the Jira tools stop answering after changing `http.noProxy` or reloading the window, start a new chat; if that does not help, run **Copy MCP diagnostics** and send the report.
- **Test scenarios:**
  - Docs-sync fails when a catalog tool is missing from the manual.
  - Bundle smoke registers exactly the remaining declared Agent Mode tools.
- **Verification:** `npm test` passes; no removed tool name remains in `package.json`.

### U12. `/ts-jira-brief` skill and skill guard

- **Goal:** the developer brief and the guard keeping skills honest.
- **Requirements:** R21, R22, R27.
- **Dependencies:** U7, U9.
- **Files:** `skills/ts-jira-brief/SKILL.md`, `package.json` (`contributes.chatSkills`, `.vscodeignore` keeps `skills/`), `src/test/mcpSkillsGuard.test.ts`.
- **Approach:** the skill tells the agent to call view, call load without extra names (unless the user named some), read the relevant downloaded attachments from `.jira-context/`, show the numbered list of skipped ones and load only those the user picks (R31), and write the eight sections of R22 with citations; the guard parses every contributed skill and fails on unknown `jira_` tool names, on a `name` that differs from the folder, and on `disable-model-invocation`.
- **Test scenarios:**
  - The guard passes for the shipped skill.
  - A skill naming a non-existent tool fails the guard.
  - Covers AE7. The skill text names all eight sections in order and the "not stated in the ticket" rule.
- **Verification:** tests pass; the packaged `.vsix` contains `skills/ts-jira-brief/SKILL.md`.

### PR3 (into the feature branch): Write tools, `/ts-jira-create` and skipped attachments

Waits on: PR2, merge order only. After PR3, the feature branch merges into `main` once the manual checklist passes (Verification Contract).

### U13. Markdown conversion for text inputs

- **Goal:** one place that turns agent Markdown into Jira wiki markup for tool inputs.
- **Requirements:** R19; KTD9.
- **Dependencies:** U4.
- **Files:** `src/mcp/jiraTools/text.ts`, `src/test/mcpTools.test.ts`.
- **Approach:** a helper applying `markdownToJiraWiki()` to comment text, the create description and update-field text values; summary stays single-line.
- **Test scenarios:**
  - Covers AE5. A heading, a list and a table convert to `h2.`, `*` items and a `||` table.
  - Plain text passes through unchanged.
- **Verification:** tests pass.

### U14. Write tools

- **Goal:** move, create, comment, update field and upload on MCP with today's safeguards.
- **Requirements:** R7, R13, R17, R18, R19, R20; KTD4, KTD8.
- **Dependencies:** U10, U13.
- **Files:** `src/mcp/jiraTools/moveTicket.ts`, `createTicket.ts`, `addComment.ts`, `updateField.ts`, `uploadAttachment.ts`, `src/test/mcpTools.test.ts`.
- **Approach:**
  1. Each handler re-validates its inputs and reuses the logic of its `jira_*` counterpart: `resolveAndApplyTransition`, template field resolution with never-guess issue type, `RecentCallGuard` and the size check. Upload uses its own workspace-folder rule (R18) instead of `isAllowedUploadPath`.
  2. Move discovers the workflow when none is cached or the cached one has no path to the target; a `partialFailure` is reported with the landed status and never retried.
  3. Create, update field and move report what changed in their result (previous value, previous status, template fields applied), using the facts today's confirmation builders look up (R7).
  4. All five carry `destructiveHint: true`.
  5. The MCP server is built per request (U1), so state that must outlive a request, such as the `RecentCallGuard` of add comment, lives in the long-lived handler dependencies created once in `register.ts`, not in the per-request server.
- **Test scenarios:**
  - Covers AE4. Move to a status two steps away without a cache discovers, moves twice and names both steps.
  - A cached workflow with no path to the target triggers one discovery; a move that stops partway is reported with its landed status and not retried.
  - Create without a template and an ambiguous issue type returns the available types and creates nothing.
  - Create with a template applies its fields, converts the description and lists the template fields it set.
  - An identical comment sent in a second, separate MCP request within a minute is skipped.
  - Update field refuses an unsupported field name, and a successful update reports the previous value.
  - Upload accepts a file inside a workspace folder that lies outside the home folder, and refuses a home-folder file outside the workspace, a path under a dotfolder, a symlink pointing out of the workspace and a file over 25 MB.
  - Each write tool's definition carries `destructiveHint: true`, and no write tool carries `readOnlyHint` (VS Code's default approval then always applies).
- **Verification:** tests pass.

### U15. Retire the remaining Jira tools; docs

- **Goal:** no Jira Agent Mode tool remains.
- **Requirements:** R1, R2, R25.
- **Dependencies:** U14.
- **Files:** `src/tools/jiraTools.ts` (removed, or reduced to nothing and deleted), `src/extension.ts`, `package.json`, `src/test/jiraTools.test.ts`, `docs/manual/*`, `README.md`, `CLAUDE.md`, `docs/onboarding.md`.
- **Approach:** remove `jira_transitionTicket`, `jira_createTicket`, `jira_addComment`, `jira_updateField`, `jira_uploadAttachment`; delete `registerJiraTools`; move any still-shared helpers to `src/mcp/jiraTools/`; update the index lines in `CLAUDE.md`.
- **Test scenarios:**
  - `package.json` declares no `languageModelTools` entry starting with `jira_`.
  - Bundle smoke and e2e registration checks pass with the Bitbucket tools only.
- **Verification:** `npm test` and `npm run compile` pass.

### U16. `/ts-jira-create` skill and command coverage

- **Goal:** the guided create flow and the coverage guard for former commands.
- **Requirements:** R21, R23, R24, R27.
- **Dependencies:** U14, U12.
- **Files:** `skills/ts-jira-create/SKILL.md`, `package.json`, `src/test/mcpSkillsGuard.test.ts`.
- **Approach:** the skill covers template choice, asking only for missing fields, showing the draft, then create; the guard maps `view`, `load`, `search`, `comment`, `field`, `move`, `create`, `check` to catalog tools or skills and fails on a gap.
- **Test scenarios:**
  - The guard passes for both shipped skills.
  - Removing the create tool from the catalog makes the coverage guard fail for `create`.
- **Verification:** tests pass; the packaged `.vsix` contains the skills.

### U17. Numbered list of skipped attachments

- **Goal:** the user picks the skipped attachments to fetch from a numbered list the agent shows after a load.
- **Requirements:** R30, R31; KTD15.
- **Dependencies:** U9.
- **Files:** `src/mcp/jiraTools/loadTicket.ts`, `src/test/mcpTools.test.ts`, `docs/manual/copilot-tools.md`.
- **Approach:**
  1. Replace load ticket's re-fetch hint with the numbered list, the separate "Not downloadable" list and the closing instruction (KTD15). A name skipped twice is numbered once.
  2. Leave the rest of the answer, and the load itself, as they are.
- **Test scenarios:**
  - Covers AE8. The four attachments give two numbered lines, two plain lines with their reasons, and the closing instruction naming load ticket and the ticket key.
  - Without a list, a ticket with one binary attachment numbers it and asks the agent to let the user pick.
  - Only unsafe names and too-large files skipped: nothing is numbered and the answer carries no instruction to ask.
  - The answer names no tool outside the catalog.
- **Verification:** tests pass; in a Copilot-harness chat, loading a ticket with a binary attachment shows the numbered list, and answering `all` writes the files.


### U18. `/ts-jira` command router

- **Goal:** a user can run any Jira tool by typing a command, without the agent choosing between tools and skills.
- **Requirements:** R21, R35.
- **Dependencies:** U14, U16.
- **Files:** `skills/ts-jira/SKILL.md`, `package.json`, `src/test/mcpSkillsGuard.test.ts`, `docs/manual/copilot-tools.md`, `README.md`, `CLAUDE.md`.
- **Approach:** a short skill with `disable-model-invocation: true`, an `argument-hint` listing the commands, the user's input through `$ARGUMENTS`, five ordered cases (nothing typed, `help`, unknown command, missing argument, run) and one table row per command. It names no skill, since a weak model ran `/ts-jira-brief` when the table pointed at it; create stays with `/ts-jira-create`, which drafts the ticket with the user first. The skill guard requires model invocation off for `ts-` skills and on for every other skill.
- **Test scenarios:**
  - Every catalog tool except create ticket has a row, and every row names a tool that exists; the skill names no other skill.
  - The cases come in order before the table, and the help text lists every command of the table.
  - The argument hint lists the table's commands, in the same order.
  - A `ts-` skill that leaves model invocation on fails the guard; one that turns it off passes.
- **Verification:** tests pass; in a Copilot-harness chat, `/ts-jira load PROJ-123` calls load ticket directly.

---

## Verification Contract

| Check | Command or step | Proves |
| --- | --- | --- |
| Types | `npm run compile` | Glue and local MCP types compile against `@types/vscode` 1.95 |
| Unit and integration | `npm test` | U1–U18 scenarios, guards, docs sync, bundle smoke |
| E2E | `xvfb-run -a npm run test:e2e` (CI `e2e` job) | U6 through VS Code's MCP client, or the recorded reduced form |
| Package | `npm run package` | `.vsix` contains `out/extension.js` and all three skills |
| Manual | The checklist in `docs/manual/copilot-tools.md` in a Copilot-harness chat, with a `.vsix` from the feature branch, on a managed Mac and a managed Windows machine | R8 tools answer, all three skills run, no duplicate tools, a load with a binary attachment shows the numbered list and `all` fetches it; gates the merge into `main` |

---

## Definition of Done

- All three PRs are merged into the feature branch in order, each leaving it with no capability offered twice, and the feature branch is merged into `main` after the manual checklist passed on a managed Mac and a managed Windows machine.
- `npm run compile`, `npm test` and the CI `e2e` job pass on `main`.
- No `jira_` entry remains in `contributes.languageModelTools`.
- The manual documents the MCP tools, all three skills, the `http.noProxy` requirement and the checklist.
- No log line, report or test output contains a key or token.
- Code from abandoned approaches is removed from the diff.
