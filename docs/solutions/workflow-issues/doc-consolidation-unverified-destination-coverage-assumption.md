---
title: Documentation consolidation deleted CLAUDE.md facts assuming a comprehensive destination doc already had them
date: 2026-08-21
category: workflow-issues
module: documentation/CLAUDE.md-consolidation
problem_type: workflow_issue
component: documentation
applies_when:
  - Consolidating, splitting, or trimming documentation on the assumption that a destination doc "already covers" the content being removed
  - Trimming a CLAUDE.md/README section down to a pointer/link into an existing satellite doc instead of repeating the content
  - Merging two docs that describe "the same pipeline/feature" from different angles or at different levels of detail
  - A destination doc looks comprehensive (has diagrams, detailed prose) and that appearance is used as justification for not checking it fact-by-fact
symptoms:
  - Plan/implementation deletes a CLAUDE.md section and replaces it with a link to docs/review-process.md, reasoning that the target doc already covers the same pipeline
  - "An automated code review (ce-code-review, coherence + feasibility personas) grepped the destination doc for each specific fact named in the deleted section and found zero hits for several of them"
  - "Concrete facts present only in the deleted CLAUDE.md text and absent from the seemingly-comprehensive destination doc: the token-estimate footer formula, the reviewExcludePatterns/minimatch matchBase mechanism, the buildAdaptiveChunks chunk-packing formula, the token-budget fallback chain, the +++ /dev/null deletion-diff handling, and the follow-up turn error/cancellation message contracts"
root_cause: missing_workflow_step
resolution_type: documentation_update
severity: medium
related_components: [CLAUDE.md, docs/review-process.md, ce-code-review]
tags: [documentation-consolidation, claude-md, doc-splitting, fact-verification, code-review, assumption-verification, review-process, docs-trim]
---

# Documentation consolidation deleted CLAUDE.md facts assuming a comprehensive destination doc already had them

## Context

This repo's `CLAUDE.md` went through a large restructuring: several sections were split out into new satellite docs (`docs/jira-flows.md`, `docs/report-import.md`), and the existing "PR review flow (Bitbucket)" section — a long, detailed walkthrough of the diff-intake/chunking/prompting/follow-up pipeline — was trimmed down to a short summary plus a link into `docs/review-process.md`, a doc that already existed and already looked comprehensive: detailed mermaid diagrams, a dedicated "Follow-ups" section, a "Modes" table, an "Upfront question" subsection, all covering the same PR-review pipeline.

The plan treated deleting the CLAUDE.md content and replacing it with a link as pure de-duplication — removing a second copy of information that `docs/review-process.md` already fully contained. That assumption was never checked fact-by-fact; it was accepted because the destination doc covered the same general topic and looked thorough. It was wrong. Several specific facts existed only in the CLAUDE.md prose and had no counterpart anywhere in `docs/review-process.md`:

- The token-estimate footer's exact formula and format: `_~N estimated tokens · budget K_`, computed as `Math.ceil((totalInputChars + totalOutputChars) / 4)` summed across all LLM calls in the response (`src/participant/BitbucketParticipant.ts:834-835`).
- `reviewExcludePatterns` matching mechanism: glob via `minimatch` with `matchBase: true` (`src/participant/BitbucketParticipant.ts:611`).
- The `buildAdaptiveChunks` chunk-packing cost formula — `1500 + 50×files + ceil(diff.length/4)` tokens (`CHUNK_FIXED_OVERHEAD = 1500` / `CHUNK_FILE_OVERHEAD = 50` in `src/participant/reviewSessionState.ts:599-600`) — with the per-file-budget-exceeded / `@@`-hunk-splitting fallback.
- The token-budget resolution order: `modelContextTokens` setting → `request.model.maxInputTokens` (VS Code LM API) → `60000` fallback, multiplied by `contextBudgetRatio`.
- Deletion-diff handling: a `+++ /dev/null` header keeps the source path and sets `deleted: true` so removed code is still reviewed (`src/participant/reviewSessionState.ts:163-165`).
- Follow-up turn message contracts, verbatim: an unresolvable `#N` reply → `` _Finding #N not found. The review has findings #1–#M._ `` (`BitbucketParticipant.ts:452`); cancellation → `` _Review session ended._ `` (`BitbucketParticipant.ts:406`); an LLM error on a follow-up → `**Follow-up failed:**` (`BitbucketParticipant.ts:507`); a comment-preview refinement error → `**Refinement failed:**` (`BitbucketParticipant.ts:393`).

