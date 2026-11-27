# Manual checklist

What the automated tests cannot show: Ticket Sidekick in a real VS Code with Copilot, on the maintainer's managed machine (proxy, the organisation's Copilot policies) against real Jira and Bitbucket Data Center. Each migration step adds its part here and runs it on that step's **preview** build; the one normal release at the end of the migration reruns every part. See the release rule in [`migration-status.md`](migration-status.md).

Write down the build version, the date and anything that failed under the part you ran.

## Step 1: Jira tools and boards

Preparation: a test project with a few open bugs in two fix versions, one of them with subtasks; a `.jira-templates.json` with one cleanup rule (`closeSubtasks: true`, no `resolution`) and `ticketSidekick.jira.searchFields` and `cleanupFields` each set to one field.

**Tools and skills**

- [ ] `/ts-jira check` answers with the connection, without `@jira`.
- [ ] In Agent mode, "show me PROJ-1", "add a comment to PROJ-1 saying test", "move PROJ-1 to In Progress" each run one tool; the writing tools ask first and show what they write.
- [ ] `/ts-jira workflow PROJ-1` answers; the Getting-Started step "See your ticket workflow" is checked off.
- [ ] `/ts-jira-create` creates a ticket from a template after the draft; the step "Create your first ticket" is checked off.

**Ticket list**

- [ ] "show the open bugs in PROJ" opens the ticket list in an editor tab; the chat only says it opened.
- [ ] "show my team's open bugs in sprint <name>" opens the list on the narrowed query, shown under the title.
- [ ] A list of more than 50 tickets shows 50 a page; the selection holds across pages; the `searchFields` column is there.
- [ ] A field change with **Add value** on labels keeps the other labels on every ticket.
- [ ] Apply on rows of several pages: VS Code's dialog names the count and lists every ticket.
- [ ] Change a listed ticket in Jira, close and reopen the board (or restart VS Code): the board says it is out of date and allows only paging; **Refresh** shows the change and keeps the selection.

**Cleanup**

- [ ] `/ts-jira cleanup "<rule>"`, "run the cleanup <rule>" and `Ticket Sidekick: Run a cleanup rule` open the same cleanup board.
- [ ] Subtasks show beneath their ticket; only tickets can be selected; the `cleanupFields` column is there.
- [ ] A ticket in a status without a path to the target cannot be selected and says why.
- [ ] The resolution must be chosen before Preview; Apply moves the subtasks first, then the ticket.
- [ ] Apply on page 1 changes only page 1's tickets.
- [ ] `/ts-jira cleanup "<rule>" in <version>` uses that version in place of the rule's.

**Stable channel**

- [ ] A VS Code on the stable channel still has the last stable version (the release rule of [`migration-status.md`](migration-status.md) holds the stable channel until the migration is done); that version still has `@jira` and `@bitbucket`.

## Step 2: Import board (Veracode and Waltz)

Run on the pre-release build of the pull request that adds the import board, against Jira Data Center.

Preparation: a test project; a `.jira-templates.json` with two templates (one with an issue type, one without) and a cleanup rule for the test project's bug type; a Veracode Detailed Report with flaws that fold (same file and CWE, same line), at least one flaw on an existing ticket and one existing `veracode` ticket whose flaw is gone from the report; a Waltz OSS Report with the same mix, components with remediation dates, and an existing ticket without a Due Date; a second, newer copy of each report with a changed finding; a report over `ticketSidekick.<kind>.maxReportSizeMB`, a file that is not a report, and a report whose findings are all below the filter settings.

**Start screen**

- [ ] `Ticket Sidekick: Open Jira Import Board` opens the start screen. With `ticketSidekick.waltz.template` empty, picking Waltz OSS asks for a template; after the pick, the setting holds the name, and the next Waltz import does not ask.
- [ ] A template setting that names a template no longer in `.jira-templates.json` asks again, saying the template is not there.
- [ ] A template without an issue type lets you pick one of the project's issue types.
- [ ] `ticketSidekick.jira.defaultProject` empty: the start screen asks for the project; typing a few letters suggests Jira's projects, and a chosen or fully typed key is saved to the setting, so the next import does not ask. A key Jira does not know and a value that is not a key ask the same way.
- [ ] A typed key of a project Jira does not have is refused with its reason, and the setting is unchanged.
- [ ] With Jira's project list unreadable (for example a network block on `/rest/api/2/project`), the start screen says so and a typed key still works; **Open Setting** opens the setting.
- [ ] The oversize report, the file that is not a report and the report with nothing matching each show their reason, and **Open** stays disabled.
- [ ] With Jira not set up (base URL removed), the start screen shows the setup hint instead of **Open**.
- [ ] Opening the same file again in the same project offers **Open stored import** (with the template it was started with) and **Start over**; Start over discards it and uses the template now in the setting.

