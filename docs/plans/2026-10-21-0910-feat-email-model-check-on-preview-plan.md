---
title: Email model check on the cleanup preview - Plan
type: feat
date: 2026-10-21
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Email model check on the cleanup preview - Plan

## Goal Capsule

- **Objective:** After the configured patterns have stripped what they know, a user importing emails can still have the Copilot model look for more boilerplate in those same emails, instead of being limited to the patterns they already wrote.
- **Means:** A `model check` reply and chip on the cleanup preview that reuses the existing model-check pass (KTD1).
- **Authority:** The Product Contract wins on behavior; a KTD wins on mechanism within it. `docs/report-import.md` stays the developer reference and `docs/manual/report-imports.md` the user manual; both change with the code.
- **Stop conditions:** Stop and ask if the second pass cannot keep pattern-found blocks intact when the model call fails (R5), or if block numbers cannot stay valid for `save <n>` after the pass (KTD3).
- **Execution profile:** Code, test-first per unit. Run `npm run compile` and `npm test` before any commit.

---

## Product Contract

### Summary

The cleanup preview offers a `model check` reply and chip. It sends every email the model has not yet checked, except rows the user excluded, to the Copilot model, one at a time. Blocks the model finds join the same preview as numbered, saveable entries. There is no new setting.

### Problem Frame

Today the model only sees emails that matched none of the user's patterns. An email that matched one footer pattern but also carries an unknown disclaimer or signature is never sent, so the model cannot find what the patterns miss. A user who has built up patterns still wants the model's help on the remainder, and learns of the gap only after the preview.

### Key Decisions

- **The AI search is offered on the preview, after patterns ran.** (session-settled: user-directed — chosen over adding pattern-matched emails to the up-front consent question and over a new always-include setting: the user sees what the patterns found before deciding whether to send anything.) Governs R1.
- **`model check` covers all not-yet-checked emails except excluded rows, with no per-row form.** (session-settled: user-directed — chosen over `model check 2, 4` row selection and over pattern-matched-only: the existing exclude toggle already gives per-email control.) Governs R2.

### Requirements

- R1. When at least one email is eligible, the preview shows a `model check` chip and a line saying what it does; when none is eligible, neither appears.
- R2. `model check` on the preview sends each eligible email once: every email with a non-empty body that fits the 30,000-character limit, is not excluded and has not already been model-checked.
- R3. Nothing is sent without that reply, and the answer is not remembered for the next import.
- R4. Blocks the model finds appear in the same preview as numbered blocks marked as found by the model, next to the pattern blocks of that email; `save <n>`, `strip` and `keep` work on them as before.
- R5. A failed model call for one email leaves that email's existing blocks untouched, logs metadata only and does not stop the other emails.
- R6. Cancelling the chat request during the pass keeps finished emails checked, leaves the rest unchecked and stays on the preview; the user can reply `model check` again.
- R7. Block numbers shown after the pass, finished or cancelled, are consistent, and a block already saved as a pattern is not offered for saving again.
- R9. Every email row on the preview, including one with nothing detected, shows the Exclude/Include control, and an excluded row says it is not sent to the model.
- R8. The user manual and developer docs no longer say matched emails are never sent, and describe the preview reply.

### Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given three emails where two matched a footer pattern and the user skipped the model for the third, when the user replies `model check` on the preview, then all three are sent once, and a signature the model finds in email 1 shows as a numbered model block under email 1, beside its pattern block, with a Save chip.
- AE2. **Covers R2, R9.** Given email 2 excluded (including an email with nothing detected), when the user replies `model check`, email 2 is not sent and its row shows the excluded state.
- AE3. **Covers R5.** Given a pattern-matched email whose model call fails, when the pass ends, its pattern blocks still show and a notice says the check failed for it.

### Scope Boundaries

