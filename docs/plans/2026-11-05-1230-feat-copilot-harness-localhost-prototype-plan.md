---
title: "Copilot Harness Localhost Prototype - Plan"
type: feat
date: 2026-11-05
topic: copilot-harness-localhost-prototype
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Copilot Harness Localhost Prototype - Plan

## Goal Capsule

- **Objective:** On a managed machine, a user in a Copilot-harness chat session can read and write Jira through Ticket Sidekick, and work on a canvas board, with the extension's localhost server meeting every security rule of decisions D1–D5. Each open prototype check is answered with evidence, so the migration direction is either confirmed or a named decision is reopened.
- **Means:** a throw-away prototype inside the existing extension: one localhost server that serves an MCP endpoint (with one MCP App) and a canvas page, plus a small canvas launcher. Settled in [`docs/architecture/copilot-harness-migration.md`](../architecture/copilot-harness-migration.md) §6.6 and §11.
- **Product authority:** this Product Contract and decisions D1–D5 in the architecture doc's decision log. The full migration (session engine, all flows, participant retirement) is not active scope.
- **Open blockers:** none for planning. Running the prototype needs a managed machine and a Jira test project (see Dependencies / Assumptions).

---

## Product Contract

### Summary

Build a minimal, unreleased slice of the decided architecture: the VS Code extension runs one key-protected HTTP server on `127.0.0.1`. That server serves an MCP endpoint the Copilot harness uses, one MCP App, and a canvas board page found through an opt-in canvas launcher. The prototype exists to answer the four checks the architecture doc left open, and to show that the security rules hold in practice.

### Problem Frame

Chat participants are deprecated and unsupported in the Copilot harness, so `@jira` and `@bitbucket` only work while the Local harness is allowed. The architecture discussion settled the direction (D1–D5), but four facts could only be guessed from source: whether the Agent Host persists the forwarded MCP key, whether a managed sandbox blocks loopback connections, how several VS Code windows behave, and where a user-only rendezvous file can live on each OS. Building the real migration on a guess would be costly to unwind if one of them fails.

### Key Decisions

- **MCP is served by the extension over HTTP on `127.0.0.1`, sharing one server with the canvas page.** Governs R1, R5. (session-settled: user-directed — chosen over a stdio MCP process with a pipe credential broker: once the canvas needs a localhost server, a second process and protocol add cost without benefit.)
- **The access key is always on.** Governs R2, R3. (session-settled: user-directed — chosen over an optional key or loopback binding alone: any local user on shared machines and browser pages could otherwise reach the port.)
- **The extension serves the canvas page and its data; a thin launcher only returns the URL.** Governs R8, R9, R10. (session-settled: user-directed — chosen over a display-only canvas fed by the agent: one model turn per click and large reports flowing through the model.)
- **A canvas write is a click, a preview, then Apply; an agent-initiated write needs the VS Code modal.** Governs R11, R12. (session-settled: user-directed — chosen over always using the modal or acting on a single click.)
- **The launcher is installed by the extension on request, with a startup check that explains it when missing.** Governs R13, R14. (session-settled: user-directed — chosen over a separate agent plugin or committing the launcher per repository; the user added the startup check.)

### Actors

- A1. User: works in a Copilot-harness chat session and on the canvas tab.
- A2. Copilot agent: runs in the Agent Host and calls the MCP endpoint.
- A3. Ticket Sidekick extension: runs the localhost server, holds credentials in SecretStorage, talks to Jira.
- A4. Canvas launcher: a small Copilot SDK extension that the Copilot runtime loads.
- A5. Jira Data Center test project: the target of reads and writes.

### Requirements

**Localhost server**

- R1. The extension runs one HTTP server bound only to `127.0.0.1` on a random port, started on activation and stopped on deactivation.
- R2. Every request must carry the right key: MCP requests a bearer key, canvas requests a key in the URL path. Both keys are random, at least 256 bits, new at each activation, kept only in memory and compared in constant time.
- R3. A request is refused with 403 when its `Host` is not exactly `127.0.0.1:<port>`, or its `Origin` is present and not the server's own origin. Responses carry no CORS headers.
- R4. Requests without a valid key are refused before any Jira call, and no refusal response or log line contains a key or a Jira token.

**MCP endpoint**

- R5. The extension registers its MCP server through `registerMcpServerDefinitionProvider` as an HTTP definition with the bearer key in `headers`, so it appears and works in a Copilot-harness session.
- R6. The endpoint offers one read tool (load a Jira ticket) and one write tool (add a comment), both calling the existing `TicketService` with the token from SecretStorage.
- R7. The read tool can also return an MCP App that shows the loaded ticket inline in chat.

**Canvas**

- R8. When enabled, the canvas launcher declares one canvas, a ticket board, and its `open()` returns the extension's URL with the canvas key in the path.
- R9. The extension writes the port and canvas key, never a Jira token, to a rendezvous file only the OS user can read. It overwrites the file at activation and deletes it at deactivation.
- R10. The board page is served by the extension and shows live data: the open tickets of one JQL query in the test project.

**Writes**

- R11. A write started on the board (add a comment to a selected ticket) first shows a preview of exactly what will be written, and executes only after a second **Apply** click.
- R12. A write started by the agent through the MCP write tool shows a VS Code modal with the same preview and executes only after approval.

**Launcher distribution**

- R13. A command **Ticket Sidekick: Enable canvas** copies the launcher to `~/.copilot/extensions/ticket-sidekick`, and **Ticket Sidekick: Disable canvas** removes it.
- R14. At startup, when `chat.canvases.enabled` is on and the launcher is missing or older than the extension's copy, a notification explains what the canvas is for and offers **Enable**, **Not now** and **Don't ask again**.

