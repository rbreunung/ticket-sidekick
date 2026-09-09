---
title: "Make Language Model Tools Available on VS Code Startup"
date: 2026-09-09
type: plan
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
---

## Goal Capsule

- **Objective:** Make the `@jira` and `@bitbucket` Language Model tools appear in VS Code without requiring the user to send the first chat message.
- **Means:** Activate the extension on startup so `activate()` runs and sets the credential context keys.
- **Authority:** This plan owns only the tool-availability trigger. The gate that decides *which* tools are shown is unchanged.
- **Stop conditions:** Tools are registered on startup and still hidden until credentials are configured; `npm run compile` and `npm test` are green.
- **Tail:** ce-plan for the implementation; commit message follows the repo convention.

## Product Contract

### Summary

The `@jira` and `@bitbucket` tools are declared in `package.json` but hidden until the first chat message, because the extension only activates on a chat/deep-link event and the tool gate (`when: "ticketSidekick.jiraCredentialsSet"`) is set inside `activate()`. This work adds an activation event so the extension loads shortly after VS Code starts, letting the existing context-key logic run and expose the tools immediately.

### Problem Frame

The tools carry `when: "ticketSidekick.jiraCredentialsSet"` in `package.json`. That context key is written by `activate()` in `src/extension.ts` via `setContext`, which reads the real config (base URL **and** token). The extension's only activation event is `["onUri"]`, so `activate()` does not run until the first chat message fires the auto-generated `onChatParticipant` event. Until then the key is false and VS Code silently filters the tools out of the manifest. The user therefore sees no tools until they have already committed to a chat turn — the exact moment the tools would be most useful.

### Key Decisions

- **Activate on startup via `onStartupFinished`, keep the full base-URL + token gate.** Chosen over a settings-only `when` clause (which cannot verify the secret token and would show tools with only a base URL set). `(session-settled: user-directed — chosen over settings-only `when` clause: the token gate is the only place both credentials are verified together, and it is a deliberate security boundary)` Governs R1.
- **One-line change only.** The fix is a single entry in `activationEvents`; no change to the gate logic, the `setContext` mechanism, or the secret-change listeners. `(session-settled: user-directed — chosen over a broader refactor: the change is already minimal and well-bounded)`

### Requirements

**Tool availability**

- R1. The `@jira` and `@bitbucket` tools are registered and visible on VS Code startup, without the user sending any chat message.
- R2. Tools remain hidden until `ticketSidekick.jiraCredentialsSet` is true — i.e. base URL **and** token are both configured for the relevant participant.

**Behavior preservation**

- R3. Deep links (`onUri`) continue to activate the extension exactly as before.
- R4. The secret-change listeners still update the context keys live when a token is set or cleared.
- R5. `activate()` makes no network calls at activation, so the startup cost is limited to the extension being resident.

### Scope Boundaries

- **In scope:** the `activationEvents` array in `package.json` only.
- **Out of scope:** any change to the gate logic, the `when` clauses, the `setContext` mechanism, the participant chat flows, the walkthroughs, or the `bitbucketCredentialsSet` context key. The Bitbucket participant is covered by the same mechanism as Jira but is not separately changed.

## Planning Contract

- `package.json` — add `"onStartupFinished"` to `activationEvents` alongside `"onUri"`.
- Verify `src/extension.ts` `activate()` still sets both context keys on load (it does today; the change does not touch it).
- No new files, no new dependencies.

## Verification Contract

- `npm run compile` passes.
- `npm test` passes.
- Manual EDH check: open VS Code with Jira configured, open a chat, and confirm the `@jira` tools are listed without a prior chat message. Repeat with Jira unconfigured and confirm the tools are absent.

## Definition of Done

- `activationEvents` includes `"onStartupFinished"`.
- Tools appear on startup when configured and stay hidden when not.
- Compile and tests are green.
- Commit message describes the change and references the root cause (tools gated on a context key only set inside `activate()`).
