---
title: Email Boilerplate Cleanup - Plan
type: feat
date: 2026-09-30
topic: email-boilerplate-cleanup
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Email Boilerplate Cleanup - Plan

## Goal Capsule

- **Objective:** Jira tickets and comments created from emails contain the actual message content, not repeated confidentiality headers, legal footers, bulky signatures or signature images, while the user stays in control of what is removed.
- **Product authority:** This Product Contract. Surrounding email-import behavior (batch review, template pick, attachment upload, `.eml` deletion) stays as documented in `docs/report-import.md` except where a requirement below changes it.
- **Open blockers:** None.

---

## Product Contract

### Summary

Before an email becomes a ticket or a comment, `@jira` detects confidentiality headers, legal footers and signature blocks throughout the thread. It uses the user's configured patterns first. If the user agrees for this batch, the Copilot model covers emails no pattern matched. One preview lists what was found per email. The user then strips or keeps the blocks, and can exclude single emails. Inline images that sit only inside stripped blocks are dropped. Signature authors' names are kept where they can be identified.

### Problem Frame

Emails imported from OWA carry company boilerplate: a confidentiality notice at the top, a legal disclaimer at the bottom, and long signatures with logos and social-media icons. Forwarded threads repeat all of it for every quoted message. Today the full body becomes the ticket description or comment verbatim, and every attachment, including inline signature images, is uploaded to the ticket. Tickets end up dominated by noise, and the attachment list fills with logo files.

### Key Decisions

- **Configured patterns first, model as a fallback.** Known company texts are removed the same way every time; the model only covers what patterns miss. Governs R2, R3. (session-settled: user-directed — chosen over model-only detection, pattern-only detection, and fixed built-in heuristics: predictable for known texts, still works without setup.)
- **The model runs only after a per-batch yes.** Email import makes no model calls today, and these are bank emails marked confidential. Governs R3. (session-settled: user-directed — chosen over an opt-in setting and on-by-default: the user decides per run whether content leaves for the model.)
- **Patterns live in user settings.** Governs R1. (session-settled: user-directed — chosen over the shared `.jira-templates.json` and a merged team+personal model: simpler to edit; each user keeps their own list.)
- **One batch-wide preview, not a per-row column or a silent setting.** Governs R6, R7. (session-settled: user-directed — chosen over a toggle column in the review table and an off/ask/always setting: the user sees what will be cut before deciding.)
- **Strip every occurrence, including quoted history.** Governs R4. (session-settled: user-directed — chosen over outer-message-only and disclaimers-everywhere-but-outer-signature-only: cleanest ticket.)
- **Images are removed only by position, not by fingerprint.** Governs R9. (session-settled: user-directed — chosen over also stripping known images by content hash and over stripping only the importing user's own signature: nothing to configure.)
- **Both email flows get the cleanup.** Governs R11. (session-settled: user-directed — chosen over batch ticket creation only: comments get the same noise.)
- **Keep the author's name best-effort; no header fallback.** Governs R5. (session-settled: user-directed — chosen over falling back to the sender's display name when the signature has no name: a nameless signature is removed completely.)

### Requirements

**Detection**

- R1. Users configure known confidentiality-header, legal-footer and signature patterns in a user-level `ticketSidekick.email.*` setting; with no patterns configured, detection relies on R3 alone.
- R2. Each email is checked against the configured patterns, and every matching block is recorded with its kind (header, footer, signature).
- R3. When at least one email in the batch has no pattern match, the user is asked once per batch whether the Copilot model may look at those emails; the model runs only on a yes, and only for those emails.
- R4. Detection covers the whole thread, so blocks repeated inside quoted or forwarded messages are found as well as the outer message's.

**Signature handling**

- R5. When a signature block is stripped, the author's name in it is kept on a best-effort basis; a signature with no recognizable name is removed completely.

**Preview and decision**

