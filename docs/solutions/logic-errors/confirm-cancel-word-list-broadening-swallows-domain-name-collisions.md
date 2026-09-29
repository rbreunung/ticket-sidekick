---
title: "Cancellation word list swallows exact domain-name matches when checked before the offered options (e.g. a status, issue type, or filter named Cancelled or Stop)"
date: 2026-08-21
last_updated: 2026-09-29
category: logic-errors
module: "src/participant/sessionState.ts — every chat-reply parser that takes a live option list and also recognizes isCancellation()/isBackOrCancellation() words"
problem_type: logic_error
component: assistant
symptoms:
  - "Typing the exact name of a live Jira value that is also a cancel word (a workflow status `Cancelled`, an issue type or saved filter named `Stop`) cancels or backs out of the flow instead of picking it"
  - "Clicking the numbered chip for the same option still works (chips resubmit the number), so the bug only shows up when the user follows the prompt's own \"reply with the number or name\" hint"
  - "No test failure and no compile error — the suite stays green because no fixture uses a colliding name; the defect depends on the user's live Jira data"
  - "Caught twice, in PR #36 and again in PR #71, only by a post-implementation `ce-code-review` pass — not by planning reviews, the implementer, or the test suite"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [JiraParticipant, sessionState, createHandler, reportImportHandler, templateGenerationHandler]
tags: [confirm-cancel-parsing, name-collision, multi-turn-session, keyword-list-ordering, chat-participant, code-review-finding, regression, exact-match-precedence, recurrence, stale-close]
---

# Cancellation word list swallows exact domain-name matches when checked before the offered options (e.g. a status, issue type, or filter named Cancelled or Stop)

## Problem

`isCancellation()` (`src/participant/sessionState.ts:579-586`) treats a fixed set of words as "cancel": `c, no, nope, cancel, cancelled, stop, abort, never mind, nevermind, don't, dont, quit, skip`. `isBackOrCancellation()` (`:590-592`) adds `back`. Many `@jira` multi-turn parsers take the user's reply **and** a live list of real Jira values (issue types, workflow statuses, resolutions, saved filters, cleanup rules) and let the user pick one by number or by exact name. When such a parser checks the cancel words **before** it matches the offered options, any live value whose name is also a cancel word can never be picked by name. `Cancelled` is a common real Jira workflow status and resolution, so this is not a theoretical collision.

The bug has now appeared twice:

1. **PR #36 (2026-08-21).** Broadening the cancel list made three parsers (`parseIssueTypeSelection`, `parseTemplateSelection`, `parseFilterSelection`) swallow a type, template, or filter named `Stop`. Fixed by reordering. The first two parsers no longer exist in the current tree; `parseFilterSelection` (`src/participant/sessionState.ts:772-786`) still carries the fix.
2. **PR #71 (2026-09-27).** The new stale-ticket close flow added `parseStaleTargetPick` and `parseStaleIssueTypePick`, written cancel-first from the start, so a workflow status named `Cancelled` or an issue type named `Stop` could not be chosen. Fixed by reordering in the same PR, after `ce-code-review` flagged it.

The second occurrence did not come from broadening the list. A parser written weeks after this learning existed repeated the same order. So the risk is not "someone grows the word list". It is "someone writes a new pick-list parser".

## Symptoms

