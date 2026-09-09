---
title: Bitbucket PR Review — Severity-Ordered Table Presentation - Plan
type: feat
date: 2026-09-09
topic: bitbucket-severity-ordered-table
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
deepened: 2026-09-09
---

# Bitbucket PR Review — Severity-Ordered Table Presentation - Plan

## Goal Capsule

- **Objective:** A user who runs `@bitbucket <pr-url>` sees the completed review's findings grouped into three severity tables — Critical, Warning, Suggestion — in that order, so a critical finding is never buried below lower-severity ones.
- **Means:** Reorganize the post-merge presentation of findings — grouping by severity, sorting each group by confidence descending, and tagging each finding with the persona pass(es) that produced it — without changing the LLM pipeline that produces findings (KTD1).
- **Product authority:** User-directed — this conversation's brainstorm dialogue, including a display-only HTML prototype (`prototype/bitbucket-review-layouts.html`, Option B) iterated on directly against the finalized behavior, plus the merge-flow analysis that found why critical findings were being lost.
- **Execution profile:** Standard depth, code execution. Pure-logic changes in `reviewSessionState.ts` and `PrReviewService.ts` (Vitest-loadable), one tagging change in `BitbucketParticipant.ts`, and a doc sync in `docs/review-process.md`. No new dependencies, no schema or API surface change.
- **Stop conditions:** Stop if the dedup-key strengthening (R14) turns out to require an LLM-based meaning comparison beyond a pure-logic lexical heuristic — that would be a product-scope change, not an implementation detail. (Deepened 2026-09-09: this was raised explicitly — whether to add an LLM-based semantic-merge call mirroring ce-code-review's judgment layer — and user-directed as out of scope for this plan; KTD3's two-layer exact-match-then-lexical-heuristic gate is the pure-logic answer that stays inside this boundary.) Stop if `formatReview`'s return shape must change in a way that breaks the `findingHeadings` command-link contract (KTD3) without a clean migration path.
- **Open blockers:** None.

**Product Contract preservation:** unchanged — all R-IDs (R1–R15), Key Decisions, and Acceptance Examples carried forward verbatim from the requirements-only state; this enrichment adds only the Planning Contract, Implementation Units, Verification Contract, and Definition of Done.

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

- R1. The completed review output is organized into up to three separate tables — Critical, Warning, Suggestion — rendered in that order (Critical first), each headed by its tier name and a count of findings in it; a tier with zero findings is omitted entirely rather than rendered as a zero-count table (KTD1).
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
- R10. The Source and Confidence components are joined by a single middle-dot `·` with a space on each side (e.g. `security, reliability · 0.92`).

**Provenance**

- R11. The provenance marker keeps its current emoji — 🆕 new, 📍 existing, ➖ removed. The coral/red, purple, and pink coloring in the prototype is a display-only concern that does not survive chat, so the plan scopes provenance to the emoji label only.

**Existing interactions (preserved)**

- R12. Clicking a finding's `#N` heading still asks the same "explain this finding" question, resubmitting the exact text `parseFollowUpIntent`'s explain path already accepts.
- R13. The `(c)` close token still exits the review session unchanged.

**Dedup strengthening**

- R14. The dedup step collapses the same real issue found by multiple passes into a single finding: when two findings share a file and line, a quick lexical same-meaning check (title, and recommendation when present, via normalized Jaccard similarity) decides whether they are the same issue. If similar, they merge — sources unioned, confidence set to the highest — rather than surviving as two separate rows. If dissimilar (genuinely different titles and fix proposals on the same line), they stay as two rows. (This is a strengthening of the current title-keyed dedup, required so R8/R9 are correct; see Key Decisions.)

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
- **New field on `ReviewFinding`:** a `sources?: SourceTag[]` array (`SourceTag = PersonaId | 'general'`) tagging which pass(es) produced each finding — a real, stored `'general'` entry for standard-pass findings, not just a display fallback — populated when findings are collected in `BitbucketParticipant.ts` and unioned on dedup. Pure — no `vscode` import, so `reviewSessionState.ts` stays Vitest-loadable.

## Acceptance Examples

