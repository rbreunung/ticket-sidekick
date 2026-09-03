---
title: Load Ticket Entry-Point Parity - Plan
type: feat
date: 2026-09-02
topic: load-ticket-parity
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Load Ticket Entry-Point Parity - Plan

## Goal Capsule

- **Objective:** A user — whether typing to `@jira` chat or working through Copilot Agent Mode — can load a ticket's full context (description, comments, attachments) into the local workspace, and gets an accurate result either way, never a false success claim when nothing was actually written. Retrieving one specific attachment the default load skipped is possible without re-running the whole load.
- **Means:** Add a `/load` slash command to `@jira` chat and a `jira_loadTicket` language-model tool for Agent Mode, both wired to the load-into-folder capability that already exists and works today via loose natural-language phrasing to `@jira`; add a companion `jira_downloadAttachment` tool for fetching one named attachment on demand (KTD5).
- **Product authority:** User-directed (this conversation).
- **Open blockers:** None.
- **Execution profile:** `code`, Standard depth. Low risk: additive tools/command over an existing, unchanged capability.
- **Tail ownership:** U2's extracted load core gets real automated coverage via a new, narrowly-scoped `vscode` module mock (KTD8); the implementer still verifies confirmation dialogs, tool registration/wiring, and R8's ask-before-analyzing behavior manually in the Extension Development Host, since those depend on live VS Code UI and a live calling model that the mock does not simulate (see Verification Contract).

---

## Product Contract

**Product Contract preservation:** changed — R7 broadened to cover the two new tools and the `/load` slash-command doc row (same intent, wider surface); R8-R11 added (session-confirmed scope addition: a user-controlled analysis nudge on `jira_loadTicket`, a new `jira_downloadAttachment` tool, and a `jira_getTicket` description fix so attachment filenames are discoverable without a load) — see Key Decisions for rationale.

### Summary

Add two new entry points to the existing "load a ticket's context into `.jira-context/<KEY>/`" capability — a `/load` slash command on `@jira` chat, and a `jira_loadTicket` Agent Mode tool — so the capability is reachable the same way every other core Jira operation already is, instead of only through natural-language phrasing that Agent Mode never sees at all. A companion `jira_downloadAttachment` tool lets Agent Mode fetch one named attachment on a known ticket without re-running the full load or waiting on the chat-only "reply with a number" resume flow, which has no Agent Mode equivalent.

### Problem Frame

`@jira` can already load a ticket's description, comments, and attachments into the workspace, but only via natural-language phrasing typed directly to `@jira` chat — it has no `/load` slash command, unlike `view`, `comment`, `field`, `move`, `search`, and `create`. Copilot Agent Mode does not go through `@jira` chat routing at all; it only sees the fixed set of registered `jira_*` language-model tools, and no tool for this capability exists.

The practical consequence: a user working in Agent Mode says "load it," the model has no tool that can write anything, and it responds with a plain-language claim ("Loaded VSJI-38 from Jira") that sounds like success but performed no write — no folder, no files. The user has no way to tell, from the response alone, that the load never happened.

A second, smaller gap: today's load always applies the same eligibility filter (text/image MIME types plus a fixed extension allowlist, under a 100 MB cap) and lists what it skipped. In chat, a user can reply with a number to fetch a skipped file anyway — but that resume flow is session-based and has no Agent Mode counterpart, so a skipped attachment is simply unreachable from Agent Mode today.

### Requirements

**Chat command**

- R1. `@jira` gains a `/load` slash command, taking a ticket key the same way `/view` does, that performs the same load-into-folder behavior available today via natural-language phrasing.
- R2. Existing natural-language "load" phrasing to `@jira` chat continues to work unchanged.

**Agent Mode tool — load**