This was caught before merge, not after, by a `ce-code-review` pass (coherence + feasibility personas, `mode:agent`) run as part of the shipping workflow. Its method was concrete rather than impressionistic: it grepped `docs/review-process.md` for each specific fact/term from the CLAUDE.md section being deleted — `"estimated token"`, `"matchBase"`, `"1500 + 50"`, `"60 000"`, `"dev/null"`, `"Finding #N"` — and got zero hits for all of them. It then named the exact failure mode this produces: a future contributor changing one of these facts (say, the token-estimate formula) would check `docs/review-process.md`, which explicitly says "keep this document in sync," to see whether the doc needed updating — and would find nothing describing the fact at all, because it was never there. The doc would drift silently, with no signal that it had ever gone stale, because it never claimed to cover the thing that changed.

## Guidance

When consolidating or deleting documentation on the assumption "the destination already covers this," treat that as a **hypothesis to verify per-fact**, not an assumption to accept because the destination doc covers the same general topic or looks comprehensive. A doc that has detailed diagrams, dedicated sections, and a "keep this in sync" note is evidence the author cared about it — it is not evidence of fact-level parity with a different doc that grew independently over time.

The concrete check: for each specific, checkable fact in the section being deleted — an exact formula, a constant, a fallback chain, a literal message string, a mechanism name (a library option like `matchBase: true`) — grep the destination doc for that fact before deleting the source. Zero hits means the fact is about to become unreachable, not deduplicated. A hit means it's safe to delete the source copy.

