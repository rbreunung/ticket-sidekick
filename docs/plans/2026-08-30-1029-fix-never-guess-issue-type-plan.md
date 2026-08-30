---
title: "Issue-Type Guessing Fix - Plan"
type: fix
date: 2026-08-30
topic: never-guess-issue-type
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Issue-Type Guessing Fix - Plan

## Goal Capsule

- **Objective:** Every ticket `@jira` creates carries an issue type the user chose or explicitly typed — never one the extension invented.
- **Means:** Generalize the sentinel-based "never guess" fix already used by the create-ticket list to the other ticket-creation entry points.
- **Product authority:** Not creating a ticket with a fabricated type outranks convenience — when a type can't be resolved, surfacing that gap to the user always wins over proceeding silently. This plan owns the issue-type-guessing fix only; the broader "easier onboarding for new users" idea is not active scope here (see How This Work Fits Together).
- **Open blockers:** None.

---

## Product Contract

### Summary

Generalizes the create-ticket list's "never fabricate an issue type" fix to the email-import and Veracode/Waltz report-import ticket-creation flows, so every entry point that creates a Jira ticket either offers a real, fetched issue type or explicitly asks the user to specify one.

### Problem Frame

The create-ticket list used to silently default an unresolvable issue type to the literal `'Task'` — a project without that type got an opaque Jira 400, one that happened to have it got a ticket with a possibly-wrong type, silently. That was fixed by introducing an explicit "no resolvable type" sentinel that forces the user to type a value instead.

The same anti-pattern is still present in the other places `@jira` creates tickets, surfaced while auditing changes since the `0.4.6` release: the shared default-issue-type resolution (used by email import) falls back to the literal `'Story'`, and the Veracode/Waltz report importer falls back to the literal `'Bug'`. Left as-is, these flows either create the wrong kind of ticket or fail with an opaque Jira error — with nothing telling the user the type was fabricated rather than real.

### Requirements

