---
title: Auto-Finish a Drained Import - Plan
type: feat
date: 2026-11-03
topic: auto-finish-drained-import
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Auto-Finish a Drained Import - Plan

## Goal Capsule

- **Objective:** A user who has created every ticket of an import does not have to type `done` (or click Done) to close it; the import ends on its own with its summary. A review that still has something to act on stays open exactly as today.
- **Means:** One predicate decides "drained" and the `create` branch reuses the `done` finish (KTD1, KTD2).
- **Product authority:** The requesting user (rbreunung).
- **Execution profile:** One pull request; the predicate, the handler change and the tests ship together.
- **Finishes:** `ce-work` implements on `claude/auto-finish-drained-import-plan`; opening a PR is a separate request.
- **Open blockers:** None.

---

## Product Contract

**Product Contract preservation:** restructured, no scope change: the single Outstanding Question (how R5 is decided) is resolved in KTD1 and removed from this section; R1–R8, F1–F2 and AE1–AE5 are unchanged.

### Summary

After `create tickets` on a single-group import (always the case for email), the review currently re-renders as "No new … left to create." with a Done link, and only `done` clears the session and prints "Import finished — …". When that empty screen would offer nothing but Done, the import finishes by itself: the summary is streamed and the session is cleared in the same turn. Any other state keeps today's behaviour.

### Problem Frame

For an email batch where every ticket was created, the next screen is a dead end whose only action is Done. The user has to answer it just to get the summary and release the stored session. The step is needed only while the screen can still do something: retry failed rows, create rows the user excluded, or run an importer-specific command. Observed in `reportImportHandler.ts` (`create` case, `done` case), `importCreate.ts` (`createNewRows` removes created rows, keeps failed ones) and `importScreens.ts` (`buildNewGroupScreen` empty branch).

### Requirements

**Auto-finish**

- R1. After a New-group `create` action on a single-group import, the import finishes in the same turn when no row of the New group remains and no row failed.
- R2. Finishing does what `done` does today: it clears the review session, writes the `import finished` log line and streams the done summary (`buildImportDoneSummary`) with the counts accumulated so far.
- R3. The summary of an auto-finished import is shown directly after the per-ticket creation results, not after a re-rendered review screen.

**Stays open**

- R4. A failed row, or a row the user excluded, keeps the review open with today's screen, so `create tickets` can retry it and `done` still ends the import.
- R5. A screen that offers a command besides Done stays open even when no New row remains. This covers the importer capabilities that add commands to the single-group screen (accepted list, export, reload report), so Veracode and Waltz imports with those commands behave as today.
- R6. In a multi-group import nothing changes: after an action the overview returns and `done` ends the import (R10 of the overview design in `docs/report-import.md`).

**Unchanged**

- R7. `done` and the cancellation words keep working on every open review exactly as today.
- R8. The "add email as a comment" flow and the email cleanup step are not touched.

### Key Flows

- F1. Clean batch
  - **Trigger:** The user clicks `Create N tickets` on an email batch with every row included.
  - **Steps:** Tickets are created one by one with their result lines; all succeed; the import summary follows.
  - **Outcome:** The session is cleared and no further reply is needed.
  - **Covered by:** R1, R2, R3
- F2. Partial failure
  - **Trigger:** One of the creations fails.
  - **Steps:** Results stream; the review re-renders with the failed row still included.
  - **Outcome:** The user retries or ends with `done`.
  - **Covered by:** R4

### Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given an email batch of three included emails that all create successfully, when the user clicks `Create 3 tickets`, then the response ends with "Import finished — **3** created, …", and the stored review session is empty.
- AE2. **Covers R4.** Given three included emails where one creation fails, when creation finishes, then the review shows the failed row with `Create 1 tickets` and no "Import finished" line appears.
- AE3. **Covers R4.** Given three emails with one excluded by the user, when the other two are created, then the review stays open with the excluded row.
- AE4. **Covers R5.** Given a Waltz import with only a New group and the export command available, when all New rows are created, then the empty New screen still shows with its export and Done actions.
- AE5. **Covers R6.** Given an import with New and Stale groups, when all New rows are created, then the overview returns as today.

### Scope Boundaries

- Not changing the `done` summary wording or the outcome counts.
- Not auto-finishing Already-ticketed or Stale actions, even in a single-group import; this requirement is about the New group's `create`.
- Not changing what is stored when the user simply moves on without `done`.