- R6. Before the batch review (or before the comment preview in the single-file flow), one preview lists, per email, which block kinds were found, a short excerpt of each, and the number of images that would be dropped.
- R7. The user replies once for the whole batch to strip or keep the detected blocks, and can exclude individual emails from stripping by row id.
- R8. For a block the model found, the preview offers to save it as a pattern, so the same text is caught by R2 next time without the model.

**Images and attachments**

- R9. An inline image that appears only inside stripped blocks is removed from the description and is not uploaded as an attachment; an image also used in the kept body stays.

**Scope of effect**

- R10. Emails with nothing detected, and emails the user kept or excluded, are imported exactly as today.
- R11. The cleanup applies to both batch ticket creation from emails and the single-file "add email as comment" flow.

### Key Flows

- F1. Batch import with cleanup
  - **Trigger:** The user imports one or more `.eml` files by any existing entry point.
  - **Steps:** The files are parsed. The configured patterns run (R2, R4). If any email has no match, the user is asked whether the model may look (R3). The preview is shown (R6, R8). The user replies strip/keep and optionally excludes rows (R7). The existing template pick, review and creation continue with the cleaned bodies and the reduced attachment set (R9).
  - **Covered by:** R2–R9, R11
- F2. Add email as comment with cleanup
  - **Trigger:** `@jira add email <KEY>` with a single file.
  - **Steps:** Same detection and preview as F1 for the one email, then the existing comment preview and posting.
  - **Covered by:** R11

### Acceptance Examples

- AE1. **Covers R3.** Given three emails where two match configured patterns, when the batch is parsed, the user is asked once whether the model may look at the one unmatched email; on "no", that email shows "nothing detected" in the preview and imports unchanged.
- AE2. **Covers R4.** Given a forwarded thread with the company disclaimer under each of four quoted messages, when the user chooses strip, all four disclaimers are removed.
- AE3. **Covers R5.** Given a signature "Best regards, Anna Schmidt, Senior Analyst, Phone …, [logo]", when stripped, "Anna Schmidt" stays and the title, phone and logo are removed. Given a signature "BR" plus a logo, when stripped, nothing of it stays.
- AE4. **Covers R9.** Given a logo image referenced once in a stripped signature and once in the kept body, when stripped, the logo stays inline and is still uploaded.
- AE5. **Covers R7.** Given a batch of five emails with detections, when the user replies strip and excludes row 3, emails 1, 2, 4, 5 are cleaned and email 3 imports unchanged.
- AE6. **Covers R8.** Given the model found a footer that no pattern matched, when the user accepts "save as pattern", the next import catches the same footer through the patterns without asking about the model.

### Scope Boundaries

- Recognizing signature images by content fingerprint outside a detected block (e.g. a logo in the middle of the body).
- Team-shared patterns in `.jira-templates.json`.
- Falling back to the header's display name when a signature has no recognizable name.
- Keeping stripped text anywhere: if `ticketSidekick.email.deleteEmlAfterImport` is on, stripped blocks are gone for good. Accepted by the user.

### Dependencies / Assumptions

- The model fallback uses the same Copilot Language Model access the rest of `@jira` already uses; no new provider.
- Per-batch model consent is not remembered between batches.

### Outstanding Questions

**Deferred to Planning**

- How a pattern marks the extent of a block (e.g. from a marker phrase to the end of the message part vs. an explicit start/end pair) and whether patterns are plain text or regular expressions.
- How "author's name" is identified in a signature (heuristic, model, or both) within the best-effort bound of R5.
- Where exactly the preview step sits relative to the template pick in F1, and how it reuses the existing clickable-reply mechanism.

### Sources / Research

- `src/utils/emlParser.ts` — `parseEmlFile()` converts the HTML body to Markdown and collects all attachments, inline ones included; the single shared entry point for all three `.eml` entry points.
- `src/participant/jira/emailHandler.ts` — the batch descriptor's `afterCreate` uploads every attachment of a row; the single-file comment flow likewise uploads all of `session.attachments`.
- `docs/report-import.md` "EML email import (batch)" — the current batch flow this feature inserts into.
- `docs/plans/2026-09-03-2108-feat-batch-email-import-plan.md` — batching decisions for email import.
