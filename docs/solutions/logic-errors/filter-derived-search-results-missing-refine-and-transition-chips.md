---
title: "Filter-derived search results silently missed refine/transition chips because the chip-eligibility computation lived in only one of three result-producing code paths"
date: 2026-09-13
category: logic-errors
module: "src/participant/JiraParticipant.ts — runResolvedFilterJql() / computeSearchResultFollowup()"
problem_type: logic_error
component: assistant
symptoms:
  - "A filter-derived search result (`@jira show my filters`, the filter-name pick-list resume, and the filter+constraint combine flow, all routed through `runResolvedFilterJql`) never showed the refine-to-me/refine-to-sprint or 'Transition these tickets' chips that a plain `searchJql` result always showed"
  - "Saying 'transition these tickets' right after a filter-derived result falsely reported no prior search, because `runResolvedFilterJql` never wrote the `tickets` array onto the stored `SearchResultSession` that the transition flow reads eligibility from"
  - "Not caught by `npm test` — `JiraParticipant.ts` imports `vscode` and is Vitest-unloadable per CLAUDE.md's Testing section, so this class of missing-metadata bug in this file is structurally invisible to the unit suite; surfaced only when three independent code-review passes (correctness, maintainability, adversarial) converged on the same finding"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [JiraParticipant, sessionState, TicketService]
tags: [chip-eligibility, duplicated-logic, session-metadata, jira-search, code-review-finding, multi-path-divergence]
---

# Filter-derived search results silently missed refine/transition chips because the chip-eligibility computation lived in only one of three result-producing code paths

## Problem

`@jira`'s search results carry follow-up chips (refine-to-me, refine-to-current-sprint, "Transition these tickets…") computed from a `JiraFollowupState`/`SearchResultSession.tickets` derived from the search's own issues. That eligibility computation (project/issue-type extraction, active-sprint lookup, "all one project and one issue type" check) was written once, inline, inside the plain `searchJql` handler when the refine/transition chips (U5/U6, R7-R9) were added. `runResolvedFilterJql` — the function `handleListMyFilters`'s single-match path, its numbered pick-list resume, the filter-name-ambiguity resume, and the constraint-combine flow (`resolveConstraintsAndSearch`) all call to run an already-resolved filter's JQL — was a separate, older function that predated the chip feature and was never revisited when it landed. It stored a `SearchResultSession` with no `tickets` array and returned `void`, never computing or returning `jiraFollowup` metadata.

## Symptoms

- A plain search (`@jira find bugs assigned to me`) always got refine/transition chips; a filter run (`@jira show my filters`, or a filter combined with a fixVersion/sprint/assignee constraint) never did — same downstream rendering code, silently different behavior depending on which of the two producing paths built the result.
- Because `runResolvedFilterJql` never populated `SearchResultSession.tickets`, a "Transition these tickets" follow-up right after a filter-derived result failed with "no previous search results to act on," even though a search had just run and its ticket keys were stored — just without the `tickets` field the transition flow's eligibility check reads.
- Two reviewers separately flagged, while looking at this same function, that `runResolvedFilterJql` also dropped `config.baseUrl`/`config.searchFields` — a second, unrelated pre-existing gap in the same never-revisited function, folded into the same fix.
- All of this passed `npm test` clean before the fix, because `JiraParticipant.ts` imports `vscode` directly and is excluded from the Vitest suite per CLAUDE.md's Testing section — a missing-metadata bug confined to this file has no unit-test path that could catch it.

## What Didn't Work

There was no failed fix attempt here — the bug shipped because the feature was implemented once, correctly, in the path being touched (`searchJql`), and the review that would have asked "does every other function returning the same session type need this too?" didn't happen until a dedicated code-review pass ran against the finished diff.

## Solution

Extract the eligibility computation into one shared helper, `computeSearchResultFollowup(issues, ticketService, config)`, that both producing paths call:

```ts
async function computeSearchResultFollowup(
  issues: JiraIssue[],
  ticketService: TicketService,
  config: JiraConfig,
): Promise<{ tickets: NonNullable<SearchResultSession['tickets']> | undefined; followupState: JiraFollowupState }> {
  // ... project/issue-type extraction, active-sprint lookup, eligibility checks ...
  return { tickets, followupState: { kind: 'searchResults', sprintName, transitionChipEligible } };
}
```

`searchJql`'s handler now calls it instead of carrying its own inline copy, and `runResolvedFilterJql` calls it too, then returns the same `{ metadata: { jiraFollowup, jiraSession } }` shape the plain-search path already returned — routing every one of its four call sites (single-match filter, pick-list resume, ambiguity resume, constraint-combine) through the one function so they all inherit identical chip behavior instead of each needing its own fix. `runResolvedFilterJql`'s own doc comment was extended to name all four call sites explicitly, so a future reader can see at a glance which flows depend on it.

## Why This Works

The bug's shape wasn't a wrong eligibility calculation — the calculation was already correct. It was **the same derived-state computation existing in only one of several functions that produce the type that state hangs off of**, with no mechanism forcing the others to stay in sync. Extracting a shared function doesn't just deduplicate the current code; it removes the possibility of this specific bug recurring, because a future third path producing a `SearchResultSession` has only one place to call, not one inline block to remember to copy.

## Prevention

- **When a new field or metadata computation is added to one function that produces a shared result/session type, grep for every other function returning or constructing that same type before considering the feature done.** `SearchResultSession` and `JiraFollowupState` are produced by more than one entry point in `JiraParticipant.ts` — a chip-eligibility feature landing in only the newest or most-visited one is exactly the gap that shipped here.
- Prefer extracting the computation into a named shared function at the point a second call site needs the same derived state, rather than after a third one is discovered missing it — the fix here had to touch four call sites because the extraction happened after the fact instead of when `runResolvedFilterJql` was first identified as a second producer of the same session type.
- This bug class is structurally invisible to `npm test` for any `vscode`-importing file (`JiraParticipant.ts`, `BitbucketParticipant.ts`, and the `src/participant/jira/*Handler.ts` files) — per CLAUDE.md's Testing section, only pure logic extracted into `sessionState.ts`/`TicketService.ts`/etc. is Vitest-covered. A deliberate `/code-review` pass (as happened here, three independent passes on the same diff) is the load-bearing check for "did every path that should get this new behavior actually get it" in this class of file.

## Related Issues

- The same commit also fixed `getOwnedFilters()` silently returning `[]` (instead of throwing) when the current user's `accountId`/`name` was missing, which made `getMyFilters()`'s `Promise.allSettled` record a failed source as an empty success. That is a distinct root cause (a swallowed-failure/wrong-return-value bug, not a duplicated-computation gap) fixed in the same review round — not the same lesson, so not folded into this doc.
- PR #59 (`rbreunung/ticket-sidekick`, `feat/favorite-filter-search` branch), merged into `main` 2026-09-13; this fix landed as a direct follow-up commit (`37a54b9`) after the merge, from a `ce-code-review`-style pass with three independent reviewer personas (correctness, maintainability, adversarial) converging on the same finding.
