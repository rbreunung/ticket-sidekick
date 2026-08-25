---
title: "Combined create-ticket list silently guesses an issue type ('Task') and drops the no-template fallback when the issue-type fetch fails"
date: 2026-08-25
category: logic-errors
module: "src/participant/jira/createHandler.ts — handleCreateTicket() / streamCreateSelection(); src/participant/JiraParticipant.ts — <!-- jira:selecting-create-option --> routing block"
problem_type: logic_error
component: assistant
symptoms:
  - "A template with no explicit `issueType` in `.jira-templates.json`, combined with a failed `ticketService.getIssueTypes(projectKey)` call, silently defaulted the ticket's issue type to the literal string `'Task'` with no indication to the user it was a guess rather than a resolved fact"
  - "If the project had no `Task` issue type, ticket creation failed with an opaque Jira 400; if it happened to have one, a ticket was silently created with a possibly-wrong issue type"
  - "When templates existed but the issue-type fetch failed entirely, the merged selection list rendered only the templates section (the 'Issue types (no template)' section was gated on `issueTypes.length > 0`), leaving the user stuck picking a template with no way to create a ticket without one, other than cancelling"
  - "This regressed an escape hatch the old, pre-merge two-separate-lists code always provided — a `showInputBox` free-type fallback in this exact scenario"
  - "Caught only by a post-implementation `ce-code-review` pass on the finished diff, not by planning-phase review or by the implementer"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [JiraParticipant, sessionState, createHandler]
tags: [issue-type-resolution, silent-default, missing-fallback, template-selection, chat-participant, code-review-finding, sentinel-value, jira-create]
---

# Combined create-ticket list silently guesses an issue type ('Task') and drops the no-template fallback when the issue-type fetch fails

## Problem

While merging `@jira create`'s separate template-list and issue-type-list prompts into one combined numbered list (`docs/plans/2026-08-24-2201-refactor-align-create-issuetype-list-plan.md`), the new selection-building logic in `handleCreateTicket` (`src/participant/jira/createHandler.ts`) conflated "no value was resolvable" with "pick a plausible default." When a template's own `issueType` couldn't be resolved — either the template had none configured, or `ticketService.getIssueTypes(projectKey)` failed outright — the list either silently substituted a fabricated issue type or silently dropped the user's only way to create a ticket without a template.

## Symptoms

- A template with no explicit `issueType` in `.jira-templates.json`, combined with a failed issue-type fetch, caused the ticket to be submitted to Jira with the literal string `'Task'` as its issue type — no indication to the user this was a guess. A project with no `Task` issue type got an opaque Jira 400; a project that happened to have one got a ticket with a possibly-wrong type, silently.
- When templates existed but the issue-type fetch failed entirely (`issueTypes = []`), the merged list's "Issue types (no template)" section rendered only `if (session.issueTypes.length > 0)` — with `issueTypes` empty, the section vanished. The user was stuck picking from templates only, with `(c)` to cancel as the only way out.
- The old, pre-merge two-separate-lists code always resolved to a `showInputBox` free-type fallback in the second scenario; the merged-list rewrite silently regressed that escape hatch.
- Neither issue was caught by planning-phase review or by the implementer — both surfaced only in a post-implementation `ce-code-review` pass on the finished diff.

## What Didn't Work

- Building each template's list entry as `issueType: t.issueType ?? issueTypes[0] ?? 'Task'` — falling all the way through to the hardcoded string `'Task'` when neither the template nor the fetched issue types had anything to offer. `'Task'` reads as a reasonable guess for a lot of Jira projects, which is exactly what made it dangerous: it looked like a real value everywhere downstream (list rendering, the submitted payload, Jira's own 400 response), with nothing to distinguish "the user chose this" from "the code invented this."
- Gating the standalone "Issue types (no template)" section purely on `session.issueTypes.length > 0`. That check is correct when `issueTypes` came from a successful fetch — but the code building `session.issueTypes` didn't first guarantee it would be non-empty in every case that reached the combined list, so a failed fetch with templates still present produced an empty array and a vanished section, with no other code path providing a bypass.

## Solution

Introduce `''` (empty string) as an explicit "no resolvable issue type" sentinel — never a real Jira issue type name — used at three points in `createHandler.ts`, plus one in `JiraParticipant.ts`'s routing block:

**1. Template list construction** (`createHandler.ts`):

```ts
// before
templates: templates.map((t) => ({ name: t.name, issueType: t.issueType ?? issueTypes[0] ?? 'Task' })),

// after
templates: templates.map((t) => ({ name: t.name, issueType: t.issueType ?? issueTypes[0] ?? '' })),
```

**2. Issue-type list construction, guaranteeing a bypass entry** (`createHandler.ts`):

