---
title: Import Start Screen Template Picker - Plan
type: feat
date: 2026-11-27
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Import Start Screen Template Picker - Plan

## Goal Capsule

- **Objective:** A developer starting an import can use a template other than the saved default for that import, and can make it the new default in the same step, without editing settings.
- **Means:** The template is always a picker on the import start screen, with a "Set as default" checkbox (KTD1).
- **Authority:** Product Contract first, then Planning Contract, then units. Issue #132 is the origin of the request.
- **Execution profile:** One PR, Lightweight depth. `npm run compile` and `npm test` pass before commit, as the project requires.
- **Finishes and ships:** The agent or developer who runs `ce-work`. A PR is opened only when the user asks for one.
- **Stop conditions:** Stop and ask if holding the pick needs a change to the stored import session or recipe format, or if the page cannot keep the checkbox value across repaints without server state.

---

## Product Contract

### Summary

The import start screen always shows the template as a picker, preselected with the saved default of the report kind. Picking another template applies to the import being started. A "Set as default" checkbox saves the pick to `ticketSidekick.<kind>.template`. It starts ticked when the setting is empty or names a template that no longer exists, and unticked when a valid default exists.

### Problem Frame

Once `ticketSidekick.<kind>.template` names a template in `.jira-templates.json`, the start screen shows it as plain text. A developer who wants another template for one import, or a different default, has to leave the screen and edit the setting. The picker shown today for an empty or stale setting saves its pick at once, so it cannot serve a one-off choice either (issue #132). This replaces the "asked once and saved" rule of R4 and AE9 in `docs/plans/2026-11-14-1641-feat-import-board-veracode-waltz-parity-plan.md`.

### Requirements

**The picker**

- R1. When `.jira-templates.json` has templates, the start screen shows a picker listing them, preselected with the template the import uses: the one picked on this screen, else the saved default of the report kind.
- R2. A pick sets the template of the import the screen opens. The issue type follows from it: the template's own, else one picked or typed as today.
- R3. A pick lasts while the start screen is open and is dropped when the report kind changes.

**The default**

- R4. A "Set as default" checkbox sits next to the picker. While it is ticked, the template picked is saved to `ticketSidekick.<kind>.template`, and ticking it saves the template currently picked. Unticking changes no saved setting.
- R5. When the setting names an existing template, the checkbox starts unticked.
- R6. When the setting is empty or names a template that no longer exists, the checkbox starts ticked and the screen says the pick is saved unless it is unticked. An unticked pick is used for this import and is not saved.

**Stored imports**

- R7. Open stored import opens the stored import with the template it was started with. Start over discards it and starts again with the template picked on the start screen.

### Key Decisions

- KD1. **One picker with the same controls whether or not a valid default exists, ticked for a first pick.** (session-settled: user-directed — chosen over keeping the immediate save without a checkbox and over never saving unless ticked: the user wants the same picker and checkbox in the empty and the valid state.) Governs R1, R4, R5, R6.

### Acceptance Examples

- AE1. **Covers R4, R6.** Given `ticketSidekick.waltz.template` is empty, when the developer picks "OSS finding" with the checkbox ticked, then the setting holds "OSS finding", and the next Waltz import shows it preselected with the checkbox unticked.
- AE2. **Covers R2, R5.** Given the default is "OSS finding", when the developer picks "Plain" with the checkbox unticked and opens the import, then the import uses "Plain", asks for an issue type, and the setting still holds "OSS finding".
- AE3. **Covers R4.** Given the state after AE2's pick, when the developer ticks the checkbox, then the setting holds "Plain".
- AE4. **Covers R6.** Given the setting names a deleted template, when the developer unticks the checkbox and picks "Plain", then the import uses "Plain" and the next import asks again.
- AE5. **Covers R7.** Given a stored import of this file and project, when the developer picks another template, then Open stored import opens the stored import with its own template, and Start over starts a new import with the picked template.

### Scope Boundaries

- The project field stays read-only once valid. Making it changeable is a separate request.
- The pick is not remembered after the start screen closes. Only the setting is.
- Considered and not built: clearing a saved default from the screen. Nobody asked for it, and the setting stays editable in Settings.
- Considered and not built: changing the template after Open. An opened import keeps its template, as today.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The checkbox value lives in the page, and the setting write is explicit in the request.** The page already holds typed project and issue-type input the same way. The `template` request carries `setAsDefault`, and the screen writes the setting only when it is exactly `true`, so no caller saves a default by omission. Governs R4 to R6.
- KTD2. **The pick is held in `StartState` and checked against `.jira-templates.json` on every view.** A pick whose template has gone is ignored and the screen falls back to the default or asks again. A kind change replaces the whole state, which drops the pick (R3). The issue type pick is already keyed by template name, so a changed pick needs no extra reset.
- KTD3. **The view reports what the page needs and nothing about the checkbox.** `template.options` is present whenever templates exist, `template.name` is the template in use, and a new `template.hasDefault` says whether the setting names an existing template. `askReason` stays for the no-default case, reworded for the checkbox. The page derives the checkbox's starting value from `hasDefault`.

---

## Implementation Units

### U1. Start screen: hold the pick, save on request

- **Goal:** The screen resolves the template from the pick, else the saved default, and writes the setting only on request.
- **Requirements:** R1 to R7, KD1, KTD1 to KTD3
- **Dependencies:** none
- **Files:** `src/boards/import/startScreen.ts`, `src/test/importStartScreen.test.ts`
- **Approach:**
  - Add the pick to `StartState`, set by the `template` request and read in `view()` before the saved setting.
  - The `template` request takes `name` and `setAsDefault`. An unknown name stays a 400 with nothing written. A write happens only for `setAsDefault === true` and a name that differs from the setting, with the existing diagnostic line.
  - In `view()`, return `options` whenever templates exist, add `hasDefault`, and keep `askReason` only without a valid default, worded for the checkbox.
  - Update the file-header comment, which still says the template is asked for only when the setting is empty or stale.
- **Patterns to follow:** the `project` request in `handle` for validate-then-write, and the template-keyed `issueType` state.
- **Test scenarios:**
  - Covers AE1. Empty setting, pick with `setAsDefault: true`: one write `['waltz', 'OSS finding']`, `hasDefault` true, and a new screen for the kind shows it preselected without asking.
  - Stale setting, pick with `setAsDefault: true`: the setting is overwritten (replaces the current stale-setting test).
  - Covers AE4. Empty setting, pick without the flag: the template in use is the pick, `canOpen` is true for a readable file, nothing is written, `hasDefault` is false, and a new screen asks again.
  - Covers AE2. Valid default, pick "Plain" without the flag: nothing is written, the issue type is asked from the project, and the recipe passed to `openImport` carries "Plain" and the picked issue type.
  - Covers AE3. After that pick, the same name with `setAsDefault: true` writes "Plain" once. The saved default with the flag writes nothing.
  - A `setAsDefault` of `"true"` or `1` writes nothing.
  - A pick survives later views and is gone after the kind changes to another kind and back.
  - A pick for a template removed from `.jira-templates.json` before the next view is ignored and the saved default shows.
  - An unknown template name returns 400 and writes nothing (existing test stays).
  - Covers AE5. With a stored import and a different pick, `stored` is true, Open passes the picked template with the same session id, and Start over discards the stored session and opens with the picked template (adapts the existing stored-template test, which flips the setting instead).
  - A Waltz pick does not reach a Veracode screen (extends the per-kind test).
- **Verification:** The start screen tests pass and `npm run compile` is clean.

### U2. Page: picker and checkbox

- **Goal:** The page always shows the picker and the checkbox, with the starting values R5 and R6 give.
- **Requirements:** R1, R4 to R6, KTD1, KTD3
- **Dependencies:** U1
- **Files:** `board-pages/import-start/page.js`, `src/test/importStartPage.test.ts`
- **Approach:**
  - Replace the read-only branch of `templateCell` with the picker, preselected from `template.name`, and the checkbox. Keep the setting key visible next to the picker so the developer still sees where the default lives.
  - Keep the checkbox value in a page variable, as `typedProject` is kept. Its starting value is `!template.hasDefault`. Once the developer acts, the page holds the value it sent, so a save that turns `hasDefault` true does not untick the box. Reset it when the kind changes.
  - A picker change sends the picked name with the checkbox value. Ticking sends the current template with `setAsDefault: true`. Unticking sends nothing.
  - Reword the header line that says the template comes from the settings. The stored-import banner already says "the template above" and stays.
- **Patterns to follow:** `projectCell` and its page variable for typed input, and `fakeDom` posted-message checks in the existing page tests.
- **Test scenarios:**
  - Valid default: `#template` exists with the default selected, the checkbox is unticked, and the page text holds no "null" or "undefined" (issue #131).
  - Empty or stale setting: the ask reason shows, the picker shows its placeholder, and the checkbox is ticked.
  - Changing the picker posts `template` with the picked name and the checkbox value, for a ticked and an unticked box.
  - Ticking after a pick posts the current name with `setAsDefault: true`, and unticking posts nothing.
  - After a save that makes the setting valid, the view re-read with `hasDefault: true` leaves the checkbox ticked.
  - The stored-import notice and Start over tests pass with the new view shape.
- **Verification:** The page tests pass.

### U3. Docs and setting descriptions

- **Goal:** Every place that says "asked once and saved" or "the template now in the setting" describes the new behavior.
- **Requirements:** R1, R4 to R7
- **Dependencies:** U1, U2
- **Files:** `docs/manual/boards.md`, `docs/manual/report-imports.md`, `docs/manual/settings-reference.md`, `package.json`, `docs/architecture/manual-checklist.md`, `CLAUDE.md`
- **Approach:**
  - `boards.md`: the Template and The same file again bullets under "Opening an import".
  - `report-imports.md`: the email, Veracode and Waltz steps and the three settings table rows.
  - `settings-reference.md`: the paragraph under the template settings.
  - `package.json`: the descriptions of `ticketSidekick.email.template`, `ticketSidekick.veracode.template` and `ticketSidekick.waltz.template`. Defaults stay.
  - `manual-checklist.md`: the start screen items for an empty template, the stored import and the email template.
  - `CLAUDE.md`: the start screen row in Key files.
  - Wording: the template is a picker, the saved default is preselected, a pick is for this import, "Set as default" saves it, it starts ticked when no valid default exists, and Start over uses the picked template.
- **Test expectation:** none -- text only. `src/test/userDocsSync.test.ts` checks setting keys and defaults, which do not change, and must stay green.
- **Verification:** `npm test` passes, and a search for "asked once" and "template now in the setting" finds no stale wording outside dated plans.

---

## Verification Contract

| Gate | Command | Applies |
| --- | --- | --- |
| Types | `npm run compile` | Every unit |
| Unit tests | `npm test` | Every unit, including the start screen, page and `userDocsSync` tests |
| Manual check | The updated start screen items in `docs/architecture/manual-checklist.md`, in a real VS Code | Before a release, not part of this PR's gate |

## Definition of Done

- R1 to R7 hold and AE1 to AE5 are covered by tests.
- `npm run compile` and `npm test` pass.
- The docs, setting descriptions, checklist and `CLAUDE.md` row use the new wording.
- No abandoned experiment code is left in the diff.

## Sources & Research

- Issue: https://github.com/rbreunung/ticket-sidekick/issues/132
- Code: `src/boards/import/startScreen.ts` (`handle` `template` case, `view`), `board-pages/import-start/page.js` (`templateCell`), `src/test/importStartScreen.test.ts` (the template and stored-import tests).
- Checked: the import parity ledger in `src/test/importBoardParity.test.ts` has no start screen template row, so it needs no update.