- R3. A `jira_loadTicket` language-model tool is added, taking `ticketKey` as required input, producing the same ticket/comments/attachments folder output that `@jira load` produces today.
- R4. Before running, the tool declares an explicit confirmation naming the ticket key and the target folder, so a load is never silent.
- R5. The tool validates its inputs independently inside its `invoke()` step rather than relying on the confirmation dialog having been seen (a user's auto-approve setting can skip it).
- R6. When no workspace folder is open, the tool reports that a folder must be open and writes nothing, rather than erroring unrecognizably or claiming success.
- R8. The tool's result text names the files it wrote (`ticket.md`, `comments.md`, `attachments/` when populated) as available for follow-up reading, and explicitly asks the user before reading them to analyze the ticket, in the same "ask the user, make no assumption" register this codebase already uses for other user-facing decisions (KTD4) — continuing into analysis is the user's decision, never one the model makes on its own from the load result alone.

**Agent Mode tool — single attachment**

- R9. A `jira_downloadAttachment` language-model tool is added, taking `ticketKey` and `filename` as required input, that downloads exactly that attachment from the named ticket into `.jira-context/<ticketKey>/attachments/`, bypassing the load command's type/extension eligibility filter (KTD5) — the filter exists to keep an unattended load from dumping arbitrary binaries into the workspace; naming a file explicitly is the user opting into it. When more than one attachment on the ticket shares that exact filename, the most recently uploaded one is downloaded — matching how the Jira web UI itself resolves same-named attachments — and the result text says so.
- R10. `jira_downloadAttachment` carries the same safeguards as `jira_loadTicket` — an explicit confirmation naming the ticket, filename, and target path; `invoke()`-level input validation; graceful no-workspace-folder failure — and reports a clear, not-found message listing the ticket's actual attachment filenames when the named one doesn't match, rather than a raw error. The 100 MB size cap still applies even though the type/extension filter does not.
- R11. `jira_getTicket`'s `modelDescription` names attachments among what it returns, so a model has a documented way to discover a ticket's attachment filenames — for `jira_downloadAttachment`'s `filename` input — without first calling `jira_loadTicket`. `jira_getTicket`'s existing `## Attachments` output (filename, size, MIME type) already covers this; only the tool's own advertised description is missing the pointer.

**Documentation**

- R7. `docs/onboarding.md`'s Jira tool table lists `jira_loadTicket` and `jira_downloadAttachment`, its "every core Jira read/write operation is also exposed as a tool" claim is accurate again, and the Slash commands table gains a `/load` row alongside the existing commands.

### Key Decisions

- **Cover both the chat and Agent Mode surfaces, not just one.** Governs R1, R3. (session-settled: user-directed — chosen over shipping the tool alone or the slash command alone: full entry-point parity was preferred, matching how every other core operation already works both ways.)
- **Treat both new tools as write tools requiring explicit confirmation.** Governs R4, R5, R10. (session-settled: user-directed — chosen over running them unconfirmed like a read tool: they write files to the user's workspace disk even though neither touches Jira, which was judged to deserve the same visibility every other write tool gets.)
- **Reuse the existing load behavior unchanged on both new entry points.** Governs R1, R3. This closes an access gap, not a behavior change — what gets downloaded, filtered, or written to `.jira-context/` by the default load path is untouched.
- **No-workspace-folder case fails gracefully, mirroring the existing chat message, rather than a raw error or a silent no-op.** Governs R6, R10.
- **`jira_loadTicket`'s result text informs, it does not instruct.** Governs R8. (session-settled: user-directed — chosen over phrasing that tells the calling model to read the files immediately: an instructive nudge would make Agent Mode auto-continue into a token-heavy analysis pass on every load, even when the user only wanted the files staged for later. The tool states where the files are and asks the user before reading them, keeping that decision with the user.)
- **Add a per-attachment fetch tool now, while this area is already open, rather than deferring it.** Governs R9, R10. (session-settled: user-directed — chosen over deferring to a follow-up plan: the gap it closes — a skipped attachment being unreachable from Agent Mode — was raised while scoping this same plan, and the tool follows the exact thin-glue pattern every other tool in this file already uses.)

### Acceptance Examples

- AE1. **Covers R1.** Given the user types `/load VSJI-38` in `@jira` chat, when the command runs, then the ticket, its comments, and its attachments land in `.jira-context/VSJI-38/`, identical to today's natural-language "load VSJI-38" result.
- AE2. **Covers R4.** Given `jira_loadTicket` is invoked with `ticketKey: "VSJI-38"`, when the tool is about to run, then the confirmation names `VSJI-38` and the target folder before anything is written.
- AE3. **Covers R6.** Given no folder is open in the workspace, when `jira_loadTicket` is invoked, then the response states that a folder must be open, and no files are written.
- AE4. **Covers R8.** Given `jira_loadTicket` completes a load, when the result text is read by the calling model, then it names the written files and asks the user before reading them further — it does not claim or imply that analysis will happen automatically.
- AE5. **Covers R9, R10.** Given `jira_downloadAttachment` is invoked with a ticket key and a filename that was skipped by an earlier `/load` (e.g., an oversized log), when the tool runs, then that exact file lands in `.jira-context/<key>/attachments/`, even though a full `/load` of the same ticket would have skipped it.
- AE6. **Covers R10.** Given `jira_downloadAttachment` is invoked with a filename that does not exist on the ticket, when the tool runs, then the response lists the ticket's real attachment filenames instead of a raw not-found error.
- AE7. **Covers R11.** Given a model wants to fetch a ticket's attachments without loading the whole ticket into the workspace, when it reads `jira_getTicket`'s `modelDescription`, then that description tells it the tool's output includes attachment filenames — so it can call `jira_getTicket` first, then `jira_downloadAttachment` with a real filename, without ever calling `jira_loadTicket`.

### Scope Boundaries

- Deferred: changing what gets downloaded or how the default `/load` / `jira_loadTicket` path filters attachments (eligibility, size limits, `.jira-context/` layout) — untouched by this work. `jira_downloadAttachment` (R9, R10) is an explicit, per-file escape hatch that bypasses the type/extension filter by design; it does not change the default filter itself.
- Deferred: loading multiple tickets in a single call.
- Outside this work's identity: fixing Agent Mode's general tendency to narrate an action as done when no tool exists for it — that is model/host behavior, not something this extension controls. This plan closes the specific gap that caused it here.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Extract a pure, `vscode`-free attachment-eligibility module** (`DOWNLOADABLE_EXTENSIONS`, `ATTACHMENT_SIZE_LIMIT`, and a `classifyAttachmentEligibility(attachments)` function returning `{ toDownload, toSkip }`) out of `loadHandler.ts` into a new `src/utils/attachmentEligibility.ts`, mirroring the existing `reportImport.ts` pattern of vscode-free shared primitives — `loadHandler.ts` currently defines and uses these inline with no dedicated unit coverage. Both the default load path and `jira_downloadAttachment`'s size-cap check import from this module. This stays worthwhile even once KTD8 makes `loadHandler.ts` itself Vitest-loadable: the classification rule gets focused, mock-free unit tests here, separate from KTD8's fuller (and heavier) integration test. Governs U2.
- KTD2. **Extract `handleLoadTicket`'s non-streaming core into a reusable function** (fetch issue/comments/attachments, classify, download eligible attachments, write `ticket.md`/`comments.md`, call the shared `ensureJiraContextGitignored` helper (KTD1-adjacent, see U2), build the skipped list) that returns a structured result instead of writing to a `ChatResponseStream`. `handleLoadTicket` (chat) calls it and keeps its existing streaming/session behavior (ticket preview, the skipped-attachments resume-by-number session) unchanged; `jira_loadTicket` (tool) calls the same function and renders its own single-string result — one implementation, per the Reuse Key Decision. Governs R1, R3, U2, U3.
- KTD3. **Neither new tool uses `RecentCallGuard`.** The guard exists to de-duplicate calls that create a new artifact per invocation (a comment, a ticket); both `jira_loadTicket` and `jira_downloadAttachment` overwrite the same target file(s) on a retry, so a repeat call is idempotent and has nothing to de-duplicate. (session-settled: user-approved — proposed with the tradeoff surfaced, confirmed over adding the guard for consistency with other write tools.) Governs U3, U4.
- KTD4. **`jira_loadTicket`'s result-text wording is an explicit ask, not a statement of availability.** E.g. `Loaded VSJI-38 into .jira-context/VSJI-38/ (ticket.md, comments.md, attachments/) — ask the user before reading these to analyze the ticket. Make no assumption.` This is the mechanism for R8/KTD-governed Key Decision above: Agent Mode chips don't exist for tool calls, so the tool's own returned text is the only channel available to steer the calling model toward checking with the user first. Because no code path can enforce that the calling model actually honors this ask, the Verification Contract's manual Extension Development Host check includes observing that `jira_loadTicket`'s result is not followed by unprompted file reading. Governs R8, U3.
- KTD5. **`jira_downloadAttachment` looks the attachment up by exact filename against a fresh `ticketService.getIssue(ticketKey)` + `getAttachments(issue)` call** (no session/cache of a prior load's skip list — KTD6-style: tools carry no session memory), matches on `att.filename`, enforces only the 100 MB size cap from KTD1's module (not the MIME/extension eligibility check), and on no match returns the ticket's actual attachment filenames so the calling model can retry with a correct one. When more than one attachment matches the filename, the one with the latest `created` timestamp wins (mirroring the Jira web UI's own same-name resolution), and the result text names that it picked the most recent of N matches. Governs R9, R10, U4.
- KTD7. **`JiraAttachment` (`src/jira/IJiraClient.ts`) gains a `created: string` field.** Jira's real `GET /issue/{key}` response already includes each attachment's `created` timestamp; `getIssue()` (`src/jira/JiraApiClient.ts`) returns the raw response cast directly to `JiraIssue`/`JiraAttachment` with no field-by-field mapping, so this is a type-only addition — no client-code change. KTD5's latest-wins tie-break needs it. Fixtures (`src/test/fixtures/ticket-PROJ-123.json` and any new same-filename fixture U4 adds) gain `created` values for their attachment entries so the tie-break is exercisable in tests. Governs U4.
- KTD8. **Introduce a minimal, hand-rolled `vscode` module mock** (`src/test/mocks/vscode.ts`), aliased for `vscode` in `vitest.config.ts` (`resolve.alias`), so Vitest can load U2's extracted load core and give it one real integration test. (session-settled: user-directed — chosen over leaving the shared core's fetch/classify/download/write correctness manually-verified only: consolidating three entry points onto one core (KTD2) raises the cost of a missed manual check, and this closes that gap with automated coverage instead.) Scoped strictly to what the load core touches — `Uri.joinPath`/`Uri.file`, an in-memory `workspace.fs` (`createDirectory`/`writeFile`/`readFile` backed by a `Map`), and `workspace.getConfiguration('ticketSidekick').get('jira.baseUrl')` — not a general-purpose vscode API shim, so it can't invite broader mocking creep. This is the first `vscode` mock in this repo's Vitest setup, following the same shape `MockJiraClient`/`MockBitbucketClient` already use for their own interfaces; the alias applies only under `npm test` and never touches the compiled extension (`tsc`/`vsce package`). Deliberately scoped to U2's core only — `jiraTools.ts`'s tool classes (confirmation dialogs, `workspace.workspaceFolders` no-folder check, tool registration) stay manually verified in the Extension Development Host, since that surface is UI- and live-model-dependent in ways the mock does not attempt to simulate. Governs U2.

### Sources / Research

- `src/participant/JiraParticipant.ts:1297-1306` — the existing `loadTicket` operation case, dispatched via `parseIntent`'s LLM classification today; `mapCommandToOperation`/`COMMAND_OPERATIONS` (`src/participant/jira/llmHelpers.ts:101-114`) is the map U1 adds `load` to, the same map `view`/`comment`/`field`/`move`/`search` already use.
- `src/participant/jira/loadHandler.ts` (full file) — `handleLoadTicket`'s current shape: streams a ticket preview, classifies attachments (lines 71-79), downloads up to 3 concurrently, writes `ticket.md`/`comments.md`, updates `.gitignore`, and (lines 194-204) offers the number-based resume for skipped attachments via a `LoadSkippedSession` written to `ws` (`vscode.Memento`) — this session mechanism has no Agent Mode analogue (KTD5's rationale for `jira_downloadAttachment`).
- `src/tools/jiraTools.ts` (full file) — the tool-registration pattern every unit here follows: `ConfiguredContext`/`tryGetConfiguredContext` for live config+client+service, `textResult()` wrapping, `isSafePathSegment()` on every LLM-supplied key/filename before it reaches a path or URL, `prepareInvocation()` building a best-effort confirmation that never throws, `invoke()` re-validating independently (KTD1 in that file's own header comment), and `registerJiraTools()` as the single registration point.
- `src/participant/sessionState.ts:1040-1133` — the existing `build*Confirmation()` builders (`buildUpdateFieldConfirmation`, `buildAddCommentConfirmation`, etc.) that back every write tool's `prepareInvocation()`; `buildLoadTicketConfirmation`/`buildDownloadAttachmentConfirmation` join this set, tested the same way in `src/test/jiraTools.test.ts`.
- `package.json` — `contributes.chatParticipants[0].commands` (the `/view`, `/comment`, … array U1 extends) and `contributes.languageModelTools` (the array U3/U4 extend), including each entry's `when: "ticketSidekick.jiraCredentialsSet"` gate.
- `docs/onboarding.md:29-72` (tool tables) and `:258-266` (`@jira` slash-command table) — the two tables R7/U5 update; `docs/onboarding.md:84-91` documents `RecentCallGuard`'s existing scope, which KTD3 explains neither new tool needs.
- No `src/test/loadHandler.test.ts` exists today, and `vitest.config.ts` has no `vscode` alias/mock as of this plan's start — confirmed `loadHandler.ts` and `jiraTools.ts` cannot currently be loaded by Vitest. KTD8 changes this for `loadHandler.ts`'s extracted core specifically, via a new alias; `jiraTools.ts` stays out of Vitest's reach this round (KTD8's scope note).
- `src/jira/IJiraClient.ts:32-38` (`JiraAttachment`) and `src/jira/JiraApiClient.ts:185-187` (`getIssue()`) — confirmed `getIssue()` returns the raw API response cast directly to `JiraIssue`, with no per-field mapping, so KTD7's `created` field addition needs no client-code change, only the type and fixture updates it names. Every existing attachment fixture (`src/test/fixtures/ticket-PROJ-123.json:34-55`) currently omits `created`.
- Every existing `invoke()` in `src/tools/jiraTools.ts` (`GetTicketTool`, `AddCommentTool`, `UpdateFieldTool`, `TransitionTicketTool`, …) wraps its main service call in `try`/`catch`, logs via `logDiag('jira.tools', 'error', …)`, and returns a `Could not <verb> <ticket>: <message>` `textResult` on failure — the pattern U3/U4's error handling below follows.
- `src/test/mocks/MockJiraClient.ts` and `MockBitbucketClient.ts` — this repo's existing precedent for a hand-rolled, interface-scoped mock backed by fixtures under `src/test/fixtures/`; KTD8's `vscode` mock follows the same shape (a minimal fake behind an interface) for the one external API surface this codebase has never mocked before.
- `vitest.config.ts` (current content: `{ test: { environment: 'node', include: ['src/test/**/*.test.ts'], pool: 'forks' } }`, no `resolve.alias`) — confirmed there is no existing alias mechanism to build on or conflict with; KTD8's alias is a net-new top-level `resolve` key.