### Key Decisions

- Finish only when the screen has nothing else to offer, rather than always after `create`: retry of failed rows and the importer commands depend on the open session (session-settled: the user asked to remove the step only if pointless).

### Documentation

Update the "Single group" bullet in `docs/report-import.md` and any user-manual text that tells email users to reply `done` after creating tickets.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **"Drained" is a pure predicate over the session and the screen options, not a rendered-screen probe.** `isNewGroupDrained(session, opts)` in `src/participant/session/importScreens.ts` is true when the session is single-group on the New view, `allRows` holds no row with `existingTicketKey === null`, and none of `opts.canExport`, `opts.canAccept`, `opts.canMergeTickets` is set. Governs R1, R4, R5, R6. Why: a failed row and an excluded row both stay in `allRows` as New rows (`createNewRows` removes only created ones), so "no New row left" already covers R4 without reading outcome counters; the three capability flags are exactly what gives the empty New screen a command besides Done (export link, `accept` list and unaccept, `reload report`). Rejected: asking `buildNewGroupScreen` what it would show, which needs a render and couples the decision to markdown. In practice only email satisfies the capability test today, since Veracode and Waltz both declare `overviewExport`.
- KTD2. **Finishing is one shared helper, not a copy of the `done` case.** `finishImport(session, ws, stream, descriptor)` in `src/participant/jira/reportImportHandler.ts` clears `descriptor.sessionKeys.review`, logs `import finished` and streams `buildImportDoneSummary`. The `done` case and the `create` case both call it. Governs R2, R7. The auto-finished turn returns no `jiraSession` metadata, as `done` does, so the session ends for the chat as well.
- KTD3. **The check runs after `createNewRows` and before `rerender()`** in the `create` case, so the per-ticket result lines and the "N on this page — X created, Y failed" line stream first and the summary follows (R3). No re-render of the empty screen happens on the finishing turn.
- KTD4. **`screenOptions` becomes exported from `src/participant/jira/importReviewScreen.ts`** so the handler builds the capability flags in one place instead of re-deriving them from the descriptor.

### Assumptions

- The email "add as a comment" flow (`EmailContentSession`) and the cleanup step never reach the `create` case of `handleImportReviewReply`, so R8 needs no code, only a test that the entry points still behave. Verify while implementing U2.
- A `create` turn with nothing selected ("Nothing selected — no tickets were created.") leaves New rows in `allRows`, so the predicate is false and the review stays open.

### Scope and Sequencing

U1 first (pure, testable alone), U2 wires it in and updates the existing email test, U3 updates documentation. One pull request.

---

## Implementation Units

### U1. Drained-import predicate

- **Goal:** Provide `isNewGroupDrained` as the single source of the "nothing left to act on" decision.
- **Requirements:** R1, R4, R5, R6; AE3, AE4, AE5.
- **Dependencies:** None.
- **Files:** `src/participant/session/importScreens.ts`; test in `src/test/sessionImportReview.test.ts`.
- **Approach:**
  - Add the function next to `buildNewGroupScreen`; it reads `singleGroup`, `view`, `allRows` and the three capability flags (KTD1).
  - It is re-exported through the `sessionState.ts` barrel like its neighbours; no new module.
- **Patterns to follow:** The existing builders in `importScreens.ts` take `ReviewSession` plus `ImportScreenOptions` and call `ensureImportViewState` first.
- **Test scenarios:**
  - Single-group New session, every row created (no New row in `allRows`), no capabilities: true.
  - Same session with one failed row still in `allRows`: false.
  - Same session with one excluded row still in `allRows`: false.
  - Same drained session with `canExport` set: false; likewise `canAccept` alone and `canMergeTickets` alone.
  - Multi-group session (`singleGroup` false) with no New rows: false.
  - Single-group session whose only group is Already ticketed (view `ticketed`): false.
- **Verification:** The predicate's table of cases passes and `npm run compile` is clean.

### U2. Auto-finish after `create`

