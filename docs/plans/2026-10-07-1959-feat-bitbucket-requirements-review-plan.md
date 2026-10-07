---
title: Bitbucket Requirements-Aware Review - Plan
type: feat
date: 2026-10-07
topic: bitbucket-requirements-review
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Bitbucket Requirements-Aware Review - Plan

## Goal Capsule

- **Objective:** A developer running a smart or deep `@bitbucket` review learns whether the change does what its Jira ticket asked for, and what it changes beyond that, without leaving the review.
- **Means:** An isolated requirements pass that is the only part of the review that sees the ticket (KD1).
- **Product authority:** The Product Contract below wins on behavior. `STRATEGY.md` boundaries still apply: nothing is written to Jira or Bitbucket, and nothing leaves the machine.
- **Execution profile:** Standard. Work sits in the `@bitbucket` participant, its `vscode`-free helpers, and the review docs. No new secret.
- **Stop conditions:** Stop and ask if the requirements pass cannot be kept out of the ordinary, persona and critic prompts, or if informal question parsing (R16) cannot be made unambiguous against URLs, mode words and Jira keys.
- **Open blockers:** None.

---

## Product Contract

### Summary

In smart and deep reviews, a Jira key in the PR title makes the review pause once and ask whether to use the ticket. If you opt in, a separate requirements pass compares the diff with the ticket's summary, description and comments, and the review gains a "Requirements coverage" block above the findings tables. You can also name the ticket in the prompt, and the upfront question no longer needs a `question:` prefix. Hints, the guided start and `help` show the exact command to copy.

### Problem Frame

The review sees the diff and the PR title and description, so it cannot tell whether the change does what the ticket asked for, or whether it also touches things the ticket never mentioned. The requirements are already in Jira and the key is usually in the PR title. Many tickets are loose bug reports or tasks, and the agreed solution only appears in a comment. The options that steer a review (mode, ticket, question) are also hard to remember.

### Key Decisions

