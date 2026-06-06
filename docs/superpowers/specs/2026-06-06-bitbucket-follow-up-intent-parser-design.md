# Bitbucket Follow-up Intent Parser — Design

**Date:** 2026-06-06
**Status:** Approved

## Context

The Bitbucket PR review multi-turn follow-up handler in `BitbucketParticipant.ts` dispatches user commands using three separate helper functions exported from `reviewSessionState.ts`:

- `isAddToReviewIntent(msg)` — detects "add to review" commands
- `resolveByNumbers(msg, findings)` — extracts finding IDs from `#N` refs
- `extractUserNote(msg)` — strips keywords/numbers to get any user note
- `resolveByNumber(msg, findings)` — resolves a single `#N` for explain flow

Three bugs exist in this setup:

| Bug | Input | Root cause |
|-----|-------|------------|
| A | `explain #3` → uncertain LLM response | `Developer's question: explain #3` is sent verbatim; LLM hedges about what `#3` refers to even though the finding is already in context |
| B | `add all to review` → not recognized | `isAddToReviewIntent` requires `/#\d+/`; "all" with no number fails |
| C | `add #1 #2 #3 #4 to review` → not recognized | VS Code Chat's `#` variable picker may intercept `#N` tokens mid-phrase and strip them before the prompt reaches the participant |

## Design

### New unified parser

Replace the four helpers with a single `parseFollowUpIntent` function returning a discriminated union:

```typescript
export type FollowUpIntent =
  | { kind: 'add'; targets: number[] | 'all'; note: string }
  | { kind: 'explain'; findingRef: number | null; question: string };

export function parseFollowUpIntent(message: string): FollowUpIntent
```

### Intent classification rules

**`add` intent** — fires when message contains both `\badd\b` and `\breview\b` (any order, case-insensitive):

- `#N` refs present → `targets: number[]` (deduplicated, ordered as found)
- `\ball\b` present, OR no `#N` and no specific targets → `targets: 'all'`
- `note` = message with `#N` refs, "add", "to", "review", "all", commas/semicolons stripped and trimmed

**`explain` intent** — everything else:

- `findingRef: N` if a `#N` is found (first match); `null` if not
- `question` = message with any `#N` replaced by `"this finding"` — fixes Bug A by removing the ambiguous number from the text the LLM sees

### Caller changes in `BitbucketParticipant.ts`

The existing branching logic:

```typescript
if (isAddToReviewIntent(prompt)) {
  const selectedFindings = resolveByNumbers(prompt, session.findings);
  const userNote = extractUserNote(prompt);
  ...
}
const exactFinding = resolveByNumber(prompt, session.findings);
```

Becomes:

```typescript
const intent = parseFollowUpIntent(prompt);
if (intent.kind === 'add') {
  const selectedFindings = intent.targets === 'all'
    ? session.findings
    : resolveByIds(intent.targets, session.findings);
  ...
}
// intent.kind === 'explain'
const exactFinding = intent.findingRef != null
  ? session.findings.find(f => f.id === intent.findingRef)
  : null;
// then LLM fuzzy-match using intent.question (cleaned text)
```

A small private `resolveByIds(ids: number[], findings: ReviewFinding[])` helper replaces `resolveByNumbers` — takes already-parsed `number[]` instead of a raw string. It is not exported; only `parseFollowUpIntent` is.

### Files changed

| File | Change |
|------|--------|
| `src/participant/reviewSessionState.ts` | Add `FollowUpIntent` type + `parseFollowUpIntent`; remove `isAddToReviewIntent`, `resolveByNumbers`, `extractUserNote`, `resolveByNumber` (all subsumed); add private `resolveByIds` |
| `src/participant/BitbucketParticipant.ts` | Replace 4 separate calls with `parseFollowUpIntent`; use `intent.question` in the follow-up LLM prompt |
| `src/test/PrReviewService.test.ts` | Replace old helper test suites with `parseFollowUpIntent` test suite (TDD: written first) |
| `CLAUDE.md` | Update `reviewSessionState.ts` description to mention `parseFollowUpIntent` |
| `README.md` | Update any follow-up command examples if they document "add to review" syntax |

### Test cases (TDD — written before implementation)

**Add intent:**

```
"add #1 #2 #3 #4 to review"  → { kind:'add', targets:[1,2,3,4], note:'' }
"add to review #1 #2 #3 #4"  → { kind:'add', targets:[1,2,3,4], note:'' }
"add all to review"           → { kind:'add', targets:'all', note:'' }
"add all findings to review"  → { kind:'add', targets:'all', note:'' }
"#1 #2 add to review"         → { kind:'add', targets:[1,2], note:'' }
"please add #1 and #4 to review" → { kind:'add', targets:[1,4], note:'' }
"add #2 to review blocking CI"   → { kind:'add', targets:[2], note:'blocking CI' }
"add to review"               → { kind:'add', targets:'all', note:'' }  // no qualifier → all
```

**Explain intent:**

```
"explain #3"                  → { kind:'explain', findingRef:3, question:'explain this finding' }
"#4 explain"                  → { kind:'explain', findingRef:4, question:'this finding explain' }
"what does #3 have to do with auth?" → { kind:'explain', findingRef:3, question:'what does this finding have to do with auth?' }
"how to fix the SQL issue"    → { kind:'explain', findingRef:null, question:'how to fix the SQL issue' }
"tell me more"                → { kind:'explain', findingRef:null, question:'tell me more' }
"#2 review"                   → { kind:'explain', findingRef:2, question:'this finding review' }
```

### CLAUDE.md update

The description for `src/participant/reviewSessionState.ts` currently says:

> `parsePrUrl`, `hasPrUrl`, `parseDiff`, …`dedupeFindings`, `extractHunkAround`, `selectFilesWithinBudget`, `parseCriticKeep`

Add to that list: `parseFollowUpIntent` (parses multi-turn follow-up messages into a typed intent — `add` with finding targets or `'all'`, or `explain` with cleaned question text).

### README.md update

If the README documents follow-up command syntax (`@bitbucket add to review #1 #2`), add `@bitbucket add all to review` as a supported shorthand.

## Verification

1. `npm run compile` — no TypeScript errors
2. `npm test` — all tests green (including new `parseFollowUpIntent` suite)
3. Manual smoke test in VS Code with a real PR review session:
   - `@bitbucket explain #3` → confident answer referencing the finding, no hedging
   - `@bitbucket add all to review` → comment preview for all findings
   - `@bitbucket add #1 #2 #3 #4 to review` → comment preview for findings 1–4