- **R2 (ties).** Two findings in the Warning tier with confidence 0.80 and 0.80 render in their original discovery order; a 0.90 finding renders above both.
- **R5 (muted low-confidence).** A Critical finding rated 0.65 renders in the Critical table with its confidence shown non-bold; it is not moved to a separate section and the Critical table header still counts it.
- **R8 (`general`).** A standard-mode finding (no persona pass) shows `general · 0.88` in the Source · Confidence column.
- **R9 (max confidence).** A finding produced by a security pass at 0.92 and a reliability pass at 0.70 shows `security, reliability · 0.92`.
- **R14 (collapse).** Phase 1 reports `src/auth/login.ts:47` as "SQL injection in user lookup" (critical, 0.92) and the security persona reports the same line as "Unparameterized query in lookup" (critical, 0.88). The titles are lexically similar enough to be the same issue, so they collapse to one finding with `security · 0.92`, not two rows.
- **R14 (separate).** Phase 1 reports `src/auth/login.ts:47` as "SQL injection in user lookup" (critical, 0.92) and the security persona reports the same line as "Missing rate-limit on password reset endpoint" (warning, 0.80). The titles and fix proposals are lexically dissimilar, so they stay as two separate rows.
- **R15 (in-chat only).** The review output contains no browser window, webview, or registered command; clicking a file path does nothing beyond the current plain-text behavior.

---

## Planning Contract

### Key Technical Decisions

KTD1. **Severity tables are GitHub-flavored markdown pipe tables rendered in chat.** Each tier is a `| File · Line | Provenance | Finding | Recommendation | Source · Confidence |` table, one row per finding, tiers ordered Critical → Warning → Suggestion (R1, R3). There is no separate `#` column — the finding number lives inside the Finding cell as the clickable `**#N** …` heading (KTD2), so a dedicated number column would duplicate it. VS Code's chat renderer executes only GFM pipe tables — no HTML, no inline color — so the prototype's colored badges do not survive (see Key Decisions: provenance scoped to emoji). Empty tiers are omitted entirely rather than rendered as a zero-count header.

KTD2. **The `#N` command-link contract is preserved by making each row's heading an exact substring of the table cell.** `composeReviewOutput` wraps each entry in `findingHeadings` via a plain string replace, so every heading must appear verbatim in the assembled markdown. Each finding's `#N` + title text is emitted as one contiguous run inside its Finding cell (e.g. `**#3** 🆕 SQL injection in user lookup`), and that exact substring is pushed to `findingHeadings`. No other cell may contain a `#<id>` token, so the replace cannot cross-match a different finding (R12).

