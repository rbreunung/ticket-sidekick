# AI Usage in Ticket Sidekick

This document describes every place the extension invokes an AI language model — what data goes in, how the prompt is constructed and grounded, and what comes back.

---

## Part 1 — User-facing overview

### What model is used

Ticket Sidekick uses whichever model the user has selected in the VS Code GitHub Copilot Chat panel. There is no hardcoded model, no Anthropic or OpenAI API key, and no data sent directly to a third-party AI provider. All requests flow through the VS Code Language Model API and the GitHub Copilot backend.

### `@jira` — when AI fires

| Trigger | What the AI does | Data sent to the model |
| --- | --- | --- |
| Every `@jira` message | Parses your command into a structured intent (operation, ticket key, field values, etc.) | Your prompt text |
| `@jira show <ticket>` | Summarizes up to 20 comments into numbered one-liners | Comment bodies, authors, dates |
| `@jira summarize <ticket>` | Writes a prose paragraph overview of the ticket | Description text, comment bodies |
| `@jira get comments` / `what do comments say?` | Synthesizes comments; filters by topic if one is named | Comment bodies, authors, dates |
| `@jira write a comment…` / `update the description…` | Drafts content; shows a preview for your approval | Your instruction; optionally conversation history and ticket context |
| After a content preview — refinement reply | Rewrites the draft based on your feedback | Previous draft, your feedback, original context |
| `@jira create` + template with `descriptionSections` | Detects which template sections your description already covers | Your description text, section names |
| `@jira spell check` | Corrects spelling and grammar in the ticket description | Description text |

AI does **not** write to Jira without your explicit confirmation. Content generation always shows a preview first.

### `@bitbucket` — when AI fires

| Trigger | What the AI does | Data sent to the model |
| --- | --- | --- |
| `@bitbucket <PR URL>` — per diff batch | Reviews changed files, returns structured findings | PR metadata (title, author, branch), unified diff for the batch |
| Same, second pass (if needed) | Re-reviews with full file content added | Diff + full source files requested in first pass |
| Follow-up without a finding number | Matches your question to the most relevant finding | Your question, all finding titles and severities |
| Follow-up referencing a specific finding | Answers your question about that finding | Finding detail (file, line, severity, description, recommendation), your question |

### Privacy and data handling

Every LLM call sends only the data described in the tables above — ticket fields, comment bodies, diff content, conversation history. No credentials, no base URLs, and no personal information beyond what is already in the Jira ticket or Bitbucket PR. Sensitive values (base URLs, tokens) are redacted from error messages displayed in chat via `redactUrls()`.

---

## Part 2 — Use case reference

### Quick reference

| # | Use case | Function | File |
| --- | --- | --- | --- |---|
| 1 | Intent parsing | `parseIntent` | `src/participant/jira/llmHelpers.ts` |
| 2 | Comment synthesis — summarize | `synthesizeComments` | `src/participant/jira/llmHelpers.ts` |
| 3 | Comment synthesis — topic filter | `synthesizeComments` | `src/participant/jira/llmHelpers.ts` |
| 4 | Content generation | `generateContent` | `src/participant/jira/llmHelpers.ts` |
| 5 | Content refinement | `generateContent` (re-invocation) | `src/participant/jira/contentHandler.ts` |
| 6 | Ticket summarization | `generateDescriptionAndCommentsSummary` | `src/participant/jira/llmHelpers.ts` |
| 7 | Template section coverage | `checkSectionCoverage` | `src/participant/jira/createHandler.ts` |
| 8 | Spell check | `spellCheckValue` | `src/participant/jira/llmHelpers.ts` |
| 9 | PR code review (two-pass) | `PrReviewService.buildPrompt` + `callLLMWithProgress` | `src/services/PrReviewService.ts`, `src/participant/BitbucketParticipant.ts` |
| 10 | Finding matching | `callLLMWithProgress` (inline prompt) | `src/participant/BitbucketParticipant.ts` |
| 11 | Finding explanation | `callLLMWithProgress` (`FOLLOW_UP_PROMPT_PREFIX`) | `src/participant/BitbucketParticipant.ts` |

---

### 1. Intent parsing

**Trigger:** Every `@jira` message that reaches the intent router (after session-state handlers have been checked).

**Inputs assembled:**
- The user's raw prompt string, JSON-serialized.

**Framing and grounding:**

Uses a three-message few-shot setup (User → Assistant → User) to establish a persona before the task:

```
User:      "You are a Jira intent parser. Your task is to analyze user commands
            and produce structured intent as a JSON object matching the schema below."
Assistant: "Understood. I parse Jira commands into structured JSON."
User:      <INTENT_PROMPT schema + user command>
```

