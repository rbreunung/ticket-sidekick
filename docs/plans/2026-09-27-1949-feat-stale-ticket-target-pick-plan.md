---
title: Stale Ticket Target Pick - Plan
type: feat
date: 2026-09-27
topic: stale-ticket-target-pick
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Stale Ticket Target Pick - Plan

## Goal Capsule

- **Objective:** When a Veracode or Waltz import finds tickets whose findings are gone, the user can move those tickets to the status that fits their project's process, including a non-final status like "Verification", without editing `.jira-templates.json` first.
- **Means:** Ask for the target at close time on the Stale screen, offering matching cleanup rules and reachable workflow statuses (R1, R2).
- **Product authority:** This Product Contract wins on behavior. `docs/report-import.md` ("Stale-ticket detection and inline close") describes today's flow and stays authoritative for everything this plan does not change.
- **Open blockers:** None.

---

## Product Contract

### Summary

After `close tickets` on the Stale screen, the user picks a target for each issue-type group: a matching cleanup rule, or any status the workflow can reach. The last pick for each project and issue type is remembered and preselected next time. On later imports, tickets already in that remembered status are marked as moved.

### Problem Frame

Today the stale-ticket close takes its target from the first `cleanupRules` entry that matches the ticket's project and issue type. A team that wants stale security findings to go to a non-final review status cannot do that without a separate rule. Even with one, a general cleanup rule for the same project and issue type (for example "close released bugs → Done") gets used first, because matching ignores the rule's name and filters. Tickets with no matching rule are shown but cannot be selected at all.

A non-final target also creates a follow-on effect. The moved ticket stays open and keeps its marker label, so the next import flags it as stale again with nothing to tell it apart from a ticket nobody has looked at.

### Key Decisions

- **The target is chosen at close time, not configured.** (session-settled: user-directed — chosen over a fixed target in config/template and over a config default with override: the target can differ from one import to the next.) Governs R1, R5.
- **The pick list offers matching rules first, then plain reachable statuses.** (session-settled: user-directed — chosen over rules only and over statuses only: a non-final state works without writing a rule, and picking a rule keeps its resolution.) Governs R2, R3, R4.
- **Moved tickets stay visible, marked and unselected.** (session-settled: user-directed — chosen over hiding them once moved and over no change: the user can still see them and move them on.) Governs R7, R8.
- **The last pick is remembered and preselected.** It adds little and gives R7 the memory it needs to know what "moved" means. (session-settled: user-approved — proposed in the scoping synthesis and confirmed; the alternative was no memory.) Governs R6, R7.
- **Waltz gets the same behavior.** Both importers share the stale close flow, and a difference between them on shared ground counts as a bug under `docs/report-import.md`'s consolidation rule. Governs R9.

### Requirements

**Choosing the target**

- R1. After `close tickets` (or `ok`) on the Stale screen, the user is asked for a target once per issue-type group that has at least one selected ticket, before any ticket is transitioned.
- R2. The pick list shows every `cleanupRules` entry matching the group's project and issue type, listed by rule name and target status, followed by every other status the group's tickets can reach according to the discovered workflow.
- R3. Picking a rule applies that rule's target status and its resolution, exactly as today's close does.
- R4. Picking a plain status transitions to that status. A resolution is asked only when the status is a closed-like one, following today's once-per-group resolution ask. A non-final status never asks for a resolution.
- R5. Replying `back` or cancelling during the pick returns to the Stale screen with nothing transitioned, the same as the existing resolution ask.

**Remembering the pick**

- R6. The chosen target is remembered per project and issue type, and next time it is preselected in the pick list, so a confirmation accepts it without choosing again.

**Tickets already moved**

- R7. On the Stale screen, a stale ticket whose current status equals the remembered target for its project and issue type is marked as already in that status.
- R8. A ticket marked by R7 is unselected by default and can still be toggled and moved again.

