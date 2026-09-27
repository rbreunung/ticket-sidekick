---
title: Bitbucket Review Teams Export - Plan
type: feat
date: 2026-09-27
topic: bitbucket-review-teams-export
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Bitbucket Review Teams Export - Plan

## Goal Capsule

- **Objective:** A developer can share a completed `@bitbucket` PR review with colleagues in a Microsoft Teams chat in one action, and the pasted text reads cleanly without any hand-editing.
- **Means:** Copy the active review to the clipboard as one plain-text block, grouped by severity.
- **Product authority:** This Product Contract. `STRATEGY.md` boundaries still apply: nothing leaves the machine without the user doing it.
- **Open blockers:** None.

---

## Product Contract

### Summary

After a review, a "Copy for Teams" follow-up chip, or typing `copy`, puts the whole review on the clipboard as one plain-text block. Typing `copy #1 #3` copies only those findings. The block lists findings under Critical / Warning / Suggestion headings and is laid out to read correctly when pasted into Teams, where Markdown is not rendered.

### Problem Frame

A review now renders as up to three severity tables with five columns each. Sharing one in Teams means selecting and copying each table separately. The pasted Markdown tables arrive as raw pipes and separator rows. The clickable `#N` headings, bold markers and command links show up as noise. Colleagues end up with a pasted review that is hard to read, or the developer reformats it by hand.

### Key Decisions

- **Clipboard, not a Teams webhook.** Webhooks only post into channels, not 1:1 or group chats, and would send review content off the machine without a user step. Governs R1, R9. (session-settled: user-directed — chosen over posting via a Teams webhook and over saving a file: works for any chat and keeps sharing a user action)
- **Plain text, not rich formatting.** The VS Code extension clipboard API writes plain text only. Rich formatting would need extra machinery (a webview or OS-specific clipboard calls). Governs R4, R5. (session-settled: user-approved — chosen over rich HTML formatting: no extra mechanism, works on every OS)
- **Grouped list, not tables.** A list reads well in a narrow chat pane and on mobile, and pastes without layout breakage. Governs R3. (session-settled: user-directed — chosen over one combined table and over the current three tables)
- **Selection reuses the review's finding numbers.** `copy #1 #3` uses the same `#N` numbering as `add #1 #3 to review`, so there's nothing new to learn. Governs R7. (session-settled: user-directed — chosen over "always everything" and "everything except muted")

### Requirements

**Triggering**

- R1. After a review completes, a "Copy for Teams" follow-up chip is offered alongside the existing review follow-ups. Clicking it copies the whole review.
- R2. Typing `copy` (or a clear equivalent like "copy for teams") in an active review session copies the whole review. `copy` followed by `#N` references copies only those findings.

**Content and layout**

- R3. The copied text starts with the PR number, PR title, author, target branch and the PR URL. It then lists findings under Critical, Warning and Suggestion headings in that order, leaving out any empty group. Each group heading shows its count.
- R4. Each finding carries its `#N`, severity, file and line (when known), title and full recommendation, laid out so it reads as a distinct block in unformatted text.
- R5. The text contains no Markdown table syntax, no bold/italic markers, no chat command links and no escaping left over from the chat rendering. Emoji severity markers are allowed. The PR URL appears as a bare URL so Teams can auto-link it.
- R6. Low-confidence findings (below `confidenceThreshold`) and location-unverified findings stay in the text with a short visible marker, never silently dropped.
- R7. When specific findings are requested, only those appear, still grouped by severity. The header notes that it is a selection (e.g., "2 of 7 findings").
- R8. A review with no findings copies the header plus a "No issues found" line.

**Feedback and session**

- R9. Copying writes only to the local clipboard. Nothing is sent anywhere else.
- R10. After copying, chat shows a short confirmation naming how many findings were copied and suggesting to paste into Teams. The review session stays active so further follow-ups (`#N` questions, `add … to review`, another copy) keep working.
- R11. Unknown `#N` references in a copy request get the same "Finding #N not found. The review has findings #1–#M." answer the `add` path already gives. Nothing is copied in that case.

### Acceptance Examples

- AE1. **Covers R2, R3, R4, R10.** **Given** a review with 2 critical and 3 warning findings, **when** the user clicks "Copy for Teams", **then** the clipboard holds a header with the PR URL, a "Critical (2)" group and a "Warning (3)" group, no Suggestion group, and chat confirms "5 findings copied".
- AE2. **Covers R7.** **Given** a review with findings #1–#7, **when** the user types `copy #1 #3`, **then** only #1 and #3 are in the text, each under its own severity heading, and the header says 2 of 7.
- AE3. **Covers R6.** **Given** a finding whose anchor could not be located, **when** the review is copied, **then** that finding appears without a line number and with a "location unverified" marker.
- AE4. **Covers R11.** **Given** a review with findings #1–#4, **when** the user types `copy #9`, **then** nothing is copied and chat answers "Finding #9 not found. The review has findings #1–#4."
- AE5. **Covers R2.** **Given** the user moved on to another prompt so the review session expired, **when** they type `copy`, **then** it is not treated as a copy request (there is no review to copy). The user reruns the review to share it.

### Success Criteria

- Pasting the copied text into a Teams 1:1 or group chat (desktop and web) produces a readable message with no manual cleanup: no stray pipes, asterisks, backslashes or `command:` links.

### Scope Boundaries

- Sharing follow-up answers (`#N` explanations, diff-aware answers) is out of scope. Only the review's findings are exported.
- Posting to Teams directly (webhook or Graph API) and saving to a file are out of scope (see Key Decisions).
- Rich-text (HTML) clipboard output is out of scope.
- Other destinations (Slack, email, a Jira comment) are not goals. The plain text may happen to work there too.
- Changing how the review renders in VS Code chat is out of scope.

### Dependencies / Assumptions

- Teams does not render Markdown pasted as plain text, but it does auto-link bare URLs and display emoji. The layout in R3–R5 assumes this.
- Copy relies on the stored review session (`bitbucket.session.review`), which already holds the numbered findings and PR reference. It never re-parses the rendered chat output.

### Outstanding Questions

**Deferred to Planning**

- Exact plain-text layout per finding (indentation, separators, line-wrapping of long recommendations). The layout must satisfy R4–R5 and should be checked by pasting a sample into Teams.
- The exact wording that counts as a copy request, and how it coexists with `parseFollowUpIntent` so a question such as "can you copy the logic from #2?" is still answered, not copied.
- Whether the stored session holds everything R3 needs (author, target branch), or needs a small addition.

### Sources / Research

- `src/services/PrReviewService.ts` — `formatReview()` renders the three severity tables and sanitizes untrusted strings for chat. The copy text needs its own plain-text output, not these table rows.
- `src/participant/BitbucketParticipant.ts` — the review completion stores `ReviewSession` and returns the `reviewCompleted` follow-up state that drives the existing chips.
- `src/participant/reviewSessionState.ts` — `parseFollowUpIntent` (the `add #N to review` parsing to mirror), `BitbucketFollowupState` (follow-up chips).
- `docs/review-process.md` "Follow-ups" — session lifetime and detection order a copy request must slot into.
- `STRATEGY.md` Boundaries — no routing of content through third-party services without a user step.
