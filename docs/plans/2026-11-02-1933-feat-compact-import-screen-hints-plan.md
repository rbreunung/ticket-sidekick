---
title: Compact Import Screen Hints - Plan
type: feat
date: 2026-11-02
topic: compact-import-screen-hints
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Compact Import Screen Hints - Plan

## Goal Capsule

- **Objective:** A user reviewing a Veracode, Waltz or email import sees the typed commands a screen offers in one glance (the rest are explained in `help`), can find a command such as `search` without the manual, and gets the longer explanation only when asking for it. The accept words say what they hide.
- **Product authority:** The requesting user (rbreunung); decisions marked `session-settled` are theirs.
- **Open blockers:** None.

---

## Product Contract

### Summary

Every import review screen keeps its clickable primary actions and replaces the stacked hint paragraphs with one grouped `Commands:` line that lists only what that screen accepts for that importer. A `help` reply or link prints the full explanations for the current screen once. Paging controls show only for directions that exist. `accept` is renamed `accept CVE`, and a bare `accept` writes nothing.

### Problem Frame

The New screen can show up to seven full-sentence hint paragraphs (include/exclude, merge and add, accept, accept component, paging, create, exit), and every new command adds another. The cost showed up the other way too: `search` shipped in PR #103 and no screen mentions it, so it only appears after a wrong reply or after `search` or `export` has already been used.

The accept words add a second problem. `accept` hides CVEs on the New screen only, and `accept component` hides a whole component at a version, which also removes it from Already ticketed and proposes closing its open ticket. Both persist to `.jira-oss-accepted.json`, and the short spelling is the less used one.

### Key Decisions

- **Compact by default; `help` prints the long text once and nothing sticks.** (session-settled: user-directed — chosen over a sticky `help off` toggle and over full text by default: "always collapsed except when I type/click help, then it once prints the longer help".) Governs R1, R6.
- **Existing click actions stay; only the explanatory sentences are compressed.** (session-settled: user-approved — chosen over folding links and commands into one strip, and over links-only: clicking stays the fast path and the strip is the reminder.) Governs R1.
- **`accept` becomes `accept CVE`.** (session-settled: user-directed — chosen over keeping `accept`: component is the case the user uses, and the word should name its effect.) Governs R9, R11.
- **Bare `accept <rows>` writes nothing and shows both spellings.** (session-settled: user-approved — chosen over an alias for CVE and over making bare `accept` mean component: acceptance is a persistent write and the two kinds differ in effect.) Governs R10.
- **The pattern is any screen that lists typed commands.** (session-settled: user-directed — chosen over report-import screens only: "every screen following the pattern".) Applied here to the import screens, their add and merge prompts and the email cleanup preview. One-line choice prompts do not stack hints and stay as they are. Governs R12.
- **Paging controls show only for directions that exist.** (session-settled: user-directed — requested after the first examples.) Governs R4.

### Requirements

**Screen layout**

- R1. Each in-scope screen keeps its clickable primary actions and shows one `Commands:` line, grouped by purpose and ending with a clickable `help`, in place of the explanatory hint paragraphs.
- R2. The `Commands:` line lists only commands the screen accepts for that importer: `search` on New and Already ticketed for Veracode and Waltz and not for email, the accept words for Waltz only.
- R3. A command that takes arguments appears as its bare name in the line, and `help` gives the syntax.
- R4. `next` shows only when a later page exists and `prev` only when an earlier one exists. `page <n>` shows only with three or more pages. A single page shows no paging control. These words are the existing clickable controls on the page line beside the primary actions, not part of the `Commands:` line, and `help` explains them. The words stay valid at the boundary and answer that the user is on the first or last page, changing nothing.
- R5. The strip, `help` and the "didn't understand" reply come from one list of commands per screen, so they cannot disagree with each other or with what the screen accepts.

**Help and discoverability**

- R6. `help`, as a reply or a click, prints the full explanation for the current screen once, giving each command's syntax and effect. It leaves the session unchanged and the next screen is compact again.
- R7. The "didn't understand" reply names the input it did not recognize and points to `help` instead of repeating its own vocabulary line.
- R8. `search` is listed on New and Already ticketed for Veracode and Waltz and explained in `help`. `show` is explained in `help` only.

