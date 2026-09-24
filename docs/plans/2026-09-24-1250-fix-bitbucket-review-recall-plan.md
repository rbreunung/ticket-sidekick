---
title: Bitbucket Review Recall - Plan
type: fix
date: 2026-09-24
topic: bitbucket-review-recall
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Bitbucket Review Recall - Plan

## Goal Capsule

- **Objective:** A developer running `@bitbucket` on a pull request, in any mode, sees every real finding the model produced, with its location when it can be verified. When part of the PR could not be reviewed, the developer is told which part.
- **Product authority:** This plan covers the whole review pipeline: intake, Pass 1, truncation recovery, Pass 2, persona passes, critic, formatting, follow-ups and smart-mode resume. Everything listed under Scope Boundaries is excluded.
- **Open blockers:** None. The remaining questions are Deferred to Planning.

---

## Product Contract

### Summary

Fix the code paths that make `@bitbucket` reviews lose findings, abort, or answer with less context than they have:
- Unreadable replies no longer end the review.
- Fetched context files actually reach Pass 2 and the critic.
- Pass 2 refines Pass 1 instead of replacing it.
- Findings with an unverifiable location are shown, not dropped.
- Truncated Data Center diffs are completed.
- Follow-ups keep the review's focus.

### Problem Frame

The developer suspects reviews miss real issues. There is no hard count behind that suspicion, but an audit of every review path found concrete mechanisms that would produce exactly that symptom. Each one loses findings with no message in chat, or with only an output-channel line.

The largest leaks are these:
- **Pass 2 never shows the files it fetched.** Only files already in the diff get their full content rendered, yet the prompt claims the files were provided. Pass 2's output then replaces Pass 1's findings wholesale.
- **A missing last line reads as truncation.** A reply that simply omits the trailing meta line is treated as truncated, which suppresses Pass 2 for that batch.
- **Anchor matching is exact.** A whitespace difference or a copied `L<n>` gutter drops the finding outright.
- **One unreadable reply aborts everything.** A single prose or empty reply from any pass ends the whole review and discards every earlier batch's findings.
- **The critic can fail closed.** Its verdict parsing turns numeric-string indices into "keep nothing".

The full list, with file and line evidence and probe results, is in Sources.

`docs/review-process.md` promises "a review never looks empty because filters stacked up", and STRATEGY.md's *Review quality* track needs output trustworthy enough to post. Today's behaviour breaks both.

### Key Decisions