A code-review pass before merging a documentation-consolidation change is one concrete, repeatable way to catch this class of loss systematically, because it applies the per-fact grep discipline mechanically instead of relying on a human or self read-through of a large diff — which is easy to rubber-stamp on "this all sounds duplicated" when skimming two docs about the same pipeline. In this session, the fix was to independently re-verify every flagged fact against source (not against the reviewer's claim, and not against conversation memory) — e.g. `grep -n "estimated tokens"` / `"totalInputChars"` in `src/participant/BitbucketParticipant.ts`, confirming line 835's exact template string and the `Math.ceil((totalInputChars + totalOutputChars) / 4)` computation — and only then relocate the verified facts into `docs/review-process.md` (a new "Diff intake and chunk budgeting" section, a new "Token estimate" section, and additions to "Follow-ups") *before* trimming the CLAUDE.md section down to a link, so nothing became unreachable at any point in the sequence. This shipped as PR #35 (branch `docs/claude-md-knowledge-restructure`), merged to `main` at commit `42d3ea4`.

## Why This Matters

A comprehensive-looking destination doc is not proof of fact-level coverage. Two docs describing "the same pipeline" can each independently accumulate unique details the other never picked up — one doc might carry the narrative flow and diagrams, the other the exact formula and exact message strings — simply because they were written or extended at different times by different passes of work, with no mechanical process forcing them to converge. Deleting one copy on the assumption that the survivor already has everything silently drops whatever the deleted copy uniquely held.

The loss is worse than ordinary information loss because it's **unrecoverable except by re-deriving from source** — grepping the codebase, reading the implementation, reconstructing the exact formula or message string by hand. Almost no future reader will do that; the entire point of writing the fact down in a doc in the first place was to save exactly that re-derivation. A silently-dropped fact doesn't announce itself as missing — the destination doc still reads as complete, still has a "keep this in sync" note, and gives no signal that anything is absent until someone needs the specific fact and can't find it.

## When to Apply

- Any documentation split, merge, consolidation, or trim where content is deleted from one location and replaced with a pointer to another doc.
- Especially when the deleted section and the destination doc both grew detailed content independently over time, so they were never mechanically kept in sync with each other — this is exactly the shape that produces silent asymmetric coverage, each doc accreting its own specifics under its own pressures.
- Especially when the destination doc *looks* authoritative or comprehensive (diagrams, dedicated sub-sections, an explicit "keep this in sync" instruction) — that appearance is precisely what makes it easy to skip the per-fact check.
- Especially when the content being deleted includes concrete, checkable specifics: exact formulas, numeric constants, fallback/resolution chains, literal error or UI message strings, named library options/mechanisms — the kind of fact a grep can directly confirm present or absent, as opposed to a general narrative description that either doc could phrase differently while still "covering" the same ground.
- One level up, to planning documents themselves: any claim in a plan or summary that enumerates or counts something (a list of settings-key prefixes, a row count for a table being moved) should be verified against the actual source rather than trusted as arithmetic the plan author already got right.

## Examples

**What was almost lost** (each below existed only in the CLAUDE.md prose slated for deletion, with zero matches in `docs/review-process.md` at the time of the reviewer's grep pass):

- The token-estimate footer's exact template and formula: `` `_~${reviewTokenEst.toLocaleString()} estimated tokens · budget ${tokenBudget.toLocaleString()}_` ``, using `Math.ceil((totalInputChars + totalOutputChars) / 4)` (`BitbucketParticipant.ts:834-835`).
- The chunk-packing cost formula: `1500 + 50×files + ceil(diff.length/4)` tokens per chunk (`CHUNK_FIXED_OVERHEAD` / `CHUNK_FILE_OVERHEAD` in `reviewSessionState.ts:599-602`), plus the hunk-splitting fallback for a single oversized file.
- The `matchBase: true` mechanism by which `reviewExcludePatterns` glob-matches file paths (`BitbucketParticipant.ts:611`).
- The follow-up message contracts, verbatim — `_Finding #N not found. The review has findings #1–#M._`, `_Review session ended._`, `**Follow-up failed:**`, `**Refinement failed:**`.

**How the review caught them:** the `ce-code-review` pass grepped `docs/review-process.md` for the specific terms/strings tied to each fact (`"estimated token"`, `"matchBase"`, `"1500 + 50"`, `"60 000"`, `"dev/null"`, `"Finding #N"`) and got zero hits across the board, then reported the concrete failure mode this creates for a future contributor relying on the "keep this document in sync" instruction to catch drift that the doc was never positioned to catch in the first place.

**How it was fixed:** each fact was re-verified against current source before being written anywhere (e.g. confirming `reviewTokenEst`'s exact template at `BitbucketParticipant.ts:834-835` and `CHUNK_FIXED_OVERHEAD = 1500` at `reviewSessionState.ts:599`), then relocated into `docs/review-process.md` as a new "Diff intake and chunk budgeting" section, a new "Token estimate" section, and additions to "Follow-ups" — before, not after, the CLAUDE.md section was trimmed to a link. Shipped in PR #35 (branch `docs/claude-md-knowledge-restructure`), merged to `main`.

**A smaller parallel instance, same underlying mistake in the opposite direction:** the same review pass caught two miscounts in the plan document that drove this restructuring (not in CLAUDE.md itself) — a settings-key-prefix list naming only 4 of the 5 real `ticketSidekick.*` prefixes actually present in `package.json`'s `contributes.configuration` (missing `veracode`), and a stated row-count of "sixteen" for a table being relocated that was actually seventeen rows. Both were caught by the reviewer independently counting against `package.json` and the source table rather than trusting the plan's own enumeration/arithmetic. Same root lesson as the main finding: verify counts and coverage claims against the actual source — don't trust the summary, even when the summary was written carefully and looks complete.

## Related

- No related `docs/solutions/` entries — this is this corpus's first `workflow-issues` entry; the three existing docs (`docs/solutions/integration-issues/waltz-oss-report-unzip-failure-on-real-world-xlsx.md`, `docs/solutions/logic-errors/redaction-substring-match-false-positives.md`, `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md`) are unrelated bug reports.
- [`docs/review-process.md`](../../review-process.md) — the destination doc extended to carry the previously-unreachable facts.
- PR #35 (`docs/claude-md-knowledge-restructure`), merged to `main`.
