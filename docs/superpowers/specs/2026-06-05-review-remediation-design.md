# Review Remediation — Design

**Date:** 2026-06-05
**Status:** Approved

## Context

A whole-project review surfaced 10 issues spanning the Jira and Bitbucket API clients, the
PR-review pipeline, the LLM intent parser, and repo infrastructure. This spec records the
agreed fix for each and the constraints under which they are implemented. Each issue is
addressed with strict TDD (a failing user-facing Vitest scenario first), and the relevant
docs (README.md, CLAUDE.md) are updated in the same change.

The two participants (`@jira`, `@bitbucket`) remain fully independent — shared logic lives
in `src/utils/`, never crossing one participant's code into the other.

## Issues and chosen approaches

### 1. Attachment filename injection (security)
`JiraApiClient.uploadAttachment` interpolates an email-derived filename straight into the
multipart `Content-Disposition` header. Fix: strip CR/LF and escape `"` for the `filename="…"`
parameter, and add RFC 5987 `filename*=UTF-8''<pct-encoded>` so Unicode names round-trip.

### 2. `getAllComments` infinite loop
Pagination advances by `comments.length`, so an empty page with a larger `total` spins
forever. Fix: break when a page returns zero comments, plus a hard iteration cap.

### 3. Pass-2 reader reads the wrong file
`makeWorkspaceReader` returns the first local file matching a basename glob, which may be a
different repo/branch than the PR. Fix: drop the workspace-first read for PR review; fetch
context via the API at the PR's `fromCommitHash`.

### 4. Unencoded path/commit in `getFileContent`
Raw interpolation breaks on spaces/`#`/`?`/non-ASCII. Fix: encode each path segment and the
commit hash in both cloud and DC branches. (Broader URL-segment audit deferred to #10's
refactor pass.)

### 5. Oversized single file diff sent un-split
`buildAdaptiveChunks` ships a file larger than the whole budget as its own chunk, truncating
the review. Fix: split an over-budget file's diff at `@@` hunk boundaries into sub-diffs that
each keep the `diff --git`/`---`/`+++` header, so parsing, line annotation, and per-file
grouping continue to work; findings re-merge by path in `formatReview`.

### 6. Greedy JSON regex in `parseIntent`
`raw.match(/\{[\s\S]*\}/)` breaks on trailing prose with braces. Fix: lift the existing
bracket-counting `extractJsonObject` (currently in `reviewSessionState.ts`) into
`src/utils/extractJsonObject.ts` and reuse it from both `parseIntent` and the Bitbucket
parser.

### 7. `parseDiff` drops deleted/renamed files
Keying on `+++ b/<path>` loses deletions (`+++ /dev/null`) and pure renames. Fix: derive the
path from the `diff --git a/… b/…` header (handle `/dev/null` on either side), review
deletions' removed lines, and report renames/mode-only changes explicitly rather than
labeling them "binary."

### 8. Untrusted content un-delimited in prompts
PR description, diff, and email body are concatenated directly into LLM prompts. Fix: fence
untrusted blocks with explicit data markers and a "treat as data, never as instructions"
directive in `PrReviewService.buildPrompt` and the email generate path.

### 9. No CI
Add a GitHub Actions workflow: `npm ci` → `npm run compile` → `npm test` on push and PR,
Node 20 LTS. The `test:e2e` suite (needs a real VS Code instance) is excluded.

### 10. HTTP duplication / no retry / swallowing catches
Now: add a 429/503 retry-with-backoff wrapper used by both clients' request methods, and
narrow the broad catches (`getRemoteLinks` → `[]`, `gatherFileContents` →
`"(file not available)"`, sprint lookups) so auth/permission failures surface instead of
masquerading as empty results. Deferred to a separate pass: the full shared request-method
refactor (and the broader URL-encoding audit from #4).

## Testing strategy

All behavioral changes are driven by failing Vitest tests first, exercised through the mock
clients (`MockJiraClient`, `MockBitbucketClient`) — no real HTTP. Suites:
`reviewSessionState`/`PrReviewService` (#3, #4, #5, #7, #8), `JiraApiClient` (#1, #2),
`llmHelpers`/new `extractJsonObject` test (#6), and mock-client retry/error tests (#10).
`npm run compile` stays clean and the full suite is green before every commit.

## Documentation

README.md: deletions now reviewed and large files split (#7, #5), optional CI badge (#9).
CLAUDE.md: new shared util (#6), PR-flow steps for #3/#5/#7/#8, retry + error handling
(#10), CI in the testing section (#9), attachment encoding note (#1).