---

## Implementation Units

### U1. Add `/load` slash command to `@jira` chat

- **Goal:** `/load` becomes a recognized `@jira` slash command that routes to the existing `loadTicket` operation, the same way `/view` routes to `getTicket`.
- **Requirements:** R1, R2
- **Dependencies:** None
- **Files:**
  - `package.json` (`contributes.chatParticipants[0].commands`)
  - `src/participant/jira/llmHelpers.ts` (`COMMAND_OPERATIONS`)
  - `src/test/llmHelpers.test.ts`
- **Approach:**
  1. Add a `load` entry to `COMMAND_OPERATIONS` mapping to `'loadTicket'`.
  2. Add a `{ name: "load", description: …, sampleRequest: "load PROJ-123" }` entry to `package.json`'s `@jira` `commands` array, matching the shape of the existing `view` entry.
- **Patterns to follow:** The existing `COMMAND_OPERATIONS` map and `package.json` `commands` array entries for `view`/`comment`/`field`/`move`/`search`.
- **Test scenarios:**
  - Happy path: `mapCommandToOperation('load')` returns `'loadTicket'`.
  - Covers AE1. Integration: existing `loadTicket`-operation tests (intent parsing, `JiraParticipant.ts` dispatch) are unaffected — `/load` pre-decides the operation the same way other commands do, without changing `handleLoadTicket`.
