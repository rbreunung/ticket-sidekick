---
title: Load Ticket Entry-Point Parity - Plan
type: feat
date: 2026-09-02
topic: load-ticket-parity
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Load Ticket Entry-Point Parity - Plan

## Goal Capsule

- **Objective:** A user — whether typing to `@jira` chat or working through Copilot Agent Mode — can load a ticket's full context (description, comments, attachments) into the local workspace, and gets an accurate result either way, never a false success claim when nothing was actually written.
- **Means:** Add a `/load` slash command to `@jira` chat and a `jira_loadTicket` language-model tool for Agent Mode, both wired to the load-into-folder capability that already exists and works today via loose natural-language phrasing to `@jira`.
- **Product authority:** User-directed (this conversation).
- **Open blockers:** None.

---

## Product Contract

### Summary

Add two new entry points to the existing "load a ticket's context into `.jira-context/<KEY>/`" capability — a `/load` slash command on `@jira` chat, and a `jira_loadTicket` Agent Mode tool — so the capability is reachable the same way every other core Jira operation already is, instead of only through natural-language phrasing that Agent Mode never sees at all.

### Problem Frame

`@jira` can already load a ticket's description, comments, and attachments into the workspace, but only via natural-language phrasing typed directly to `@jira` chat — it has no `/load` slash command, unlike `view`, `comment`, `field`, `move`, `search`, and `create`. Copilot Agent Mode does not go through `@jira` chat routing at all; it only sees the fixed set of registered `jira_*` language-model tools, and no tool for this capability exists.

The practical consequence: a user working in Agent Mode says "load it," the model has no tool that can write anything, and it responds with a plain-language claim ("Loaded VSJI-38 from Jira") that sounds like success but performed no write — no folder, no files. The user has no way to tell, from the response alone, that the load never happened.

### Requirements

**Chat command**

- R1. `@jira` gains a `/load` slash command, taking a ticket key the same way `/view` does, that performs the same load-into-folder behavior available today via natural-language phrasing.
- R2. Existing natural-language "load" phrasing to `@jira` chat continues to work unchanged.

**Agent Mode tool**

- R3. A `jira_loadTicket` language-model tool is added, taking `ticketKey` as required input, producing the same ticket/comments/attachments folder output that `@jira load` produces today.
- R4. Before running, the tool declares an explicit confirmation naming the ticket key and the target folder, so a load is never silent.
- R5. The tool validates its inputs independently inside its `invoke()` step rather than relying on the confirmation dialog having been seen (a user's auto-approve setting can skip it).
- R6. When no workspace folder is open, the tool reports that a folder must be open and writes nothing, rather than erroring unrecognizably or claiming success.

**Documentation**

- R7. `docs/onboarding.md`'s Jira tool table lists `jira_loadTicket`, and its "every core Jira read/write operation is also exposed as a tool" claim is accurate again.

### Key Decisions

- **Cover both the chat and Agent Mode surfaces, not just one.** Governs R1, R3. (session-settled: user-directed — chosen over shipping the tool alone or the slash command alone: full entry-point parity was preferred, matching how every other core operation already works both ways.)
- **Treat the tool as a write tool requiring explicit confirmation.** Governs R4, R5. (session-settled: user-directed — chosen over running it unconfirmed like a read tool: it writes multiple files to the user's workspace disk even though it never touches Jira, which was judged to deserve the same visibility every other write tool gets.)
- **Reuse the existing load behavior unchanged on both new entry points.** Governs R1, R3. This closes an access gap, not a behavior change — what gets downloaded, filtered, or written to `.jira-context/` is untouched.
- **No-workspace-folder case fails gracefully, mirroring the existing chat message, rather than a raw error or a silent no-op.** Governs R6.

### Acceptance Examples

- AE1. **Covers R1.** Given the user types `/load VSJI-38` in `@jira` chat, when the command runs, then the ticket, its comments, and its attachments land in `.jira-context/VSJI-38/`, identical to today's natural-language "load VSJI-38" result.
- AE2. **Covers R4.** Given `jira_loadTicket` is invoked with `ticketKey: "VSJI-38"`, when the tool is about to run, then the confirmation names `VSJI-38` and the target folder before anything is written.
- AE3. **Covers R6.** Given no folder is open in the workspace, when `jira_loadTicket` is invoked, then the response states that a folder must be open, and no files are written.

### Scope Boundaries

- Deferred: changing what gets downloaded or how it's filtered (attachment eligibility, size limits, `.jira-context/` layout) — untouched by this work.
- Deferred: loading multiple tickets in a single call.
- Outside this work's identity: fixing Agent Mode's general tendency to narrate an action as done when no tool exists for it — that is model/host behavior, not something this extension controls. This plan closes the specific gap that caused it here.

---
