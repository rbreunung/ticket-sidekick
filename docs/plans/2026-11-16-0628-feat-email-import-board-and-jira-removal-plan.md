---
title: "Email Import Board and @jira Removal - Plan"
type: feat
date: 2026-11-16
topic: email-import-board-and-jira-removal
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Email Import Board and @jira Removal - Plan

## Goal Capsule

- **Objective:** A developer does all Jira work, email imports included, from a Copilot chat or a board, with no `@jira` participant and no Local harness. This finishes Step 2 of the migration.
- **Means:** Email becomes a third kind on the existing import board, with the boilerplate cleanup as a board step. Then `@jira` is removed. Closes O7, O8 and O11 and the email part of O9 and O10 in [`docs/architecture/migration-status.md`](../architecture/migration-status.md).
- **Product authority:** The maintainer's decisions below, within R14 to R19, R24, R25, R43 and R45 of [`2026-11-11-2234-feat-boards-replace-chat-participants-plan.md`](2026-11-11-2234-feat-boards-replace-chat-participants-plan.md). Step 3 (Bitbucket) is not active scope.
- **Open blockers:** None for planning. The model probe (R1) is the first unit and can stop the model-check and removal units (R2).

---

## Product Contract

### Summary

The import board gets an Email kind: the developer picks one or more `.eml` files, then goes through the boilerplate cleanup step on the board, with consent and a model pick before any email text reaches a model. After cleanup, the emails are rows on the New tab. Each row becomes a new ticket or a comment on an existing ticket, and rows whose subject matches an existing ticket are marked as likely repeats. When this works on the managed machine, `@jira` is removed.

### Problem Frame

The email import is the last Jira work that runs only through `@jira`, and `@jira` runs only in the Local harness. Every other Jira task already has a tool, a skill or a board. Until the email import moves, the participant stays in the code along with its own help screen, its `workspaceState` sessions, its guard tests and a second set of documentation. Every email fix also has to be made in a flow that is being retired.

The email check is the only part of the import that calls a language model. Today it uses the chat request's model, which exists only inside a participant. Nothing in the extension has yet called a model from outside a chat request on the managed machine (Q1 of the migration status page). Tool calls that already work don't answer this, because they run the other way: Copilot calls the extension, and the extension never calls a model.

### Key Decisions

- **The model probe comes first, and what happens if it fails is decided after the result.** (session-settled: user-directed — chosen over deciding now to remove `@jira` regardless, and over deciding now to keep `@jira` for the model check: the maintainer wants the result before choosing.) Governs R1, R2.
- **Adding an email as a comment is a per-row choice on the New tab.** (session-settled: user-approved — chosen over a separate start mode and over both: one control covers one or many emails and fits the likely-repeat marking.) Governs R13, R14.
- **Mid-run prompts are steps on the board.** (session-settled: user-approved — carried from the boards plan, chosen over native VS Code pickers and over asking in chat.) Governs R8, R9.
- **Repeated emails are found by searching Jira for the subject.** (session-settled: user-directed — carried from the boards plan, chosen over remembering which files produced a ticket, and over a warning only.) Governs R12.
- **The email check has its own model setting, which falls back to the review-model setting; both ship in this step.** (session-settled: user-directed — carried from the boards plan, chosen over one setting for all calls, and over dropping the model check.) Governs R9, R18.
- **A model pick is written to the email-model setting.** That is the setting the check reads first, and it leaves the review choice to the review board in Step 3. Governs R9.
- **Every release is a preview.** (session-settled: user-directed — carried from the migration status page, chosen over a normal release after each step.) Governs R21.

### Actors

- A1. Developer: chooses the files, gives or withholds consent, picks the model, decides each row, and applies.
- A2. Copilot agent: opens the board, loaded or not, and learns only whether it opened.
- A3. Extension: parses emails, runs the cleanup and the model check, searches Jira, and writes tickets and comments.

### Requirements

**Model probe**