R1. When a ticket-creation flow cannot resolve a real issue type for a project (no template default, and the project's issue-type list could not be fetched), it must never submit a fabricated type — it must clearly indicate to the user that a type still needs to be specified.

R2. Whenever a flow already presents a way to choose an issue type (a numbered list of templates/types), the "type not yet resolved" case renders in that same list as an explicit, distinct action item — not as a normal-looking selectable value.

R3. When resolution fails before any such list is on screen, the user must still get a way to type the issue type explicitly before the ticket is created — never a silent guess, and never a dead end with no way to specify one.

R4. This applies to every remaining place `@jira` creates a ticket: email import — both the command-palette trigger and the `@jira create from email` chat continuation — and the Veracode/Waltz report-import review flow.

R5. No ticket is ever created carrying an issue type the code invented rather than one the user chose from a real list or typed explicitly.

### Key Decisions

- **Never guess an issue type — always tell the user what's missing.** A fabricated type either creates the wrong kind of ticket or fails with an opaque Jira error, with nothing indicating it wasn't real. (session-settled: user-directed — chosen over silently defaulting to `'Story'`/`'Bug'`: guessing produces a wrong or opaquely-rejected ticket with no visible indication anything was fabricated.) Governs R1, R5.
- **Extend the existing "type not resolved" list pattern rather than invent a new one.** The create-ticket list already proved out an explicit-sentinel approach; the email and report-import flows already show the same style of numbered template/type list, so the fix reuses that shape instead of adding a different UX per flow. Governs R2, R3.

### Actors

- A1. The user creating a ticket through `@jira` (chat flow or a VS Code command-palette action).
- A2. The Jira project's configured issue types, fetched from the Jira API — the only source of a real, valid type alongside a template's own configured default.

### Key Flows

- F1. **Email import — command-palette trigger**
  - **Trigger:** User runs the "Import Email" command from the VS Code command palette.
  - **Actors:** A1, A2
  - **Steps:** The extension resolves the default project, matching templates, and the project's available issue types, then opens the chat continuation (F2).
  - **Outcome:** If no real type is resolvable at this point, the session carries that as an explicit unresolved state, never a guessed value — F2 is responsible for surfacing it to the user.
  - **Covers:** R1, R3, R4

- F2. **Email import — chat continuation** (`@jira create from email`)
  - **Trigger:** F1 completes, or the user runs `@jira create from email` directly with a pre-loaded session.
  - **Actors:** A1, A2
  - **Steps:** The chat renders the existing numbered templates/types list; when the type is unresolved, the list shows an explicit "you'll be asked to type it" entry instead of a plausible-looking type name; picking it prompts the user to type the issue type before the ticket is created.
  - **Outcome:** The ticket is created only once a real, user-chosen or user-typed type exists.
  - **Covers:** R2, R3, R4, R5

- F3. **Veracode/Waltz report-import review**
  - **Trigger:** User imports a Veracode or Waltz report and reaches the template/issue-type review screen.
  - **Actors:** A1, A2
  - **Steps:** The review screen's numbered templates/types list applies the same unresolved-type sentinel as F2, rather than silently offering only `'Bug'` when the project's issue-type fetch fails.
  - **Outcome:** Every ticket created from the batch carries a real, user-selected or user-typed type.
  - **Covers:** R1, R2, R4, R5

### Acceptance Examples

- AE1. **Given** a project whose issue-type fetch fails and a template with no configured type, **when** the user starts email import via the command palette, **then** the resulting chat message never states a specific type as fact — it shows the "you'll need to specify it" indicator and lets the user type one in. Covers R1, R2, R3.
- AE2. **Given** the Veracode/Waltz report-import review screen where the issue-type fetch failed and no template configures a type, **when** the review list renders, **then** it shows an explicit "type it in" entry instead of silently offering only `'Bug'`. Covers R1, R2.
- AE3. **Given** the user picks the "type it" entry in any of these lists, **when** they submit a value, **then** that typed value becomes the ticket's issue type — the flow never falls back to a hardcoded default afterward. Covers R3, R5.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan owns the issue-type-guessing fix only. The broader "easier onboarding for new users" idea is the current understanding of related future work, not a committed roadmap:

- Easier onboarding for new users (command-completion suggestions, inline help text, discovery affordances)
  - Can proceed independently of this plan — different surface entirely (command/help discoverability, not ticket-creation correctness)
  - Shares the underlying goal of making `@jira`/`@bitbucket` clearer to newcomers
  - Still to decide: which commands/surfaces it covers, and how it's explored — planned as a separate brainstorm right after this one

### Scope Boundaries

- Out of scope: the broader "easier onboarding for new users" idea (command completion, help text, discovery affordances) — see How This Work Fits Together.
- Out of scope: which issue types are considered valid or available — that still comes entirely from the Jira project fetch and template configuration; this plan only changes what happens when that source comes up empty.
- Out of scope: template definitions themselves (`.jira-templates.json` shape, resolution rules).

### Sources / Research

- `docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md` — the original sentinel-based fix and its rationale; this plan generalizes the same approach.
- `docs/plans/2026-08-24-2201-refactor-align-create-issuetype-list-plan.md` — the implementation plan the original fix was built from.
- `src/participant/jira/createHandler.ts:193-195,279-286` and `src/participant/JiraParticipant.ts:254-258` — the exact sentinel-render (`label()`) and synchronous `showInputBox` detour pattern every unit below reuses verbatim.
- Verified during planning (still accurate, unchanged since the brainstorm): `src/participant/sessionState.ts:429-434` (`selectDefaultIssueType`'s final `?? 'Story'`), `src/extension.ts:260,275,279`, `src/participant/jira/emailHandler.ts:14,41,123,152,184` (list-building and `handleEmailContentSession`'s two `finishEmailTicket` call sites at `:314,320`, plus the list-less bare-confirm message at `:422-423`), and `src/participant/jira/reportImportHandler.ts:126,141,152` (list-building) and `:240-246` (`handleImportTemplateSelection`'s `pick` resolution, before the dedup/review pipeline starts). `src/participant/jira/veracodeHandler.ts:73-77` carries its own copy of the same stale "will default to 'Bug'" wording, wired through `reportImportHandler.ts`'s shared `ReportImportDescriptor` as `onIssueTypeFetchFailed` rather than sharing code with `reportImportHandler.ts:141`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **`selectDefaultIssueType`'s final fallback becomes the `''` sentinel, not `'Story'`.** The function already prefers a real fetched type when one exists; only its last resort — nothing resolvable from any source — changes, so it returns the same "no resolvable type" signal `createHandler.ts`'s list already uses instead of a guess. Governs R1, R5.
- KTD2. **Every list-building call site's hardcoded-literal fallback (`'Story'`, `'Bug'`) becomes `''`**, mirroring `createHandler.ts`'s own `t.issueType ?? issueTypes[0] ?? ''` chain exactly — not a new fallback shape per call site. Governs R1, R2.
- KTD3. **List rendering reuses `createHandler.ts`'s exact `label()` mapping** (`issueType === '' ? '_you will be asked to type it_' : issueType`) wherever a template/type list is shown, so the sentinel never appears as a plausible-looking value in either flow's UI. Governs R2.
- KTD4. **The "type it" detour is a synchronous `vscode.window.showInputBox` call at the point a resolved type is about to be used** — the exact mechanism `JiraParticipant.ts`'s routing block already uses for the create-ticket list — not a new multi-turn session or workspaceState key. This keeps the fix a direct application of the existing pattern rather than a second implementation of "ask for a value." Governs R3, R5.
- KTD5. **A flow with no list to show at all (email import's "nothing to pick from" bare-confirm path) detours to the input box immediately**, the same way `createHandler.ts`'s own "both templates and issue types are completely empty" case already does, rather than ever rendering the sentinel as a stated fact in a message with no list around it. Governs R3.

### Assumptions

- Beyond the one reordering U1 calls out (moving each `issueTypes` fetch above its `availableTemplates` build, see U1 step 2), none of the four call sites' surrounding control flow needs restructuring — each already has a natural point (a list-building step, a pick-resolution step, a pre-creation step) that maps directly onto `createHandler.ts`'s proven shape.

---

## Implementation Units

### U1. Never-guess default resolution

- **Goal:** Make the shared default-issue-type helper and every list-building call site fall back to the `''` sentinel instead of a hardcoded literal.
- **Requirements:** R1, R2, R4
- **Dependencies:** None
- **Files:** `src/participant/sessionState.ts`, `src/extension.ts`, `src/participant/jira/emailHandler.ts`, `src/participant/jira/reportImportHandler.ts`, `src/participant/jira/veracodeHandler.ts`, `src/test/JiraParticipant.test.ts` (or wherever `selectDefaultIssueType`'s existing tests live — confirm the actual path before adding to it)
- **Approach:**
  1. `selectDefaultIssueType` (`sessionState.ts:429-434`): change the final `?? 'Story'` to `?? ''` (KTD1).
  2. `extension.ts:260`, `emailHandler.ts:152`, `reportImportHandler.ts:126`: change each `t.issueType ?? 'Story'`/`'Bug'` to `t.issueType ?? issueTypes[0] ?? ''`, matching `createHandler.ts`'s exact chain (KTD2). In all three files this `availableTemplates` block currently runs *before* `issueTypes` is fetched/declared later in the same function (`extension.ts:269`, `emailHandler.ts:161`, `reportImportHandler.ts:135`) — unlike `createHandler.ts`, where `issueTypes` is fetched first (`:256`) and consumed later (`:294`). Move each file's `issueTypes` fetch above its `availableTemplates` build so the new fallback chain can reference an already-declared `issueTypes`, mirroring `createHandler.ts`'s order; this reordering carries no behavior change beyond execution order. `extension.ts:275`'s `showWarningMessage` wording ("will default to 'Story'") and `reportImportHandler.ts:141`'s log message ("defaulting to 'Bug'") no longer describe real behavior — update or drop both now that nothing is defaulted.
  3. `reportImportHandler.ts:152`'s `issueTypes.length > 0 ? issueTypes : ['Bug']` becomes `issueTypes.length > 0 ? issueTypes : ['']`, matching `createHandler.ts`'s `issueTypes: issueTypes.length > 0 ? issueTypes : ['']` treatment exactly.
  4. `veracodeHandler.ts:73-77`'s `onIssueTypeFetchFailed` callback shows its own `showWarningMessage` reading "...will default to 'Bug'. ..." — this is a second, independent copy of the same stale wording `reportImportHandler.ts:141` carries (wired through the shared `ReportImportDescriptor`, not shared code with it). Update it the same way.
- **Test scenarios:**
  - Happy path: `selectDefaultIssueType(['Story', 'Task'])` still returns `'Story'` — real values are preferred exactly as before; only the empty-input case changes.
  - Edge case: `selectDefaultIssueType([])` returns `''`, not `'Story'`.
  - Edge case: a template with no configured `issueType` and an empty fetched-types list produces `''` at each of the three list-building call sites, not the old literal.
- **Verification:** No caller yet handles the new `''` values specially — that's U2/U3's job. This unit only proves the value itself changed, via unit tests on `selectDefaultIssueType` and the three list-building expressions in isolation; `npm run compile` proves the reordering didn't leave a use-before-declaration.

### U2. Email-import: sentinel rendering and detour

- **Goal:** `@jira create from email` (both the command-palette trigger and the chat continuation) never states a fabricated type as fact, and always gives the user a way to type one when nothing resolved.
- **Requirements:** R1, R2, R3, R5
- **Dependencies:** U1
- **Files:** `src/participant/jira/emailHandler.ts`, its test file (confirm actual path — likely `src/test/JiraParticipant.test.ts` or a dedicated `emailHandler`-adjacent suite; match this codebase's existing convention rather than assuming)
- **Approach:**
  1. Wherever `streamEmailContentPreview` (or its list-building helper) renders `availableTemplates`/`availableIssueTypes` as a numbered list, apply KTD3's `label()` mapping to each entry.
  2. `streamEmailContentPreview`'s prompt (`:421-423`) interpolates `session.issueType` in *both* ternary branches, not just the list-less one: the `hasOptions` true branch (`:422`, shown whenever templates and/or issue types exist) and the `hasOptions` false branch (`:423`). When `session.issueType === ''`, the false branch is KTD5's list-less case — skip the message entirely and go straight to the `showInputBox` detour (KTD4). The true branch still needs its own fix even though a numbered list is present: replace `**${session.issueType}**` with the same "you'll be asked to type it" wording used in the list (KTD3) rather than interpolating the blank sentinel, since a failed issue-type fetch alongside existing templates leaves `session.issueType === ''` with `hasOptions` true. Neither branch should ever render the sentinel into the "create the ticket... as `<type>`" wording.
  3. `handleEmailContentSession`'s two points where a resolved `issueType` is about to reach `finishEmailTicket` (`:314` after a pick, `:320` after a bare confirm): before each call, check for `issueType === ''` and detour to the input box first — same shape as `JiraParticipant.ts:254-258`'s existing block — using the typed value (or cancelling, matching the existing "no issue type provided — cancelled" wording) instead of proceeding with `''`.
- **Test scenarios:**
  - Happy path: a numbered list with a sentinel entry renders it as "_you will be asked to type it_", not blank or a guessed name.
  - Edge case: the list-less path with `session.issueType === ''` shows the input-box prompt instead of a message stating a fake type.
  - Edge case: a numbered list is present (templates exist) but the issue-type fetch failed, so `session.issueType === ''` with `hasOptions` true — the prompt shows the "you'll be asked to type it" wording instead of an empty/blank interpolated type.
  - Edge case: picking the sentinel entry from the numbered list opens the input box; a typed value flows through to `finishEmailTicket` unchanged; an empty/cancelled input box cancels the flow with a clear message, never falls back to a guess.
  - Edge case: a bare "post it" confirm when `session.issueType === ''` also detours to the input box, not straight to `finishEmailTicket`.
  - Integration scenario: a template with a real configured `issueType` (never `''`) is entirely unaffected — no new prompt appears when a real value was already resolved.
- **Execution note:** The pure list-rendering/label logic (if factored into `sessionState.ts` alongside `pickEmailOption`) gets full Vitest coverage; the `vscode`-coupled `showInputBox` detour itself is best caught by a `/code-review` pass on the finished diff, per this codebase's documented precedent for this class of code (`docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md`).

### U3. Report-import: sentinel rendering and detour

- **Goal:** The Veracode/Waltz report-import review flow never fabricates a type for its batch, and always gives the user a way to type one before any ticket in the batch is created.
- **Requirements:** R1, R2, R4, R5
- **Dependencies:** U1
- **Files:** `src/participant/jira/reportImportHandler.ts`, its test file (match this codebase's existing convention for this file's tests)
- **Approach:**
  1. `streamImportTemplateSelection`: apply KTD3's `label()` mapping to the rendered `availableTemplates`/`availableIssueTypes` list, same as U2 step 1.
  2. `handleImportTemplateSelection`: right after `pick` resolves (`:240`) and before the dedup/review pipeline starts, check `pick.issueType === ''` and detour to the input box (KTD4) — the whole batch shares this one resolved type, so this single point covers every row; nothing downstream (dedup search, review table, `executeImportBatch`) needs its own sentinel awareness.
- **Test scenarios:**
  - Happy path: a numbered list with a sentinel entry renders it as "_you will be asked to type it_" (mirrors AE2).
  - Edge case: picking the sentinel entry (or a bare confirm resolving to it) opens the input box before any dedup search or review-table work happens; a typed value becomes the batch's `issueType`; a cancelled input box cancels the whole import with a clear message.
  - Integration scenario: `executeImportBatch` and the review table receive only a real, non-empty `issueType` — never called with `''`.
- **Execution note:** Same testing split as U2 — pure logic gets Vitest coverage; the `vscode`-coupled detour is a `/code-review` target.

---

## Verification Contract

| Command | Applies to | What it proves |
|---|---|---|
| `npm run compile` | All units | TypeScript type-checks clean. |
| `npm test` | U1 fully; the pure-logic portions of U2, U3 | Vitest unit coverage — must be green before commit, per CLAUDE.md. |
| `/code-review` pass | U2, U3 | This codebase's documented load-bearing check for `vscode`-coupled flow code (see each unit's Execution note). |

---

## Definition of Done

- All three units implemented; `npm run compile` and `npm test` green.
- A `/code-review` pass run on the finished diff before merge.
- No email-import or report-import flow ever creates a ticket carrying a fabricated issue type — confirmed by AE1-AE3 holding for both flows, not just the original create-ticket list.
- No dead or experimental code left from approaches that didn't pan out.
