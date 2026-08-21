---
title: "Broadened cancellation word list swallows exact domain-name matches (e.g. an issue type, template, or filter literally named Stop, Skip, or Quit)"
date: 2026-08-21
category: logic-errors
module: "src/participant/sessionState.ts — parseIssueTypeSelection() / parseTemplateSelection() / parseFilterSelection()"
problem_type: logic_error
component: assistant
symptoms:
  - "A Jira issue type literally named `Stop` (or `Skip`/`Quit`/any other newly-added cancellation word) cannot be selected during ticket creation — typing its exact name cancels the flow instead of picking it"
  - "A `.jira-templates.json` template named `Stop` is unreachable the same way during template selection"
  - "A saved Jira filter named `Stop` cannot be chosen during filter selection — the user's exact-name reply is interpreted as cancel"
  - "No test failure and no compile error: `npm test` stayed green (982/982) through implementation because no fixture in the repo happened to use a colliding name, and `npm run compile` was clean — this is an environment-dependent regression, invisible unless the caller's live Jira data happens to collide with the generic word list"
  - "Not caught by the two earlier `ce-doc-review` planning-phase passes or by the implementer — caught only by a separate, later, post-implementation `ce-code-review` pass run after the feature was otherwise fully implemented and tests were passing"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [JiraParticipant, sessionState, createHandler]
tags: [confirm-cancel-parsing, name-collision, multi-turn-session, keyword-list-ordering, chat-participant, code-review-finding, regression, exact-match-precedence]
---

# Broadened cancellation word list swallows exact domain-name matches (e.g. an issue type, template, or filter literally named Stop, Skip, or Quit)

## Problem