- **Verification:** `mapCommandToOperation('load') === 'loadTicket'`; `/load PROJ-123` in the Extension Development Host produces the same result as today's natural-language `load PROJ-123`.

### U2. Extract shared load and attachment-eligibility logic

- **Goal:** Give both new Agent Mode tools (U3, U4) one implementation to call instead of duplicating `loadHandler.ts`'s logic, make the attachment eligibility rule unit-testable, and give the shared load core itself a real integration test (KTD8) instead of manual-only verification.
- **Requirements:** (supports R3, R9 — no requirement of its own; internal refactor)
- **Dependencies:** None
- **Files:**
  - `src/utils/attachmentEligibility.ts` (new)
  - `src/participant/jira/loadHandler.ts` (refactor)
  - `src/test/attachmentEligibility.test.ts` (new)
  - `src/test/mocks/vscode.ts` (new — KTD8)
  - `vitest.config.ts` (add `resolve.alias` for `vscode` — KTD8)
  - `src/test/loadTicketCore.test.ts` (new — KTD8)
- **Approach:**
  1. Create `src/utils/attachmentEligibility.ts` (no `vscode` import): move `DOWNLOADABLE_EXTENSIONS`, `ATTACHMENT_SIZE_LIMIT`, and a new `classifyAttachmentEligibility(attachments: JiraAttachment[]): { toDownload: JiraAttachment[]; toSkip: JiraAttachment[] }` extracted from `handleLoadTicket`'s existing classification loop (KTD1).
  2. Update `loadHandler.ts` to import from the new module instead of defining these locally; behavior is unchanged.
  3. Extract a small `ensureJiraContextGitignored(wsRoot)` helper from `handleLoadTicket`'s existing `.gitignore`-update block, callable on its own (not only bundled inside the full load core) — U4 needs it standalone, since `jira_downloadAttachment` can run on a ticket that was never loaded.
  4. Extract `handleLoadTicket`'s fetch/classify/download/write-files/skipped-list core into a reusable, still-`vscode`-dependent function returning a structured result (ticket key, summary, comment count, downloaded count, skipped list, write errors) instead of streaming (KTD2), calling `ensureJiraContextGitignored` as one of its steps. `handleLoadTicket` calls the core, then does its existing chat-only work (ticket-preview streaming, the skipped-attachments resume session) unchanged.
  5. Build `src/test/mocks/vscode.ts` (KTD8): `Uri.joinPath`/`Uri.file` as plain path-joining helpers; `workspace.fs.createDirectory`/`writeFile`/`readFile` backed by an in-memory `Map<string, Uint8Array>` keyed by joined path, reset between tests; `workspace.getConfiguration('ticketSidekick').get('jira.baseUrl')` returning a configurable fixed string. Nothing beyond what the extracted core touches.
  6. Add `resolve: { alias: { vscode: '<path to src/test/mocks/vscode.ts>' } }` to `vitest.config.ts`.
  7. Add `src/test/loadTicketCore.test.ts`: construct a `TicketService` from `MockJiraClient` (real fixtures, real eligibility filtering), call the extracted core against the in-memory mock filesystem, and assert on the fake `Map`'s contents plus the returned structured result.
