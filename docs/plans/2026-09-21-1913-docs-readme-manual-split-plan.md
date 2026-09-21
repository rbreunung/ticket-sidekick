---
title: README Hybrid Manual Split - Plan
type: docs
date: 2026-09-21
topic: readme-manual-split
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# README Hybrid Manual Split - Plan

## Goal Capsule

- **Objective:** Someone reading Ticket Sidekick's documentation — on the GitHub repo page or the VS Code Marketplace Details tab — gets a short, navigable entry point for first use, with deep-reference material one click away, all from a single maintained source.
- **Means:** Restructure `README.md` into a hybrid: first-time setup and core commands stay inline; deep-reference sections move to new pages under a new `docs/manual/` folder, linked from `README.md`.
- **Product authority:** `ce-brainstorm` dialogue, confirmed synthesis (this session).
- **Open blockers:** None. The exact file-by-file split within `docs/manual/` is deferred to planning (see Scope Boundaries).

## Product Contract

### Summary

`README.md` splits into a hybrid entry point: intro, quickstart, prerequisites, setup, and core commands for both `@jira` and `@bitbucket` stay inline, while templates/cleanup rules, the settings reference, the PR-review deep dive, and the report-import flows (email, Veracode, Waltz) move to new pages under `docs/manual/`. A new `docs/known-limitations.md` entry records that nothing enforces README-to-manual consistency automatically.

### Key Decisions

- **Hybrid split, not all-inline or fully-split.** First-time users need setup and core commands reachable without leaving `README.md`; the templates, settings, and PR-review sections are long enough that keeping them inline would defeat the restructure. Governs R1, R2. (session-settled: user-directed — chosen over an all-inline README with collapsible sections and over a fully-split README that links out for everything, including quickstart: the fully-split option was rejected because it adds a click before a first-time user's first command.)
- **New `docs/manual/` folder, not the existing `docs/`.** The existing `docs/` tree is agent-context for Claude Code sessions (`jira-flows.md`, `review-process.md`, etc.) plus CE artifacts (`docs/plans/`, `docs/solutions/`); mixing end-user pages into it would blur both audiences. Governs R3. (session-settled: user-directed — chosen over adding the new pages directly to `docs/` — keeps end-user reading distinct from agent/CE content.)
- **Manual linked markdown, no build tooling or docs site.** The doc corpus (~1100 lines total) is too small to justify a generated-README pipeline or a published docs site; GitHub and the VS Code Marketplace already render the same `README.md` and linked files natively via `vsce`'s relative-link rewriting (`package.json:11-14` sets the `repository` field this depends on; `README.md:12` already links to `docs/onboarding.md` today using this exact mechanism). Governs R3, R4, R5. (session-settled: user-directed — chosen over a generated-README build script and over a GitHub Pages/static-site pipeline: both solve a duplication problem that doesn't exist here, at the cost of new tooling to maintain.)
- **Existing `docs/*.md` agent-context files stay untouched.** They serve Claude Code sessions, not end users reading the extension's documentation, so this restructure doesn't reorganize, rename, or fold them in. Governs Scope Boundaries. (session-settled: user-directed — chosen over folding `docs/*.md` content into the new user documentation where it overlaps.)

### Requirements

**README structure**

- R1. `README.md` retains, for both `@jira` and `@bitbucket`: the project intro, quickstart, prerequisites, setup, and core commands — a first-time reader reaches a working first command (e.g. `@jira check`, `@bitbucket <pr-url>`) without leaving the file.
- R2. `README.md` moves its deep-reference material to new pages under `docs/manual/`, replacing each moved section with a short pointer sentence and a link at the point it previously occupied. Deep-reference material includes: templates and cleanup-rule examples/fields (`README.md:485-735`), the settings reference for both participants (`README.md:735-815`, `README.md:999-1038`), the PR-review walkthrough plus follow-ups/posting-comments and token-usage tuning (`README.md:889-998`, `README.md:1039-1070` — split around the nested Bitbucket settings-reference subsection), and the three report-import flows — email, Veracode, Waltz (`README.md:375-485`).

**Manual pages**

- R3. New pages live under a new `docs/manual/` folder, separate from the existing `docs/` tree. The number and names of individual `docs/manual/*.md` files, and the exact section-to-file mapping, are left to planning.
- R4. Cross-links from `README.md` into `docs/manual/*.md` are plain relative markdown links, the same mechanism `README.md:12`'s existing link to `docs/onboarding.md` already uses.
- R5. `README.md` remains the single file GitHub's repo page and the VS Code Marketplace listing both render — no content moved to `docs/manual/` is duplicated elsewhere.

