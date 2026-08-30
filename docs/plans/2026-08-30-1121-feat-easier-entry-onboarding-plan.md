---
title: "Easier Entry Onboarding - Plan"
type: feat
date: 2026-08-30
topic: easier-entry-onboarding
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Easier Entry Onboarding - Plan

## Goal Capsule

- **Objective:** A first-time user of `@jira`/`@bitbucket` can discover what the extension can do and successfully complete a first ticket and a first PR review without needing to read the README first.
- **Means:** Add a Getting-Started walkthrough, Language Model tools, slash commands, follow-up suggestions, `disambiguation` metadata, and a friendlier first-touch fallback — layered onto the existing natural-language-routed architecture for both participants.
- **Product authority:** Every new entry point (tools, slash commands) stays a shortcut into the existing intent-routed flows, never a parallel mechanism a user has to learn separately; every write stays behind an explicit confirmation. This plan owns the discoverability/onboarding cluster only — the issue-type-guessing fix and the template-generation-from-a-ticket feature are separate plans (see How This Work Fits Together).
- **Open blockers:** Implementation should not start until two prerequisites are complete, not just planned: (1) the issue-type-guessing fix (`docs/plans/2026-08-30-1029-fix-never-guess-issue-type-plan.md`), and (2) a template-generation-from-a-ticket feature, which has not yet been brainstormed or planned.

---

## Product Contract

### Summary

Adds a cluster of discoverability mechanisms to both `@jira` and `@bitbucket`: Language Model tools usable from plain Agent Mode, slash commands and follow-up suggestion chips on the existing chat flows, `disambiguation` metadata, a friendlier first-touch response when a prompt can't be understood, and a Getting-Started walkthrough that ends in a real first ticket and a real first PR review.

### Problem Frame

Today, everything the extension can do lives only in the README. Neither `@jira` nor `@bitbucket` defines slash commands, `disambiguation` metadata, or follow-up suggestions in `package.json`, and there's no `contributes.walkthroughs` entry — a new user's only path to discovering commands is reading external documentation before ever opening chat.

The two participants are also asymmetric today: `@bitbucket` already responds to a bare `@bitbucket` with a concrete example and a `check` hint, while `@jira` routes everything through its LLM intent parser and, when that parser can't classify the prompt, prints the literal string `"Unrecognised operation."` with no guidance — exactly the moment a lost first-timer is most likely to hit.

Separately, VS Code's Language Model Tools API (`contributes.languageModelTools`) lets an extension's operations be called directly by Copilot Agent Mode, without the user ever invoking `@jira`/`@bitbucket` — a second entry point this extension doesn't use at all today.

### Requirements

**Language Model tools**

R1. Jira and Bitbucket read operations (get/show a ticket, search, a PR review, etc.) are available as Language Model tools that Agent Mode can call directly, without the user invoking `@jira`/`@bitbucket`.

R2. Jira and Bitbucket write operations (create/update a ticket, post a PR comment, etc.) are also available as tools, but each write shows its own confirmation naming the concrete change about to be made before it executes — a tool call never writes silently.

R3. Tool operations reuse the same underlying service logic — and its existing safeguards, such as never guessing an issue type — as the `@jira`/`@bitbucket` chat flows use today; there is no separate, divergent implementation of the same operation for tools.

R4. When a tool is called and credentials aren't configured, it returns a clear, actionable result naming the missing setup step instead of a raw error — the same information `@jira`'s and `@bitbucket`'s existing "not configured" chat messages give, in a form Agent Mode can relay to the user.

**In-chat discoverability**

R5. Both `@jira` and `@bitbucket` gain a slash command for each major capability, shown in the participant's own autocomplete. Every slash command remains a shortcut into the existing natural-language-routed flow — never a separate mechanism a user must learn on its own.

R6. Both participants offer follow-up suggestion chips after every major response, proposing a likely next action (e.g. after loading a ticket: add a comment, transition it; after a PR review: add findings to review, ask about a finding).

R7. Both participants declare `disambiguation` metadata (category, description, example prompts) so Copilot can route ambiguous prompts and surface real usage examples.