Commit `36ea22e` unified six previously hand-rolled multi-turn `@jira` chat-reply parsers in `src/participant/sessionState.ts` onto shared `isConfirmation()`/`isCancellation()` helpers, and broadened `isCancellation()`'s word list from a narrow `c`/`cancel` set to also include `no, nope, cancelled, stop, abort, never mind, nevermind, don't, dont, quit, skip` (`src/participant/sessionState.ts:260-267`). Three of the six unified parsers — `parseIssueTypeSelection`, `parseTemplateSelection`, `parseFilterSelection` — accept the user's raw reply plus a caller-supplied live list of real domain values (a project's actual Jira issue types, a workspace's actual template names, a user's actual saved Jira filters) and let the user select one by typing its exact name. In the pre-fix version, all three checked `isCancellation(reply)` before checking whether `reply` matched a real domain value, so any project/workspace whose issue type, template, or saved filter happened to be literally named "Stop", "Skip", "Quit", etc. would have that value become permanently unselectable by name.

## Symptoms

- A Jira issue type literally named "Stop" (or "Skip"/"Quit"/any other newly-added cancellation word) cannot be selected during ticket creation — typing its exact name cancels the flow instead of picking it.
- A `.jira-templates.json` template named "Stop" is unreachable the same way during template selection.
- A saved Jira filter named "Stop" cannot be chosen during filter selection — the user's exact-name reply is interpreted as "cancel".
- No test failure and no compile error: `npm test` stayed green (982/982) through implementation because no fixture in the repo happened to use a colliding name, and `npm run compile` was clean — this is an environment-dependent regression, invisible unless the caller's live Jira data happens to collide with the generic word list.
- Not caught by the two earlier `ce-doc-review` planning-phase passes (which caught two unrelated issues — a plan referencing a nonexistent method, and a missed pair of parsers needing relabeling) or by the implementer. Caught only by a separate, later, post-implementation `ce-code-review` pass run as a background agent after the feature was otherwise fully implemented and tests were passing.

## What Didn't Work

Nothing was tried and discarded before the fix — this was a straightforward, single-pass reordering once the code-review finding was understood. The only design question worth recording is that a broader "shared parser skeleton" refactor was considered and explicitly rejected as out of scope for this fix (see the `d67ff6b` commit message: "Not applied: a shared parser skeleton beyond the confirm/cancel prefix — judged out of scope, a bigger redesign than this fix warrants").

## Solution

Fixed in commit `d67ff6b` ("fix(jira): close name-collision regressions from confirm/cancel unification"). Each of the three affected parsers was reordered so the exact, case-insensitive match against the caller's live domain list runs **before** the call to `isCancellation()`. This is a general reordering — not a per-word carve-out (e.g. not "special-case the word 'stop'"), which would only move the same bug class to the next word someone adds to the shared list later.

`parseIssueTypeSelection`, before (as it existed on `36ea22e`, prior to `d67ff6b`):

```ts
export function parseIssueTypeSelection(reply: string, types: string[]): string | 'cancel' | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (isCancellation(normalized)) return 'cancel';
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= types.length) return types[num - 1];
  if (!isNaN(num)) return 'invalid';
  const match = types.find((t) => t.toLowerCase() === normalized);
  return match ?? 'invalid';
}
```

After, `src/participant/sessionState.ts:194-204`:

```ts
export function parseIssueTypeSelection(reply: string, types: string[]): string | 'cancel' | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  // A real issue type name wins over the generic cancellation word list — otherwise a
  // project with a type literally named "Stop" or "Quit" could never select it by name.
  const match = types.find((t) => t.toLowerCase() === normalized);
  if (match) return match;
  if (isCancellation(reply)) return 'cancel';
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= types.length) return types[num - 1];
  return 'invalid';
}
```

The same reordering was applied to `parseTemplateSelection` (`src/participant/sessionState.ts:206-220`) and `parseFilterSelection` (`src/participant/sessionState.ts:353-367`). `parseTemplateSelection` also keeps a separate `NO_TEMPLATE` shortcut set (`n`, `no template`, `none`, `0`, `without template`, `src/participant/sessionState.ts:215`) — that is an unrelated, deliberate, pre-existing product decision for "proceed without a template" and is not part of this fix; it is checked after both the name match and `isCancellation()`.

The other three unified parsers — `parseSkipInput` (`src/participant/sessionState.ts:153-183`), `parseBulkUpdateReview` (`:340-351`), and `parseReviewInput` (`:596-609`) — were **not** touched, and correctly so: none of them matches `reply` against a caller-supplied free-text domain-value list. `parseSkipInput` only matches numeric ticket-key suffixes extracted from `tickets`, not names; `parseBulkUpdateReview` only recognizes a fixed `skip <keys>` prefix; `parseReviewInput` only matches short synthetic row ids (`'1'..'N'`, `'A1'..'Am'`) that are never user-chosen text. None of them has a name-collision surface to protect, so reordering them would have been a no-op.

The commit also carried two minor, unrelated riders: removing a duplicated `ticketSidekick.jira.baseUrl` config read from `src/participant/jira/emailHandler.ts` (now passed in as a parameter, matching every other handler), and standardizing `parseBulkUpdateReview`/`parseFilterSelection` to pass the raw `reply` rather than a pre-trimmed variable into `isCancellation`/`isConfirmation` (style-only, both already trim internally).

Regression tests were added in `src/test/JiraParticipant.test.ts`: `describe('parseTemplateSelection', ...)` at line 169 with the new case at line 208, `describe('parseIssueTypeSelection', ...)` at line 230 with the new case at line 272, and `describe('parseFilterSelection', ...)` at line 583 with the new case at line 622 — each constructs a types/templates/filters list containing a literal `'Stop'` entry and asserts both the exact-case and lowercased reply resolve to that real value, not to `'cancel'`.

## Why This Works

The general principle: **a specific-identity check against live, caller-supplied data must run before a generic keyword/classification check**, whenever both could plausibly match the same input string. A real domain value (an issue type someone actually created, a template someone actually authored) is always more specific and more intentional than membership in a shared generic word list — the user typing "Stop" when "Stop" is a real option in front of them is far more likely to mean "select Stop" than "cancel via a word that happens to also mean cancel elsewhere."

This bug class is worth distinguishing from an ordinary logic bug because of *where* the blast radius lives. `isCancellation()`'s word list and its six call sites are decoupled by design — that's the whole point of unifying them. But that decoupling means growing the shared list is an **action-at-a-distance** change: editing one `Set` in `sessionState.ts` silently grows the collision surface of every caller that matches raw user free text against it, including callers whose own diff didn't change at all. Nothing in the diff of the word-list broadening itself reveals this; you have to separately reason about every caller's data shape to see the risk. That is precisely why this is a distinct hazard class from a typo or an off-by-one: the failure isn't local to the changed lines, it's a property of the interaction between the changed lines and code elsewhere that appears untouched.

## Prevention

- When broadening a shared free-text keyword/classification list (confirm/cancel words, redaction key-patterns, status/priority name matching, or any other "does this string mean X" mechanism), explicitly audit every caller that matches raw user input against a **live domain-value list** for collision risk — not just the callers that happen to have existing test fixtures. The unit test suite staying green here (`982/982`) proved nothing about this risk, because no fixture used a colliding name; passing tests are not evidence of safety for this bug class.
- Ask the question directly during review: "what happens when a real value collides with one of these new words?" That question, asked in a dedicated post-implementation review pass rather than inferred from reading the diff, is what caught this — not the existing test suite, and not either of the two earlier planning-phase reviews, which were scoped to the plan document rather than to interaction effects across the implemented code.
- Add adversarial "name collides with the generic word" test cases as a standing category whenever a parser both classifies free text generically *and* matches it against a live domain list — replicate the pattern in `src/test/JiraParticipant.test.ts:208, 272, 622`: build a values list containing a literal entry equal to one of the generic keywords (e.g. `'Stop'`), and assert both exact-case and lowercased replies resolve to the real value, not to the generic classification.
- This principle generalizes beyond `isCancellation()`/`isConfirmation()`: any shared generic-keyword or classification mechanism in this codebase — redaction key-patterns (`src/utils/logRedaction.ts`), status/priority/name matching against Jira metadata, or any future shared free-text parser — carries the same shape of risk when its keyword set is broadened. The fix pattern is the same every time: check the specific, caller-supplied, live-data match first; fall through to the generic classification only when nothing specific matched.

## Related Issues

- **Moderate overlap** with [`redaction-substring-match-false-positives.md`](redaction-substring-match-false-positives.md) — both are `root_cause: logic_error` instances of "a generic/broad matcher started matching legitimate values it shouldn't have," but via different mechanisms: that bug was a single matcher that was structurally too loose (bare substring containment, fixed by tightening the matcher itself with word-boundary + exact-set logic); this bug was a two-check *ordering* problem (an already-correct specific check existed but ran after the generic one, fixed by reordering rather than changing either check's own logic). Worth reading together as two instances of the same broader principle: specific/exact matches against live data must run before a generic classifier.
- Fixed in [PR #36](https://github.com/rbreunung/ticket-sidekick/pull/36) (commit `d67ff6b`, branch `fix/jira-chat-ux-consistency`), merged into `main`.
