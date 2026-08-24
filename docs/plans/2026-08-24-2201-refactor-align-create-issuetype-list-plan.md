---
title: Align Create-Ticket Template and Issue-Type Selection - Plan
type: refactor
date: 2026-08-24
topic: align-create-issuetype-list
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Align Create-Ticket Template and Issue-Type Selection - Plan

## Goal Capsule

- **Objective:** `@jira create` always presents one combined, predictable selection step — templates and issue types together — instead of sometimes showing only a template list and sometimes showing a template list followed by a separate issue-type list.
- **Means:** Merge the two sequential prompts into a single numbered list (templates first, then remaining issue types), matching the list shape and selection mechanics the Veracode/Waltz report-import flow already uses.
- **Product authority:** Repo owner, established in this brainstorm dialogue.
- **Open blockers:** None.

## Product Contract

### Summary

Replace `@jira create`'s conditional two-step selection (a template list, then sometimes a separate issue-type list when the template or prompt didn't already pin one down) with a single combined numbered list of templates followed by remaining issue types, always requiring an explicit numbered pick — the same shape the Veracode/Waltz report-import flow already presents.

### Problem Frame

Today, `handleCreateTicket` shows the template list first, then resolves the issue type as `selectedTemplate?.issueType ?? intent.issueType` (LLM-extracted from the prompt). When either of those is present, the issue-type list is skipped entirely; when neither is present, a second list appears. The result looks inconsistent to the user — sometimes one list, sometimes two — even though the underlying logic is deterministic. The same two-prompt problem doesn't exist in the Veracode/Waltz report-import flow, which already fetches issue types up front and folds them into the same list as templates, or in the email-to-ticket flow, which does the same but adds a no-pick shortcut. Aligning `@jira create` to the report-import shape removes the conditional branching that produces the inconsistency.

### Requirements

- R1. When one or more templates exist in `.jira-templates.json`, `@jira create` shows a single list combining templates (each with its associated issue type) and the project's remaining selectable issue types (those not already the issue type of a template) — replacing the current template-list-then-conditional-issue-type-list sequence.
- R2. The combined list always requires an explicit numbered reply to proceed — no default issue type is silently pre-accepted, and no bare-confirm shortcut is offered.
- R3. Issue types are fetched from the target Jira project before the combined list is built, regardless of whether a template's own issue type would otherwise have made that fetch unnecessary.
- R4. Resolving the project key (from the prompt, git branch, `ticketSidekick.jira.defaultProject`, or an input box) happens before the combined list is built, since issue types are project-scoped.
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
- `src/participant/sessionState.ts:435-451` (`pickEmailOption`, `EmailOptionPick`) — existing combined-list selection parser, reusable shape for planning to evaluate.
- `src/templates/TemplateService.ts:10-16` (`JiraTemplate` interface) — confirms no per-flow scoping field exists on a template today.
