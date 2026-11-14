---
title: "Spell Check and Template Skills - Plan"
type: feat
date: 2026-11-14
topic: spell-check-and-template-skills
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Spell Check and Template Skills - Plan

## Goal Capsule

- **Objective:** A developer corrects the spelling of a ticket's description, and turns a ticket into a reusable template, from a Copilot chat. Neither needs `@jira` or the Local harness any more.
- **Means:** Two explicit-only skills, `/ts-jira-spell-check` and `/ts-jira-template`, each backed by one new write tool. The same change removes `@jira spell check` and `@jira` template generation. This closes O3 and O4 of [`docs/architecture/migration-status.md`](../architecture/migration-status.md).
- **Product authority:** The maintainer's decisions below. They amend R28 and R29 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md) (R18). The rest of Step 1 (O1, O2, the other O5 removals, O6) is not active scope.
- **Open blockers:** None.

---

## Product Contract

### Summary

`/ts-jira-spell-check KEY` lets Copilot's agent list spelling and grammar fixes for a ticket's description, and a tool applies only the fixes the developer approves. `/ts-jira-template KEY` saves a template built from the ticket's fields to `.jira-templates.json` after one native confirmation. `@jira spell check` and `@jira` template generation are removed in the same change.

### Problem Frame

Step 1 of the migration removes every `@jira` flow except the imports, and each flow can go only once its replacement exists (R33 of the boards plan). Spell check and template generation are the two flows with no replacement yet. A developer who uses either has to switch to the Local harness for it. Today's template generation is a seven-step chat dialogue held in `workspaceState` sessions, which is the participant mechanism this migration retires.

### Key Decisions