**Prototype checks**

- R15. The prototype answers, with recorded evidence, whether the Agent Host writes the forwarded MCP bearer key anywhere on disk or into logs.
- R16. The prototype answers whether a managed sandbox policy (`allowLocalNetwork`, `sandboxMcpServers`) blocks the Agent Host's or the launcher's connection to `127.0.0.1`.
- R17. The prototype answers how two VS Code windows behave: which window's server a session and its canvas reach, and what the rendezvous file must hold per window.
- R18. The prototype answers where the rendezvous file lives on Windows and on Linux or macOS, and how "only this user can read it" is enforced on each.
- R19. The findings for R15–R18 are recorded in the architecture doc's decision log (§11), each stating whether it confirms D1–D5 or which decision it reopens.

### Key Flows

- F1. Agent reads a ticket
  - **Trigger:** A1 asks the agent in a Copilot-harness session to show ticket `KEY-1`.
  - **Actors:** A1, A2, A3, A5
  - **Steps:** A2 calls the read tool with the bearer key; A3 checks key, Host and Origin; A3 loads the ticket through `TicketService`; A2 shows the result, or the MCP App renders it inline.
  - **Covered by:** R1–R7
- F2. User opens and works on the board
  - **Trigger:** A1 opens the ticket board canvas.
  - **Actors:** A1, A3, A4, A5
  - **Steps:** A4 reads the rendezvous file and returns the URL; the canvas tab loads the page from A3; A1 selects a ticket and drafts a comment; A3 shows the preview; A1 clicks **Apply**; A3 writes the comment and refreshes the board.
  - **Covered by:** R8–R11
- F3. Agent writes a comment
  - **Trigger:** A1 asks the agent to comment on a ticket.
  - **Actors:** A1, A2, A3, A5
  - **Steps:** A2 calls the write tool; A3 shows the modal with the preview; on approval A3 writes, on refusal it returns "not approved" to A2.
  - **Covered by:** R6, R12
- F4. First start with canvases enabled
  - **Trigger:** The extension activates while `chat.canvases.enabled` is on and the launcher is not installed.
  - **Actors:** A1, A3
  - **Steps:** A3 shows the notification; **Enable** installs the launcher; **Don't ask again** suppresses future notifications.
  - **Covered by:** R13, R14

### Acceptance Examples

- AE1. **Covers R2, R4.** Given the server is running, when a local process sends an MCP request without the bearer key, then it gets 401, no Jira call is made, and the log line names neither key nor token.
- AE2. **Covers R3.** Given a valid key, when the request's `Host` is `localhost:<port>` or another name, then it gets 403.
- AE3. **Covers R3.** Given a valid canvas key, when a web page on another origin posts to the board's write endpoint, then it gets 403 and cannot read any response.
- AE4. **Covers R2, R5.** Given VS Code reloads the window, when the agent's next turn starts, then the old keys are refused and the session works with the new ones after the runtime relaunches the server.
- AE5. **Covers R9.** Given the extension deactivates, when the launcher's `open()` runs, then the rendezvous file is gone and the canvas shows that Ticket Sidekick is not running.
- AE6. **Covers R11.** Given A1 drafts a comment on the board, when A1 closes the preview without clicking **Apply**, then nothing is written to Jira.
- AE7. **Covers R12.** Given the agent calls the write tool, when A1 cancels the modal, then nothing is written and the agent receives "not approved".
- AE8. **Covers R14.** Given the launcher is installed and current, when the extension starts, then no notification appears.

### Success Criteria

- F1–F4 work end to end in a Copilot-harness session on a managed machine, on Windows and on at least one of Linux or macOS.
- R15–R18 each have a recorded yes/no answer with evidence, and R19's decision-log entries say which of D1–D5 stand.

### Scope Boundaries

- Deferred for later: the session engine, migrating any participant flow (imports, cleanup, guided create), Bitbucket, the onboarding walkthrough step, and a Marketplace release.
- Deferred for later: hardening beyond R1–R4, such as rate limits, request size limits and an audit journal.
- Outside this prototype: Jira Cloud, remote Agent Hosts and the Agents window; the prototype targets the editor window on a local machine.
- Outside this prototype: changing or removing `@jira`/`@bitbucket`; both keep working in the Local harness unchanged.

### Dependencies / Assumptions

- A managed machine with VS Code 1.144 or later, the Copilot harness available, and `chat.canvases.enabled` allowed by policy.
- A Jira Data Center test project where the prototype may read and add comments, with a PAT set through the existing token command.
- The Copilot SDK canvas API (`createCanvas`, marked `@experimental`) stays compatible for the prototype's lifetime.

### Outstanding Questions

**Deferred to Planning**

- Does the prototype live only on a branch, or ship behind a hidden setting in a pre-release build so testers can install it?
- Which Jira test project and JQL query does the board use?
- How is the launcher packaged inside the extension (copied file, versioned by the extension version)?

### Sources / Research

- [`docs/architecture/copilot-harness-migration.md`](../architecture/copilot-harness-migration.md): current design, options, §6.6 localhost server rules, §11 decision log and open checks.
- VS Code source: `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostMcpServerSupport.ts` (forwarding of extension-provided MCP definitions, headers included), `src/vs/platform/agentHost/node/copilot/copilotSessionLauncher.ts` (MCP Apps and elicitation enabled), `src/vs/workbench/contrib/canvases/common/agentHostCanvas.ts` (canvas URLs must be `http`/`https`), all in `microsoft/vscode`.
- MCP specification 2025-11-25, Transports: Origin validation, localhost binding and authentication for local HTTP servers.
- `@github/copilot-sdk` 1.0.28: `dist/canvas.d.ts` (`createCanvas`, `CanvasProviderOpenResult`).
