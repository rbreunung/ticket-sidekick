---
title: git commands hardcoded to 'origin' fail in this repo -- the GitHub remote is named 'Github'
date: 2026-08-22
category: workflow-issues
module: development-workflow/git-remote-configuration
problem_type: workflow_issue
component: development_workflow
applies_when:
  - Running any automated git/gh shipping workflow (ce-work, ce-commit-push-pr, lfg, or manual git automation) in this repo
  - Writing or following a skill/script step that hardcodes 'origin' as the remote name for push, fetch, or 'git rev-parse --abbrev-ref origin/HEAD'
  - Diffing or composing a PR description against the repo's default branch and needing to fetch it by remote name
  - Any repo that is mirrored to more than one git host (here: Bitbucket Cloud and GitHub), which is a common reason a repo ends up without a remote literally named 'origin'
symptoms:
  - "git rev-parse --abbrev-ref origin/HEAD fails with: fatal: ambiguous argument 'origin/HEAD': unknown revision or path not in the working tree."
  - "git push -u origin HEAD fails identically -- no remote named 'origin' exists"
  - "git remote -v shows two remotes, neither named 'origin': Bitbucket-Cloud and Github (capital G)"
  - "gh repo view / gh pr create / gh pr list all succeed throughout, because gh resolves the repo from the remote URL, not the remote's local alias -- masking that raw git commands assuming 'origin' are broken"
root_cause: missing_validation
resolution_type: workflow_improvement
severity: medium
related_components: [ce-commit-push-pr, ce-work, git, gh-cli]
tags: [git, github, gh-cli, remote-name, origin, multi-remote, ce-commit-push-pr, shipping-workflow]
---

# git commands hardcoded to 'origin' fail in this repo -- the GitHub remote is named 'Github'

## Context

During an automated `ce-work` -> `ce-commit-push-pr` shipping run, several git commands that assume a remote named `origin` failed outright:

- `git rev-parse --abbrev-ref origin/HEAD` failed with `fatal: ambiguous argument 'origin/HEAD': unknown revision or path not in the working tree.` -- a different message from the one below, since `rev-parse` fails on ref resolution rather than on a network remote lookup, but caused by the same missing-`origin` root cause.
- The generic `ce-commit-push-pr` shipping skill's documented push step is hardcoded as `git push -u origin HEAD` (its `references/commit-and-push.md` -- a bundled reference file in the Compound Engineering plugin, not part of this repo's own tree) -- this fails with `fatal: 'origin' does not appear to be a git repository` and would have failed identically had it been run verbatim.

`git remote -v` (verified live in this repo) shows:

```text
Bitbucket-Cloud  https://breurob-admin@bitbucket.org/breurob/jira-copilot-extension.git (fetch)
Bitbucket-Cloud  https://breurob-admin@bitbucket.org/breurob/jira-copilot-extension.git (push)
Github           https://github.com/rbreunung/ticket-sidekick.git (fetch)
Github           https://github.com/rbreunung/ticket-sidekick.git (push)
```

There is **no remote literally named `origin`** in this repo. It has two deliberately, descriptively named remotes -- `Github` (capital G, the primary/public mirror) and `Bitbucket-Cloud` (a secondary mirror) -- instead of the conventional `origin` alias. This is a valid, intentional repo configuration, not a misconfiguration to correct.

Throughout the same session, `gh` CLI commands (`gh repo view`, `gh pr view`, `gh pr list`, `gh pr create`) all worked correctly regardless of this, because `gh` resolves its target repository from the remote's URL matched against the authenticated host -- not from the remote's local alias name. Only raw `git` commands that hardcode the string `origin` fail. This is an easy trap: `gh` succeeding gives false confidence that "everything git/gh-related is fine," right up until a bare `git push -u origin HEAD` or `git rev-parse --abbrev-ref origin/HEAD` throws.

**This is a recurring friction, not a one-off (session history):** three prior sessions on this repo's `main`/refactor branches independently hit the same wall and re-derived the fix from scratch each time, with no persistent record left behind:

