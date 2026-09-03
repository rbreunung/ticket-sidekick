---
title: Extension Changelog - Plan
type: feat
date: 2026-09-02
topic: extension-changelog
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Extension Changelog - Plan

## Goal Capsule

- **Objective:** A user browsing Ticket Sidekick in VS Code's Extensions view can read real, per-version release history in the Changelog tab, without leaving the editor or visiting GitHub.
- **Means:** Capture GitHub's generated release notes via its REST API before creating each stable release (KTD1), write them into `CHANGELOG.md` with attribution stripped (KTD2), gated to the stable channel (KTD3), and backfill history once via a local script (KTD4).
- **Authority:** Product scope established in the brainstorm dialogue; technical approach established in this planning session.
- **Stop conditions:** None — no blocking questions remain.
- **Execution profile:** `code`, Standard depth. Low risk: a CI/config change with no runtime or user-data impact.
- **Tail ownership:** The implementer runs the manual dry-run checks in Verification Contract before considering U1/U3 done — no automated CI gate exercises this workflow logic itself.

---

## Product Contract

**Product Contract preservation:** unchanged from the brainstorm.

### Summary

`CHANGELOG.md` at the extension root, sourced from GitHub's own generated release notes, so VS Code's Extensions view Changelog tab shows real version history for Ticket Sidekick. The stable-release workflow captures those generated notes, strips PR/author attribution, and commits the result alongside each version bump; a one-time backfill seeds entries for every existing stable release.

### Problem Frame

GitHub Release notes already exist for every past release (auto-generated via `gh release create --generate-notes`), but that history is invisible from inside VS Code — the Extensions view's Changelog tab only renders a `CHANGELOG.md` file, which the extension has never had. A user deciding whether to update, or wondering what an update changed, currently has to leave the editor and find the repo on GitHub.

### Requirements

**Content source & generation**

- R1. The stable-release workflow (`channel: release` only) generates the version's release notes via GitHub's release-notes generator before creating the GitHub Release, so the same generated text backs both surfaces.
- R2. That generated text is written into `CHANGELOG.md` under a per-version heading and committed in the same commit that already bumps the version, so a published version's changelog entry exists by the time it reaches the Marketplace.
- R3. Each `CHANGELOG.md` entry strips the "by @author in #PR" attribution GitHub's generator appends per line. The GitHub Release itself is unaffected and keeps that attribution.
- R4. A preview-channel release (`channel: preview`) does not add or modify any `CHANGELOG.md` entry.

**Backfill**

- R5. `CHANGELOG.md` is seeded once with an entry for every existing GitHub Release currently marked as a full release (not pre-release), each built from that release's own already-generated notes with the same attribution stripped as R3.
- R6. The backfill omits any existing GitHub Release marked as a pre-release — this covers both past preview builds and a handful of early non-representative test releases.

### Key Decisions

