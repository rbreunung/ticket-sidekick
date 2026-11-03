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
- **Product authority:** The requesting user (rbreunung).
- **Open blockers:** None.

---

## Product Contract

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

### Outstanding Questions

#### Deferred to Planning

- Whether R5 is best decided from the importer descriptor's capabilities or by asking the screen builder what it would offer.