- One session discovered mid-task that "the git remote is named `Bitbucket-Cloud`, not `origin`," resolved the default branch via `Bitbucket-Cloud/HEAD`, and created its work branch with an explicit remote-qualified ref (`git checkout -b refactor/unify-review-table-rendering Bitbucket-Cloud/main`) to sidestep an `origin`-based command entirely.
- A second session pushed successfully with `git push -u Github HEAD` and used `git fetch --no-tags Github main` by name during PR-description context gathering.
- A third, most recent prior session ran a batch of git context commands including `git log --oneline origin/main..HEAD`, and 3 of 8 commands in that batch errored -- consistent with `origin`-based commands failing.

No prior session left behind a persistent fix (a renamed remote, an updated script/skill default, or a note like this one) -- each rediscovered the correct remote name ad hoc via `git remote -v` and moved on. This doc exists to break that cycle.

## Guidance

Never hardcode or assume the remote name is `origin` in this repo -- and, generalized, never assume it in any repo before verifying, since a repo with no `origin` remote at all is a real, encountered case, not a theoretical edge case.

Before running any remote-qualified git command (push, fetch, or a `rev-parse` against a remote's `HEAD`), resolve the actual remote name and default branch from two independent, verifiable sources and cross-check them:

1. **List local remotes and their URLs**: `git remote -v`. This gives you the actual local alias(es) in use.
2. **Get the canonical repo URL and default branch from `gh`** (which already knows the right repository regardless of local alias naming):
   ```bash
   gh repo view --json url --jq ".url"
   # -> https://github.com/rbreunung/ticket-sidekick

   gh repo view --json defaultBranchRef --jq ".defaultBranchRef.name"
   # -> main
   ```
3. **Match the `gh`-reported URL to the remote with that URL** in the `git remote -v` output to learn the actual local remote name to use (in this repo: `Github`, not `origin`).
4. **Push using the discovered remote name**, not `origin`:
   ```bash
   git push -u Github HEAD
   # -> branch 'feat/unify-review-table-rendering' set up to track 'Github/feat/unify-review-table-rendering'.
   ```
5. **Fetch the base branch the same way**, e.g. when composing a diff or a PR description:
   ```bash
   git fetch --no-tags Github main
   ```
6. **Never resolve the default branch via `git rev-parse --abbrev-ref origin/HEAD`** in this repo -- it depends on a remote literally named `origin` having a locally configured symbolic `HEAD` ref (set via `git remote set-head origin -a`), and neither the remote name nor that ref exists here. Use `gh repo view --json defaultBranchRef --jq ".defaultBranchRef.name"` instead -- it needs no local remote-name knowledge at all. (A session-history variant that also works: resolve a specific remote's default branch via `<remote>/HEAD` once that remote's symbolic HEAD is set locally, e.g. `Bitbucket-Cloud/HEAD` -- but the `gh repo view` approach is simpler since it needs no local ref setup first.)
7. **`gh` subcommands themselves never need this treatment.** `gh pr create`, `gh pr list --head <branch>`, `gh pr view <number>` all work by passing only a branch name, PR number, or PR URL -- never a remote-qualified ref (`origin/main`, `Github/main`). Don't add remote-name logic to `gh` calls; it's only the raw `git` commands that need it.

This was verified working end-to-end in this session: the branch `feat/unify-review-table-rendering` was pushed to `Github`, PR #37 (`https://github.com/rbreunung/ticket-sidekick/pull/37`) was opened, reviewed, and merged -- confirmed directly via `gh pr view 37 --json state,mergedAt`, which returned `{"state":"MERGED","mergedAt":"2026-08-22T20:39:48Z"}`.

## Why This Matters

A generic or automated git workflow -- a CI script, an agent-driven shipping skill like `ce-commit-push-pr`, or even a human contributor's muscle-memory `git push origin main` -- will fail with a confusing `fatal: 'origin' does not appear to be a git repository` error in this repo specifically, unless it first discovers the actual remote name. The failure mode is doubly confusing because:

- The error message talks about `origin` "not appearing to be a git repository," which reads like a corrupted or misconfigured remote, not "this remote alias simply doesn't exist under this name."
- `gh` CLI commands run immediately before or after the failing `git` command succeed without any special handling, because `gh` resolves the repository from remote URLs, not local alias names. That success creates false confidence that the rest of the git-level tooling will "just work" the same way -- right up until a raw `git push`, `git fetch`, or `git rev-parse` against a remote ref hits the missing-`origin` wall.

Any automation that hardcodes `origin` (the near-universal default convention) will silently break the first time it runs against this repo, even though the repo itself is perfectly healthy and its `gh`-based tooling works fine. And per the session-history evidence above, this has already cost three separate sessions their own from-scratch rediscovery of the same fix.

## When to Apply

- Any time a script, skill, or new command needs to push, fetch, or otherwise reference a remote-qualified ref (`<remote>/<branch>`) against the GitHub-hosted remote in this repo -- use `Github`, not `origin`.
- Any time the same is needed against the Bitbucket mirror in this repo -- use `Bitbucket-Cloud`, not `origin`.
- More generally: before writing or running any git automation in *any* repo that assumes a remote named `origin` exists -- run `git remote -v` first and don't assume. This repo is a concrete, verified counterexample to that common default assumption, so the assumption itself is not safe to bake into shared/generic tooling (such as the `ce-commit-push-pr` skill's `references/commit-and-push.md` -- again, an external plugin path, not one in this repo -- which currently hardcodes `git push -u origin HEAD`).
- When auditing or extending shipping/automation skills that touch git push/fetch/rev-parse steps, prefer the `git remote -v` + `gh repo view --json ...` discovery pattern over a hardcoded remote name so the same skill works in repos with non-standard remote naming.