- Not built: telling the model which blocks the patterns already found. Pattern blocks win on overlap in `verifyModelBlocks`, so repeats merge without it; revisit if the model returns noisy duplicates.
- Not built: re-running the model on an email that was already checked in the same import.
- Not built: a `model check <row>` form (see Key Decisions) and a new setting.
- Deferred to Follow-Up Work: none.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Reuse the consent-phase pass.** `runModelCheck` takes the rows to check as a parameter instead of selecting `awaiting-consent` rows itself; consent calls it with those rows, the preview with the eligible rows. One pass, one prompt, one set of limits. Serves R2, R5, R6.
- KTD2. **Eligibility is a pure function on the row.** Not excluded, non-empty body, not over `MODEL_CHECK_MAX_CHARS`, status not `checked`. `declined` and `failed` rows count as eligible because an explicit `model check` on the preview is fresh consent and a failed call is a retry. Serves R1, R2.
- KTD3. **Remap saved block numbers by block identity.** Blocks are numbered across the whole preview in row order, so a model block added to email 1 shifts every later number and would corrupt `savedBlocks`. Before the pass the handler records each saved block as row id + kind + start/end line; after the pass, finished or cancelled, it rebuilds `savedBlocks` from the blocks that still exist with `source: 'model'`. A saved block that is now found by its own pattern drops out and reads as a pattern block. Serves R4, R7. No schema change.
- KTD4. **A failed call keeps existing blocks.** Today a failure sets `blocks = []`, which is harmless at consent (the row has none) and would erase pattern blocks on the preview. The failure branch now only sets `modelStatus = 'failed'`. Serves R5.
- KTD5. **`model check` is parsed on the preview only as the phrase itself.** Not `yes`, which already means something on the consent screen and would be ambiguous next to `strip`/`keep`. Serves R3.

### Assumptions

None beyond the above; `verifyModelBlocks` merging pattern and model blocks was read from the code.

---

## Implementation Units

### U1. Preview eligibility, wording and reply parsing

- **Goal:** The pure session module knows which rows are eligible, shows the offer, parses the reply and remaps saved numbers.
- **Requirements:** R1, R2, R3, R7, R9; KTD2, KTD3, KTD5.
- **Dependencies:** none.
- **Files:** `src/participant/session/emailCleanup.ts`, `src/test/sessionEmailCleanup.test.ts`.
- **Approach:**
  - Add an exported eligibility helper over a session or row, using `isTooLongForModelCheck`.
  - In `buildEmailCleanupPreview`, add one line plus a `Model check` chip (via `buildChatCommandLink`) before the Strip chip when any row is eligible; name how many emails would be sent. Keep email-derived text neutralized as the file already does.
  - Show a short note on pattern-matched rows that are too long for the check, so their absence from the pass is explained.
  - Show the Exclude/Include chip and the excluded marker on rows with nothing detected too, and word the preview's exclude hint as also keeping an email from the model check (R9).
  - In `parseEmailCleanupReply`, return `{ action: 'model-check' }` for the preview phase on `model check` / `model-check` only.
  - Add a pure helper that, given the saved numbers and the numbered blocks before, returns the saved numbers for the numbered blocks after (KTD3).
  - Update the file's header comment: the preview now also hosts the second model pass.
- **Patterns to follow:** existing `buildEmailCleanupConsent` chip line and `numberEmailCleanupBlocks`.
- **Test scenarios:**
  - Covers AE2. A session with a matched row, an unmatched `declined` row and an excluded row lists exactly the first two as eligible.
  - A `checked` row, an empty-body row and a row over 30,000 characters are not eligible.
  - The preview of a session with an eligible row contains the `model check` chip and the line; with no eligible row it contains neither.
  - A command: link or angle-bracket autolink in a subject stays inert on the new line.
  - `parseEmailCleanupReply('model check', 'preview', ids)` and `'Model-Check'` give `model-check`; `'yes'` and `'check'` stay `invalid` in the preview.
  - Saved block #2 (email 2) after a model block is inserted into email 1 maps to #3; a saved block whose identity is gone is dropped.
