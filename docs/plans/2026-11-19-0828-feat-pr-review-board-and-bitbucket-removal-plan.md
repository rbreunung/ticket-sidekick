---
title: "PR Review Board and @bitbucket Removal - Plan"
type: feat
date: 2026-11-19
topic: pr-review-board-and-bitbucket-removal
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# PR Review Board and @bitbucket Removal - Plan

## Goal Capsule

- **Objective:** A developer reviews a Bitbucket pull request from a Copilot chat or the Command Palette, with every feature today's review has, without the `@bitbucket` participant or the Local harness. This is the last step of the migration: after it, nothing deprecated remains and the stable channel can get a release.
- **Means:** A PR review board over today's review pipeline, a read-findings tool, the Bitbucket tools moved into the catalog shape of the Jira tools, a `/ts-bitbucket` skill, and then the removal of `@bitbucket`. Closes O9, O10 and O12 to O16, O18, O19 and the Bitbucket part of O20 in [`docs/architecture/migration-status.md`](../architecture/migration-status.md), and answers Q2, Q3 and Q5.
- **Product authority:** The maintainer's decisions in Key Decisions below, within R20 to R27 and R45 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md). Where the two disagree, this plan wins: it adds an Explain control to the review board, which that plan left out (its "Not in this work" line).
- **Open blockers:** None.

---

## Product Contract

### Summary

The review board opens as soon as a review starts. Its first step takes the model, mode, upfront question and the requirements source: the Jira ticket, or a goal the developer types. It then shows the passes as they run and the verified findings when they are done. Each finding can be explained, noted, posted to Bitbucket as an editable comment, or copied for Teams. The chat agent can read the findings through a tool. When every `@bitbucket` behaviour has a home or a recorded drop, `@bitbucket` is removed.

### Problem Frame

The PR review is the last flow that runs only through a chat participant. `@jira` went on 2026-11-16, so `@bitbucket` is now the only reason the extension still needs the Local harness, `src/participant/`, `workspaceState` chat sessions, follow-up chips and a second set of documentation. VS Code 1.146's release notes, as recorded in the migration status page (Q4), announce the Local harness's removal for February 2027. Under the migration's release rule, the stable channel gets nothing until the whole migration is done, so colleagues on stable get no fix until this step lands.

Today's review also works in a way chat makes awkward. A finding is explained in one turn, a comment is drafted in another, and a "Copy for Teams" is triggered by a typed word. Nothing survives the chat moving on.

---

### Key Decisions

