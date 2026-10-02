---
title: Token Meter on Frozen Host Objects and Honest Review Failures - Plan
type: fix
date: 2026-10-02
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Token Meter on Frozen Host Objects and Honest Review Failures - Plan

## Goal Capsule

- **Objective:** `@bitbucket` reviews work whatever shape the editor's model objects have, a review that never ran is never presented as a review that found nothing, and the "Ticket Sidekick" output channel is enough to tell why a review failed.
- **Means:** a token-meter wrapper that cannot contradict a read-only property (KTD1), plus a count-based failed-review result (KTD3) and a diagnostics pass over the review path (KTD6).
- **Authority:** the Product Contract's R-IDs win on behavior, KTDs win on mechanism. The original bug report is evidence, not specification; its proposed fix is superseded by KTD1.
- **Execution profile:** code, test-first. The frozen-model test goes red before the meter changes.
- **Stop and ask if:** the shape-matrix tests show the empty-target proxy cannot satisfy a needed behavior, or a fix needs changes to existing flow-test assertions beyond the two named in U3.
- **Finishes and ships:** `ce-work` implements on branch `claude/wizardly-euler-cdtljn`. A maintainer cuts the patch release through the manual release workflow.

---

## Product Contract

### Summary

Make the token meter safe on read-only host objects and unable to break a model call. Report a review in which no file was reviewed as failed, not as clean. Make the failure trace in the output channel name the error class, why a call was not retried, and the metering state.

### Problem Frame

`createTokenMeter` wraps the chat model in a `Proxy` that returns its own `sendRequest`. When the host hands the extension a frozen model, every property is read-only and non-configurable, and the JavaScript `Proxy` rules forbid a `get` trap from returning anything but the real value. The wrapper throws on first access. The wrapper also binds every other method, so the same rule makes `countTokens` throw. Any `@bitbucket` call is affected: reviews, follow-ups and comment refinement. The meter shipped in 0.6.14, and its tests use a plain mutable model, so nothing caught this.

The failure then misleads. A one-file PR captures the error per batch, prints "could not review … after retrying", and finishes with "No issues found." although only one attempt ran and nothing was reviewed. A multi-file PR rethrows the same error and shows "Review failed" instead. The output channel records the attempt and the message but not the error class, nor that it chose not to retry, nor that the review ended with zero reviewed files.

### Requirements

**Metering safety**

- R1. `@bitbucket` model calls work when the model or reply object is read-only (frozen), for every property and method the code reads, not only `sendRequest`.
- R2. Metering never fails a model call. If the meter cannot attach, the call runs on the unwrapped model, that response's tokens are not counted and no usage footer shows, and a warning names the cause.
- R3. Metering of ordinary models is unchanged: counts, the `chars / 4` estimate fallback, partial counts on a broken stream, separate totals per meter, and non-fatal recording failures.

**Failure reporting**

- R4. When no file received a readable review reply, the chat says the review failed, with the file count, the cause and a pointer to the output channel, and never shows "No issues found."
- R5. A review that failed under R4 is not stored or announced as completed: no review session, no first-review-completed signal, no "review completed" follow-up chips. In smart mode it does not ask the user to choose lenses.
- R6. When only some files failed, results appear as today under a partial-results warning that no longer claims a retry it cannot vouch for.
- R7. A per-file failure notice says "after retrying" only when the error class is one the retry layer retries.

**Diagnostics**

- R8. Each failed review-call log line names the error class. For an error with no provider code it also carries the top stack frames as function plus file and line, without directories.
- R9. When an error is not retried, the log says so and names the class, so a one-attempt failure explains itself.
- R10. A review that ends failed logs at error level with the reviewed and failed file counts and the first cause. A partial review's completion line carries the same counts. No review that reviewed nothing logs "completed — 0 finding(s)".
- R11. Each review's opening log lines record whether metering is on and whether the host's model object is frozen.

### Key Decisions

