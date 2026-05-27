# Jira Comment Generation Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `@jira write comment` / `@jira update description` quality by honoring the `contentSource` classification throughout the call chain, filtering noise from conversation history, and adding grounding instructions so the LLM summarizes only what's in the provided context.

**Architecture:** All changes flow through one call chain: `JiraParticipant` (intent + routing) → `buildContentContext` (history selection) → `generateContent` (LLM prompt + role). Each function gets one focused change; no new abstractions are introduced. Pure helper tests cover the logic; vscode-dependent glue is verified by TypeScript compilation.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest. Node.js managed by Volta — use `~/.volta/bin/npm` if `npm` is not on PATH.

---

## Background

There are 7 problems in scope, grouped into 4 files:

| # | Problem | File |
|---|---|---|
| 1 | `buildContentContext` always uses full history regardless of `contentSource` | `contentHandler.ts` |
| 2 | `extractHistoryTurns` includes intermediate preview drafts as if they were findings | `llmHelpers.ts` |
| 3 | "Post it" / "use that" routes through `generateContent` instead of lifting the text verbatim | `JiraParticipant.ts` |
| 4 | `generateContent` uses a generic role + no grounding when the source is history | `llmHelpers.ts` |
| 5 | `history-recent` window is hardcoded to 3 turns — too few for a day's analysis | `sessionState.ts` |
| 6 | No prompt specialization for `history-full` vs standalone `generate` | `llmHelpers.ts` |
| 7 | No token guard on history — long sessions can overflow the model context silently | `sessionState.ts` |

---

## File Map