**Accept words**

- R9. `accept CVE <rows>` hides those rows' CVEs exactly as `accept <rows>` does today, including the optional `because …` reason and the New-screen-only effect. It is case-insensitive.
- R10. A bare `accept <rows>` records nothing and answers with the two spellings, `accept CVE <rows>` and `accept component <rows>`.
- R11. `accept component`, `accepted`, `unaccept` and the Remove links keep their current words and behavior.

**Coverage and guards**

- R12. The compact line and `help` apply to the overview, New, Already ticketed and Stale screens and the email cleanup preview. The add and merge prompts show a single `help` link instead of the full line.
- R13. The user manual and README tables describe the `Commands:` line, `help`, `search`, `show` and the new accept words.
- R14. A test fails when a command a screen's reply parser accepts appears in neither that screen's `Commands:` line nor its `help` text, or when the line lists a command the parser rejects.

### Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given a Waltz import with three pages of new rows, when page 1 shows, the screen shows `next` and `page 3`, no `prev`, and a `Commands:` line with `search`, `accept CVE` and `accept component`. A Veracode import shows no accept words. An email import shows no `search`.
- AE2. **Covers R6.** When the user replies `help` on the New screen, the full text for that screen prints once, and the next screen shows the compact line again.
- AE3. **Covers R10.** When the user replies `accept 2 4`, nothing is written to `.jira-oss-accepted.json` and the reply shows both spellings.
- AE4. **Covers R4.** When the user replies `next` on the last page, the reply says it is the last page and the session is unchanged.
- AE5. **Covers R7.** When the user replies `2x` on the New screen, the reply names `2x` as not understood and links to `help`.
- AE6. **Covers R9.** When the user replies `accept cve 2 because not reachable`, row 2's CVEs are accepted with that reason, as `accept 2 because not reachable` does today.

### Success Criteria

- A user who has never seen `search` finds it from the New or Already ticketed screen without opening the manual.
- The default New screen drops from up to seven hint paragraphs to one `Commands:` line beside its existing click actions.

### Scope Boundaries

Deferred for later:

- A VS Code setting for the default hint style.
- A sticky help mode.
- Searching Jira beyond the tickets the review already matched.
- Renaming `unaccept`.

Outside this plan:

- Changing what any command does, other than the accept rename.
- The one-line choice prompts in ticket creation, template generation, field disambiguation and bulk cleanup, and the PR review follow-ups. Their `Reply` occurrences were single-choice lines when this plan was written; revisit if one starts stacking hints.

### Dependencies / Assumptions

- Builds on the `search`, `show` and `merge … into` replies from PR #103 (`docs/plans/2026-10-24-1051-feat-import-ticket-search-plan.md`).
- The accepted-list file format and stored sessions do not change, and no chat link sends the bare `accept` word today.
- The email cleanup preview's current commands (`model check`, `skip model`, a row number, `save <n>`) are taken from `docs/manual/report-imports.md` and still have to be checked against the code.

### Outstanding Questions

#### Deferred to Planning

- The exact group labels and wording of each screen's `Commands:` line.
- How the email cleanup preview's commands map onto the shared line.

### Sources / Research

- Current hint paragraphs: `src/participant/session/importScreens.ts` (New screen hints around lines 300-330, `groupScreenExitLine`, `buildSearchFollowUp`).
- Current vocabulary lines and accept parsing: `src/participant/session/importReplies.ts` (`describeImportReplyVocabulary`, `parseAcceptReply`, `parseAcceptComponentReply`).
- Screen options that gate hints: `src/participant/jira/importReviewScreen.ts` and `ImportScreenOptions` in `importScreens.ts`, which have `canFold`, `canAccept`, `canMergeTickets` and `canExport` but no search option.
- Behavior and user wording: `docs/report-import.md` ("search and show", accepted CVEs and components) and `docs/manual/report-imports.md`.
