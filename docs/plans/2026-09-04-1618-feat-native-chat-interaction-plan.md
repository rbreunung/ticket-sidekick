---
title: Native VS Code Chat Interaction - Plan
type: feat
date: 2026-09-04
topic: native-chat-interaction
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
deepened: 2026-09-04
---

# Native VS Code Chat Interaction - Plan

## Goal Capsule

- **Objective:** A user working in `@jira` or `@bitbucket` answers a pending question, picks from a list, toggles a batch-review row, or asks about a PR finding by clicking directly on the relevant text in the chat response — never needing to type a reply for those cases — while every existing typed reply continues to work exactly as today, and no visible artifact of the extension's own session-tracking appears in the response.
- **Means:** Replace the HTML-comment-tag session-continuity check with `ChatResult.metadata` read off `chatContext.history` (KTD1), and render every currently-typed-only discrete-choice reply as an inline command-link wrapping the existing content, reusing `workbench.action.chat.open` directly with no new registered commands for the common case (KTD2).
- **Product authority:** User-directed — this conversation's brainstorm dialogue, including four mechanisms built and live-tested directly in the running Extension Development Host, plus two architecture forks resolved during planning research.
- **Open blockers:** None.
- **Execution profile:** `code`, Deep depth. Cross-cutting: touches 25 workspaceState-backed Jira sessions (corrected count — see KTD7), the untagged background `SearchResultSession`, and Bitbucket's `ReviewSession` (with its nested comment-preview sub-state) plus its PR-finding rendering.
- **Tail ownership:** Manual verification in the Extension Development Host across one representative session from each interaction shape (a pure numbered pick, a pure confirm/cancel, a table-toggle review screen, a PR finding) — VS Code Chat UI click-through has no automated coverage today, since `JiraParticipant.ts`/`BitbucketParticipant.ts` import `vscode` and stay outside the Vitest suite.

---

## Product Contract

**Product Contract preservation:** restructured, no scope change — the session count — carried in the Goal Capsule execution profile and KTD7, and referenced by R1 — was corrected from the brainstorm's "22" to the 25 found during planning research (see KTD7); this changes no requirement's meaning, only its stated scope size. R11 is new (added during planning, user-directed — see Key Decisions), covering a defect found adjacent to R10's own work. R12 and U9 were added during a post-implementation gap review (user-directed), closing five confirm/cancel/toggle render sites missed by U5/U6. R13 and U10 were added in the same gap review, migrating the `<!-- @jira-ticket:KEY -->` last-ticket marker — a context-tracking artifact distinct from the session tags R1–R3 moved — onto `ChatResult.metadata`. No other Product Contract content changed.

### Summary

Two changes to how `@jira` and `@bitbucket` interact with the user in chat: session continuity moves from a visible HTML-comment tag matched against rendered text to `ChatResult.metadata` carried on `chatContext.history`; and every reply a user can currently only give by typing — a numbered pick, a confirm/cancel, a per-row batch-review toggle, or an "explain this finding" question — gets an equivalent clickable element, alongside the existing typed path, unchanged. A defect found adjacent to this work (a non-rendering HTML fold in the Bitbucket review output) is fixed in the same pass.

### Problem Frame

Every one of this extension's multi-turn chat sessions detects whether it's still the active conversation by appending an HTML comment (e.g. `<!-- jira:transition-review -->`) as the literal last line of its response, then string-matching that tag against the previous turn's rendered text on the next request. This is a workaround: the tag exists purely to answer "is the stored session still current," a question `ChatResult.metadata` — the same channel already used elsewhere in this codebase for follow-up-chip suggestions — can answer natively, without a visible-in-principle artifact riding along in every multi-turn response.

Separately, every one of those sessions that asks the user to choose something — a resolution, a filter, whether to post a comment, which batch rows to skip — can currently only be answered by typing back a specific word, number, or phrase, even though VS Code's Chat API has real, working mechanisms for turning a piece of already-rendered content into something clickable. Nothing in the current implementation uses them.

### Requirements

**Session continuity**

- R1. Every multi-turn session (see KTD7 for the corrected inventory) detects whether it's still active by reading the prior turn's `ChatResult.metadata` off `chatContext.history`, not by matching a visible HTML-comment tag against the last rendered response text.
- R2. The actual session data continues to live in `workspaceState` exactly as today — only the liveness check changes.
- R3. No visible tag or marker remains in a rendered chat response as a byproduct of session-continuity tracking.

**Native discrete-choice interactions**

- R4. Any reply the user can currently only give by typing a specific word, number, or phrase gets an equivalent clickable element wrapping the existing content itself — never a separate "click here"-style affordance appended after it — while typing the same reply continues to work unchanged.
- R5. Clicking produces the exact same outcome as typing the reply: it appears as the user's own new message in the transcript, handled by the same multi-turn session logic already in place, not a separate code path.
- R6. Numbered or named pick-lists (resolution selection, filter selection, template/issue-type selection, load-skipped attachment pick, template-generation type pick) render each option's own label as the clickable element.
- R7. Every confirm/cancel-capable session renders the confirm action and the cancel action as clickable, full spelled-out words (e.g. "Cancel") rather than the current abbreviated `(c)` token.
- R8. Per-row toggles in batch review tables (cleanup/transition review, bulk-update review, and the Veracode/Waltz/email import review screens) render a checkmark per row that flips between included and excluded on click and re-renders the table with the updated state; typing specific row numbers to skip remains available alongside it.
- R9. A checkmark column always defaults to the positive framing — checked means the row's default action will happen (e.g. a "Create" column, checked by default) — never a negative "Skip" framing where checked means excluded.
- R10. Each finding in a completed Bitbucket PR review renders its own heading as a clickable element that asks the same "explain this finding" question already available by typing a reference to that finding's number.
- R11. The low-confidence-findings fold in a completed Bitbucket PR review renders as plain, always-visible markdown instead of the current `<details>`/`<summary>` HTML block, which does not render in VS Code's chat panel.

**Missed confirm/cancel/toggle sites (post-implementation gap review)**

