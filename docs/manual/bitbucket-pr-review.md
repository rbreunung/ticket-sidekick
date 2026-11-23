# Pull Request Review

A Bitbucket pull request is reviewed on the **review board**, an editor tab like the other [boards](boards.md). See the main [README](../../README.md#bitbucket-setup) for the Bitbucket setup first.

## Opening a review

Any of these opens the review board of a pull request:

- **Command Palette:** `Ticket Sidekick: Review a pull request`, then paste the link as shown in the browser and press **Open**.
- **Typed command:** `/ts-bitbucket review <link> [question]` in a Copilot chat. A Jira key you type (`PROJ-123`) becomes the ticket to check against, the rest becomes the question.
- **Copilot Agent mode:** paste the link and ask for a review in your own words. Copilot opens the board with `bitbucket_open_review` and says only that it opened; it does not review the pull request itself.

```text
/ts-bitbucket review https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
/ts-bitbucket review https://bitbucket.org/myworkspace/myrepo/pull-requests/7 PROJ-123 does it handle empty input?
```

Trailing segments like `/overview`, `/diff` or `/commits` in the link are ignored. Asking again for a pull request that already has a stored review opens that review instead of starting a new one.

## The first step

The board always stops on its first step before anything runs. No model call happens until you press **Start**.

- **Review model.** Every model call of the review uses this model: the passes, Explain, Rewrite, the goal rewording and the requirements check. When `ticketSidekick.bitbucket.reviewModel` is empty or the model is not available, the board asks for one and saves your pick to that setting.
- **Requirements source.** What the review checks the pull request against:
  - **Jira ticket** — type a key, or press **Use PROJ-123** when the pull request title names one. A key you type wins over the title's. This needs Jira set up; without it the ticket is unavailable and the board says why.
  - **A goal** — type what the change should do, then press **Reword**. The board rewrites it into in-scope and out-of-scope points you can correct before Start. Nothing is reworded unless you press Reword.
  - **None** — no requirements check.
- **Question** (optional) — something specific to look for, such as "does this handle concurrent writes safely?". It reaches every review call.

## Running the review

**Start** runs the regular pass over the pull request and shows its steps while it runs ("Reading the pull request…", then each batch). **Stop** ends a pass early; what it found so far is kept.

When the regular pass is done, the board shows the findings and, above them, the extra passes the review suggests from what it saw. The suggestion can be empty. You decide what happens next, now or later:

- keep the findings as they are,
- run the suggestion,
- or pick any extra passes under **Passes to run** and press **Run selected**: **Security**, **Performance**, **Reliability**, **Maintainability** and the **Critic**.

The critic checks the findings it has not checked yet. It removes a finding it cannot confirm, or, when you already worked on that finding (explained it or drafted a comment), labels it *probably a false alarm* instead. Later passes see the files the regular pass saw, read at the reviewed commit. Each finding keeps its number for the whole review, so a removed finding leaves a gap.

A new commit on the pull request never starts a review by itself. The board says the review is out of date; **Run again** reviews the pull request at the new commit after a confirmation. **New review** goes back to the first step.

### What the board shows

- **Findings (N)** — each finding with its severity (Critical, Warning, Suggestion), file and line, description, recommendation, provenance (new, existing or removed code), confidence and the passes that found it. A finding whose quoted code could not be found in the diff is marked *location unverified*; one below `ticketSidekick.bitbucket.confidenceThreshold` is marked *low confidence*. Findings are never hidden for either reason.
- **Requirements coverage** — when a ticket or goal was chosen: the requirements the check found, each met, not evident or unclear, and the changed files the ticket does not account for. After changing the goal, **Re-check** redoes only the coverage; the findings stay.
- **Not reviewed and dropped** — files left out (no text change, `reviewExcludePatterns`, a Data Center diff cut short and not fetched, a failed batch), findings dropped for naming a file outside the pull request, and findings the critic removed.
- **Token usage per pass** — the input and output tokens of each pass and of Explain and Rewrite.

If no batch of the regular pass could be reviewed, the board shows a failure banner and no findings, never "No issues found"; **Run again** tries again. If only some batches failed, the other findings are shown under a banner. The "Ticket Sidekick" output channel (View → Output) has the details.

## Findings: Explain, comments and copy

- **Explain** answers under the finding, using its code, the pull request title and description and your question. Explaining again replaces the answer.
- **Comment for #N** is a draft you edit by hand. **Rewrite** with an instruction ("make it shorter", "focus on the security impact") rewrites it with the review model; **Undo** brings back your text.
- **Post N comment(s)** posts the selected drafts after a VS Code confirmation that names them. A finding with a verified line becomes an inline comment on that line; one without goes to the pull request's activity. Each comment's result is shown, and only the failed ones are offered again. Bitbucket Cloud needs the **Pull requests: Write** scope on the App Password.
- **Copy … for Teams** puts the selected findings, or all of them, on the clipboard as plain text grouped by severity, with the pull request's title, author, branch and link and the requirements coverage when there is one. **Copy … as Markdown** does the same as Markdown for anywhere else.

The review, its explanations, drafts and coverage are kept in a stored session, so the board comes back after a restart.

## From a chat

After a review, ask Copilot about it in your own words, such as "explain finding 2" or "did this PR introduce a regression?". Copilot reads the stored review with `bitbucket_read_findings` (the summary, the findings list or one finding with its code, explanation and draft) and the diff with `bitbucket_getPullRequestDiff`.

- `/ts-bitbucket check` tests the Bitbucket connection.
- `/ts-bitbucket usage` shows the tokens the reviews used, per month and model.
- `/ts-bitbucket help review` explains the review in a few lines.

## Token usage

Every model call of a review is counted with the editor's tokenizer for the model in use; a `~` marks a figure that had to be estimated. Cache and reasoning tokens are not available and are not counted. The board shows the usage per pass, and `/ts-bitbucket usage` the running total per month and model on your machine:

```text
| Month   | Model             | Input     | Output  | Calls |
| ------- | ----------------- | --------: | ------: | ----: |
| 2026-10 | claude-sonnet-4.5 | 1,240,000 | 188,000 |    27 |
```

The table covers the current month and the two before it; older months are deleted. Only counters are stored, never pull request content. The extension holds no prices, and your Copilot plan may bill differently. Totals are per machine and do not sync.

## Reducing token usage on large pull requests

The review packs files into each model call up to the smaller of the model's context budget and about 24 000 tokens, so every file gets a real share of the model's answer; large pull requests take more calls in exchange. A file too large for one call is split along its diff hunks. Deleted files are reviewed too.

- **Run fewer passes.** The regular pass alone is the cheapest review; extra passes are only run when you pick them.
- **Exclude files** that don't need a review (migrations, snapshots, generated code). Both `*.snap` and `**/*.snap` match at any depth:

  ```json
  "ticketSidekick.bitbucket.reviewExcludePatterns": ["**/migrations/**", "**/*.snap", "**/*.generated.ts"]
  ```

- **Less surrounding code.** Each change is sent with 12 unchanged lines around it by default. Lower it on very large pull requests:

  ```json
  "ticketSidekick.bitbucket.reviewContextLines": 6
  ```

- **Context size.** If the model's context size isn't detected, set it yourself, and adjust the share a call may use with `ticketSidekick.bitbucket.contextBudgetRatio`:

  ```json
  "ticketSidekick.bitbucket.modelContextTokens": 128000
  ```

See [Settings Reference → Bitbucket](settings-reference.md#bitbucket-settings-reference) for every `ticketSidekick.bitbucket.*` setting.
