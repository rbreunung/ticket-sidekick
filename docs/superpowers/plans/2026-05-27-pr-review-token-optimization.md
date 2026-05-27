# PR Review Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `CHUNK_SIZE = 10` in `BitbucketParticipant.ts` with token-budget-based adaptive chunking, add a `quick` mode that skips the second LLM pass, and add configurable file exclusion patterns.

**Architecture:** A pure `buildAdaptiveChunks` function (in `reviewSessionState.ts`) greedily packs `FileDiff` entries into chunks using a token estimate (`diff.length ÷ 4`), staying under a budget derived from the model's actual context window. `BitbucketParticipant` resolves the budget at review time (user setting → VS Code LM API → 60k fallback), filters excluded files, then drives the existing two-pass loop with the new chunks — skipping Pass 2 entirely when `reviewMode` is `quick`.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.LanguageModelChat.maxInputTokens`), `minimatch@^9` for glob matching, Vitest for unit tests.

---

## File Map

| File | Change |
|---|---|
| `src/participant/reviewSessionState.ts` | Add `buildAdaptiveChunks` function |
| `src/test/PrReviewService.test.ts` | Add `buildAdaptiveChunks` unit tests |
| `src/bitbucket/IBitbucketClient.ts` | Extend `BitbucketConfig` with 4 new optional fields |
| `src/services/ConfigService.ts` | Read 4 new settings in `getBitbucketConfig()` |
| `src/participant/BitbucketParticipant.ts` | Replace chunking loop; add quick mode; add exclusion filter |
| `package.json` | Register 4 new settings; add `minimatch` runtime dep |
| `README.md` | Document new settings under Bitbucket |

---

## Task 1: `buildAdaptiveChunks` — TDD

**Files:**
- Modify: `src/participant/reviewSessionState.ts`
- Modify: `src/test/PrReviewService.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Add to the bottom of `src/test/PrReviewService.test.ts`:

```typescript
import { buildAdaptiveChunks } from '../participant/reviewSessionState';