| File | Changes |
|---|---|
| `src/participant/sessionState.ts` | Bump `history-recent` window 3→10; add 30k char token guard (#5, #7) |
| `src/participant/jira/llmHelpers.ts` | Filter preview turns from `extractHistoryTurns`; add `contentSource` param to `generateContent` with specialized role + grounding; add `isPointerPrompt`, `extractLastAssistantText` helpers (#2, #4, #6) |
| `src/participant/jira/contentHandler.ts` | Add `contentSource` param to `buildContentContext`; use `buildHistoryContext` to route history (#1) |
| `src/participant/JiraParticipant.ts` | Pass `intent.contentSource` to `buildContentContext` + `generateContent`; add verbatim pointer shortcut (#3) |
| `src/test/JiraParticipant.test.ts` | Tests for `serializeTurns` changes + new `isPointerPrompt` helper |
| `src/test/contentHandler.test.ts` | Test that `buildContentContext` routes history based on `contentSource` |

---

### Task 1: sessionState.ts — bump recent window + add token guard

**Files:**
- Modify: `src/participant/sessionState.ts`
- Test: `src/test/JiraParticipant.test.ts`

Currently `serializeTurns` cuts to 3 turns in `recent` mode and has no length limit in `full` mode. Three turns is too few to capture a day's investigation. An unbounded full history overflows the model context on long sessions.

- [ ] **Step 1: Write the failing tests**

Open `src/test/JiraParticipant.test.ts`. Find the existing `describe('serializeTurns', ...)` block (currently near line 21). Add three new tests inside it — after the existing four:

```typescript
it('includes turns 5–14 (last 10) when 15 turns are provided in recent mode', () => {
  const manyTurns = Array.from({ length: 15 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `message-${i}`,
  }));
  const result = serializeTurns(manyTurns, 'recent');
  expect(result).not.toContain('message-0'); // turns 0–4 dropped (15 − 10 = 5 oldest excluded)
  expect(result).not.toContain('message-4');
  expect(result).toContain('message-5');     // turn 5 is the 10th-from-last
  expect(result).toContain('message-14');    // last turn always included
});

it('truncates serialized history exceeding 30 000 chars and adds note', () => {
  const longText = 'a'.repeat(4000);
  const manyTurns = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: longText,
  }));
  const result = serializeTurns(manyTurns, 'full');
  expect(result).toContain('_(oldest turns omitted to fit context)_');
  expect(result).not.toContain(manyTurns[0].text.slice(0, 50)); // first turn dropped
  expect(result).toContain(manyTurns[9].text.slice(0, 50));     // last turn kept
});

it('does not add truncation note when history is short', () => {
  const result = serializeTurns([{ role: 'user' as const, text: 'hello' }], 'full');
  expect(result).not.toContain('oldest turns omitted');
});
```

- [ ] **Step 2: Run to verify the three new tests fail**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "serializeTurns"
```

Expected: the three new tests FAIL (wrong window size, no truncation logic yet).

- [ ] **Step 3: Update the existing "last 3 turns" test**

The fixture in the `describe` block has only 5 turns. With a window of 10, all 5 appear in recent mode. Find the test named `'returns only the last 3 turns in recent mode'` and replace it:

```typescript
it('includes all turns when total is within the 10-turn recent window', () => {
  const result = serializeTurns(turns, 'recent');
  expect(result).toContain('Show me PROJ-1');         // was excluded at window=3, now included
  expect(result).toContain('Roses are red');
  expect(result).toContain('Add that poem as a comment');
});
```

- [ ] **Step 4: Implement the changes in `serializeTurns`**

Open `src/participant/sessionState.ts`. Place the constant and the updated function where `serializeTurns` currently lives (around line 187). The constant must be at module level, not inside the function:

```typescript
const MAX_HISTORY_CHARS = 30_000;

export function serializeTurns(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  mode: 'recent' | 'full',
): string {
  const selected = mode === 'recent' ? turns.slice(-10) : turns;
  const serialized = selected
    .filter((t) => t.text.length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
  if (serialized.length <= MAX_HISTORY_CHARS) return serialized;
  const tail = serialized.slice(-MAX_HISTORY_CHARS);
  const firstBreak = tail.indexOf('\n\n');
  const clean = firstBreak >= 0 ? tail.slice(firstBreak + 2) : tail;
  return `_(oldest turns omitted to fit context)_\n\n${clean}`;
}
```

- [ ] **Step 5: Run tests to verify all `serializeTurns` tests pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "serializeTurns"
```

Expected: all `serializeTurns` tests PASS (including the updated and the three new ones).

- [ ] **Step 6: Type-check**

```bash
~/.volta/bin/npm run compile
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/participant/sessionState.ts src/test/JiraParticipant.test.ts
git commit -m "feat: bump history-recent window to 10 turns and add 30k char token guard"
```

---

### Task 2: llmHelpers.ts — preview filter, prompt specialization, grounding, verbatim helpers

**Files:**
- Modify: `src/participant/jira/llmHelpers.ts`
- Test: `src/test/JiraParticipant.test.ts`

Four changes in one file:
1. `extractHistoryTurns` — skip assistant turns containing `<!-- jira:previewing -->` (they are intermediate drafts, not findings)
2. `generateContent` — add optional `contentSource` param; use specialized role and grounding instruction when the source is history
3. New `isPointerPrompt` — detects "post it / use this / add that as a comment" patterns
4. New `extractLastAssistantText` — finds the last non-preview assistant turn for verbatim copy

- [ ] **Step 1: Write failing tests for `isPointerPrompt`**

`isPointerPrompt` is a pure function with no vscode dependency. Add tests at the end of `src/test/JiraParticipant.test.ts`. The import line will produce a compile error until the function exists — that is the intended failing state:

Add to the top-level imports at the top of the file:

```typescript
import { isPointerPrompt } from '../participant/jira/llmHelpers';
```

Add at the end of the file:

```typescript
describe('isPointerPrompt', () => {
  it('matches "post it"', () => {
    expect(isPointerPrompt('post it')).toBe(true);
  });

  it('matches "use this as a comment on PROJ-123"', () => {
    expect(isPointerPrompt('use this as a comment on PROJ-123')).toBe(true);
  });

  it('matches "add that as a comment"', () => {
    expect(isPointerPrompt('add that as a comment')).toBe(true);
  });

  it('does not match a standalone generation instruction', () => {
    expect(isPointerPrompt('write a summary of the investigation findings')).toBe(false);
  });

  it('does not match a literal comment instruction', () => {
    expect(isPointerPrompt('add comment: everything looks good')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify the tests fail**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "isPointerPrompt"
```

Expected: FAIL with import or type error (`isPointerPrompt` does not exist yet).

- [ ] **Step 3: Add `isPointerPrompt` and `extractLastAssistantText` to `llmHelpers.ts`**

At the bottom of `src/participant/jira/llmHelpers.ts`, after all existing functions, add:

```typescript
export function isPointerPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(post|use|add|take|copy)\s+(it|this|that)\b/.test(lower) ||
    /\b(add|post)\s+(it|this|that)\s+as\s+(a\s+)?comment\b/.test(lower);
}

export function extractLastAssistantText(context: vscode.ChatContext): string {
  const turns = extractHistoryTurns(context);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant') return turns[i].text;
  }
  return '';
}
```

`extractLastAssistantText` calls `extractHistoryTurns`, which will automatically exclude preview drafts after the next step.

- [ ] **Step 4: Run to verify `isPointerPrompt` tests pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "isPointerPrompt"
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Filter preview-loop turns in `extractHistoryTurns`**

In `src/participant/jira/llmHelpers.ts`, find `extractHistoryTurns` (around line 144). Replace it:

```typescript
export function extractHistoryTurns(context: vscode.ChatContext): Array<{ role: 'user' | 'assistant'; text: string }> {
  type Turn = { role: 'user' | 'assistant'; text: string };
  return context.history.flatMap<Turn>((turn) => {
    if (turn instanceof vscode.ChatRequestTurn) {
      return [{ role: 'user', text: turn.prompt }];
    }
    if (turn instanceof vscode.ChatResponseTurn) {
      const raw = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      // Skip intermediate content preview drafts — they are not accepted findings
      if (raw.includes('<!-- jira:previewing -->')) return [];
      const text = stripHiddenMarkers(raw);
      return text ? [{ role: 'assistant', text }] : [];
    }
    return [];
  });
}
```

The only change from the original is checking `raw.includes('<!-- jira:previewing -->')` before processing the turn. Preview assistant turns are excluded entirely from all history — so they will not appear in any context passed to the LLM.

- [ ] **Step 6: Add `contentSource` param and prompt specialization to `generateContent`**

In `src/participant/jira/llmHelpers.ts`, replace the full `generateContent` function (around lines 102–128):

```typescript
export async function generateContent(
  instruction: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  context?: string,
  contentSource?: 'generate' | 'history-recent' | 'history-full',
): Promise<string> {
  const isHistoryBased = contentSource === 'history-recent' || contentSource === 'history-full';
  const roleText = isHistoryBased
    ? 'You are a technical scribe for a software development team. Your task is to synthesize findings from a conversation into a concise Jira comment.'
    : 'You are a Jira assistant. Your task is to write Jira comment and description text. Content may include prose summaries, code snippets, patches, or any technical material appropriate for a Jira comment.';
  const roleAckText = isHistoryBased
    ? 'Understood. I synthesize conversation findings into concise Jira comments.'
    : 'Understood. I write Jira comment and description text, including any technical content such as code or patches.';
  const roleSetup = vscode.LanguageModelChatMessage.User(roleText);
  const roleAck = vscode.LanguageModelChatMessage.Assistant(roleAckText);
  let task: string;
  if (context) {
    const groundingNote = isHistoryBased
      ? '\n\nBase your summary ONLY on the conversation excerpt provided above. Do not add information not present in the source.'
      : '';
    task = `Available context:\n\n${context}${groundingNote}\n\nUsing the context above, write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`;
  } else {
    task = `Write the following:\n${instruction}\n\nProduce only the final text. No preamble, no explanation.`;
  }
  const response = await model.sendRequest(
    [roleSetup, roleAck, vscode.LanguageModelChatMessage.User(task)],
    {},
    token,
  );
  let content = '';
  for await (const chunk of response.text) {
    content += chunk;
  }
  return content.trim();
}
```

The new 5th parameter is optional. All existing callers that omit it continue to work without change.

- [ ] **Step 7: Run full test suite and type-check**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests PASS, no type errors. The `generateContent` signature change is backwards-compatible.

- [ ] **Step 8: Commit**

```bash
git add src/participant/jira/llmHelpers.ts src/test/JiraParticipant.test.ts
git commit -m "feat: filter preview drafts from history, add grounding + specialized role to generateContent, add pointer helpers"
```

---

### Task 3: contentHandler.ts — honor contentSource in buildContentContext

**Files:**
- Modify: `src/participant/jira/contentHandler.ts`
- Test: `src/test/contentHandler.test.ts`

`buildContentContext` currently always calls `serializeTurns(extractHistoryTurns(chatContext), 'full')` regardless of `contentSource`. After this task, it will use `buildHistoryContext` (already exported from `llmHelpers.ts`) to route: no history for `generate`, recent-10 for `history-recent`, full for `history-full`.

- [ ] **Step 1: Write failing tests**

Open `src/test/contentHandler.test.ts`. Update the `vi.mock` for `llmHelpers` to include `buildHistoryContext`:

```typescript
vi.mock('../participant/jira/llmHelpers', () => ({
  generateContent: vi.fn(),
  isLmRefusal: vi.fn(),
  extractHistoryTurns: vi.fn(),
  buildHistoryContext: vi.fn(),
}));
```

Add `buildHistoryContext` and `buildContentContext` to the imports:

```typescript
import { streamContentPreview, handleContentSession, buildContentContext } from '../participant/jira/contentHandler';
import { generateContent, isLmRefusal, buildHistoryContext } from '../participant/jira/llmHelpers';
```

Add a new describe block at the end of the file:

```typescript
describe('buildContentContext — contentSource routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildHistoryContext).mockReturnValue(undefined);
  });

  it('calls buildHistoryContext with "generate" when contentSource is generate', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '', 'generate');
    expect(buildHistoryContext).toHaveBeenCalledWith('generate', chatContext);
  });

  it('calls buildHistoryContext with "history-recent" when contentSource is history-recent', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '', 'history-recent');
    expect(buildHistoryContext).toHaveBeenCalledWith('history-recent', chatContext);
  });

  it('defaults to history-full when contentSource is omitted', async () => {
    const request = { references: [] } as never;
    const chatContext = { history: [] } as never;
    await buildContentContext(request, chatContext, 'Ticket text', '');
    expect(buildHistoryContext).toHaveBeenCalledWith('history-full', chatContext);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "contentSource routing"
```

Expected: FAIL (`buildHistoryContext` not called, or import error on `buildContentContext`).

- [ ] **Step 3: Update imports in contentHandler.ts**

Open `src/participant/jira/contentHandler.ts`. Replace the two import lines at the top:

```typescript
// Remove serializeTurns from sessionState import:
import { isCancellation, isConfirmation } from '../sessionState';

// Remove extractHistoryTurns; add buildHistoryContext:
import { generateContent, isLmRefusal, buildHistoryContext } from './llmHelpers';
```

- [ ] **Step 4: Update `buildContentContext` signature and body**

Replace the `buildContentContext` function (lines 50–70):

```typescript
export async function buildContentContext(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  ticketText: string,
  commentBlocks: string,
  contentSource: 'generate' | 'history-recent' | 'history-full' = 'history-full',
): Promise<string> {
  const parts: string[] = [];

  const fileContent = await gatherFileContent(request.references, chatContext.history);
  if (fileContent) parts.push(`**Attached files:**\n\n${fileContent}`);

  const historyText = buildHistoryContext(contentSource, chatContext);
  if (historyText) parts.push(`**Conversation history:**\n\n${historyText}`);

  const ticketSection = commentBlocks
    ? `${ticketText}\n\n**Comments:**\n\n${commentBlocks}`
    : ticketText;
  parts.push(`**Ticket:**\n\n${ticketSection}`);

  return parts.join('\n\n---\n\n');
}
```

`buildHistoryContext` is defined in `llmHelpers.ts` as:
```typescript
// Already exists — no changes needed:
export function buildHistoryContext(contentSource, context): string | undefined {
  if (contentSource === 'history-recent') return serializeTurns(extractHistoryTurns(context), 'recent');
  if (contentSource === 'history-full') return serializeTurns(extractHistoryTurns(context), 'full');
  return undefined; // 'generate' → no history
}
```

For `generate`, it returns `undefined`, so the history block is omitted entirely.

- [ ] **Step 5: Run tests to verify they pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "contentSource routing"
```

Expected: all 3 new tests PASS.

- [ ] **Step 6: Run full suite and type-check**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/participant/jira/contentHandler.ts src/test/contentHandler.test.ts
git commit -m "feat: honor contentSource in buildContentContext — skip history for generate mode"
```

---

### Task 4: JiraParticipant.ts — wire contentSource + verbatim pointer shortcut

**Files:**
- Modify: `src/participant/JiraParticipant.ts`

This task wires `intent.contentSource` through to `buildContentContext` and `generateContent`, and adds the verbatim shortcut for pointer prompts ("post it", "use that") so the LLM isn't re-generating text the user is explicitly pointing at.

The two callsites to update are:
- `addComment` case (around line 648)
- `updateField` description case (around line 679)

- [ ] **Step 1: Update the `llmHelpers` import**

Find the line importing from `./jira/llmHelpers` (around line 14). Add `isPointerPrompt` and `extractLastAssistantText`:

```typescript
import { parseIntent, generateContent, isLmRefusal, synthesizeComments, generateDescriptionAndCommentsSummary, isPointerPrompt, extractLastAssistantText } from './jira/llmHelpers';
```

- [ ] **Step 2: Replace the non-literal branch in the `addComment` case**

Find the `addComment` case (around line 640). The non-literal `else` branch (currently lines 648–660) becomes:

```typescript
} else {
  const ticketText = await ticketService.getTicket(ticketKey!);
  const { comments } = await ticketService.getIssueComments(ticketKey!, 50);
  const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';

  // Verbatim shortcut: when the user points at the previous response ("post it",
  // "use that"), copy the last assistant turn directly instead of re-generating.
  if (intent.contentSource === 'history-recent' && isPointerPrompt(request.prompt)) {
    const lastText = extractLastAssistantText(chatContext);
    if (lastText.length > 200) {
      await streamContentPreview(
        { ticketKey: ticketKey!, operation: 'addComment', currentContent: lastText, historyContext: undefined },
        stream, ws,
      );
      return;
    }
  }

  const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
  const context = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
  const content = await generateContent(request.prompt, request.model, token, context, nonLiteralSource);
  if (isLmRefusal(content)) {
    stream.markdown(`_Could not generate comment content — the AI model declined the request. Try rephrasing your instruction or use \`@jira add comment to ${ticketKey}\` with explicit text._`);
    return;
  }
  await streamContentPreview(
    { ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context },
    stream, ws,
  );
  return;
}
```

The cast `as 'generate' | 'history-recent' | 'history-full'` is safe: `'literal'` is already handled by the `isLiteral` guard earlier in the case.

- [ ] **Step 3: Wire contentSource in the `updateField` description case**

Find the description non-literal branch (around line 679). Replace the two `buildContentContext` / `generateContent` call lines and the `streamContentPreview` line:

```typescript
const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
const contentCtx = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
const content = await generateContent(fieldValueRaw, request.model, token, contentCtx, nonLiteralSource);
if (isLmRefusal(content)) {
  stream.markdown(`_Could not generate description content — the AI model declined the request. Try rephrasing your instruction._`);
  return;
}
await streamContentPreview(
  { ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx },
  stream, ws,
);
return;
```

- [ ] **Step 4: Run full suite and type-check**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass, no type errors. `JiraParticipant.ts` is not unit-tested by Vitest (vscode dependency), so TypeScript compilation is the verification step.

- [ ] **Step 5: Commit**

```bash
git add src/participant/JiraParticipant.ts
git commit -m "feat: wire contentSource through addComment/updateDescription and add verbatim pointer shortcut"
```

---

## Verification

After all four tasks:

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

All tests must be green. Manual smoke tests:

1. `@jira write a comment about Star Trek on PROJ-1` — should produce a standalone poem/text without injecting previous conversation (contentSource `generate`, no history in context)
2. `@jira summarize what we found today on PROJ-1` — should summarize the conversation findings only (contentSource `history-full`, with grounding instruction)
3. After Claude writes a long summary, say `@jira post it as a comment on PROJ-1` — should use the assistant's previous text verbatim, not re-generate
4. Long session (many turns): `@jira write comment summarizing PROJ-1` — history should be truncated with the "oldest turns omitted" note rather than silently failing