- **All twelve audit areas are in scope as one plan**, not split into separately shipped groups. (session-settled: user-directed — chosen over "lost + vague results only", "only lost results" and "only follow-ups": one pass over the whole system.) Governs R1–R24.
- **Pass 2 refines Pass 1 rather than replacing it or only adding to it.** (session-settled: user-directed — chosen over "additive only" and "replace, but fixed": it keeps Pass 1's recall while letting real context disprove a finding.) Governs R7, R8.
- **A finding with an unlocatable anchor is kept, demoted, rather than dropped.** (session-settled: user-directed — chosen over "drop, but disclose" and "drop silently": nothing vanishes.) Governs R13.
- **A finding naming a file that is not in the PR diff at all is still dropped**, because it breaks grounding rule 1 (an invented path). It is counted under R14. Governs R13, R14.
- **Chunks shrink in every mode to trade cost for depth.** (session-settled: user-directed — chosen over "prompt-only" and "make it a setting": each file gets more of the model's reply.) Governs R15.
- **The smaller chunk cap applies to `deep` and `quick` too.** (session-settled: user-directed — chosen over exempting `deep` or `quick`: one rule, with the cost shown in the token estimate.) Governs R15.
- **Recall is proven by recorded-reply tests, one per failure shape.** (session-settled: user-directed — chosen over also building a planted-bug PR reviewed by a live model: deterministic and runs in CI.) See Success Criteria.
- **Truncated Data Center diffs are recovered, not only disclosed.** (session-settled: user-directed — chosen over "disclose only": full coverage on large PRs is worth the extra calls.) Governs R17.

### Requirements

**A bad reply never sinks the review**

- R1. A reply from any review call that cannot be parsed never ends the review. This covers Pass 1, continuation, Pass 2, persona passes and the critic. The reply is retried like any other failed attempt. If it still fails, only that batch's files are reported as not reviewed by that pass, and every other batch's findings are shown.
- R2. An empty reply counts as a failed attempt under R1, never as a crash.
- R3. Findings are recovered from every common JSON shape for the same content: one object per line, objects spread over several lines, a JSON array, a `{"findings": [...]}` wrapper, and any of these inside a code fence.
- R4. A reply that ends cleanly but lacks the trailing meta line is complete, not truncated. It gets no truncation warning, no continuation call, and stays eligible for Pass 2. "Truncated" means the reply stops mid-object or mid-line.
- R5. Truncation recovery re-reviews every file the cut-off reply did not finish, including the file it stopped inside, and applies to persona passes as well as Pass 1. A batch recovered this way stays eligible for Pass 2.

**Context actually reaches the model**

- R6. Every context file fetched for Pass 2 or critic round 2 that fits the budget appears in that prompt in full, whether or not the file is in the diff. A prompt never says files were provided when none were.
- R7. Pass 2 receives Pass 1's findings for its batch. It may add findings, and it may retract a Pass 1 finding only by explicitly referencing it. Pass 1 findings it does not mention are kept.
- R8. If Pass 2 fails or is truncated, the batch keeps Pass 1's findings plus any complete additions and explicit retractions Pass 2 managed to return.
- R9. A Pass 2 or critic prompt never exceeds the token budget. Context files that do not fit are skipped and named in the diagnostic timeline.
- R10. In `deep` mode the critic judges each finding with the same context files Pass 2 used for that batch.

**Critic verdicts**

- R11. A critic verdict listing indices as numeric strings is read as numbers. A verdict with any index outside 1..N, such as 0-based numbering, is treated as unparseable: the batch's findings are kept unverified, with the same notice a failed critic call shows today.

**Location verification**

- R12. Anchor matching tolerates the following differences, while verified line numbers still come only from the diff:
  - whitespace differences inside and around the line, including tabs vs spaces
  - a copied `L<n>` gutter
  - a leading `+`, `-` or space diff marker
  - the path spellings `./x`, `a/x`, `b/x` and `/x`
  - a file split across several pieces
- R13. A finding whose anchor still cannot be located is kept as a file-level finding marked "location unverified". It has no line number and is muted like a below-threshold confidence row. When posted, it goes to the activity feed, never inline.
- R14. When findings were dropped, the review output says so in one line with counts. This covers invented file paths (per the Key Decision) and critic drops. A review never shows "No issues found" alone after it dropped findings.

**Depth vs cost**

- R15. In every mode, a chunk is capped well below the model's input window, so each file gets a larger share of the model's reply. The token-estimate line keeps showing the resulting cost.
- R16. The review and persona prompts give one consistent set of length limits:
  - The conflicting code-example limits (3–15 lines vs ≤8 lines) are resolved.
  - The context-file request limit matches what the pipeline will actually fetch.
  - The prompts ask for every real issue while still excluding speculation, instead of saying a short list is better.

**Diff intake**

- R17. When Bitbucket Data Center marks a PR diff as truncated, each cut file's diff is fetched on its own and reviewed. If a single file's diff is still cut, the review states that the file was reviewed partially.

**Follow-ups and smart-mode resume**

- R18. Every follow-up answer receives the review's upfront question and the PR title and description. This covers `#N` explain, free-text finding match and general PR questions.
- R19. Free-text finding matching accepts the model naming a finding as `2`, `#2`, `Finding 2` or `2.`.
- R20. A message is treated as "add to review" only when it asks to add or post findings. A question that happens to contain "add" and "review" is answered as a question.
- R21. A finding on a removed line carries the diff excerpt around that removed line, so a follow-up about it sees the real code.
- R22. The diff stored for follow-ups holds only the files that were reviewed. When it must be shortened to fit the budget, it drops whole files, keeping files with findings first, and the follow-up prompt names the omitted files.
- R23. A smart-mode review resumed after the fallback question behaves like an uninterrupted smart review:
  - Persona passes get the same focus question and review instructions.
  - The stored session supports diff-aware follow-ups.
  - The partial-failure notice, the token estimate and the follow-up chips appear.

**Documentation**

- R24. `docs/review-process.md` and the "Findings funnel" entry in `CONCEPTS.md` describe the new behaviour: Pass 2 refines, unverified-location rows, dropped-count disclosure, the chunk cap and Data Center recovery. The `CONCEPTS.md` entry also loses its stale "folded into the collapsed section" wording.

### Acceptance Examples

- AE1. **Covers R1.** **Given** a `deep` review of a three-chunk PR, **when** the security persona answers chunk 2 with only "No security issues found." on both tries, **then** the review completes with every finding from all chunks and shows one notice that the Security pass could not review chunk 2's files.
- AE2. **Covers R4.** **Given** a Pass 1 reply with three complete finding lines and no meta line, **when** the batch is processed, **then** no truncation warning or continuation call happens, and the three findings count as that batch's result.
- AE3. **Covers R3.** **Given** a Pass 1 reply containing two findings as pretty-printed multi-line JSON objects, **when** it is parsed, **then** both findings reach anchor verification.
- AE4. **Covers R6, R7.** **Given** Pass 1 found findings #a and #b and asked for `src/util.ts`, which is not in the diff, **when** Pass 2 runs, **then** its prompt contains `src/util.ts` in full plus both findings. If Pass 2 explicitly retracts #b and adds #c, the batch shows #a and #c.
- AE5. **Covers R8.** **Given** the same batch, **when** the Pass 2 reply is cut off before any retraction, **then** the batch still shows #a and #b.
- AE6. **Covers R11.** **Given** a critic verdict `{"keep":["1","2"]}` for three findings, **then** findings 1 and 2 are kept and finding 3 is dropped. **Given** `{"keep":[0,1]}`, **then** all findings are kept unverified, with a notice.
- AE7. **Covers R12, R13.** **Given** a diff line indented with tabs and an `anchorCode` that uses spaces, **then** the finding gets the verified line. **Given** an `anchorCode` matching no diff line even after normalization, **then** the finding appears muted, marked "location unverified", with no line number.
- AE8. **Covers R14.** **Given** every raw finding in a review referenced a file outside the PR, **then** the output reads as "No issues found" plus a line saying N findings were dropped because they named files outside this PR.
- AE9. **Covers R17.** **Given** a Data Center PR whose diff response is marked truncated after 40 of 55 files, **when** the review runs, **then** the remaining 15 files are fetched and reviewed. A single file still cut on re-fetch is named as reviewed partially.
- AE10. **Covers R19, R20.** **Given** an active review session, **when** the user asks "Can you review whether #2 would add latency?", **then** they get an explanation of finding 2, not a comment preview. **When** the matcher answers "#2" to a free-text question, **then** finding 2 is explained.
- AE11. **Covers R23.** **Given** a smart review started with `-- does this break concurrent writes?` that hit the fallback question, **when** the user replies "all", **then** the persona passes see that question, and a later general follow-up is answered with the stored diff.

### Success Criteria

- Every failure shape the audit found (Sources, F1–F11) has a recorded-reply or recorded-response test in `npm test` that failed before the change and passes after it.
- The existing `npm test` suite and `npm run compile` stay green.
- The findings funnel in the output channel still adds up, with the new unverified-location and dropped-file counts shown as their own stages.

### Scope Boundaries

- No new review modes or personas, and no change to what the critic is asked to judge.
- No live-model recall benchmark or planted-bug PR. Real-world gains are judged by the developer's own spot checks.
- No automatic posting. Unverified-location findings follow the existing confirm-before-post flow.
- No change to concurrent-review session sharing: two reviews in one window still share one session slot.

### Dependencies / Assumptions

- Bitbucket Data Center's PR diff response carries `truncated` flags at the response, file, hunk and segment levels, and a per-file PR diff can be requested separately. This has not been verified against a live server.
- Bitbucket Cloud's PR diff is assumed not to be truncated silently. If planning finds that it is, R17's disclosure applies to Cloud as well.
- VS Code's Language Model API still exposes no real token counts, so R9's and R15's budgets stay character-based estimates.

### Outstanding Questions

**Deferred to Planning**

- The exact chunk cap for R15 (a fixed token ceiling, a fraction of the window, or files per chunk) and whether it scales with the model's output limit.
- Whether a prose reply that plainly states "no issues" counts as a clean empty result instead of a failed attempt under R1.
- How Pass 2 expresses an explicit retraction under R7, and what it does when a retraction names a finding that doesn't exist.
- How unverified-location findings under R13 interact with dedup, since they carry no line.
- Which Data Center endpoint and paging behaviour R17 uses for per-file diffs, and how cut files are merged back into chunking.

### Sources / Research

Audit findings, all verified against HEAD `ff4ceda`. Probe results came from running the helpers on crafted inputs.

- **F1 — an unreadable reply aborts the review.** Nothing catches `parseReviewResponse` in the Pass 1 loop (`src/participant/BitbucketParticipant.ts:1137`) or in persona passes (`:388`). It throws on prose or empty replies (`:253-258`). `callLLMOnce` returns `""` on an empty stream (`:117-142`).
- **F2 — a missing trailer reads as truncation.** `parseNdjsonFindings` sets `truncated: !hasMetaLine && …` (`src/participant/reviewSessionState.ts:524`). A truncated batch skips Pass 2 (`BitbucketParticipant.ts:1215`).
- **F3 — some JSON shapes parse as zero findings.** Pretty-printed objects and one-line arrays fall through to `extractJsonObject`, which picks the first finding object, so `findings` becomes `[]` (`BitbucketParticipant.ts:233-241`). Probe confirmed.
- **F4 — Pass 2 context is never rendered, and Pass 2 replaces Pass 1.** `assemblePrompt` renders full content only for diff files (`src/services/PrReviewService.ts:243-251`). The Pass 2 note is unconditional (`:256-259`). The test at `src/test/PrReviewService.test.ts:256-265` codifies the omission. Pass 2 replaces Pass 1 at `BitbucketParticipant.ts:1253-1254`. `selectFilesWithinBudget` always admits the first file (`reviewSessionState.ts:1125`).
- **F5 — the critic has the same rendering gap.** `buildCriticPrompt` renders content only for diff files (`PrReviewService.ts:288-295`).
- **F6 — critic verdict parsing fails closed.** `parseCriticKeep` keeps only integers (`reviewSessionState.ts:1008-1019`). Probe: `["1","2"]` gives an empty set, and `[0,1]` keeps the wrong finding.
- **F7 — anchor matching is exact.** `locateAnchor` requires exact equality after trimming (`reviewSessionState.ts:759-784`). Path lookup is exact and uses the first piece of a split file (`:977`).
- **F8 — truncation coverage is judged by "has a finding".** Coverage is decided by files with at least one finding (`BitbucketParticipant.ts:1157-1158`). Persona passes have no continuation.
- **F9 — follow-ups lose context.** `upfrontQuestion` is stored (`BitbucketParticipant.ts:1546`) but never read. The matcher uses `parseInt` (`:813`). `parseFollowUpIntent` triggers on "add" plus "review" (`reviewSessionState.ts:563-566`). `extractHunkAround` uses new-file ranges only (`:794-813`). The stored raw diff is cut by prefix (`BitbucketParticipant.ts:1534-1535`).
- **F10 — smart-fallback resume drops state.** `SmartFallbackSession` has no question or diff (`reviewSessionState.ts:90-102`). The resume path uses `config.reviewInstructions` only (`BitbucketParticipant.ts:637`).
- **F11 — Data Center truncation is ignored.** The diff types ignore truncation flags (`src/bitbucket/BitbucketApiClient.ts:8-21, 207-227`).
- **F12 — the prompts push toward fewer, shorter findings.** Prompt rule 6 and the conflicting length limits are in `PrReviewService.ts:13-78`. The chunk budget is 0.7 × the input window (`BitbucketParticipant.ts:946-950`).
- **Related docs:**
  - `docs/review-process.md`: the pipeline, and the "Filtering: only two hard drops" promise.
  - `CONCEPTS.md`: the "Findings funnel" entry.
  - `docs/plans/2026-08-26-2316-feat-bitbucket-review-diagnostics-plan.md`: the diagnostics timeline this work extends.
  - `docs/plans/2026-09-04-1350-feat-bitbucket-persona-review-plan.md`: persona passes and smart mode.
