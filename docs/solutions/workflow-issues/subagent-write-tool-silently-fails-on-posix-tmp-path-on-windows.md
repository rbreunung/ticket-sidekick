---
title: Subagent `Write` tool calls silently fail on POSIX `/tmp/...` paths on Windows (Git Bash) — convert with `cygpath -w` first
date: 2026-08-31
category: workflow-issues
module: development-workflow/subagent-artifact-writes
problem_type: workflow_issue
component: development_workflow
applies_when:
  - "Dispatching a subagent (or making an orchestrator-level Write-tool call) on a Windows host running Claude Code via Git Bash"
  - "Writing to a path derived from a skill's standard POSIX-style scratch/run-dir snippet, e.g. /tmp/compound-engineering-$(id -u)/..."
  - "The subagent-artifact-write pattern is {run_dir}/{artifact-name}.json (or similar) delivered via the Write tool — this applies to any compound-engineering skill built the same way (ce-code-review, ce-simplify-code, ce-compound itself), not just one specific skill"
symptoms:
  - "4 of 5 general-purpose subagents in a parallel batch reported success ('written full findings JSON to <path>') for a Write-tool call; for 3 of those 4, the target file did not exist on disk afterward when checked with ls"
  - "The Write tool call itself returned no error to the subagent — the failure was completely silent and undetectable from the subagent's own tool-result, so no subagent self-reported or fell back to an inline return"
  - "All affected subagents had been given the same orchestrator-constructed POSIX-style path (/tmp/compound-engineering-$(id -u)/ce-code-review/<run-id>/<name>.json)"
  - "The identical POSIX-style /tmp/... path worked fine for the orchestrator's own Bash-tool file operations (e.g. git diff ... > \"$RUN_DIR/full.diff\") against the same run directory, masking that the failure was specific to the Write tool rather than the path itself"
  - "Retrying the same subagents with a Windows absolute path for the same run directory (derived via cygpath -w from the POSIX path) succeeded and was confirmed on disk via ls"
root_cause: missing_validation
resolution_type: workflow_improvement
severity: high
tags: [claude-code, subagent-dispatch, write-tool, posix-path, windows, git-bash, msys, silent-failure]
---

# Subagent `Write` tool calls silently fail on POSIX `/tmp/...` paths on Windows (Git Bash) — convert with `cygpath -w` first

## Problem

An orchestrator running a `ce-code-review` multi-agent review on Windows (Git Bash / MSYS) created a scratch run directory with the skill-standard POSIX-style snippet (`SCRATCH_ROOT="/tmp/compound-engineering-$(id -u)"`, `RUN_DIR="$SCRATCH_ROOT/ce-code-review/$RUN_ID"`) and passed that same POSIX-style path to nine `general-purpose` reviewer subagents as `{run_dir}`, instructing each to write its full JSON findings there via the platform's `Write` tool. Most of the first batch's `Write` calls silently did not produce a file on disk at that path, even though each subagent's own `Write` call apparently returned success and each subagent's final report claimed the file was written.

## Symptoms

- Of the first batch of 5 subagents dispatched (testing, maintainability, project-standards, agent-native, learnings-researcher — the last with no file-write requirement), only 1 of the 4 file-writing subagents (`testing.json`) actually produced a file on disk in `RUN_DIR`.
- `maintainability.json`, `project-standards.json`, and `agent-native.json` were missing from the run directory when the orchestrator happened to `ls` it.
- Each of those three subagents' own final report explicitly claimed success — e.g. "Full findings JSON written to `/tmp/compound-engineering-.../maintainability.json`." — despite no file existing at that path.
- No subagent self-detected or reported the failure; the `Write` tool call itself apparently returned success (or at least no visible/actionable error) to each subagent, so there was no signal at the point of failure that anything had gone wrong.
- The failure was discovered only incidentally, when the orchestrator happened to `ls` the run directory later — not through any error surfaced during the write itself.
- By contrast, the orchestrator's own `git diff ... > "$RUN_DIR/full.diff"` — a Bash-tool call using the same POSIX `$RUN_DIR` string — succeeded, and the resulting file was later readable via both the POSIX path and its Windows-mapped equivalent (obtained via `cygpath -w`). This confirmed the path itself was fine for Bash-tool operations; only `Write`-tool operations against the identical string failed.

## What Didn't Work

The working assumption — both the orchestrator's and the pattern documented in `ce-code-review`'s own dispatch instructions — was that Git Bash/MSYS's transparent POSIX-to-Windows path rewriting (the mechanism that makes `/tmp/...` resolve to a real path like `C:\Users\<user>\AppData\Local\Temp\...` for Bash commands) would apply uniformly to any tool call given that same path string, including a subagent's direct `Write` tool call. Under that assumption, handing subagents the literal `/tmp/compound-engineering-$(id -u)/ce-code-review/$RUN_ID` string as `{run_dir}` and telling them to write there via "the platform's file-write tool" seemed sufficient. This held for the Bash-tool artifact (`full.diff`) but did not hold for most of the `Write`-tool artifacts in the first batch; 3 of 4 silently failed to land, with no error raised to reveal the assumption was wrong until a manual directory listing exposed it.