## Examples

**Fails in this repo** (assumes `origin` exists):
```bash
git rev-parse --abbrev-ref origin/HEAD
# fatal: ambiguous argument 'origin/HEAD': unknown revision or path not in the working tree.

git push -u origin HEAD
# fatal: 'origin' does not appear to be a git repository
```

**Works in this repo** (discovers the actual remote name and default branch first, then uses them):
```bash
# 1. See what remotes actually exist locally
git remote -v
# Bitbucket-Cloud  https://breurob-admin@bitbucket.org/breurob/jira-copilot-extension.git (fetch)
# Bitbucket-Cloud  https://breurob-admin@bitbucket.org/breurob/jira-copilot-extension.git (push)
# Github           https://github.com/rbreunung/ticket-sidekick.git (fetch)
# Github           https://github.com/rbreunung/ticket-sidekick.git (push)

# 2. Confirm the canonical repo + default branch via gh (no local-alias awareness needed)
gh repo view --json url --jq ".url"
# https://github.com/rbreunung/ticket-sidekick
gh repo view --json defaultBranchRef --jq ".defaultBranchRef.name"
# main

# 3. Match the gh URL to the git remote with that URL -> "Github" is the real local name

# 4. Push using the discovered remote name
git push -u Github HEAD
# branch 'feat/unify-review-table-rendering' set up to track 'Github/feat/unify-review-table-rendering'.

# 5. Fetch the base branch the same way
git fetch --no-tags Github main

# 6. gh subcommands need no remote-name awareness at all
gh pr create ...
gh pr list --head feat/unify-review-table-rendering
gh pr view 37
```

**Verified outcome**: PR #37 (`https://github.com/rbreunung/ticket-sidekick/pull/37`) was opened from `feat/unify-review-table-rendering` pushed to `Github`, and is confirmed merged --
```bash
gh pr view 37 --json state,mergedAt
# {"state":"MERGED","mergedAt":"2026-08-22T20:39:48Z"}
```
-- citing the PR number rather than a commit SHA, since this repo's history already shows a squash-merge pattern (e.g. `Merge pull request #37 from rbreunung/feat/unify-review-table-rendering` in `git log`), which means individual commit SHAs from a branch don't reliably survive into `main`.

## Related

- No related `docs/solutions/` entries -- a corpus-wide search (frontmatter and content grep across `title`, `tags`, `module`, and full-text for `remote`/`origin`/`git push`/`gh repo`) found no doc covering git-remote naming or `origin`-assumption failures; the two incidental hits (a `git log`-style "pushed to the Github remote" mention in `docs/solutions/integration-issues/waltz-oss-report-unzip-failure-on-real-world-xlsx.md`, and an unrelated "remote-image embed" wiki-markup term in `docs/solutions/security-issues/waltz-oss-report-markdown-injection-in-jira-wiki-converter.md`) are unrelated to this topic. `docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md` is this corpus's only other `workflow-issues` entry and shares the directory but not the topic (documentation fact-verification, not git tooling).
- No related GitHub issues found (`gh issue list --search "origin remote" --state all` and `gh issue list --search "remote push" --state all` against `rbreunung/ticket-sidekick` both returned zero results).
- PR #37 (`feat/unify-review-table-rendering`), merged to `main`.
