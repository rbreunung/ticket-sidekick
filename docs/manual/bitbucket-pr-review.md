# Pull Request Review

A Bitbucket pull request is reviewed on the **review board**, an editor tab like the other [boards](boards.md). See the main [README](../../README.md#bitbucket-setup) for the Bitbucket setup first.

## Opening a review

Any of these opens the review board of a pull request:

- **Command Palette:** `Ticket Sidekick: Review a pull request`, then paste the link as shown in the browser and press **Open**.
- **Typed command:** `/ts-bitbucket review <link> [PROJ-123] [text]` in a Copilot chat. A Jira key you type (`PROJ-123`) and the rest of the text become the background for the reviewer (see below).
- **Copilot Agent mode:** paste the link and ask for a review in your own words. Copilot opens the board with `bitbucket_open_review` and says only that it opened; it does not review the pull request itself.

```text
/ts-bitbucket review https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/42
/ts-bitbucket review https://bitbucket.org/myworkspace/myrepo/pull-requests/7 PROJ-123
/ts-bitbucket review https://bitbucket.org/myworkspace/myrepo/pull-requests/7 watch thread safety
```

Trailing segments like `/overview`, `/diff` or `/commits` in the link are ignored. Asking again for a pull request that already has a stored review opens that review instead of starting a new one. A review stored by an earlier version of Ticket Sidekick is not kept: the board opens on the first step for the same pull request with a notice saying so, and nothing runs until you press **Start**.

## The first step

The board always stops on its first step before anything runs. No model call happens until you press **Start**.

- **Review model.** Every model call of the review uses this model: the passes, the discussion of a finding, Regenerate and Rewrite. When `ticketSidekick.bitbucket.reviewModel` is empty or the model is not available, the board asks for one and saves your pick to that setting.
- **Background.** What the change is meant to do, for the reviewer. Pick one:
  - **Jira ticket** — the key from your request, or else the one the pull request title names, is filled in; you can type another. The ticket is read into an editable box: its summary, description and newest comments, within size limits. Trim it as you like; what you leave in the box is what the reviewer gets. When the ticket cannot be read (not found, no access, Jira not set up), the box says why and you can switch to your own text or none; **Start** still works and the review then runs with no background, which the board says. This needs Jira set up; without it the ticket is unavailable and the board says why.
  - **Your text** — a goal, or what the reviewer should watch for, such as "does this handle concurrent writes safely?".
  - **None** — no background.

  When your request names both a ticket and text, your text is picked and the key stays in the ticket field, so you can switch before **Start**. The background reaches every review call: every pass, the critic and the discussion of a finding. Ticket text is sent as data the reviewer must not take as instructions; your own text is sent as instructions. With a background, the reviewer also reports changes that go against it; such a finding is marked *against goal*.

## Running the review

**Start** runs the regular pass over the pull request. The **summary band** above the findings follows the review:

- **While a pass runs** it shows the progress by batch with **Stop**, the background in use and the tokens so far. **Stop** ends the pass early; what it found so far is kept.
- **When the regular pass ends** it opens with the finding counts by severity and *against goal*, the next passes to run (the suggested ones preselected, the other persona passes and the critic offered) with **Run selected** and **Not now**, the background, what was not reviewed and the token usage per pass.
- **Once you start on the findings** it folds to one line with the counts, the passes run, the background, how many files were not reviewed, the tokens, **More passes** and **Run again**. **More passes** opens it again.

Findings appear in the list as each batch finishes, while the pass still runs, and you can open and read them. Nothing is selected until you pick a finding, and a finding you opened stays open while new ones arrive. Explain, Rewrite and Post wait until the pass ends.

You decide what happens next, now or later: keep the findings as they are, run the suggestion, or pick any extra passes and press **Run selected**: **Security**, **Performance**, **Reliability**, **Maintainability** and the **Critic**. The persona passes you pick run at the same time, all of them on a review of up to four batches and two at a time on a larger one; the band shows each pass on its own line, and **Stop** ends all of them, keeping what each found. The critic runs last, after the others, so it checks their findings too. When a run ends, the band offers the passes not run yet, and the critic when there are findings it has not checked.

If the model limits the requests while passes run together, the remaining passes run one after another and the refused batches run once more at the end; the band says so. If the model refuses again, is blocked or the quota is used up, the run stops at once with a message, and the passes it did not finish are offered again. Try again later.

The critic checks the findings it has not checked yet. It removes a finding it cannot confirm, or, when you already worked on that finding (discussed it or drafted a comment), labels it *probably a false alarm* instead. Later passes see the files the regular pass saw, read at the reviewed commit. Each finding keeps its number for the whole review, so a removed finding leaves a gap.

A new commit on the pull request never starts a review by itself. The board says the review is out of date; **Run again** reviews the pull request at the new commit after a confirmation. **New review** goes back to the first step.

### What the board shows

On a wide tab the **findings list** is on the left and the **detail pane** of the finding you opened on the right. On a narrow tab the list fills the tab and a finding opens over it; **← Back to the findings** or Escape returns to the same entry in the list.

- **The list** — each finding with a checkbox for Post and Copy, its number, severity (Critical, Warning, Suggestion), title, file and line, and markers in words: *against goal*, *probably a false alarm*, a drafted and a posted comment, *location unverified* for a finding whose quoted code could not be found in the diff, and *low confidence* below `ticketSidekick.bitbucket.confidenceThreshold`. Findings are never hidden for either reason. The list is sorted by severity, then by confidence. A pass with no findings says "No issues found".
- **The footer** under the list — **Select all**, **Post N comments**, **Copy for Teams** and **Copy as Markdown** (one **Copy** menu on a narrow tab). It stays visible while a finding is open over the list.
- **The detail pane** — the finding's description, recommendation, line facts (verified or not, new or existing code, confidence, the passes that found it), the code around the finding from the reviewed commit, its discussion and its draft comment. With no finding opened it shows the review so far: the counts, the files and batches reviewed and the reviewed commit.
- **Not reviewed and dropped** (in the band) — files left out (no text change, `reviewExcludePatterns`, a Data Center diff cut short and not fetched, a failed batch), findings dropped for naming a file outside the pull request, and findings the critic removed.

If no batch of the regular pass could be reviewed, the board shows a failure banner and no findings, never "No issues found"; **Run again** tries again. If only some batches failed, the other findings are shown under a banner. The "Ticket Sidekick" output channel (View → Output) has the details.

## Findings: discussion, comments and copy

- **Explain** starts a discussion of the finding in the detail pane, using its code, the pull request title and description, the background and the discussion so far. **Ask** adds a follow-up question and its answer below the earlier ones. The discussion is kept with the review.
- **Discuss in chat** opens Copilot Chat in Agent mode with a short prompt naming the pull request and the finding; add your question and send it. Copilot reads the finding, its discussion and the review's background with `bitbucket_read_findings`, and can read whole files at the reviewed commit with `bitbucket_read_file`. If the chat cannot be opened, the prompt is copied to the clipboard for you to paste. The board's draft does not change.
- **Draft comment** is a comment you edit by hand, made from the finding and the first answer of its discussion. **Preview** shows it as Bitbucket will show it after Post; **Edit** goes back to the text box. **Rewrite** with an instruction ("make it shorter", "focus on the security impact") rewrites it with the review model; **Undo** brings back your text. When the discussion has grown since the draft was made, the draft says so and **Regenerate** writes it again from the finding and the whole discussion; your edits are replaced only then, and **Undo** brings them back.
- Answers and the preview are shown as Markdown, with headings, lists and highlighted code. They never run HTML, scripts, images or command links; a web link opens only after VS Code asks you.
- **Post N comments** posts the selected drafts after a VS Code confirmation that names them. A finding with a verified line becomes an inline comment on that line; one without goes to the pull request's activity. Each comment's result is shown, and only the failed ones are offered again. Bitbucket Cloud needs the **Pull requests: Write** scope on the App Password.
- **Copy for Teams** puts the selected findings, or all of them, on the clipboard as plain text grouped by severity, with the pull request's title, author, branch and link and each finding's discussion. **Copy as Markdown** does the same as Markdown for anywhere else.

The review, its discussions and drafts are kept in a stored session, so the board comes back after a restart.

## From a chat

After a review, ask Copilot about it in your own words, such as "explain finding 2" or "did this PR introduce a regression?". Copilot reads the stored review with `bitbucket_read_findings` (the summary, the findings list, or one finding with its code, discussion, draft, the review's background and the commit the review read), a whole file at that commit with `bitbucket_read_file`, and the diff with `bitbucket_getPullRequestDiff`.

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
