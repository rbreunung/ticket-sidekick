---
title: Bitbucket Token Usage - Plan
type: feat
date: 2026-10-01
topic: bitbucket-token-usage
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Bitbucket Token Usage - Plan

## Goal Capsule

- **Objective:** `@bitbucket` users see token consumption only when they ask for it, and can look up how many input and output tokens each model consumed over the last three months, accurately enough to compare against current API prices themselves.
- **Product authority:** The user (repository owner) decided every point below in the brainstorm dialogue. `@jira` and price calculation are not active scope.
- **Open blockers:** None.

## Product Contract

### Summary

The `~N estimated tokens` line under `@bitbucket` answers becomes an opt-in setting, default off. When on, it shows one line with input tokens, output tokens, and the model. Separately, every `@bitbucket` model call adds its tokens to a local per-month, per-model counter. `@bitbucket usage` shows the stored months as a table. Counters older than the current month plus the two before it are deleted. The extension contains no prices.

### Problem Frame

Today the token line appears under every review, follow-up answer, and comment refinement and cannot be turned off. It is a `chars/4` guess that merges input and output into one number, so it cannot be matched against API prices, which differ for input and output and per model. Nothing records usage over time, so a month of reviews cannot be totalled. The user wants a quiet default, trustworthy counts, and the data needed to do the price comparison themselves.

### Key Decisions

- **Tokens only, no prices.** Prices change and Copilot does not expose them; the table is the input to the user's own comparison. Governs R9.
- **Only input and output are tracked.** VS Code's model API exposes neither cache reads, cache writes, nor reasoning tokens. Governs R4, R6.
- **Counting is always on; only the footer is optional.** Otherwise `@bitbucket usage` would be empty for anyone who has not enabled the footer. Governs R5.
- **Counters are per model.** Price differs per model, so merged totals would be useless for comparison. Governs R5, R8.
- **Three-month retention, pruned on write.** Keeps the stored data small without a background job. Governs R7.
- **Footer format is a single line (session-settled: user-directed — chosen over a per-pass breakdown and a line with the monthly total: the user picked the minimal line).** Governs R3.
- **`@bitbucket usage` is a chat table (session-settled: user-directed — chosen over a short comparison and a Command Palette report: the user picked the per-model table).** Governs R8.

### Requirements

**Token footer**

- R1. A setting turns the token footer on or off; its default is off.
- R2. With the setting off, no token line appears under any `@bitbucket` answer (review, follow-up, comment refinement).
- R3. With the setting on, each such answer ends with one line: `_Tokens: <in> in · <out> out · <model> · budget <K>_`, with `budget` shown only where the previous line showed one.
- R4. The line's figures are totals across every model call made for that answer, with input and output reported separately. Figures come from the model's own token counter; when it is unavailable for a call, the old `chars/4` estimate is used for that call and the line marks the figures as estimated.

**Usage tracking**

- R5. Every `@bitbucket` model call adds its input and output tokens to a counter keyed by calendar month (local time) and model, whether or not the footer is on.
- R6. A counter stores only month, model identifier, input tokens, output tokens, call count, and an estimated-figures flag. No PR content, titles, URLs, or user text is stored.
- R7. When a counter is written, counters for months older than the current month and the two before it are deleted.
- R8. `@bitbucket usage` replies with a table of all stored months, one row per month and model: month, model, input, output, calls. Rows containing estimated figures are marked. With nothing stored, it says so instead of showing an empty table.
- R9. The extension holds no price data and shows no costs.

**Documentation**

- R10. User-visible changes (setting, `@bitbucket usage`, the footer wording) are reflected in the user manual and domain docs as the project's documentation rules require. All wording, setting descriptions, and docs are in English.

### Acceptance Examples

- AE1. **Covers R1, R2.** Given a fresh install, when a PR review completes, then no token line appears under the answer.
- AE2. **Covers R3, R4.** Given the footer is on and a review made calls totalling 41,230 input and 6,840 output tokens on one model, then the answer ends with `_Tokens: 41,230 in · 6,840 out · <model> · budget <K>_`.
- AE3. **Covers R4.** Given the token counter fails for one call, then that call is counted with the `chars/4` estimate and the footer marks the totals as estimated.
- AE4. **Covers R5.** Given the footer is off, when a follow-up answer is produced, then the current month's counter for that model still increases.
- AE5. **Covers R7.** Given counters exist for July, August, September, and October 2026, when October's counter is next written, then July's counter is deleted and the other three remain.
- AE6. **Covers R8.** Given two models were used in October and one in September, then `@bitbucket usage` shows three rows with input, output, and call counts. Given nothing is stored, it shows a short "no usage recorded" message.

### Scope Boundaries

**Deferred for later**

- Prices and cost calculation (live fetch, built-in table, or user-entered prices).
- Token footers or usage tracking for `@jira`.
- A Command Palette report, per-call-type breakdown, or CSV export.
- Syncing usage across machines.

**Outside this plan**

- Tracking cache reads, cache writes, or reasoning tokens (not exposed by the model API).
- Matching Copilot's real billing (flat rate or premium requests).

Key flows are omitted: the behavior is two independent one-step outputs (a footer line and a table), fully covered by the requirements and examples.

### Dependencies / Assumptions

- Assumes the model API's token counter is available for most calls; the estimate fallback (R4) covers the rest.
- Assumes one `@bitbucket` response may use several models only rarely; if it does, the footer lists the model that handled the most calls (planning may refine).

### Outstanding Questions

**Deferred to Planning**

- Setting key name and wording within the existing `ticketSidekick.bitbucket.*` group.
- Where counters are stored and how concurrent writes are kept consistent.
- How the footer picks the model when one response used several (see Assumptions).
- Whether `usage` needs a slash-command entry in `package.json`, which the README sync test checks.

### Sources / Research

- Token footer sites and heuristic: `src/participant/BitbucketParticipant.ts` (four `estimated tokens` call sites; `callLLM` near line 125 is the single `sendRequest` path for `@bitbucket`).
- Existing documentation of the footer: `docs/review-process.md` ("Token estimate"), `docs/manual/bitbucket-pr-review.md`, `docs/bitbucket-follow-up-improvements.md`.
- Settings docs sync: `docs/manual/settings-reference.md`, enforced by `src/test/userDocsSync.test.ts`.
