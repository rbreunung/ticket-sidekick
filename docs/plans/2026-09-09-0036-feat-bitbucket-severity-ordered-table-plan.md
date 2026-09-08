---
title: Bitbucket PR Review — Severity-Ordered Table Presentation - Plan
type: feat
date: 2026-09-09
topic: bitbucket-severity-ordered-table
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Bitbucket PR Review — Severity-Ordered Table Presentation - Plan

## Goal Capsule

- **Objective:** A user who runs `@bitbucket <pr-url>` sees the completed review's findings grouped into three severity tables — Critical, Warning, Suggestion — in that order, so a critical finding is never buried below lower-severity ones.
- **Means:** Reorganize the post-merge presentation of findings — grouping by severity, sorting each group by confidence descending, and tagging each finding with the persona pass(es) that produced it — without changing the LLM pipeline that produces findings.
- **Product authority:** User-directed — this conversation's brainstorm dialogue, including a display-only HTML prototype (`prototype/bitbucket-review-layouts.html`, Option B) iterated on directly against the finalized behavior, plus the merge-flow analysis that found why critical findings were being lost.
- **Open blockers:** None.

---

## Product Contract

### Summary

The completed Bitbucket PR review output is reorganized from a single file-grouped list (findings in discovery order within each file) into three separate severity-grouped tables — Critical, Warning, Suggestion — in that order, each sorted by confidence descending. The confidence fold that hides low-confidence findings is removed entirely; low-confidence findings are shown in their own severity tier with a muted (non-bold) confidence number. Each finding gains a "Source · Confidence" column that lists the persona pass(es) that produced it (comma-separated, or `general` for standard mode) and the highest confidence among those passes. The existing `#N`-to-explain and `(c)`-to-close interactions are preserved. The dedup step is strengthened so the same real issue found by multiple passes collapses to one finding with unioned sources and max confidence — a prerequisite for the Source column to be correct.

### Problem Frame

The review prompt tells the LLM to "output findings ordered by severity — critical first," but that instruction is discarded by the pipeline: `dedupeFindings` (`reviewSessionState.ts`) preserves first-occurrence order and never re-sorts, and `formatReview` (`PrReviewService.ts`) groups findings by file in discovery order. The net effect is that a critical finding discovered in a later chunk can appear below every warning and suggestion discovered earlier — the exact "confused" output the user reported.

Three independent causes combine:

1. **Ordering.** `dedupeFindings` preserves discovery order; `formatReview` groups by file. Severity order is never applied.
2. **Confidence fold.** `formatReview` folds any finding below `confidenceThreshold` (default 0.7) into a collapsed `<details>` section — which VS Code's chat renderer does not even collapse (it renders the literal tags), so a critical finding rated below 0.7 can vanish into inert literal HTML.
3. **Dedup collision.** `dedupeFindings` keys by `${file}::${line}::${title}`, so the same real issue found by phase 1 and a persona with *different* titles survives as two separate findings — and a downgraded re-report can outrank the critical original.

The user's chosen remedy addresses causes 1 and 2 directly (severity grouping + fold removal) and requires cause 3 to be tightened so the new "Source" column can correctly attribute a finding to the passes that produced it.

### Requirements

**Severity grouping**

- R1. The completed review output is organized into three separate tables — Critical, Warning, Suggestion — rendered in that order (Critical first), each headed by its tier name and a count of findings in it.
- R2. Within each severity table, findings are sorted by confidence descending (highest confidence first); ties break by the finding's original discovery order.
- R3. A finding's severity tier is determined by its `severity` field (`critical` / `warning` / `suggestion`), unchanged from today.

**Confidence fold removal**

- R4. No finding is hidden, collapsed, or moved into a separate low-confidence section based on its confidence. Every finding that survives the pipeline appears in exactly one severity table.
- R5. Low-confidence findings (below `confidenceThreshold`, default 0.7) are shown in their own severity tier with a muted confidence signal — the confidence number rendered without bold emphasis, not the current `<details>`/`<summary>` fold.
- R6. When no finding is below the threshold, the muted rendering is simply never applied — the output is identical to a review with all-high-confidence findings.

**Source · Confidence column**

- R7. Each finding row carries a "Source · Confidence" column.
- R8. The Source component lists the persona pass(es) that produced the finding, comma-separated and in a fixed persona order: security, performance, reliability, maintainability. A standard-mode finding with no persona pass reads `general`.
- R9. The Confidence component is the highest confidence among the passes that produced the finding; a single-pass finding shows that pass's confidence.
- R10. The Source and Confidence components are joined by a single middle-dot `·` with a space on each side (e.g. `security, reliability · 0.92`), matching the prototype's shorter dash rather than the wider ` · ` used elsewhere.

**Provenance**

