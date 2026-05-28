# LLM Prompt Quality Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a bug where content refinements lose their specialized LLM role, and apply the established 3-message role/ack/task prompt pattern to the five remaining bare single-turn LLM functions, add a Bitbucket Pass 2 re-evaluation note, and fill test coverage gaps for three new helpers.

**Architecture:** All changes are in-place modifications — no new files. The 3-message pattern (`[User roleText, Assistant ackText, User task]`) is already established in `generateContent`; each remaining function gets a tailored role. The bug fix adds `contentSource` to the `ContentSession` type so refinements carry the same context as initial generation. Tests live in the existing test files.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest. Node.js managed by Volta — use `~/.volta/bin/npm` if `npm` is not on PATH.

---

## Background

`generateContent` already uses a specialized 3-message prompt pattern with role, acknowledgment, and grounding. The audit found:

1. `ContentSession` (addComment/updateDescription) lacks a `contentSource` field — refinements silently drop back to the generic role.
2. Five functions still use bare single-turn prompts: `synthesizeComments`, `generateDescriptionAndCommentsSummary`, `parseIntent`, `spellCheckValue`, `checkSectionCoverage`.
3. `PrReviewService.buildPrompt` doesn't instruct the model to re-evaluate when full file contents are available (Pass 2).
4. `buildHistoryContext`, `extractLastAssistantText`, and `generateContent` role selection are not unit tested.

---

## File Map

| File | Changes |
|------|---------|
| `src/participant/sessionState.ts` | Add `contentSource` to `ContentSession` (addComment/updateDescription variant) |
| `src/participant/jira/contentHandler.ts` | Refinement branch passes `session.contentSource` as 5th arg to `generateContent` |
| `src/participant/JiraParticipant.ts` | Three `streamContentPreview` callsites gain `contentSource` |
| `src/participant/jira/llmHelpers.ts` | Upgrade `synthesizeComments`, `generateDescriptionAndCommentsSummary`, `parseIntent`, `spellCheckValue` to 3-message pattern |
| `src/participant/jira/createHandler.ts` | Upgrade `checkSectionCoverage` to 3-message pattern |
| `src/services/PrReviewService.ts` | Append Pass 2 re-evaluation note when `fileContents` non-empty |
| `src/test/contentHandler.test.ts` | New test: refinement preserves `contentSource`; fix existing addComment fixture |
| `src/test/PrReviewService.test.ts` | New test: re-evaluation note present in Pass 2 prompt |
| `src/test/llmHelpers.test.ts` | 3 new describe blocks + extended vscode mock |

---

### Task 1: Fix ContentSession missing contentSource (bug)

**Files:**
- Modify: `src/participant/sessionState.ts`
- Modify: `src/participant/jira/contentHandler.ts`
- Modify: `src/participant/JiraParticipant.ts`
- Test: `src/test/contentHandler.test.ts`

When `handleContentSession` refines content it calls `generateContent(prompt, model, token, refineContext)` — no 5th argument — so refinements always use the generic Jira assistant role, losing the scribe role + grounding that was applied on first generation.

- [ ] **Step 1: Write the failing test**

Open `src/test/contentHandler.test.ts`. Add a new describe block at the end of the file:

```typescript
// ---------------------------------------------------------------------------
// handleContentSession — addComment refinement preserves contentSource
// ---------------------------------------------------------------------------

describe('handleContentSession — addComment refinement preserves contentSource', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MockJiraClient();
    ticketService = new TicketService(client);
  });

  it('passes session.contentSource to generateContent on refinement', async () => {
    vi.mocked(generateContent).mockResolvedValue('Refined comment text.');
    vi.mocked(isLmRefusal).mockReturnValue(false);

    const session: ContentSession = {
      operation: 'addComment',
      ticketKey: 'PROJ-123',
      currentContent: 'Original comment.',
      historyContext: 'Some history context.',
      contentSource: 'history-full',
    };

    const stream = mockStream();
    const ws = mockWs();

    await handleContentSession(session, 'make it shorter', nullModel, nullToken, stream as never, ticketService, ws as never);

    expect(generateContent).toHaveBeenCalledOnce();
    const args = vi.mocked(generateContent).mock.calls[0];
    expect(args[4]).toBe('history-full');
  });
});
```

- [ ] **Step 2: Run compile to verify it fails**

```bash
~/.volta/bin/npm run compile 2>&1 | grep -E "error TS|contentSource"
```