**Coverage and eligibility**

- R9. The Veracode and Waltz importers behave identically for R1–R8.
- R10. A stale ticket with no matching cleanup rule becomes selectable when the discovered workflow for its project and issue type exists.
- R11. A ticket with no discovered workflow, or no path from its current status to the picked target, is left out of the transition with a per-ticket note saying why, and the rest of the group still runs.

### Acceptance Examples

- AE1. Non-final target with no rule. **Covers R2, R4, R10.**
  - **Given:** Project `SEC` has no cleanup rule for `Bug`, and the workflow for `SEC`/`Bug` has been discovered.
  - **When:** The user selects two stale tickets, runs `close tickets`, and picks the status "Verification".
  - **Then:** Both tickets move to "Verification". No resolution is asked.
- AE2. Rule picked over a status. **Covers R2, R3.**
  - **Given:** `SEC`/`Bug` has the rule "Close released bugs" (target "Done", resolution "Fixed").
  - **When:** The user picks that rule.
  - **Then:** The tickets go to "Done" with resolution "Fixed", and no resolution question is asked.
- AE3. Remembered pick and moved marker on the next import. **Covers R6, R7, R8.**
  - **Given:** On the last import the user picked "Verification" for `SEC`/`Bug`, and ticket `SEC-12` is still in "Verification" while its finding is still gone.
  - **When:** The user runs the next Veracode import.
  - **Then:** `SEC-12` appears on the Stale screen, marked as already in "Verification" and unselected. If the user selects other tickets and runs `close tickets`, "Verification" is preselected in the pick list.
- AE4. Back out of the pick. **Covers R5.**
  - **When:** The pick list is showing and the user replies `back`.
  - **Then:** The Stale screen returns, and no ticket has been transitioned.
- AE5. Unreachable target. **Covers R11.**
  - **Given:** One selected ticket's current status has no path to the picked status.
  - **When:** The close runs.
  - **Then:** That ticket is skipped with a note naming the missing path. The other tickets in the group are transitioned.

### Scope Boundaries

- No fixed target in `.jira-templates.json`, the import template, or a VS Code setting. The remembered pick only preselects and never closes anything without the user confirming.
- No reopening or other action when a moved ticket's finding comes back in a later report. Deduplication already treats it as "already ticketed".
- No change to `@jira cleanup` / `@jira run cleanup`. They keep taking their target from the named rule.
- No change to how stale tickets are detected.

### Outstanding Questions

**Deferred to Planning**

- When the tickets in one issue-type group sit in different current statuses, should the list show the union of reachable statuses or only the ones every ticket can reach? R11 covers the tickets that cannot get there either way.
- Where the remembered pick is stored and how it is keyed. It should outlive the chat session, like the workflow cache does.
- How a remembered pick that names a rule since deleted, or a status no longer in the workflow, is dropped from the preselection.

### Sources / Research

- `src/participant/jira/cleanupHandler.ts` — `buildStaleTicketGroups()`: the first-match rule lookup, the `targetState ?? 'Done'` fallback, the workflow-cache path check, and `CLOSED_LIKE_STATES` gating the resolution ask.
- `src/utils/reportImport.ts` — `buildStaleSearchJql()`: stale candidates are `resolution is EMPTY` plus the marker label, which is why a ticket moved to a non-final status is flagged again. `buildDedupJql()` has no status filter, so a moved ticket still counts as already ticketed.
- `src/participant/jira/reportImportHandler.ts` — the shared Veracode/Waltz session flow that runs the stale check and hosts the Stale screen.
- `src/services/WorkflowService.ts` — `findPath()` over the discovered workflow graph.
- `docs/report-import.md` — "Stale-ticket detection and inline close" and "Overview and group screens".
- `docs/plans/2026-09-14-1726-feat-veracode-fold-page-stale-plan.md` — the plan that introduced the stale check and chose `cleanupRules` as its only target source.