- R11. The provenance marker keeps its current emoji — 🆕 new, 📍 existing, ➖ removed. The coral/red, purple, and pink coloring in the prototype is a display-only concern that does not survive chat, so the plan scopes provenance to the emoji label only.

**Existing interactions (preserved)**

- R12. Clicking a finding's `#N` heading still asks the same "explain this finding" question, resubmitting the exact text `parseFollowUpIntent`'s explain path already accepts.
- R13. The `(c)` close token still exits the review session unchanged.

**Dedup strengthening**

- R14. The dedup step collapses the same real issue found by multiple passes into a single finding: when two findings share a file and line but differ only in title, they are treated as the same issue and merged — their sources unioned and their confidence set to the highest — rather than surviving as two separate rows. (This is a strengthening of the current title-keyed dedup, required so R8/R9 are correct; see Key Decisions.)

**In-chat only**

- R15. The review output stays inside the chat panel — no browser window, no webview, no new registered command. (See Key Decisions for the file-link decision.)

### Key Decisions

- **Three severity tables over a single severity-sorted list.** The user asked for findings "ordered by severity" and picked the grouped-table presentation (Option B in the prototype) over a single table sorted by severity — strongest visual grouping, at the cost of fragmentation. Governs R1, R2, R3.
- **The confidence fold is removed, not fixed.** The user directed that the fold "does not work" and to "plan for removing it anyway"; VS Code's chat renderer does not execute raw HTML regardless. Governs R4, R5, R6.
- **"Source · Confidence" column format.** The Source component is the comma-separated persona ids that produced the finding (`general` for standard mode); the Confidence component is the highest among those passes; joined by a single `·` dash. Governs R7, R8, R9, R10.
- **Provenance is scoped to the emoji label.** The prototype's coral/red, purple, and pink coloring does not survive VS Code's chat renderer, which renders only GitHub-flavored markdown pipe tables with no inline colors or badges. Governs R11.
- **The dedup key is strengthened before the Source column is meaningful.** The current `${file}::${line}::${title}` key keeps same-issue re-reports with different titles as separate findings, which would let a downgraded report outrank the critical original and double-count a finding across the Source column. Governs R14.
- **File-path click-to-open is an open decision, deferred from this plan.** Clicking a file path to open it in the editor at the finding's line would require a new registered command (e.g. `ticketSidekick.bitbucket.openFinding`) carrying the file path and line, plus a trust-gated command-link in the table. This is a genuine enhancement but is not settled; the plan keeps the current plain-text file path. Governs the in-chat-only scope (R15) and the Summary's stated scope.

---

## Scope Boundaries

- **Untouched:** the LLM review pipeline that *produces* findings — `buildPrompt`/`buildPersonaPrompt`, `callLLMOnceWithProgress`, `parseReviewResponse`, `resolveFindingAnchors`, the batch/retry logic in `BitbucketParticipant.ts`, and the persona-pass aggregation. This plan only changes what happens to findings *after* `dedupeFindings` returns them.
- **Untouched:** the Jira participant, all Jira flows, Agent Mode tools (`contributes.languageModelTools`), and the Bitbucket comment-preview / post-as-comment flows (`formatPrComment`, `postFindingsAsComments`) — none of which go through `formatReview`'s table presentation.
- **Untouched:** the confidence *threshold* setting and its default (0.7). The threshold is repurposed from "fold below this" to "mute below this" — the value and its setting are unchanged.
- **New field on `ReviewFinding`:** a `sources?: PersonaId[]` array (or equivalent) tagging which persona pass(es) produced each finding, populated during the merge in `BitbucketParticipant.ts` and unioned on dedup. Pure — no `vscode` import, so `reviewSessionState.ts` stays Vitest-loadable.

## Acceptance Examples

- **R2 (ties).** Two findings in the Warning tier with confidence 0.80 and 0.80 render in their original discovery order; a 0.90 finding renders above both.
- **R5 (muted low-confidence).** A Critical finding rated 0.65 renders in the Critical table with its confidence shown non-bold; it is not moved to a separate section and the Critical table header still counts it.
- **R8 (`general`).** A standard-mode finding (no persona pass) shows `general · 0.88` in the Source · Confidence column.
- **R9 (max confidence).** A finding produced by a security pass at 0.92 and a reliability pass at 0.70 shows `security, reliability · 0.92`.
- **R14 (collapse).** Phase 1 reports `src/auth/login.ts:47` as "SQL injection in user lookup" (critical, 0.92) and the security persona reports the same line as "Unparameterized query in lookup" (critical, 0.88). They collapse to one finding with `security · 0.92`, not two rows.
- **R15 (in-chat only).** The review output contains no browser window, webview, or registered command; clicking a file path does nothing beyond the current plain-text behavior.