R8. When `@jira` receives a prompt it cannot classify, it no longer shows the bare `"Unrecognised operation."` message — it shows a helpful, example-driven message instead, mirroring `@bitbucket`'s existing no-PR-URL guidance.

R9. Both participants detect an empty invocation or an obvious greeting/help-shaped prompt (e.g. "help", "hi", "what can you do") before attempting to classify it as a real command, and respond with orientation instead of routing it through the LLM intent parser.

**Getting-Started walkthrough**

R10. A VS Code Getting-Started walkthrough introduces the extension: Jira base URL and credentials, a default project, and that project's ticket types/workflow, ending with creating a first ticket using the project's real template-generation capability (per the prerequisite in Goal Capsule).

R11. The walkthrough includes a parallel Bitbucket track: credentials setup and a first PR review.

R12. Each walkthrough step links to (or runs) the real command/setting it describes, and marks itself complete only when that action actually happened — never a static checklist disconnected from the extension's real state.

### Key Decisions

- **Every write-capable tool call shows its own confirmation naming the concrete change, never silent.** (session-settled: user-directed — chosen over read-only-only tools or skipping tools entirely: read+write tools were wanted, with the same safety bar `@jira`'s existing create-preview flow already has.) Governs R2.
- **Extend, don't replace.** Slash commands and tools funnel into the same natural-language-routed operations the existing architecture already has — no user is required to learn a new mechanism to keep working the old way. Governs R3, R5.
- **Follow-ups roll out to every major response, not a narrow starting set.** (session-settled: user-directed — chosen over starting with just the two highest-traffic flows: broader day-one consistency preferred over incremental rollout.) Governs R6.
- **Build order is a prerequisite, not a parallel track.** This plan depends on the issue-type-guessing fix and a template-generation-from-a-ticket feature landing first, so the walkthrough's final step can use their real, finished behavior rather than a stand-in. (session-settled: user-directed — chosen over shipping the walkthrough first with a stand-in step: a consistent end state was wanted over incremental shipping.) Governs R10.
- **Both participants get identical treatment.** Tools, slash commands, follow-ups, disambiguation, and a walkthrough track apply to `@bitbucket` exactly as they do to `@jira`, rather than `@jira` first with parity later. (session-settled: user-directed.) Governs R1, R5, R6, R7, R11.

### Actors

- A1. A new or infrequent user of `@jira`/`@bitbucket` who doesn't yet know the extension's commands or setup steps.
- A2. Copilot Agent Mode, which can call registered tools autonomously while completing an unrelated task.
- A3. The Jira and Bitbucket APIs — source of real data and target of writes, reached the same way for both chat flows and tools.

### Key Flows

- F1. **Tool call, read or write**
  - **Trigger:** Agent Mode (or a `#toolname` reference) invokes a Jira or Bitbucket tool.
  - **Actors:** A1, A2, A3
  - **Steps:** The tool checks credentials are configured; if not, it returns the actionable "not configured" result (R4) instead of calling the API. If configured and the operation writes, VS Code shows the tool's confirmation naming the concrete change (R2) before it runs. Either way, execution goes through the same service logic the chat flows already use (R3).
  - **Outcome:** A1 either sees a clear setup prompt, a concrete confirmation before a write, or a read result — never a silent write or a raw error.
  - **Covers:** R1, R2, R3, R4

- F2. **First-touch orientation**
  - **Trigger:** A1 sends `@jira` or `@bitbucket` an empty, greeting-shaped, or unclassifiable prompt.
  - **Actors:** A1
  - **Steps:** An empty or greeting-shaped prompt (R9) is recognized before any LLM call and answered with orientation directly. Anything else still goes to the intent parser; only if that returns no usable operation does the example-driven fallback (R8) fire.
  - **Outcome:** A1 never sees a bare, unexplained error on their first message.
  - **Covers:** R8, R9

- F3. **Getting-Started walkthrough**
  - **Trigger:** A1 opens the walkthrough (auto-shown on install, or from VS Code's Get Started page).
  - **Actors:** A1
  - **Steps:** Jira track — base URL → credentials → default project → that project's ticket types/workflow → create a first ticket via the real template-generation capability. Bitbucket track (R11) runs in parallel — credentials → a first PR review. Each step completes itself once its real action happens (R12), not on a manual checkbox.
  - **Outcome:** A1 reaches one real, working ticket and one real, working PR review without leaving VS Code's own UI.
  - **Covers:** R10, R11, R12

### Acceptance Examples

- AE1. **Given** Agent Mode calls a Jira "create ticket" tool, **when** the tool is about to execute, **then** the user sees a confirmation naming the concrete ticket (project, type, summary) before anything is written to Jira. Covers R2.
- AE2. **Given** credentials are not configured, **when** Agent Mode calls any Jira or Bitbucket tool, **then** the tool's result names the missing setup step instead of a raw connection/auth error. Covers R4.
- AE3. **Given** a prompt `@jira` genuinely cannot classify (not empty, not a greeting), **when** the intent parser returns no usable operation, **then** the response shows concrete example prompts instead of `"Unrecognised operation."`. Covers R8.
- AE4. **Given** a bare `@jira` or a greeting like "hi"/"help", **when** the user sends it, **then** the response orients them without ever calling the LLM intent parser. Covers R9.
- AE5. **Given** the walkthrough's ticket-types/workflow step, **when** the user completes the action it points at, **then** that step is marked done automatically — not left for the user to check off by hand. Covers R12.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan owns the discoverability/onboarding cluster (Language Model tools, slash commands, follow-ups, disambiguation, first-touch fallback, walkthrough) for both `@jira` and `@bitbucket`. It is sequenced after two prerequisites:

- Never-guess-issue-type fix — `docs/plans/2026-08-30-1029-fix-never-guess-issue-type-plan.md`
  - Enables this plan's walkthrough, whose final step creates a real ticket and must not silently guess a type
  - Build order: implement before this plan
- Template-generation-from-a-ticket feature (not yet brainstormed or planned)
  - Enables this plan's walkthrough final step, which uses the real capability instead of a stand-in
  - Still to decide: its own requirements — needs its own brainstorm before it can be built
  - Build order: implement before this plan; order relative to the issue-type-guessing fix is not fixed by this plan

### Scope Boundaries

- Deferred for later: the template-generation-from-a-ticket feature itself (suggesting a template from an existing ticket, guided field-visibility configuration) — its own follow-up plan, see How This Work Fits Together.
- Outside this plan: the issue-type-guessing fix's own requirements — already a separate, complete plan.

### Outstanding Questions

- **Deferred to Planning:** Exact wording, icons, and tags for slash commands, and the tool metadata shape (`modelDescription`, `inputSchema` per operation) — settled once the VS Code API specifics are being wired up.
- **Deferred to Planning:** The relative build order between the two prerequisite items (issue-type fix vs. template-generation) — this plan only requires both precede it, not their order relative to each other.

### Sources / Research

- `docs/plans/2026-08-30-1029-fix-never-guess-issue-type-plan.md` — prerequisite plan (see How This Work Fits Together).
- `docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md` — the pattern R3 requires tools to reuse.
- VS Code Chat Participant API guide (`commands`, `disambiguation`, follow-ups): https://code.visualstudio.com/api/extension-guides/ai/chat
- VS Code Language Model Tool API guide (`contributes.languageModelTools`, `prepareInvocation`/confirmation messages): https://code.visualstudio.com/api/extension-guides/ai/tools
- VS Code Walkthroughs guide and `contributes.walkthroughs` reference: https://code.visualstudio.com/api/ux-guidelines/walkthroughs , https://code.visualstudio.com/api/references/contribution-points#contributes.walkthroughs
- Verified in this repo: `package.json`'s `contributes.chatParticipants` block (no `commands`, `disambiguation`, or follow-up wiring today); `src/participant/JiraParticipant.ts:1099-1100` (bare `"Unrecognised operation."` fallback); `src/participant/JiraParticipant.ts:52,69` (existing "not configured" messages); `src/participant/BitbucketParticipant.ts:550-557` (existing no-PR-URL guidance); `src/templates/TemplateService.ts` and README's "Templates and cleanup rules" section (templates are hand-authored JSON only, no generation flow today).