- **Verification:** The unit tests pass and the preview text reads correctly for one email and for several.

### U2. The model pass from the preview

- **Goal:** Replying `model check` on the preview runs the pass over the eligible rows and merges the result.
- **Requirements:** R2, R4, R5, R6, R7; KTD1, KTD3, KTD4.
- **Dependencies:** U1.
- **Files:** `src/participant/jira/emailHandler.ts`, `src/test/emailHandler.test.ts`.
- **Approach:**
  - Change `runModelCheck` to take the rows to check; consent passes its `awaiting-consent` rows. Leave a row's blocks alone on failure (KTD4). Add the phase to the existing log fields.
  - In `handleEmailCleanupReply`, handle `model-check` in the preview branch of the switch:
    1. Without a model, re-show the preview with the "no Copilot model" notice.
    2. With no eligible row, re-show the preview with a "nothing left to check" notice.
    3. Otherwise run the pass, then remap `savedBlocks` on every exit (KTD3), cancelled included.
    4. On `cancelled`, keep the preview with a "Model check stopped" notice; on `done`, re-show it with a notice saying how many blocks were added, or that the model found nothing more, plus how many emails failed.
  - Keep the session metadata and the `email-cleanup` follow-up kind unchanged.
- **Patterns to follow:** the consent branch of `handleEmailCleanupReply` and `runModelCheck`'s retry and cancel handling.
- **Execution note:** Start with a failing handler test for AE1, the highest-value path.
- **Test scenarios:**
  - Covers AE1. Two pattern-matched emails and one unmatched email: after consent is skipped, `model check` on the preview sends the matched emails (and the declined one) once each; a signature the model returns for email 1 shows as a model block with a Save chip, and email 1 keeps its pattern block.
  - Covers AE2. An excluded row is not sent.
  - Covers AE3. A failing call for a matched email leaves its pattern blocks, shows a failure notice and logs no body or reply text.
  - A second `model check` right after a finished one says nothing is left and sends nothing.
  - Cancelling part-way keeps the finished row `checked`, leaves the rest as before, stays on the preview and the next `model check` sends only the unfinished rows; a block saved before the cancel keeps its marker on the same block.
  - No model available keeps the preview and sends nothing.
  - `save <n>` after the pass saves the right block even though a model block was added above it; a block saved before the pass is not offered again.
  - `strip` after the pass removes pattern and model blocks and hands the cleaned items on, as before.
  - For the single-email "add email to PROJ-42" target, `model check` on the preview works the same and `strip` continues into the comment preview.
- **Verification:** `npm run compile` and `npm test` are green; existing consent tests still pass with the new `runModelCheck` signature.

### U3. Documentation

- **Goal:** The user manual and developer docs describe the preview reply.
- **Requirements:** R8.
- **Dependencies:** U1, U2.
- **Files:** `docs/manual/report-imports.md`, `docs/report-import.md`.
- **Approach:**
  - In the manual's cleanup section, add a `model check` row to the preview reply table and a sentence that it also covers emails your patterns matched. Keep the consent table's "emails that matched a pattern are never sent" accurate for that screen and point to the preview reply.
  - In `docs/report-import.md` item 4, add the preview `model check` pass: eligibility, saved-number remap and that a failure keeps pattern blocks.
  - No `package.json` change, so `src/test/userDocsSync.test.ts` is unaffected; chat reply words are not machine-checked (KL9), so read both pages once for consistency.
- **Test expectation:** none -- documentation only.
- **Verification:** `npm test` still passes; the manual no longer claims matched emails can never be sent.

---

## Verification Contract

| Check | Command | Applies to |
|---|---|---|
| Type check | `npm run compile` | U1, U2 |
| Unit and handler tests | `npm test` | U1, U2, U3 |

## Definition of Done

- All R1–R8 hold and AE1–AE3 are covered by tests.
- `npm run compile` and `npm test` are green.
- The manual and `docs/report-import.md` match the shipped replies.
- No abandoned experimental code remains in the diff.
