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
- R2. `README.md` moves its deep-reference material to new pages under `docs/manual/`, replacing each moved section with a short pointer sentence and a link at the point it previously occupied. Deep-reference material includes: templates and cleanup-rule examples/fields (`README.md:485-735`), the settings reference for both participants (`README.md:735-815`, `README.md:998-1038`), the PR-review walkthrough plus follow-ups/posting-comments and token-usage tuning (`README.md:889-1070`), and the three report-import flows — email, Veracode, Waltz (`README.md:375-485`).

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
