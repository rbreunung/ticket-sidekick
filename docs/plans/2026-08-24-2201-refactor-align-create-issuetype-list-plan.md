---
title: Align Create-Ticket Template and Issue-Type Selection - Plan
type: refactor
date: 2026-08-24
topic: align-create-issuetype-list
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Align Create-Ticket Template and Issue-Type Selection - Plan

## Goal Capsule

- **Objective:** `@jira create` always presents one combined, predictable selection step — templates and issue types together — instead of sometimes showing only a template list and sometimes showing a template list followed by a separate issue-type list.
- **Means:** Merge the two sequential prompts into a single numbered list (templates first, then remaining issue types), reusing the list shape and selection mechanics the Veracode/Waltz report-import flow already uses (KTD1).
- **Product authority:** Repo owner, established in the source brainstorm dialogue.
- **Open blockers:** None.

---

## Product Contract

### Summary

Replace `@jira create`'s conditional two-step selection (a template list, then sometimes a separate issue-type list when the template or prompt didn't already pin one down) with a single combined numbered list of templates followed by remaining issue types, always requiring an explicit numbered pick — the same shape the Veracode/Waltz report-import flow already presents.

### Problem Frame

Today, `handleCreateTicket` shows the template list first, then resolves the issue type as `selectedTemplate?.issueType ?? intent.issueType` (LLM-extracted from the prompt). When either of those is present, the issue-type list is skipped entirely; when neither is present, a second list appears. The result looks inconsistent to the user — sometimes one list, sometimes two — even though the underlying logic is deterministic. The same two-prompt problem doesn't exist in the Veracode/Waltz report-import flow, which already fetches issue types up front and folds them into the same list as templates, or in the email-to-ticket flow, which does the same but adds a no-pick shortcut. Aligning `@jira create` to the report-import shape removes the conditional branching that produces the inconsistency.

### Requirements

- R1. When one or more templates exist in `.jira-templates.json`, `@jira create` shows a single list combining templates (each with its associated issue type) and the project's remaining selectable issue types (those not already the issue type of a template) — replacing the current template-list-then-conditional-issue-type-list sequence.
- R2. The combined list always requires an explicit numbered reply to proceed — no default issue type is silently pre-accepted, and no bare-confirm shortcut is offered.
- R3. Issue types are fetched from the target Jira project before the combined list is built, regardless of whether a template's own issue type would otherwise have made that fetch unnecessary.
- R4. Resolving the project key (from the prompt, the `ticketSidekick.jira.defaultProject` setting, or an input box) happens before the combined list is built, since issue types are project-scoped.
- R5. When no templates exist, the list contains issue types only — matching current behavior for that case.
- R6. When issue types cannot be fetched (API failure) and no templates exist either, fall back to the existing input-box prompt for a free-typed issue type — matching current failure-fallback behavior.
- R7. Templates continue to be loaded as one shared, unfiltered list across all flows (manual creation, email import, Veracode/Waltz import) — this work does not add per-flow template scoping.

### Key Decisions

- **Always require an explicit numbered pick; no pre-selected default to accept.** Matches the Veracode/Waltz report-import list, not the email flow's default-and-shortcut pattern — the user typically has a specific favorite template per use case and will type its number regardless of any guessed default. Governs R2. (session-settled: user-directed — chosen over a pre-selected-default-with-shortcut approach after weighing both existing precedents.)
- **Per-flow template filtering is out of scope.** Templates already show unfiltered across every flow today (`TemplateService.loadTemplates()` returns one flat list with no flow-scoping field); combining the create-ticket list doesn't change that, and adding filtering is a separate concern. Governs R7. (session-settled: user-directed.)

### Scope Boundaries

- The email-to-ticket and Veracode/Waltz report-import flows are unchanged — they are the reference pattern this work aligns to, not additional work.
- Section Q&A, template field resolution, and ticket creation after the combined selection are unchanged.
- Per-flow template filtering/tagging is deferred, not part of this work (see Key Decisions).

### Dependencies / Assumptions

- Assumes issue-type fetching (`GET /rest/api/2/project/{key}`) remains the source of truth for a project's selectable issue types, as it is today.
- Assumes moving project-key resolution earlier in the flow has no effect on how the project key itself is resolved (same precedence order), only on when it happens.

### Sources / Research

