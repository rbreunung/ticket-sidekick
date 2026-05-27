# LLM Prompt Quality Audit — Design Spec

**Date:** 2026-05-27
**Branch context:** Follows `feature/jira-comment-generation-quality`, which introduced the 3-message role pattern, grounding instructions, and `contentSource` routing for `generateContent`.

---

## Context

The `feature/jira-comment-generation-quality` branch fixed the most visible prompt quality issues: `generateContent` now uses specialized roles, grounding instructions, and properly routes history based on `contentSource`. An audit of all remaining LLM call sites in the codebase found four categories of follow-up work:

1. **Bug** — `ContentSession` does not store `contentSource`. Refinements in `handleContentSession` call `generateContent` without the 5th argument, losing the specialized role/grounding that was applied on the initial generation.
2. **Prompt inconsistency** — Five functions (`synthesizeComments`, `generateDescriptionAndCommentsSummary`, `parseIntent`, `spellCheckValue`, `checkSectionCoverage`) use bare single-turn prompts instead of the `[User role, Assistant ack, User task]` pattern established by `generateContent`.
3. **Bitbucket Pass 2** — `PrReviewService.buildPrompt` includes the full file contents on Pass 2 but adds no "re-evaluate uncertain findings" instruction, wasting the additional context.
4. **Test coverage** — `buildHistoryContext`, `extractLastAssistantText`, and `generateContent` role selection are not covered by unit tests.

---

## Architecture

All changes are in-place modifications to existing functions — no new abstractions, no new files. Each function gets targeted improvements that keep it independently testable and readable.

### Call chain reference

```
JiraParticipant
  └─ parseIntent                    ← Section 2: add role/ack
  └─ synthesizeComments             ← Section 2: add role/ack + grounding
  └─ generateDescriptionAndCommentsSummary  ← Section 2: add role/ack + grounding
  └─ generateContent                ← already upgraded; Section 1: receives contentSource from session
  └─ spellCheckValue                ← Section 2: add role/ack
contentHandler.handleContentSession
  └─ generateContent                ← Section 1: pass session.contentSource
createHandler.checkSectionCoverage  ← Section 2: add role/ack

BitbucketParticipant
  └─ PrReviewService.buildPrompt    ← Section 3: add Pass 2 re-evaluation note
```

---

## Section 1 — Bug: `ContentSession` missing `contentSource`

### Problem

`ContentSession` (the `addComment | updateDescription` variant in `sessionState.ts`) has no `contentSource` field. When `handleContentSession` processes a refinement (not a confirm/cancel), it calls:

```typescript
const refined = await generateContent(prompt, model, token, refineContext);
// ↑ no contentSource — always uses generic Jira assistant role
```

A comment initially generated with `history-full` (scribe role + grounding) gets the generic role on every subsequent refinement.

### Fix

**`src/participant/sessionState.ts`**
Add `contentSource: 'generate' | 'history-recent' | 'history-full'` to the `addComment | updateDescription` variant of `ContentSession`.

**`src/participant/jira/contentHandler.ts`**
- `streamContentPreview` input parameter gains `contentSource`; it is saved into the session object.
- Refinement branch in `handleContentSession`: pass `session.contentSource` as the 5th argument to `generateContent`.

**`src/participant/JiraParticipant.ts`**
- Both `addComment` and `updateDescription` callsites already have `nonLiteralSource` in scope; pass it to `streamContentPreview`.

### Tests

Add one test to `src/test/contentHandler.test.ts`: `handleContentSession — addComment refinement preserves contentSource`. Mock `generateContent`; store a session with `contentSource: 'history-full'`; send a refinement message; assert `generateContent` was called with `'history-full'` as the 5th argument.

---

## Section 2 — Jira prompt quality upgrades

All five functions in `src/participant/jira/llmHelpers.ts` and `src/participant/jira/createHandler.ts` are upgraded to the `[User role, Assistant ack, User task]` pattern. Grounding notes are added to prose-output functions.

### `synthesizeComments`

Two modes; each gets a distinct role:

- **Summary mode** role: `"You are a Jira comment analyst. Your task is to produce concise numbered summaries of each comment."`
- **Query mode** role: `"You are a Jira comment analyst. Your task is to find and quote comments relevant to the user's query."`
- Grounding note appended to the task: `"Base your response only on the comments provided above. Do not invent or infer information not present in the source."`

### `generateDescriptionAndCommentsSummary`

Role: `"You are a technical scribe. Your task is to write a single prose paragraph summarizing a Jira ticket's description and comments."`
Grounding note: `"Base your summary only on the description and comments provided above."`

### `parseIntent`

