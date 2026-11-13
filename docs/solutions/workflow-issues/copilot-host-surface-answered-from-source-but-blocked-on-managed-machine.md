---
title: A Copilot host surface confirmed from VS Code's source was still blocked on the managed machine
date: 2026-11-13
category: workflow-issues
module: architecture/copilot-integration-surfaces
problem_type: workflow_issue
component: development_workflow
severity: high
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - Choosing how Copilot or VS Code reaches the extension (tool route, chat UI host, page host, transport)
  - A spike question was answered from VS Code docs or source rather than run on the maintainer's managed machine
  - Planning several PRs on top of a surface that is Preview, experimental, or governed by an organisation policy
symptoms:
  - The MCP server shipped in PRs 114 to 117 was refused on the company machine as "blocked by policy"
  - A canvas shipped through the extension's agent plugin was never registered in Copilot chats on VS Code 1.146
  - The local HTTP server behind MCP and the board pages only worked with 127.0.0.1 added to http.noProxy
tags: [copilot-harness, mcp, canvas, agent-plugin, managed-machine, org-policy, spike, extension-tools, boards, migration]
---

# A Copilot host surface confirmed from VS Code's source was still blocked on the managed machine

## Context

Between 2026-11-05 and 2026-11-13 the extension moved away from the deprecated `@jira`/`@bitbucket` chat participants. The first plan (`docs/architecture/copilot-harness-migration.md`, now superseded) picked three new surfaces:

- **An MCP server inside the extension** on `127.0.0.1` (decisions D1, D2, D6), merged as PRs #114 to #117 together with the full Jira tool catalog and the `/ts-jira` skills on top of it.
- **A VS Code canvas** for the security report, shipped as an agent plugin with its own Copilot SDK program (commits on the branch merged as PR #124).
- **A local HTTP server** that served the MCP endpoint and the canvas/board pages, protected by per-activation keys and requiring `127.0.0.1` in `http.noProxy`.

The plan's phase 0 listed spikes S1 to S7 and an exit criterion: "a minimal broker + MCP App prototype runs in a Copilot-harness session on a managed machine". S1 to S4 were marked **"Answered from source: yes"**: VS Code's code shows an extension-registered MCP server reaches the Copilot harness, MCP Apps and sampling work, and so on. The questions only the organisation or the managed machine could answer (S6 the Local-harness switch, S7 MCP sandboxing) stayed open, and work continued.

On the managed machine each surface failed for a reason the source could not show:

| Surface | What happened | Recorded in |
| --- | --- | --- |
| MCP server | The organisation's MCP allowlist refused it ("blocked by policy"); extension language model tools from the same extension got through | D19, D21 |
| Canvas via agent plugin | VS Code up to 1.146 only forwards a plugin that contains a skill, agent, command, hook, instruction or MCP server, so a canvas-only plugin was dropped (microsoft/vscode#347397, fixed for 1.147). Even after adding a skill, an extension's canvas was not registered in Copilot chats on 1.146 | commit message of the plugin-skill fix, D18, D20 |
| Local HTTP server | Corporate proxy settings route loopback traffic unless the user adds `127.0.0.1` to `http.noProxy`, a setting the extension must not write | D6, D20 |

The result: about a week of merged features (MCP lifecycle, keys, request guard, diagnostics report quoting VS Code's MCP log lines, canvas program, agent plugin, startup notices, a `toolsFrom` switch) was removed on 2026-11-13 (D20, D21). The tool catalog itself survived because it was written vscode-free (`src/tools/jiraTools/`) and could be registered a second way, as `vscode.lm.registerTool` tools (`src/tools/registerJiraTools.ts`).

## Guidance

1. **"Answered from source" settles whether VS Code can do something, not whether this user's machine lets it.** Organisation policy (MCP allowlists, `vscode.temporaryAllowLocalHarness`, sandboxing), proxy setup and the installed VS Code version are only visible on the managed machine. Mark a spike that depends on them as open until it has been run there, however clear the source is.
2. **Meet the phase-0 exit criterion before building the feature set on a new surface.** A throw-away probe on the managed machine (one tool, one page, one call) is cheap; a merged catalog plus lifecycle, diagnostics and docs on a blocked surface is not. If the managed machine is not available yet, keep work on the new surface to the probe.
3. **Prefer the surface with the fewest policy and network gates.** Of the routes tried, extension language model tools and webviews in editor tabs (talking to the extension over `postMessage`) need no port, no key, no proxy entry and no plugin, and they are what the managed machine allowed. Preview or `@experimental` hosts (canvases, agent plugins) and anything listening on a port are the first to be blocked.
4. **Keep the domain logic independent of the host.** What survived the switch did so because the tool catalog (`defineTool`/`callTool` in `src/tools/toolDefinition.ts`) and the session model (`src/sessions/`) import no host API. Write the host binding as a thin last layer so a blocked host costs only that layer.
5. **When a route is dropped, remove it and mark the documents.** Keeping the canvas "built for later" or both tool routes behind a setting was rejected (D19 superseded by D21): an untested second host to keep in step, a switch users must operate, and plans that later sessions read as current. The superseded plans carry a banner and `docs/architecture/migration-status.md` lists what is removed.

## Why This Matters

The extension's real users sit on managed banking machines with a corporate proxy and organisation-controlled Copilot policies. A design that works on an unmanaged developer machine and in VS Code's source can still be dead on arrival there, and each surface was only found out after its PRs were merged. The plan already assumes this risk continues: "Extension tools stay allowed by the organisation's Copilot policy … an organisation could restrict extension tools too, and then only the Command Palette boards remain" (boards plan, assumptions), and model access outside a chat participant is still to be checked on the managed machine before `@bitbucket` is removed.

## When to Apply

- Before planning the import board, the PR review board, or any feature that calls a model outside a chat participant: run the managed-machine check the boards plan names first (model access with the Local harness disallowed).
- When a VS Code release note or Copilot SDK change offers a new surface (canvas, agent host feature, MCP App, chat customization) that looks like a better host.
- Whenever a spike table entry says "answered from docs" or "answered from source" and the next step is several PRs.

## Examples

Spike entry as it was written, then acted on:

```text
S1 | Does an MCP server registered through registerMcpServerDefinitionProvider
     reach a Copilot-harness session? | Answered from source: yes.
→ PRs #114–#117 build the server, keys, lifecycle and full tool catalog on it.
→ Managed machine: "blocked by policy".
```

Spike entry as it should be held:

```text
S1 | Does an MCP server registered through registerMcpServerDefinitionProvider
     reach a Copilot-harness session ON THE MANAGED MACHINE? |
     Source: yes. Managed machine: open — run a one-tool probe there before PR 2.
```

Release gate that now carries the same idea for every step: R35 in the boards plan — a step becomes a normal release only after a written manual checklist passes on the maintainer's managed machine with the proxy, the organisation's Copilot policies and real Jira and Bitbucket Data Center.

## Related

- `docs/architecture/copilot-harness-migration.md` — superseded plan; spikes S1 to S7 and decisions D1 to D22
- `docs/architecture/boards-and-sessions.md` — the design as built (D18 to D22)
- `docs/architecture/migration-status.md` — what is done and still open
- `docs/plans/2026-11-11-2234-feat-boards-replace-chat-participants-plan.md` — current plan, R35 and the managed-machine assumptions
- `docs/solutions/workflow-issues/doc-consolidation-unverified-destination-coverage-assumption.md` — another case of acting on an unverified assumption