```ts
// before
issueTypes,

// after
issueTypes: issueTypes.length > 0 ? issueTypes : [''],
```

This makes the existing `session.issueTypes.length > 0` render guard trivially true whenever templates exist but the fetch failed — the section always has at least the one sentinel entry to show.

**3. Rendering the sentinel as an instruction, not a blank** (`streamCreateSelection` in `createHandler.ts`):

```ts
const label = (issueType: string) => issueType === '' ? '_you will be asked to type it_' : issueType;
```

**4. Routing block detours to the input box instead of submitting the sentinel** (`JiraParticipant.ts`, inside the `<!-- jira:selecting-create-option -->` handler, after `pickEmailOption()` resolves the user's numeric pick):

```ts
let issueType = pick.issueType;
if (issueType === '') {
  const entered = await vscode.window.showInputBox({ prompt: 'Enter the issue type (e.g. Bug, Story, Task)', ignoreFocusOut: true }) ?? null;
  if (!entered) { stream.markdown('No issue type provided — cancelled.'); return; }
  issueType = entered;
}
```

This mirrors the pre-existing "both templates and issue types are completely empty" fallback, which already used `showInputBox` for the same reason — the fix generalizes that existing escape hatch to a second, previously-unhandled partial-failure case (templates present, issue-type fetch failed) instead of inventing a new mechanism.

## Why This Works

The root failure mode is **silently substituting a plausible-looking default for a value that could not actually be resolved from any real source**. `'Task'` and "just omit the section" both hide the fact that the code has no real answer — one hides it behind a fabricated value that flows all the way to Jira's API, the other hides it by removing the only UI path that could have produced a real answer. Both are invisible until a user (or Jira's 400 response) surfaces them, by which point the ticket is either wrong or the user is stuck.

The `''` sentinel fixes this structurally rather than patching each symptom: it is a value that is provably never a real Jira issue-type name, so it can be checked for equality everywhere the resolved issue type is consumed — in list rendering (`label()`), in list construction (guaranteeing the bypass entry exists), and in the terminal routing step (detouring to `showInputBox` instead of calling `continueAfterIssueType` with a guess). Because the sentinel is threaded through the same `CreateSelectionSession`/`pickEmailOption()` data path as a real issue type, there is exactly one place it must be intercepted before reaching the Jira API — no duplicate defaulting logic to keep in sync across call sites.

## Prevention

- **General principle**: when a value your code needs isn't resolvable from any real source (a failed fetch, a missing config field), don't let a fallback chain (`??`) silently bottom out in a plausible-looking literal. Bottom it out in a sentinel that is provably distinguishable from every real value, and force that sentinel through an explicit fallback UI or error path at the point of consumption — never let it flow silently into a downstream API call.
- **Code-review checklist item**: any `??`/`||` fallback chain that ends in a hardcoded literal (a string like `'Task'`, a magic number, a default id) is worth flagging — ask whether that literal represents a real, verified value or is standing in for "nothing worked." If the latter, it should be a sentinel plus an explicit handling path, not a silent default.
- **List/section-gating checklist item**: when a UI section's visibility is gated on `array.length > 0`, check whether every code path that constructs that array actually guarantees it can be non-empty when the section needs to appear, rather than relying on an assumption (e.g. "the fetch usually succeeds") that a failure path silently violates.
- This bug pattern was caught by an automated `/code-review` pass on a plan-driven implementation, not by a human reviewer or by the test suite — `createHandler.ts` and the `JiraParticipant.ts` routing block both import `vscode` directly, so both fall under the same Vitest-unloadable rule `CLAUDE.md`'s Testing section states by name for `JiraParticipant.ts`/`BitbucketParticipant.ts`, and this class of bug is structurally invisible to `npm test` here. A `/code-review` pass (or equivalent manual review) is the load-bearing check for `vscode`-coupled flow code in this codebase — worth running deliberately on any new multi-step `vscode`-dependent flow rather than assuming unit-test coverage will catch fallback/default-value bugs in it.

## Related Issues

- `docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md` — a different failure mode (parsing-order collision, not silent-default) in the same Jira ticket-creation multi-turn selection subsystem (`src/participant/sessionState.ts` / `createHandler.ts` / `JiraParticipant.ts`), also caught by a post-implementation `ce-code-review` pass rather than by tests. Worth reading together as two distinct ways this subsystem's `vscode`-coupled flow code has slipped past earlier review.
- `docs/plans/2026-08-24-2201-refactor-align-create-issuetype-list-plan.md` — the plan this fix was implemented against; KTD5 and KTD7 in its Planning Contract document this exact fix and its rationale.
- PR #39 (`rbreunung/ticket-sidekick`, `worktree-brainstorm-align-issuetype-list` branch), merged into `main` 2026-08-24.