- `src/participant/jira/createHandler.ts:232-326` (`handleCreateTicket`) — current template-list-then-conditional-issue-type-list logic; `resolvedType = selectedTemplate?.issueType ?? intent.issueType` at `:296` is the branch point that produces the inconsistency.
- `src/participant/jira/reportImportHandler.ts:114-178` (`buildImportTemplateSession`, `streamImportTemplateSelection`) — the reference pattern: combined templates+issue-types list, issue types always fetched up front, explicit numbered pick required, no default-accept shortcut. Shared by both the Veracode and Waltz importers via `ReportImportDescriptor`.
- `src/participant/jira/emailHandler.ts:136-190,280-330,400-423` — the alternate existing pattern (combined list plus a pre-selected default and a no-pick "post it" shortcut via `selectDefaultIssueType()`), considered and not chosen for this work.
- `src/participant/sessionState.ts:435-451` (`pickEmailOption`, `EmailOptionPick`) — existing combined-list selection parser, reused directly rather than duplicated (KTD1).
- `src/templates/TemplateService.ts:10-16` (`JiraTemplate` interface) — confirms no per-flow scoping field exists on a template today.
- `src/participant/jira/ticketContext.ts:27-40` (`resolveProjectKey`) — confirms project-key resolution is prompt → `defaultProject` setting → input box, with no git-branch fallback; corrects R4's wording from the source brainstorm doc, which mistakenly listed git branch as a source (git branch is used only for resolving an *existing* ticket key elsewhere, not a project key).