- **Two separate explicit-only skills, not new `/ts-jira` router commands.** (session-settled: user-directed — chosen over instruction files in the `/ts-jira` folder and over exception rows in its `SKILL.md`: the router keeps its strict one-call rule.) Governs R1, R2.
- **Spell check covers the description only.** (session-settled: user-directed — chosen over summary and description as R28 stated: matches today's `@jira spell check`.) Governs R3.
- **Copilot's agent finds the corrections; the extension makes no model call.** (session-settled: user-approved — chosen over a tool calling a model with today's spell-check prompt: no dependency on open decision Q1 and no model setting, at the cost of results varying with the chat's model.) Governs R4.
- **The proposal is a numbered list of changes, and single items can be dropped.** (session-settled: user-approved — chosen over showing the full corrected text and over all-or-nothing approval.) Governs R5.
- **A tool applies the approved pairs; the agent never writes the whole description.** (session-settled: user-directed — chosen over rules in the skill only and over rules plus a diff in chat: nothing but the listed corrections can change, so wiki markup and code stay intact.) Governs R6 to R8.
- **One template write tool; its native confirmation is the only review.** (session-settled: user-directed — chosen over a read tool followed by a write tool with a field review in chat, and over a board: unwanted fields are removed by editing the file afterwards.) Governs R10.
- **A taken name saves under a numbered name.** (session-settled: user-directed — chosen over refusing and asking for another name, and over replacing the existing template after confirmation.) Governs R11.
- **No-ticket mode is dropped.** (session-settled: user-directed — chosen over saving name and issue type only, and over the agent asking for every value before the write: Jira's required-fields metadata carries no values, so without the review step such a template presets nothing.) Governs R9.
- **Kept from today's flow: asking for the name, the empty-required warning, the first-ticket offer.** (session-settled: user-directed — chosen over dropping them.) Governs R12 to R14.
- **The first-ticket offer is a hint, not a question.** (session-settled: user-directed — chosen over asking and then starting `/ts-jira-create`, and over dropping the offer.) Governs R14.
- **The two `@jira` flows are removed in this change.** (session-settled: user-directed — chosen over leaving their removal to O5's single removal pass.) Governs R16.
- **The boards plan is updated in place.** (session-settled: user-approved — chosen over stating only in this plan that it supersedes R28 and R29.) Governs R18.
- **A refused correction refuses the whole write.** The developer sees which pairs were refused and can drop them and run again, so a partial write never surprises them. Governs R7.

### Requirements

**Skills**

- R1. Two new skills, `/ts-jira-spell-check KEY` and `/ts-jira-template KEY [name]`, which the agent never starts by itself (`disable-model-invocation`, like `/ts-jira-brief`).
- R2. The closing line of `/ts-jira help` names both skills, as it names `help brief` and `help create` today; the router's commands and rules are otherwise unchanged.

**Spell check**

- R3. `/ts-jira-spell-check KEY` checks only the ticket's description; a ticket without a description gets a reply saying so and no write.
- R4. The agent proposes spelling and grammar corrections only, no rewording or style changes, and never inside `{code}`, `{noformat}`, `{{monospace}}` or a link target.
- R5. The proposal is a numbered list of "before → after" lines; the developer approves it, or drops items by number first. When nothing is found, the reply says so and nothing is written.
- R6. A new write tool takes the ticket key and the approved pairs, applies them to the description as Jira holds it at the time of the write, and saves the result.
- R7. The tool refuses the write when any pair's "before" text does not occur exactly once in the current description or lies inside code, `{noformat}`, monospace or a link target, and names each refused pair.
- R8. The tool's native confirmation shows every pair and the resulting description; like the other Jira write tools it falls under the shared duplicate guard and reports a write Jira did not answer in time as possibly saved.

**Template**

- R9. `/ts-jira-template` builds the entry from a reference ticket only, with today's deterministic logic (template-shaped fields copied, per-ticket fields left out). Without a ticket key the skill asks for one.
- R10. One write tool builds and saves the entry. Its native confirmation lists the name, the issue type and every field with its value, and nothing is written without approval.
- R11. When the name is already in `.jira-templates.json`, the entry is saved under the lowest free numbered name ("Bug (2)", "Bug (3)"), and the confirmation shows the name used.
- R12. When no name is typed, the agent asks for one before calling the tool.
- R13. A required field that is empty on the reference ticket is not written. The confirmation and the result list each such field as "asked when a ticket is created".
- R14. After a save, the result ends with one line showing the `/ts-jira-create` command that uses the new template, and asks nothing.
- R15. The save adds only the new entry and keeps the rest of `.jira-templates.json` (other templates, `cleanupRules`). A file that exists but cannot be read in full is never written over.

**Removal and documentation**

- R16. `@jira spell check` and `@jira` template generation are removed: their intent operations, routing, sessions and `workspaceState` keys, help entries, follow-up chips and tests.
- R17. The user manual follows: the README's spell-check line goes, and `docs/manual/copilot-tools.md` describes both skills and both new tools.
- R18. The boards plan is updated: R28 and R29 and their Replacement Map rows name the new skills and today's decisions, and the Key Decision "The minimum VS Code version rises in step 1" is marked withdrawn, matching R36. The migration status marks O3 and O4 as done.

### Key Flows

- F1. Spell check (covers R3 to R8)
  1. The developer types `/ts-jira-spell-check PROJ-123`.
  2. The agent reads the ticket and lists the corrections, numbered.
  3. The developer replies "skip 2" or approves.
  4. The agent calls the apply tool with the approved pairs. The developer approves the native confirmation.
  5. The tool writes the description and reports the result.
- F2. Template (covers R9 to R14)
  1. The developer types `/ts-jira-template PROJ-123`.
  2. The agent asks for a name and gets "Payments bug".
  3. The agent calls the write tool. The confirmation lists the issue type, the fields and values, and the empty required fields.
  4. On approval the tool saves the entry. The result ends with the `/ts-jira-create` hint.

### Acceptance Examples

- AE1. **Covers R7.** Given an approved pair "shwon → shown" and a description where "shwon" appears twice, when the tool runs, then nothing is written and the result names that pair as not unique.
- AE2. **Covers R6, R7.** Given the ticket was edited between the proposal and the write so that one "before" text is gone, when the tool runs, then nothing is written and the edit is kept.
- AE3. **Covers R4, R7.** Given "recieved" appears only inside a `{code}` block, then the agent does not propose it, and a pair naming it is refused by the tool.
- AE4. **Covers R11.** Given templates "Bug" and "Bug (2)" exist, when a template named "Bug" is saved, then it is saved as "Bug (3)" and the confirmation says so.
- AE5. **Covers R13.** Given Team is required and empty on PROJ-123, when the template is saved, then it has no Team field and the result lists Team as asked when a ticket is created.
- AE6. **Covers R15.** Given `.jira-templates.json` holds invalid JSON, when a template is saved, then the file is left unchanged and the result says why.
- AE7. **Covers R3, R5.** Given a ticket with no description, or one with nothing to correct, then the reply says so and no tool writes.

### Scope Boundaries

- Dropped from today's `@jira` behaviour: no-ticket mode, the per-field keep-or-drop review, typing values for empty fields, replacing an existing template, and starting a ticket from the new template automatically.
- Not in this work: spell check of the summary or comments; editing or updating an existing template; the other Step 1 points (O1, O2, the remaining O5 removals, O6).

### Dependencies / Assumptions

- `src/test/skillsGuard.test.ts` already requires `disable-model-invocation` on every `ts-` skill other than `/ts-jira-create`, and fails on a basic `@jira` command with no tool or skill left for it. `src/test/jiraCommandsGuard.test.ts` ties the `@jira` help catalog to the intent operations, so R16 removes both together.
- New tools go into the catalog in `src/tools/jiraTools/`; `node scripts/sync-jira-tools.mjs` generates their `package.json` entries, and `src/test/userDocsSync.test.ts` checks them against `docs/manual/copilot-tools.md`.

### Outstanding Questions

**Deferred to Planning**

- Tool names and argument shapes.
- Where today's template logic moves. `src/participant/session/templateGeneration.ts` sits under `src/participant/`, which goes at the end of the migration, so the parts the tool reuses need a home outside it.
- How the apply tool recognises code, `{noformat}`, monospace and link-target spans in wiki markup, and whether `src/utils/jiraWikiToMarkdown.ts` already has a usable tokenizer.
- What a save does when `.jira-templates.json` does not exist yet, matching today's `TemplateService.saveTemplate`.

### Sources / Research

- Today's spell check: `handleSpellCheck` in `src/participant/jira/fieldHandler.ts` (description only, `spellCheckValue` model call, preview session).
- Today's template generation: `src/participant/jira/templateGenerationHandler.ts` and `src/participant/session/templateGeneration.ts` (`filterOutPerTicketFields`, `buildGeneratedTemplate`, `findUnsetIncludedRows`, `buildEmptyRequiredFieldsWarning`); flow summary in `docs/jira-flows.md` "Template generation".
- Save path: `TemplateService.saveTemplate` in `src/templates/TemplateService.ts` (keeps `cleanupRules`, optional overwrite).
- Router rules this plan keeps intact: `skills/ts-jira/SKILL.md`.