- **All of Step 3 is one plan, removal included.** (session-settled: user-directed — chosen over a plan covering only the board and the read-findings tool, and over the board alone: one plan carries the migration to its end.) Governs R25 to R29.
- **The board opens at once and shows live steps.** (session-settled: user-approved — chosen over streaming findings while the run continues, and over opening the board only when the review is done, which would break the rule that mid-run prompts are steps on the board.) Answers Q3. Governs R1, R8.
- **A typed goal can replace the Jira ticket as the requirements source.** (session-settled: user-directed — the maintainer asked for a field to explain the ticket's goal instead of having the ticket read.) Governs R5, R6.
- **Goal wins over ticket.** (session-settled: user-approved — chosen over sending both to the model, and over never reading the ticket.) Governs R5.
- **Smart mode's fallback choice stays as a board step.** (session-settled: user-approved — chosen over always running all four persona passes, and over always finishing with the standard pass.) Governs R9.
- **Comments are edited by hand, with a model Rewrite as an option.** (session-settled: user-directed — chosen over hand editing only, and over posting without editing.) Governs R15.
- **Explain is on the board, and the agent can still read findings.** (session-settled: user-approved — chosen over a board-only review the agent cannot see, and over explaining only in chat; it supersedes the boards plan's "no Explain control on the board".) The maintainer's use case is to explain an issue and then post it or share it with a teammate. Governs R13, R15, R16, R22.
- **Copy offers plain text for Teams and Markdown for everywhere else.** (session-settled: user-directed — chosen over plain text only.) Governs R16, R30.
- **Explain, Rewrite and the coverage re-check use the review model.** (session-settled: user-approved — chosen over a second model setting for these calls.) Governs R3, R17.
- **A stopped or interrupted review keeps what it found.** (session-settled: user-approved — chosen over resuming the remaining batches, and over discarding the partial run.) Governs R10.
- **The agent matches a free-text question to a finding itself.** (session-settled: user-approved — chosen over keeping the extension's own matching call.) It reads the findings through R22, so today's extension call that matches a question to a finding is dropped. Governs R22.
- **The Bitbucket tools move into the catalog shape of the Jira tools.** (session-settled: user-approved — chosen over leaving the three existing tools as they are and building only the new ones that way.) The boards plan's mapping table already puts them there. Answers Q2. Governs R24.
- **A new commit on the PR never starts a review by itself.** (session-settled: user-approved — chosen over an automatic quick re-run, and over reviewing only the new commits.) A deep review costs many tokens, so the board marks itself out of date and waits for Run again. Governs R19.

---

### Requirements

**Starting a review**

- R1. A review starts from a PR link in a Copilot chat, from `/ts-bitbucket review <url> [quick|smart|deep]`, or from a Command Palette command that asks for the PR link on the board. The review board opens as an editor tab before any pass runs.
- R2. The board's first step shows the mode, with the `ticketSidekick.bitbucket.reviewMode` setting as its default, an optional upfront question, and the requirements source (R5). Values given in the chat request or the command fill the step, and the review starts without waiting when nothing is left to choose.
- R3. The review passes, Explain, Rewrite and the coverage re-check all use the model named in `ticketSidekick.bitbucket.reviewModel`. When it is empty, or names a model that is not available, the first step asks the developer to pick one and saves the pick to that setting.
- R4. No model call starts before every choice on the first step is made, and the board shows which model ran (boards plan R45).

**Requirements check**

- R5. The requirements source is a goal the developer types, or the Jira ticket. A non-empty goal is used, and the ticket is not read. Without a goal, the ticket step follows today's rules: an explicit key is read, a key found only in the PR title asks Use or Skip as a step on the board, and with Jira not configured the board says so in one line and reviews without the check.
- R6. After a review, the developer can edit the goal and re-check: only the requirements check runs again, on the stored diff, and its coverage block is replaced. The findings are untouched. Entering a goal on a review that had no check runs it for the first time.

**Running the review**

- R7. The pipeline is today's pipeline, with the same quick, standard, smart and deep modes, passes, anchor verification and critic, and it gives the same findings for the same diff, model and mode as `@bitbucket` does (boards plan R20).
- R8. While the review runs, the board shows each pass and each batch as it finishes, with the other controls locked, and a Stop control.
- R9. When smart mode gets no usable persona recommendation from any batch, the run pauses and the board asks: run all four persona passes, or finish with the standard review only. Nothing runs until the developer picks.
- R10. A review stopped by the developer or interrupted by a restart keeps the findings of its finished batches, under a banner that names how many batches finished. A review with failed batches shows today's partial-results banner the same way. Run again starts the whole review over.

**Findings**

- R11. The board shows the verified findings exactly as computed, ordered by severity, with today's markers for low confidence and an unverified location, the requirements coverage block when there is one, and the token usage of the run (boards plan R21).
- R12. Each finding can carry a note the developer writes.
- R13. Each finding has an Explain control. Explain makes one model call with the finding, its code, the PR title and description, and the upfront question, and shows the answer under the finding. Explaining again replaces the answer.
- R14. The developer selects findings to post. The board drafts one comment per finding from the finding, its note and its explanation, in an editable text box.
- R15. A draft can be edited by hand, or rewritten by the model with an instruction the developer types, one model call per draft. The developer reviews the result before posting. Posting needs the native confirmation that names each comment (boards plan R3).
- R16. Copy for Teams puts the selected findings, or all of them, on the clipboard as plain text with their notes, explanations and the coverage block. It stays plain text because Teams shows pasted Markdown as raw characters.
- R30. A second control, Copy as Markdown, copies the same content as Markdown, for places that render it such as a Bitbucket comment or Confluence.
- R17. Explain, Rewrite and the coverage re-check count toward the monthly per-model token counters, like the review passes.

**Session**

- R18. Findings, notes, explanations, drafts, coverage and the token usage are part of the review's session. A restored board shows them without running anything, and the agent can still read them (boards plan R26).
- R19. When the PR's head commit has changed since the review, the board marks itself out of date and offers Run again. It never starts a review on its own.

**Chat**

- R20. A review started from chat answers the agent with a short result: counts by severity, the verdict and the coverage summary, with no finding text (boards plan R22).
- R21. When the agent posts a comment on its own, the comment goes through the tool's confirmation dialog, not through the board (boards plan R23).
- R22. A read-findings tool gives the agent a review's findings list and, on request, one finding with its code, note and explanation. The agent uses it to explain, to work out which finding a free-text question means, and to fix a finding in the local checkout.
- R23. `/ts-bitbucket` offers `review`, `check`, `usage` and `help`. `check` tests the Bitbucket connection and `usage` shows the monthly token table, as `@bitbucket check` and `@bitbucket usage` do now.
- R24. The Bitbucket tools are in the same catalog shape as the Jira tools, with the same generated manifest entries, confirmations for writes, and guard tests.

**Removal**

- R25. A parity ledger lists every `@bitbucket` behaviour (reply words, chips, sessions, settings and pipeline rules) as Carry over or Dropped, and a test fails when a behaviour is missing from it or a Carry over row has no board or tool that keeps it. It works like the import board's ledger.
- R26. When the ledger is complete, `@bitbucket`, `src/participant/`, the `chatParticipants` contribution, follow-up chips, disambiguation entries, the participant walkthrough steps, the `bitbucket.session.*` keys and the participant guard tests are removed, along with everything else on the migration status page's removal checklist.
- R27. Every developer and user document describes tools and boards only: `docs/review-process.md`, `docs/onboarding.md`, the README's Bitbucket section, the manual, `CLAUDE.md` and its Bitbucket checklist, and the migration status page. The deprecation notes added on 2026-11-13 go too (O16, O19, O20).
- R28. The manual checklist gets a Step 3 part. Each preview build runs it on the managed machine.
- R29. Every release until the removal is a preview. The first stable release after it reruns the whole manual checklist.

---

### Key Flows

- F1. Review from chat
  - **Trigger:** The developer pastes a PR link in Copilot chat and says "review this, smart".
  - **Steps:** The board opens (R1). The ticket key in the PR title shows Use or Skip, and the developer types a goal instead (R5). The board shows the passes running (R8). The findings appear (R11). The agent says in chat "2 critical, 4 warnings, changes needed" (R20).
  - **Covered by:** R1 to R5, R8, R11, R20
- F2. Explain, then post or share
  - **Trigger:** The developer is unsure about finding #3.
  - **Steps:** Explain shows the reason under the finding (R13). The developer adds a note (R12), selects #3 to post, and rewrites the draft with "shorter, friendlier" (R14, R15). They confirm and the comment is posted. They then copy #3 for a teammate in Teams (R16).
  - **Covered by:** R12 to R16
- F3. Back the next day
  - **Trigger:** VS Code restarts with the review board open, and the PR has a new commit.
  - **Steps:** The board shows the stored findings and explanations (R18), marked out of date (R19). In chat, "fix #3 in my checkout" works through the read-findings tool (R22).
  - **Covered by:** R18, R19, R22

---

### Acceptance Examples

- AE1. **Covers R3, R4.** Given the review model setting is empty, when a review starts, then the first step asks for a model, no model call is made before the pick, and the next review does not ask again.
- AE2. **Covers R5.** Given a PR titled "PROJ-12 Add export" and Jira configured, when the developer types the goal "backend endpoint only", then the ticket is not read and the coverage is checked against the goal.
- AE3. **Covers R5.** Given the same PR and an empty goal, when the review starts in smart mode, then the board asks Use PROJ-12 or Skip before any model call.
- AE4. **Covers R6.** Given a finished review with a coverage block, when the developer edits the goal and re-checks, then exactly one model call runs, the coverage is replaced and the findings are unchanged.
- AE5. **Covers R9.** Given smart mode gets no usable persona recommendation from any batch, when phase 1 ends, then the run waits on the board until the developer picks all or standard.
- AE6. **Covers R10.** Given a deep review on 7 batches, when the developer presses Stop after 3, then the board shows the findings of those 3 under a banner saying 3 of 7 batches finished.
- AE7. **Covers R15.** Given a draft comment, when the developer declines the native confirmation, then nothing is posted and the draft stays as edited.
- AE8. **Covers R18, R22.** Given a review board was open, when VS Code restarts, then the board shows the same findings and explanations, no review runs, and the agent can still read finding #3.
- AE9. **Covers R19.** Given a stored review and a new commit on the PR, when the board's background check runs, then the board is marked out of date and no model call is made.

---

### Scope Boundaries

- Dropped with `@bitbucket`, and recorded as Dropped in the ledger (R25): the reply words (`done`, `cancel`, `copy`, `add … to review`, `#N`), follow-up chips, clickable finding headings in chat, and the extension's call that matches a free-text question to a finding.
- Resuming a stopped review where it left off.
- Findings that appear while the run continues.
- A review started by a new commit on its own.
- An Explain or Rewrite that runs without the developer pressing the control.

---

### Dependencies / Assumptions

- A board can call the review model outside a chat request on the managed machine, as Q1 confirmed for the email check on 2026-11-16.
- The organisation's Copilot policy keeps allowing extension tools (V4). If it stops, the board still opens from the Command Palette, but F1 and R20 to R22 do not work.

---

### Outstanding Questions

#### Deferred to Planning

- Whether the `ticketSidekick.bitbucket.showTokenUsage` setting has a job once the chat footer is gone, or is removed with `@bitbucket` (R11, R17).
- How the work splits into PRs and preview builds, as long as the removal (R26) comes last.
- What "the verdict" in R20 is, worked out from today's review output.
- What one review session holds when the same PR is reviewed in a different mode, given that a session id comes from its kind and source.

---

### Sources / Research

- [`docs/architecture/migration-status.md`](../architecture/migration-status.md): open points O9 to O20, decisions Q2 to Q5, the removal checklist and the release rule.
- [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md): R20 to R27 and R45, flow F3, AE6 to AE8, and the mapping table of old flows to new.
- [`docs/review-process.md`](../review-process.md): the pipeline, modes, requirements pass, smart fallback, follow-ups, Copy for Teams and token usage that R5 to R17 keep.
- `src/boards/boardModels.ts`: the existing `ticketSidekick.bitbucket.reviewModel` setting constant and the model list and send interface. The review passes do not read the setting yet.
- `src/tools/bitbucketTools.ts`: the three Bitbucket tools as they are today, outside the Jira catalog.
- `src/test/importBoardParity.test.ts` and the import board parity ledger in the migration status page: the pattern R25 follows.
- [`2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md`](2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md): how the previous step moved a participant flow to a board and removed the participant.
