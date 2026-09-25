# Bitbucket PR Review

Part of `@bitbucket` — the PR review walkthrough, multi-turn follow-ups, posting comments back to Bitbucket, and options for reducing token usage on large PRs. See the main [README](../../README.md) for setup and core commands first.

## PR review

Paste any pull request URL into the chat:

```text
@bitbucket https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
@bitbucket https://bitbucket.org/myworkspace/myrepo/pull-requests/7
```

Trailing segments like `/overview`, `/diff`, or `/commits` are stripped automatically.

The plugin:

1. Fetches PR metadata and the full unified diff
2. Applies any configured `reviewExcludePatterns` to skip files before analysis
3. Splits the changed files into chunks sized to the model's context window, capped at about 24 000 tokens per call so every file gets a real share of the model's answer — large PRs take more calls in exchange for depth
4. For each chunk: sends a structured diff-only prompt and, if the LLM requests additional context files, fetches them (as many as fit) and runs a second pass that sees both those files and the first pass's findings — it can add findings or retract one, and keeps the rest; the second pass is skipped in `quick` mode
5. Merges all findings across chunks and streams a single structured report ordered by file, with numbered findings and severity badges

> **Deleted files are reviewed** — removing a validation or error-handling block can be just as risky as adding code. Files with no textual diff (binary, pure renames, or mode-only changes) are skipped and reported in the chat.
>
> **Very large files** that exceed the per-call budget on their own are split along diff-hunk boundaries and reviewed across several calls, rather than failing or being truncated.

For token-saving options (`quick` mode, file exclusion, context tuning) see [Reducing token usage on large PRs](#reducing-token-usage-on-large-prs).

### Upfront focus question

Give the reviewer something specific to look for before it starts:

```text
@bitbucket question: does this change handle concurrent writes safely? https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
@bitbucket https://bitbucket.org/myworkspace/myrepo/pull-requests/7 -- does this change handle concurrent writes safely?
```

It combines freely with `quick`/`deep`, in either order:

```text
@bitbucket review deep <url> question: Did I introduce any regression?
```

Mode keywords and the focus question are fully independent — set the review depth,
the focus, both, or neither, in any order. The focus question reaches every LLM
call in the pipeline, including the deep-mode critic pass, not just the first
analysis pass, so it keeps shaping the review from start to finish. When a
question is supplied, the review output starts with a `_focus: <question>_` line.

Example output:

```text
## PR #42 — Add OAuth login flow
_by Jane Smith → main · 3 files changed_

2 🔴 critical · 1 🟡 warning · 3 🔵 suggestions

---

**📄 src/auth/login.ts**
**#1** 🔴 `L42` SQL injection — user input concatenated into query string
→ Use parameterised queries or a query builder instead.
```

## Follow-ups and posting comments

After a review, the session stays active for multi-turn follow-ups. Reference a finding by number, describe it in natural language, or ask any general question about the PR:

```text
@bitbucket #2 is this always a problem or only if the site has third-party scripts?
@bitbucket can the localStorage finding be downgraded if we enforce a strict CSP?
@bitbucket explain the SQL injection issue and show a fixed version
@bitbucket is this change backwards-compatible with the v2 API?
@bitbucket are there missing test cases for the new endpoints?
```

Questions without a `#N` reference automatically answer at the PR level using the title and all findings as context. For reviews run after this feature, the underlying diff is stored alongside the session, so these general follow-ups can also draw on the actual code changes — not just the findings summary — giving more grounded answers to broad questions like "did I introduce a regression?".

Each AI response ends with a `_~N estimated tokens_` line (using a `chars/4` heuristic — VS Code's LM API does not expose exact counts).

To exit the review session, reply `c` or `cancel`:

```text
c
```

Push selected findings back to Bitbucket as PR comments:

```text
@bitbucket #2 #3, #5 add to review
@bitbucket add #1 #2 #3 to review
@bitbucket add all to review
@bitbucket #1 add to review this is blocking merge
```

The numbers and `add to review` keywords can appear in any order. `add all to review` selects every finding at once. Any extra text (after stripping the command keywords) becomes a brief reviewer note appended to each comment.

**Before posting, the plugin shows a preview** of each comment's exact text along with where it will land:

- `📌 Inline comment on line 42 of src/auth.ts` — the comment will be anchored to that diff line
- `⚠️ Line 42 could not be located in the diff — will fall back to activity feed comment` — the line was reported by the AI but isn't in the diff; you can cancel and investigate, or confirm to post as a general comment

Reply **`"post it"`** to post, **`(c)`** to cancel, or give a refinement instruction to adjust the comment text before posting. For example:

```text
make it more concise
focus on the security impact only
add that this affects all authenticated endpoints
```

> **Note (Bitbucket Cloud):** Posting comments requires the **Pull requests: Write** scope on your App Password. See [Store your Bitbucket credentials](../../README.md#3-store-your-bitbucket-credentials) in the main README.

## Reducing token usage on large PRs

The reviewer packs files into each LLM call up to the smaller of the model's context budget and about 24 000 tokens. The cap trades a few more calls on large PRs for a more thorough review of each file, and leaves room for the second pass's context files.

**Quick mode** — skips the second LLM pass (diffs only, no additional file context):

```
@bitbucket review quick https://bitbucket.company.com/...
```

Set `ticketSidekick.bitbucket.reviewMode` to `"quick"` to make this the default. Use `@bitbucket review deep <url>` to force standard mode for a single review.

**Excluding files** — skip files that don't need review (migrations, snapshots, generated code):

```json
"ticketSidekick.bitbucket.reviewExcludePatterns": [
  "**/migrations/**",
  "**/*.snap",
  "**/*.generated.ts"
]
```

Patterns use glob syntax. Both `*.snap` and `**/*.snap` work (bare filename patterns match at any depth).

**Manual context override** — if the model's context size isn't auto-detected, set it explicitly:

```json
"ticketSidekick.bitbucket.modelContextTokens": 128000
```