**Opening from chat**

- [ ] In Agent mode, "import the Veracode report reports/scan.xml" (a workspace path) with the settings complete opens the board loaded; the chat only says it opened.
- [ ] The same with a template setting empty opens the start screen with the kind and file filled in.
- [ ] Dragging the report file into the chat and asking for the import does the same.
- [ ] `/ts-jira import waltz <path>` opens the Waltz board.

**New**

- [ ] **Create** checkboxes, **Select all** and **Select none** set the rows; the count line follows.
- [ ] **Merge selected** on two rows shows them as one merge; **Unmerge** splits them again.
- [ ] **Preview create** lists the tickets; Apply with more than one ticket asks VS Code's dialog. Each Veracode ticket gets the Due Date from `ticketSidekick.veracode.slaDays`; each row then links its created ticket.
- [ ] In a project whose create screen lacks the Due Date field, the ticket is still created and its result says the Due Date was left out.
- [ ] **Add selected to ticket** as a comment: the preview shows the ticket's summary and status; Apply adds the labels and one comment and asks no VS Code dialog. That ticket's row on Already ticketed still offers its own action.
- [ ] **Add selected to ticket** as a rewrite on a resolved ticket: the preview warns it is resolved and lists the findings the rewrite drops; Apply rewrites title, description and labels and posts the comment.
- [ ] With more than 50 New rows selected, the preview creates 50 and says how many remain; the next Apply creates the rest.

**Already ticketed**

- [ ] With `ticketSidekick.jira.securityReportFields` set to a custom field, the tab shows the ticket's assignee and that field after Change; clicking a title sorts the rows (natural order, empty last, third click back to the report's order) without moving the picks or the chosen actions. Restart VS Code with a stored board and open it: it opens, and Refresh fills in the assignees.
- [ ] The tab opens on **Changed**, with the changed rows and the ticket without a Due Date ("No Due Date"); **Unchanged** and **All** show the others, each with its count.
- [ ] A row's action changes on its own; **Set all shown to** `leave` on **Changed** changes only those rows, and the rows under **Unchanged** keep theirs.
- [ ] Two rows of one ticket, one on `rewrite` and one on `leave`: the preview refuses and names them.
- [ ] Veracode `rewrite` on the ticket without a Due Date sets it; on a ticket with a Due Date it keeps it, or moves it earlier only when a joining flaw is due sooner. Waltz `rewrite` sets the Due Date from the report and the result says so.
- [ ] `new ticket` on a row whose tickets are all resolved creates a full ticket titled `… (follow-up to KEY)` and linked to the resolved ticket.
- [ ] Change a listed ticket in Jira, then apply a `rewrite` on it: it is not written, its result says it changed in Jira, and the board lists it until you drop it.

**Stale**

- [ ] The ticket whose flaw is gone is listed; checking it and choosing **Move to** (the cleanup rule first, then the reachable statuses) and a **Resolution** for a closing status makes **Preview close** ready. Apply asks VS Code's dialog and closes it.
- [ ] Stale tickets of two issue types, each with its own target, close in one Apply.
- [ ] A ticket of an issue type without a discovered workflow cannot be checked and says why; after `/ts-jira workflow <KEY>` and **Refresh**, it can.

**Accepted (Waltz)**

- [ ] **Preview accept CVEs of selected…** with a reason writes `.jira-oss-accepted.json` after Apply, with no VS Code dialog; the component leaves New when all its CVEs are accepted. On Already ticketed there is no accept-CVE control.
- [ ] **Preview accept components of picked…** on an Already-ticketed row takes it off Already ticketed and puts its open ticket on Stale.
- [ ] On **Accepted**, **Unaccept…** and **Unaccept component…** remove the entries after a preview, and the rows come back.
- [ ] With `.jira-oss-accepted.json` made invalid JSON, the board shows the warning and accept and unaccept are refused; the file is unchanged.

**Ticket merge**