- **Reuse GitHub's generated release notes as the changelog source** (session-settled: user-directed — chosen over building a separate commit-message/PR-title parser: the generator already produces good output, and this avoids parallel logic that could drift from it). Governs R1, R2.
- **Strip PR/author attribution only from the `CHANGELOG.md` copy** (session-settled: user-directed — chosen over mirroring GitHub's notes verbatim in both places, and over adding `.github/release.yml` category labels: cleaner read for an in-editor audience, no new config to maintain). Governs R3.
- **Stable channel only** (session-settled: user-approved — chosen over updating `CHANGELOG.md` on every channel including preview: keeps the in-editor tab focused on what stable users actually received). Governs R4.
- **Backfill full history** (session-settled: user-directed — chosen over starting the changelog fresh at the next release: gives users complete project history in-editor from day one). Governs R5, R6.

### Key Flows

- F1. Stable release publishes a changelog entry
  - **Trigger:** The release workflow runs with `channel: release`.
  - **Steps:** Generate the release notes text via GitHub's generator → strip PR/author attribution → prepend a new `## [version] - date` section to `CHANGELOG.md` → commit alongside the existing version-bump commit → create the GitHub Release using the same generated (unstripped) text.
  - **Outcome:** `CHANGELOG.md` and the GitHub Release both describe the same release from the same generated source, published together.
  - **Covers:** R1, R2, R3

### Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given a stable release is triggered, when the workflow completes, then `CHANGELOG.md` has a new top entry for that version with the release's changes listed but no "by @author in #PR" text, and the GitHub Release for that version shows the same changes with attribution intact.
- AE2. **Covers R4.** Given a preview release is triggered, when the workflow completes, then `CHANGELOG.md` is unchanged and only a GitHub pre-release is created, as today.
- AE3. **Covers R5, R6.** Given the one-time backfill runs, when it finishes, then `CHANGELOG.md` contains one entry per existing stable GitHub Release; entries for existing pre-release-marked releases (including the two releases titled "PR Review Test 1"/"PR Review Test 2") are absent.

### Scope Boundaries

- Categorized changelog sections (Added / Fixed / Docs, via `.github/release.yml` labeling) — a possible future upgrade; not part of this pass.
- Bumping `actions/checkout` / `actions/setup-node` past their Node 20 action runtime (GitHub is deprecating Node 20 for actions themselves) — confirmed needed, and carried into this plan as U2, a tag-along edit to the same workflow files this work already touches. It is unrelated infra maintenance with no product decision attached, so it is not tied to R1-R6.

### Dependencies / Assumptions

- Depends on the `gh` CLI (already used in `.github/workflows/release.yml`) exposing the release-notes text ahead of creating the release. Confirmed: `gh api repos/{owner}/{repo}/releases/generate-notes` (POST, params `tag_name`, `target_commitish`, `previous_tag_name`) returns `{name, body}` without creating anything — see KTD1.
- Assumes every existing stable GitHub Release still carries generated notes text to source the backfill from (confirmed true for all releases from `0.0.2` through `0.5.3` at the time of this plan).

### Sources / Research

- No `CHANGELOG.md` exists at the repo root today, and nothing in `.vscodeignore` would exclude one from the packaged `.vsix` if added.
- No `.github/release.yml` categorization config exists; GitHub's generated notes currently render as a flat "What's Changed" list.
- `gh release list --limit 100` confirms a GitHub Release exists for every tag from `0.0.2` through `0.5.3`, including releases titled "PR Review Test 1" / "PR Review Test 2" (for `0.0.4`/`0.0.5`) that GitHub already marks pre-release alongside genuine preview builds.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Fetch notes via GitHub's REST API before the `.vsix` is packaged, not merely before the release is created** — call `gh api repos/{owner}/{repo}/releases/generate-notes` with `tag_name` set to the version being released, `previous_tag_name` set to the last stable tag, and `target_commitish` set to the pre-version-bump `HEAD`; extract the returned `body`; pass that exact string to `gh release create` via `--notes`/`--notes-file` in place of `--generate-notes` (dropping the now-unused `${NOTES_START_FLAG}`/`--notes-start-tag` argument that only had meaning alongside `--generate-notes`), so `CHANGELOG.md` and the GitHub Release trace to one captured fetch rather than two independent generations (session-settled: user-directed — chosen over reading the notes back from `gh release view` right after creating the release: guarantees the two surfaces can never diverge, at the cost of introducing an API call with no precedent in this repo). This step, and the `CHANGELOG.md` write it feeds, must run before the workflow's `Package VSIX` step — running it any later means the `.vsix` a release actually ships is zipped before `CHANGELOG.md` gains that release's own entry, defeating R2. Governs R1, R2.
- KTD2. **Strip attribution with a line-level pattern match, applied only to the `CHANGELOG.md` copy** — drop the trailing `by @user in <#N-or-URL>` clause from each generated bullet line before writing it to `CHANGELOG.md`; the string passed to `gh release create --notes` keeps it unchanged (session-settled: user-directed — chosen over mirroring verbatim or a structured re-parse of the notes into categories: Governs R3). Governs R3.
- KTD3. **Gate the new logic on the workflow's existing `channel == 'release'` branching**, the same per-channel `if` idiom the workflow already uses twice, rather than introducing a new flag or input. Governs R4.
- KTD4. **Backfill via a one-off local script, not a permanent workflow job** — read `gh release list --json tagName,isPrerelease,body,publishedAt`, filter to non-prerelease, and write the resulting sections directly into `CHANGELOG.md`; run once by the implementer rather than adding a `workflow_dispatch` job that would sit unused after the one backfill run. Run it before the next stable release ships under U1's new logic, so no tag's entry is ever written twice by two different mechanisms. Governs R5, R6.

### Sources / Research

- `.github/workflows/release.yml:37,42` — `actions/checkout@v4` and `actions/setup-node@v4`, the two lines U2 changes; the same pair repeats at `.github/workflows/ci.yml:17,20`.
- `.github/workflows/release.yml:61-74` (`Resolve version`) runs before `:76-88` (`Package VSIX`), which builds the `.vsix` that `vsce publish` (125) later uploads unmodified. U1's notes-capture and CHANGELOG-write steps insert between those two — not later in the file — so the entry is inside the `.vsix` this release ships, per KTD1. The existing `LAST_STABLE` lookup (currently computed later, inside the Publish step at `:118-122`, with a `2>/dev/null || true` fallback) moves up to sit alongside them; the `--generate-notes` flag on `gh release create` (currently `:131`) is replaced with the captured text per KTD1.
- `.github/workflows/release.yml:110-114` — the "version already exists" duplicate-publish guard stays where it is, inside the Publish step. Running notes-capture/CHANGELOG-write earlier means a duplicate-version run does some wasted work (an API call, a file write) before this guard stops it — not incorrect published state, since nothing commits or publishes until after it passes.
- `.github/workflows/release.yml:83,105` — the existing `if [ "${{ inputs.channel }}" = "preview" ]` per-channel branches KTD3 follows.
- Repo-wide search confirms no existing use of `gh api .../generate-notes` and no existing `scripts/` utility that does markdown generation or text transformation — U1's and U3's transforms are new, not extensions of an existing pattern.
- `package.json`'s `scripts` block and `.vscodeignore`/`.gitignore` have nothing that blocks or needs updating for a root `CHANGELOG.md`.
- `README.md:1049-1066` (`## Releasing`) and `CLAUDE.md`'s release paragraph are the two docs U4 updates; neither currently mentions a changelog.
- GitHub REST API docs, `POST /repos/{owner}/{repo}/releases/generate-notes`: request params `tag_name` (required), `target_commitish` (required if the tag doesn't exist yet), `previous_tag_name`, `configuration_file_path`; response `{name, body}`. No dedicated `gh` subcommand wraps it — access via `gh api`.
- This repo's GitHub remote is aliased `Github` (capital G), not `origin` — relevant only to whoever pushes the branch/opens the PR for this work, not to the workflow file's own internal git commands (the Actions runner's checkout is always `origin` inside the job regardless of local aliases).

---

## Implementation Units

### U1. Capture and write the per-release changelog entry

- **Goal:** On a stable release, fetch GitHub's generated notes before the release exists, write a stripped copy into `CHANGELOG.md`, and publish the release from the same captured text.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** None
- **Files:**
  - `.github/workflows/release.yml`
- **Approach:**
  1. Move the `LAST_STABLE` lookup up to run right after `Resolve version`, and add a notes-capture step alongside it, before `Package VSIX` (KTD1): call the generate-notes endpoint with the new version as `tag_name`, `LAST_STABLE` as `previous_tag_name`, and the pre-bump `HEAD` as `target_commitish`; capture the returned body.
  2. In that same early position — still before `Package VSIX` — add a CHANGELOG-writing step, gated on the release channel (KTD3): strip attribution per line (KTD2) and prepend a `## [version] - date` section to `CHANGELOG.md`, so the entry is inside the `.vsix` this release packages next.
  3. Later, where `gh release create` already runs, replace its `--generate-notes` flag (and drop the now-vestigial `${NOTES_START_FLAG}`/`--notes-start-tag` argument) with the captured (unstripped) text, so the GitHub Release and the changelog entry originate from one fetch.
- **Execution note:** This is CI/config work with no Vitest harness for GitHub Actions YAML or embedded shell — prefer a manual dry run over unit coverage: a preview-channel run to prove `CHANGELOG.md` stays untouched, then a real stable release to prove the entry lands correctly and ships inside that release's own `.vsix`.
- **Patterns to follow:** The existing `LAST_STABLE` variable-capture idiom; the existing per-channel `if` branches (`release.yml:83,105`); `set -euo pipefail` at the top of every shell step in this file.
- **Test scenarios:**
  - Happy path: a stable release with commits since the last tag produces a `CHANGELOG.md` entry matching the GitHub Release's content minus attribution.
  - Edge case: a stable release with no notable commits since the last tag still gets a dated entry, not a skipped one.
  - Covers AE2. Conditional: a preview-channel run leaves `CHANGELOG.md` with zero diff, and still produces a GitHub pre-release with full generated notes as before.
  - Integration: the version's own `.vsix` (packaged after the CHANGELOG-writing step) contains that version's `CHANGELOG.md` entry — not just the git-committed copy — closing the one-version-lag gap R2 exists to prevent.
  - Integration: the text written to `CHANGELOG.md` and the text on the created GitHub Release trace to the same captured fetch (verified by comparing them, attribution aside).
  - Failure path: the notes-capture call failing (e.g., API error) fails the workflow step loudly rather than publishing a release with a missing changelog entry.
- **Verification:** A stable release run produces a correctly formatted, attribution-stripped `CHANGELOG.md` entry that is present inside the packaged `.vsix` itself, matching an unchanged GitHub Release; a preview run leaves `CHANGELOG.md` untouched.

### U2. Bump `actions/checkout` / `actions/setup-node` for Node 24 action-runtime support

- **Goal:** Stop GitHub's Node 20 action-runtime deprecation warning on every CI and release run.
- **Requirements:** None (tag-along maintenance — see Scope Boundaries)
- **Dependencies:** None
- **Files:**
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
- **Approach:** Bump `actions/checkout@v4` → `@v7.0.1` and `actions/setup-node@v4` → `@v7.0.0` at each of their four occurrences across both files (`node24` runtime landed at `actions/setup-node@v5.0.0`; both actions are past that at their current latest releases).
- **Test expectation:** none -- pure dependency-version bump with no logic change; the next CI/release run is the verification.
- **Verification:** A CI run on this branch completes without the Node 20 deprecation warning.

### U3. Backfill historical changelog entries

- **Goal:** Seed `CHANGELOG.md` once with an entry for every existing stable release.
- **Requirements:** R5, R6
- **Dependencies:** U1 (entry format must match what ongoing releases will produce)
- **Files:**
  - `scripts/backfill-changelog.mjs` (new, one-off utility — kept in the repo as a re-runnable regenerator, not deleted after use)
  - `CHANGELOG.md` (output)
- **Approach:**
  1. Read `gh release list --json tagName,isPrerelease,body,publishedAt --limit 500` (an explicit high limit — `gh release list` defaults to the 30 most recent releases, which already undercounts this repo's history).
  2. Filter to entries where `isPrerelease` is false.
  3. For each, strip attribution the same way U1 does (KTD2) and build a `## [tag] - date` section from the release's own `body`.
  4. Write all sections into `CHANGELOG.md`, newest first, in one pass — designed to regenerate the backfilled block safely on a re-run rather than duplicating it.
- **Test scenarios:**
  - Happy path: running the script against this repo's real release history produces one entry per stable tag, newest first, attribution stripped.
  - Edge case: a stable release whose body is minimal (e.g., the earliest release, with no prior tag to compare against) still produces a heading, not an error.
  - Covers AE3. Exclusion: releases marked pre-release, including the two titled "PR Review Test 1"/"PR Review Test 2", produce no entry.
  - Re-run safety: running the script twice leaves `CHANGELOG.md` with one entry per stable tag, not duplicates.
- **Verification:** `CHANGELOG.md`'s backfilled entries match `gh release list`'s non-prerelease tags one-to-one, in order, each stripped of attribution.

### U4. Document the new changelog behavior

- **Goal:** Keep the repo's own release-process docs accurate.
- **Requirements:** R1-R6 (documentation of the behavior they define)
- **Dependencies:** U1, U2, U3
- **Files:**
  - `README.md` (the `## Releasing` section)
  - `CLAUDE.md` (the release paragraph)
- **Approach:** Add a short note to both that a stable release now also writes a `CHANGELOG.md` entry from the same generated notes, and that preview releases do not.
- **Test expectation:** none -- documentation only.
- **Verification:** Both docs describe the CHANGELOG behavior alongside the existing release-sequence description.

---

## Verification Contract

| Check | Command / method | Applies to |
| --- | --- | --- |
| Type check | `npm run compile` | Whole repo (unaffected by this work, must stay green) |
| Unit tests | `npm test` | Whole repo (unaffected by this work, must stay green) |
| Preview dry run | Trigger the release workflow with `channel: preview`; confirm `CHANGELOG.md` has no diff | U1 |
| Stable dry run | Trigger the release workflow with `channel: release`; confirm the new `CHANGELOG.md` entry, the entry inside the packaged `.vsix` itself, and the GitHub Release all match (minus attribution) | U1 |
| CI runtime check | Confirm a CI run shows no Node 20 action-runtime deprecation warning | U2 |
| Backfill check | Run `scripts/backfill-changelog.mjs` once; diff `CHANGELOG.md` against `gh release list --limit 500`'s non-prerelease tags (same explicit limit as U3, so the check can't pass on a truncated backfill) | U3 |

## Definition of Done

- `CHANGELOG.md` exists at the repo root with one backfilled entry per existing stable release (U3), and gains one correctly formatted, attribution-stripped entry on the next real stable release (U1).
- `CHANGELOG.md` stays unchanged across preview releases (U1, AE2).
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` pin `actions/checkout` and `actions/setup-node` at Node-24-runtime versions (U2).
- `README.md` and `CLAUDE.md` describe the new changelog behavior (U4).
- `scripts/backfill-changelog.mjs` is committed as a documented, re-runnable utility rather than a throwaway script.