- **A failed review must not read as clean.** (session-settled: user-directed — chosen over a core-fix-only change: a review that never ran showing "No issues found" tells a reviewer the PR is clean.) Governs R4, R5, R6, R7.
- **Metering never breaks a model call.** (session-settled: user-directed — chosen over a core-fix-only change: the meter is a side feature and it took down the core review.) Governs R2.
- **The logging audit is part of this change.** (session-settled: user-directed — chosen over a separate follow-up: the failure's trace should name its cause class and why it was not retried.) Governs R8, R9, R10, R11.

### Acceptance Examples

- AE1. Covers R1, R3. Given a one-file PR and a frozen model whose replies are also frozen, when `@bitbucket <pr-url>` runs, the review completes with its findings and a stored session.
- AE2. Covers R4, R5, R9, R10. Given a one-file PR and a model that throws a plain `TypeError` on every call, when the review runs, one call is made, the chat shows "Review failed" with the cause and no "No issues found", no session is stored, and the log shows the not-retried decision and an error-level failed-review line.
- AE3. Covers R6. Given a PR in two batches where one batch fails every try and the other succeeds, the successful batch's findings appear under the partial-results warning and the session is stored.
- AE4. Covers R7. Given a failing batch, the notice says "after retrying" when the error was a transient provider error that exhausted its tries, and omits it when the error was not retried.

### Success Criteria

- The original report reproduces in the flow-test harness with a frozen model and passes after the fix.
- From the output channel alone, a reader can tell which error class ended a failed review, how many attempts ran, whether a retry was refused and why, and whether metering was on.

### Scope Boundaries

Considered and not built:

- Changing which errors count as transient or retrying plain `TypeError`s. The user kept that out of scope; a code bug should fail fast.
- Showing "metering is off" in the chat. An unmetered response undercounts a usage counter, which a warning in the output channel surfaces cheaply. KL12 records it.
- Treating persona-only or critic-only failures as a failed review. Pass-1 or persona replies that parsed still produce findings; the partial warning covers the rest.
- Special handling of user cancellation. It keeps its current behavior; R7's wording rule already stops it reading as a retried failure.
- Any change to the usage counters, the footer format or `@bitbucket usage`.

Deferred to Follow-Up Work:

- Capture the frozen-host-object lesson under `docs/solutions/` once the fix has shipped and the host's behavior is confirmed from the new log field.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Both wrappers become proxies over an empty target.** The model wrapper and the reply wrapper keep their handlers (read from the real object, bind functions, replace only `sendRequest` or `text`) and gain a `has` trap, but no longer use the real object as proxy target. The invariant only checks a target's own properties, so an empty target cannot violate it. (session-settled: user-approved — chosen over `Object.create(model)` shadowing: that calls the model's inherited methods with `this` set to the wrapper, which a Node probe showed throws on a class with `#private` fields, while the empty-target proxy kept working on a frozen `#private` model.)
- KTD2. **Fail-open probe at construction.** `createTokenMeter` reads the real model's `sendRequest` (the wrapper's own `sendRequest` never touches the real model, so probing the wrapper would prove nothing) and, through the wrapper, `countTokens` and `id`, inside a try/catch. On a throw it returns the raw model, zero totals and `metered: false`, and logs one warning through `onDiag`. The footer already skips responses with zero calls. With KTD1 the probe guards against wrapper-specific failures we have not seen, which is why it stays this small.
- KTD3. **"Failed" is decided by a count, not by `anyBatchFailed`.** The boolean cannot tell one failed batch from all of them. The handler counts files in successful pass-1 batches plus successful persona batches (deep mode runs personas inline). Zero means failed. The check sits right after the chunk loop, before smart mode's persona-choice fallback, so smart mode cannot ask about lenses for a review that never ran. `ReviewTally` gains only optional fields, because stored smart-fallback sessions carry an older tally.
- KTD4. **"After retrying" is derived from the error class.** The retry layer retries exactly the errors `isTransientLmError` accepts, so a transient error that reaches a batch has used its tries and a non-transient one ran once. No attempt count needs plumbing. The aggregate warning drops the phrase.
- KTD5. **A failed review follows the abort path's contract.** The existing outer catch already streams a failure and returns with no session, no context key and no chips. The failed result does the same. This matters because `ticketSidekick.firstReviewCompleted` completes a Getting Started walkthrough step.
- KTD6. **Diagnostics through pure helpers, with redaction-safe keys.** Error description, the give-up decision line and the failure wording live in `reviewDiagnostics.ts` and `reviewSessionState.ts`, which `vscode`-free tests can load. New `details` keys avoid the standalone word `token`, which `sanitizeDetails` redacts (`docs/solutions/logic-errors/redaction-substring-match-false-positives.md`): use `metering`, `frozen`, `errorName`, `stackHead`. Stack frames are cut to function plus file basename and line so a pasted log carries no home directory.

### High-Level Technical Design

Review outcome after the chunk loop (R4, R5, R6):

| Reviewed files | Chat | Stored session, walkthrough signal, chips | Completion log |
| --- | --- | --- | --- |
| All batches readable | Findings, or "No issues found." | Yes | Info, finding count |
| Some batches failed | Findings plus the partial-results warning | Yes | Info, finding count and failed-file count |
| None | "Review failed" with file count, cause, output-channel pointer | No | Error, reviewed and failed counts, first cause |

---

## Implementation Units

### U1. Token meter on frozen objects, with fail-open

**Goal:** Metering works on read-only model and reply objects and can never fail a call.

**Requirements:** R1, R2, R3 (AE1; KTD1, KTD2).

**Dependencies:** none.

**Files:**

- Modify: `src/participant/bitbucket/tokenMeter.ts`
- Test: `src/test/tokenMeter.test.ts`

**Approach:**

- Replace both `new Proxy(real, …)` with proxies over an empty target and forward `get` and `has` to the real object. Keep the bind-to-real-object behavior for functions.
- Add the construction-time probe (KTD2: the real `sendRequest`, plus `countTokens` and `id` through the wrapper) and a `metered` flag on the returned meter. On fallback, return zero totals and warn via `onDiag` with the error name and message.
- Update the file's header comment, which still describes a proxy "that overrides only `sendRequest`".

**Execution note:** Write the frozen-model test first and watch it fail with the reported message.

**Patterns to follow:** the existing `fakeModel()` fixture and `drain()` helper in `src/test/tokenMeter.test.ts`.

**Test scenarios:**

- Covers AE1. Frozen model (`Object.freeze(fakeModel())`): `sendRequest` returns a reply, totals and `record` match the unfrozen case.
- Frozen model: `countTokens`, `id`, `family` and `maxInputTokens` read through unchanged.
- Frozen reply (`Object.freeze({ text })`): streamed text is counted and returned.
- Class model with a `#private` field and a `this`-dependent `countTokens`: the call returns the real value.
- Model with a getter-based `family`: reads through.
- `'family' in model` is true for a real property and false for an unknown one.
- Model whose `sendRequest` accessor throws on read: the meter returns the raw model (same identity), `metered` is false, totals are zero, and `onDiag` receives a warning with the error name.
- Model whose `countTokens` accessor throws on read: same fallback, proving the through-the-wrapper reads are probed too.
- All 11 existing scenarios pass unchanged.

**Verification:** the frozen-model scenario fails on the old code with the reported message and passes now; `npm test` is green for this file.

### U2. Diagnostics helpers and failure wording

**Goal:** Pure, testable helpers for the new log lines and the failure messages.

**Requirements:** R4, R6, R7, R8, R9 (AE4; KTD4, KTD6).

**Dependencies:** none.

**Files:**

- Modify: `src/participant/bitbucket/reviewDiagnostics.ts`
- Modify: `src/participant/reviewSessionState.ts`
- Test: `src/test/reviewDiagnostics.test.ts`
- Test: `src/test/PrReviewService.test.ts` (where the existing `formatRecoveryDecision` tests live; confirm at implementation)
- Test: `src/test/logRedaction.test.ts`

**Approach:**

- Add `describeErrorForLog(err)` returning the error name, the provider code when present, and, only for errors without a string `code`, `stackHead` (top three frames, function plus file basename and line).
- Add a `give-up` kind to `RecoveryDecision` and its `formatRecoveryDecision` line. `handleAttemptFailure` emits it where it now returns silently for a non-transient error.
- Add wording helpers: a per-batch failure notice taking the already-described cause and a `retried` flag, the partial-results banner without "after retrying", and the failed-review message (file count, cause, output-channel pointer, no "No issues found").
- Helpers import from the existing `vscode`-free modules only, avoiding a cycle with `PrReviewService.ts`.

**Patterns to follow:** `handleAttemptFailure`'s injected `logFailure`/`logReview`; `formatCallLine`'s pure string builders.

**Test scenarios:**

- `describeErrorForLog` on a `TypeError` returns the name and at most three frames, none containing a directory path.
- On a `LanguageModelError`-shaped error (`code: 'Unknown'`) it returns name and code and no `stackHead`.
- On a thrown string it returns without throwing.
- Covers AE2. `handleAttemptFailure` with a non-transient error logs the failure line, the error line and one give-up line naming the class.
- `handleAttemptFailure` with a transient first-attempt error still logs the retry decision, and a split half's terminal failure still logs neither retry nor give-up.
- Covers AE4. The batch notice contains "after retrying" for a transient error and omits it for a `TypeError`.
- The failed-review message contains the file count and cause and not "No issues found".
- A details object using `errorName`, `stackHead`, `metering` and `frozen` survives `sanitizeDetails` without `[REDACTED]`.

**Verification:** the new helper tests pass and no existing test in these files changes.

### U3. Failed-review result and logging in the review handler

**Goal:** Wire the count-based failed result, the wording and the new log fields into `@bitbucket`.

**Requirements:** R4, R5, R6, R7, R8, R9, R10, R11 (AE2, AE3, AE4; KTD3, KTD4, KTD5).

**Dependencies:** U1, U2.

**Files:**

- Modify: `src/participant/BitbucketParticipant.ts`
- Modify: `src/participant/reviewSessionState.ts` (`ReviewTally` optional fields)
- Test: `src/test/bitbucketReviewFlow.test.ts`

**Approach:**

1. In the pass-1 loop, count the files of each successful batch and record the failed-file count and the first failure's cause. Have `runPersonaPassesForChunk` return its successful batch count and add it to the same tally.
2. After the chunk loop and before the smart-mode block, when nothing was reviewed: log the error-level failed line, stream the failed-review message, and return with no session, context key or chips (KTD5).
3. Replace the three per-batch failure strings and the partial banner with the U2 helpers. Leave the critic notice and the transient "empty response after retrying" message as they are; both already match their conditions.
4. Pass `describeErrorForLog` output into `logLmFailure` and the four outer catches (review aborted, smart resume, follow-up, refinement).
5. Add `metering` and `frozen` to the "Review started" and "model in use" details, from the meter's `metered` flag and `Object.isFrozen(request.model)`.
6. Carry the reviewed and failed counts into the completion line, and through `phase1Tally` as optional fields.

**Patterns to follow:** the outer catch's existing no-metadata return; `reviewDiagnostics.ts`'s injected-callback style.

**Harness changes:** let a turn freeze the model and its replies; capture output-channel lines instead of dropping them; record `executeCommand` calls so the walkthrough signal can be asserted.

**Test scenarios:**

- Covers AE1. A one-file PR with a frozen model and frozen replies completes with findings and a stored session.
- Covers AE2. A one-file PR whose model throws `TypeError` each call: one model call, "Review failed" with the cause, no "No issues found", no stored session, no follow-up or session metadata, no `firstReviewCompleted` command, and the log holds the give-up line and an error-level failed line.
- Covers AE2. A two-file PR with a transient error on every call (replaces the test at `bitbucketReviewFlow.test.ts:212`): four calls, "Review failed", no "No issues found", no partial banner.
- Smart mode with every batch failing: no persona-choice question, "Review failed".
- Covers AE3. Two chunks, one failing and one succeeding: the findings appear under the partial warning, the session is stored, and the completion log line carries both counts.
- Covers AE4. A one-file PR with a non-transient error omits "after retrying"; one with a transient error that exhausts its tries includes it.
- Deep mode where pass 1 fails everywhere but persona passes succeed: the result is partial, not failed.
- The smart-fallback resume test at `bitbucketReviewFlow.test.ts:610` still passes with the new banner wording in its assertion.
- "Review started" details include `metering` and `frozen`, and are not redacted.

**Verification:** the flow tests pass; the review no longer prints "No issues found." when no file was reviewed.

### U4. Documentation and the known-limitation entry

**Goal:** Keep developer docs, the user manual and the register in step with the behavior.

**Requirements:** R2, R4, R6, R8, R9, R10, R11 (KTD1–KTD6).

**Dependencies:** U1, U2, U3.

**Files:**

- Modify: `docs/review-process.md`
- Modify: `docs/manual/bitbucket-pr-review.md`
- Modify: `CLAUDE.md`
- Modify: `docs/known-limitations.md`

**Approach:**

- `docs/review-process.md` "Token usage": describe the empty-target proxy and the fail-open fallback instead of "wraps `request.model` … in a proxy that overrides only `sendRequest`". "Resilience & debugging": add the outcome table, amend the sentence saying `formatReview` and `ReviewSession` "always run … even after partial failures" so it excepts a review that reviewed nothing, and list the new log lines and fields in the diagnostic timeline.
- `docs/manual/bitbucket-pr-review.md`: say in "Token usage" that an answer ends without the Tokens line when metering cannot attach and the output channel says why; add a short note on the "Review failed" result versus the partial-results warning.
- `CLAUDE.md`: update the `tokenMeter.ts` and `reviewDiagnostics.ts` key-file rows.
- `docs/known-limitations.md`: add KL12 (Low): a response whose meter falls back to the raw model is not counted in usage and shows no footer.

**Test expectation:** none -- documentation only. `src/test/userDocsSync.test.ts` must stay green; no setting, command or tool changes.

**Verification:** the docs describe the shipped behavior, and a search of `docs/` finds no remaining "overrides only `sendRequest`" wording.

---

## Verification Contract

| Check | Command | Applies to |
| --- | --- | --- |
| Type check | `npm run compile` | every unit |
| Unit and flow tests | `npm test` | every unit |
| Targeted loop | `npx vitest run src/test/tokenMeter.test.ts src/test/reviewDiagnostics.test.ts src/test/bitbucketReviewFlow.test.ts` | U1–U3 |
| Real-host check (local, not in CI) | Run `@bitbucket <pr-url>` in VS Code with `showTokenUsage` on; read the `frozen` and `metering` fields in the "Ticket Sidekick" output | U1, U3 |

## Definition of Done

- All R-IDs are met and AE1–AE4 each have a passing test.
- `npm run compile` and `npm test` are green; `userDocsSync.test.ts` is unaffected.
- Dead-end or experimental code from rejected approaches (for example an `Object.create` attempt) is removed from the diff.
- The real-host check was run, or its absence is recorded for the maintainer.
- U4's docs match the code; `docs/known-limitations.md` has KL12.

---

## Risks and Notes

- **Host freezing is unconfirmed.** The fix does not depend on it: any non-configurable, non-writable property triggers the invariant. R11 records `frozen` so the first field report confirms or refutes it.
- **Empty-target proxy cannot be enumerated.** `Object.keys(model)` and spread would see nothing. No code in `src/` enumerates the model; the one `Object.entries` hit is unrelated usage-counter code.
- **Behavior change for an existing test.** `bitbucketReviewFlow.test.ts:212` currently asserts the partial banner and "No issues found" together for a run that reviewed nothing. U3 rewrites it; that is the behavior R4 removes.
- **Stored smart-fallback sessions.** They carry an older `ReviewTally`; KTD3 keeps the new fields optional.
- **Bake-off not run.** The mechanisms are internal and cheap to reverse, and Node probes already separated them.
- **Release.** Users on 0.6.14 are affected, so this ships as a patch; the release workflow generates the changelog entry.

## Sources and Research

- Meter and wrappers: `src/participant/bitbucket/tokenMeter.ts`; fixtures in `src/test/tokenMeter.test.ts`.
- Retry classification and the single-versus-multi-file difference: `src/utils/lmRetry.ts` (`isTransientLmError`, `withEasierRetry` captures a single item's error but rethrows a non-transient error for a batch of files).
- Failure and logging paths: `src/participant/BitbucketParticipant.ts` (`describeFailure`, `logLmFailure`, `runPersonaPassesForChunk`, `completeReview`, the pass-1 loop, the outer catches); `src/participant/bitbucket/reviewDiagnostics.ts` (`handleAttemptFailure`); `src/participant/reviewSessionState.ts` (`ReviewTally`, `formatRecoveryDecision`).
- Zero-findings output: `PrReviewService.formatReview` returns "No issues found." for an empty list.
- Harness: `src/test/bitbucketReviewFlow.test.ts` builds a plain mutable model per turn and drops output-channel lines.
- Redaction pitfall: `docs/solutions/logic-errors/redaction-substring-match-false-positives.md`; vscode mock convention: `docs/solutions/workflow-issues/vscode-mock-testing-convention-not-checked-before-inventing-new-one.md`.
- Node probes (this session): a frozen object under the current proxy throws for `sendRequest` and `countTokens`; `Object.create` shadowing throws on `#private` state; an empty-target proxy passes both.