- R1. Before the model check is built on the board, the maintainer confirms on the managed machine, with the Local harness disallowed, whether the extension can list the available models and call one from outside a chat request. The result is recorded under Q1 on the migration status page.
- R2. If the probe fails, work stops before the model-check and `@jira`-removal units until the maintainer chooses what to do (see Outstanding Questions).

**Starting an email import**

- R3. The import board's start screen offers Email as a kind next to Veracode and Waltz, and takes one or more `.eml` files. Today's file-count limit (50) and `ticketSidekick.email.maxBatchSizeMB` cap apply to the whole selection.
- R4. A file that fails to parse is named on the board, and the rest of the batch continues.
- R5. One template and issue type apply to the whole batch, chosen on the board as they are today.
- R6. A workspace path or `.eml` dragged into the chat opens the board already loaded, through the open-board tool. A dragged email counts as consent to send it to the model, as R15 of the boards plan states.

**Cleanup step**

- R7. Before the New tab, the board runs today's boilerplate cleanup: pattern detection from `ticketSidekick.email.boilerplatePatterns`, a preview of the blocks found in each email, strip or keep, excluding single emails, and saving a model-found block as a pattern.
- R8. No email text goes to a model until the developer consents on the board. The consent step names the emails that would be checked and offers check or skip, and the preview offers the check again for emails not yet checked.
- R9. When neither the email-model setting nor the review-model setting names a model, the consent step asks the developer to pick one of the available models, before any call. The choice is written to the email-model setting, and the board shows which model checked each email.
- R10. A failed or cancelled check leaves that email's blocks as they were and marks it, so it can be checked again. Logs carry metadata only, never email text or model replies, as they do today.
- R11. Cleanup choices, consent and check results are part of the session and survive a reload or restart.

**New tab and writes**

- R12. Before anything is created, the board searches the project for tickets whose summary matches each email's subject. A match is marked as a likely repeat with its key and is not selected for creation.
- R13. Each email row can be created as a ticket or added to an existing ticket as a comment through the board's add-to-ticket control. A likely repeat offers its matched key as the target.
- R14. A comment carries the cleaned body and uploads the email's remaining attachments, following the file rules of today's comment flow.
- R15. Creating tickets keeps today's rules: one ticket per included email, a failed email doesn't stop the rest, attachments are uploaded after creation (a failed upload is a warning, not a failed row), and `ticketSidekick.email.deleteEmlAfterImport` is honoured.
- R16. Writes follow the board rules: a preview, then Apply, a native confirmation when more than one ticket changes, and a line in the Output Channel for each write.
- R17. A drained email import, with no New row left after the writes, finishes without a separate step, as the parity ledger's rule states.

**Settings**

- R18. The review-model and email-model settings exist with the fallback of Key Decisions and are documented in `docs/manual/settings-reference.md`.

**Removal and documentation**

- R19. Every email row of the import board parity ledger (`email-*`, `afterCreate`, the drained finish) is mapped to a board action and a board scenario test before `@jira` is removed.
- R20. Removes the `@jira` participant, its email import and add-as-comment flows, its help screen, its `workspaceState` sessions and the Command Palette command "Create Jira ticket from email (.eml)". Wherever these were mentioned, the docs now point to the import board.
- R21. The README, the manual pages, `CLAUDE.md` and the migration status page describe the email kind and drop `@jira`. The email part of the manual checklist is written and run on the preview build on the managed machine.

### Key Flows

- F1. Batch import from the start screen
  - **Trigger:** The developer opens the import board and picks Email and several `.eml` files.
  - **Actors:** A1, A3
  - **Steps:** Files are parsed (R4). Cleanup detects patterns (R7). Consent and, if needed, a model pick (R8, R9). The model check runs and the preview is shown. Strip or keep. The New tab shows rows with likely repeats marked (R12). The developer creates some rows and adds others as comments (R13). Preview, Apply (R16). The import finishes (R17).
  - **Covered by:** R3 to R17
