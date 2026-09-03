---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
date: 2026-09-03
type: feat
topic: bitbucket-onboarding-clarity
---

# Clearer Bitbucket Onboarding: Where to Put the PR URL

## Goal Capsule

**Objective:** Make the `@bitbucket` message format unmistakable at every user-facing surface, and surface the optional upfront-question syntax so first-time users discover it without reading docs.

**Context:** Users who type `@bitbucket` see a generic description ("Review Bitbucket pull requests with natural language") that tells them *what* it does but not *what to do next*. The exact format (`@bitbucket <url>` on one line) is buried in prose, and the upfront-question feature (`-- Did I introduce any regression?`) is implemented and tested but never surfaced outside `docs/review-process.md`.

**Scope boundary:** Copy/clarity changes to three existing surfaces only. No new code paths, no new features, no new UI components. The greeting message stays unchanged (already concise; the no-URL fallback is where confused users land).

## Product Contract

### Requirements

| ID | Requirement |
|----|-------------|
| R1 | The participant description shown when a user types `@bitbucket` in the chat box must state the exact format (`@bitbucket <url>`) and point to `help` for options. |
| R2 | The walkthrough "first review" step must show the format on its own line (not buried in prose) and include an upfront-question example. |
| R3 | The chat no-URL fallback message must explicitly say "paste the URL right after `@bitbucket`", include an upfront-question example, and end with a "type `@bitbucket help`" hint for confused users. |

### Flows

**Flow: User types `@bitbucket` and is unsure what to do next**

1. User types `@bitbucket` in the Copilot chat box.
2. VS Code shows the participant description inline: *"Paste a PR URL to review it: @bitbucket \<url\> — type "help" for options"*.
3. If the user hits Enter with no URL (or non-greeting text without a URL), the no-URL fallback responds with the format on its own line, an upfront-question example, and a "type `@bitbucket help`" hint.
4. If the user is in the Getting Started walkthrough, the first-review step shows the same format + upfront question before the "Ask @bitbucket to review a PR" button.

### Acceptance Examples

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Cold start | User has never used `@bitbucket` | Types `@bitbucket` in chat box | Sees inline hint with exact format and "type help" pointer |
| Confused user | User types `@bitbucket review this` (no URL) | Receives the no-URL fallback | Message says "paste the URL right after `@bitbucket`", shows an upfront-question example, and offers `@bitbucket help` |
| Walkthrough user | User is on the Getting Started walkthrough | Reads the first-review step | Sees the format on its own line + an upfront-question example before the action button |

### Non-Goals

- Changing the greeting message (stays lean; chip handles next steps)
- Adding a new onboarding surface, command, or doc section
- Modifying the `help` command's own response content
- Changing the upfront-question parsing logic or syntax

## How This Work Fits Together

This is a self-contained clarity pass. It does not depend on or block any other planned work. The upfront-question feature it surfaces was already fully implemented and tested (`parseUpfrontQuestion`/`stripUpfrontQuestion` in `reviewSessionState.ts`); this plan only makes it discoverable.

## Implementation Notes (for ce-plan)

Three files, all copy-only:

1. **`package.json`** — `contributes.chatParticipants[1].description`: replace generic description with format + help pointer.
2. **`walkthroughs/bitbucket/first-review.md`** — restructure the "paste a real PR URL" sentence into its own code line; add upfront-question example paragraph.
3. **`src/participant/BitbucketParticipant.ts`** (~line 587) — rewrite the no-URL fallback `stream.markdown(...)` string: add "paste the URL right after", upfront-question example, and "type help" hint.

No test changes needed (the fallback message text is not asserted in unit tests; it's a chat-streaming string). Compile + existing test suite must stay green.
