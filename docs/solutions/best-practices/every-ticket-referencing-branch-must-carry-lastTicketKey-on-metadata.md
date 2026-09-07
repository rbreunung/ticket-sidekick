---
title: Every ticket-referencing branch must carry lastTicketKey on metadata, or a bare follow-up loses its context
date: 2026-09-07
category: best-practices
module: jira/session-state
problem_type: best_practice
component: service_layer
severity: medium
applies_when:
  - "A multi-turn Copilot Chat flow carries a scalar piece of context (a ticket key, a PR URL, a selected item) across turns via ChatResult.metadata.jiraSession.lastTicketKey"
  - "You are adding or modifying a branch that references a ticket but does not start a new multi-turn session"
  - "You are migrating a visible-marker mechanism (HTML comment in rendered text) to a structured metadata field"
symptoms:
  - "A bare follow-up like 'add a comment' after a ticket-referencing response returns 'I don't have a ticket in context — which ticket?' even though the ticket was just named"
  - "The failure is intermittent and depends on whether an *older* turn in history happened to carry lastTicketKey; the current turn did not"
  - "The visible-marker approach leaked a marker into the rendered chat and required stripping it from LLM history text (stripHiddenMarkers in sessionState.ts:330)"
root_cause: missing_validation
resolution_type: code_fix
related_components: [documentation, testing_framework]
tags: [lastTicketKey, jiraSession, ChatResult-metadata, empty-kinds-sentinel, session-state, multi-turn, html-marker, parity-bug]
---

# Every ticket-referencing branch must carry lastTicketKey on metadata, or a bare follow-up loses its context

## Context

The `@jira` Copilot Chat participant tracks which ticket the conversation is currently about, so a bare follow-up like "add a comment" resolves to the right ticket without the user re-typing the key. The original mechanism was a **visible HTML-comment marker** injected into the rendered chat text: `<!-- @jira-ticket:KEY -->`. The reader had to strip that marker out of the LLM history text before re-feeding it to the model, because a literal HTML comment leaking into the conversation would pollute future prompts.