Expected: TypeScript error — `contentSource` does not exist on the `ContentSession` `addComment` variant.

- [ ] **Step 3: Add `contentSource` to `ContentSession` in `sessionState.ts`**

Open `src/participant/sessionState.ts`. Replace the `addComment | updateDescription` variant (lines 17–21):

```typescript
export type ContentSession =
  | {
      operation: 'addComment' | 'updateDescription';
      ticketKey: string;
      currentContent: string;
      historyContext: string | undefined;
      contentSource: 'generate' | 'history-recent' | 'history-full';
    }
  | {
      operation: 'createTicket';
      projectKey: string;
      summary: string;
      issueType: string;
      templateName: string | null;
      extraFields: Record<string, unknown>;
      currentContent: string;
    };
```

- [ ] **Step 4: Fix the existing addComment test fixture**

In `src/test/contentHandler.test.ts`, find the `handleContentSession — addComment regression` describe block (around line 303). The session fixture there is missing `contentSource` now that it's required. Add it:

```typescript
const session: ContentSession = {
  operation: 'addComment',
  ticketKey: 'PROJ-123',
  currentContent: 'This is a test comment.',
  historyContext: undefined,
  contentSource: 'generate',
};
```

- [ ] **Step 5: Update the refinement branch in `contentHandler.ts`**

Open `src/participant/jira/contentHandler.ts`. Replace lines 137–142 (the refinement branch start):

```typescript
  // Refinement instruction
  const historyContext = session.operation !== 'createTicket' ? session.historyContext : undefined;
  const refineContext = [historyContext, `Previously generated:\n${session.currentContent}`]
    .filter(Boolean)
    .join('\n\n');
  const contentSource = session.operation !== 'createTicket' ? session.contentSource : undefined;
  const refined = await generateContent(prompt, model, token, refineContext, contentSource);
```

- [ ] **Step 6: Update the three `streamContentPreview` callsites in `JiraParticipant.ts`**

Open `src/participant/JiraParticipant.ts`.

**Callsite 1** — verbatim pointer shortcut (around line 658). Replace:
```typescript
              await streamContentPreview(
                { ticketKey: ticketKey!, operation: 'addComment', currentContent: lastText, historyContext: undefined },
                stream, ws,
              );
```
With:
```typescript
              await streamContentPreview(
                { ticketKey: ticketKey!, operation: 'addComment', currentContent: lastText, historyContext: undefined, contentSource: 'history-recent' },
                stream, ws,
              );
```

**Callsite 2** — regular addComment (around line 673). Replace:
```typescript
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context },
              stream, ws,
            );
```
With:
```typescript
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context, contentSource: nonLiteralSource },
              stream, ws,
            );
```

**Callsite 3** — updateDescription (around line 704). Replace:
```typescript
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx },
              stream, ws,
            );
```
With:
```typescript
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx, contentSource: nonLiteralSource },
              stream, ws,
            );
```