## Solution

When the same session later had to re-dispatch four more reviewer subagents after an unrelated interruption, the orchestrator — having diagnosed the path issue — explicitly converted the POSIX run-dir path to its Windows equivalent first, using `cygpath -w` from a Bash-tool call, and handed that Windows path to each subagent instead:

```bash
# before — handed to the first-batch subagents; silently failed for 3/4 Write calls
run_dir = "/tmp/compound-engineering-197609/ce-code-review/<run-id>"

# after — handed to the second-batch subagents
cygpath -w "/tmp/compound-engineering-197609/ce-code-review/<run-id>"
# -> C:\Users\ANTROP~1\AppData\Local\Temp\compound-engineering-197609\ce-code-review\<run-id>
```

Each retried subagent was given that literal Windows-style absolute path plus an explicit instruction: "Use an absolute Windows path exactly as given above — this environment is Windows; do NOT use a `/tmp/...` path — it will silently fail to write on this host." All four retried subagents' artifact files (`correctness.json`, `security.json`, `api-contract.json`, `adversarial.json`) were confirmed present via `ls` immediately afterward, each with a real, non-trivial byte count.

The generalized fix: whenever an orchestrator on Windows hands a subagent (or its own `Write` tool call) a path for a `Write`-tool-style file operation, and that path originated as a POSIX-style scratch/temp path, convert it to a native Windows absolute path first via `cygpath -w <posix-path>` run through the Bash tool. Don't hand-construct the Windows path by guessing the `/tmp` → `AppData\Local\Temp` mapping — the exact segments (e.g. the numeric UID-derived directory component) must match exactly what MSYS actually used, and `cygpath -w` is the reliable source of that mapping. Bash-tool operations on the original POSIX path (like the `git diff` redirect above) continue to work fine and need no change — only `Write`-tool-style calls need the converted path.

## Why This Works

Git Bash/MSYS's POSIX-to-Windows path translation operates at the shell layer: it rewrites a path as part of executing a command through `bash`/MSYS's own process, which is why a Bash-tool call using `$RUN_DIR` (a POSIX string) transparently resolves to the correct real Windows location — the translation happens inside the shell invocation itself. A subagent's `Write` tool call is not a shell command at all; it's a direct file-write API call from the harness, invoked independently of any Bash/MSYS process. That call never passes through the shell layer where the rewriting happens, so it never receives the translation. A `/tmp/...`-style path handed straight to `Write` on Windows has no such root to resolve against, and the failure was not surfaced as a visible error back to the calling agent — the `Write` call apparently reported success (or at least nothing actionable) regardless, leaving the agent with no signal that its artifact was never actually written. This is consistent with the direct evidence gathered: the identical `$RUN_DIR` string worked for the Bash-tool `git diff` redirect (shell layer involved) and failed for `Write`-tool calls (shell layer bypassed), and the failure mode flipped to reliable success once the path was pre-converted to a real Windows path via `cygpath -w` before being handed to `Write`.

## Prevention

- **Resolve the Windows path once, at run-dir-creation time.** Immediately after `mkdir -p "$RUN_DIR"` (or equivalent), run `cygpath -w "$RUN_DIR"` via the Bash tool and capture the result. Pass that Windows-style path — not the POSIX path — into every subagent prompt wherever the instruction is "write via the `Write` tool." Bash-tool instructions to the same subagent, if any, can keep using the POSIX path unchanged.
- **Don't trust a subagent's own "I wrote the file" claim as proof the file exists.** In this incident, 3 of 4 file-writing subagents in the first batch reported success with an explicit path, and all 3 were wrong — the `Write` call gave no visible error even when it silently failed. After dispatching a batch of subagents that are each supposed to produce an artifact, `ls` (or equivalent) the run directory and confirm every expected artifact file is actually present with a non-trivial size before treating the batch as complete. This is the only way the failure was actually caught here — a happenstance manual check, not a reported error — so it should be a deliberate step, not left to chance.
- **This applies beyond `ce-code-review`.** Any compound-engineering skill (or other multi-agent workflow) whose subagent-artifact-write pattern follows the same `{run_dir}/{artifact}.json`-via-`Write`-tool shape — `ce-simplify-code`, `ce-compound` itself, and any custom skill built the same way — is subject to the identical failure mode on a Windows host, since the root cause is in the tool-call/shell-layer boundary, not anything specific to reviewer dispatch.
- **When re-dispatching subagents after a partial failure (of any kind, not just this one),** re-verify the run-dir path being handed out is still the correct, converted form — don't assume a path computed once at the start of a long session is still being propagated correctly to every later dispatch, especially across an interruption/retry boundary.

## Related Issues

- [`docs/solutions/workflow-issues/github-remote-not-named-origin.md`](github-remote-not-named-origin.md) — same broad shape (an automated tooling workflow silently breaks on an environment-specific assumption, discovered only by comparing expected vs. actual behavior), different concrete subject (git remote naming, not path translation).
