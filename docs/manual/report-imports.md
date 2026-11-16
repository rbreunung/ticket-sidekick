# Report Imports (Email, Veracode, Waltz)

> **Where each import runs.** All three imports run on the [import board](boards.md#import-board). Open it with **Ticket Sidekick: Open import board**, `/ts-jira import <veracode, waltz or email> [PATH ...]`, or by asking Copilot with the files' paths. The `@jira` chat participant and its import commands are gone.

Turns `.eml` emails, a Veracode Detailed Report, or a Waltz OSS Report into Jira tickets. See the main [README](../../README.md) for setup and core commands first.

## Emails (.eml)

Download the email from OWA using **More actions → Download message** to save a `.eml` file, then:

1. Open the import board and pick **Email** as the kind, or type `/ts-jira import email` in a Copilot chat. You can also attach the `.eml` files to the message, or name them: `/ts-jira import email mails/escalation.eml`
2. Choose one or more `.eml` files (at most 50, and at most `ticketSidekick.email.maxBatchSizeMB` in total). A file that is not an email is named and left out
3. Check the project and the template. The template comes from `ticketSidekick.email.template`; when it is empty the start screen asks for one once and saves it. One template and issue type apply to all emails of the import
4. **Open**. If boilerplate was found, or an email can be checked by the model, the [cleanup step](#removing-confidentiality-headers-footers-and-signatures) comes first
5. Each email is a row on the **New** tab. Create tickets for the selected emails, or add emails to an existing ticket as comments, each after a preview and **Apply**. Creating more than one ticket asks you to confirm in a VS Code dialog

Each ticket gets the email's subject as its summary and its body as the description. Tables in the email body (including those written in desktop Outlook or Word) arrive as Jira tables with a header row, and empty cells stay empty. A table that only lays out a signature or logo is flattened into plain lines. Inline images are uploaded as Jira attachments and embedded as thumbnails at their position; file attachments are uploaded to the ticket. A failed upload is named in the result and does not fail the ticket. Individual attachments larger than 25 MB are rejected with a clear message.

The board does not keep the attachments themselves: it reads them from the `.eml` file again when it writes. If a file was moved or deleted in the meantime, that email is not written and the result says so; the other emails are written.

### Likely repeats

Before anything is created, the board searches the project for tickets whose summary is an email's subject, ignoring `RE:`, `AW:`, `FW:` and `WG:` prefixes, spacing and case. Such an email is marked **Likely a repeat of PROJ-42**, starts unselected, and offers **Add as comment to PROJ-42**. You can still select it to create a new ticket. When the search fails, the tab says so and marks nothing.

### Adding an email as a comment

Select one or more emails, type the ticket key next to **Add selected to ticket** and preview. Each email becomes one comment with the sender and received date as a header, followed by the body in Jira markup, and its attachments are uploaded to that ticket. After the cleanup's strip, only the attachments that remain are uploaded. The `.eml` file is kept, whatever `ticketSidekick.email.deleteEmlAfterImport` says.

## Removing confidentiality headers, footers and signatures

Before the emails become tickets or comments, the board looks for boilerplate in every message of each thread, including quoted and forwarded ones: confidentiality headers at the top, legal footers and disclaimers at the bottom, and signature blocks with their logos. Nothing is removed until you say so, and the `.eml` files are never changed.

**Your patterns first.** List the texts your company repeats in the `ticketSidekick.email.boilerplatePatterns` user setting (see [Settings Reference](settings-reference.md#report-import-settings) for the format). Every email is checked against them. Without an end phrase, a header covers the line(s) its start phrase is on — add an end phrase for multi-line headers.

**The model only with your yes.** If an email matches none of your patterns, the board asks whether a language model may look at those emails:

| Control | What happens |
|---|---|
| **Preview model check…** | Shows exactly which emails would be sent, to which model. Nothing is sent until you **Apply**. Emails are sent one at a time; an email longer than 30,000 characters is never sent and shows *Too long for the check* |
| **Continue without the model** | Nothing is sent. Those emails show *Not checked* and import unchanged |

The model is `ticketSidekick.email.checkModel`, or `ticketSidekick.bitbucket.reviewModel` when that one is empty. When both are empty, pick a model in the list on the board: the preview then also says it saves your pick to `ticketSidekick.email.checkModel`. The start screen shows the same model and lets you check that it answers. Dragging the emails into a Copilot chat counts as your yes for those emails; the board still shows the preview before anything is sent.

A check that fails is marked *Check failed*, keeps what your patterns found, and can be repeated. If VS Code closes during a check, the emails already checked keep their result and the others wait for your answer again.

**What was found.** The table lists, per email, the blocks found (header, footer or signature, with the first line and the line count, and whether your pattern or the model found it) and the model check's state. Then:

| Control | What happens |
|---|---|
| **Strip and continue** | Removes the blocks from the ticked emails and opens the New tab |
| **Keep everything and continue** | Imports every email unchanged |
| the tick box of an email | Leaves that email out of stripping and out of a later model check; it imports unchanged |
| **Save as pattern…** | For a block the model found: saves it to your patterns in your user settings after a preview of the start and end phrases, so the next import finds it without the model |
| **Preview model check of N more email(s)…** | Sends the emails the model has not looked at yet, including ones your patterns matched. Shown only while one can still be checked |

**What stripping keeps.** A stripped signature keeps the author's name line when it can be recognized (the sender's name, or a name right after a closing such as "Best regards"); a signature with no recognizable name, such as "BR" and a logo, is removed completely. An inline image that appears only inside stripped blocks is removed from the text and not uploaded; an image also used in the kept text stays.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.email.template` | `""` | The template an email import uses; asked for once on the start screen when empty |
| `ticketSidekick.email.deleteEmlAfterImport` | `false` | Delete the `.eml` file after its ticket is created (not after a comment) |
| `ticketSidekick.jira.defaultProject` | — | Project the tickets go to; asked for on the start screen when empty |
| `ticketSidekick.email.maxBatchSizeMB` | `150` | Largest total size (1–500 MB) of the `.eml` files of one import; a larger selection is refused before any file is read |
| `ticketSidekick.email.boilerplatePatterns` | `[]` | Your known confidentiality headers, legal footers and signatures (see above) |
| `ticketSidekick.email.checkModel` | `""` | The model of the email check; picked on the board when empty |

## Create Jira tickets from a Veracode report (.xml)

Veracode reports are imported on the **import board**.

Export a Detailed Report XML from Veracode, then:

1. Run **Command Palette → Ticket Sidekick: Open import board**, or ask Copilot in Agent mode with the file's path (or drag the file into the chat), or type `/ts-jira import veracode <path>`
2. On the start screen, pick **Veracode** and the `.xml` file. The template comes from `ticketSidekick.veracode.template`; when that setting is empty, the start screen asks for one once and saves it (see [Boards → Import board](boards.md#import-board))
3. Review the results on the board's tabs (see [Reviewing an import](#reviewing-an-import) below): new flaws, flaws that already have a ticket, and stale tickets each have their own tab, with their own Preview and Apply
4. Tickets are created one per group of related flaws (flaws in the same file with the same CWE, or on the same line, fold into one ticket — see [Folding findings into one ticket](#folding-findings-into-one-ticket)), with severity, CWE (linked to the public CWE definition), file/line location, each flaw's own description, and the category's remediation recommendation

Each ticket is labeled `veracode`, `veracode-issue-<id>`, and `cwe-<id>` (plus any labels from your chosen template), so re-running the import after a partial run — or after remediating some flaws and re-scanning — will not create duplicate tickets for flaws that already have one.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.veracode.template` | empty | The template a Veracode import uses; asked for once on the start screen and saved here when empty |
| `ticketSidekick.veracode.minSeverity` | `4` | Minimum severity (0–5) included by default |
| `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` | Remediation statuses included by default |
| `ticketSidekick.veracode.maxReportSizeMB` | `50` | Largest report file (1–200 MB) accepted; a larger file is rejected before it is read |
| `ticketSidekick.veracode.slaDays` | Very High 14, High 28, the rest 0 | Calendar days from first found to the Jira Due Date, per severity; 0 means no Due Date (see [Due dates from your SLA table](#due-dates-from-your-sla-table)) |

Only `<staticflaws>` are imported (dynamic/manual analysis findings are out of scope). One Apply creates at most 50 tickets; the preview says how many remain, and the next Apply creates the rest.

### Due dates from your SLA table

Each flaw's due date is the date Veracode first found it plus the number of days for its severity in `ticketSidekick.veracode.slaDays` (see the [settings reference](settings-reference.md#report-import-settings)). The table ships with Very High 14 days and High 28 days; the other severities are 0, which means no due date. Change the numbers to your company's policy.

- **On a new ticket**, the Jira **Due Date** is the earliest due date of the ticket's flaws, written as it is even when already past. The ticket's Findings table shows each flaw's **First found** date and **Due date**; a very large fold's slimmer table leaves them out, but the Due Date field still carries the date. A flaw whose report entry has no first-found date counts from the ticket's creation date (today, for a new ticket). A severity at 0 gets no Due Date, and an existing Due Date is never cleared. If your project does not show the Due Date field, the ticket is still created or rewritten without it: you get a warning, and the dates stay in the description.
- **A Due Date is set once.** Later imports do not recalculate or overwrite it, so a date you moved by hand, such as an agreed extension, stays, and changing the table does not reach tickets that already have a Due Date. The one exception is flaws joining a ticket: with **Add selected to ticket** as a rewrite, or new findings on the ticket, the Due Date becomes the earlier of its current date and the earliest due date of the joining flaws, and never later. Adding as a comment never touches the Due Date.
- **Tickets that have no Due Date.** On the Already ticketed tab, an open ticket with an empty Due Date whose flaws have a due date shows as changed, marked "No Due Date" with the change `Due Date missing → <date>`, and defaults to `rewrite`, which sets it. `rewrite` also rebuilds the ticket's description and replaces any text added by hand, so check the rows before you apply. One Apply writes at most 50 tickets: apply again for the rest, especially on the first import after the upgrade. A resolved ticket is not offered a change for a missing date alone.
- **Export and overview.** **Save overview as CSV…** and **Save overview as Excel…** show the same due dates and flags for items that have no ticket yet (an item without a Fix Version is flagged against the latest unreleased release, see the Flag column below), and the security report board flags Veracode tickets by their Jira Due Date like OSS tickets, see [Security report: open Veracode and Waltz tickets by release](#security-report-open-veracode-and-waltz-tickets-by-release).

### Reviewing an import

The import board shows each group as a tab with its count. Its controls are described in [Boards → Import board](boards.md#import-board); this section says what each group means.

- **New** — findings without a ticket yet. Include or leave out rows, fold rows together or add them to an existing ticket (see [Folding findings into one ticket](#folding-findings-into-one-ticket)), accept CVEs or components (OSS reports only — see [Accepting CVEs](#accepting-cves-you-have-decided-to-live-with)), and create the included rows.
- **Already ticketed** — findings that already have a ticket. Each row shows its ticket, the ticket's status, what changed since the ticket was made (for example a new CVE, a higher rating or a new flaw), and a proposed action. The tab opens on the rows that changed or have no Due Date; the others are under **Unchanged** and **All**. Veracode and OSS reports offer the same three actions:
  - **rewrite** — rebuilds the existing ticket's title, description and labels from the report and posts a comment naming what was added and what dropped out (see [Folding findings into one ticket](#folding-findings-into-one-ticket)). It replaces text you added to the description by hand. It rebuilds the whole ticket, so set it on all the rows that point to the same ticket or on none of them; the preview refuses a mix and writes nothing.
  - **new ticket** — creates a complete new ticket for the finding with its current content, titled `… (follow-up to PROJ-123)` and linked to the resolved ticket. Offered only when every ticket for the finding is resolved. See also [Keeping OSS tickets up to date](#keeping-oss-tickets-up-to-date).
  - **leave** — does nothing.

  Rows without changes propose **leave**. A change on an open ticket proposes **rewrite**; a change whose tickets are all resolved proposes **new ticket**.
- **Stale** — open tickets whose finding is no longer in the report. Check the tickets to close, then choose where each issue type goes: one of your matching cleanup rules (listed first), or any status your workflow can reach, such as a review status like "Verification". A resolution is asked only when the target is a closing status and no rule supplies one. One Apply can close tickets of several issue types. A ticket needs a discovered workflow to be selectable; `/ts-jira workflow <KEY>` discovers it for a ticket of that project and issue type. Tickets you move to a status that isn't final stay open, so later imports list them again as stale.

Each tab's Apply affects only its own group — nothing is created, updated or closed until you apply that tab's change.

### Folding findings into one ticket

Several findings are often one piece of work: ten SQL injections in one repository class, or a dozen `netty-*` artifacts that move to the next version together. A **folded ticket** covers all of them.

**Veracode folds automatically.** Flaws in the same file with the same CWE become one row and one ticket, whatever their lines. Flaws on the same line fold too, whatever their CWE. A flaw with no source file never folds, and a flaw with no CWE never folds by CWE. Waltz folds nothing automatically; every component is its own row.

**Fold more yourself on the New tab** (both report kinds):

| Control | What it does |
|---|---|
| **Merge selected** | Combines the selected rows into one row — any CWEs, files, components or versions. |
| **Unmerge** | Splits a merged row back into the rows it came from. |
| **Add selected to ticket** | Adds the selected rows to an existing ticket (see below). |

A merge stays on the board until you unmerge it or create the ticket. It is not kept between imports: a later import shows the members as separate rows again.

**What a folded ticket looks like.** The title says what it folds instead of listing ids, for example `OrderRepository.java - SQL Injection (7 findings)`, `OrderRepository.java - 7 findings: SQL Injection, Cross-Site Scripting` when CWEs are mixed, `OrderRepository.java +2 files - SQL Injection (7 findings)` across files, or `[OSS] netty-codec:4.1.100 +2 components — High`. The description opens with a banner stating how many findings it folds and a table with one row per finding (issue id or component, severity or rating, location, and so on), followed by a section per finding with its own details. If a description would get too long for Jira, the per-finding text is shortened and a note says so; the table always lists every finding. The ticket carries the labels of every finding in it, so the next import recognizes each of them.

**Add rows to an existing ticket.** **Add selected to ticket** works for any ticket, including one a colleague created by hand. Type its key and choose how:

- **as a comment** — adds the findings' labels to the ticket and posts one comment listing them. The ticket's description and title stay as they are.
- **as a rewrite** — **overwrites the ticket's description and title** with the findings of this report (the added rows plus the Already-ticketed rows that point to this ticket), adds the labels, and posts a comment listing what was added and any finding the ticket recorded that the new description no longer covers.

**Preview add…** reads the ticket first: it shows its summary and status, warns if it is resolved, and for a rewrite lists the findings the rewrite drops. Both choices change the ticket's labels. Nothing is written until you apply. If a write fails, the rows stay in New; if only the comment fails, the write stands and the rows leave New. A comment does not settle the ticket's rows on Already ticketed: they still offer their own action.

To find the ticket to add to, **Search matched tickets** lists the open tickets this import already matched whose summary contains the text. It makes no Jira call; for any other ticket, type its key.

### Merging tickets

Two or more tickets for the same piece of work can be combined. A finding with more than one open ticket names the others in its Ticket cell under "also open:". On the **Already ticketed** tab, pick the rows of the tickets, choose the ticket to keep (one of the picked ones, or type its key), and click **Preview merge tickets…**. You choose the direction: keeping PROJ-1301 closes PROJ-1190, and keeping PROJ-1190 closes PROJ-1301.

The preview reads the tickets and shows them, the steps and any warnings, and writes nothing. Apply asks VS Code's dialog, then a **Ticket merge** tab runs the steps (see [Boards → Ticket merge](boards.md#ticket-merge)). Merging works differently for the two kinds of report.

**OSS reports.** Then:

1. The kept ticket is rewritten once from the report rows of all the tickets (title, description and the combined labels), and a comment names the tickets it took over and any finding the new text no longer covers.
2. Each cancelled ticket is linked as a duplicate of the kept one, gets `[Merged into PROJ-12]` in front of its title, and a banner above its text. The original text stays below the banner.
3. Each cancelled ticket is closed with resolution Duplicate. You pick the status to move each issue type to.

**Veracode reports.** The tickets are not rewritten or renamed. For each ticket you close:

1. If it records flaws the kept ticket lacks and the report still lists them, or the report lists a flaw no ticket records yet, the kept ticket is rebuilt once from the report so it carries them all (its Due Date follows the usual rule: set only when empty, moved earlier only when the added flaws are due sooner). If every flaw is already on the kept ticket, nothing is rewritten.
2. The two tickets are linked: `Duplicate` when nothing moved, `Relates` when flaws moved.
3. A comment on the closed ticket names the kept one. A flaw that is not moved is named in that comment: one the report no longer lists, or one the report still lists but outside the kept ticket's rows (filtered by your settings, or grouped under another ticket). The preview says which.
4. The ticket is closed. You pick the status; the resolution is Duplicate when your project has it, otherwise you pick one.

If the kept ticket cannot be rebuilt (the step fails and you choose **Ignore**), the sources that had flaws to move are not linked, commented on or closed, so their flaws never end up only on a closed ticket; the end of the merge lists those steps as not done.

What to expect:

- **Warnings before you apply.** A resolved kept ticket, a ticket that no import created (a rewrite replaces its text, and the findings it would drop are listed), and an already-resolved cancelled ticket (OSS reports: it is rewritten and linked but not closed; Veracode: it is linked and commented on but not closed).
- **Missing Jira pieces.** Without a Duplicate link type the tickets are linked as Relates. Without a Duplicate resolution you pick the resolution from your project's list. The preview says so up front.
- **If a step fails,** the merge stops and the merge tab shows every step with its status and the error. **Retry…** runs that step again, **Ignore…** skips it and carries on with the rest (the end of the merge lists what is missing), and **Stop…** ends the merge. Steps already done stay done.
- **The closes.** Before the tickets are closed, you choose the target status, and the resolution where one is asked, for every issue type of the tickets to close. One Apply then closes them all.
- **A ticket Jira closes without the Duplicate resolution** (some workflows reject the field) is named when the merge ends.
- **Later imports.** The kept ticket stays open, so it is the one later imports propose changes for; the closed ticket is resolved and is left alone, and its labels still count as known, so its items do not come back as new.

After a merge the tabs show the new reading from Jira, except a tab where you have unfinished choices: it is marked out of date and offers **Refresh**, which keeps every choice whose rows still exist.

### Reloading the report

**Reload report…** reads the same report file again, checks Jira again and rebuilds every tab. It also picks up edits to `.jira-oss-accepted.json`. Its preview lists the choices you have made, each kept if its rows are still in the report and dropped otherwise; after Apply the board names the ones it dropped. If the report file has moved, the board offers **Pick the file again…** instead.

## Create Jira tickets from an OSS report (.xlsx)

OSS reports are imported on the **import board**.

Export an "OSS Report" from Waltz (or a compatible SCA tool) as `.xlsx`, then:

1. Run **Command Palette → Ticket Sidekick: Open import board**, or ask Copilot in Agent mode with the file's path (or drag the file into the chat), or type `/ts-jira import waltz <path>`
2. On the start screen, pick **Waltz OSS** and the `.xlsx` file. The template comes from `ticketSidekick.waltz.template`; when that setting is empty, the start screen asks for one once and saves it
3. Review the results on the board's tabs (see [Reviewing an import](#reviewing-an-import) above), the same way as a Veracode import, plus an **Accepted** tab
4. Tickets are created one per component (use **Merge selected** to fold related components such as a family of `netty-*` artifacts into one ticket — see [Folding findings into one ticket](#folding-findings-into-one-ticket)), with the max vulnerability rating, the dates by which the component must be fixed, the single most critical CVE up front, affected artifact paths, and a table of known vulnerabilities

Each ticket is labeled `oss-dependency` and a sanitized, collision-safe version of the component's name (plus any labels from your chosen template), so re-running the import will not create duplicate tickets for components that already have one.

### Remediation dates and the Jira Due Date

The report says by when each vulnerable component has to be fixed. Each ticket lists these in its **Components** table, which has one row per component with its name, rating, remediation action and these dates:

- **Policy date** — when the policy requires the component to be fixed.
- **Planned date** — your own target, present only for components marked `Remediate`.
- **Attestation date** — the date shown as the attestation date in Waltz (the report's `Attested Rem Plan Due By` column). Tickets created before this column was named correctly list it under the old title "Plan deadline"; the import does not read that title back, so such a ticket shows as changed once against a newer report, and a rewrite records it under the new title.
- **Plan status** — the report's own reason when its plan is not valid (for example `Overdue` or `Unplanned`), shown as written and labelled "as of" the date the report was extracted. No overdue-days number is shown anywhere.

A component without dates shows `n/a` in the date cells. A ticket that folds several components lists every component in the same table.

The ticket's Jira **Due Date** is the planned date, or the policy date when there is no planned date; a folded or merged ticket takes the earliest of its components. No Due Date is set when no component has a date, and an existing Due Date is never cleared. If your project does not show the Due Date field, the ticket is still created or rewritten without it: you get a warning, and the dates stay in the description.

### Keeping OSS tickets up to date

Import a newer report and the **Already ticketed** tab compares it with your tickets. A row is a **change** when its component has a new CVE, a higher rating, different dates than the ticket's description records (the plan status is not compared), or when a component that a combined ticket covers is no longer in the report. A ticket made before dates existed records none, so it counts as changed as soon as the report has dates for it. A component that is only hidden by your rating or action settings, or that you accepted, has not left the report.

| Action | What it does | When it is offered |
|---|---|---|
| **rewrite** | Rebuilds the ticket from the report — title, description, labels and **Due Date** — and posts a comment naming the new components, the changed dates, the Due Date it set and any component that dropped out (whose label is taken off). | Always |
| **leave** | Does nothing. | Always |
| **new ticket** | Creates a complete new ticket for the component, with its current content, dates and Due Date, titled `… (follow-up to PROJ-123)` and linked to the resolved ticket. | Only when every ticket of the component is resolved |

A change on an open ticket proposes **rewrite**; a change where every ticket is resolved proposes **new ticket**, because a component that is still in the report is still open work; no change proposes **leave**. Rows that point to the same ticket always propose the same action, because **rewrite** rebuilds the whole ticket. A row whose dates changed shows each changed date as the ticket records it next to the report's, for example `Policy date 2026-12-31 → 2027-03-31`, and the comment a rewrite posts lists the same dates.

Things to know:

- **A rewrite sets the Due Date from the report, even over a date you changed by hand in Jira**, and the result says so. It also replaces text you added to the description by hand.
- A component that disappears from the report is handled by the **Stale** tab, which does not touch the Due Date.
- The first import after upgrading can propose many actions: every open ticket whose component now has dates proposes **rewrite**, and every resolved one that is still in the report proposes **new ticket**. One Apply writes at most 50 tickets, so apply again for the rest, and look through the **new ticket** rows before you apply them.
- **update** and **re-create** are not offered for OSS reports.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.waltz.template` | empty | The template an OSS report import uses; asked for once on the start screen and saved here when empty |
| `ticketSidekick.waltz.minVulnRating` | `High` | Minimum "Max Vuln Rating" (Low/Medium/High/Critical) included by default |
| `ticketSidekick.waltz.includeRemediationActions` | `["", "Remediate"]` | Remediation Action values included by default (empty string means the column was blank) |
| `ticketSidekick.waltz.maxReportSizeMB` | `50` | Largest report file (1–200 MB) accepted; a larger file is rejected before it is read |

One Apply creates at most 50 tickets; the preview says how many remain, and the next Apply creates the rest. If you re-run the import later, already-created tickets are automatically skipped via the dedup check.

### Accepting CVEs you have decided to live with

Some CVEs are known and accepted (not reachable in your setup, no fix available yet). Record them once and the OSS import stops offering them in **New**.

On the New tab, select the rows, type a reason if you want one, and click **Preview accept CVEs of selected…**, then Apply. CVEs can be accepted from New rows only.

The CVEs listed on those rows are written to `.jira-oss-accepted.json` in the workspace root, next to `.jira-templates.json`. The reason is optional. Commit the file and your team shares the same decisions; you can also edit it by hand:

```json
{
  "accepted": [
    { "component": "netty-codec", "cve": "CVE-2024-1234", "reason": "only reachable from the internal network" },
    { "component": "libfoo", "cve": "CVE-2024-5678" }
  ]
}
```

How it applies:

- **Matched by component name and CVE, not version.** `netty-codec:4.1.100` and `netty-codec:4.1.101` are the same component, so an upgrade that still reports the accepted CVE stays hidden. A new CVE on the same component is offered again.
- **A partly accepted component stays in New** with only its remaining CVEs: the ticket's description, CVE labels and rating cover just those, and the rating is recomputed from them. A component whose CVEs are all accepted disappears from New.
- **The rating floor still applies.** If a component's remaining CVEs rate below `ticketSidekick.waltz.minVulnRating` after the accepted ones are dropped, it is hidden too.
- **Merged rows.** Accepting the CVEs of a merged row accepts the CVEs of every component in it.
- **CVE entries affect the New tab only.** The Already ticketed and Stale tabs are unchanged by them, so a later import can still propose adding an accepted CVE to an existing ticket. To take a whole component off all three tabs, accept it as a component (below).

A line above the tabs says how many accepted CVEs and components the list hid from this report, and how many components fell below the rating floor. The **Accepted** tab lists the entries with their reasons. **Unaccept…** deletes an entry after a preview, and the entry is offered again right away: the tabs read the report again, or, where you have unfinished choices, are marked out of date and offer **Refresh**.

If `.jira-oss-accepted.json` is not valid JSON, the import hides nothing and shows a warning. If it has an entry that cannot be read (for example a mistyped key), that entry is skipped with a warning. In both cases accept and unaccept leave the file alone until you fix it, so nothing you wrote by hand is lost.

### Accepting a whole component at its version

Some components cannot be fixed at all (no newer version exists, or the risk is accepted). Accept the component at that exact version and the OSS import stops asking about it everywhere: select its rows on the New tab and click **Preview accept components of selected…**, or pick its rows on the Already ticketed tab and click **Preview accept components of picked…**. The reason is optional. Each component is written to the same `.jira-oss-accepted.json` as an entry with a `version` and no `cve`:

```json
{
  "accepted": [
    { "component": "libfoo", "cve": "CVE-2024-5678" },
    { "component": "netty-codec", "version": "4.1.100", "reason": "no newer version exists" }
  ]
}
```

What happens to an accepted component:

- **New:** it is never offered as a new ticket.
- **Already ticketed:** its existing tickets drop off the tab, whether they are open or resolved.
- **Stale:** an existing ticket with no resolution is offered for closing on the Stale tab, even though the report still lists the component. Closing works as for any stale ticket (issue type, target, resolution). A resolved ticket is not offered. Accepting a row on the Already ticketed tab adds its ticket to Stale straight away. A ticket that also covers a component that is still active is left alone.
- **Exact version:** `netty-codec:4.1.100` accepted does not cover `4.1.101`. After you upgrade, the new version is a normal row again.
- **Stays accepted:** a new CVE, a higher rating or a fixed version in the report does not bring the component back. Remove the entry to review it again.
- **Jira is not changed** by accepting. Only closing a stale ticket changes Jira, and only when you ask for it.

The **Accepted** tab shows component entries as "Whole component, version …" with **Unaccept component…**. A removed entry is offered again right away, as for a CVE. A version of the extension without this feature skips component entries with a warning and leaves the file alone, so update the extension for the whole team.

## Security report: open Veracode and Waltz tickets by release

The unresolved Veracode and Waltz tickets of a project can be listed by the release they are planned for, with each ticket's Due Date, so you can see what blocks a release and which tickets have no release yet. There are two ways to start it.

- **The security report board** (`/ts-jira security-report PROJ`, "show the security report for PROJ", or `Ticket Sidekick: Open security report`) searches Jira for the project's unresolved Veracode (`veracode` label) and Waltz (`oss-dependency` label) tickets, with both tools in the same tables, and saves them as CSV or Excel; see [Boards](boards.md#security-report). The `@jira /security-report` command it replaces is gone.
- **Save overview as CSV…** and **Save overview as Excel…** on the [import board](boards.md#search-and-export) do the same for that one report and compare it with Jira, as the board read it: the board reads nothing new when you save, and a stale ticket the board closed is left out. Each row also gets a **Report match**: *tracked* (an open ticket for an item of the report), *stale* (an open ticket whose item is no longer in the report) or *in report, no ticket* (a New row, or an item whose tickets are all resolved).

The result is one table per Jira **Fix Version**, ordered by release date, and a last table **Not assigned to a release** for tickets without a Fix Version and, in an import, for report items without a ticket. Each table has a count line and a link to the matching list in Jira. An import's links list the tickets by key, so stale tickets are included; items without a ticket cannot be in a Jira list, and the table says how many there are.

| Column | Meaning |
|---|---|
| Item | The ticket's title (a folded or merged ticket is one row) |
| Rating | The most severe finding (Veracode) or the highest rating (Waltz) |
| Ticket | Key and Jira status |
| Due | The ticket's Jira Due Date |
| Flag | **⚠ overdue** when the Due Date has passed; **⚠ due before release** when the Due Date is earlier than the release date of the ticket's Fix Version, so the release ships after the deadline. A Due Date after the release is not flagged, and a Fix Version without a release date is never flagged. A ticket (or report item) with no Fix Version is flagged **⚠ due before release** when its Due Date is earlier than the latest release date among the project's **unreleased** versions. Released versions never move that date, but a far-future placeholder version that is still unreleased does, so it flags more tickets. A project with no dated unreleased version flags none of them. |

A ticket with several Fix Versions appears once, under the earliest release, and names the others. Release dates come from the project's version list in Jira.

The import board saves the overview through a save dialog; the security report board saves the same files with **Save full report as CSV** and **Save full report as Excel**. An import overview with no rows is saved with the header row only. Both files have the same rows and columns: Veracode tickets give one row per finding (issue id, CWE, module, path, file, line, function), Waltz tickets one row per ticket with its components in the **Members** column and the earliest of their dates. The columns run Fix Version, Release Date, Due Date, Policy date, Planned date and Attestation date side by side, with **Members** as the last column. Every row has a **Detail source** column: *report* (the loaded report), *table* (the ticket's findings or components table), *legacy* (an older ticket layout) or *title and labels* (only the ticket's title and labels could be read). Text from tickets is shown as the ticket holds it, which can differ slightly from the report for unusual characters.

The Excel file is one sheet with real date cells (they sort and filter as dates), a frozen header row and a filter on every column. Rows flagged **⚠ overdue** are filled orange and rows flagged **⚠ due before release** yellow; the Flag column carries the same words. The CSV has no colours. If a spreadsheet opens the CSV in one column, set `ticketSidekick.jira.overviewCsvDelimiter` to `semicolon`; the setting does not affect the Excel file. The column order changed from earlier versions (the dates moved next to Due Date and Members moved to the end), so a script that reads the CSV by column position needs to read it by header name instead.

### What the tickets record

Every Veracode ticket carries a **Findings** table (issue id, severity, CWE and its name, module, path, file, line, function) and every Waltz ticket a **Components** table (component, rating, remediation action, CVE and artifact counts and the four remediation dates), single-finding and single-component tickets included. The overview reads them back. A very large Veracode ticket (several hundred findings) keeps only issue id, severity, CWE, file and line in its table so it fits Jira's size limit, and says so. A ticket created before these tables existed is read from its older layout or from its title and labels, with less detail; a **rewrite** upgrades it. A ticket whose table disagrees with its labels (for example after a hand edit) is marked *edited*.