- **Technical design:** Directional shape only — `handleLoadTicket(...)` becomes: stream ticket preview (unchanged) → call the extracted core (which itself calls `ensureJiraContextGitignored`) → stream summary + skipped list + write the resume session (unchanged). The extracted core itself does not stream or touch `ws`.
- **Patterns to follow:** `src/utils/reportImport.ts` — an existing `vscode`-free shared-primitives module used by two call sites (Veracode and Waltz importers), same shape this unit introduces for load/attachment logic. `src/test/mocks/MockJiraClient.ts` — this repo's existing shape for an interface-scoped, fixture-backed mock, which KTD8's `vscode` mock follows for a new interface.
- **Test scenarios:**
  - Happy path: `classifyAttachmentEligibility` sorts a text file, an image, and a known-extension document into `toDownload`.
  - Edge case: a file over `ATTACHMENT_SIZE_LIMIT` lands in `toSkip` regardless of MIME type.
  - Edge case: an unknown binary MIME type with no matching extension lands in `toSkip`.
  - Edge case: empty attachment list returns empty `toDownload`/`toSkip`.
  - Integration (KTD8): the extracted core, run against `MockJiraClient`'s `ticket-PROJ-123` fixture and the in-memory `vscode` mock, writes `ticket.md` and `comments.md` with the expected content, downloads the eligible attachments into the fake `attachments/` path, skips the oversized/unknown-binary ones, calls `ensureJiraContextGitignored`, and returns a structured result matching what was written.
  - Integration (KTD8), error path: `MockJiraClient` configured to throw on `getIssue` — the core's failure propagates as a rejected promise rather than a partial or silently-swallowed write, so U3/U4's own `try`/`catch` (Sources) has something real to catch.