- R12. The five discrete-choice render sites below — each currently a plain bold token or plain `✓`/`_excluded_` cell that U5/U6 missed — get the same clickable command-link treatment as their already-linked siblings, with typing the equivalent reply still working unchanged:
  - (a) `streamContentPreview`'s create-ticket confirm (`"create it"`), `src/participant/jira/contentHandler.ts`.
  - (b) `streamContentPreview`'s add-comment / update-description confirm (`"post it"`), same file.
  - (c) the template-generation field-review footer's `"post it"` and `"(c)"` tokens, `buildTemplateFieldReviewTable` in `src/participant/sessionState.ts` — the cancel becomes a full "Cancel" word resubmitting `cancel` (see U9 step 3; the current `(c)` does not actually cancel through this table's parser).
  - (d) the template-generation field-review table's per-row `Include?` toggle cell, `TEMPLATE_FIELD_REVIEW_COLUMNS` in `src/participant/sessionState.ts`.
  - (e) the comment-pagination `"load all"` token, `JiraParticipant.ts`.

**Last-ticket context marker (post-implementation gap review)**

- R13. The "last referenced ticket" key is carried on `ChatResult.metadata` — read back from `chatContext.history` — instead of a `<!-- @jira-ticket:KEY -->` HTML comment appended to rendered responses. No visible marker remains in any rendered Jira response, and the bare-follow-up resolution (`parseLastTicketFromContext`, called at `JiraParticipant.ts:968`) keeps its scan-all-turns-latest-wins semantics by reading metadata off history turns rather than regex-scanning rendered text.

### Key Decisions

