---
title: New vitest vscode-mock architecture built before checking the codebase's existing per-test-file convention
date: 2026-09-04
category: workflow-issues
module: testing/vscode-dependent-file-coverage
problem_type: workflow_issue
component: testing_framework
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: low
related_components: [TicketService, loadHandler, "vitest.config.ts"]
tags: [vitest, vscode-mock, testing-convention, simplify, reuse, load-ticket-parity]
---

# New vitest vscode-mock architecture built before checking the codebase's existing per-test-file convention

## Context

`ticket-sidekick` has a structural fact that recurs on nearly every feature that touches a Jira/Bitbucket chat handler: files like `src/participant/jira/*Handler.ts` and `ConfigService.ts` legitimately need to import `vscode`, but `vscode` is not a resolvable module under plain Vitest — it only exists inside the VS Code extension host. `CLAUDE.md`'s "Testing" section documents the consequence at a high level (`JiraParticipant.ts`/`BitbucketParticipant.ts` "cannot be loaded by Vitest" and are "covered by the e2e suite only"), but it stops there. It does not document the mechanical pattern for the much more common case: a handler file imports `vscode` for one or two small things (an output channel, a workspace folder path) but otherwise contains pure, well-worth-unit-testing logic.

That gap surfaced during the "load ticket entry-point parity" work (`docs/plans/2026-09-02-2247-feat-load-ticket-parity-plan.md`, shipped as PR #48). The plan's own doc-review phase raised a legitimate concern — the newly extracted `loadTicketToWorkspace` core (in `src/participant/jira/loadHandler.ts`) had no coverage beyond manual/e2e checks — and the session's answer, written into the plan itself as a Key Technical Decision before implementation began, was to build the repo's *first* `vscode` mock: a standalone `src/test/mocks/vscode.ts` stub module (since deleted — see Guidance below), aliased in via a new `resolve.alias` entry in `vitest.config.ts`, explicitly modeled on the existing `MockJiraClient`/`MockBitbucketClient` pattern *(session history)*. That analogy was the gap: `MockJiraClient`/`MockBitbucketClient` mock the app's own client **interfaces**, not the third-party `vscode` module, and nobody searched the test suite for an existing `vscode`-mocking convention before designing the new mechanism. The plan's own doc-review pass (which dispatches coherence/feasibility/adversarial reviewer subagents) approved the decision as originally proposed *(session history)* — it, too, didn't catch the missing convention search.

Implementation followed the plan as written: `vitest.config.ts` gained the alias, `src/test/mocks/vscode.ts` was written (needing one follow-up patch, for a missing `window.appendLine` stub, before it passed), and `src/test/loadTicketCore.test.ts` was written against that global stub. `npm test` and `npm run compile` were both green, and this was committed as part of implementation unit U2 *(session history)*.

## Guidance

**Before adding any new mocking mechanism for a `vscode`-importing file, grep the existing test suite for `vi.mock('vscode'` first.** `ticket-sidekick` already has a working, in-use convention: a **local, per-test-file `vi.mock('vscode', () => ({ ... }))`**, scoped to only the slice of the `vscode` API surface that file's unit under test actually touches. When the mock needs mutable state shared between the mock factory (which Vitest hoists above all imports) and the test bodies, wrap that state in `vi.hoisted()`.

This convention wasn't found until the post-implementation `/simplify` pass, run before code review as part of the standard shipping workflow. One of `/simplify`'s parallel review angles — a reuse-focused pass — flagged that the codebase already has this exact convention, in active use by `src/test/reportImportHandler.test.ts`, `src/test/cleanupHandler.test.ts`, and several other handler test files. The session verified the finding directly (`grep -rln "vi.mock('vscode'" src/test/*.ts`, then reading `reportImportHandler.test.ts` and `JiraParticipant.test.ts`), confirmed it was real and load-bearing (those tests genuinely exercise real `vscode`-importing handler code, not a trivial no-op), and corrected course *(session history)*: rewrote `loadTicketCore.test.ts` to use the local `vi.mock` pattern, deleted `src/test/mocks/vscode.ts` entirely, and reverted `vitest.config.ts` to its pre-alias shape. The targeted tests plus the full suite were re-run green before the fix was committed.

Minimal example, from `src/test/cleanupHandler.test.ts:3-8` (testing `src/participant/jira/cleanupHandler.ts`, which imports `vscode`):

```ts
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
}));
```

That's the whole mock — just the two properties (`workspace.workspaceFolders`, `window.createOutputChannel`) the handler code path under test actually reads. `src/test/reportImportHandler.test.ts:3` uses the identical top-level `vi.mock('vscode', () => ({ ... }))` shape (its own mock has no `workspace.fs` and needs no `vi.hoisted()`, since the file it tests doesn't touch the filesystem). `src/test/loadTicketCore.test.ts` itself is the precedent for the `vi.hoisted()` + in-memory-filesystem shape: it declares `const { fakeFiles, resetFakeFiles } = vi.hoisted(() => { const files = new Map<string, Uint8Array>(); ...})` and implements `workspace.fs.createDirectory`/`writeFile`/`readFile` against that shared map, so the mock factory (hoisted above imports) and the test bodies (seeding/asserting against `fakeFiles`) can both reach the same state — reach for that same shape whenever a test needs shared mutable mock state, whether or not an existing file happens to demonstrate it yet.