- **Goal:** End a drained import in the same turn as the last successful `create tickets`.
- **Requirements:** R1, R2, R3, R4, R6, R7; F1, F2; AE1, AE2, AE3, AE5.
- **Dependencies:** U1.
- **Files:** `src/participant/jira/reportImportHandler.ts`; `src/participant/jira/importReviewScreen.ts` (export `screenOptions`); tests in `src/test/emailHandler.test.ts` and `src/test/reportImportHandler.test.ts`.
- **Approach:**
  - Extract `finishImport` from the `done` case and call it there (KTD2).
  - In the `create` case, after `Object.assign(session, afterGroupAction(await createNewRows(...)))`, return `finishImport(...)` when `isNewGroupDrained(session, screenOptions(descriptor, baseUrl))`; otherwise `rerender()` as today (KTD3).
  - The finishing turn returns no review metadata.
- **Execution note:** Start by changing the existing email test (below) to the new expectation and watch it fail.
- **Patterns to follow:** The `done` case and `buildImportDoneSummary`; `createNewRows` already adds the created and failed counts to `outcomes`, so the summary needs no extra bookkeeping.
- **Test scenarios:**
  - Rewrite the AE1 test in `src/test/emailHandler.test.ts` ("an email batch opens straight on the New screen with Done, "ok" creates, and "done" ends it"): after `ok` creates both tickets, the last streamed text contains `**2** created` and not `No new emails left to create`, and `ws.store['jira.session.emailReview']` is undefined without a `done` reply. Covers AE1.
  - Email batch where the first creation throws (the existing failure test with `Jira is down`): the review stays open, the failed row is listed and `ws.store` still holds the session. Covers AE2.
  - Email batch with one row excluded: `ok` creates the others and the session stays open with the excluded row. Covers AE3.
  - A retry after a failure (`ok` again, creation now succeeds) finishes the import, and the summary adds the counts of both turns (one failed then one created). Covers F2.
  - Import with a New and a Stale group (reportImportHandler fixtures): after the New rows are created the overview returns. Covers AE5.
  - Waltz-shaped descriptor (export capability present) with only New rows: after creation the empty New screen renders with Done. Covers AE4.
  - `done` typed on a still-open review ends it with the same summary text as before. Covers R7.
- **Verification:** The email, handler and review tests pass; no test that types `done` after a fully successful email batch remains.

### U3. Documentation

- **Goal:** Keep the developer and user docs true to the new behaviour.
- **Requirements:** R1–R5 (behaviour changes users can see).
- **Dependencies:** U2.
- **Files:** `docs/report-import.md` ("Single group" bullet, line 231); `docs/manual/report-imports.md` (line 146); `CLAUDE.md` row for `reportImportHandler.ts` gets a short clause only if the final shape warrants it.
- **Approach:**
  - `docs/report-import.md`: replace "re-shows itself after an action" with the auto-finish rule and the cases that keep the screen open, citing `isNewGroupDrained`.
  - `docs/manual/report-imports.md`: say that an email batch finishes by itself once every ticket is created, and that **Done** stays for failed or excluded emails.
  - Check README and `docs/manual/` for other text telling email users to reply `done` (grep found none beyond the manual line above).
- **Test scenarios:** Test expectation: none — documentation only; `src/test/userDocsSync.test.ts` must keep passing.
- **Verification:** The docs describe exactly the conditions in KTD1.

---

## Verification Contract

- `npm run compile` — type check clean.
- `npm test` — green before the commit; the tests that prove the plan are the U1 cases in `sessionImportReview.test.ts`, the rewritten email test and the new handler cases in `emailHandler.test.ts` / `reportImportHandler.test.ts`. These mock `vscode` and run in Vitest; they do not exercise a real chat, so one manual check in VS Code with an `.eml` batch against a test Jira is advisable but not a gate.

## Definition of Done

- Every unit's verification holds and AE1–AE5 are each covered by a passing test.
- `npm run compile` and `npm test` are green.
- The old email test that typed `done` after a clean batch is replaced, not left alongside a duplicate.
- Docs match the behaviour (U3); no dead code from the extraction remains.

---

## Sources & Research

- Code read: `src/participant/jira/reportImportHandler.ts` (`done` and `create` cases), `importCreate.ts` (`createNewRows`), `importReviewScreen.ts` (`afterGroupAction`, `screenOptions`), `src/participant/session/importScreens.ts` (`buildNewGroupScreen`, `ImportScreenOptions`), `src/test/emailHandler.test.ts` (existing AE1 test).
- Docs: `docs/report-import.md` "Overview and group screens"; `docs/manual/report-imports.md`.
- No external research and no `docs/solutions/` entry applied.
