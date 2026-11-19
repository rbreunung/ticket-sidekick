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

- **Objective:** A developer reviews a Bitbucket pull request from a Copilot chat or the Command Palette, without the `@bitbucket` participant or the Local harness. They decide how deep the review goes at the latest useful moment, not up front. This is the last step of the migration: after it, nothing deprecated remains, and the stable channel can get a release.
- **Means:** A PR review board. A staged review on it replaces the quick, smart and deep modes. A read-findings tool, the Bitbucket tools moved into the catalog shape of the Jira tools, a `/ts-bitbucket` skill, and then the removal of `@bitbucket`. This closes O9, O10, O12 to O16, O18, O19 and the Bitbucket part of O20 in [`docs/architecture/migration-status.md`](../architecture/migration-status.md). It answers Q2, Q3 and Q5: O18 and Q5 by the removal, with no interim deprecation mark.
- **Product authority:** The maintainer's decisions in Key Decisions below, within R20 to R27 and R45 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md). Where the two disagree, this plan wins. It replaces the review modes with a staged review, which changes that plan's R20 and R27. It also adds an Explain control to the review board, which that plan's "Not in this work" line left out.
- **Open blockers:** None.

---

## Product Contract

### Summary

The review board opens as soon as a review is asked for. It stops on a first step: the model, the requirements source (a Jira ticket, a goal the developer types and the board rewords for review, or none) and an optional upfront question. After Start, the board runs the regular pass and shows the findings, along with a suggestion of which extra passes are worth running. The suggestion may be empty. The developer keeps the result, runs the suggestion, or picks any extra passes up to a full review, now or later. Each finding can be explained, posted to Bitbucket as an editable comment, or copied for Teams or as Markdown. The chat agent can read the findings through a tool. Once every `@bitbucket` behaviour has a home or a recorded drop, `@bitbucket` is removed.

### Problem Frame

The PR review is the last flow that runs only through a chat participant. `@jira` went on 2026-11-16. Now `@bitbucket` is the only reason the extension still needs the Local harness, `src/participant/`, `workspaceState` chat sessions, follow-up chips and a second set of documentation. The migration status page (Q4) records that VS Code 1.146's release notes announce the Local harness's removal for February 2027. Under the migration's release rule, the stable channel gets nothing until the whole migration is done, so colleagues on stable get no fix until this step lands.

Today's review also asks the developer to choose the depth before seeing anything. A deep review costs many model calls. Smart mode picks its extra passes without asking. Once a review is done, more depth means running it again from the start. In chat, a finding is explained in one turn, a comment is drafted in another, and "Copy for Teams" is triggered by a typed word. None of it survives when the chat moves on.

---

### Key Decisions