KTD3. **The dedup key drops the title, but a same-meaning gate decides the merge.** `dedupeFindings` keys by `${file}::${line ?? ''}` instead of `${file}::${line}::${title}`. On a key collision it does not blindly merge — and it does not overwrite: the internal per-key store is a bucket (`Map<string, Array<Omit<ReviewFinding,'id'>>>`), not a single value, because a dissimilar collision must survive as its own entry rather than being discarded by whichever finding scanned second. An incoming finding is compared against each existing bucket member in turn through two layers, mirroring ce-code-review's own dedup split as closely as a pure-logic (no LLM call) implementation allows (session-settled: user-directed — chosen over a single fuzzy gate applied uniformly, and over adding an LLM-based semantic-judgment call to fully match ce-code-review's design, which was explicitly rejected as out of scope: it would add a model round-trip to the synchronous dedup path on every review and require moving this logic out of the `vscode`-free `reviewSessionState.ts`, an architecture change beyond what this plan's Stop Conditions allow):
  - **Exact-match fast path (mirrors ce-code-review's fingerprint layer).** If the two findings' normalized titles are identical, they merge unconditionally — no similarity math, no threshold. This is the deterministic-certainty case ce-code-review's exact fingerprint (file + line + normalized title) also treats as a guaranteed merge, and it fixes a gap the fuzzy gate alone would have: two reports with the *same* title but very different recommendations should still merge (an identical title is a stronger same-issue signal than any recommendation mismatch), whereas a single fuzzy gate could let a dissimilar recommendation veto it.
  - **Fuzzy gate (this plan's stand-in for ce-code-review's LLM judgment layer).** Only when titles are not already identical: compute a lexical similarity check comparing the two findings' titles and, when both have a `recommendation`, their recommendations too, combining the two per-field Jaccard scores as `min(titleSimilarity, recommendationSimilarity)` when both are present, else `titleSimilarity` alone — chosen over `average(title, recommendation)` because `min` is the one that actually delivers the stated "recommendation can pull a borderline pair below threshold" behavior and is the more conservative combinator, matching ce-code-review's "conservative merge, never lossy" principle: it never merges on a near-title-match alone when the recommendations clearly diverge.

When either layer's condition is met against a bucket member, the incoming finding merges into that member: `sources` unioned (KTD4 — every finding, standard-pass included, carries an explicit `sources` array, so this is always a real array union, never a display-time guess); `confidence` set to the max of the two, then bumped +0.05 (capped at 0.95) when the unioned `sources` set has 2+ distinct entries — independent corroboration across passes is itself evidence, mirroring ce-code-review's confidence promotion on multi-reviewer agreement (session-settled: user-directed — chosen over plain max(a,b), which under-weighted agreement between independently-focused passes: a security-persona finding at 0.60 merged with a standard-pass finding at 0.65 on the same issue is more trustworthy than either alone, not merely as trustworthy as the stronger one); severity taken from the stronger (existing `SEVERITY_RANK` rule); provenance taken by explicit precedence — 🆕 new > ➖ removed > 📍 existing — rather than first-encountered (session-settled: user-directed — chosen over "carry from first-encountered," which is scan-order-dependent and can silently downgrade a genuinely new issue to existing when the standard pass happens to be resolved before the persona pass that correctly flagged it as new; mirrors the existing severity-escalation rule, applied to the one other field where "more urgent wins" also holds); every remaining field carried from the first-encountered finding (R14). When the combined similarity is below the threshold against every existing bucket member — genuinely different titles and fix proposals on the same line — the incoming finding is appended to the bucket as its own entry, surviving as a separate row once buckets are flattened in first-occurrence order. This is the refinement over a pure title-drop key: it stops two distinct issues on one line from collapsing while still merging same-issue re-reports, and the bucket (rather than single-value) store is what actually makes "stay separate" achievable once the key no longer includes the title. The similarity check itself is a pure-logic lexical heuristic (Jaccard similarity on normalized word tokens), not an LLM call, so it stays fast and keeps `reviewSessionState.ts` Vitest-loadable. The threshold is the one knob: a low threshold merges aggressively (catches differently-worded same issues but risks over-merging distinct issues); a high threshold separates aggressively (catches distinct issues but lets differently-worded same issues survive as two rows). See Assumptions for the residual risk.

KTD4. **Every finding is tagged at the merge site, not in the LLM response — standard-pass findings included.** `runPersonaPassesForChunk` returns untagged findings today (the model output has no persona field). The tagging happens where each pass's findings are concatenated into `allFindings`: every finding from a given persona pass is stamped with that persona's id in `sources`, and every standard-pass (phase 1) finding is stamped with `sources: ['general']` (session-settled: user-directed — chosen over leaving standard-pass findings with an absent `sources` field and rendering `general` only as a display-time fallback, which made `'general'` impossible to count as a real member of the corroboration-bump's sources union in KTD3 — `'general'` is a `SourceTag`, not just a rendering string, and stamping it explicitly at the one seam where pass identity is known removes the ambiguity). This keeps the LLM pipeline untouched (Scope Boundaries) and means the tag is set exactly once. `formatSourceConfidence`'s absent-field fallback to `general` remains solely for pre-existing session state saved before this change (System-Wide Impact).

KTD5. **The confidence threshold is repurposed from "fold" to "mute."** `formatReview` no longer splits findings into primary/low; every finding lands in its severity table (R4). The threshold's only remaining job is to decide whether a row's confidence cell is muted (non-bold) when below it (R5, R6). The setting and its default (0.7) are unchanged.

KTD6. **The findings funnel drops the `foldedByConfidence` stage.** With no fold, nothing is "folded by confidence," so that stage is removed from `FindingsFunnelCounts`, `formatFindingsFunnel`, and the reconciliation invariant (`raw = dedupedCrossBatch + droppedByAnchor + (droppedByCritic ?? 0) + final`). `final` becomes the total finding count shown. This keeps the funnel honest — a stage that always reports 0 would mislead a debugger reading the Output Channel.

KTD7. **Persona order reuses `ALL_PERSONA_IDS`; `general` sorts last.** The fixed Source ordering (security, performance, reliability, maintainability) is exactly the existing `ALL_PERSONA_IDS` constant in `reviewSessionState.ts`, so no new ordering list is introduced and the circular-dependency workaround that already keeps that module Vitest-loadable is preserved (R8). When a merged finding's `sources` contains both real persona ids and `'general'` (e.g. a security-persona finding merged with a standard-pass finding, KTD3), `'general'` renders after every persona id regardless of array order — it is the catch-all tag, never a peer to rank among the four named lenses.

KTD8. **`formatReview`'s return shape stays stable; `lowCount` becomes always-zero.** The method still returns `{ markdown, primaryCount, lowCount, findingHeadings }`. `primaryCount` now means "total findings shown" (all of them) and `lowCount` is always `0`, so the two existing call sites in `BitbucketParticipant.ts` and the funnel wiring compile unchanged. This avoids a signature change rippling through the participant; see U4 for the exact semantics.

### Assumptions

- **The same-meaning gate is a heuristic, not a perfect discriminator.** KTD3's lexical check catches same-issue re-reports that are worded differently, but it cannot read intent — a low threshold over-merges distinct issues, a high threshold lets differently-worded same issues survive as two rows. The plan picks a single fixed threshold as a reasonable default and treats the residual over/under-merge risk as acceptable because same-line distinct issues are rare; if real reviews surface frequent same-line distinct issues, that is a product-scope change to revisit, not an implementation detail.
- **The display-only prototype is not committed.** `prototype/bitbucket-review-layouts.html` referenced in the Goal Capsule was a brainstorm working artifact and is not in the repo; the plan treats it as product authority only, not a file to read or diff against.
- **Confidence values are present on most findings.** The model is prompted to emit `confidence`, but a finding may omit it. Muted rendering (R5) applies only when a numeric confidence below the threshold exists; an absent confidence renders as a plain number with no mute and sorts last within its tier (treated as lowest).

### Sequencing

U1 (type + source formatter) is the foundation — U2, U3, and U4 all depend on it. U2 (dedup merge) and U3 (persona tagging) are independent of each other once U1 lands. U4 (formatReview rewrite) depends on U1 and U2. U5 (funnel + doc sync) depends on U4 because it removes the fold stage that U4 eliminates.

### System-Wide Impact

- **Diagnostic funnel.** The Output Channel's findings-funnel line loses one stage (`foldedByConfidence`). Anyone reading historical run records will see a different shape; the opt-in structured run record inherits the change automatically since it embeds the funnel summary.
- **Session state shape.** `ReviewFinding` gains an optional `sources` field. Existing `workspaceState` sessions stored before this change simply lack the field entirely and render as `general` via `formatSourceConfidence`'s absent-field fallback — no migration needed, since new findings always populate the field explicitly (real persona ids, or `['general']` for standard-pass) while the fallback covers only pre-existing sessions.
- **No API, schema, or settings change.** The Bitbucket/Jira clients, `package.json` contributes, and all settings keys are untouched.

---

## Implementation Units

### U1. Add `sources` to `ReviewFinding` and a pure Source · Confidence formatter

- **Goal:** Give findings a way to record which persona pass(es) produced them, and provide the single pure function that renders the "Source · Confidence" cell so every call site formats it identically.
- **Requirements:** R7, R8, R9, R10.
- **Dependencies:** none.
- **Files:** `src/participant/reviewSessionState.ts`, `src/test/PrReviewService.test.ts`.
- **Approach:**
  1. Add a `SourceTag = PersonaId | 'general'` type alias and an optional `sources?: SourceTag[]` field to the `ReviewFinding` interface in `reviewSessionState.ts`, documented as "pass(es) that produced this finding — real persona ids and/or the literal `'general'` tag for the standard pass; absent only on pre-existing session state saved before this field existed (KTD4)."
  2. Add a pure exported helper, e.g. `formatSourceConfidence(finding, threshold?)`, that returns the cell string: the Source component (comma-joined `sources`, real persona ids in `ALL_PERSONA_IDS` order first, then `general` last when present, KTD7 — or the literal `general` when the field is absent entirely, covering pre-existing session state) joined to the Confidence component by ` · ` (R10). The Confidence component is the finding's own `confidence` (already the max-plus-bump after U2's merge), rendered as a decimal. Its emphasis encodes confidence against the threshold: at or above `threshold` it is bold (`**0.92**`); below `threshold` it is plain/muted (`0.65`) — this is R5's "muted" signal; an absent confidence renders plain with no emphasis.
  3. Keep the helper free of any `vscode` import so the module stays Vitest-loadable.
- **Patterns to follow:** The existing `ALL_PERSONA_IDS` constant and its circular-dependency doc comment; the `severityIcon`/`provenanceIcon` local helpers in `formatReview` for the "small pure formatter" idiom.
- **Test scenarios:**
  - A finding with `sources: ['security','reliability']` and confidence 0.92 (threshold 0.7) renders `security, reliability · **0.92**`.
  - A finding with `sources: ['general']` (standard mode, U3's explicit stamp) renders `general · <confidence>`.
  - A finding with the `sources` field entirely absent (pre-existing session state, KTD4) also renders `general · <confidence>` via the fallback.
  - A finding with `sources: ['security', 'general']` (a merged security-persona + standard-pass finding, KTD3) renders `security, general · <confidence>` — `general` last regardless of array order.
  - Persona ids are emitted in `ALL_PERSONA_IDS` order regardless of input order (e.g. input `[reliability, security]` → `security, reliability`).
  - A confidence at or above the threshold is bold; below it is plain (muted); an absent confidence is plain with no emphasis.
- **Verification:** The helper is exported and unit-tested in isolation; `reviewSessionState.ts` still imports no `vscode`.

### U2. Strengthen `dedupeFindings` to merge same-file/same-line findings

- **Goal:** Collapse the same real issue found by multiple passes into one finding with unioned sources and max confidence, so the Source column is correct.
- **Requirements:** R14.
- **Dependencies:** U1.
- **Files:** `src/participant/reviewSessionState.ts`, `src/test/PrReviewService.test.ts`.
- **Approach:**
  1. Change the dedup key from `${file}::${line ?? ''}::${title}` to `${file}::${line ?? ''}` (KTD3), and change the internal per-key store from a single value to a bucket — `Map<string, Array<Omit<ReviewFinding,'id'>>>` — so a dissimilar collision can be appended as its own entry instead of overwriting the existing one (KTD3; without this, the "stay separate" acceptance example is unimplementable, since a single-value map always discards whichever finding loses the `stronger` comparison).
  2. For each incoming finding, compare it against every existing member of its key's bucket in turn, through the two-layer gate (KTD3): if the normalized titles are identical, merge unconditionally (exact-match fast path — no similarity math needed). Otherwise compute the fuzzy same-meaning gate — `min(titleJaccard, recommendationJaccard)` when both findings have a `recommendation`, else `titleJaccard` alone — against each member. Merge into the first bucket member that either layer accepts; if no member matches, append the incoming finding to the bucket as a new entry.
  3. On a merge, union the two `sources` arrays (deduplicated — always a real array union, since every finding carries an explicit `sources` array per KTD4, including `['general']` for standard-pass findings), set `confidence` to the max of the two then add a +0.05 corroboration bump (capped at 0.95) when the unioned `sources` set has 2+ distinct entries (KTD3), and take severity from the stronger via the existing `SEVERITY_RANK` comparison. Resolve `provenance` by a fixed `PROVENANCE_RANK`-style precedence — 🆕 new > ➖ removed > 📍 existing — rather than first-encountered (KTD3). Carry every other field (`title`, `description`, `recommendation`, `relatedLines`, `diffHunk`) from the first-encountered finding.
  4. Flatten each key's bucket into the output in first-occurrence order, and preserve first-occurrence order across keys (the existing `order` array) so discovery-order tie-breaking for R2 is intact.
- **Patterns to follow:** The current `dedupeFindings` body and its `stronger` comparator, adapted from a single-value `byKey` map to the bucket shape above; keep the function's outer signature (`Array<Omit<ReviewFinding,'id'>>`) unchanged. The similarity helper is a small pure function (tokenize → lowercase → set → Jaccard) with no `vscode` import.
- **Test scenarios:**
  - Two findings on the same file+line with *identical* titles but a very different recommendation still merge (exact-match fast path fires regardless of recommendation similarity).
  - Two findings on the same file+line with *similar but not identical* titles collapse to one (the R14 acceptance example: critical 0.92 + critical 0.88 → one finding, confidence 0.92, via the fuzzy gate).
  - Two findings on the same file+line with *dissimilar* titles and fix proposals stay as two separate rows (verifies the bucket-append path, not just the merge path).
  - Three findings on the same file+line, where the first two are similar to each other and the third is dissimilar to both, yield two output rows: the first two merged, the third standing alone in the bucket.
  - The merged finding's `sources` is the union of both inputs' sources.
  - When severities disagree, the stronger severity wins (existing behavior retained).
  - Two findings on the same file but different lines stay separate.
  - Two findings on different files at the same line stay separate.
  - A finding with `sources: ['general']` merged with one that has `sources: ['security']` yields `['security', 'general']`.
  - A finding whose title is similar but whose recommendation is clearly different is kept separate — `min(titleJaccard, recommendationJaccard)` is pulled below threshold by the low recommendation score even though title similarity alone would have cleared it.
  - Merging a finding with `sources: ['security']` at 0.60 into one with `sources: ['general']` at 0.65 yields confidence 0.70 (max 0.65 + 0.05 bump, since the union `['security','general']` has 2 distinct entries).
  - Merging two findings that both carry the same single source (e.g. both `['general']`, or both `['security']`) applies no bump — the union has only 1 distinct entry.
  - A merge where the combined confidence would exceed 0.95 after the bump is capped at 0.95.
  - Merging a 📍 existing finding (first-encountered) with a 🆕 new finding on the same file+line yields provenance 🆕, not 📍 (precedence, not discovery order).
  - Merging a ➖ removed finding with a 📍 existing finding yields ➖ (precedence order: 🆕 > ➖ > 📍).
- **Verification:** The existing `dedupeFindings` test block is updated so the "keeps distinct titles on the same line separate" case now runs through the bucket-append path and asserts two output rows for dissimilar titles, one merged row for similar ones.

### U3. Tag every finding with its source(s) at the merge site

- **Goal:** Stamp each persona pass's findings with that persona's id, and every standard-pass finding with the literal `'general'` tag, so the Source column and KTD3's corroboration bump can both rely on `sources` always being a real, populated array.
- **Requirements:** R8.
- **Dependencies:** U1.
- **Files:** `src/participant/BitbucketParticipant.ts`.
- **Approach:**
  1. In `runPersonaPassesForChunk`, after each persona's findings are resolved, stamp every finding with `sources: [persona.id]` before returning (KTD4). This is the single seam where pass identity is known.
  2. Stamp every standard-pass (phase 1) finding with `sources: ['general']` at the same seam — they no longer flow through untagged (KTD4). `'general'` is a `SourceTag`, not just a rendering fallback, so it must be a real stored value here for KTD3's merge-time sources union to work.
  3. Confirm the smart-fallback resume path (`resumeSmartReviewPhase2`) tags its persona and standard-pass findings the same way, since it calls the same helper.
- **Patterns to follow:** The existing per-persona loop in `runPersonaPassesForChunk`; the `Omit<ReviewFinding,'id'>` shape already used for unnumbered findings.
- **Test scenarios:**
  - Test expectation: none — this unit is VS Code-dependent glue (the participant imports `vscode`) and is covered by the e2e suite, not Vitest. The pure behavior it depends on (tagging a finding's `sources`, including the standard-pass `'general'` stamp) is exercised indirectly through U1/U2/U4's tests using hand-built findings.
- **Verification:** `npm run compile` passes; the persona loop stamps `sources` without altering any other field; standard-pass findings enter `allFindings` already carrying `sources: ['general']`.

### U4. Rewrite `formatReview` to render three severity tables with muted low-confidence

- **Goal:** Replace the file-grouped list + confidence fold with three severity-ordered pipe tables, each sorted by confidence descending, carrying the Source · Confidence column and preserving the `#N` command-link contract.
- **Requirements:** R1, R2, R3, R4, R5, R6, R7, R10, R11, R12.
- **Dependencies:** U1, U2.
- **Files:** `src/services/PrReviewService.ts`, `src/test/PrReviewService.test.ts`.
- **Approach:**
  1. Remove the primary/low split and the low-confidence fold block entirely (KTD5). Every finding is rendered.
  2. Group findings by `severity` into three buckets in fixed order Critical → Warning → Suggestion; omit any empty bucket (KTD1).
  3. Within each bucket, sort by confidence descending, treating an absent confidence as lowest, and break ties by original array order (stable sort) (R2).
  4. Before assembling any cell, run title/description/recommendation text through a pipe/newline-safe sanitizer (escape or replace `|`, collapse embedded newlines to spaces) mirroring `reportImport.ts`'s existing `sanitizeCellText()` pattern (feasibility finding: LLM-generated cell text routinely contains code/SQL/shell fragments, and a bare `|` splits a GFM row into extra columns while a newline breaks it entirely — `neutralizeMarkdownLinks` alone does not cover this). Apply the sanitizer before building the `#N` heading run too, so the heading pushed to `findingHeadings` (KTD2) is byte-identical to what's rendered in the cell — sanitizing after computing the heading would break KTD2's exact-substring contract.
  5. Render each bucket as a GFM pipe table headed by the tier name and its count (e.g. `### 🔴 Critical (2)`), with columns `File · Line | Provenance | Finding | Recommendation | Source · Confidence` — no separate number column, since the number lives in the Finding cell (KTD1). The Finding cell holds the contiguous `**#N** <provenance-emoji> <title>` run (title already sanitized per step 4) that is pushed to `findingHeadings` (KTD2). The Source · Confidence cell uses U1's `formatSourceConfidence`, so high-confidence values render bold and low-confidence values plain (R5, R6).
  6. Keep the existing header (PR title/author/branch/file count) and the trailing follow-up/exit line unchanged; keep `neutralizeMarkdownLinks` applied to every untrusted string (title, file, PR title/author) in addition to the new cell sanitizer — the two guard different characters and both are needed.
  7. Return `{ markdown, primaryCount: findings.length, lowCount: 0, findingHeadings }` (KTD8).
- **Patterns to follow:** The current `formatReview` header assembly and its `neutralizeMarkdownLinks` usage; `reportImport.ts`'s `sanitizeCellText()` for the new pipe/newline guard; the existing `findingHeadings` push pattern so `composeReviewOutput` keeps working.
- **Test scenarios:**
  - Findings of mixed severity render in three tables ordered Critical, Warning, Suggestion, each headed with its count (Covers R1).
  - Within a tier, higher confidence renders above lower; equal confidence preserves input order (Covers R2 / AE ties).
  - A low-confidence critical finding appears in the Critical table with a plain (non-bold) confidence cell and is counted in the header — not moved to a separate section (Covers R5 / AE).
  - When no finding is below threshold, every confidence cell is bold — no plain/muted value appears anywhere (Covers R6).
  - A standard-mode finding's Source · Confidence cell reads `general · <confidence>` (Covers R8 / AE).
  - A multi-source finding reads `security, reliability · 0.92` (Covers R9 / AE).
  - Each finding's `#N` heading is an exact substring of the returned markdown and present in `findingHeadings`, so `composeReviewOutput` can wrap it (Covers R12).
  - A finding whose title contains a literal `|` character renders without corrupting the table's column count, and its sanitized heading is still an exact substring pushed to `findingHeadings`.
  - A finding whose recommendation contains an embedded newline renders as a single table row, not a broken one.
  - Provenance emoji (🆕/📍/➖) still render on the relevant rows (Covers R11).
  - An empty findings array renders the no-issues message and returns zero counts.
  - `primaryCount` equals the total finding count and `lowCount` is always 0.
- **Verification:** The existing `formatReview` test block is rewritten to assert table structure, tier order, sort order, mute behavior, and the Source · Confidence cell; `composeReviewOutput` still wraps every heading.

### U5. Update the findings funnel and sync `docs/review-process.md`

- **Goal:** Remove the now-defunct `foldedByConfidence` stage from the diagnostic funnel and update the review-process doc so it matches the new presentation.
- **Requirements:** R4 (fold removal is what makes the stage defunct).
- **Dependencies:** U4.
- **Files:** `src/participant/reviewSessionState.ts`, `src/participant/BitbucketParticipant.ts`, `src/test/PrReviewService.test.ts`, `src/test/logRedaction.test.ts`, `docs/review-process.md`.
- **Approach:**
  1. Remove `foldedByConfidence` from the `FindingsFunnelCounts` interface and from `formatFindingsFunnel`'s output lines (KTD6).
  2. Update the reconciliation doc comment to `raw = dedupedCrossBatch + droppedByAnchor + (droppedByCritic ?? 0) + final`.
  3. In `BitbucketParticipant.ts`, drop `foldedByConfidence: lowCount` from the funnel counts object and set `final` to the total finding count (`primaryCount`).
  4. Update `docs/review-process.md`: the pipeline diagram's `formatReview` node (now "three severity tables, muted low-confidence"), the stage table's confidence row (fold → mute), the funnel description, and the settings table's `confidenceThreshold` note ("below → muted, not folded").
  5. Update any test that asserts on the funnel shape or the `foldedByConfidence` field.
- **Patterns to follow:** The existing `formatFindingsFunnel` and its reconciliation test; the doc's stage table and mermaid pipeline diagram.
- **Test scenarios:**
  - The funnel summary no longer contains a "folded by confidence" line and still reconciles raw against the remaining stages plus final.
  - The critic line is still omitted outside deep mode (existing behavior retained).
  - `logRedaction.test.ts`'s funnel fixture compiles and passes after the field is removed.
- **Verification:** `npm run compile` passes with no references to `foldedByConfidence`; `docs/review-process.md` describes the three-table presentation and the mute (not fold) behavior.

---

## Verification Contract

| Gate | Command | Proves |
| --- | --- | --- |
| Type check | `npm run compile` | No TypeScript errors after the `ReviewFinding.sources`, dedup, formatReview, and funnel changes; no dangling `foldedByConfidence` references. |
| Unit tests | `npm test` | All Vitest suites green — especially the rewritten `formatReview` block, the updated `dedupeFindings` block, the new `formatSourceConfidence` cases, and the funnel reconciliation tests. |
| E2E (manual) | `npm run test:e2e` | The participant-level tagging (U3) and end-to-end table rendering in a real VS Code instance; not run in CI. |

Run `npm run compile` before `npm test`. `npm test` must be green before commit. Node is managed by Volta — use `~/.volta/bin/npm` if `npm` is not on PATH.

---

## Definition of Done

- **Global:**
  - `npm run compile` and `npm test` are both green.
  - A completed `@bitbucket <pr-url>` review renders its non-empty severity tables (Critical, Warning, Suggestion, empty tiers omitted) in that order, each sorted by confidence descending, with a Source · Confidence column on every row.
  - No table row is corrupted by a literal `|` or embedded newline in an LLM-generated title/description/recommendation — cell text is sanitized before assembly (U4).
  - No finding is hidden or folded; low-confidence findings appear in their tier with a muted confidence cell.
  - The `#N` explain and `(c)` close interactions still work (verified via the e2e suite or manual run).
  - `docs/review-process.md` matches the new presentation and funnel shape.
  - No abandoned-attempt code remains in the diff (e.g. no leftover primary/low split, no dead `foldedByConfidence` references).
- **Per unit:**
  - U1: `SourceTag`/`sources` field present; `formatSourceConfidence` exported and unit-tested, including the absent-field legacy fallback and the persona-then-`general` ordering; module still `vscode`-free.
  - U2: dedup uses a per-key bucket (not a single value) so dissimilar same-line findings survive as separate rows; the two-layer same-meaning gate (exact-title fast path, then `min(titleJaccard, recommendationJaccard)` for near-misses) decides merges; merged findings carry unioned sources, max-confidence-plus-corroboration-bump (capped 0.95), and precedence-resolved provenance (🆕 > ➖ > 📍); the "distinct titles on same line" test now runs through the bucket-append path.
  - U3: persona-pass findings carry `sources: [persona.id]`; standard-pass findings carry `sources: ['general']` explicitly (not untagged); compiles clean.
  - U4: non-empty severity tables render in order with correct sort, mute, and Source · Confidence cells; cell text is pipe/newline-sanitized before assembly; `findingHeadings` remain exact substrings of the sanitized output; `lowCount` is always 0.
  - U5: funnel has no `foldedByConfidence` stage and reconciles; doc updated; all funnel tests pass.