`INTENT_PROMPT` embeds a complete JSON schema (19 operations, 20+ fields) and exhaustive per-operation descriptions. Each operation definition rules in and out similar commands to minimize routing errors. Notable grounding rules embedded in the schema:

- `runCleanup` is explicitly distinguished from `transition` (bulk vs. single)
- `bulkTransition` / `bulkUpdateField` are only valid "when a prior search result is available"
- `contentSource` is classified in the same call (see [The `contentSource` two-level classification](#the-contentsource-two-level-classification))
- `fixVersion` must be captured verbatim, including spaces inside quotes

**Output and parsing:**
The model is instructed to return **only** a JSON object with no markdown or explanation. The raw response is searched with `/\{[\s\S]*\}/` to extract the first JSON object, which is then `JSON.parse`d into a `ParsedIntent`. If no JSON object is found, the error message includes the first 200 characters of the raw response.

**Known limitations:**
Ambiguous commands can be misrouted — for example, "close PROJ-123" may parse as `runCleanup` (bulk) instead of `transition` (single) if the ticket key is not clearly present. The schema descriptions attempt to minimize this but cannot eliminate it. The fallback is a follow-up question to the user.

---

### 2. Comment synthesis — summarize mode

**Trigger:** `getTicket` (comments section), `getComments` (no query), `showTicket`, and "load all" confirmation in the more-comments session.

**Inputs assembled:**
- All comment bodies serialized by `serializeCommentsForLLM`: each comment formatted as `**Author** (YYYY-MM-DD):\n<formatted body>`, joined by `\n\n---\n\n`.
- `query` is `null` in this mode.

**Framing and grounding:**

Three-message few-shot:

```
User:      "You are a Jira comment analyst. Your task is to produce concise
            numbered summaries of each comment."
Assistant: "Understood. I produce concise numbered summaries of each comment."
User:      "Comments:\n\n<serialized comments>\n\n
            Summarise each comment in one sentence. Number each one.
            Format: N. **Author** (date): one-sentence summary.
            Produce only the final content, no preamble.
            Base your response ONLY on the comments provided above.
            Do not add information not present in the source."
```

The grounding rule at the end ("Base your response ONLY on…") is explicit hallucination prevention.

**Output and parsing:**
Plain text. Streamed directly into chat with no parsing — the numbered list format is enforced by the prompt.

**Known limitations:**
Comment quality degrades with very long individual comments because the model summarizes them into one sentence regardless of length. The format instruction (N. **Author** (date): …) may be violated by some models.

---

### 3. Comment synthesis — topic filter mode

**Trigger:** `getComments` when `commentQuery` is non-null (user asked "what do comments say about X?").

**Inputs assembled:**
- Same serialized comment blocks as summarize mode.
- `query`: the topic string extracted by the intent parser.

**Framing and grounding:**

Role switches to a different persona:

```
User:      "You are a Jira comment analyst. Your task is to find and quote
            comments relevant to the user's query."
Assistant: "Understood. I find and quote comments relevant to the user's query."
User:      "Comments:\n\n<serialized comments>\n\n
            Find and quote comments relevant to: \"<query>\".
            Note the author and date for each relevant comment.
            Produce only the final content, no preamble.
            Base your response ONLY on the comments provided above.
            Do not add information not present in the source."
```

**Output and parsing:**
Plain text. No structured parsing — the model is free to quote and summarize as it sees fit.

**Known limitations:**
If the query is vague, the model may return loosely related comments. No threshold is applied — if no comments match, the model may still return something tangentially related.

---

### 4. Content generation

**Trigger:** `addComment` or `updateField` (description) when `contentSource` is `generate`, `history-recent`, or `history-full`.

**Inputs assembled:**
- `instruction`: the user's request string.
- `context` (optional): built by `buildHistoryContext`:
  - `history-recent` → last 3 conversation turns serialized as `User: … / Assistant: …`
  - `history-full` → all turns in chat history
  - Plus the current ticket's text and comments (passed from the caller)
- `contentSource`: controls role text and grounding note.

**Framing and grounding:**

The persona differs based on `contentSource`:

```
# history-based:
User:      "You are a technical scribe for a software development team.
            Your task is to synthesize findings from a conversation
            into a concise Jira comment."
Assistant: "Understood. I synthesize conversation findings into concise Jira comments."

# generate (standalone):
User:      "You are a Jira assistant. Your task is to write Jira comment and
            description text. Content may include prose summaries, code snippets,
            patches, or any technical material appropriate for a Jira comment."
Assistant: "Understood. I write Jira comment and description text, including any
            technical content such as code or patches."
```

For history-based calls, an additional grounding note is appended to the task:

> "Use the CONVERSATION HISTORY as your primary source. The ticket text is reference context only — do not simply rephrase findings already stated in the ticket or its existing comments. Do not add information not present in the provided sources."

**Output and parsing:**
Plain text. Trimmed and stored as `ContentSession.currentContent` for the preview loop. Checked for refusals via `isLmRefusal()` (see [Refusal detection](#refusal-detection)).

**Known limitations:**
`history-full` includes all visible turns but excludes session-management responses (previewing, load-skipped) that are filtered out in `extractHistoryTurns`. Very long conversations may exceed the model's context window — the call is made unconditionally with no truncation.

---

### 5. Content refinement

**Trigger:** User replies to a content preview with a refinement instruction (anything that is not a confirmation or cancellation).

**Inputs assembled:**
- `prompt`: the user's refinement instruction.
- `refineContext`: the previous `historyContext` (if any) concatenated with `"Previously generated:\n<currentContent>"`.

**Framing and grounding:**
Same as content generation — `generateContent` is re-invoked with `refineContext` as the `context` argument. The previous draft is explicitly included so the model can apply the feedback incrementally rather than starting from scratch.

**Output and parsing:**
Same as content generation. The result replaces `ContentSession.currentContent` and a new preview is streamed.

---

### 6. Ticket summarization

**Trigger:** `summarizeTicket` operation (`@jira summarize <ticket>`).

**Inputs assembled:**
- `descriptionText`: the formatted description extracted from `getTicket()` output (everything after `**Description:**`).
- `commentBlocks`: serialized comment bodies (same format as comment synthesis), or `null` if no comments.

**Framing and grounding:**

```
User:      "You are a technical scribe. Your task is to write a single prose
            paragraph summarizing a Jira ticket's description and comments."
Assistant: "Understood. I write a single prose paragraph summarizing the
            ticket's description and comments."
User:      "<description block>\n\n<comment block>\n\n
            Write a concise prose paragraph summarising the above.
            No preamble, no headings, no bullet points.
            Base your summary ONLY on the description and comments provided above.
            Do not add information not present in the source."
```

The structured ticket fields (status, assignee, priority, etc.) are output directly from `getTicket()` without AI involvement. Only the description + comments go through the model.

**Output and parsing:**
Plain text. Appended to the fields header as an `**Overview:**` section.

---

### 7. Template section coverage

**Trigger:** `createTicket` when a template with `descriptionSections` is selected and the user has provided a description in their prompt.

**Inputs assembled:**
- `prompt`: the user's description text.
- `sections`: the array of section names from the template (e.g. `["Steps to reproduce", "Expected behavior", "Actual behavior"]`).

**Framing and grounding:**

```
User:      "You are a content coverage analyst. Your task is to determine which
            template sections are addressed by the given text."
Assistant: "Understood. I identify which sections are covered."
User:      "Does this text address any of these sections?
            Reply with ONLY a JSON array of section names that are clearly covered.
            Sections: <JSON array>
            Text: <JSON string>"
```

The instruction "clearly covered" is intentional — partial or tangential coverage should not be claimed. Both inputs are JSON-encoded to avoid injection from user text containing special characters.

**Output and parsing:**
The response is searched with `/\[[\s\S]*\]/` to extract the first JSON array. On parse failure an empty array is returned, causing all sections to be asked interactively. This is the safe fallback.

---

### 8. Spell check

**Trigger:** `spellCheck` operation (`@jira spell check`).

**Inputs assembled:**
- `text`: the current ticket description formatted as Markdown.

**Framing and grounding:**

```
User:      "You are a copy editor. Your task is to find and correct
            spelling and grammar errors in text."
Assistant: "Understood. I identify and fix spelling and grammar errors."
User:      "Check this text for spelling and grammar errors:\n\n<text>\n\n
            If there are no errors, reply with exactly: UNCHANGED
            If there are errors, reply with ONLY the corrected text, no explanation."
```

The binary output instruction ("UNCHANGED" vs. corrected text) eliminates the need to diff model output against input — the model declares whether it changed anything.

**Output and parsing:**
If the trimmed response matches `/^unchanged$/i`, the function returns `null` (no update). Otherwise the trimmed text is returned as the corrected description. A preview loop is started so the user can confirm or discard the correction.

**Known limitations:**
The model may silently rewrite content beyond spelling corrections. The preview step before posting mitigates this.

---

### 9. PR code review (two-pass)

**Trigger:** `@bitbucket <PR URL>`.

**Inputs assembled — Pass 1:**
- `REVIEW_PROMPT_PREFIX`: a fixed system preamble (see below).
- PR header: id, title, author, target branch, description.
- Per-file sections: `### File: <path>\n**Diff:**\n<unified diff>`.
- Applied to each batch produced by `buildAdaptiveChunks` (greedy packing within the token budget).
- Optional `additionalInstructions` from the `ticketSidekick.bitbucket.reviewInstructions` setting.

**Inputs assembled — Pass 2** (skipped in `quick` mode):
- Same as Pass 1, plus `**Full content:**\n<source>` appended to each file section for files listed in `additionalFilesNeeded`.
- A pass-2 note prepended: "This is a second-pass review. Full file contents have been provided… if a finding was speculative due to missing context and the full file shows no issue, omit it from your response."

**Framing and grounding:**

`REVIEW_PROMPT_PREFIX` is a hardcoded system preamble with five explicit grounding rules:

1. Only report findings for files whose exact path appears in a `diff --git` header.
2. Treat JSON fixtures and test data as data, not production logic.
3. Only cite line numbers visible in the diff context; omit the `line` field otherwise.
4. Only report confirmed issues — omit speculative findings.
5. Only request real source files in `additionalFilesNeeded`; never request fixtures or inferred paths.

The review categories are fixed: security vulnerabilities, best-practice violations, bugs and logic errors.

The output schema is specified inline:

```json
{"findings":[{"file":"…","line":42,"severity":"critical|warning|suggestion",
  "title":"…","description":"…","recommendation":"…","codeExample":"…"}],
"additionalFilesNeeded":["…"]}
```

**Output and parsing:**
`extractJsonObject` searches for the first `{…}` block in the raw response. `JSON.parse` is called on it; if it fails, the error message includes the extracted text (up to 400 chars) and the raw response head (up to 600 chars) for diagnosis. Findings are accumulated across all batches and merged before formatting.

**Token budget:**
Resolved as: `ticketSidekick.bitbucket.modelContextTokens` → `request.model.maxInputTokens` (VS Code API) → 60 000. Multiplied by `contextBudgetRatio` (default 0.7) to leave headroom for the response. Each chunk is estimated as `1500 + 50×files + ceil(diff.length / 4)` tokens.

**Known limitations:**
JSON non-compliance by the model causes a hard error surfaced to the user. The error message includes raw model output to help diagnose whether the issue is a bad diff, a model limitation, or a token overflow.

---

### 10. Finding matching

**Trigger:** Follow-up `@bitbucket` message when no finding number (`#N`) is present in the prompt.

**Inputs assembled:**
- The user's follow-up question.
- A listing of all findings: `#<id>: [<severity>] <title> (<file>)` — one per line.

**Framing and grounding:**

Inline prompt (no few-shot, no system role):

```
The developer asked: "<prompt>"

Available findings:
#1: [critical] SQL injection (src/db/query.ts)
#2: [warning] Token in localStorage (src/auth/store.ts)
…

Reply with ONLY the finding number (e.g. "2") that best matches the question,
or "none" if no match.
```

The constraint "ONLY the finding number" minimizes parsing work and prevents the model from embedding the answer in prose.

**Output and parsing:**
`parseInt(matchRaw.trim(), 10)` — if the result is `NaN`, no match is assumed and the user is asked to reference a finding by number.

---

### 11. Finding explanation

**Trigger:** Follow-up `@bitbucket` message after a finding has been matched (either by number or via use case 10).

**Inputs assembled:**
- The selected finding: file path, line (if present), severity, title, description, recommendation.
- The user's follow-up question.

**Framing and grounding:**

`FOLLOW_UP_PROMPT_PREFIX` is a fixed preamble:

```
A developer is asking a follow-up question about a specific finding from a
code review. Answer their question directly and thoroughly. If they state an
assumption, evaluate it. Include specific conditions under which this could be
acceptable or needs fixing, and any concrete code changes where relevant.
```

The finding detail and the developer's question are appended verbatim. No JSON output — this is a free-form prose response.

**Output and parsing:**
Plain text streamed directly into chat. No parsing.

---

## Part 3 — Cross-cutting mechanics

### VS Code LM API

All calls use `model.sendRequest(messages, {}, token)` where:
- `messages` is an array of `vscode.LanguageModelChatMessage` objects.
- `{}` is an empty options object (no tool definitions, no temperature overrides).
- `token` is a `vscode.CancellationToken` that propagates chat panel cancellation.
- Responses are consumed with `for await (const chunk of response.text)` and manually buffered into a string.

The model is never selected inside the extension — it is always passed in as `request.model` from the VS Code chat participant API, so the user's active Copilot Chat model is used.

### Few-shot prompting pattern

Most calls use a three-message User → Assistant → User pattern rather than a system message, because the VS Code LM API does not have a distinct system role. The pattern:

```
User:      <role description — what kind of expert you are>
Assistant: "Understood. <brief restatement of the role>"
User:      <actual task with data>
```

This establishes persona before the task arrives, which improves instruction-following compared to embedding the role in the task message.

### The `contentSource` two-level classification

Intent parsing produces two orthogonal classifications in one call:

1. **`operation`** — what to do (`addComment`, `updateField`, …)
2. **`contentSource`** — how to produce the content (`literal`, `generate`, `history-recent`, `history-full`)

`contentSource` encodes the user's epistemological intent: did they provide the exact text, invent something new, point at something from a few messages ago, or refer to the whole investigation? This drives fundamentally different downstream behavior:

- `literal` → skip AI generation entirely, post verbatim
- `generate` → call `generateContent` with standalone persona
- `history-recent` → serialize last 3 turns, call `generateContent` with scribe persona
- `history-full` → serialize all turns, call `generateContent` with scribe persona

The schema description for `contentSource` contains a deliberate tie-breaking rule: "when in doubt between `generate` and `history-full`, prefer `history-full`" — this avoids creative invention when the user likely means to document prior work.

A complementary regex shortcut, `isPointerPrompt`, detects unambiguous pointer phrases ("post it", "copy it", "add this as a comment") before the intent parser runs. When it fires, `contentSource` is forced to `history-recent` without an LLM call, and the last assistant message is posted verbatim. This covers the most common "just post what you wrote" case at zero latency.

### Token budget management (Bitbucket)

The review token budget is resolved in priority order:

1. `ticketSidekick.bitbucket.modelContextTokens` (user setting, hard override)
2. `request.model.maxInputTokens` (VS Code LM API, model-reported)
3. 60 000 (safe fallback for models that do not report their context size)

This is multiplied by `contextBudgetRatio` (default 0.7) to reserve space for the model's response. The estimate per diff chunk (`1500 + 50×files + ceil(diff.length / 4)`) approximates token count without tokenizing — the 4-bytes-per-token ratio is a conservative heuristic for mixed-language code.

### JSON robustness

Three calls require structured JSON output: intent parsing (`ParsedIntent`), section coverage (`string[]`), and PR review (`{findings, additionalFilesNeeded}`). All three use regex extraction before `JSON.parse` to tolerate models that wrap their output in markdown fences or add preamble text:

- `ParsedIntent`: `/\{[\s\S]*\}/` — extracts first JSON object
- Section coverage: `/\[[\s\S]*\]/` — extracts first JSON array; returns `[]` on failure
- PR review: `extractJsonObject()` — same object extraction; throws a descriptive error on failure

The safe fallback for section coverage (`[]`) causes all sections to be asked interactively — a worse user experience but not a crash. The PR review throws because there is no safe partial result.

### Refusal detection

Only `generateContent` checks for model refusals. The check (`isLmRefusal`) looks for common decline phrases (`"can't assist"`, `"unable to assist"`, etc.) in responses shorter than 300 characters. If a refusal is detected, the content preview step is skipped and an error is surfaced to the user. Other call sites do not perform refusal detection — intent parsing and structured outputs are expected to succeed or return a well-defined fallback.

### No prompt caching

The extension does not use the VS Code LM API's prompt caching features. Each call starts from scratch. The fixed preambles (`REVIEW_PROMPT_PREFIX`, `INTENT_PROMPT`, `FOLLOW_UP_PROMPT_PREFIX`) are candidates for caching if latency becomes a concern — they are long, static, and repeated on every request.

### Adding a new LLM call

1. Add a helper function in `src/participant/jira/llmHelpers.ts` (Jira) or inline in `BitbucketParticipant.ts` (Bitbucket).
2. Use the three-message User → Assistant → User pattern to establish a role.
3. End the task message with output format instructions and a grounding rule ("Base your response ONLY on the data provided above. Do not add information not present in the source.").
4. If the output is JSON, use regex extraction before `JSON.parse` and define a safe fallback.
5. Accept and forward `vscode.CancellationToken` — all async LLM calls must be cancellable.
6. If the call is in a user-visible critical path, wrap it in `callLLMWithProgress` to show a status-bar spinner.