- A workflow status named `Cancelled`, or an issue type named `Stop`, typed by name at the stale close's target or issue-type step, returned to the Stale screen instead of picking it (pre-PR #71).
- An issue type, template, or saved filter named `Stop` typed by name cancelled the flow (pre-PR #36).
- The numbered chip for the same option works, because `buildChatCommandLink` chips resubmit the option's number (e.g. `src/participant/JiraParticipant.ts:302`, `src/participant/jira/reportImportHandler.ts:567`). The failure needs the user to type the name, which is exactly what the prompts invite ("Reply with the number or name").
- `npm test` and `npm run compile` stay green: no fixture uses a colliding name.

## What Didn't Work

- **Keying prevention to "when broadening the word list".** The first version of this learning told reviewers to audit callers whenever the shared list grows. The list has not grown since, yet three more parsers were written cancel-first afterwards: `parseGuidedTransitionStatusPick` / `parseGuidedTransitionResolutionPick` (guided "Transition it" flow, 2026-09-10), `parseIssueTypePick` (template-generation flow), and the stale close's two pick parsers (PR #71). The trigger that matters is writing any new parser that takes a live option list.
- **A shared option matcher that leaves the order to each caller.** `pickByNumberOrName()` (`src/participant/sessionState.ts:317-322`) was extracted to share number-or-name matching, but it returns `undefined` on no match and leaves the cancel check to the caller. Every caller still decides the order, and several got it wrong.
- **Per-word carve-outs.** Until the 2026-09-29 fix, the stale close's resolution step (`src/participant/jira/reportImportHandler.ts`) ran `isBackOrCancellation(reply) && reply.trim().toLowerCase() !== 'skip'` before `parseResolutionSelection`. That special-cased one word (`skip` there means "no resolution") and left every other collision open: a resolution named `Cancelled` went back instead. This is the pattern PR #36 explicitly rejected.
- **Planning reviews and the test suite.** Neither caught either occurrence. Both were caught by a dedicated post-implementation `ce-code-review` pass (PR #71's description lists it as one of two confirmed findings fixed before merge).

## Solution

Match the offered options first. Only if nothing matched, treat the reply as cancel/back. Otherwise report it as invalid. Do not special-case individual words.

PR #71's stale target pick, before:

```ts
export function parseStaleTargetPick(reply: string, options: StaleTargetOption[]): StaleTargetOption | 'back' | 'invalid' {
  if (isBackOrCancellation(reply)) return 'back';
  return pickByNumberOrName(reply, options, formatStaleTargetOption)
    ?? options.find(o => o.kind === 'rule' && o.ruleName.toLowerCase() === reply.trim().toLowerCase())
    ?? 'invalid';
}
```

After (`src/participant/sessionState.ts:2208-2213`):

```ts
export function parseStaleTargetPick(reply: string, options: StaleTargetOption[]): StaleTargetOption | 'back' | 'invalid' {
  const picked = pickByNumberOrName(reply, options, formatStaleTargetOption)
    ?? options.find(o => o.kind === 'rule' && o.ruleName.toLowerCase() === reply.trim().toLowerCase());
  if (picked) return picked;
  return isBackOrCancellation(reply) ? 'back' : 'invalid';
}
```

`parseStaleIssueTypePick` (`:2217-2221`) got the same reordering. Regression tests: `src/test/sessionState.test.ts:1534-1538` (a `Cancelled` status stays pickable while a bare `cancel` still goes back) and `:1554-1556` (an issue type named `Stop`).

PR #36 applied the same reordering to `parseFilterSelection` (still in the tree at `src/participant/sessionState.ts:772-786`, tests at `src/test/JiraParticipant.test.ts:565-568` and `:607-612`) and to the since-removed `parseIssueTypeSelection` / `parseTemplateSelection`. `parseConstraintMatchSelection` (`src/participant/sessionState.ts:988-1003`) was written label-first following the same rule.

For **free-text asks**, where the reply is not matched against a list at all (a new template name, a typed issue type), the codebase uses a second remedy: only the literal `(c)` cancels, via `isExplicitCancelToken()` (`src/participant/sessionState.ts:594-603`, "KTD3"), so `Stop` stays enterable as a value. The chat-based issue-type ask in `src/participant/jira/ticketContext.ts:105` uses it too.

### Remaining instances, fixed 2026-09-29

A sweep of the tree on 2026-09-28 found four more places still cancel-first. Each took a live Jira list and prompted "reply with the number or name", so clicking the numbered chip worked but typing the name did not:

| Parser | Live list | Colliding value that failed by name |
| --- | --- | --- |
| `parseGuidedTransitionStatusPick` | workflow statuses | `Cancelled` |
| `parseGuidedTransitionResolutionPick` | the transition's resolutions | `Cancelled` |
| `parseIssueTypePick` | project issue types | `Stop` |
| stale close, pick-resolution step (`reportImportHandler.ts`) | resolutions | any cancel word except `skip` |

All four were reordered options-first on 2026-09-29, in the follow-up to PR #73 (branch `claude/cancel-word-option-precedence`). The resolution step now runs `parseResolutionSelection` first (it already maps `none`/`skip` to "no resolution", `src/participant/sessionState.ts:324-328`) and only treats back/cancel words as "go back" when that finds nothing, so the `skip` carve-out is gone. Each fix has a collision test (`Cancelled` or `Stop`) plus a check that a plain cancel word still cancels.

After that fix, the audit command under Prevention finds only `parseGuidedTransitionPathPick`, which matches route numbers only and has no name to collide.

## Why This Works

A live option the user can see is more specific than membership in a generic word list. If `Cancelled` is on screen as a status and the user types `Cancelled`, they almost certainly mean the status. Checking the options first honours that. A reply that matches nothing still reaches the cancel/back check, so `cancel`, `stop`, and `back` keep working whenever no offered option has that name.

The hazard persists because cancel handling and option matching live in separate helpers (`isCancellation`/`isBackOrCancellation` versus `pickByNumberOrName`). Each new parser re-combines them, and the cancel-first order reads naturally ("handle the escape hatch, then the real work"). Nothing in the type system or the test suite pushes back.

## Prevention

- **Trigger: writing or reviewing any parser that takes a live option list and also accepts a cancel/back word.** Growing the word list is only one way in. Ask: "What happens when a real option is named `Cancelled`, `Stop`, or `Skip`?"
- **Audit command.** Find parsers that check cancel words before options:

  ```bash
  grep -n -A2 "if (isCancellation(reply))\|if (isBackOrCancellation(reply))" src/participant/sessionState.ts src/participant/jira/*.ts
  ```

  Any hit followed by `pickByNumberOrName(...)` or an `options.find(...)` name match is this bug.
- **Standing test case.** For every such parser, add a test with an option literally named like a cancel word. Prefer `Cancelled` for statuses and resolutions, since it is a real Jira default in many instances, and `Stop` for issue types, templates, and filters. Assert that the exact and lower-cased name resolve to the option, and that a bare `cancel` or `back` still cancels. Model: `src/test/sessionState.test.ts:1534-1538`.
- **Free-text asks use `isExplicitCancelToken()`**, not `isCancellation()`, when the value itself could plausibly be a cancel word.
- **No per-word exceptions.** A `!== 'skip'` style guard fixes one word and hides the rest.
- **Structural option (not yet done).** A single helper that takes the options plus the cancel predicate and always matches options first would remove the per-caller ordering decision that has gone wrong in every round listed above. The same principle applies to any shared generic classifier matched against live data, such as redaction key patterns in `src/utils/logRedaction.ts`: specific live-data match first, generic classification second.

## Related Issues

- **Moderate overlap** with [`redaction-substring-match-false-positives.md`](redaction-substring-match-false-positives.md): both are "a generic matcher claims a legitimate value". That one was a matcher that was too loose (fixed by tightening it); this one is a check-ordering problem (fixed by reordering). Read them together.
- First fix: [PR #36](https://github.com/rbreunung/ticket-sidekick/pull/36) (branch `fix/jira-chat-ux-consistency`), merged 2026-08-21.
- Recurrence fix: [PR #71](https://github.com/rbreunung/ticket-sidekick/pull/71) (stale-ticket target pick), merged 2026-09-27. Its `parseStaleTargetPick` doc comment links back to this file.