- F2. Opened from chat
  - **Trigger:** The developer drags an `.eml` into the chat and asks to import it.
  - **Actors:** A1, A2, A3
  - **Steps:** The agent opens the board loaded (R6). Consent is already given by the drag, so the board runs the check or asks for a model (R9), then continues as in F1.
  - **Covered by:** R6, R8, R9

### Acceptance Examples

- AE1. **Covers R1, R2.** Given the probe shows that no model can be called outside a chat request on the managed machine, when planning continues, then the model-check and removal units are not started until the maintainer decides.
- AE2. **Covers R8.** Given an email with no pattern match, when the developer chooses skip on the consent step, then no model call is made and the email goes to the New tab unchanged.
- AE3. **Covers R9.** Given both model settings are empty, when the developer consents, then the board asks for a model before any call, and the next import does not ask again.
- AE4. **Covers R12, R13.** Given an email whose subject matches the summary of PROJ-42, when the New tab lists it, then it is marked as a likely repeat of PROJ-42, isn't selected for creation, and offers "add as comment to PROJ-42".
- AE5. **Covers R14.** Given an email whose cleanup stripped a signature with an inline image, when it is added as a comment, then the comment has the cleaned body and only the attachments that remain are uploaded.
- AE6. **Covers R11.** Given the developer consented and two of five emails were checked, when VS Code restarts, then the board shows those two as checked and the other three as not checked.
- AE7. **Covers R20.** Given this step is released, when a developer types `@jira`, then no participant answers, and the Command Palette has no email import command.

### Scope Boundaries

- Merging email rows into one ticket. The email kind has no fold, as today.
- A separate start mode for adding one email to a given ticket key. Replaced by R13.
- Step 3: the review board, `bitbucket_read_findings`, `/ts-bitbucket`, and removing `@bitbucket`. The review-model setting ships here (R18), but its pick step for reviews belongs to Step 3.
- The `@bitbucket` deprecation mark in the chat UI (O18, Q5) and the keyboard and screen-reader check (O17).
- Guard tests and ledger tables that exist only for the Veracode and Waltz parity stay until the end-of-migration removal checklist, unless planning finds they have nothing left to check.

### Dependencies / Assumptions

- The email chat flow already runs on the shared import engine (`src/imports/`), so the board reuses its rows, creation and `afterCreate`. Only the cleanup step and the comment outcome are new to the board.
- The add-to-ticket control on the New tab, built for Veracode and Waltz folding, can take an email row as its source.
- Verified 2026-11-16: no code outside `src/participant/` calls `vscode.lm.selectChatModels`, and the email check and intent parse use the chat request's model (`src/participant/JiraParticipant.ts:130`, `:173`).

### Outstanding Questions

**Resolve before the model-check units (after R1)**

- If the probe fails: ship the email board with pattern cleanup only and remove `@jira`, or keep `@jira` for the model check until a model call outside a chat request works.

**Deferred to Planning**

- Whether the batch's template is saved as a `ticketSidekick.email.template` setting like the other kinds, or chosen each run.
- How the probe is delivered (a temporary command in a preview build, or the first cut of the board's consent step).
- Which participant guard tests and parity ledger rows go with `@jira` and which wait for the end-of-migration checklist.
- How an email session's id is derived from a batch of files.

### Sources / Research

- [`docs/architecture/migration-status.md`](../architecture/migration-status.md): O7 to O11, Q1, the import board parity ledger and the removal checklist.
- [`docs/report-import.md`](../report-import.md) "EML email import (batch)": today's cleanup, consent, model check and comment flow.
- [`2026-11-14-1641-feat-import-board-veracode-waltz-parity-plan.md`](2026-11-14-1641-feat-import-board-veracode-waltz-parity-plan.md): the import board, start screen and add-to-ticket control this builds on.
- `src/participant/jira/emailHandler.ts`: the `email` descriptor, `afterCreate` and the comment flow.