Role: `"You are a Jira intent parser. Your task is to analyze user commands and produce structured intent as a JSON object matching the schema below."`
Ack: `"Understood. I parse Jira commands into structured JSON."`
The existing schema and operation definitions remain in the User task message (INTENT_PROMPT stays as-is, just moved to the 3rd message).

### `spellCheckValue`

Role: `"You are a copy editor. Your task is to find and correct spelling and grammar errors in text."`
Ack: `"Understood. I identify and fix spelling and grammar errors."`
The UNCHANGED / corrected-text output instruction remains in the User task message.

### `checkSectionCoverage` (createHandler.ts)

Role: `"You are a content coverage analyst. Your task is to determine which template sections are addressed by the given text."`
Ack: `"Understood. I identify which sections are covered."`
The JSON array output instruction remains in the User task message.

### Verification

TypeScript compilation (`npm run compile`) is the primary verification — `model.sendRequest` calls are VS Code-dependent and cannot be Vitest unit tested. The test suite must remain green.

---

## Section 3 — Bitbucket Pass 2 re-evaluation note

### Problem

`PrReviewService.buildPrompt` builds the same prompt structure for both Pass 1 (no file contents) and Pass 2 (with file contents). The model sees more evidence in Pass 2 but has no instruction to re-evaluate uncertain findings from Pass 1.

### Fix

In `src/services/PrReviewService.ts`, inside `buildPrompt`, detect Pass 2 by checking whether `fileContents` is provided and non-empty. Append the following after the existing grounding rules:

> `"Note: This is a second-pass review. Full file contents have been provided for files you flagged as needing additional context. Use them to confirm or retract uncertain findings — if a finding was speculative due to missing context and the full file shows no issue, omit it from your response."`

No new parameter is needed; `fileContents` presence is the signal.

### Tests

Add one test to `src/test/PrReviewService.test.ts`: `buildPrompt — includes re-evaluation note when fileContents is provided`. Assert the prompt string contains the re-evaluation note when `fileContents` is a non-empty Map.

---

## Section 4 — Test coverage gaps

Three new `describe` blocks in `src/test/llmHelpers.test.ts`:

### `buildHistoryContext`

Pure function with no VS Code model dependency. 3 tests:
- `'generate'` → returns `undefined`
- `'history-recent'` → returns serialized turns in recent mode (calls `serializeTurns` with `'recent'`)
- `'history-full'` → returns serialized turns in full mode (calls `serializeTurns` with `'full'`)

Mocked `vscode.ChatContext` with 2 turns is sufficient.

### `extractLastAssistantText`

Uses the existing vscode mock infrastructure. 3 tests:
- Returns the last assistant turn text (no preview marker)
- Skips assistant turns containing `<!-- jira:previewing -->` and returns the previous non-preview assistant turn
- Returns `''` when no non-preview assistant turns exist

### `generateContent` — role selection

Requires mocking `model.sendRequest` to return an async iterable. 2 tests:
- `contentSource: 'history-full'` → first message in `sendRequest` call contains the scribe role text
- `contentSource: 'generate'` → first message contains the generic Jira assistant role text

The mock can return an empty string; the test only checks the messages array passed to `sendRequest`.

---

## File map

| File | Change |
|------|--------|
| `src/participant/sessionState.ts` | Add `contentSource` to `ContentSession` (addComment/updateDescription variant) |
| `src/participant/jira/contentHandler.ts` | `streamContentPreview` input + session storage + refinement `generateContent` call |
| `src/participant/JiraParticipant.ts` | Pass `contentSource` to `streamContentPreview` at both callsites |
| `src/participant/jira/llmHelpers.ts` | Upgrade `synthesizeComments`, `generateDescriptionAndCommentsSummary`, `parseIntent`, `spellCheckValue` to 3-message pattern |
| `src/participant/jira/createHandler.ts` | Upgrade `checkSectionCoverage` to 3-message pattern |
| `src/services/PrReviewService.ts` | Append Pass 2 re-evaluation note when `fileContents` present |
| `src/test/contentHandler.test.ts` | New test: refinement preserves `contentSource` |
| `src/test/PrReviewService.test.ts` | New test: re-evaluation note present in Pass 2 prompt |
| `src/test/llmHelpers.test.ts` | 3 new describe blocks: `buildHistoryContext`, `extractLastAssistantText`, `generateContent` role |

---

## Verification

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

All tests must be green. No new test should be skipped. Compilation must be error-free.

Manual smoke tests:
1. Refine a history-based comment twice — role in LLM call should stay as scribe, not revert to generic assistant
2. Run `@jira summarize on PROJ-1` — `generateDescriptionAndCommentsSummary` output should be a clean prose paragraph without preamble
3. `@jira show comments on PROJ-1` — `synthesizeComments` output should be a clean numbered list
4. Run a Bitbucket PR review with a complex file — Pass 2 should more aggressively retract speculative findings