- [ ] Waltz: pick two Already-ticketed rows, keep one, **Preview merge tickets…**: the preview shows the steps and the warnings (a resolved kept ticket, a ticket no import created). Apply asks VS Code's dialog and opens the **Ticket merge** tab.
- [ ] Veracode: the same closes the source without renaming it; a flaw the report no longer lists is named in the preview and in the comment on the closed ticket.
- [ ] Make a step fail (for example, remove your edit permission on one source): the merge tab shows the error and **Retry…**, **Ignore…** and **Stop…**; Retry after fixing it carries on, Ignore skips the step and carries on, Stop ends the merge.
- [ ] Sources of two issue types: the merge tab asks the target status and, where needed, the resolution for each; one Apply with one VS Code dialog closes them all.
- [ ] While the merge is unfinished, Apply on New is refused with a note to finish or stop the merge; selecting rows on New still works.
- [ ] **Refresh** while the merge waits: Already ticketed stays as the merge read it and stays marked out of date until the merge ends.
- [ ] When the merge ends, the tab lists steps not done and tickets closed without their resolution; **Acknowledge and close this tab** closes it, and the other tabs refresh or show their out-of-date mark.

**Search, export, reload**

- [ ] **Search matched tickets** finds an open matched ticket by a word of its summary; a word in no summary says so.
- [ ] **Save overview as CSV…** and **Save overview as Excel…** save the overview with the due-date columns. With `ticketSidekick.jira.overviewCsvDelimiter` set to `semicolon`, the CSV uses semicolons; a stale ticket the board closed is not in it.
- [ ] Replace the report file with the newer copy and **Reload report…**: the preview lists your unfinished choices; after Apply the changed finding shows and any dropped choice is named.

**Out of date and restart**

- [ ] With New rows merged but not created, unaccept a CVE on Accepted: New is marked out of date and offers only **Refresh**; Refresh brings the component back and keeps the merge.
- [ ] Change a matched ticket in Jira while Already ticketed has no unfinished choice, then **Refresh**: the tab shows the change without a mark.
- [ ] Real VS Code restart with a ticket merge waiting on a failed step and unapplied choices on New and Already ticketed: the board comes back with its merge tab, the failed step and its question, and every choice; the board's own earlier writes do not mark any tab out of date.
- [ ] Close VS Code during an Apply that creates several tickets: after the restart the created rows show their tickets and the next preview lists only the rest.
- [ ] Close VS Code while a ticket merge's opening Apply runs: after the restart the merge tab shows the finished steps and offers **Retry…** to carry on from the first waiting step.
- [ ] Install a build that changes the import board's stored format over a stored import: the board says it was rebuilt after an update, with the same file, template and issue type, and no earlier choices.
- [ ] Move the report file, then restore the board: writes are refused and **Pick the file again…** is offered; after picking it at its new place, the choices are still there and writes work.
- [ ] Turn Jira off (wrong base URL) and **Refresh**: the board keeps what it showed and refuses writes until a check passes.
- [ ] When every tab is handled, the board says there is nothing left to do and offers **Close**; export still works. **Close** closes the tab, and the import is no longer listed on the sessions board.
- [ ] Save a newer scan over the report file and open the same import again: tickets the board wrote for the earlier scan ask for a decision again where the new scan changed them.
- [ ] Two Already-ticketed rows on one resolved ticket: a new ticket for one row leaves the other row to decide.
- [ ] Type a filter on Already ticketed, wait for a background update, then press Enter (or click elsewhere): the table is filtered.
- [ ] On the start screen, make Open fail (for example with the report file removed), switch to another tab and back: the error is still shown.

**`@jira` and the ticket list**

- [ ] The Command Palette has no "Create Jira tickets from Veracode report" or "… from OSS report" command.
- [ ] Ticket list board: close VS Code during an Apply that moves several tickets; after the restart the moved tickets show as done and a new preview covers only the rest.

## Step 2: Email import and `@jira` removed

