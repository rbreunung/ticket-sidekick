---
title: Jira Chat UX Consistency - Plan
type: fix
date: 2026-08-21
topic: jira-chat-ux-consistency
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Jira Chat UX Consistency - Plan

## Goal Capsule

- **Objective:** Every `@jira` chat response is consistent in two ways — a ticket key is always a clickable Jira link when the workspace has a base URL configured, and every multi-turn flow accepts and rejects confirmation/cancellation input the same way.
- **Means:** Fix ticket-key linking at its root (`TicketService`, or inline at the call site when a flow bypasses `TicketService` entirely) instead of per-call-site workarounds, and replace six separate hand-rolled confirm/cancel checks with one shared mechanism.
- **Product authority:** Repo owner, established in the source brainstorm dialogue and confirmed during planning (the `no`/template-selection collision below).
- **Open blockers:** None. All planning-deferred and review-surfaced choices are resolved below (KTD1-KTD4).

## Product Contract

### Summary

Make `@jira` chat responses consistent: every message that names a ticket key links to Jira when configured, and every multi-turn flow's confirm/cancel handling shares one mechanism and vocabulary instead of several different ones.

### Problem Frame

The user hit this directly: creating a ticket in chat shows the new ticket's key as plain text, with no link to Jira — even though `@jira show`, search results, and comment references already render `[KEY](baseUrl/browse/KEY)` when `ticketSidekick.jira.baseUrl` is configured.

Tracing the codebase confirmed the exact shape of the gap. `TicketService`'s read methods (`getTicket`, `search`, the linked-issues formatter) all take `baseUrl` as a parameter and render a link. Its action methods — `createTicket`, `addComment`, `updateField` — do not: they return a bare-key confirmation string with no `baseUrl` awareness at all (`src/services/TicketService.ts:259,297,591`). Two other flows hit the identical gap independently and each wrote its own workaround — `emailHandler.ts` and `reportImportHandler.ts` both regex the key back out of `createTicket`'s plain-text result and rebuild a link themselves. A third, undocumented instance of the same workaround exists in `contentHandler.ts:123`, which regexes the key out of `createTicket`'s result to build the `<!-- @jira-ticket:KEY -->` marker. Planning also found two call sites that don't go through `TicketService` at all: the single-ticket field-update confirmation and the bulk field-update progress lines are both built inline in `JiraParticipant.ts` around direct `jiraClient.updateIssue`/`ticketService.bulkUpdateField` calls, and are bare-key today.

