# AI Usage in Ticket Sidekick

This document describes every place the extension invokes an AI language model: what data goes in, how the prompt is built and what comes back. It describes the current design (tools, skills and boards). The chat participants `@jira` and `@bitbucket`, which used to own most model calls (intent parsing, comment synthesis, content generation, finding matching), were removed on 2026-11-16 and 2026-11-23; their calls are gone.

---

## Part 1: User-facing overview

### Who calls the model

There are two kinds of model use, and they differ in who picks the model and who makes the call.

| Kind | Who calls the model | Which model | Examples |
| --- | --- | --- | --- |
| **Copilot's agent** | GitHub Copilot Chat, in your chat | The model you picked in the Copilot Chat panel | Reading a ticket through a tool, writing a brief, finding spelling errors, drafting a ticket from a template, choosing which tool to call |
| **The extension's boards** | The extension itself, outside any chat request | The model a setting names (`ticketSidekick.bitbucket.reviewModel`, `ticketSidekick.email.checkModel`) | The pull request review, the discussion of a finding, Regenerate, Rewrite, the email boilerplate check |

There is no hardcoded model, no Anthropic or OpenAI API key and no data sent to a third-party AI provider. Every request flows through the VS Code Language Model API and the GitHub Copilot backend.

### Copilot's agent (Jira and Bitbucket tools, `/ts-` skills)

The extension makes **no model call of its own** for single-ticket Jira work. Its tools (`jira_view_ticket`, `jira_create_ticket`, `jira_add_comment` and the rest) return data or write what the agent passes them; the agent, on your chat's model, does the reading, summarizing and drafting. What goes to the model is whatever a tool returns into the chat: ticket fields, description, comments and, for `bitbucket_getPullRequestDiff`, the diff.

| Skill | What the agent does with the model | Where the text comes from |
| --- | --- | --- |
| `/ts-jira-create` (also started by the agent for a new ticket) | Drafts the ticket from a template, asks for missing fields, shows the draft before `jira_create_ticket` writes | Your request, the template, the project's fields |
| `/ts-jira-brief` | Writes a developer brief of one ticket | Description, comments and relevant attachments of the ticket |
| `/ts-jira-spell-check` | Proposes corrections to a description; `jira_correct_description` applies only the corrections you approve | The ticket description |
| `/ts-jira-template` | Builds a template from a ticket; `jira_create_template` saves it under the next free number | An existing ticket's fields and description |
| `/ts-jira`, `/ts-bitbucket` | Run the command you type through the matching tools | The command and what the tools return |

A tool that writes shows a confirmation with every value before it runs, so the agent never writes to Jira or Bitbucket on its own.

### The extension's boards

A board calls the model for these tasks, and only after you started the board's step:

| Board | Task | What the model gets | Setting |
| --- | --- | --- | --- |
| Review | The regular pass: review each batch of changed files | PR title, author, branch and description, the unified diff of the batch, context files read at the reviewed commit, `ticketSidekick.bitbucket.reviewInstructions`, the background (a Jira ticket's text as you left it in the box, as data, or your own text, as instructions) | `reviewModel` |
| Review | Persona passes (security, performance, reliability, maintainability), the critic | The same diff batches and the background; a persona pass never gets another pass's findings, the critic gets the findings it checks. The picked persona passes run at the same time (up to four requests at once), the critic after them | `reviewModel` |
| Review | Discussion of a finding (Explain and each follow-up), Regenerate a draft comment | The finding with its code, the PR title and description, the background and the discussion so far (the first answer and the newest turns that fit); Regenerate writes the draft from the finding and the whole discussion | `reviewModel` |
| Review | Rewrite a draft comment | The draft and your instruction | `reviewModel` |
| Import | Email boilerplate check, only after you consent | The converted Markdown body of one email, to find signature and disclaimer blocks | `ticketSidekick.email.checkModel`, else `reviewModel` |
| Import | The model check after a pick (start screen) | The fixed prompt `Reply with the single word: ready`; no ticket, email or PR data | the model you picked |

A board never calls a model before you picked one: the review board's first step and the import start screen ask for the model and save the pick when the setting is empty or the model is no longer available. Every board model call counts toward the monthly token counters (`bitbucket_token_usage`, `/ts-bitbucket usage`).

### Privacy and data handling

Every model call sends only the data listed above. No credentials, no base URLs and no personal information beyond what is already in the Jira ticket, email or pull request. Diagnostic log lines are redacted by `logRedaction.ts` and never contain ticket or diff text; the content-free shape of a Data Center diff response is the only diff-related line logged.

---

## Part 2: Use case reference (boards)

The prompts, batching, anchor verification, retries and the critic are described in full in [`docs/review-process.md`](docs/review-process.md); this part says only where each call lives.

| # | Use case | Entry point | File |
| --- | --- | --- | --- |
| 1 | Regular pass, per diff batch, then the whole-file refinement call | `runRegularPass`, `callBatchWithSplit` | `src/review/engine/regularPass.ts`, `batchReview.ts`, `plumbing.ts` |
| 2 | Persona passes, picked ones at the same time under a cap | `runPersonaPass`, `extraPassesRun` | `src/review/engine/extraPass.ts`, `src/boards/review/runs.ts` |
| 3 | Critic | `runCritic` | `src/review/engine/critic.ts` |
| 4 | Discussion of a finding (Explain and follow-ups) | `askAboutFinding` | `src/review/findingCalls.ts` |
| 5 | Regenerate a draft comment from the discussion | `regenerateComment` | `src/review/findingCalls.ts` |
| 6 | Rewrite a draft comment | `rewriteComment` | `src/review/findingCalls.ts` |
| 7 | Email boilerplate check | `buildModelCheckPrompt`, `parseModelCheckReply`, `verifyModelBlocks` | `src/utils/emailBoilerplate.ts`, `src/boards/import/cleanupStage.ts` |
| 8 | Model check after a pick | `checkModelAnswers` | `src/boards/boardModels.ts` |

### Grounding rules

- **Review replies are untrusted.** A finding's line comes from the quoted `anchorCode`, never from the model's line number; code that cannot be found keeps the finding as *location unverified*, and a finding naming a file outside the PR is dropped and counted (see "The line-number trust boundary" in `docs/review-process.md`).
- **Email check replies are verified.** `verifyModelBlocks` keeps a block the model names only when its quote is found in the email, so the model cannot make the extension strip text that is not there.
- **Ticket text is data.** A Jira ticket used as the background is sent inside the untrusted-content fence with the PR title, description and diff, and the prompt says to read it as a description of the intended change, never as instructions; fence markers inside any of it are defanged. Your own text is sent as instructions.
- **Answers are rendered safely.** Discussion answers and the draft preview are rendered as Markdown in the extension into a tree of allowed elements: no raw HTML, scripts, images or command links, and a web link opens only after VS Code's confirmation (`src/review/markdownTree.ts`).

### Structured output

Review replies are JSON and parsed tolerantly (`parseReviewReply`: NDJSON, pretty-printed, arrays, wrappers, cut-off replies); the critic's `keep` list has its own parser. A reply with no usable JSON throws `UnparseableReplyError` and is retried like a provider error. The discussion, Regenerate and Rewrite return free text (Markdown).

---

## Part 3: Cross-cutting mechanics

### Calling a model outside a chat request

A board has no `request.model` to use, so it asks VS Code for the models you have (`vscode.lm`) and calls the one a setting names. `BoardModels` (`src/boards/boardModels.ts`, vscode-free) lists the models, sends a single prompt and hands out a stoppable handle; `registerBoards.ts` binds it to `vscode.lm`. Stop on a board aborts the request through an `AbortSignal`, and the text sent before the stop is not kept as a partial reply. Calls are made with `model.sendRequest(messages, options, token)`; responses are consumed with `for await (const chunk of response.text)`.

### Retries and splitting

`src/utils/lmRetry.ts` makes up to three tries per call. A transient failure (`isTransientLmError`) is retried; for a batch the third try splits the batch in half (`withEasierRetry`), for a single prompt it repeats the call (`withLmRetry`). A stopped request is rethrown at once. A batch that still fails is reported with the others kept. `refusalOf` tells Copilot's refusals apart: a rate-limited batch of passes running together makes the rest run one after another and the refused batch run once more after a wait; a blocked or quota refusal stops the run at once. See "Resilience & debugging" in `docs/review-process.md`.

### Token budget and metering

The review's token budget is resolved as `ticketSidekick.bitbucket.modelContextTokens`, else the model's own `maxInputTokens`, else 60 000, multiplied by `ticketSidekick.bitbucket.contextBudgetRatio` (default 0.7) and capped at 24 000 tokens per batch. `createTokenMeter` wraps the model, counts each request's input and output (falling back to `chars/4`, flagged as an estimate) and records it per month and model (`TokenUsageService`). See "Token usage" in `docs/review-process.md`.

### No prompt caching

The extension does not use prompt caching. Each call starts from scratch. The fixed preambles of the review prompts are long, static and repeated, so they are the candidates if latency becomes a concern.

### Adding a new model call

1. Decide whether the model call belongs to a board or to the agent. A single-ticket task belongs to the agent: add a tool that returns the data and a skill that tells the agent what to do with it; the extension makes no call.
2. For a board, put the prompt builder and the reply parser in a vscode-free module (`src/review/`, `src/boards/<kind>/` or `src/utils/`) and send through the board's injected `BoardModels` or model handle, never through `vscode.lm` directly.
3. End the task with the output format and a grounding rule ("Base your response only on the data above").
4. If the reply is JSON, parse it tolerantly, define a safe fallback or throw `UnparseableReplyError` so the call is retried.
5. Take the stop signal (`AbortSignal`) and let the call be cancelled; wrap a call you retry in `withLmRetry` or `withEasierRetry`.
6. Meter the call through the token meter and log it through `logDiag`/`onDiag` without content.
7. Add the call to the tables above and, if it is a setting or consent the user sees, to the user manual.