**Product Contract preservation:** Restructured, no scope change — R4's wording was corrected to drop the inaccurate "git branch" source (see Sources / Research). No requirement's intent, scope, or R-ID changed.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Reuse `pickEmailOption()`/`EmailOptionPick` (`src/participant/sessionState.ts:435-451`) to parse the combined list's numbered reply, instead of writing a new parser.** It already maps a number to either `{ kind: 'template', name, issueType }` or `{ kind: 'type', issueType }` over a `templates` array plus an `issueTypes` array — exactly the shape R1 needs — and is already unit-tested. Governs R1, R2.
- KTD2. **Retire `TemplateSelectionSession`, `IssueTypeSelectionSession`, `parseTemplateSelection`, and `parseIssueTypeSelection` entirely**, replacing them with one new session type and reusing KTD1's parser, rather than keeping the old two-step types alongside the new combined one. Nothing outside `createHandler.ts`/`JiraParticipant.ts` references them. Governs R1.
- KTD3. **New session type `CreateSelectionSession`** carries what the combined list and its follow-up need: `templates: Array<{ name: string; issueType: string }>`, `issueTypes: string[]`, `projectKey: string`, `summary: string | null`, `description: string | null`, `extraFields?: Record<string, unknown>`, `originalPrompt: string`. Mirrors `ImportTemplateSelectionSession`'s shape (`sessionState.ts:483`) but keeps the create-flow's existing pending fields (`summary`, `description`, `extraFields`) that the report-import session doesn't carry. Governs R1, R3, R4.
- KTD4. **Cancellation is checked before the numeric parse**, via `isCancellation(reply)`, matching the email/report-import call sites — `pickEmailOption` itself has no cancel case. Governs R2.
- KTD5. **A template with no explicit `issueType` displays the project's first fetched issue type as its effective type; when no issue type is resolvable at all (nothing fetched), it carries the `''` sentinel instead of a guessed literal.** An earlier version of this decision defaulted to the literal `'Task'` in that case; a `ce-code-review` pass on the implementation found this silently created tickets with a guessed, unverified type. `''` (never a real Jira issue type name) renders as "you will be asked to type it" in the list, and picking it opens the free-type input box (matching R6's existing fallback UX) instead of submitting a guess. Governs R1, R6.
- KTD6. **When a picked template can no longer be found** (renamed or removed from `.jira-templates.json` between the list being shown and the reply), warn the user and proceed without its default fields — matching `reportImportHandler.ts:260-268`'s existing warning, not `emailHandler.ts`'s silent fallback, since a silent type/field mismatch is a worse surprise than one extra line. Governs R1. (resolves a `ce-doc-review` finding.)
- KTD7. **When templates exist but the issue-type fetch fails entirely, the combined list still carries one `''`-sentinel entry in its issue-types side**, so there is always a way to create a ticket without picking a template — not just when both sides are empty (R6's original fully-empty case). A `ce-code-review` pass on the implementation found the initial version left no escape hatch in this partial-failure case: templates-only with no way to bypass one. Governs R6.

### Assumptions

- When templates exist but the project's issue-type fetch fails, the combined list still shows the templates plus the single `''`-sentinel bypass entry (KTD7) rather than falling back straight to the input box — the input box only fires when *both* templates and fetched issue types are empty (R6).

### Sequencing

U1 (session type + reused parser) is a prerequisite for U2 (`createHandler.ts` rebuild) and U3 (`JiraParticipant.ts` routing). U2 and U3 land together — U3's routing block reads the `CreateSelectionSession` U2 builds and streams, so U2's list-building/streaming logic must exist before U3's routing block can call into it; `continueAfterIssueType` itself is unchanged by either unit. U4's actual work (test updates) only needs U1's removed/added symbols, but land it after U2/U3 too, since it also touches the `JiraParticipant.test.ts` blocks U3's routing change makes obsolete.

---

## Implementation Units

### U1. Combined session type and retirement of the two-step types

**Goal:** Add `CreateSelectionSession` and remove the two session types and two parsers it replaces.

**Requirements:** R1, R7 (no new filtering added). Prerequisite for U2, U3.

**Dependencies:** None.

**Files:**
- `src/participant/sessionState.ts` (modify)

**Approach:**
1. Add the `CreateSelectionSession` interface per KTD3, next to the existing `ImportTemplateSelectionSession` for discoverability.
2. Remove `TemplateSelectionSession`, `IssueTypeSelectionSession`, `parseTemplateSelection`, `parseIssueTypeSelection` (KTD2).
3. No new parser is added — `pickEmailOption` and `isCancellation` are reused as-is (KTD1, KTD4).

**Test scenarios:**
- Test expectation: none — this unit only adds a type and removes two functions; behavior coverage lives in U4's tests of the callers.

**Verification:** `npm run compile` passes with no remaining references to the removed types/functions outside this unit's own removal.

### U2. `createHandler.ts`: build and stream the combined list; resolve project key first

**Goal:** `handleCreateTicket` resolves the project key, always fetches issue types, loads templates, and streams one combined list — replacing the current template-list-then-conditional-issue-type-list sequence.

**Requirements:** R1, R2, R3, R4, R5, R6.

**Dependencies:** U1.

**Files:**
- `src/participant/jira/createHandler.ts` (modify)

**Approach:**
1. Move project-key resolution (`resolveProjectKey`) to the start of the fresh-call branch of `handleCreateTicket`, before template loading — currently it runs after template selection returns (`createHandler.ts:280`).
2. After the project key resolves, fetch issue types via `ticketService.getIssueTypes(projectKey)` unconditionally (R3), catching a fetch failure the same way `TicketService`'s existing fallback does today (log + fall through with an empty list).
3. Load templates via `TemplateService.loadTemplates()` as today, mapping to `{ name, issueType: t.issueType ?? issueTypes[0] ?? '' }` pairs for the list (KTD5's `''` sentinel).
4. If both templates and fetched issue types are empty, fall back to the existing `showInputBox` free-type prompt (R6), matching current behavior. If templates exist but issue types are empty, carry one `''`-sentinel entry in the issue-types side instead (KTD7).
5. Otherwise build a `CreateSelectionSession` (KTD3) and stream the combined list, reusing `reportImportHandler.ts:157-178`'s two-heading rendering (`**Templates:**` / `**Issue types (no template):**`, whichever side is non-empty) adapted to the `<!-- jira:selecting-create-option -->` marker.
6. The "returning from a template selection turn" branch (`createHandler.ts:245-257`, reloading a preselected template by name) is removed — it existed only to support the old two-step flow's second call into `handleCreateTicket`; the combined list resolves everything in one round-trip now (see U3). Remove `handleCreateTicket`'s now-unreachable `preselectedTemplateName`/`originalPrompt` parameters along with it, and update the two remaining call sites (the fresh-call entry point) accordingly.
7. `continueAfterIssueType` (`createHandler.ts:74-174`) is unchanged — it remains the shared continuation both the direct-resolved-type path and U3's routing call into.
8. `streamTemplateSelection` and `streamIssueTypeSelection` (the two exported streaming functions for the old two-step lists) are removed — their only callers are the routing blocks U3 replaces. Their rendering logic is superseded by the new combined-list streaming function from step 5.

**Test scenarios:**
- Test expectation: covered indirectly — `createHandler.ts` imports `vscode` and is not Vitest-testable (matches existing project convention); its behavior is exercised through U3's routing tests where feasible, and is otherwise verified by manual/e2e check per the Verification Contract.

**Verification:** `npm run compile` passes; manual check per Verification Contract below.

### U3. `JiraParticipant.ts`: single routing block for the combined selection

**Goal:** Replace the two separate routing blocks (`<!-- jira:selecting-template -->` and `<!-- jira:selecting-type -->`) with one block that parses the reply against the combined session and resolves either a template pick or a bare issue-type pick.

**Requirements:** R1, R2.

**Dependencies:** U1, U2.

**Files:**
- `src/participant/JiraParticipant.ts` (modify)

**Approach:**
1. Replace the two blocks at `JiraParticipant.ts:209-273` with one block keyed on the new marker, reading `CreateSelectionSession` from `workspaceState`.
2. Check `isCancellation(request.prompt)` first (KTD4); on cancel, clear the session and show `_Cancelled._`.
3. Otherwise parse the number and call `pickEmailOption(n, session.templates, session.issueTypes)` (KTD1); on `null`/out-of-range, re-stream the same combined list as an invalid-reply retry (mirrors the email/report-import re-prompt pattern).
4. On a `{ kind: 'template', ... }` pick, reload the full `JiraTemplate` from `TemplateService` by name. If it can no longer be found, warn (`_Warning: template "<name>" is no longer available — proceeding without its default fields._`, matching `reportImportHandler.ts:260-268`, KTD6) and continue with `selectedTemplate: null`; otherwise call `continueAfterIssueType` with the reloaded template.
5. On a `{ kind: 'type', ... }` pick, call `continueAfterIssueType` with `selectedTemplate: null` and the picked issue type.
6. Either kind: if the resolved issue type is the `''` sentinel (KTD5, KTD7), open the free-type input box before calling `continueAfterIssueType`, and cancel the flow if nothing is entered — mirrors R6's existing input-box UX rather than submitting a guessed type.
7. Both call sites reuse `continueAfterIssueType`'s existing signature unchanged (no new parameters needed).

**Test scenarios:**
- Test expectation: none for `JiraParticipant.ts` itself — it imports `vscode` and is not Vitest-testable (matches existing project convention); routing behavior is verified per the Verification Contract.

**Verification:** `npm run compile` passes; manual check per Verification Contract below.

### U4. Update `sessionState.test.ts` for the removed/reused functions

**Goal:** Remove test coverage for the retired `parseTemplateSelection`/`parseIssueTypeSelection`, and confirm `pickEmailOption`'s existing coverage already proves the combined-list parsing this work now depends on.

**Requirements:** R1, R2, R5. Covers the KTD1/KTD2 technical choices.

**Dependencies:** U1.

**Files:**
- `src/test/sessionState.test.ts` (modify)
- `src/test/JiraParticipant.test.ts` (modify — remove any `parseTemplateSelection`/`parseIssueTypeSelection` describe blocks that live there instead)

**Approach:**
1. Remove the `describe('parseTemplateSelection', ...)` and `describe('parseIssueTypeSelection', ...)` blocks (found in `src/test/JiraParticipant.test.ts:169-230` at plan time — confirm current location before removing, since `ce-plan` doesn't move test files).
2. Leave `pickEmailOption`'s existing test coverage (`src/test/JiraParticipant.test.ts:794-818` at plan time) as-is — it already proves the numbering behavior (`kind: 'template'` for indices within the templates array, `kind: 'type'` beyond it) that `createHandler`'s combined list now relies on; no new test is needed purely for reuse.
3. Add one new scenario, if not already covered: `pickEmailOption` called with an empty `templates` array returns only type picks starting at index 1 — covers R5 (no-templates case).

**Test scenarios:**
- `pickEmailOption(1, [], ['Bug', 'Task'])` returns `{ kind: 'type', issueType: 'Bug' }` (R5: no-templates list still resolves correctly).
- Regression: existing `pickEmailOption` scenarios (template pick within range, type pick beyond range, out-of-range `null`) continue to pass unchanged.

**Verification:** `npm test -- sessionState JiraParticipant` passes with no reference to the removed parsers remaining anywhere in the suite.

---

## Verification Contract

| Unit | Verification | Repo command |
| --- | --- | --- |
| U1 | No remaining references to removed types/functions | `npm run compile` |
| U2 | Combined list builds correctly (templates+types, templates-only, types-only, input-box fallback) | Manual check: run `@jira create ...` in the Extension Development Host against a workspace with `.jira-templates.json`, and again without one |
| U3 | Numbered reply resolves to the right template/type; cancel and invalid-reply paths work | Manual check: same session, reply with a template number, a type-only number, an out-of-range number, and a cancellation word |
| U4 | Parser test coverage reflects the reused/removed functions | `npm test -- sessionState JiraParticipant` |
| All | Full suite green, no regressions | `npm run compile && npm test` |

## Definition of Done

- `@jira create` shows exactly one combined numbered list (templates + remaining issue types) instead of the old two-step sequence, in every case R1/R5/R6 describe.
- The list always requires an explicit numbered pick — no default is silently accepted.
- `TemplateSelectionSession`, `IssueTypeSelectionSession`, `parseTemplateSelection`, `parseIssueTypeSelection` are fully removed, with no dangling references or imports.
- `npm run compile` and `npm test` pass.
- No leftover dead code from the removed two-step flow: the "returning from a template selection turn" branch and `handleCreateTicket`'s `preselectedTemplateName`/`originalPrompt` parameters in `createHandler.ts`, `streamTemplateSelection`/`streamIssueTypeSelection`, and the old routing blocks in `JiraParticipant.ts`.