**Don't:**
- Add a `resolve.alias` for `vscode` (or any other hard-to-mock module) to `vitest.config.ts`.
- Create a new standalone `src/test/mocks/<module>.ts` stub module that every test file is meant to share.

**Do:**
- `vi.mock('vscode', () => ({ ... }))` at the top of the one test file that needs it, containing only the properties that file's code path touches.
- Reach for `vi.hoisted()` only when the mock factory and the test body both need to read/write the same mutable state (e.g., a `Map<string, Uint8Array>` standing in for a fake filesystem).

## Why This Matters

- **A global alias/stub couples every test file to one shared, ever-growing fake `vscode` surface.** Each new handler that needs a slightly different corner of the `vscode` API either bloats the shared stub or forces awkward overrides per test file — a maintenance burden that grows with every feature, and a source of test-to-test coupling (one handler's needs shape a module every other test file also depends on).
- **The local-mock convention keeps each test file's `vscode` surface minimal and legible.** A reader of `cleanupHandler.test.ts` can see, in six lines at the top of the file, exactly what `vscode` API the unit under test needs — no cross-referencing a shared stub file to know what's real versus mocked.
- **Inventing a second, parallel mechanism when one already works means the codebase now has two ways to do the same thing** — exactly what the mandatory `/simplify` pass's reuse-focused review angle exists to catch. It did catch it here, but only after the plan had already committed to the new mechanism (and doc-review had approved it), the alias, the stub module, and a full test file had all already been written, and the whole thing had to be reverted and rewritten. A convention search costing a few seconds is strictly cheaper than an implementation-plus-review round trip to undo the wrong one.
- **Doc-review approving a plan-level decision doesn't substitute for a convention search.** The reviewer subagents evaluated the KTD8 decision as internally coherent and feasible; none of them were positioned to know the repo already had a working alternative unless the search was actually run and surfaced in the plan. The check that actually caught this was `/simplify`'s reuse angle working directly against the tree, after implementation — not the earlier planning-stage review.

## When to Apply

Any time new Vitest coverage is needed for a function/module that imports `vscode` — most commonly a new or extended handler in `src/participant/jira/*Handler.ts` (or a Bitbucket equivalent), or new logic added to `ConfigService.ts`. This does **not** apply to `TicketService.ts`, `PrReviewService.ts`, `JiraApiClient.ts`, or `BitbucketApiClient.ts` — those four are deliberately kept `vscode`-free (per `CLAUDE.md`'s `onDiag`-injection pattern) precisely so they need no `vscode` mock at all; the local-`vi.mock('vscode', ...)` convention is for the participant/handler layer specifically.

More generally, the underlying habit generalizes beyond `vscode`: **before building any new test infrastructure (a mock, a fixture helper, a stub module) — and ideally before writing it into a plan's Key Technical Decisions at all — grep the existing test suite for the mechanism you're about to invent.** In a codebase this size, there is very likely already a convention; reusing it is faster than building a new one, and a new one competing with an existing convention is exactly the kind of thing `/simplify`'s reuse angle will flag, but catching it post-implementation costs an implementation-plus-review round trip that catching it at planning time would not.

## Examples

- `src/test/cleanupHandler.test.ts:3-8` — the paste-worthy minimal example: a local `vi.mock('vscode', () => ({...}))` exposing only `workspace.workspaceFolders` and `window.createOutputChannel`.
- `src/test/reportImportHandler.test.ts:3` — same top-level `vi.mock('vscode', ...)` shape, without `vi.hoisted()` (that file's unit under test doesn't touch the filesystem, so its mock doesn't need shared mutable state).
- `src/test/loadTicketCore.test.ts` — the precedent for the `vi.hoisted()` + in-memory-fake-filesystem shape (a `Map<string, Uint8Array>` shared between the mock's `workspace.fs` implementation and the test bodies), needed for `loadTicketToWorkspace`'s `readFile`/`writeFile`/`createDirectory` calls.
- Other handler test files following the same convention: `src/test/emailHandler.test.ts`, `src/test/fieldHandler.test.ts`, `src/test/contentHandler.test.ts`, `src/test/JiraParticipant.test.ts`, `src/test/ConfigService.test.ts`, `src/test/llmHelpers.test.ts`.
- What not to do, and what was reverted: a `resolve.alias` entry in `vitest.config.ts` mapping `vscode` to a stub, and a standalone `src/test/mocks/vscode.ts` module. Both were removed; `src/test/loadTicketCore.test.ts` was rewritten to use a local `vi.mock('vscode', () => ({...}))` with `vi.hoisted()` for its fake-file-map state, matching the `reportImportHandler.test.ts` shape.
- Quick lookup command for the next implementer facing this fork: `grep -rn "vi.mock('vscode'" src/test/` — find the nearest existing example, copy its shape, trim the mocked surface to only what the new unit under test touches.

This correction shipped in PR #48 (the "load-ticket-parity" plan's implementation) on `rbreunung/ticket-sidekick`. It was purely a test-architecture fix — no product code changed. `npm test` and `npm run compile` were green both before and after the correction; the tests exercising `loadTicketToWorkspace` continued to pass, now via the local-mock pattern instead of the global alias.

## Related

- [`docs/solutions/logic-errors/cleanup-review-table-issue-keys-not-linked-unlike-every-other-review-table.md`](../logic-errors/cleanup-review-table-issue-keys-not-linked-unlike-every-other-review-table.md) — shares the same abstract lesson (an existing codebase convention wasn't checked/applied before building something new), but is otherwise unrelated in concrete subject: this one is a knowledge-track finding about test-mocking infrastructure, caught before shipping; that one is a bug-track finding about a UI-rendering helper (`formatKeyLink()`), shipped to `main` and caught afterward.
- [`docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md`](doc-consolidation-unverified-destination-coverage-assumption.md) — shares this directory and the same abstract shape (proceeding on an unverified assumption — there, that a destination doc already covered some content; here, that no existing test-mocking convention existed — instead of checking first), but the concrete subject (documentation consolidation) is unrelated to testing conventions.
- This directory's other docs (`github-remote-not-named-origin.md`, `subagent-write-tool-silently-fails-on-posix-tmp-path-on-windows.md`) address unrelated failure classes (git remote naming, Windows path translation across a tool-call boundary) and are not otherwise related to this learning.