- KD1. **Only the requirements pass sees the ticket.** Ordinary, persona and critic passes are untouched, so the earlier goal of sharpening existing findings with the ticket is dropped. Governs R8. (session-settled: user-directed — chosen over giving ordinary passes a goal summary: the existing passes stay unaffected.)
- KD2. **Ask first with clickable choices** rather than auto-using the ticket or requiring a keyword. Governs R1, R2. (session-settled: user-directed — chosen over keyword-only, auto-use and ask-only-in-smart/deep variants.)
- KD3. **Comments count as requirements source.** Governs R6, R10. (session-settled: user-directed — chosen over summary and description only.)
- KD4. **Coverage is a separate block, not numbered findings.** Governs R13, R14. (session-settled: user-directed — chosen over ordinary findings and over both.)
- KD5. **A wrong reading can be corrected in a follow-up.** Governs R15. (session-settled: user-directed — included at the user's request.)
- KD6. **A trailing question sentence is accepted** with no delimiter. Governs R16. (session-settled: user-directed — chosen over keeping `question:` formal or deferring.)
- KD7. **A missing key or failed lookup runs the review unchanged** and says why. Governs R4. (session-settled: user-directed — chosen over searching further or asking for the key.)
- KD8. **Jira stays optional for `@bitbucket`.** The two participants remain independent and share only credential storage. Governs R5. (session-settled: user-approved)

### Requirements

**Triggering and ticket reference**

- R1. In smart and deep reviews, when the PR title contains a Jira key and Jira is configured, the review pauses once before reviewing and offers clickable choices: requirements check, scope check, use a different ticket, or skip.
- R2. A Jira key in the prompt, outside the PR URL and outside the upfront question text, or written `ticket: KEY`, is the explicit ticket. It overrides a different title key, skips the pause, and runs both checks.
- R3. Quick and standard reviews are unchanged except for one hint line when the title has a key, plus a follow-up chip, both giving the exact smart re-run command. An explicit ticket reference in those modes is ignored with one line saying so.
- R4. When no key is found, Jira is not configured, or the ticket cannot be fetched, the review runs exactly as today and says why in one line. The branch name and PR description are not searched for a key.
- R5. `@bitbucket` reviews work with no Jira configuration at all.

**Reading the ticket**

- R6. The requirements source is the ticket's summary, description and comments. Comments are capped in size, newest first.
- R7. Ticket text is treated as untrusted input and fenced the way the PR description is.

**The requirements pass**

- R8. The requirements pass is the only pass that receives ticket text. It runs only after the user opts in, in smart and deep.
- R9. The pass can ask for extra whole files beyond the diff, within the same budget rules as the existing whole-file pass.
- R10. The pass opens with "How I read this ticket" and labels each requirement by source: description, comment, or inferred. When a later comment narrows or contradicts the description, the newest agreed direction wins; a contradictory thread is flagged and the affected requirements are marked unclear.
- R11. When no usable goal can be derived, the block says "no clear requirements found" and the gap and scope checks are skipped. A requirement is never invented to have something to check.
- R12. Each requirement is marked met, not evident or unclear, and the scope check lists changes the ticket does not account for. Only a requirement that can be pointed to in the ticket text can be marked not evident.

**Output and follow-ups**

- R13. The result is a "Requirements coverage" block above the findings tables. Its items are not numbered findings, so `explain`, `add` and `copy` cannot target them individually.
- R14. "Copy for Teams" includes the coverage block in its plain-text output.
- R15. A follow-up that states the real goal ("the goal is actually X") redoes the coverage block against that wording. Only the requirements pass re-runs.

**Informal syntax and discoverability**

- R16. The upfront question may be a sentence ending in `?` before or after the PR URL, with no delimiter; `question:` and `--` keep working. The review's first line echoes the detected focus. A mode word or Jira key inside the question never changes the review mode or the ticket (per R2).
- R17. The guided start (a bare `/review` or a mode word without a URL) and `@bitbucket help` list smart, deep, a ticket reference and a question, each with a copyable example.

**Documentation and testability**

- R18. The README command table, the matching page under `docs/manual/` and `docs/review-process.md` are updated in the same change.
- R19. The decisions for mode gating, prompt parsing, ticket-text isolation and the correction follow-up live in `vscode`-free modules so Vitest can cover them. The participant file only calls them.

### Key Flows

- F1. Smart or deep review with a title key
  - **Trigger:** The user runs `@bitbucket review smart <url>` and the title contains PROJ-123.
  - **Steps:** The review asks whether to use the ticket; the user picks the checks; the requirements pass runs; the coverage block appears above the findings tables.
  - **Covered by:** R1, R6, R8, R10, R12, R13
- F2. Explicit ticket
  - **Trigger:** The user runs `@bitbucket review smart PROJ-9 <url> does this handle retries?`
  - **Steps:** The ticket and question are extracted, no pause occurs, both checks run, and the first line echoes the focus.
  - **Covered by:** R2, R16
- F3. Correcting the reading
  - **Trigger:** The coverage block misreads the ticket and the user replies with the real goal.
  - **Steps:** The requirements pass re-runs against that wording and the block is replaced.
  - **Covered by:** R15

### Acceptance Examples

- AE1. **Covers R1, R8.** Given a smart review of a PR titled "PROJ-123 add retry" with Jira configured, when the user picks both checks, a coverage block appears and no ordinary, persona or critic prompt contains ticket text.
- AE2. **Covers R3.** Given a standard review of the same PR, when it runs, no pause occurs and one line shows the smart re-run command.
- AE3. **Covers R10.** Given a bug report whose description is vague and whose last comment says "fix by adding an idempotency key", when the pass runs, the block names that requirement and labels its source as a comment.
- AE4. **Covers R11.** Given a ticket with a one-line summary and no description or useful comments, when the pass runs, the block says "no clear requirements found" and lists no gaps.
- AE5. **Covers R2, R16.** Given the prompt `review deep <url> does this fix PROJ-77?` and a title key of PROJ-123, when the prompt is parsed, the mode is deep, the question is the sentence, and the ticket is PROJ-123 because the key inside the question is ignored.
- AE6. **Covers R4, R5.** Given Jira is not configured, when a smart review of a PR with a title key runs, it behaves as today and one line says Jira is not configured.

### Success Criteria

- The parsing rows in R2, R16 and the AE examples hold as a table of prompts under Vitest, including URLs containing `--`.
- A recording fake model shows ticket text reaches only the requirements call, and quick and standard make no extra call.
- Fixture tickets cover a clean spec, a bug report with the fix agreed in a comment, a contradictory thread and an empty ticket. Recorded replies check parsing and rendering in CI; an optional manual script runs the same fixtures against the real model to compare interpretations by eye (not run in CI).
- Chips and the pause itself are covered by the e2e suite only.

### Scope Boundaries

**Deferred for later**

- Parent epics, linked tickets and attachments as requirements source.
- Searching the branch name or PR description for a key.
- Requirements checks in quick and standard reviews.
- Writing anything back to Jira.

**Outside this product's identity**

- Posting review results to Jira or Bitbucket without a confirmation step (`STRATEGY.md` boundary).

### Dependencies / Assumptions

- Jira credentials come from the existing shared configuration; `@bitbucket` reads tickets without depending on the `@jira` participant.
- "Copy for Teams" including the coverage block (R14) is an assumption the user confirmed in the synthesis.
- The comment cap in R6 is a size limit chosen during planning.

### Outstanding Questions

**Deferred to Planning**

- How large a comment cap fits the prompt budget alongside a large diff.
- Whether the requirements pass runs once over the whole PR or per chunk when the diff is large, and where it sits relative to smart mode's persona phase.
- How the Bitbucket participant obtains a ticket reader without importing the `@jira` participant.
- Exact wording of the chips and hint lines.

### Sources / Research

- `docs/review-process.md` — whole-file Pass 2, "Upfront question", "Follow-ups".
- `src/participant/reviewSessionState.ts` — `parseUpfrontQuestion`, `isReviewStartWithoutUrl`, `computeBitbucketFollowups`, `formatReviewForSharing`.
- `src/services/PrReviewService.ts` — PR title and description already sent to the model, fenced as untrusted.
- `docs/plans/2026-09-04-1350-feat-bitbucket-persona-review-plan.md` — precedent for an isolated, mode-gated pass.
- `STRATEGY.md` — boundaries; `CLAUDE.md` — test layout and documentation rules.