- **All of Step 3 is one plan, removal included.** (session-settled: user-directed — chosen over a plan covering only the board and the read-findings tool, and over the board alone: one plan carries the migration to its end.) Governs R31 to R35.
- **A staged review replaces quick, smart and deep.** Every review runs the regular pass first. The developer then keeps the findings, runs the suggested extra passes, or picks any of them up to a full review. More passes can be added later. (session-settled: user-directed — chosen over keeping the modes as shortcuts next to a step-by-step default, and over keeping the modes with only an upgrade on a finished review: decide what to run at the latest point, not up front.) Governs R8 to R12, R29.
- **The requirements source is chosen before the review and runs with the regular pass.** (session-settled: user-directed — chosen over offering the requirements check as an extra pass after the regular one.) Governs R5.
- **A typed goal is reworded for review and shown before Start.** (session-settled: user-directed for the goal as a source; user-approved for showing the rewording, chosen over rewording silently and over using the typed words as they are.) The developer's wording may not suit a requirements check, so the board rewrites it into in-scope and out-of-scope points they can correct. Governs R6.
- **The board always stops on its first step.** (session-settled: user-approved — chosen over starting at once when the chat request already names everything.) Governs R2.
- **The board opens at once and shows live steps.** (session-settled: user-approved — chosen over streaming findings while the run continues, and over opening the board only when the review is done.) Answers Q3. Governs R1, R13.
- **Comments are edited by hand, with a model Rewrite as an option.** (session-settled: user-directed — chosen over hand editing only, and over posting without editing.) Governs R19.
- **Explain is on the board, and the agent can still read findings.** (session-settled: user-approved — chosen over a board-only review the agent cannot see, and over explaining only in chat; it supersedes the boards plan's "no Explain control on the board".) The use case is to explain an issue, then post it or share it with a teammate. Governs R17, R19, R20, R28.
- **Copy offers plain text for Teams and Markdown for everywhere else.** (session-settled: user-directed — chosen over plain text only.) Governs R20, R21.
- **Every model call uses the review model.** This covers Explain, Rewrite, the goal rewording and the re-check. (session-settled: user-approved — chosen over a second model setting for these calls.) Governs R3, R23.
- **A stopped or interrupted review keeps what it found.** (session-settled: user-approved — chosen over resuming the remaining batches, and over discarding the partial run.) Governs R14.
- **The agent matches a free-text question to a finding itself.** (session-settled: user-approved — chosen over keeping the extension's own matching call.) Governs R28.
- **The agent gets a review's result from the read-findings tool.** Starting a review only answers "opened". (session-settled: user-approved — chosen over a tool call that stays open until the review ends, which board steps can delay for minutes.) Governs R26, R28.
- **The Bitbucket tools move into the catalog shape of the Jira tools.** (session-settled: user-approved — chosen over leaving the three existing tools as they are and building only the new ones that way.) Answers Q2. Governs R30.
- **No note field on findings.** (session-settled: user-directed — chosen over keeping the boards plan R21's note: the editable draft carries the developer's own words.) Governs R18, R20.
- **The results screen is one column.** The next-pass choice sits above the findings. (session-settled: user-directed — chosen over tabs like the import board, and over a list with a detail pane, after text sketches of each.) Governs R16.
- **Later passes see what the regular pass saw, read at the reviewed commit.** (session-settled: user-approved — chosen over reading newly requested files at the PR's newest head.) Governs R11, R24.
- **A repeat request opens the stored review.** (session-settled: user-approved — chosen over opening on the first step with the stored review named, and over keeping several reviews per PR.) Governs R36.
- **The critic labels instead of removing when the developer worked on a finding.** (session-settled: user-approved — chosen over keeping every rejected finding labelled, and over always removing.) Governs R37.
- **A new commit on the PR never starts a review by itself.** (session-settled: user-approved — chosen over an automatic quick re-run, and over reviewing only the new commits.) Governs R25.

---

### Requirements

**Starting a review**

- R1. A review starts from a PR link in a Copilot chat, from `/ts-bitbucket review <url>`, or from a Command Palette command that asks for the PR link on the board. The review board opens as an editor tab before any pass runs.
- R2. A new review always stops on the board's first step, prefilled from the chat request or the command, and starts only when the developer presses Start. The step holds the model pick when one is needed (R3), the requirements source (R5) and an optional upfront question.
- R36. Asking for a PR that already has a stored review opens that review, marked out of date when R25 applies. A New review control goes to the first step. Start then asks for confirmation before it replaces a review that has explanations or drafts.
- R3. Every model call the board makes uses the model named in `ticketSidekick.bitbucket.reviewModel`. When that setting is empty, or names a model that is not available, the first step asks the developer to pick one and saves the pick to the setting.
- R4. No model call is made before the model is chosen. The goal rewording (R6) is the only call before Start. The board shows which model ran (boards plan R45).

**Requirements source**

- R5. The first step offers three requirements sources: the Jira ticket, a goal, or none. The ticket is preselected when Jira is configured and the request names a key or the PR title carries one. Otherwise none is preselected. With Jira not configured, the ticket option is unavailable, with a one-line reason. The chosen source is checked as part of the regular pass.
- R6. A typed goal is reworded by one model call into in-scope and out-of-scope points, shown in an editable box on the first step. The developer corrects it and presses Start. The check compares the diff against the text as it stands at Start. The rewording runs only once a model is chosen, and Start is locked while it runs. When it fails, the typed words stay and are used as they stand. Changing the typed goal after the points were corrected asks before the corrections are replaced.
- R7. After a review, the developer can change the source or edit the goal and re-check. Only the requirements check runs again, on the stored diff, and replaces the coverage block. The findings are untouched.

**Staged review**

- R8. Every review starts with the regular pass. That is today's standard review: pass 1, then the budget-aware Pass 2 with whole-file context, plus the requirements check when a source is chosen. The quick, smart and deep modes and the `ticketSidekick.bitbucket.reviewMode` setting are removed.
- R9. The regular pass ends with a suggestion of which of the four persona passes are worth running. Every batch of the regular pass asks for the recommendation as smart mode's first phase does today, and the suggestion is the union across the finished batches. When the recommendation is empty, the board says no extra pass is suggested. When no batch gave a usable recommendation, the board says so and suggests nothing.
- R10. After the regular pass, the developer keeps the findings, runs the suggested passes, or picks any combination of the four persona passes and the critic pass. Picking all of them gives today's deep review.
- R11. Extra passes can be added to a finished review at any time. They run on the full diff the regular pass reviewed and see the context files the earlier passes read. They may ask for more files, as Pass 2 does today, and every file is read at the reviewed commit, never at a newer head. Their findings join the list under today's dedupe rules, and the board marks which passes have run.
- R37. The critic checks the findings it has not checked yet. A finding it cannot confirm is removed, as in deep mode today, unless the developer has explained it or drafted a comment for it. Then it stays, labelled as probably a false alarm. Finding numbers never change: new findings get new numbers, and a removed finding leaves a gap.
- R12. Each pass keeps today's prompts, anchor verification, confidence and dedupe rules. A review with the regular pass plus every extra pass applies the same rules as today's deep review (boards plan R20).

**Running**

- R13. While a pass runs, the board shows each batch as it finishes, with the other controls locked, and a Stop control.
- R14. A pass stopped by the developer or interrupted by a restart keeps the findings of its finished batches, under a banner that names how many batches finished. A pass with failed batches shows today's partial-results banner the same way. A stopped extra pass is not marked as run, and it can be added again on its own. Run again redoes the whole review from the regular pass, after a confirmation when explanations or drafts would be lost.

**Findings**

- R15. The board shows the verified findings exactly as computed, ordered by severity, with today's markers for low confidence and for an unverified location, the requirements coverage block when there is one, and the token usage per pass (boards plan R21).
- R16. After the regular pass, the board is one column, in this order: a header line with the PR, the model, the requirements source and the passes run; the pass suggestion and picker; the coverage block; the findings. Post and Copy act on the selected findings.
- R17. Each finding has an Explain control. Explain makes one model call with the finding, its code, the PR title and description, and the upfront question, and shows the answer under the finding. Explaining again replaces the answer.
- R18. The developer selects findings to post. The board drafts one comment per finding from the finding and its explanation, each in an editable text box. A draft is made once and does not change by itself. When the finding's explanation changes later, the draft is marked outdated, with a Regenerate control.
- R19. A draft can be edited by hand or rewritten by the model with an instruction the developer types, one model call per draft, and the developer reviews the result before posting. After a Rewrite, Undo restores the previous text until the developer edits or posts. Posting needs the native confirmation, which names each comment (boards plan R3).
- R20. Copy for Teams puts the selected findings, or all of them, on the clipboard as plain text with their explanations and the coverage block. It stays plain text because Teams shows pasted Markdown as raw characters.
- R21. Copy as Markdown copies the same content as Markdown, for places that render it, such as a Bitbucket comment or Confluence.
- R22. While Explain, Rewrite, the goal rewording, a re-check or Post runs, that control is locked and shows it is busy. On failure, an error line appears where the result would go, and the previous explanation, draft or coverage stays unchanged. Posting several comments reports each one, and only the failed ones can be retried.
- R23. Every model call the board makes counts toward the monthly per-model token counters.

**Session**

- R24. Findings, the passes run, explanations, drafts, the requirements source, coverage, token usage, the full reviewed diff, the reviewed commit and the context files read are part of the review's session. A restored board shows them without running anything, and the agent can still read them (boards plan R26).
- R25. When the PR's head commit has changed since the review, the board marks itself out of date and offers Run again. It never starts a review on its own.

**Chat**

- R26. A review started from chat answers the agent "opened". The agent gets the counts by severity, the passes run, the verdict and the coverage summary through the read-findings tool (R28).
- R27. When the agent posts a comment on its own, the comment goes through the tool's confirmation dialog, not through the board (boards plan R23).
- R28. A read-findings tool gives the agent a review's summary, its findings list, and on request one finding with its code and explanation. The agent uses it to explain, to work out which finding a free-text question means, and to fix a finding in the local checkout.
- R29. `/ts-bitbucket` offers `review <url>`, `check`, `usage` and `help`. `check` tests the Bitbucket connection and `usage` shows the monthly token table, as `@bitbucket check` and `@bitbucket usage` do now. A plain chat request with a PR link also starts a review.
- R30. The Bitbucket tools are in the same catalog shape as the Jira tools, with generated manifest entries, confirmations for writes and the same guard tests.

**Removal**

- R31. A parity ledger lists every `@bitbucket` behaviour as Carry over or Dropped: reply words, chips, sessions, settings, modes and pipeline rules. A test fails when a behaviour is missing from it, or when a Carry over row has no board or tool that keeps it. It works like the import board's ledger.
- R32. Once the ledger is complete, the removal takes out `@bitbucket`, `src/participant/`, the `chatParticipants` contribution, follow-up chips, disambiguation entries, the participant walkthrough steps, the `bitbucket.session.*` keys and the participant guard tests, along with the rest of the migration status page's removal checklist.
- R33. Every developer and user document then describes tools and boards only. That covers `docs/review-process.md` (now the staged review), `docs/onboarding.md`, the README's Bitbucket section, the manual, `CLAUDE.md` and its Bitbucket checklist, and the migration status page. The deprecation notes added on 2026-11-13 go too (O16, O19, O20).
- R34. The manual checklist gets a Step 3 part, and each preview build runs it on the managed machine.
- R35. Every release until the removal is a preview. The first stable release after it reruns the whole manual checklist.

---

### Key Flows

- F1. Review from chat
  - **Trigger:** The developer pastes a PR link in Copilot chat and says "review this".
  - **Steps:** The board opens on its first step (R1, R2). The ticket from the PR title is preselected. The developer switches to a goal, types "only backend endpoint, export button later", and corrects the reworded points (R5, R6). After Start, the regular pass runs with live progress (R13). The findings appear with "Suggested: security pass" (R9). The developer runs it (R10). Later they ask in chat "how bad is it?", and the agent answers from the read-findings tool (R26, R28).
  - **Covered by:** R1 to R6, R8 to R10, R13, R26, R28
- F2. Explain, then post or share
  - **Trigger:** The developer is unsure about finding #3.
  - **Steps:** Explain shows the reason under the finding (R17). The developer selects #3 to post and rewrites the draft with "shorter, friendlier" (R18, R19). They confirm, and the comment is posted. Then they copy #3 for a teammate in Teams (R20).
  - **Covered by:** R17 to R20
- F3. Back the next day
  - **Trigger:** VS Code restarts with the review board open, and the PR has a new commit.
  - **Steps:** The developer pastes the PR link again, and the board opens on the stored findings, explanations and passes run (R36, R24), marked out of date (R25). They add the critic pass to the stored review. It reads files at the reviewed commit (R11) and labels #3, which the developer had explained, as probably a false alarm (R37). In chat, "fix #2 in my checkout" works through the read-findings tool (R28).
  - **Covered by:** R11, R24, R25, R28, R36, R37

---

### Acceptance Examples

- AE1. **Covers R2, R3, R4.** Given the review model setting is empty, when the developer pastes a PR link in chat, then the board stops on its first step and asks for a model. No model call is made before the pick, and the next review does not ask for a model again.
- AE2. **Covers R5.** Given a PR titled "PROJ-12 Add export" with Jira configured, when the board opens, then the ticket is preselected. When the developer picks none, no ticket is read and no coverage block appears.
- AE3. **Covers R6.** Given the developer types the goal "only backend endpoint, export button later", when they leave the goal field, then one model call shows in-scope and out-of-scope points in an editable box. Nothing else runs until Start.
- AE4. **Covers R7.** Given a finished review with a coverage block, when the developer edits the goal and re-checks, then exactly one model call runs, the coverage is replaced and the findings are unchanged.
- AE5. **Covers R9, R10.** Given the regular pass suggests no extra pass, when the board shows the findings, then it says no extra pass is suggested and still offers every extra pass to pick.
- AE6. **Covers R11.** Given a finished review that ran the security pass, when the developer adds the critic pass the next day, then the critic runs on the full reviewed diff over the findings it has not checked yet, and the security pass is marked as run.
- AE7. **Covers R14.** Given the regular pass on 7 batches, when the developer presses Stop after 3, then the board shows the findings of those 3 under a banner saying 3 of 7 batches finished.
- AE8. **Covers R19, R22.** Given a hand-edited draft, when a Rewrite fails, then the error shows under the draft and the hand-edited text is unchanged. When the developer declines the native confirmation, nothing is posted.
- AE9. **Covers R24, R28.** Given a review board was open, when VS Code restarts, then the board shows the same findings and explanations, no review runs, and the agent can still read finding #3.
- AE10. **Covers R25.** Given a stored review and a new commit on the PR, when the board's background check runs, then the board is marked out of date and no model call is made.
- AE11. **Covers R36.** Given a stored review of PR #482 with an explanation on #3, when the developer asks for PR #482 again, then the stored review opens. Pressing New review and then Start asks for confirmation before the stored review is replaced.
- AE12. **Covers R37.** Given finding #3 has an explanation and #5 has none, when the critic added later cannot confirm either, then #5 is removed and #3 stays labelled as probably a false alarm. #4 keeps its number.
- AE13. **Covers R14.** Given the security pass is stopped after 2 of 5 batches, when the board shows the review, then its findings from 2 batches are kept, the security pass is not marked as run, and it can be added again.

---

### Scope Boundaries

- Dropped with `@bitbucket`, and recorded as Dropped in the ledger (R31): the quick review (pass 1 without Pass 2), the mode words and the hands-off deep review from chat, the smart-mode fallback question, the reply words (`done`, `cancel`, `copy`, `add … to review`, `#N`), follow-up chips, clickable finding headings in chat, and the extension's call that matches a free-text question to a finding.
- Resuming a stopped pass where it left off.
- Findings that appear while a pass is still running.
- A review or extra pass started by a new commit, or by anything other than the developer.
- An Explain, Rewrite or goal rewording that runs without the developer asking for it.

---

### Dependencies / Assumptions

- The session model gains a model-run mode for the review board. A run starts from a board action and saves each finished batch to the session. Stop is handled outside the per-session action queue and cancels the model call in flight. The run is never started by a background check or Refresh. Today every board action waits in one queue per session (`src/sessions/sessionManager.ts`), and no board model call can be cancelled (`src/boards/registerBoards.ts`). This is a shared interface, so it is built before the board's runs (R11, R13, R14).
- A board can call the review model outside a chat request on the managed machine, as Q1 confirmed for the email check on 2026-11-16.
- The organisation's Copilot policy keeps allowing extension tools (V4). If it stops, the board still opens from the Command Palette, but F1, R26 and R28 do not work.

---

### Outstanding Questions

#### Deferred to Planning

- The board's model access today returns only the reply text. The passes also need a stream that can be cancelled, token counting, and the partial-reply recovery that `@bitbucket` uses (R12, R14, R23). Planning decides how the board's model access grows to provide these.
- What the board shows for a review with no findings, and for a regular pass where every batch failed.
- How findings are selected for Post and Copy, and how a long list stays usable after a full review.
- Whether the `ticketSidekick.bitbucket.showTokenUsage` setting still has a job once the chat footer is gone (R15, R23).
- What "the verdict" in R26 is, worked out from today's review output.
- How the work splits into PRs and preview builds. The model-run mode comes first and the removal (R32) last.

---

### Sources / Research

- [`docs/architecture/migration-status.md`](../architecture/migration-status.md): open points O9 to O20, decisions Q2 to Q5, the removal checklist and the release rule.
- [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md): R20 to R27 and R45, flow F3, AE6 to AE8, and the mapping table of old flows to new.
- [`docs/review-process.md`](../review-process.md): the passes, the mode table, persona recommendations, the requirements pass, follow-ups, Copy for Teams and token usage that R5 to R23 build on.
- [`docs/architecture/boards-and-sessions.md`](../architecture/boards-and-sessions.md): the session model, Apply progress, and the rule that an open-board tool answers only "opened" (behind R26).
- `src/boards/boardModels.ts`: the existing `ticketSidekick.bitbucket.reviewModel` setting constant and the board's model list and send interface. The review passes do not read the setting yet.
- `src/tools/bitbucketTools.ts`: the three Bitbucket tools as they are today, outside the Jira catalog.
- `src/test/importBoardParity.test.ts` and the import board parity ledger on the migration status page: the pattern R31 follows.
- [`2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md`](2026-11-16-0628-feat-email-import-board-and-jira-removal-plan.md): how the previous step moved a participant flow to a board and removed the participant.