Run on the preview build on the managed machine, against Jira Data Center, with a few real `.eml` files (one with an attachment, one with a known disclaimer, one whose subject is already a ticket's summary).

**Start screen and model**

- [ ] `Ticket Sidekick: Open Jira Import Board`, kind **Email**, **Choose emails…** with three files: the screen says how many emails it will import; a file that is not an email is named and left out.
- [ ] With `ticketSidekick.email.template` empty, the start screen asks for a template once; the next email import does not ask.
- [ ] "Model for the email check" lists your models; picking one saves it to `ticketSidekick.email.checkModel` and says "The model answered."
- [ ] With the Local harness hidden (`chat.editor.localAgent.enabled: false`), the model still answers.

**Cleanup**

- [ ] An email with a pattern match opens on the cleanup with the block shown; **Strip and continue** creates a ticket without it, and the `.eml` file is unchanged.
- [ ] An email without a match asks first; **Continue without the model** sends nothing (the Output channel has no model call).
- [ ] **Preview model check…** names each email and the model; only **Apply** sends them. A block the model found can be saved as a pattern, and the next import finds it without the model.
- [ ] Close VS Code during a model check of several emails: after the restart the checked ones keep their result and the others ask again.

**New tab**

- [ ] The email whose subject is a ticket's summary is marked as a likely repeat, starts unselected, and **Add as comment to KEY** posts it there with sender, date and attachments.
- [ ] Creating two emails asks for the VS Code confirmation; each ticket has the subject, the body and the attachments.
- [ ] Delete one `.eml` after the board loaded, then create: that email is refused with "pick the file again", the other is created.
- [ ] With `ticketSidekick.email.deleteEmlAfterImport` on, a created email's file is deleted; a comment's file is kept.
- [ ] The email board shows no Reload report, no CSV or Excel export and no ticket search.

**From chat**

- [ ] `/ts-jira import email` opens the start screen; with `.eml` files attached, it opens loaded and says you agreed to the model check by attaching them.
- [ ] "Import these emails" in Agent mode with the files attached opens the board; Copilot says only that it opened.

**`@jira` is gone**

- [ ] Typing `@jira` in a chat offers no participant.
- [ ] The Command Palette has no "Create Jira ticket from email (.eml)" command.
- [ ] `ticketSidekick.jira.showConnectionInfo` is no longer in the Settings screen; `/ts-jira check` shows the connection.

## Step 3: PR review board

Run on the preview build of the review board on the managed machine, against Bitbucket Data Center and Jira Data Center, with a real pull request whose title names a Jira ticket, one small pull request (at most four batches) and, if you can, one large enough that the Data Center server cuts its diff. `@bitbucket` is already removed in this build, so the review board is the only way to review.

**Opening the board**

- [ ] `Ticket Sidekick: Review a pull request` opens "Review a pull request"; pasting the PR link and **Open** opens the board on its first step.
- [ ] `/ts-bitbucket review <link>` opens the same board; the chat answers only with the status the tool returns.
- [ ] In Agent mode, "review this pull request <link>" opens the board; Copilot says it opened and does not review the PR itself.
- [ ] Asking again for the same PR opens the stored review, not a new first step.

**Managed-machine probe** (run first; stop and report if it fails)

- [ ] Four concurrent model requests succeed: on a review of at most four batches, pick all four persona passes and **Run selected**; all four lines of the band move at the same time, and no more than two are refused as rate-limited.
- [ ] **Discuss in chat** opens Copilot Chat in Agent mode with the prompt typed in and not sent.

**First step**

- [ ] With `ticketSidekick.bitbucket.reviewModel` empty, **Review model** lists your models; picking one saves it to the setting.
- [ ] With the Local harness hidden (`chat.editor.localAgent.enabled: false`), the review still runs.
- [ ] Background **Jira ticket**: the key from the PR title is filled in, and a typed key replaces it; the box fills with the ticket's summary, description and newest comments, and what you leave in the box after trimming is what the review gets.
- [ ] A ticket key that does not exist: the box says it was not found, **Start** stays available, and the review then runs with no background; the band says why.
- [ ] `/ts-bitbucket review <link> PROJ-123 watch thread safety`: the first step opens with your text picked and the key kept in the ticket field; nothing runs before **Start**.
- [ ] Background **Your text** and **None**: Start runs without a ticket read; with your text, findings that go against it are marked *against goal*.
- [ ] A review stored by the build before this one: the board opens on the first step for the same PR with a notice that it was rebuilt, and nothing runs until **Start**.

**Running the review**

- [ ] While the regular pass runs, the band shows the progress by batch, **Stop**, the background and the tokens so far; findings appear in the list as each batch finishes, sorted by severity.
- [ ] During the pass, open a finding: it stays open and selected while new findings arrive; Explain, Rewrite and Post wait until the pass ends. With nothing opened, the detail pane shows the review so far (counts, files, batches, the reviewed commit).
- [ ] When the regular pass ends, the band opens with the counts by severity and against goal, the next passes (the suggested ones preselected) with **Run selected** and **Not now**, the background, **Not reviewed and dropped** and the token usage per pass.
- [ ] Opening a finding folds the band to one line with the counts, passes, background, not-reviewed count, tokens, **More passes** and **Run again**; **More passes** opens it again.
- [ ] **Stop** during a pass keeps the findings found so far.
- [ ] **Run selected** with two persona passes runs them at the same time, one band line each; existing finding numbers do not change. With the critic picked too, it starts only after both ended and checks only findings it has not checked yet.
- [ ] On a review of more than four batches, pick three or four persona passes: at most two run at once, and the next starts when one ends.
- [ ] **Stop** while passes run together ends all of them, keeps what each found, and offers the passes not finished again; a picked critic does not run.
- [ ] A cut Data Center diff: the cut files are fetched one by one, and **Not reviewed and dropped** lists any file still not reviewed.
- [ ] `/ts-bitbucket usage` counts the same calls for the month as the band shows.

**Findings**

- [ ] On a wide tab the list is on the left and the opened finding on the right, with its code from the reviewed commit and its line marked.
- [ ] Narrow the tab until the columns no longer fit: the list fills the tab, a finding opens over it, **← Back to the findings** and Escape return the focus to the same list entry, and the footer with Post and one **Copy** menu stays visible.
- [ ] Every control can be reached with the keyboard, and the markers are words, not colour alone.
- [ ] **Explain** on a finding answers in its discussion; a follow-up with **Ask** adds below the first answer instead of replacing it. Answers show headings, lists and highlighted code.
- [ ] After a follow-up, the draft says the discussion changed; **Regenerate** writes it again from the finding and the whole discussion, and **Undo** brings your edited text back.
- [ ] Edit a draft comment by hand, then **Rewrite** with an instruction; **Undo** brings back your text.
- [ ] **Preview** shows the draft as Markdown, as Bitbucket shows it after Post; **Edit** returns to the text box. A link in an answer or the preview opens only after VS Code asks.
- [ ] Select two findings and **Post 2 comments**: the VS Code confirmation names them; in Bitbucket, a finding with a verified line is an inline comment and one without is on the activity feed, and it renders as the preview did.
- [ ] **Copy for Teams** pastes as readable plain text in Teams; **Copy as Markdown** pastes as Markdown; neither has a requirements section.
- [ ] Close and reopen VS Code with the board open: the findings, discussions and drafts are still there.

**From chat**

- [ ] **Discuss in chat** on a finding opens Copilot Chat in Agent mode with a prompt naming the PR link and the finding number, not sent; add a question and send it: Copilot reads the finding with `bitbucket_read_findings` first, and the board's draft does not change.
- [ ] With the chat unable to open (for example Copilot Chat disabled), **Discuss in chat** copies the prompt and the board says to paste it.
- [ ] In that chat, ask Copilot to read a whole file around the finding: it uses `bitbucket_read_file` and gets the file at the reviewed commit; a path with `..` is refused.
- [ ] After a review, asking Copilot "explain finding 2" answers from `bitbucket_read_findings` with the same finding and its discussion; after a new commit on the PR, it says the review read an older commit.
- [ ] `/ts-bitbucket check` reports the connection; `/ts-bitbucket help review` explains the staged review.

**`@bitbucket` is gone**

- [ ] Typing `@bitbucket` in a chat offers no participant.
- [ ] `ticketSidekick.bitbucket.reviewMode`, `showTokenUsage` and `showConnectionInfo` are no longer in the Settings screen.
- [ ] The Bitbucket walkthrough's last step opens the review board and completes after a finished review.

## Agents window

Run on the preview build that declares `capabilities.agentsWindow.supported`, on the managed machine. Start each session from the Agents window, not from the editor's Chat view. Open point O23 in [`migration-status.md`](migration-status.md).

- [ ] The extension is listed as enabled in the Agents window, and **View → Output → Ticket Sidekick** shows it activated there.
- [ ] The session's tool list shows the Ticket Sidekick Jira and Bitbucket tools.
- [ ] "show me PROJ-1" runs `jira_view_ticket`; a writing tool asks first, as in the editor.
- [ ] `/ts-jira check` and `/ts-bitbucket check` are found and answer.
- [ ] `/ts-bitbucket review <link>` and "open the security report for PROJ" open their boards (note where the tab opens).