**Known-limitation tracking**

- R6. `docs/known-limitations.md` gets one new Active Register row (next unused `KL<N>` ID, per that file's existing convention) describing the risk that `README.md` and `docs/manual/` pages can drift out of sync since nothing enforces consistency automatically; it surfaces at the existing monthly Routine check-in like every other entry.

### Scope Boundaries

- Existing `docs/*.md` agent-context files (`jira-flows.md`, `review-process.md`, `report-import.md`, `onboarding.md`, `known-limitations.md` itself, and the `docs/plans/`, `docs/solutions/`, `docs/ideation/`, etc. subfolders) are not reorganized, renamed, or moved — `known-limitations.md` is touched only for the one new row in R6.
- No docs website, GitHub Pages, or generated/build-time README assembly.
- The precise `docs/manual/*.md` file breakdown (how many files, their names, exactly which README subsection maps to which) is a planning decision, not fixed here.

### Dependencies / Assumptions

- Assumes `vsce`'s existing relative-link rewriting for the Marketplace Details tab continues to work for links into `docs/manual/*.md` the same way it already works for `README.md:12`'s link to `docs/onboarding.md` — not independently re-verified against `vsce`'s source in this session, only inferred from the current working link plus the `repository` field already set in `package.json:11-14`.

### Sources / Research

- `README.md:1-1109` — current heading structure and line ranges cited above.
- `README.md:12` — existing `docs/onboarding.md` link, the precedent this plan's linking mechanism follows.
- `package.json:11-14` — `repository` field enabling `vsce`'s Marketplace link rewriting.
- `docs/known-limitations.md:10-42` — Active Register convention (fields, ID scheme, severity scale) that R6's new row follows.
- `docs/` directory listing — confirms the existing folder already mixes agent-context files (`jira-flows.md`, `review-process.md`, `onboarding.md`, `report-import.md`) with CE-artifact subfolders (`plans/`, `solutions/`, `ideation/`, `issues/`, `presentation/`, `superpowers/`), supporting Key Decision 2's separation.
- `docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md` — a prior doc-consolidation in this repo (CLAUDE.md → `docs/review-process.md`) silently dropped facts that existed only in the deleted prose, caught by a code-review pass grepping the destination for each specific fact. Shaped KTD2 and U1's verification.
- `README.md:912` — the one internal anchor link inside the content being moved (`[Reducing token usage on large PRs](#reducing-token-usage-on-large-prs)`); both its source and target sit inside the same relocated block (`README.md:889-1070`), so it keeps resolving after the move without edits — confirmed by checking both line positions against the move boundary in R2.

---

## Planning Contract

**Product Contract preservation:** unchanged — R1-R6 and all four Key Decisions carry forward from the `ce-brainstorm` original with no scope change.

### Key Technical Decisions

- **KTD1. Four `docs/manual/` pages, grouped by reference topic, not one per README subsection.** `jira-templates-and-cleanup-rules.md`, `settings-reference.md` (covering both participants), `bitbucket-pr-review.md`, and `report-imports.md` — grouping keeps file count low while each page stays topically focused. Governs U1. (session-settled: user-approved — chosen over splitting the settings reference per participant: a single combined page covers both without doubling file count for a section that's short per participant.)
- **KTD2. Content is relocated verbatim, never paraphrased.** Per `docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md`, a "looks equivalent" rewrite risks silently dropping checkable facts (exact settings keys, template JSON examples, cleanup-rule field tables) that no later reader would notice missing. Governs U1, U2.
- **KTD3. The new known-limitation row carries severity Low.** A manually-tracked documentation-drift risk with no functional or security impact, distinguishing it from the register's existing Medium/High rows (`KL3`, `KL4`, `KL7`), which involve code correctness or security gaps. Governs U3. (session-settled: user-approved — chosen over Medium severity: a doc-drift risk with no functional or security impact doesn't warrant the same urgency as the register's code-correctness/security rows.)

---

## Output Structure

```text
docs/manual/
├── jira-templates-and-cleanup-rules.md
├── settings-reference.md
├── bitbucket-pr-review.md
└── report-imports.md
```

---

## Implementation Units

### U1. Relocate deep-reference content into new `docs/manual/` pages

- **Goal:** Create `docs/manual/` with four new pages holding the templates/cleanup, settings reference, PR-review, and report-import content moved verbatim out of `README.md`.
- **Requirements:** R2, R3 (KTD1, KTD2)
- **Dependencies:** None
- **Files:**
  - `docs/manual/jira-templates-and-cleanup-rules.md` (new)
  - `docs/manual/settings-reference.md` (new)
  - `docs/manual/bitbucket-pr-review.md` (new)
  - `docs/manual/report-imports.md` (new)
- **Approach:**
  1. For each of the four content blocks — templates/cleanup (`README.md:485-735`), settings reference for both participants (`README.md:735-815`, `README.md:999-1038`), PR review + follow-ups + token usage (`README.md:889-998`, `README.md:1039-1070` — split around the nested Bitbucket settings-reference subsection, extracted separately into `settings-reference.md`), report imports (`README.md:375-485`) — cut the block's existing markdown verbatim into its new file.
  2. Give each new page a top-level `#` heading and one lead-in sentence naming which participant(s) it covers and when to read it, since a manual page may be opened with no README context above it. Demote the source's existing headings one level where needed so each file's own heading hierarchy stays coherent.
  3. Do not paraphrase, drop examples, or shorten tables/code fences during the move (KTD2) — content should read identically to its README original, just relocated.
- **Test scenarios:** Test expectation: none -- pure content relocation, no application behavior.
- **Verification:** Each new page's content matches its source block line-for-line (no truncation or paraphrase); no two source ranges overlap (re-check line numbers against the current `README.md` before cutting, since a prior version of this plan had the settings-reference range nested inside the PR-review range); the one internal anchor link inside the moved content (`README.md:912`) still resolves within its new file; `npm run compile` and `npm test` still pass.

### U2. Restructure `README.md` into the hybrid entry point

- **Goal:** Replace the four moved sections in `README.md` with short pointers linking to the new `docs/manual/` pages, leaving quickstart/setup/core-commands and all other inline content unchanged.
- **Requirements:** R1, R2, R4, R5 (KTD2)
- **Dependencies:** U1
- **Files:** `README.md`
- **Approach:**
  1. At each of the four original locations, replace the removed block with 1-2 sentences plus a relative markdown link to its new `docs/manual/*.md` file, matching the link style `README.md:12`'s existing `docs/onboarding.md` link already uses.
  2. Read the full remaining `README.md` top-to-bottom once after editing to confirm no leftover sentence still refers to removed content by name without a link.
  3. Confirm the file still reads as a coherent, standalone entry point: intro, quickstart, setup, and core commands for both `@jira` and `@bitbucket` remain intact and in their original order.
- **Test scenarios:** Test expectation: none -- pure documentation restructuring, no application behavior.
- **Verification:** All four new links resolve to existing files; `npm run package` succeeds, confirming the packaged `.vsix` includes the rewritten README; the packaged README's links follow the same rewriting behavior `README.md:12`'s existing link already relies on.

### U3. Record the README/manual consistency risk in the known-limitation register

- **Goal:** Add one Active Register row to `docs/known-limitations.md` documenting that nothing enforces consistency between `README.md` and `docs/manual/` automatically.
- **Requirements:** R6 (KTD3)
- **Dependencies:** U1, U2 (describes the finished split)
- **Files:** `docs/known-limitations.md`
- **Approach:**
  1. Read the current Active Register to confirm the next unused `KL<N>` id (`KL9` as of this plan's writing — re-check at implementation time in case another entry landed first).
  2. Add one row following the existing table's five columns (ID, Description/Pointer, Found, Severity, Reason): a pointer to `README.md` and `docs/manual/`, today's date, severity Low (KTD3), and a reason naming that no automated check exists and the existing monthly Routine is the catch mechanism.
- **Test scenarios:** Test expectation: none -- single table row addition, no behavior to verify beyond matching the existing table's format.
- **Verification:** The new row is valid Markdown table syntax and matches the column order and style of the existing rows (`KL1`-`KL8`).

---

## Verification Contract

| Command | Purpose |
| --- | --- |
| `npm run compile` | TypeScript type check — sanity check that an unrelated docs change didn't break anything. |
| `npm test` | Vitest unit tests — same sanity purpose. |
| `npm run package` | Runs `vsce package`; produces a local `.vsix` so the packaged README (with rewritten links) can be checked, satisfying R5. |
| Manual link check | Open each new `docs/manual/*.md` link from the rewritten `README.md` to confirm no broken relative path. |

---

## Definition of Done

- All four `docs/manual/` pages exist and hold their full moved content (U1).
- `README.md`'s four replaced sections read as short pointers to those pages, with no other content changed (U2).
- The `docs/known-limitations.md` Active Register carries the new row (U3).
- `npm run compile`, `npm test`, and `npm run package` all pass.
