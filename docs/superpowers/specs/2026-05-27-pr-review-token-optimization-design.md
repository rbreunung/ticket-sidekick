# Design Spec: PR Review Token Optimization

## Context

Reviewing a large 140-file Bitbucket PR consumed ~10% of the user's monthly GitHub Copilot Premium token budget. The root cause is the hardcoded `CHUNK_SIZE = 10` constant in `BitbucketParticipant.ts`: a 140-file PR spawns 14 chunks × up to 2 LLM passes each = up to 28 LLM calls. Each call carries ~1,200 tokens of fixed overhead (system prompt + PR metadata), regardless of the model's actual context capacity. Modern models like Claude Sonnet have 200k-token context windows — the current approach leaves nearly all of that unused.

The goal is to make large PR reviews dramatically cheaper by packing more files per chunk (fewer LLM calls, less overhead duplication) while giving the user control over review depth at both the setting level and per-review via a command keyword.

---

## Feature 1: Token-Budget Adaptive Chunking

### How it works

Replace the hardcoded `CHUNK_SIZE = 10` with a token-budget-based approach:

1. At review time, resolve the token budget using this priority order:
   - User-set `ticketSidekick.bitbucket.modelContextTokens` (integer, optional) — explicit override
   - `request.model.maxInputTokens` from the VS Code LM API — automatic detection
   - Hard-coded safe default: **60,000 tokens** (conservative fallback for unknown models)

2. Compute effective budget: `tokenBudget = resolvedContextTokens × contextBudgetRatio`
   - New setting `ticketSidekick.bitbucket.contextBudgetRatio` (number 0.1–0.9, default `0.7`)
   - Reserves 30% of context for the model's output and safety headroom

3. Pack files into chunks greedily using a token estimator:
   - Fixed overhead per chunk: ~1,500 tokens (system prompt + PR header)
   - Per-file overhead: 50 tokens (path + section headers)
   - Per-file diff cost: `Math.ceil(diff.length / 4)` (4 chars ≈ 1 token)
   - Start a new chunk when adding the next file would exceed the budget

### Expected impact

| Scenario | Current chunks | Adaptive chunks |
|---|---|---|
| 140-file PR, Claude Sonnet (200k ctx) | 14 | ~2 |
| 140-file PR, GPT-4o (128k ctx) | 14 | ~3 |
| 140-file PR, fallback (60k default) | 14 | ~7 |

### New utility function

A pure `buildAdaptiveChunks(diffs: FileDiff[], tokenBudget: number): FileDiff[][]` function extracted from `BitbucketParticipant.ts` into `src/participant/reviewSessionState.ts` (where other pure review helpers live). This makes it unit-testable independently.

---

## Feature 2: Quick Mode (No Pass 2)

### Command syntax

- `@bitbucket review <url>` — uses the configured default depth
- `@bitbucket review quick <url>` — forces quick mode for this review (no Pass 2)
- `@bitbucket review deep <url>` — forces standard mode for this review (Pass 2 enabled)

Keyword detection: after stripping the PR URL from the prompt, if any remaining word is `quick` or `deep` (case-insensitive, whole-word match), apply that mode. Otherwise fall back to the setting.

### New setting

`ticketSidekick.bitbucket.reviewMode` (`"standard"` | `"quick"`, default `"standard"`)

- `"standard"` — current two-pass behavior (LLM may request additional file context in Pass 2)
- `"quick"` — Pass 2 disabled entirely; LLM only sees diffs; no additional file content fetched

### Token impact

Quick mode eliminates all Pass 2 calls. For a 140-file PR where half the chunks trigger Pass 2, this removes 7 additional LLM calls entirely.

---

## Feature 3: File Exclusion Patterns (Lower Priority)

### New setting

`ticketSidekick.bitbucket.reviewExcludePatterns` (string array, default `[]`)

Patterns are matched against each file's path using `minimatch` glob syntax. `minimatch` must be added as a dependency if not already present (check `package.json`; it is a common transitive dep of many Node toolchains). Excluded files are filtered out before chunking. The review output header notes: *"N files excluded by pattern."*

Example:
```json
["**/migrations/**", "**/*.snap", "**/fixtures/**", "**/*.generated.ts"]
```

### Documentation

- Setting description in `package.json` includes a usage example with common patterns
- README.md Bitbucket section documents all three new settings with examples

---

## New VS Code Settings Summary

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `ticketSidekick.bitbucket.modelContextTokens` | number (optional) | unset | Manual override for model context window size in tokens |
| `ticketSidekick.bitbucket.contextBudgetRatio` | number (0.1–0.9) | `0.7` | Fraction of context window to use per chunk |
| `ticketSidekick.bitbucket.reviewMode` | `"standard"` \| `"quick"` | `"standard"` | Default review depth (quick disables Pass 2) |
| `ticketSidekick.bitbucket.reviewExcludePatterns` | string[] | `[]` | Glob patterns for files to skip in review |

---

## Files to Change

| File | Change |
|---|---|
| `src/participant/reviewSessionState.ts` | Add `buildAdaptiveChunks(diffs, tokenBudget)` pure function |
| `src/participant/BitbucketParticipant.ts` | Replace `CHUNK_SIZE` with adaptive chunking; parse `quick`/`deep` keyword; read new settings; filter excluded files |
| `src/services/ConfigService.ts` | Add getters for the 4 new settings |
| `package.json` | Register new `contributes.configuration` entries; add `minimatch` if absent |
| `README.md` | Document new settings under Bitbucket configuration |

---

## Testing

1. **Unit tests** (new or extended in `src/test/`):
   - `buildAdaptiveChunks` with small budget → many small chunks
   - `buildAdaptiveChunks` with large budget → few large chunks
   - `buildAdaptiveChunks` with a single very large file → one chunk containing just that file

2. **Integration (manual)**:
   - Review a real multi-file PR in quick mode and confirm Pass 2 is never triggered
   - Review the same PR in standard mode and confirm findings are equivalent or richer
   - Set `reviewExcludePatterns` for a pattern that matches some files; confirm count in the review header

3. **Token regression** (observational):
   - Review the same large PR before and after; confirm fewer chunks in the output stream

---

## Verification

Run `npm test` and `npm run compile` — all existing tests must stay green. The `buildAdaptiveChunks` function must have dedicated unit tests added as part of this change.