The migration (R13 of the `feat/native-chat-interaction` plan, PR #53) moved the ticket key off the rendered text and onto the structured `ChatResult.metadata.jiraSession.lastTicketKey` field. No marker is appended to rendered responses anymore.

The migration itself is documented in `docs/jira-flows.md` (the "Last-ticket context" and "Jira sessions" sections). This learning is the **post-implementation "what we learned"** companion — specifically the two review-caught parity bugs and the convention that prevents them.

## Guidance

When you need to remember "which ticket are we talking about" across chat turns, **carry the key on `ChatResult.metadata`, never in the rendered text.**

Concretely, in the `@jira` participant:

- Every branch that references a ticket returns `{ metadata: { jiraSession: { kinds: [], lastTicketKey } } }` — the **empty-kinds sentinel**. All ~39 existing consumers read the session via `getActiveJiraSession(...)?.kinds.includes(...)`, and an empty `kinds` array keeps every one of those checks false (no active session) while still letting the key be found. This is why the sentinel is safe: it is indistinguishable from "no session" to the session-detection logic, but the key is still discoverable.
- The reader, `parseLastTicketFromContext` in `src/participant/jira/ticketContext.ts:121`, reverse-iterates `ChatContext.history` and reads `(turn.result.metadata as { jiraSession?: JiraSessionContinuity } | undefined)?.jiraSession?.lastTicketKey`, first hit wins. This preserves the original "latest referenced ticket wins" semantics without scanning rendered markdown.
- The shape is declared on `JiraSessionContinuity` in `src/participant/sessionState.ts:1602`.

### The parity-bug gotcha

The non-obvious part: **any branch that references a ticket must carry `lastTicketKey`, even when it does not start a new multi-turn session.** A branch that references a ticket but returns bare `void` silently drops the context, and the next bare follow-up can no longer resolve.

Two branches of this exact shape were caught during review and fixed:

- **Multi-key bulk field-update** (`src/participant/JiraParticipant.ts`). The single-key path carried `lastTicketKey`, but the multi-key path returned bare `void` after streaming "Done — N updated". This was a **regression** versus the pre-diff behavior, which appended the marker for both paths. Fixed so the last successfully updated key is carried, matching the single-key path:

  ```ts
  // src/participant/JiraParticipant.ts — field-update-preview confirmation
  let lastUpdatedKey: string | undefined;
  if (toUpdate.length === 1) {
    await jiraClient.updateIssue(toUpdate[0], { [previewSession.fieldId]: previewSession.fieldValue });
    return { metadata: { jiraSession: { kinds: [], lastTicketKey: toUpdate[0] } } };
  } else {
    await ticketService.bulkUpdateField(toUpdate, previewSession.fieldId, previewSession.fieldValue, (key, ok, err) => {
      if (ok) { passed++; lastUpdatedKey = key; }   // capture the last success
      else { failed++; }
    });
  }
  // R13: carry the last successfully updated key on metadata (parity with the
  // single-key path above) so a bare follow-up after a multi-ticket update resolves.
  if (lastUpdatedKey !== undefined) {
    return { metadata: { jiraSession: { kinds: [], lastTicketKey: lastUpdatedKey } } };
  }
  return;
  ```

- **Spell-check no-op early returns** (`src/participant/jira/fieldHandler.ts`). The "no description to check" and "no issues found" early returns named the ticket in the response text but returned bare `void`. Fixed to carry the key on both no-op paths:

  ```ts
  // src/participant/jira/fieldHandler.ts — handleSpellCheck
  if (!rawDescription.trim()) {
    stream.markdown(`**${ticketKey}** has no description to check.`);
    return { metadata: { jiraSession: { kinds: [], lastTicketKey: ticketKey } } };
  }
  ```

### How to check a new branch

Before finishing a change that references a ticket, ask: does this branch's response carry `lastTicketKey`? If the branch starts a new multi-turn session, the session kinds already encode the ticket; if it references a ticket but returns bare `void`, add the empty-kinds sentinel. The test that guards this is in `src/test/fieldHandler.test.ts` — the spell-check no-op paths assert `chatResult?.metadata?.jiraSession?.lastTicketKey`.

## Why This Matters

Visible HTML markers in chat text are a footgun: they leak into the rendered transcript and must be actively stripped from LLM history before the text is reused (`stripHiddenMarkers` in `src/participant/sessionState.ts:330` exists precisely because pre-migration history turns may still carry them). That is dead code that only exists as a migration safety net — no production path emits HTML-comment markers anymore.

Carrying the key on `metadata` instead:

- **Never leaks into the transcript.** There is no marker to strip, so `stripHiddenMarkers` is now purely defensive.
- **Survives structured round-trips.** `metadata` is a typed object, not a string you have to regex out of prose. The reader reads a field, not a pattern.
- **Keeps session detection and last-ticket tracking orthogonal.** The empty-kinds sentinel decouples "is there an active multi-turn session?" from "which ticket was last referenced?" — one question is answered by `kinds`, the other by `lastTicketKey`.

The tradeoff is that the sentinel relies on a convention (empty `kinds` = "no session but key carried") that every new consumer must respect. Adding a consumer that reads `kinds` directly is safe; adding one that inspects `lastTicketKey` must understand the sentinel.

## When to Apply

Apply this pattern whenever a chat participant needs to remember a scalar piece of context (a ticket key, a PR URL, a selected item) across turns **without** surfacing it in the rendered response. It is the right tool when:

- The value is needed only to resolve a follow-up, not to show the user.
- The value must not pollute the LLM history (HTML markers in text do).
- You already have a structured `metadata` return surface (VS Code's `ChatResult.metadata`).

Do **not** reach for it when the value genuinely needs to be visible to the user — that belongs in the streamed markdown, not in metadata.

## Examples

**Correct — carry the key on a no-op path that still names the ticket:**

```ts
// src/participant/jira/fieldHandler.ts (handleSpellCheck)
if (!rawDescription.trim()) {
  stream.markdown(`**${ticketKey}** has no description to check.`);
  return { metadata: { jiraSession: { kinds: [], lastTicketKey: ticketKey } } };
}
```

The response text names the ticket, and the key rides on metadata so a bare follow-up resolves.

**Correct — the empty-kinds sentinel for a referenced-but-not-session branch:**

```ts
// src/participant/jira/contentHandler.ts
return { metadata: { jiraSession: { kinds: [], lastTicketKey: created.key } } };
```

**Correct — the reader:**

```ts
// src/participant/jira/ticketContext.ts (parseLastTicketFromContext)
for (let i = context.history.length - 1; i >= 0; i--) {
  const turn = context.history[i];
  if (turn instanceof vscode.ChatResponseTurn) {
    const key = (turn.result.metadata as { jiraSession?: JiraSessionContinuity } | undefined)?.jiraSession?.lastTicketKey;
    if (key) return key;
  }
}
```

**Anti-pattern — returning bare `void` when the branch references a ticket:**

```ts
// BUG (pre-fix): bulk update path returned void, dropping last-ticket context
await ticketService.bulkUpdateField(...);
stream.markdown(`\n_Done — ${passed} updated..._`);
return; // lastTicketKey lost — a bare follow-up can no longer resolve
```

This was the parity regression fixed in PR #53; the fix carries `lastUpdatedKey` on the same metadata shape.

## Verification gaps (leave these to the next contributor)

- The empty-kinds sentinel is only exercised for a single consumer in tests; the convention is not validated across all ~39 consumers.
- `lastTicketKey` is not validated against the ticket-key shape `[A-Z][A-Z0-9]+-\d+`, so a malformed key would round-trip silently.
- Metadata persistence across a chat reload (fresh VS Code session) is unverified — `metadata` rides on `ChatResult` and is only re-read from `ChatContext.history`, which depends on VS Code persisting history across reloads.