describe('buildAdaptiveChunks', () => {
  function makeDiff(path: string, diffLength: number): { path: string; diff: string } {
    return { path, diff: 'x'.repeat(diffLength) };
  }

  it('returns empty array for empty input', () => {
    expect(buildAdaptiveChunks([], 10000)).toEqual([]);
  });

  it('packs all files into one chunk when budget is large', () => {
    const diffs = [makeDiff('a.ts', 100), makeDiff('b.ts', 100), makeDiff('c.ts', 100)];
    const chunks = buildAdaptiveChunks(diffs, 100000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(3);
  });

  it('splits into multiple chunks when budget is tight', () => {
    // Each file costs: CHUNK_FILE_OVERHEAD(50) + ceil(400/4)(100) = 150 tokens
    // Fixed overhead per chunk: CHUNK_FIXED_OVERHEAD(1500)
    // Budget 1700: fits 1 file (1500+150=1650 ≤ 1700), not 2 (1500+300=1800 > 1700)
    const diffs = [makeDiff('a.ts', 400), makeDiff('b.ts', 400), makeDiff('c.ts', 400)];
    const chunks = buildAdaptiveChunks(diffs, 1700);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[2]).toHaveLength(1);
  });

  it('always includes at least one file per chunk even when it exceeds budget', () => {
    // A huge file that alone costs more than the budget — must not be silently dropped
    const diffs = [makeDiff('huge.ts', 400000)]; // ~100000 tokens alone
    const chunks = buildAdaptiveChunks(diffs, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].path).toBe('huge.ts');
  });

  it('packs multiple files until budget is hit, then starts new chunk', () => {
    // Budget: 2000. Fixed overhead: 1500. Each file: 50+25=75 tokens (100 chars).
    // 2 files fit (1500+75+75=1650 ≤ 2000), 3 would be 1725 ≤ 2000, 4 would be 1800 ≤ 2000...
    // Actually need tighter budget: 1700. 1 file fits (1650), 2nd would be 1725 > 1700.
    // Let's use 4 files with budget 1700 to get 4 chunks:
    const diffs = Array.from({ length: 4 }, (_, i) => makeDiff(`f${i}.ts`, 400));
    const chunks = buildAdaptiveChunks(diffs, 1700);
    expect(chunks).toHaveLength(4);
    expect(chunks.flatMap(c => c)).toHaveLength(4); // no files lost
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 5 "buildAdaptiveChunks"
```

Expected: errors like `buildAdaptiveChunks is not a function`.

- [ ] **Step 1.3: Implement `buildAdaptiveChunks` in `reviewSessionState.ts`**

Add these constants and function to the bottom of `src/participant/reviewSessionState.ts`:

```typescript
const CHUNK_FIXED_OVERHEAD = 1500;
const CHUNK_FILE_OVERHEAD = 50;

export function buildAdaptiveChunks(diffs: FileDiff[], tokenBudget: number): FileDiff[][] {
  if (diffs.length === 0) return [];
  const chunks: FileDiff[][] = [];
  let currentChunk: FileDiff[] = [];
  let currentTokens = CHUNK_FIXED_OVERHEAD;

  for (const diff of diffs) {
    const fileTokens = CHUNK_FILE_OVERHEAD + Math.ceil(diff.diff.length / 4);
    if (currentChunk.length > 0 && currentTokens + fileTokens > tokenBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = CHUNK_FIXED_OVERHEAD;
    }
    currentChunk.push(diff);
    currentTokens += fileTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm test -- --reporter=verbose 2>&1 | grep -A 5 "buildAdaptiveChunks"
```

Expected: all `buildAdaptiveChunks` tests pass.

- [ ] **Step 1.5: Compile check**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/antrophos/git/jira-copilot && git add src/participant/reviewSessionState.ts src/test/PrReviewService.test.ts && git commit -m "feat: add buildAdaptiveChunks to reviewSessionState with tests"
```

---

## Task 2: Install `minimatch`

**Files:**
- Modify: `package.json` (dependency added by npm)

- [ ] **Step 2.1: Install `minimatch`**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm install minimatch@^9
```

Expected: `minimatch` appears in `package.json` `dependencies` and `package-lock.json` is updated.

- [ ] **Step 2.2: Verify install**

```bash
cd /Users/antrophos/git/jira-copilot && node -e "const {minimatch} = require('./node_modules/minimatch'); console.log(minimatch('src/foo.ts', '**/*.ts'))"
```

Expected: `true`.

- [ ] **Step 2.3: Compile check**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1 | tail -5
```

Expected: no errors. (TypeScript types for minimatch are bundled in the package itself.)

- [ ] **Step 2.4: Commit**

```bash
cd /Users/antrophos/git/jira-copilot && git add package.json package-lock.json && git commit -m "chore: add minimatch dependency for glob pattern matching"
```

---

## Task 3: Settings plumbing — `IBitbucketClient`, `ConfigService`, `package.json`

**Files:**
- Modify: `src/bitbucket/IBitbucketClient.ts`
- Modify: `src/services/ConfigService.ts`
- Modify: `package.json`

- [ ] **Step 3.1: Extend `BitbucketConfig` in `IBitbucketClient.ts`**

In `src/bitbucket/IBitbucketClient.ts`, update the `BitbucketConfig` interface. The current interface ends at line 23. Replace it:

```typescript
export interface BitbucketConfig {
  baseUrl: string | undefined;
  authType: BitbucketAuthType;
  token: string | undefined;
  showConnectionInfo?: boolean;
  reviewInstructions?: string;
  modelContextTokens?: number;
  contextBudgetRatio?: number;
  reviewMode?: 'standard' | 'quick';
  reviewExcludePatterns?: string[];
}
```

- [ ] **Step 3.2: Read new settings in `ConfigService.getBitbucketConfig()`**

In `src/services/ConfigService.ts`, replace the `getBitbucketConfig()` method body:

```typescript
async getBitbucketConfig(): Promise<BitbucketConfig> {
  const config = vscode.workspace.getConfiguration('ticketSidekick');
  return {
    baseUrl: config.get<string>('bitbucket.baseUrl'),
    authType: config.get<BitbucketAuthType>('bitbucket.authType') ?? 'datacenter',
    token: await this.context.secrets.get(ConfigService.BITBUCKET_TOKEN_KEY),
    showConnectionInfo: config.get<boolean>('bitbucket.showConnectionInfo') ?? false,
    reviewInstructions: config.get<string>('bitbucket.reviewInstructions') || undefined,
    modelContextTokens: config.get<number>('bitbucket.modelContextTokens') || undefined,
    contextBudgetRatio: config.get<number>('bitbucket.contextBudgetRatio') ?? 0.7,
    reviewMode: config.get<'standard' | 'quick'>('bitbucket.reviewMode') ?? 'standard',
    reviewExcludePatterns: config.get<string[]>('bitbucket.reviewExcludePatterns') ?? [],
  };
}
```

- [ ] **Step 3.3: Register new settings in `package.json`**

In `package.json`, inside the `"id": "bitbucket"` configuration block, add the four new property entries after the existing `ticketSidekick.bitbucket.reviewInstructions` entry (before the closing `}` of `"properties"`):

```json
          "ticketSidekick.bitbucket.modelContextTokens": {
            "type": "number",
            "description": "Override the model's context window size in tokens for chunk sizing. Leave unset to use the model's reported value (recommended). Set this if auto-detection is unavailable or you want a conservative cap (e.g. 60000)."
          },
          "ticketSidekick.bitbucket.contextBudgetRatio": {
            "type": "number",
            "default": 0.7,
            "minimum": 0.1,
            "maximum": 0.9,
            "description": "Fraction of the model's context window to use per review chunk (0.1–0.9, default 0.7). The remaining 30% is reserved for the model's output. Lower this value if you see context-limit errors during reviews."
          },
          "ticketSidekick.bitbucket.reviewMode": {
            "type": "string",
            "enum": ["standard", "quick"],
            "default": "standard",
            "description": "Default review depth. 'standard' enables the two-pass review where the LLM can request additional file context. 'quick' skips the second pass (diffs only) — faster and cheaper for large PRs. Override per-review with '@bitbucket review quick <url>' or '@bitbucket review deep <url>'."
          },
          "ticketSidekick.bitbucket.reviewExcludePatterns": {
            "type": "array",
            "items": { "type": "string" },
            "default": [],
            "description": "Glob patterns for files to skip during PR review (e.g. [\"**/migrations/**\", \"**/*.snap\", \"**/*.generated.ts\"]). Excluded files are not sent to the LLM; the review output notes how many were skipped."
          }
```

- [ ] **Step 3.4: Compile check**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3.5: Tests still pass**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 3.6: Commit**

```bash
cd /Users/antrophos/git/jira-copilot && git add src/bitbucket/IBitbucketClient.ts src/services/ConfigService.ts package.json && git commit -m "feat: add PR review token-optimization settings to BitbucketConfig"
```

---

## Task 4: Wire up `BitbucketParticipant.ts`

**Files:**
- Modify: `src/participant/BitbucketParticipant.ts`

This task replaces the `CHUNK_SIZE = 10` section (lines 302–362 in the current file) with adaptive chunking, quick-mode detection, and exclusion filtering.

- [ ] **Step 4.1: Add imports**

At the top of `src/participant/BitbucketParticipant.ts`, add `buildAdaptiveChunks` to the existing `reviewSessionState` import, and add `minimatch`:

```typescript
import { minimatch } from 'minimatch';
```

Change the existing import from `./reviewSessionState` to include `buildAdaptiveChunks`:

```typescript
import {
  parsePrUrl,
  parseDiff,
  resolveByNumber,
  resolveByNumbers,
  isAddToReviewIntent,
  extractUserNote,
  extractJsonObject,
  buildAdaptiveChunks,
  type ReviewFinding,
  type ReviewSession,
} from './reviewSessionState';
```

- [ ] **Step 4.2: Replace the review orchestration block**

Find the section starting at `try {` (around line 301) that contains `const CHUNK_SIZE = 10;`. Replace the **entire body of the try-block** — from `const CHUNK_SIZE = 10;` all the way through the `await ws.update(...)` call — with the following. Keep everything before the try-block (URL extraction, config check, client construction) and the `catch (err)` block after it unchanged.

The new try-block body:

```typescript
      // Detect quick/deep mode keyword from prompt (overrides setting)
      const promptWithoutUrl = prompt.replace(/https?:\/\/\S+/g, '').toLowerCase();
      const reviewMode = /\bquick\b/.test(promptWithoutUrl) ? 'quick'
        : /\bdeep\b/.test(promptWithoutUrl) ? 'standard'
        : (config.reviewMode ?? 'standard');

      // Resolve token budget: user setting → model API → safe fallback
      const resolvedContextTokens = config.modelContextTokens
        ?? request.model.maxInputTokens
        ?? 60000;
      const budgetRatio = config.contextBudgetRatio ?? 0.7;
      const tokenBudget = Math.floor(resolvedContextTokens * budgetRatio);

      stream.markdown('_Fetching PR…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);
      const rawDiff = await client.getPullRequestDiff(parsed.project, parsed.repo, parsed.prId);

      // Apply exclusion patterns before chunking
      let fileDiffs = parseDiff(rawDiff);
      const excludePatterns = config.reviewExcludePatterns ?? [];
      let excludedCount = 0;
      if (excludePatterns.length > 0) {
        const before = fileDiffs.length;
        fileDiffs = fileDiffs.filter(
          (d) => !excludePatterns.some((p) => minimatch(d.path, p)),
        );
        excludedCount = before - fileDiffs.length;
      }

      if (fileDiffs.length === 0) {
        stream.markdown('_No files to review after applying exclusion patterns._\n\n');
        return;
      }

      if (excludedCount > 0) {
        stream.markdown(`_${excludedCount} file${excludedCount !== 1 ? 's' : ''} excluded by pattern._\n\n`);
      }

      const chunks = buildAdaptiveChunks(fileDiffs, tokenBudget);

      let allFindings: Array<Omit<ReviewFinding, 'id'>> = [];
      let fileOffset = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const from = fileOffset + 1;
        const to = fileOffset + chunk.length;
        fileOffset += chunk.length;
        const batchLabel = chunks.length > 1 ? ` · batch ${i + 1}/${chunks.length}` : '';
        stream.markdown(`_Analysing files ${from}–${to} of ${fileDiffs.length}${batchLabel}…_\n\n`);

        const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
        const chunkRaw = await callLLMWithProgress(
          service.buildPrompt(pr, chunk, undefined, config.reviewInstructions),
          request.model, token, batchStatus,
        );
        const { findings, additionalFilesNeeded } = await parseReviewResponse(chunkRaw);
        let chunkFindings = findings;

        if (reviewMode !== 'quick' && additionalFilesNeeded.length > 0) {
          const capped = additionalFilesNeeded.slice(0, 5);
          const batchSuffix = chunks.length > 1 ? ` (batch ${i + 1})` : '';
          stream.markdown(`_Fetching ${capped.length} context file${capped.length !== 1 ? 's' : ''}${batchSuffix}…_\n\n`);
          const extraContents = await service.gatherFileContents(
            parsed.project, parsed.repo, pr.fromCommitHash,
            capped,
            makeWorkspaceReader,
          );
          const pass2Raw = await callLLMWithProgress(
            service.buildPrompt(pr, chunk, extraContents, config.reviewInstructions),
            request.model, token, `${batchStatus} pass 2`,
          );
          chunkFindings = (await parseReviewResponse(pass2Raw)).findings;
        }

        allFindings = allFindings.concat(chunkFindings);

        if (chunks.length > 1 && i < chunks.length - 1) {
          const crit = chunkFindings.filter((f) => f.severity === 'critical').length;
          const warn = chunkFindings.filter((f) => f.severity === 'warning').length;
          const sugg = chunkFindings.filter((f) => f.severity === 'suggestion').length;
          const tally = [
            crit ? `${crit} 🔴` : '',
            warn ? `${warn} 🟡` : '',
            sugg ? `${sugg} 🔵` : '',
          ].filter(Boolean).join(' · ') || 'no issues';
          stream.markdown(`_Batch ${i + 1}/${chunks.length} done · ${tally}_\n\n`);
        }
      }

      const numbered = allFindings.map((f, idx) => ({ ...f, id: idx + 1 }));
      const output = service.formatReview(numbered, pr, fileDiffs.length);
      stream.markdown(output);

      await ws.update('bitbucket.session.review', {
        prTitle: pr.title,
        prUrl: urlMatch[0],
        project: parsed.project,
        repo: parsed.repo,
        prId: parsed.prId,
        findings: numbered,
      } satisfies ReviewSession);
```

- [ ] **Step 4.3: Compile check**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1 | tail -10
```

Expected: no errors. If TypeScript complains about `request.model.maxInputTokens` not existing on the type, add `// @ts-ignore` on that line (VS Code 1.90+ has it, but older `@types/vscode` may not yet). Check with:

```bash
grep -n "maxInputTokens" node_modules/@types/vscode/index.d.ts 2>/dev/null | head -3
```

If not found, use this fallback for the resolution line instead:

```typescript
      const resolvedContextTokens = config.modelContextTokens
        ?? (request.model as { maxInputTokens?: number }).maxInputTokens
        ?? 60000;
```

- [ ] **Step 4.4: Tests still pass**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/antrophos/git/jira-copilot && git add src/participant/BitbucketParticipant.ts && git commit -m "feat: replace fixed CHUNK_SIZE with adaptive token-budget chunking and quick mode"
```

---

## Task 5: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 5.1: Add new settings to README**

Find the Bitbucket settings table in `README.md` (search for `ticketSidekick.bitbucket.reviewInstructions`). Add four rows after the existing `Review instructions` row:

```markdown
| Model context tokens | `ticketSidekick.bitbucket.modelContextTokens` |
| Context budget ratio | `ticketSidekick.bitbucket.contextBudgetRatio` |
| Review mode | `ticketSidekick.bitbucket.reviewMode` |
| Review exclude patterns | `ticketSidekick.bitbucket.reviewExcludePatterns` |
```

Then add a new subsection after the table (before the next `##` heading):

```markdown
### Reducing token usage on large PRs

For PRs with many files, the reviewer automatically packs as many files as possible into each LLM call based on the model's actual context window. On Claude Sonnet (200k tokens) a 140-file PR typically needs only 2 LLM calls instead of 14.

**Quick mode** skips the second LLM pass entirely (diffs only, no additional file context):

```
@bitbucket review quick https://bitbucket.company.com/...
```

Set `ticketSidekick.bitbucket.reviewMode` to `"quick"` to make this the default.

**Excluding files** — skip files that don't need review (migrations, snapshots, generated code):

```json
// settings.json
"ticketSidekick.bitbucket.reviewExcludePatterns": [
  "**/migrations/**",
  "**/*.snap",
  "**/*.generated.ts"
]
```

**Manual context override** — if the model's context size isn't auto-detected, set it explicitly:

```json
"ticketSidekick.bitbucket.modelContextTokens": 128000
```
```

- [ ] **Step 5.2: Compile + test**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1 | tail -5 && ~/.volta/bin/npm test 2>&1 | tail -5
```

Expected: no errors, all tests pass.

- [ ] **Step 5.3: Commit**

```bash
cd /Users/antrophos/git/jira-copilot && git add README.md && git commit -m "docs: document PR review token optimization settings in README"
```

---

## Task 6: Final verification

- [ ] **Step 6.1: Full test suite**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass, no regressions.

- [ ] **Step 6.2: Full compile**

```bash
cd /Users/antrophos/git/jira-copilot && ~/.volta/bin/npm run compile 2>&1
```

Expected: no TypeScript errors.

- [ ] **Step 6.3: Smoke-check adaptive chunking math**

Run this quick sanity check in Node to confirm the budget math works as expected for a typical 140-file PR on a 200k-context model:

```bash
node -e "
const budget = Math.floor(200000 * 0.7); // 140000
const FIXED = 1500;
const FILE = 50;
const avgDiff = 500 * 4; // 500 lines * 4 chars/token * 4 = 2000 chars → 500 tokens
const perFile = FILE + avgDiff / 4; // 50 + 500 = 550
let chunks = 0, current = 0, files = 0;
for (let i = 0; i < 140; i++) {
  if (files > 0 && current + perFile > budget) { chunks++; current = FIXED; }
  current += perFile; files++;
}
if (files > 0) chunks++;
console.log('chunks for 140 files on 200k model:', chunks);
"
```

Expected output: `chunks for 140 files on 200k model: 2` (or similar small number, well under the old 14).