- [ ] **Step 7: Run tests and compile**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass, including the new one. `args[4]` is now `'history-full'`. No TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/participant/sessionState.ts src/participant/jira/contentHandler.ts src/participant/JiraParticipant.ts src/test/contentHandler.test.ts
git commit -m "fix: persist contentSource in ContentSession so refinements use the correct LLM role"
```

---

### Task 2: Upgrade Jira LLM functions to 3-message pattern (llmHelpers.ts)

**Files:**
- Modify: `src/participant/jira/llmHelpers.ts`

Four functions in this file use bare single-turn prompts. Each gets a `[User roleText, Assistant ackText, User task]` pattern with grounding notes for prose-output functions.

No unit tests are possible for these functions (they call `model.sendRequest` with the VS Code API). TypeScript compilation is the verification.

- [ ] **Step 1: Replace `synthesizeComments`**

In `src/participant/jira/llmHelpers.ts`, replace the full `synthesizeComments` function (lines 185–199):

```typescript
export async function synthesizeComments(
  commentBlocks: string,
  query: string | null,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const roleText = query
    ? 'You are a Jira comment analyst. Your task is to find and quote comments relevant to the user\'s query.'
    : 'You are a Jira comment analyst. Your task is to produce concise numbered summaries of each comment.';
  const roleAck = query
    ? 'Understood. I find and quote comments relevant to the user\'s query.'
    : 'Understood. I produce concise numbered summaries of each comment.';
  const task = query
    ? `Find and quote comments relevant to: "${query}". Note the author and date for each relevant comment.`
    : 'Summarise each comment in one sentence. Number each one. Format: N. **Author** (date): one-sentence summary.';
  const taskPrompt = `Comments:\n\n${commentBlocks}\n\n${task} Produce only the final content, no preamble.\n\nBase your response only on the comments provided above. Do not invent or infer information not present in the source.`;
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text.trim();
}
```

- [ ] **Step 2: Replace `generateDescriptionAndCommentsSummary`**

In `src/participant/jira/llmHelpers.ts`, replace the full `generateDescriptionAndCommentsSummary` function (lines 201–217):

```typescript
export async function generateDescriptionAndCommentsSummary(
  descriptionText: string,
  commentBlocks: string | null,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  const parts = [
    descriptionText ? `Description:\n${descriptionText}` : null,
    commentBlocks ? `Comments:\n\n${commentBlocks}` : null,
  ].filter(Boolean).join('\n\n');
  if (!parts) return '_No description or comments._';
  const roleText = 'You are a technical scribe. Your task is to write a single prose paragraph summarizing a Jira ticket\'s description and comments.';
  const roleAck = 'Understood. I write a single prose paragraph summarizing the ticket\'s description and comments.';
  const taskPrompt = `${parts}\n\nWrite a concise prose paragraph summarising the above. No preamble, no headings, no bullet points.\n\nBase your summary only on the description and comments provided above.`;
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
  let text = '';
  for await (const chunk of response.text) text += chunk;
  return text.trim();
}
```

- [ ] **Step 3: Replace `parseIntent`**

In `src/participant/jira/llmHelpers.ts`, replace lines 86–100 (the `parseIntent` function body):

```typescript
export async function parseIntent(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<ParsedIntent> {
  const roleSetup = vscode.LanguageModelChatMessage.User(
    'You are a Jira intent parser. Your task is to analyze user commands and produce structured intent as a JSON object matching the schema below.',
  );
  const roleAck = vscode.LanguageModelChatMessage.Assistant(
    'Understood. I parse Jira commands into structured JSON.',
  );
  const task = vscode.LanguageModelChatMessage.User(INTENT_PROMPT + JSON.stringify(prompt));
  const response = await model.sendRequest([roleSetup, roleAck, task], {}, token);
  let raw = '';
  for await (const chunk of response.text) {
    raw += chunk;
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Model did not return a JSON object. Response: ${raw.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]) as ParsedIntent;
}
```

- [ ] **Step 4: Replace `spellCheckValue`**

In `src/participant/jira/llmHelpers.ts`, replace the full `spellCheckValue` function (lines 219–231):

```typescript
export async function spellCheckValue(
  text: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string | null> {
  const roleText = 'You are a copy editor. Your task is to find and correct spelling and grammar errors in text.';
  const roleAck = 'Understood. I identify and fix spelling and grammar errors.';
  const taskPrompt = `Check this text for spelling and grammar errors:\n\n${text}\n\nIf there are no errors, reply with exactly: UNCHANGED\nIf there are errors, reply with ONLY the corrected text, no explanation.`;
  const response = await model.sendRequest(
    [
      vscode.LanguageModelChatMessage.User(roleText),
      vscode.LanguageModelChatMessage.Assistant(roleAck),
      vscode.LanguageModelChatMessage.User(taskPrompt),
    ],
    {},
    token,
  );
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const trimmed = raw.trim();
  if (/^unchanged$/i.test(trimmed)) return null;
  return trimmed || null;
}
```

- [ ] **Step 5: Run tests and compile**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all existing tests pass, no TypeScript errors. The function signatures haven't changed so no callers are affected.

- [ ] **Step 6: Commit**

```bash
git add src/participant/jira/llmHelpers.ts
git commit -m "feat: upgrade synthesizeComments, generateDescriptionAndCommentsSummary, parseIntent, spellCheckValue to 3-message role pattern"
```

---

### Task 3: Upgrade checkSectionCoverage (createHandler.ts)

**Files:**
- Modify: `src/participant/jira/createHandler.ts`

`checkSectionCoverage` is a private function inside `createHandler.ts` that determines which template sections are addressed by a user's input.

No unit tests needed (VS Code model dependency). TypeScript compilation is the verification.

- [ ] **Step 1: Replace `checkSectionCoverage`**

Open `src/participant/jira/createHandler.ts`. Replace the full `checkSectionCoverage` function (lines 12–31):

```typescript
async function checkSectionCoverage(
  prompt: string,
  sections: string[],
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string[]> {
  const roleSetup = vscode.LanguageModelChatMessage.User(
    'You are a content coverage analyst. Your task is to determine which template sections are addressed by the given text.',
  );
  const roleAck = vscode.LanguageModelChatMessage.Assistant(
    'Understood. I identify which sections are covered.',
  );
  const task = vscode.LanguageModelChatMessage.User(
    `Does this text address any of these sections? Reply with ONLY a JSON array of section names that are clearly covered.\nSections: ${JSON.stringify(sections)}\nText: ${JSON.stringify(prompt)}`,
  );
  const response = await model.sendRequest([roleSetup, roleAck, task], {}, token);
  let raw = '';
  for await (const chunk of response.text) raw += chunk;
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as string[];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Run tests and compile**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/participant/jira/createHandler.ts
git commit -m "feat: upgrade checkSectionCoverage to 3-message role pattern"
```

---

### Task 4: Bitbucket Pass 2 re-evaluation note

**Files:**
- Modify: `src/services/PrReviewService.ts`
- Test: `src/test/PrReviewService.test.ts`

`buildPrompt` is called with `fileContents` on Pass 2 but adds no instruction to re-evaluate uncertain findings with the new evidence.

- [ ] **Step 1: Write the failing test**

Open `src/test/PrReviewService.test.ts`. Add a new `it` block inside the existing `describe('PrReviewService.buildPrompt', ...)` block, after the last existing test (around line 239):

```typescript
  it('includes a re-evaluation note when fileContents is provided (Pass 2)', () => {
    const client = new MockBitbucketClient();
    const service = new PrReviewService(client);
    const contents = new Map([['src/foo.ts', 'const x = 1;\n']]);

    const prompt = service.buildPrompt(pr, fileDiffs, contents);

    expect(prompt).toContain('second-pass review');
  });
```

- [ ] **Step 2: Run to verify the test fails**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 "second-pass"
```

Expected: FAIL — the prompt does not yet contain "second-pass review".

- [ ] **Step 3: Update `buildPrompt` in `PrReviewService.ts`**

Open `src/services/PrReviewService.ts`. Replace the `return` statement at the end of `buildPrompt` (around line 82):

```typescript
    const pass2Note =
      fileContents && fileContents.size > 0
        ? '\nNote: This is a second-pass review. Full file contents have been provided for files you flagged as needing additional context. Use them to confirm or retract uncertain findings — if a finding was speculative due to missing context and the full file shows no issue, omit it from your response.\n\n'
        : '';
    return REVIEW_PROMPT_PREFIX + pass2Note + extra + header + '---\n\n' + fileSections;
```

- [ ] **Step 4: Run tests and compile**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass including the new one. No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/PrReviewService.ts src/test/PrReviewService.test.ts
git commit -m "feat: add Pass 2 re-evaluation note to PrReviewService.buildPrompt when file contents provided"
```

---

### Task 5: Fill test coverage gaps (llmHelpers.test.ts)

**Files:**
- Modify: `src/test/llmHelpers.test.ts`

Three new describe blocks: `buildHistoryContext` (pure function, no model needed), `extractLastAssistantText` (uses existing vscode mock), and `generateContent — role selection` (requires extending the vscode mock to include `LanguageModelChatMessage`).

- [ ] **Step 1: Extend the vscode mock to include LanguageModelChatMessage**

Open `src/test/llmHelpers.test.ts`. Inside the `vi.mock('vscode', () => { ... })` factory (currently ends before the return), add `LanguageModelChatMessage` to the returned object:

```typescript
vi.mock('vscode', () => {
  class MockMarkdownPart {
    constructor(public value: { value: string }) {}
  }
  class MockResponseTurn {
    response: MockMarkdownPart[];
    constructor(parts: Array<{ value: string }>) {
      this.response = parts.map((p) => new MockMarkdownPart(p));
    }
  }
  class MockRequestTurn {
    constructor(public prompt: string, public references: never[] = []) {}
  }
  return {
    ChatRequestTurn: MockRequestTurn,
    ChatResponseTurn: MockResponseTurn,
    ChatResponseMarkdownPart: MockMarkdownPart,
    LanguageModelChatMessage: {
      User: (text: string) => ({ role: 'user' as const, content: text }),
      Assistant: (text: string) => ({ role: 'assistant' as const, content: text }),
    },
  };
});
```

- [ ] **Step 2: Update the import line**

The current import is:
```typescript
import { extractHistoryTurns } from '../participant/jira/llmHelpers';
```

Replace it with:
```typescript
import { extractHistoryTurns, buildHistoryContext, extractLastAssistantText, generateContent } from '../participant/jira/llmHelpers';
```

- [ ] **Step 3: Add the three new describe blocks**

At the end of `src/test/llmHelpers.test.ts`, after the existing `extractHistoryTurns` describe block, add:

```typescript
describe('buildHistoryContext', () => {
  it('returns undefined for "generate" source', () => {
    const context = { history: [] } as never;
    expect(buildHistoryContext('generate', context)).toBeUndefined();
  });

  it('returns serialized recent turns for "history-recent" source', () => {
    const history = [
      new vscode.ChatRequestTurn('hello'),
      new vscode.ChatResponseTurn([{ value: 'world' }]),
    ];
    const result = buildHistoryContext('history-recent', { history } as never);
    expect(result).toContain('User: hello');
    expect(result).toContain('Assistant: world');
  });

  it('returns serialized full turns for "history-full" source', () => {
    const history = [
      new vscode.ChatRequestTurn('hello'),
      new vscode.ChatResponseTurn([{ value: 'world' }]),
    ];
    const result = buildHistoryContext('history-full', { history } as never);
    expect(result).toContain('User: hello');
    expect(result).toContain('Assistant: world');
  });
});

describe('extractLastAssistantText', () => {
  it('returns the last assistant turn text', () => {
    const history = [
      new vscode.ChatRequestTurn('first question'),
      new vscode.ChatResponseTurn([{ value: 'first answer' }]),
      new vscode.ChatRequestTurn('follow-up'),
      new vscode.ChatResponseTurn([{ value: 'second answer' }]),
    ];
    expect(extractLastAssistantText({ history } as never)).toBe('second answer');
  });

  it('skips assistant turns containing the jira:previewing marker', () => {
    const history = [
      new vscode.ChatResponseTurn([{ value: 'real answer' }]),
      new vscode.ChatResponseTurn([{ value: 'Draft.\n\n<!-- jira:previewing -->' }]),
    ];
    expect(extractLastAssistantText({ history } as never)).toBe('real answer');
  });

  it('returns empty string when no non-preview assistant turns exist', () => {
    const history = [new vscode.ChatRequestTurn('hello')];
    expect(extractLastAssistantText({ history } as never)).toBe('');
  });
});

describe('generateContent — role selection', () => {
  const makeModel = () => ({
    sendRequest: vi.fn().mockImplementation(() =>
      Promise.resolve({
        text: (async function* () {
          yield '';
        })(),
      }),
    ),
  });

  it('uses scribe role for history-full contentSource', async () => {
    const model = makeModel();
    await generateContent('write a summary', model as never, {} as never, undefined, 'history-full');
    const [messages] = model.sendRequest.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('technical scribe');
  });

  it('uses Jira assistant role for generate contentSource', async () => {
    const model = makeModel();
    await generateContent('write something', model as never, {} as never, undefined, 'generate');
    const [messages] = model.sendRequest.mock.calls[0] as [Array<{ content: string }>];
    expect(messages[0].content).toContain('Jira assistant');
  });
});
```

- [ ] **Step 4: Run to verify the new tests pass**

```bash
~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 3 -E "buildHistoryContext|extractLastAssistantText|generateContent"
```

Expected: all new tests PASS.

- [ ] **Step 5: Run full suite and compile**

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/test/llmHelpers.test.ts
git commit -m "test: add unit tests for buildHistoryContext, extractLastAssistantText, generateContent role selection"
```

---

## Verification

After all five tasks:

```bash
~/.volta/bin/npm test && ~/.volta/bin/npm run compile
```

All tests must be green. Compilation must be error-free.

Manual smoke tests:
1. Generate a history-based comment, then refine it twice — the LLM should stay in scribe role throughout (no regression to generic assistant role).
2. `@jira summarize PROJ-1` — `generateDescriptionAndCommentsSummary` output should be a clean prose paragraph with no preamble.
3. `@jira show comments on PROJ-1` — `synthesizeComments` output should be clean numbered summaries.
4. Run a Bitbucket PR review on a PR with complex files — Pass 2 should more aggressively retract speculative findings using the re-evaluation note.