- **Verification:** `attachmentEligibility.test.ts` and `loadTicketCore.test.ts` pass; `@jira load PROJ-123` in the Extension Development Host still produces identical output to before the refactor (manual regression check, now a secondary confirmation rather than the only one).

### U3. Add `jira_loadTicket` Agent Mode tool

- **Goal:** Agent Mode can load a ticket's full context into `.jira-context/<key>/` the same way `@jira load` does, with an explicit confirmation and a user-decides-next-step result message.
- **Requirements:** R3, R4, R5, R6, R8
- **Dependencies:** U2
- **Files:**
  - `src/tools/jiraTools.ts` (`LoadTicketTool` class + registration)
  - `src/participant/sessionState.ts` (`buildLoadTicketConfirmation`, result-text builder)
  - `package.json` (`contributes.languageModelTools` entry)
  - `src/test/jiraTools.test.ts`
- **Approach:**
  1. `buildLoadTicketConfirmation(ticketKey, targetFolder)` in `sessionState.ts` — deterministic from the ticket key alone (`.jira-context/<ticketKey>/`), no network call needed at confirmation time (R4).
  2. `LoadTicketTool.prepareInvocation()` calls the builder directly.
  3. `LoadTicketTool.invoke()`: validate `ticketKey` (non-empty, `isSafePathSegment`) before anything else (R5); check for an open workspace folder and return the graceful no-folder message if none, before any Jira call (R6); resolve config via `tryGetConfiguredContext`; wrap the call to U2's extracted core in `try`/`catch`, logging a failure via `logDiag('jira.tools', 'error', ...)` and returning a `Could not load <ticketKey>: <message>` result on error, matching every existing tool's `invoke()` (Sources); on success, build and return the result text via KTD4's ask-before-analyzing wording (R8).
  4. Register `jira_loadTicket` in `registerJiraTools()` and declare it in `package.json` (`when: "ticketSidekick.jiraCredentialsSet"`, matching every other tool).