- **One unified mechanism — a command-link wrapping the existing content, which resubmits the equivalent reply as a real chat turn — replaces three alternatives considered and ruled out in live testing.** `stream.button()` cannot render inside a markdown table cell at all (ruling it out for R8's per-row toggles) and needs a registered command per choice; `ChatFollowup` chips render as a fixed row below the whole response rather than inline with the option they answer. (session-settled: user-directed — chosen after building and comparing both live in the Extension Development Host against real review-table content) Governs R4, R5, R6, R7, R8, R10.
- **Session continuity moves onto `ChatResult.metadata` read from `chatContext.history`, the same channel already used for follow-up-chip suggestions in this codebase, rather than the current tag-in-rendered-text match.** `workspaceState` keeps owning the actual session data — only the liveness check changes. (session-settled: user-approved) Governs R1, R2, R3.
- **VS Code's built-in `askQuestions` tool and re-architecting onto an LLM tool-calling loop or a Model Context Protocol server were investigated and ruled out.** `askQuestions` is real but scoped to VS Code's bundled Copilot Chat "Chat Sessions" runtime — confirmed empirically absent from `vscode.lm.tools` inside this extension's own activated host, so it is not reachable via the public `lm.invokeTool()` API. The architectural alternatives would replace this codebase's hand-coded multi-turn state machines with an LLM-orchestrated tool loop — a materially larger change than the interaction-mechanism fix this plan scopes. Governs the Summary's stated scope (interaction-mechanism fix only).
- **Native `vscode.window.showQuickPick`/`showInputBox` and a custom Webview panel were ruled out**, consistent with an existing product principle: no native VS Code UI element should pull the user out of the chat panel (`docs/plans/2026-09-01-2324-fix-onboarding-chat-flow-continuity-plan.md`). Governs the Summary's stated scope (no native VS Code UI outside the chat panel).
- **Checkmark columns default to the positive framing (checked = default action) rather than negative (checked = skip).** (session-settled: user-directed) Governs R9.
- **`(c)` becomes a full spelled-out word wherever it is also clickable.** (session-settled: user-directed) Governs R7.
- **The command-link mechanism reuses `workbench.action.chat.open` directly, not new registered wrapper commands.** Planning research found this codebase's own walkthrough markdown already links `command:workbench.action.chat.open?<encoded-args>` inline with no intermediate command. (session-settled: user-directed — chosen over registering one wrapper command per interaction shape, after research surfaced the existing lower-cost precedent) Governs R4–R8, R10; see KTD2.
- **`PrReviewService.formatReview()` returns structured per-finding data instead of one assembled markdown string, so `BitbucketParticipant.ts` composes the trusted link.** (session-settled: user-directed — chosen over a regex substitution over the assembled output string) Governs R10; see KTD3.
- **The non-rendering `<details>`/`<summary>` low-confidence fold is replaced with plain markdown.** Found adjacent to R10's own work in the same function; VS Code's chat markdown renderer does not support raw HTML. (session-settled: user-directed) Governs R11; see KTD4.
- **Five discrete-choice render sites missed by U5/U6 get the same command-link treatment as their already-linked siblings, rather than a new mechanism.** A post-implementation gap review found that `streamContentPreview`'s create-ticket confirm (`"create it"`), its add-comment/update-description confirm (`"post it"`), the template-generation field-review footer (`"post it"`/`"(c)"`), that table's per-row `Include?` toggle, and the comment-pagination `"load all"` token were all left as plain bold text / plain `✓` cells while their siblings in other flows already link. Each is a discrete choice whose reply text an existing parser already accepts (`isConfirmation`, the template-field-review toggle/ok/cancel parser, the comment-pagination load-all path), so each reuses U1's `buildChatCommandLink` over that exact accepted text — no new parser, no new mechanism. (session-settled: user-directed) Governs R12; see U9.
- **The last-ticket key is a context-tracking artifact distinct from the session tags, and it migrates onto the same `ChatResult.metadata` channel per R3's intent rather than staying as an HTML comment.** The `<!-- @jira-ticket:KEY -->` marker was left in rendered responses when U2–U4 moved the *session* tags to metadata — a different artifact that rides the same "invisible context" idea. VS Code's chat renderer does not process raw HTML (established by R11/KTD4), so the comment renders as literal visible text even though `docs/jira-flows.md:61` claims it is "invisible in rendered markdown." Migrating the key onto metadata (read back from `chatContext.history`) removes the visible artifact and makes the doc's claim true, with no new mechanism. (session-settled: user-directed) Governs R13; see U10.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Session continuity rides on `ChatResult.metadata`, read via `chatContext.history[history.length-1].result.metadata`, extending the same channel `JiraFollowupState`/`BitbucketFollowupState` already use for follow-up chips** (`sessionState.ts:1306-1313`, `provideFollowups` at `JiraParticipant.ts:1406-1410`/`BitbucketParticipant.ts:1189-1191`). Every response-producing branch across `JiraParticipant.ts`, `BitbucketParticipant.ts`, and their `src/participant/jira/*Handler.ts` files must change from a bare `return;` to `return { metadata: { <sessionKind>: ... } };` — this is the largest mechanical surface in the plan, since today's comment at `JiraParticipant.ts:87-88` deliberately omits metadata from these branches ("a multi-turn session reply whose own response tag already carries the next-step guidance"). `getLastAssistantText()` (`ticketContext.ts:14-24`) and its tag-matching `if (lastResponse.includes(...))` branches are replaced by a metadata-read equivalent with the same reload characteristics (both read `chatContext.history`, so neither survives a reload differently than the other — not a regression). Governs R1, R2, R3.
- KTD2. **Discrete-choice command-links use inline `[label](command:workbench.action.chat.open?<url-encoded-JSON>)` markdown, not registered wrapper commands.** `workbench.action.chat.open` goes into each response's `MarkdownString.isTrusted.enabledCommands`, matching the four existing trust-gate call sites (`JiraParticipant.ts:99-105,115-119`; `BitbucketParticipant.ts:260-268,599-602`) and the walkthrough's own existing use of the same command. The query argument is `{ query: '@jira <exact reply text>', isPartialQuery: false }` — `isPartialQuery: false` (or omitted) auto-submits (confirmed against VS Code's own command implementation: `isPartialQuery: false` routes to `acceptInput`, not `setInput`). A wrapper command is added only for a reply whose text can't safely inline-encode in the query JSON (expected to be rare — replies here are short numbered/confirm/label text). Governs R4–R8, R10.
- KTD3. **`PrReviewService.formatReview()` returns structured per-finding data** (each finding's id, heading text, and body) instead of one assembled markdown string. `BitbucketParticipant.ts`'s existing `stream.markdown(output)` call (`BitbucketParticipant.ts:1144`) becomes a composition step: it builds the final trusted `MarkdownString`, wrapping each finding's heading in a `workbench.action.chat.open` command-link (query resubmits the same text `parseFollowUpIntent`'s `explain` path already accepts — `reviewSessionState.ts:324-356`). `formatReview()` stays free of any `vscode` import. Governs R10.
- KTD4. **The low-confidence fold (`formatReview()`'s `lowFold`, currently `<details>`/`<summary>` HTML) becomes a plain, always-visible markdown line** — a labeled list of low-confidence findings with no collapse, since VS Code's chat markdown renderer does not execute raw HTML. Governs R11.
- KTD5. **Pure command-link-building helpers stay in `sessionState.ts`/`reviewSessionState.ts` and return only raw markdown link text** (`[label](command:...)`) — they never construct or set `MarkdownString.isTrusted` themselves. This preserves the existing enforcement tests (`sessionState.test.ts:105`, `reviewSessionState.test.ts:25`, both titled "never emits a trusted MarkdownString command link — plain text only"). Trust-gating happens only in `JiraParticipant.ts`/`BitbucketParticipant.ts`, mirroring the existing `settingsLink`/`credentialsLink` shape. Governs R4–R12 as an implementation constraint. Note for U9: `streamContentPreview` (in `contentHandler.ts`) and `buildTemplateFieldReviewTable`'s render call sites currently use plain `stream.markdown(...)`; adding command-links to their output requires routing those responses through the same trust-gate (`trustedChatMarkdown(...)`) the already-linked siblings use.
- KTD6. **Per-row toggle state differs by table type.** Import-review tables (Veracode/Waltz/email) already carry `ReviewRowBase.included: boolean` (`sessionState.ts:609-613`) and `buildImportReviewTable` (`sessionState.ts:684-747`) already renders `✓`/`_excluded_` per row from it — R8 there is a rendering change on already-tracked state: the `✓`/`_excluded_` text becomes a command-link toggling `included` and resubmitting. The cleanup/transition table (`TransitionBatchSession`/`buildReviewTable`, `sessionState.ts:119-172`) has no per-row `included` field — its exclusion model is a cascading skip-set parsed by `parseSkipInput` (`sessionState.ts:208-238`). Add an `included`-shaped field to `TransitionBatchTicket`/`TransitionSubtask` mirroring `ReviewRowBase`'s existing convention, rather than inventing a new shape; `buildBulkUpdateReviewTable` (`sessionState.ts:766-768`, backed by `parseBulkUpdateReview`'s `skip KEY1 KEY2` syntax, `sessionState.ts:405-416`) gets the same field added. A fourth table type — the template-generation field-review table (`TEMPLATE_FIELD_REVIEW_COLUMNS`/`buildTemplateFieldReviewTable`, `sessionState.ts`) — already carries `included: boolean` on its rows and renders a plain `✓`/`_excluded_` cell, so R12(d) is a rendering-only change there (the cell becomes a command-link), not a state-field addition. Governs R8, R9, R12(d).
- KTD7. **Corrected session inventory: 25 workspaceState-backed Jira sessions, not 22.** `docs/jira-flows.md`'s `## Jira sessions` table under-counts by 3 — `FieldUpdatePreviewSession` (tag `<!-- jira:field-update-preview -->`, `JiraParticipant.ts:479`), `FieldSelectionSession` (`<!-- jira:selecting-field -->`, `:447`), and `SprintSelectionSession` (`<!-- jira:sprint-selection -->`, `:418`) exist in code but are missing from the table. Plus the untagged background `SearchResultSession` (silently overwritten, no reply-detection branch) and Bitbucket's `ReviewSession` (tag `<!-- bitbucket:review-session -->`) with its nested `<!-- bitbucket:comment-preview -->` sub-state (no separate `workspaceState` key — reuses `ReviewSession`'s own state plus in-flight refinement fields). Implementation units should enumerate sessions by grepping `<!-- jira:` tags in `JiraParticipant.ts` directly rather than trusting the doc table until U8 fixes it. Governs R1–R3 (scope correction only).

### Assumptions

- Every reply-shape classification (numbered pick / confirm-cancel / confirm-cancel-plus-escape-hatch / free text) used in Implementation Units below comes from direct reading of each session's parse function (`parseResolutionSelection`, `parseFilterSelection`, `parseSkipInput`, `parseBulkUpdateReview`, `parseReviewInput`, `parseFollowUpIntent`, etc.) during planning research, not from the stale `docs/jira-flows.md` table.
- `AwaitIssueTypeSession`, `CreationSession`'s Q&A answers, `LoadSkippedSession`'s numeric pick, `CommentListSession`'s query text, and the template-generation await-name/await-free-type/await-summary sessions are free text or numbered-but-open-ended enough that R6's "clickable label" treatment does not apply cleanly — `LoadSkippedSession` is the one partial exception (a numbered pick over a short attachment list) and gets R6 treatment; the rest stay typed-only, consistent with the Summary's scope for free-text sessions. This refers to the *free-text answers* those sessions collect (section content, issue-type names, template names), not to their discrete confirm/cancel/toggle tokens: `streamContentPreview`'s `"create it"`/`"post it"` confirms and the template-field-review footer/toggle are discrete choices and get R12 treatment (U9) even though the surrounding Q&A stays typed-only.

---

## Implementation Units

### U1. Shared command-link helper and trust-gating pattern

- **Goal:** One pure helper that builds a raw `[label](command:workbench.action.chat.open?<encoded>)` markdown string for a given reply text, reused by every later unit; document the trust-gating call-site pattern.
- **Requirements:** R4, R5. KTD2, KTD5.
- **Dependencies:** None.
- **Files:**
  - `src/participant/sessionState.ts`
  - `src/participant/reviewSessionState.ts` (re-export or mirror, per existing cross-file convention — `sessionState.ts` and `reviewSessionState.ts` do not import each other)
  - `src/test/sessionState.test.ts`
  - `src/test/reviewSessionState.test.ts`
- **Approach:**
  1. Add `buildChatCommandLink(label: string, participantId: '@jira' | '@bitbucket', replyText: string): string` returning the raw markdown link — URL-encodes `JSON.stringify({ query: \`${participantId} ${replyText}\`, isPartialQuery: false })` into the `command:workbench.action.chat.open?...` URI.
  2. The helper never touches `vscode.MarkdownString` — it is plain string building, consistent with KTD5 and the existing `sessionState.test.ts:105`/`reviewSessionState.test.ts:25` enforcement.
  3. Document (code comment) that every caller building a `MarkdownString` from output containing this helper's links must set `.isTrusted = { enabledCommands: ['workbench.action.chat.open'] }` before `stream.markdown(...)`, mirroring `JiraParticipant.ts:99-105`.
- **Test scenarios:**
  - `buildChatCommandLink('Fixed', '@jira', 'Fixed')` returns a `[Fixed](command:workbench.action.chat.open?...)` string whose decoded query JSON is `{ query: '@jira Fixed', isPartialQuery: false }`.
  - A reply text containing a character requiring escaping in JSON (e.g. a quote) round-trips correctly through encode/decode.
  - The helper's output, when passed through the existing "never emits a trusted MarkdownString" test pattern, still passes — confirms no `vscode` dependency was introduced.
- **Verification:** `npm test` passes for both test files; `npm run compile` clean.

### U2. Session continuity — shared type and `JiraParticipant.ts`'s own inline sessions

- **Goal:** Introduce the metadata-carrying continuity mechanism and apply it to every session branch that lives directly in `JiraParticipant.ts` (not delegated to a `*Handler.ts` file).
- **Requirements:** R1, R2, R3.
- **Dependencies:** None.
- **Files:**
  - `src/participant/JiraParticipant.ts`
  - `src/participant/sessionState.ts`
  - `src/participant/jira/ticketContext.ts`
  - `src/test/JiraParticipant.test.ts` (or equivalent — check for existing coverage of `getLastAssistantText`/tag-matching before adding)
- **Approach:**
  1. Add a metadata-shaped type (e.g. `JiraSessionContinuity`) alongside `JiraFollowupState` in `sessionState.ts`, carrying the active session's kind/tag-equivalent.
  2. Add a helper (e.g. `getActiveJiraSession(chatContext): JiraSessionContinuity | undefined`) reading `chatContext.history[history.length-1]` when it is a `ChatResponseTurn`, returning `.result.metadata?.jiraSession`.
  3. Replace `lastResponse.includes('<!-- jira:TAG -->')` checks with the new helper's return value, for every session branch defined directly in `JiraParticipant.ts` (per KTD7's grep-based inventory — resolution selection, transition review's `JiraParticipant.ts`-side resume paths, sprint selection, field selection, field-update preview, more-comments, comment-list, load-skipped, and any other inline branch not delegated to a handler file).
  4. Every one of those branches' `stream.markdown(...)` calls gains a matching `return { metadata: { jiraSession: {...} } };`.
  5. Remove the now-unused tag strings from the response text for these branches only (handler-file branches keep their tags until U3/U4 land, so the codebase stays in a working mixed state between units).
- **Test scenarios:**
  - Covers R1–R3. A session with metadata set on the prior turn, when the next turn arrives, is read as active via the new helper.
  - The old tag-matching helper (`getLastAssistantText`), if retained for handler-file branches still pending U3/U4, continues to work unchanged for those branches.
  - A turn with no prior metadata (fresh conversation, or the user sent an unrelated message) resolves to "no active session," matching today's behavior when the tag is absent.
- **Verification:** `npm test`, `npm run compile`. Manual: start a resolution-selection or sprint-selection session, confirm it resumes correctly on the next turn with no visible tag in the response.

### U3. Session continuity — core flow handler files

- **Goal:** Apply the metadata mechanism to the six core flow handlers.
- **Requirements:** R1, R2, R3.
- **Dependencies:** U2 (shares the type and helper).
- **Files:**
  - `src/participant/jira/createHandler.ts`
  - `src/participant/jira/contentHandler.ts`
  - `src/participant/jira/fieldHandler.ts`
  - `src/participant/jira/workflowHandler.ts`
  - `src/participant/jira/loadHandler.ts`
  - `src/participant/jira/cleanupHandler.ts`
  - Corresponding test files in `src/test/`
- **Approach:**
  1. For each file, every function that streams a response ending in a session tag gains a `return { metadata: {...} } ;` using U2's type/helper.
  2. Update the matching detection branches in `JiraParticipant.ts` for these handlers' sessions to use the new metadata helper instead of tag-matching.
  3. Remove the response tags for these sessions once both sides (build + detect) are converted.
- **Test scenarios:**
  - One test per handler file confirming its session-producing function returns the expected `metadata` shape.
  - Covers R1–R3 for at least one session in this group (e.g. content preview or field-update preview resumes correctly, is silently dropped when superseded).
- **Verification:** `npm test`, `npm run compile`. Manual: run `@jira run cleanup`, confirm the review screen resumes correctly through a resolution-selection detour.

### U4. Session continuity — report-import, template-generation, and Bitbucket

- **Goal:** Apply the metadata mechanism to the remaining Jira handler files and to Bitbucket's `ReviewSession`.
- **Requirements:** R1, R2, R3.
- **Dependencies:** U2.
- **Files:**
  - `src/participant/jira/reportImportHandler.ts`
  - `src/participant/jira/veracodeHandler.ts`
  - `src/participant/jira/waltzHandler.ts`
  - `src/participant/jira/emailHandler.ts`
  - `src/participant/jira/templateGenerationHandler.ts`
  - `src/participant/BitbucketParticipant.ts`
  - `src/participant/reviewSessionState.ts`
  - Corresponding test files in `src/test/`
- **Approach:**
  1. Same mechanical conversion as U3, for the report-import/template-generation family.
  2. For Bitbucket: add the equivalent metadata type in `reviewSessionState.ts` (mirroring `BitbucketFollowupState`'s existing shape), convert `ReviewSession`'s main tag and the nested `comment-preview` sub-state, and update `BitbucketParticipant.ts`'s detection branches.
- **Test scenarios:**
  - Covers R1–R3 for the Bitbucket `ReviewSession`: an active follow-up session is dropped correctly when the user sends an unrelated message.
  - One test confirming the batch email/Veracode/Waltz import review screen resumes correctly through metadata after a template-selection detour.
- **Verification:** `npm test`, `npm run compile`. Manual: run a Bitbucket PR review, ask a follow-up, confirm the session state and metadata both round-trip; run a Veracode import, confirm resume through template selection.

### U5. Numbered picks and confirm/cancel become clickable

- **Goal:** Apply U1's command-link helper to every pure numbered-pick and pure confirm/cancel session (R6, R7).
- **Requirements:** R6, R7.
- **Dependencies:** U1.
- **Files:**
  - `src/participant/sessionState.ts` (render functions for resolution selection, filter selection, create-selection, sprint selection, field selection, template-generation type pick, load-skipped pick, template-gen collision, template-gen offer-create, more-comments)
  - `src/participant/reviewSessionState.ts` (Bitbucket's confirm/cancel prompts)
  - `src/participant/jira/*Handler.ts` files that render these sessions directly (per KTD7's inventory)
  - `src/test/sessionState.test.ts`, `src/test/reviewSessionState.test.ts`
- **Approach:**
  1. For each numbered-pick session, wrap each option's own label text with U1's helper instead of appending separate link text — the label itself becomes `[Fixed](command:...)`.
  2. For each confirm/cancel session, spell out the cancel word (KD: "`(c)` becomes a full word") and wrap both the confirm and cancel words with U1's helper.
  3. Typed replies (name, number, `(c)`/"cancel") must still parse correctly — verify against each session's existing parse function; do not change parser behavior, only the rendered text.
- **Test scenarios:**
  - Covers R6. A resolution-selection render with four options: each option's own name is the link, no separate "Select" text.
  - Covers R7. Every confirm/cancel render: cancel reads as a full word, never `(c)`.
  - A typed numeric reply (e.g. "2") and a typed name reply both still resolve correctly through the existing parser, unchanged by the rendering change.
  - A typed "cancel" (full word) and a typed "(c)" (old abbreviation, still typeable even though no longer shown) both still parse as cancellation, per `isCancellation`'s existing word-list behavior.
- **Verification:** `npm test`, `npm run compile`. Manual: click a resolution option and a cancel link in the Extension Development Host; confirm each resubmits and resolves identically to typing.

### U6. Per-row table toggles

- **Goal:** Convert batch review tables' inclusion indicator to a clickable checkmark (R8, R9).
- **Requirements:** R8, R9.
- **Dependencies:** U1. Reads on U6's own toggle-state field being present (KTD6) before rendering, so the state-field addition and the rendering change land together per table type.
- **Files:**
  - `src/participant/sessionState.ts` (`buildImportReviewTable`, `buildReviewTable`, `buildBulkUpdateReviewTable`, `TransitionBatchTicket`, `TransitionSubtask`, `parseSkipInput`, `parseBulkUpdateReview`)
  - `src/participant/jira/cleanupHandler.ts` (constructs `TransitionBatchTicket`/`TransitionSubtask`)
  - `src/test/sessionState.test.ts`
- **Approach:**
  1. Import-review tables (Veracode/Waltz/email): change `buildImportReviewTable`'s `✓`/`_excluded_` cell text to a command-link toggling `r.included` and resubmitting a toggle reply `parseReviewInput` already parses.
  2. Rename/reframe any existing "Skip" column header to a positive action name (e.g. "Create") per R9; confirm default `included: true`.
  3. Add `included: boolean` (default `true`) to `TransitionBatchTicket`/`TransitionSubtask`, populated by `cleanupHandler.ts` at construction; extend `buildReviewTable`/`buildBulkUpdateReviewTable` to render it as a command-link under a positive-action column header (e.g. "Transition"), defaulting all rows checked — the same R9 reframe applied to import tables in step 2.
  4. Extend `parseSkipInput`/`parseBulkUpdateReview` (or add an adjacent toggle-reply parser) to accept a click-generated single-row toggle reply, without breaking the existing multi-number typed skip syntax.
- **Test scenarios:**
  - Covers R8, R9. A cleanup review batch: every row starts checked under a positive-action header; clicking one row's checkmark toggles only that row and the table re-renders with just that change.
  - Covers R8. Typing specific ticket numbers to skip produces the same excluded-row outcome as clicking those rows' checkmarks.
  - An import review table (Veracode) with a pre-existing `included: false` row (from a prior toggle) renders that row unchecked on the next render.
  - A three-way toggle sequence (check, uncheck, re-check the same row) ends in the correct final state.
- **Verification:** `npm test`, `npm run compile`. Manual: run `@jira run cleanup` and a Veracode import, click a row's checkmark in each, confirm the table re-renders correctly and the final transitioned/created set matches what was checked.

### U7. Bitbucket PR-finding clickable headings and low-confidence fold fix

- **Goal:** Make each finding's heading clickable (R10) and replace the non-rendering `<details>` fold (R11).
- **Requirements:** R10, R11.
- **Dependencies:** U1.
- **Files:**
  - `src/services/PrReviewService.ts`
  - `src/participant/BitbucketParticipant.ts`
  - `src/test/PrReviewService.test.ts`
- **Approach:**
  1. Change `formatReview()`'s return shape to include structured per-finding data (id, heading text, body) alongside (or instead of) the single assembled `markdown` string — per KTD3, confirm no `vscode` import is introduced.
  2. In `BitbucketParticipant.ts`'s composition step (`:1144`), wrap each finding's heading in U1's command-link helper, replaying the same reply text `parseFollowUpIntent`'s `explain` path (`reviewSessionState.ts:324-356`) already accepts for a finding reference.
  3. Replace the `<details>`/`<summary>` low-confidence fold with a plain markdown line — a labeled, always-visible list of low-confidence findings, same content, no collapse. When `lowCount` is zero, render no low-confidence section at all (preserving current behavior).
  4. Preserve `formatReview()`'s other existing return fields (`primaryCount`, `lowCount`) and confirm all existing callers still compile.
- **Test scenarios:**
  - Covers R10. A completed review with five findings: clicking finding #3's own heading produces the same answer as typing a question referencing finding #3.
  - `formatReview()`'s low-confidence section, when it fires, renders as plain markdown with no `<details>`/`<summary>` tags in the output string.
  - Existing `formatReview()` test assertions on `primaryCount`/`lowCount` and overall markdown shape still pass after the structural change (update assertions for the new return shape, don't drop coverage).
- **Verification:** `npm test`, `npm run compile`. Manual: run a Bitbucket PR review with at least one low-confidence finding, confirm the fold renders visibly (not collapsed/hidden), and click a finding heading to confirm it produces an explain answer.

### U8. Documentation sync

- **Goal:** Bring `docs/jira-flows.md`, `docs/review-process.md`, and `CLAUDE.md` in line with the new mechanism and the corrected session inventory.
- **Requirements:** none directly (documentation only); supports R1-R11's discoverability.
- **Dependencies:** U1–U7.
- **Files:**
  - `docs/jira-flows.md`
  - `docs/review-process.md`
  - `CLAUDE.md`
- **Approach:**
  1. Fix `docs/jira-flows.md`'s `## Jira sessions` table per KTD7 (add the three missing sessions), and replace the "workspaceState key + response tag" mechanism description with the metadata-based one.
  2. Update `docs/review-process.md`'s follow-ups section for Bitbucket's `ReviewSession` the same way.
  3. Update `CLAUDE.md`'s "Multi-turn session state" section, which currently describes the tag mechanism being replaced.
- **Test expectation:** none — documentation only, no behavioral change.
- **Verification:** Each doc's session/mechanism description matches the shipped code; no residual mention of the HTML-tag mechanism as current behavior.

### U9. Missed confirm/cancel/toggle sites (post-implementation gap review)

- **Goal:** Give the five discrete-choice render sites missed by U5/U6 the same clickable command-link treatment as their already-linked siblings, with typing the equivalent reply still working unchanged.
- **Requirements:** R12. KTD2, KTD5, KTD6.
- **Dependencies:** U1 (reuses `buildChatCommandLink`). Independent of U2–U8 — can land in any order; it is a rendering-only change over already-parsed reply text.
- **Files:**
  - `src/participant/jira/contentHandler.ts` (`streamContentPreview`, both branches)
  - `src/participant/sessionState.ts` (`buildTemplateFieldReviewTable`, `TEMPLATE_FIELD_REVIEW_COLUMNS`)
  - `src/participant/jira/templateGenerationHandler.ts` (render call sites for the field-review table — trust-gate wrap)
  - `src/participant/JiraParticipant.ts` (comment-pagination `"load all"` lines)
  - `src/test/sessionState.test.ts`, and any test asserting on `buildTemplateFieldReviewTable`'s footer text
- **Approach:**
  1. **(a) create-ticket confirm** — in `streamContentPreview`'s `createTicket` branch, replace the plain bold `"create it"` with `buildChatCommandLink('create it', '@jira', 'create it')`; wrap the response in `trustedChatMarkdown(...)`. `"create it"` is already in `isConfirmation()` (`sessionState.ts:362`), so the click reproduces typing exactly.
  2. **(b) add-comment / update-description confirm** — same branch's sibling: replace plain bold `"post it"` with `buildChatCommandLink('post it', '@jira', 'post it')`; wrap in `trustedChatMarkdown(...)`.
  3. **(c) template-field-review footer** — in `buildTemplateFieldReviewTable`, replace `**post it**` and `**(c)**` with `buildChatCommandLink('Post it', '@jira', 'post it')` and `buildChatCommandLink('Cancel', '@jira', 'cancel')`. **The cancel link must resubmit the word `cancel`, not `(c)`:** this table is parsed by `parseReviewInput` (`sessionState.ts:964`), whose cancel check delegates to `isCancellation()` — a set containing `cancel` but *not* the literal `(c)` (unlike `isExplicitCancelToken()`, which is used only by the template-gen free-text name/type asks, not this table). A link resubmitting `(c)` would parse as `invalid` and re-prompt instead of cancelling. Using `cancel` also matches the flow's own re-prompt (`templateGenerationHandler.ts:446`, already `Cancel → 'cancel'`) and satisfies R7 (full spelled-out word, clickable). This fixes a pre-existing inconsistency where the initial footer's `(c)` never actually cancelled through this parser — only the re-prompt did.
  4. **(d) template-field-review per-row toggle** — in `TEMPLATE_FIELD_REVIEW_COLUMNS`, change the `Include?` accessor from plain `r.included ? '✓' : '_excluded_'` to `buildChatCommandLink(r.included ? '✓' : '_excluded_', '@jira', r.id)` — resubmitting the row's own id, which `applyReviewToggle` (`sessionState.ts:1002`) already flips. Mirror the import-tables' R8 cell exactly (`sessionState.ts:859-868`).
  5. **(e) comment-pagination load-all** — at all three sites in `JiraParticipant.ts` (`:1000`, `:1039`, `:1069`), replace plain bold `"load all"` with `buildChatCommandLink('load all', '@jira', 'load all')`; wrap each response in `trustedChatMarkdown(...)`. `"load all"` is already in `isConfirmation()`.
  6. **Trust-gate the render call sites** that now emit links but currently use plain `stream.markdown`: `contentHandler.ts`'s `streamContentPreview` (both branches) and `templateGenerationHandler.ts`'s field-review table renders (`:424`, `:474`). Per KTD5, the pure helpers return raw link text; only these participant-side call sites set trust.
- **Test scenarios:**
  - Covers R12(a)/(b). `streamContentPreview`'s create-ticket and add-comment/update-description responses each contain a `command:workbench.action.chat.open` link whose decoded query is `{ query: '@jira create it', ... }` / `{ query: '@jira post it', ... }`; the surrounding summary/description text is unchanged.
  - Covers R12(c). `buildTemplateFieldReviewTable`'s footer contains links decoding to `@jira post it` and `@jira cancel` (the word, not `(c)` — see step 3); update any existing assertion that matched the old plain-bold footer text rather than dropping coverage.
  - Covers R12(d). A field-review row with `included: true` renders a `✓` cell whose link decodes to the row's own id; a row with `included: false` renders `_excluded_`; clicking (resubmitting the id) flips only that row via `applyReviewToggle`.
  - Covers R12(e). Each of the three comment-pagination responses contains a `load all` link decoding to `{ query: '@jira load all', ... }`.
  - The existing "never emits a trusted MarkdownString command link — plain text only" enforcement tests (`sessionState.test.ts`) still pass for the pure helpers — no `vscode` dependency introduced in `sessionState.ts`.
- **Verification:** `npm test`, `npm run compile`. Manual (Extension Development Host): create a ticket and click `"create it"`; post a comment and click `"post it"`; generate a template, toggle a field row's `Include?` cell and click the footer's `post it`/`(c)`; load a ticket with >10 comments and click `"load all"` — each reproduces the typed reply's outcome.

### U10. Last-ticket marker → metadata (post-implementation gap review)

- **Goal:** Carry the "last referenced ticket" key on `ChatResult.metadata` instead of a `<!-- @jira-ticket:KEY -->` HTML comment appended to rendered responses, so no visible marker remains and bare-follow-up resolution reads metadata off history turns.
- **Requirements:** R13. KTD1 (same `ChatResult.metadata` channel), KTD7 (enumerate by grep, not docs).
- **Dependencies:** U2 (shares the `JiraSessionContinuity`/metadata helper and the same "read from `chatContext.history`" pattern). Independent of U5–U9 — it is a context-tracking change over already-rendered text, not a link or session-tag change.
- **Files:**
  - `src/participant/sessionState.ts` (extend the Jira metadata type with an optional last-ticket key; add/adjust the pure helper that reads it off history turns)
  - `src/participant/jira/ticketContext.ts` (`parseLastTicketFromContext` — switch from regex-scanning rendered text to reading metadata off history turns, preserving scan-all-turns-latest-wins)
  - Emission sites (remove the marker append): `src/participant/JiraParticipant.ts`, `src/participant/jira/contentHandler.ts`, `src/participant/jira/emailHandler.ts`, `src/participant/jira/fieldHandler.ts`, `src/participant/jira/loadHandler.ts` — enumerate by grepping `@jira-ticket:` rather than trusting this list
  - Tests: `src/test/contentHandler.test.ts`, `src/test/fieldHandler.test.ts`, `src/test/JiraParticipant.test.ts` (the `extractLastTicketFromText` describe block), `src/test/llmHelpers.test.ts`
- **Approach:**
  1. **Extend the metadata type.** Add an optional last-ticket key to the Jira session-continuity metadata shape in `sessionState.ts` (e.g. `lastTicketKey?: string` on `JiraSessionContinuity`, or a sibling field if that reads cleaner). Keep it pure — no `vscode` import.
  2. **Add/adjust the reader.** In `ticketContext.ts`, change `parseLastTicketFromContext` to iterate `chatContext.history` in reverse and return the first turn whose `.result.metadata` carries a last-ticket key — replacing the current regex scan of rendered markdown text (`extractLastTicketFromText`). Preserve the exact "scan all turns, latest wins" semantics it has today.
  3. **Remove every emission site.** Grep `@jira-ticket:` across `src/` and, at each site, drop the marker append from the rendered response and instead attach the key to that branch's returned `ChatResult.metadata`. Sites span `JiraParticipant.ts`, `contentHandler.ts`, `emailHandler.ts`, `fieldHandler.ts`, and `loadHandler.ts` (~21 emissions). Where a branch already returns metadata (post-U2), add the key to it; where it does not, return `{ metadata: { ... } }`.
  4. **Update tests.** Replace assertions that the rendered markdown contains `<!-- @jira-ticket:KEY -->` (`contentHandler.test.ts`, `fieldHandler.test.ts`) with assertions on the returned metadata. Update the `extractLastTicketFromText` describe block in `JiraParticipant.test.ts` to cover the new metadata-reading path (and remove/repurpose the text-extraction helper if it is now unused). Fix the history-turn fixtures in `llmHelpers.test.ts` that embed the marker in rendered text.
  5. **Fix the doc.** `docs/jira-flows.md:61` claims the marker is "invisible in rendered markdown" — after this unit that becomes true; update the surrounding prose to describe the key as metadata-carried (fold into U8's doc pass or do it here).
- **Test scenarios:**
  - Covers R13. A create-ticket and a load-ticket response return `metadata` carrying the ticket key, and their rendered markdown contains no `@jira-ticket:` marker.
  - Covers R13 (resolution). Given a history whose last metadata-carrying turn references `PROJ-125`, bare-follow-up resolution returns `PROJ-125`; a later non-metadata turn does not clear it (latest-wins across all turns, matching today's behavior).
  - The existing "no visible tag in any rendered response" enforcement still holds — no new visible artifact is introduced.
- **Verification:** `npm test`, `npm run compile`. Manual (Extension Development Host): create a ticket and load another; confirm neither response shows a `<!-- @jira-ticket:… -->` line, then send a bare follow-up (e.g. "add a comment") and confirm it resolves to the most recently referenced ticket.

---

## System-Wide Impact

- **Every handler file that produces a session response is touched in lockstep by U2–U4.** The metadata migration is not isolated to `JiraParticipant.ts` — it reaches all six core handlers (U3), the report-import/template-generation family, and Bitbucket's `ReviewSession` (U4). Between units, the codebase intentionally runs a mixed old/new mechanism: sessions converted by an earlier unit resume via metadata, sessions not yet converted still resume via tag-matching. Both mechanisms coexist safely because they read independent data (`ChatResult.metadata` vs. rendered response text) — a converted session and an unconverted one never interfere with each other's liveness check.
- **The two participants (`@jira`, `@bitbucket`) stay independent**, per this codebase's existing architecture (`CLAUDE.md`: the two participants share only `ConfigService`). U2–U4 and U5–U7's changes to one participant's files carry no dependency on the other's; U4 and U7 both touch Bitbucket but through different files (`reviewSessionState.ts`/`BitbucketParticipant.ts` for continuity, `PrReviewService.ts`/`BitbucketParticipant.ts` for findings) and can land in either order.
- **Agent Mode / the `contributes.languageModelTools` surface (`jira_loadTicket`, `bitbucket_postComment`, etc.) is unaffected.** Confirmed during planning research: that surface never reads the `workspaceState` session keys or `ChatResult.metadata` this plan changes, and Agent Mode's tool-calling loop does not render or click chat markdown. No unit in this plan touches `src/tools/jiraTools.ts` or `src/tools/bitbucketTools.ts`.
- **U9 is a rendering-only delta over already-parsed reply text.** It adds no new session, parser, or state field — each of its five sites reuses a token an existing parser already accepts (`isConfirmation`, the template-field-review toggle/ok/cancel path, `applyReviewToggle`). Its only structural change beyond wrapping tokens in links is routing three currently-plain `stream.markdown` call sites (`contentHandler.ts`'s `streamContentPreview`, `templateGenerationHandler.ts`'s field-review renders) through the existing `trustedChatMarkdown(...)` trust-gate. It can land independently of U2–U8 and does not touch the metadata migration.
- **U10 touches every Jira response-producing branch that references a ticket — the same lockstep surface as U2–U4.** It removes the `<!-- @jira-ticket:KEY -->` marker from ~21 emission sites across five files and attaches the key to each branch's returned metadata instead. Mixed old/new coexists safely for the same reason it does in U2–U4: metadata and rendered text are independent data, so a converted branch (metadata) and an unconverted one (marker in text) never interfere — but a *missed* emission site silently loses last-ticket context for that flow with no error.

## Risks & Dependencies

- **The metadata migration (U2–U4) is the largest mechanical surface in the plan — every response-producing branch across ~10 files must be converted, and a missed branch fails silently.** A session whose branch is not converted keeps using tag-matching; if its *detection* branch is converted but its *response* branch is not (or vice versa), that session stops resuming with no error, no failing test, and no compile error — it just silently drops the user's in-progress flow. Mitigation: enumerate sessions by grepping `<!-- jira:` tags directly (KTD7) at the start of U2–U4, not from `docs/jira-flows.md`'s table, and treat "does every tag have a matching metadata-producing branch" as an explicit per-unit checklist before calling it done.
- **Precedent for this exact failure shape exists in this codebase:** a prior change left one review table missing a shared rendering convention every sibling table already had, and it was caught only by manual audit — tests and compile stayed green throughout (`docs/solutions/logic-errors/cleanup-review-table-issue-keys-not-linked-unlike-every-other-review-table.md`). U2–U4's manual verification step should include a full sweep across the corrected session inventory (KTD7), not spot-checks of a few sessions. **U9 is this same failure shape recurring in the link work itself:** five confirm/cancel/toggle sites shipped as plain text while their siblings linked, and were caught only by a post-implementation manual review — compile and tests stayed green throughout. Mitigation: U9's manual verification clicks each of the five sites, and the "does every discrete-choice token have a matching command-link" sweep should be re-run across all render functions (not just the ones U5/U6 named) before closing.
- **Dependency on existing parser behavior staying unchanged (U5, U6, U9):** every unit that adds a command-link reuses the exact same reply text the corresponding parser already accepts (`parseResolutionSelection`, `parseReviewInput`, `parseFollowUpIntent`, `isConfirmation`, `applyReviewToggle`, etc.). If a parser's accepted-text format ever drifts from what the click-generated reply encodes, clicking silently produces a different outcome than intended. No new parser logic is introduced by this plan specifically to avoid this risk — U5/U6/U7/U9 replay existing accepted text rather than inventing a new reply shape.
- **U10's failure mode is silent loss of last-ticket context, not an error.** A missed emission site (a branch that still appends the marker but never attaches metadata, or one that drops both) means bare follow-ups in that flow no longer resolve to the right ticket — no compile error, no failing test unless a scenario covers that specific branch. Mitigation: grep `@jira-ticket:` as an explicit per-branch checklist (KTD7), and confirm zero remaining matches in `src/` before closing U10; the updated resolution test (latest-wins across metadata-carrying turns) guards the reader side.

## Verification Contract

| Command | Applies to | Done signal |
|---|---|---|
| `npm run compile` | All units | `tsc` reports no errors |
| `npm test` | All units | All Vitest suites pass, including new/updated coverage in U1–U10 |

Manual verification (Extension Development Host, per Tail ownership): a resolution-selection or similar pure pick (U5), a confirm/cancel session (U5), a cleanup or import review table with per-row toggles (U6), and a Bitbucket PR review with a clickable finding and a visible low-confidence fold (U7) — each clicked through end to end and compared against typing the equivalent reply. U9 adds: click `"create it"` on a create-ticket preview, `"post it"` on a comment/description preview, the template-field-review footer's `post it`/`(c)` and a row's `Include?` cell, and `"load all"` on a paginated comment list — each reproducing its typed reply. U10 adds: create a ticket and load another, confirm neither response shows a visible `<!-- @jira-ticket:… -->` line, then send a bare follow-up and confirm it resolves to the most recently referenced ticket.

## Definition of Done

- `npm run compile` and `npm test` are both green, including new coverage from U1–U10.
- Every session in the corrected inventory (KTD7) resumes correctly via metadata, with no visible tag in any rendered response (R1–R3).
- Numbered picks, confirm/cancel, per-row table toggles, and Bitbucket findings are all clickable per R4–R10, with typing still working unchanged for each.
- The low-confidence findings fold renders visibly, without `<details>`/`<summary>` HTML (R11).
- The five missed sites in R12 (create-ticket `"create it"`, comment/description `"post it"`, template-field-review footer + per-row toggle, comment-pagination `"load all"`) are clickable with typing unchanged (U9).
- The last-ticket key is carried on `ChatResult.metadata` with no visible `<!-- @jira-ticket:KEY -->` marker in any rendered response, and bare-follow-up resolution still finds the most recently referenced ticket (R13, U10).
- `docs/jira-flows.md`, `docs/review-process.md`, and `CLAUDE.md` reflect the new mechanism and corrected session count (U8), including the now-true "invisible" claim for the last-ticket marker (U10).
- Manual verification in the Extension Development Host confirms all four representative interaction shapes plus U9's five sites and U10's no-visible-marker + bare-follow-up resolution (Tail ownership).