A parallel inconsistency exists in confirm/cancel handling. A shared word list (`isConfirmation`/`isCancellation` in `sessionState.ts`) is used by most flows (content preview, email import, bulk-update review's re-prompt path). But six flows each hand-roll a narrower, independent check instead of using it: template selection and issue-type selection (`c`/`cancel` only), filter selection (`c`/`cancel` only), the cleanup review screen's `parseSkipInput` (`ok`/`c`/`cancel` only), the bulk-update review screen's `parseBulkUpdateReview` (`/^(ok|yes|confirm)$/i` / `/^(c|cancel)$/i`), and the Veracode/Waltz review screen's `parseReviewInput` (`ok`/`c`/`cancel` only).

Dialogue surfaced a real collision this creates: the shared list treats a bare `skip` reply as cancel, but template selection already uses `skip` as an alias for "proceed without a template." The brainstorm resolved this by dropping `skip` as a no-template alias rather than carving out a permanent exception. Planning found the identical collision on a second word: `no` is both a `NO_TEMPLATE` alias and a member of the shared cancellation list. Resolved the same way, by dialogue during planning.

### Requirements

**Ticket linking**

- R1. Every chat message that names a ticket key links to Jira (`[KEY](baseUrl/browse/KEY)`) when `ticketSidekick.jira.baseUrl` is configured — covering ticket creation, adding a comment, updating a field (single-ticket and bulk), matching the pattern `getTicket`/search/linked-issues already use, regardless of whether the confirming call site routes through `TicketService` or builds its message inline.
- R2. When `baseUrl` is not configured, messages fall back to the bare key — unchanged from existing read-flow behavior.
- R3. The three existing call-site workarounds that reconstruct a link (or a key) from `createTicket`'s plain-text result (email import, Veracode/Waltz report import, the `contentHandler.ts` ticket-marker regex) are removed once the root method itself exposes the created key directly, so the logic lives in exactly one place.

**Confirm/cancel consistency**

- R4. Every multi-turn `@jira` flow that asks for confirmation or accepts cancellation recognizes the same word set through one shared mechanism, replacing the six separate implementations that exist today: `parseTemplateSelection`, `parseIssueTypeSelection`, `parseFilterSelection`, `parseSkipInput`, `parseBulkUpdateReview`, `parseReviewInput`.
- R5. Every confirm prompt displays "post it" as the suggested confirmation word, including every review/apply screen that currently suggests "ok"; "post" alone is also accepted, in addition to the existing accepted synonyms (which keep working). This includes the bulk-update-review and Veracode/Waltz-review screens, whose parsers (R4) must accept it for the wording to be honest.
- R6. `skip` and `no` are both removed as "no template" aliases, so both mean cancel everywhere with no flow-specific exception. Template selection's "proceed without a template" shortcut remains reachable via `n` / `none` / `no template` / `without template` / `0`.

### Key Decisions

- **Fix at the root, not at each call site — including call sites that bypass `TicketService` entirely.** `TicketService`'s action methods gain the same `baseUrl`-aware rendering its read methods already have; call sites that build their confirmation inline without going through `TicketService` (the single-ticket and bulk field-update paths) link the key inline instead, using the same `config.baseUrl ? [key](url) : key` pattern already used elsewhere in `JiraParticipant.ts`. Confirm/cancel parsing consolidates onto one shared mechanism across all six independent implementations. Governs R1, R3, R4. (session-settled: user-directed — the user chose the broadest linking scope offered, "everything that mentions a ticket key," over scoping the fix to just ticket creation.)
- **`skip` and `no` both drop as "no template" aliases.** `skip` was discovered as a collision during the brainstorm; `no` was discovered as the identical collision during planning, once the fix's own mechanism (`isCancellation`) exposed it. Both resolved the same way — removing the special case rather than documenting it as a permanent exception. Governs R6. (session-settled: user-directed, in two rounds: `skip` during the brainstorm, `no` during planning after the review surfaced it.)
- **The displayed confirm-word hint becomes "post it" everywhere, replacing "ok"; "post" is also accepted.** Governs R5. (session-settled: user-directed — chosen over keeping "ok" for review/apply screens and "post it" for content-generation screens as two separate displayed words.)

### Acceptance Examples

- AE1. **Covers R1.** When a user runs `@jira create ...` and confirms, the response shows the new ticket as `[KEY](baseUrl/browse/KEY)` instead of a bare key, when `baseUrl` is configured.
- AE2. **Covers R1.** When a user adds a comment, updates a field (single-ticket or bulk), the confirmation names the ticket(s) as a link, not bare text, under the same configuration.
- AE3. **Covers R4, R6.** When a user types `skip` or `no` during template selection, the ticket-creation flow cancels entirely — it no longer proceeds without a template.
- AE4. **Covers R5.** When a user is asked to confirm any review/apply screen (cleanup, bulk-update, Veracode/Waltz), the prompt suggests "post it" (not "ok"), and typing "post" alone also confirms.

### Success Criteria

- No chat message that names a ticket key omits a link when `baseUrl` is configured, regardless of which call site produces it.
- Confirm/cancel parsing in every multi-turn Jira flow is driven by one shared function and word set, not per-flow duplicated logic — including every screen R5 relabels.

### Scope Boundaries

- `@bitbucket`'s confirm/cancel already routes through the shared `isConfirmation`/`isCancellation` mechanism — untouched by this work.
- Only the confirm/cancel *recognition* layer and the displayed hint word change; other prompt wording (list formatting, section headers, selection syntax) is unchanged.
- Read-flow linking (`@jira show`, search, comment-list ticket references) already works today and is unchanged — it is the reference pattern this work extends to the action flows.

### Dependencies / Assumptions

- Assumes `ticketSidekick.jira.baseUrl` remains the single settings key gating link-vs-bare-key rendering, consistent with existing read flows.

### Sources / Research

- `src/services/TicketService.ts` — read methods (`getTicket:248`, `search:345`, linked-issues `formatIssueLinkLine:122`) already render `baseUrl`-aware links; action methods (`addComment:259`, `updateField:297`, `createTicket:591`) return bare-key strings with no `baseUrl` parameter. `updateField` is called only from `contentHandler.ts:136` (description-field content preview) — the single-ticket and bulk field-update paths below do not use it.
- `src/participant/jira/emailHandler.ts:349` (comment confirmation) and `:443-448` (create confirmation), `src/participant/jira/reportImportHandler.ts:420-422`, `src/participant/jira/contentHandler.ts:123` — the three existing regex-based workarounds (`extractCreatedKeyFromConfirmation` in `sessionState.ts:241`, and `contentHandler.ts`'s own inline regex for the `<!-- @jira-ticket:KEY -->` marker).
- `src/participant/JiraParticipant.ts:392-394` (single-ticket field update, calls `jiraClient.updateIssue` directly) and the adjacent `ticketService.bulkUpdateField(...)` callback (multi-ticket progress lines) — both bare-key, both bypass `TicketService.updateField` entirely. `src/participant/JiraParticipant.ts:798` — the literal-addComment call site, also bare. `src/participant/JiraParticipant.ts:751,779` — the existing `config.baseUrl ? [key](url) : key` inline pattern to mirror for the two call sites above.
- `src/participant/sessionState.ts:246-264` — the shared `isConfirmation`/`isCancellation` word lists.
- `src/participant/sessionState.ts:152-212` — `parseSkipInput`, `parseIssueTypeSelection`, `parseTemplateSelection` (`NO_TEMPLATE` set includes both `skip` and `no`).
- `src/participant/sessionState.ts:337-348` — `parseBulkUpdateReview` (used at `JiraParticipant.ts:510,1083`), `src/participant/sessionState.ts:591-604` — `parseReviewInput` (used via `reportImportHandler.ts:369`, hint text at `sessionState.ts:580`), `src/participant/sessionState.ts:350-362` — `parseFilterSelection` (used at `JiraParticipant.ts:182`-ish). All three are independent hand-rolled checks, found during plan review, not in the original brainstorm's three-implementation count.
- `src/participant/JiraParticipant.ts:411,510,1083`, `src/participant/jira/fieldHandler.ts:26`, `src/participant/jira/reportImportHandler.ts:369`, `src/participant/sessionState.ts:114,580` — every displayed "ok"-to-apply hint.

---

## Planning Contract

**Product Contract preservation:** Restructured during planning, no scope change — R1/R3/R4/R5/R6 were broadened to name call sites and parsers a code-review pass found that the original brainstorm's sampling missed (the single-ticket/bulk field-update paths, and three more hand-rolled parsers: `parseBulkUpdateReview`, `parseReviewInput`, `parseFilterSelection`). The brainstorm's core intent — "everything that mentions a ticket key" links, "every multi-turn flow" shares one confirm/cancel mechanism — already covered these; planning made the letter of the requirements match what the user already settled. AE1-AE4 kept their original IDs and core intent, broadened the same way. No requirement was narrowed, and no new product decision was needed except the `no`/template-selection collision, resolved the same way `skip` was.

### Key Technical Decisions

- KTD1. **`baseUrl` continues to thread through as a per-call parameter**, matching the existing convention `getTicket`/`search`/`formatIssueLinkLine` already use, rather than injecting it into `TicketService`'s constructor. `JiraParticipant.ts` already resolves `config.baseUrl` once per request and has it in scope at every call site this plan touches, so this extends an established pattern rather than introducing a new one. Governs R1.
- KTD2. **`createTicket`'s return type changes from a bare confirmation string to a structured value exposing the created key directly**, so every caller that needs the raw key (report import's batch loop, `contentHandler.ts`'s ticket-marker regex) reads it off a field instead of regexing it out of prose. `addComment`/`updateField` keep their existing `Promise<string>` shape. Governs R1, R3.
- KTD3. **One shared key-link formatter, reused everywhere a ticket key needs to become a link** — including `TicketService`'s three existing read-method call sites that currently each inline the same `baseUrl ? [key](url) : key` expression, and the two `JiraParticipant.ts` call sites that bypass `TicketService` entirely — rather than adding more inline copies. Governs R1.
- KTD4. **The single-ticket and bulk field-update confirmations stay inline in `JiraParticipant.ts`, linked directly, rather than being rerouted through `TicketService.updateField`.** They call `jiraClient.updateIssue`/`ticketService.bulkUpdateField` today and have their own error handling around that; rerouting them through `TicketService.updateField` would be a larger architectural change than this plan's scope, and the existing inline `config.baseUrl ? [key](url) : key` pattern (`JiraParticipant.ts:751,779`) is already the established way to link a key outside `TicketService`. Governs R1.

### Sequencing

U1 is a prerequisite for U2 and U3 (both depend on `TicketService`'s new signatures and `createTicket`'s new return shape). U4 and U5 are independent of U1-U3 and of each other — U5 depends on U4 covering `parseBulkUpdateReview` and `parseReviewInput` before U5's hint-text change to those two screens would be honest, so **U4 must land before or together with U5's changes to those two screens' hint text** (the rest of U5 is independent).

---

## Implementation Units

### U1. TicketService: baseUrl-aware action-method confirmations

**Goal:** `createTicket`, `addComment`, and `updateField` accept an optional `baseUrl` and render a linked key when it's present; `createTicket`'s return exposes the created key directly instead of only embedding it in prose; the `baseUrl ? [key](url) : key` pattern is deduplicated into one shared formatter, reusable outside `TicketService` too.

**Requirements:** R1, R2. Prerequisite for AE1, AE2.

**Dependencies:** None.

**Files:**
- `src/services/TicketService.ts` (modify)
- `src/test/TicketService.test.ts` (modify)

**Approach:**
1. Add an optional `baseUrl?: string` parameter to `addComment`, `updateField`, and `createTicket`.
2. Extract a small shared formatter — reused by `createTicket`, `addComment`, `updateField`, the three existing read-method call sites that currently each inline this pattern (`formatIssueLinkLine:122`, `getTicket:248`, `search:345`), and exported so `JiraParticipant.ts` can reuse it directly for the two call sites that bypass `TicketService` (KTD3, KTD4).
3. Change `createTicket`'s return type from `Promise<string>` to a small structured value carrying the created key and the formatted confirmation message (KTD2). Exact field names are an implementation detail.
4. `addComment`/`updateField` keep returning `Promise<string>`; the string itself is linked when `baseUrl` is passed, bare when it isn't (R2). `updateField`'s early-return "field not supported" message is unaffected — it never names the ticket key.

**Test scenarios:**
- `createTicket` with `baseUrl` set returns a message containing `[KEY](baseUrl/browse/KEY)` and exposes `KEY` as a field.
- `createTicket` with `baseUrl` absent returns the existing bare-key message unchanged, still exposing `KEY` as a field.
- `addComment`/`updateField` with `baseUrl` set return a linked message; with `baseUrl` absent, return the existing bare-key message unchanged.
- Edge case: `baseUrl` as an empty string behaves the same as absent, matching the `config.baseUrl ?? ''` fallback pattern used elsewhere.

**Verification:** `TicketService.test.ts` asserts the linked and unlinked message text and the exposed key field for `createTicket`/`addComment`/`updateField`.

### U2. Thread baseUrl into every interactive call site

**Goal:** Every place that confirms a create/comment/field-update in an interactive session — whether it routes through `TicketService` or builds its message inline — passes `config.baseUrl` through and shows a linked key.

**Requirements:** R1, R2, R3 (the `contentHandler.ts:123` regex). Covers AE1, AE2.

**Dependencies:** U1.

**Files:**
- `src/participant/jira/contentHandler.ts` (modify — `handleContentSession`)
- `src/participant/JiraParticipant.ts` (modify — literal-`addComment` call site; calls into `handleContentSession`; the single-ticket field-update confirmation at `:392-394`; the bulk field-update progress-line callback)
- `src/test/contentHandler.test.ts`, `src/test/JiraParticipant.test.ts` (modify)

**Approach:**
1. Add a `baseUrl?: string` parameter to `handleContentSession`; thread it into its three `ticketService.*` calls (createTicket, addComment, updateField-description). Update `JiraParticipant.ts`'s calls into `handleContentSession` to pass `config.baseUrl`.
2. In `handleContentSession`'s `createTicket` branch, replace the regex extraction of the key for the `<!-- @jira-ticket:KEY -->` marker (`contentHandler.ts:123`) with reading the key directly off `createTicket`'s new structured return (KTD2).
3. Update the literal-`addComment` call site (`JiraParticipant.ts:798`) to pass `config.baseUrl`.
4. At the single-ticket field-update confirmation (`JiraParticipant.ts:392-394`, which calls `jiraClient.updateIssue` directly), build the confirmation using the shared key-link formatter from U1 instead of the current unlinked `` `Updated **${previewSession.fieldName}** on ${toUpdate[0]}.` `` — matching the pattern already used at `JiraParticipant.ts:751,779` (KTD4).
5. At the bulk field-update progress callback passed to `ticketService.bulkUpdateField(...)`, link each key in the `✓ ${key}` / `✗ ${key}: ${err}` lines the same way (KTD4).

**Test scenarios:**
- Confirming ticket creation in the interactive preview flow with `baseUrl` configured shows a linked key, and the `<!-- @jira-ticket:KEY -->` marker still resolves to the correct key.
- Confirming an add-comment or description-update in the interactive preview flow with `baseUrl` configured shows a linked key.
- The literal-comment path (`@jira comment PROJ-1 "text"`) shows a linked key when `baseUrl` is configured.
- A single-ticket field update (via `@jira set field`) shows a linked key when `baseUrl` is configured.
- A bulk (multi-ticket) field update shows a linked key per ticket in its progress lines when `baseUrl` is configured.
- Regression: all of the above with no `baseUrl` configured render exactly as they do today.

**Verification:** Updated `contentHandler.test.ts` and `JiraParticipant.test.ts` assert linked-vs-bare-key text in each flow's final chat message, including the single-ticket and bulk field-update paths.

### U3. Remove the ad-hoc link workarounds; fix the email add-comment confirmation

**Goal:** `emailHandler.ts` and `reportImportHandler.ts` use `createTicket`'s exposed key directly instead of regexing it out of prose; `emailHandler.ts`'s separate add-comment confirmation also becomes linked, using `addComment`'s own returned message; the now-unused `extractCreatedKeyFromConfirmation` helper and its dedicated test are removed.

**Requirements:** R1, R3. Covers AE1, AE2.

**Dependencies:** U1.

**Files:**
- `src/participant/jira/emailHandler.ts` (modify)
- `src/participant/jira/reportImportHandler.ts` (modify)
- `src/participant/sessionState.ts` (modify — remove `extractCreatedKeyFromConfirmation`)
- `src/test/emailHandler.test.ts`, `src/test/reportImport.test.ts`, `src/test/JiraParticipant.test.ts` (modify)

**Approach:**
1. `emailHandler.ts`'s `finishEmailTicket`: pass `baseUrl` into `createTicket`, use its exposed key and message directly, delete the regex-and-rebuild `linkMsg` logic (`emailHandler.ts:443-448`).
2. `emailHandler.ts`'s email-to-comment confirmation (`emailHandler.ts:349-350`): pass `baseUrl` into `addComment` and display its returned message directly (replacing the current custom "Added comment to **KEY**." wording with `addComment`'s own linked confirmation) — one consistent source of truth for this message, matching how `contentHandler.ts` and `reportImportHandler.ts` already consume it.
3. `reportImportHandler.ts`'s batch-creation loop (`:420-422`): pass `baseUrl` into `createTicket`; read the created key from its exposed field instead of `extractCreatedKeyFromConfirmation`.
4. Remove `extractCreatedKeyFromConfirmation` from `sessionState.ts` and its dedicated test block in `JiraParticipant.test.ts`, once step 3 removes its only remaining caller.

**Test scenarios:**
- Finishing an email-to-ticket import with `baseUrl` configured shows a linked key.
- An email-to-comment import with `baseUrl` configured shows a linked key, using `TicketService`'s own confirmation wording.
- A Veracode/Waltz batch-creation progress line shows a linked key per created ticket, matching today's per-item summary format (`✓ [KEY](url) — summary`).
- Regression: all of the above with no `baseUrl` configured render the existing bare-key text (email-to-comment's wording changes regardless of `baseUrl`, per step 2 above — call this out in the PR description as a minor incidental wording change).

**Verification:** Updated `emailHandler.test.ts`/`reportImport.test.ts` assert linked-vs-bare-key text; `TicketService.test.ts`/`JiraParticipant.test.ts` no longer reference `extractCreatedKeyFromConfirmation`.

### U4. Unify confirm/cancel recognition

**Goal:** All six independent hand-rolled parsers — `parseTemplateSelection`, `parseIssueTypeSelection`, `parseFilterSelection`, `parseSkipInput`, `parseBulkUpdateReview`, `parseReviewInput` — recognize confirmation/cancellation through the shared `isConfirmation`/`isCancellation` mechanism instead of their own narrower checks; `skip` and `no` no longer mean "no template."

**Requirements:** R4, R6. Covers AE3. Prerequisite for R5's hint-text change on the bulk-update-review and Veracode/Waltz-review screens.

**Dependencies:** None.

**Files:**
- `src/participant/sessionState.ts` (modify)
- `src/test/JiraParticipant.test.ts` (modify)

**Approach:**
1. In `parseTemplateSelection`, replace the literal `c`/`cancel` check with `isCancellation(reply)`; remove both `skip` and `no` from the `NO_TEMPLATE` set (keep `n`, `no template`, `none`, `0`, `without template`).
2. In `parseIssueTypeSelection` and `parseFilterSelection`, replace each literal `c`/`cancel` check with `isCancellation(reply)`.
3. In `parseSkipInput`, replace the literal `ok` check with `isConfirmation(reply)` and the literal `c`/`cancel` check with `isCancellation(reply)`, before falling through to its existing ticket-number parsing.
4. In `parseBulkUpdateReview`, replace its `/^(ok|yes|confirm)$/i` and `/^(c|cancel)$/i` regex checks with `isConfirmation(reply)`/`isCancellation(reply)`, before falling through to its existing `skip KEY1 KEY2` parsing.
5. In `parseReviewInput`, replace its literal `ok`/`c`/`cancel` checks with `isConfirmation(reply)`/`isCancellation(reply)`, before falling through to its existing row-id toggle parsing.

**Test scenarios:**
- Typing a word from the shared cancellation set (e.g. `stop`, `abort`, `never mind`) during template selection, issue-type selection, filter selection, the cleanup review, the bulk-update review, and the Veracode/Waltz review all cancel — not just literal `c`/`cancel`.
- Typing `skip` or `no` during template selection now cancels the whole ticket-creation flow (AE3), not "proceed without a template."
- `n` / `no template` / `none` / `0` / `without template` still proceed without a template during template selection.
- Regression: numeric/name selection, the cleanup review's ticket-number skip syntax (`skip 11 14`), the bulk-update review's `skip KEY1 KEY2` syntax, and the Veracode/Waltz review's row-id toggle syntax all behave unchanged — none of those phrases exact-match a single cancellation/confirmation word.

**Verification:** Updated `JiraParticipant.test.ts` cases for all six parsers cover the shared-word acceptance and the `skip`/`no` behavior change.

### U5. Unify the displayed confirm word

**Goal:** Every confirm prompt in a multi-turn `@jira` flow suggests "post it" instead of "ok"; "post" alone is added to the accepted confirmation words.

**Requirements:** R5. Covers AE4.

**Dependencies:** For the bulk-update-review and Veracode/Waltz-review screens specifically, depends on U4 (their parsers must accept "post"/"post it" before their hint text can honestly say so). The rest of this unit is independent.

**Files:**
- `src/participant/sessionState.ts` (modify — `CONFIRMATIONS` set, cleanup-review footer string, Veracode/Waltz-review footer string)
- `src/participant/JiraParticipant.ts` (modify — hint text at the field-update-preview and bulk-update-review prompts)
- `src/participant/jira/fieldHandler.ts` (modify — hint text)
- `src/participant/jira/reportImportHandler.ts` (modify — hint text)
- `src/test/JiraParticipant.test.ts` (modify)

**Approach:**
1. Add `post` to the `CONFIRMATIONS` set in `sessionState.ts`.
2. Replace every "Reply **ok** to apply/proceed, …" hint string with "Reply **post it** to apply/proceed, …" — `JiraParticipant.ts:411,510,1083`, `fieldHandler.ts:26`, `reportImportHandler.ts:369`, `sessionState.ts:114,580`.

**Test scenarios:**
- `isConfirmation('post')` and `isConfirmation('post it')` both return true.
- Replying `post` alone confirms every review/apply screen: cleanup review, field-update preview, bulk-update review, Veracode/Waltz review (AE4).
- Regression: `ok` and the other existing synonyms still confirm every screen — nothing removed from the accepted set.

**Verification:** Updated `JiraParticipant.test.ts` assertions cover the new accepted word and the updated hint text on every screen.

---

## Verification Contract

| Unit | Verification | Repo command |
| --- | --- | --- |
| U1 | Linked/unlinked message text and exposed key field, for createTicket/addComment | `npm test -- TicketService` |
| U2 | Linked key in interactive create/comment/single-ticket-field/bulk-field confirmations | `npm test -- contentHandler JiraParticipant` |
| U3 | Linked key in email and report-import confirmations; `extractCreatedKeyFromConfirmation` fully removed | `npm test -- emailHandler reportImport JiraParticipant TicketService` |
| U4 | Shared cancel-word acceptance across all six parsers; `skip`/`no` cancel instead of skipping the template | `npm test -- JiraParticipant` |
| U5 | `post`/`post it` accepted on every review/apply screen; hint text updated | `npm test -- JiraParticipant` |
| All | Full suite green, no regressions | `npm run compile && npm test` |

## Definition of Done

- Every chat message naming a ticket key is linked when `baseUrl` is configured, across all call sites in U1-U3, including the two that bypass `TicketService`.
- No call site regexes a key back out of a `createTicket` confirmation string — `extractCreatedKeyFromConfirmation` and `contentHandler.ts`'s own regex are both removed.
- All six independent parsers recognize the shared confirm/cancel word set; `skip` and `no` both cancel everywhere.
- Every confirm-prompt hint string says "post it"; `post` and all existing synonyms are accepted on every screen it appears on.
- `npm run compile` and `npm test` pass.
- No leftover dead code or unused imports from the removed workarounds.