- **Patterns to follow:** `ListTemplatesTool`'s no-workspace-folder early return (`src/tools/jiraTools.ts`); `AddCommentTool`/`UpdateFieldTool` for the confirmation + `invoke()`-revalidation + `try`/`catch`/`logDiag` shape (no `RecentCallGuard` per KTD3).
- **Test scenarios:**
  - Happy path: `buildLoadTicketConfirmation('VSJI-38', '.jira-context/VSJI-38/')` names both the ticket and the folder.
  - Covers AE2. Confirmation is built without any live data — no network call required to render it.
  - Covers AE4. The result-text builder's output asks the user before reading the files, and does not phrase reading them as automatic.
  - Edge case: empty/missing `ticketKey` returns the standard "a ticket key is required" message without reaching `tryGetConfiguredContext`.
  - Edge case: a `ticketKey` containing `/`/`\`/`..` is rejected by `isSafePathSegment` before any call.
  - Not configured: `tryGetConfiguredContext` returning the not-configured result short-circuits before any load work.
  - Error path: an upstream failure (unknown ticket key, network error, auth failure) from U2's extracted core returns a `Could not load <ticketKey>: <message>` result rather than throwing.
- **Verification:** `jiraTools.test.ts` confirmation/result-text cases pass; a manual Extension Development Host run of `jira_loadTicket` on a real ticket produces the same `.jira-context/<key>/` contents as `@jira load`, with a confirmation and a result message matching R4/R8, and the model does not read the loaded files unprompted (Verification Contract's manual EDH check — AE3/R6's no-workspace-folder case is included in that same manual pass, since it depends on live `vscode.workspace.workspaceFolders` state Vitest cannot simulate for a `vscode`-importing file).

### U4. Add `jira_downloadAttachment` Agent Mode tool

- **Goal:** Agent Mode can fetch one specific, named attachment from a known ticket — including one the default load path skips — without a full reload or the chat-only resume flow, and can discover that filename via `jira_getTicket` alone.
- **Requirements:** R9, R10, R11
- **Dependencies:** U2
- **Files:**
  - `src/jira/IJiraClient.ts` (`JiraAttachment` gains `created: string` — KTD7)
  - `src/tools/jiraTools.ts` (`DownloadAttachmentTool` class + registration)
  - `src/participant/sessionState.ts` (`buildDownloadAttachmentConfirmation`, not-found message builder)
  - `package.json` (`contributes.languageModelTools`: new `jira_downloadAttachment` entry; `jira_getTicket`'s existing entry gets an updated `modelDescription` — R11)
  - `src/test/fixtures/ticket-PROJ-123.json` (add `created` to existing attachment entries; add a same-filename duplicate fixture for the tie-break test)
  - `src/test/jiraTools.test.ts`
- **Approach:**
  1. Update `jira_getTicket`'s `modelDescription` in `package.json` to name attachments among what it returns (R11) — e.g. append "Lists the ticket's fields, description, and attachment filenames." No code change: `GetTicketTool` already renders the `## Attachments` section (`src/services/TicketService.ts:277-286`); only the tool's advertised description was missing the pointer.
  2. `buildDownloadAttachmentConfirmation(ticketKey, filename, targetPath)` — names ticket, filename, and `.jira-context/<ticketKey>/attachments/<filename>`.
  3. `DownloadAttachmentTool.invoke()`: validate `ticketKey` and `filename` (non-empty, `isSafePathSegment` on both — R10); check for an open workspace folder first (R10); resolve config; wrap the rest in `try`/`catch` returning a `Could not download <filename> from <ticketKey>: <message>` result on failure, matching every existing tool's `invoke()` (Sources); fetch `ticketService.getIssue(ticketKey)` and `getAttachments(issue)`; collect every attachment whose `filename` matches exactly.
  4. On zero matches: return a message listing the ticket's actual attachment filenames (KTD5) — no write.
  5. On one or more matches: pick the one with the latest `created` timestamp (KTD5/KTD7); when more than one matched, name in the result text that the most recent of N was picked.
  6. Enforce the 100 MB cap from KTD1's module against the picked attachment (reject over-cap with a clear message, no write); otherwise download via `ticketService.downloadAttachment`, call U2's `ensureJiraContextGitignored(wsRoot)` helper, and write into `.jira-context/<ticketKey>/attachments/` (creating the directory if it doesn't already exist from a prior load).
  7. Register `jira_downloadAttachment` in `registerJiraTools()` and declare it in `package.json`.
- **Technical design:** Directional only — `invoke()` does not consult or write any `LoadSkippedSession`; it always re-derives the ticket's attachment list live (KTD5), so it works whether or not `/load`/`jira_loadTicket` ran first. It calls U2's `ensureJiraContextGitignored` helper directly rather than U2's full load core (KTD2 governs U3 only, not U4), since a full load-and-classify pass is not needed for one named file.
- **Patterns to follow:** `GetTicketTool`/`AddCommentTool` for the `isSafePathSegment` + `tryGetConfiguredContext` + `try`/`catch`/`logDiag` shape; `handleLoadTicket`'s existing attachment-download loop (`ticketService.downloadAttachment`, `vscode.workspace.fs.writeFile`) for the single-file download itself.
- **Test scenarios:**
  - Covers AE7. `jira_getTicket`'s declared `modelDescription` (read from `package.json`) mentions attachments — a config-shape check, not a behavior test, since `GetTicketTool`'s attachment rendering is pre-existing and untouched by this unit.
  - Happy path: confirmation names ticket, filename, and target path.
  - Covers AE5. Downloading a filename that the eligibility filter would skip (e.g. a `.bin` file) still succeeds — the tool does not call `classifyAttachmentEligibility`.
  - Covers AE6. A `filename` not present among the ticket's attachments returns a message listing the real filenames, not a raw error.
  - Edge case: two attachments share the same `filename` with different `created` timestamps — the tool downloads the one with the latest `created` and the result text names that a duplicate was resolved.
  - Edge case: a matching attachment over `ATTACHMENT_SIZE_LIMIT` is rejected with a clear size-cap message, no write.
  - Edge case: empty/missing `ticketKey` or `filename` returns a validation message without reaching `tryGetConfiguredContext`.
  - Edge case: a `filename` containing `/`/`\`/`..` is rejected by `isSafePathSegment` before any call.
  - Edge case: run against a ticket that was never loaded before — `.jira-context/` is still added to `.gitignore` (via `ensureJiraContextGitignored`), same as a fresh `/load`.
  - Error path: an upstream failure (unknown ticket key, network error, auth failure) returns a `Could not download <filename> from <ticketKey>: <message>` result rather than throwing.
  - Not configured / no workspace folder: same graceful short-circuits as U3, verified the same way.
- **Verification:** `jiraTools.test.ts` confirmation/not-found/duplicate-resolution/modelDescription cases pass; a manual Extension Development Host run fetches a real ticket's previously-skipped attachment successfully, correctly resolves a real duplicate-filename case if one is available, and reports a real not-found case correctly (same manual-EDH rationale as U3).

### U5. Update `docs/onboarding.md`

- **Goal:** The onboarding doc's tool and slash-command tables are accurate again.
- **Requirements:** R7
- **Dependencies:** U1, U3, U4
- **Files:**
  - `docs/onboarding.md`
- **Approach:**
  1. Add `jira_loadTicket` and `jira_downloadAttachment` rows to the Write tools table (`docs/onboarding.md:55-60`), each with required/optional input columns matching their tool schema.
  2. Add a `/load` row to the `@jira` Slash commands table (`docs/onboarding.md:258-266`).
  3. Confirm the "every core Jira read/write operation is also exposed as a tool" claim (`docs/onboarding.md:9`) is accurate given the new tools.
- **Test expectation:** none -- documentation only.
- **Verification:** Both tables list the new command/tools; the "every core operation" claim holds.

---

## Verification Contract

| Check | Command / method | Applies to |
| --- | --- | --- |
| Type check | `npm run compile` | Whole repo (unaffected by this work, must stay green) |
| Unit tests | `npm test` | U1 (`llmHelpers.test.ts`), U2 (`attachmentEligibility.test.ts`, `loadTicketCore.test.ts` — KTD8), U3/U4 (`jiraTools.test.ts` confirmation/result-text/not-found builders) |
| Manual Extension Development Host check | Run `@jira load`, `/load`, `jira_loadTicket`, and `jira_downloadAttachment` against a real Jira ticket (including a ticket with a normally-skipped attachment, and a duplicate-filename attachment if one is available); confirm `jira_loadTicket`'s result is not followed by unprompted file reading (R8/KTD4) | U1 (chat streaming), U3, U4 — confirmation dialogs, `jiraTools.ts` registration/wiring, and R8's ask-behavior, none of which KTD8's mock covers. U2's fetch/classify/download/write correctness now has `loadTicketCore.test.ts` (KTD8) as its primary check; this EDH pass is a secondary real-data confirmation for it, not the only one |

## Definition of Done

- `/load` works identically to today's natural-language load (U1, AE1); natural-language load is unaffected (R2).
- `jira_loadTicket` and `jira_downloadAttachment` are registered, declared in `package.json`, and gated on `ticketSidekick.jiraCredentialsSet` like every other tool (U3, U4).
- `jira_loadTicket`'s confirmation and result text satisfy R4/R6/R8 (AE2-AE4), including a manual EDH observation that the calling model does not read the loaded files unprompted; `jira_downloadAttachment`'s confirmation, not-found handling, duplicate-filename tie-break (latest `created` wins, KTD5/KTD7), and size-cap enforcement satisfy R9/R10 (AE5-AE6); `jira_getTicket`'s `modelDescription` names attachments (R11, AE7).
- `attachmentEligibility.test.ts`, `loadTicketCore.test.ts` (KTD8), updated `llmHelpers.test.ts`, and updated `jiraTools.test.ts` all pass; `npm run compile` and `npm test` are green.
- `docs/onboarding.md`'s tool table and slash-command table both list the new surfaces (U5, R7).
- No dead-end or abandoned code from the `loadHandler.ts` refactor remains — `handleLoadTicket` and `jira_loadTicket` route through the same extracted core (KTD2); `jira_downloadAttachment` implements its own single-file fetch per KTD5, sharing the size-cap constant from KTD1's module and the `ensureJiraContextGitignored` helper from U2.
