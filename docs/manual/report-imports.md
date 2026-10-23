# Report Imports (Email, Veracode, Waltz)

Part of `@jira` — turns a `.eml` email, a Veracode Detailed Report, or a Waltz OSS Report into Jira tickets. See the main [README](../../README.md) for setup and core commands first.

## Create Jira ticket from email (.eml)

Download the email from OWA using **More actions → Download message** to save a `.eml` file, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)**
2. Select the `.eml` file from your Downloads folder
3. If boilerplate was found, or an email needs your OK for a model check, that step comes first — see [Removing confidentiality headers, footers and signatures](#removing-confidentiality-headers-footers-and-signatures)
4. A preview appears in the `@jira` chat with subject, sender, date, body, and attachments
5. Reply with a template number, an issue type number, or **post it** to create the ticket

You can also trigger the import from the chat directly:

```text
@jira create ticket from mail
@jira import email
```

A file picker opens, the preview appears, and you proceed as above.

Tables in the email body (including those written in desktop Outlook or Word) arrive as Jira tables with a header row, and empty cells stay empty. A table that only lays out a signature or logo is still flattened into plain lines.

Inline images are uploaded as Jira attachments and embedded as thumbnails at their position in the description. File attachments are uploaded to the ticket. Individual attachments larger than 25 MB are rejected with a clear message rather than failing mid-upload.

## Removing confidentiality headers, footers and signatures

Before an email becomes a ticket or a comment, `@jira` looks for boilerplate in every message of the thread, including quoted and forwarded ones: confidentiality headers at the top, legal footers and disclaimers at the bottom, and signature blocks with their logos. Nothing is removed until you say so.

**Your patterns first.** List the texts your company repeats in the `ticketSidekick.email.boilerplatePatterns` user setting (see [Settings Reference](settings-reference.md#report-import-settings) for the format). Every email is checked against them. Without an end phrase, a header covers the line(s) its start phrase is on — add an end phrase for multi-line headers.

**The model only with your yes.** If an email matches none of your patterns, `@jira` asks once for the whole import whether the Copilot model may look at those emails:

| Reply | What happens |
|---|---|
| `model check` (or `yes`) | Only the emails listed on that screen are sent to the model, one at a time. On this screen, emails that matched a pattern are not sent; you can still send them later with `model check` on the preview. An email longer than 30,000 characters is never sent and shows *too long for model check* |
| `skip model` (or `no`) | Nothing is sent. Those emails show *nothing detected* and import unchanged |
| `cancel` | Stops the import |

No email content goes to the model without this reply, and the answer is not remembered for the next import. If you stop the chat response while the model check runs, the import pauses at this question: emails already checked keep their result, the rest are not sent, and you reply **model check** or **skip model** to continue. With no patterns configured you see this question on every import. If nothing was found and you skip the model, the import continues straight to the template pick.

**The preview.** One screen lists, per email, its row id, subject, which blocks were found (for example *3 footers, 1 signature*) with a short excerpt and line count of each, and how many images would be dropped. A block marked *capped* hit the 40-line limit before a natural end. Reply:

| Reply | What happens |
|---|---|
| `strip` | Removes the listed blocks, then continues to the template pick (or the comment preview) |
| `model check` | Sends every email the model has not looked at yet to the model, one at a time, to find boilerplate your patterns missed — including emails your patterns already matched. Excluded emails, empty emails and emails over 30,000 characters are not sent. New blocks appear in the same preview next to the pattern blocks. Shown only while at least one email can still be checked; nothing is sent unless you reply |
| `keep` | Imports every email unchanged |
| a row id, e.g. `3` (or `2, 4`) | Excludes that email from stripping and from `model check`; reply it again to include it. Excluded emails import unchanged. Emails with nothing detected show the same Exclude chip |
| `save <n>` | For a block the model found (numbered `#n`): saves it as a pattern in your user settings, so the next import finds it without the model. The preview shows the exact start and end phrases it will store before you save. Blocks your patterns found are already saved and cannot be saved again |
| `cancel` | Stops the import |

**What stripping keeps.** A stripped signature keeps the author's name line when it can be recognized (the sender's name, or a name right after a closing such as "Best regards"); a signature with no recognizable name, such as "BR" and a logo, is removed completely. An inline image that appears only inside stripped blocks is removed from the text and not uploaded; an image also used in the kept text stays. With `ticketSidekick.email.deleteEmlAfterImport` on, the stripped text is gone for good.

## Add an email as a comment to an existing ticket

Log a customer follow-up, escalation, or partner communication on a ticket that already exists — without leaving VS Code.

**From the chat (fastest):**

```text
@jira add email to PROJ-42
@jira add comment from mail to PROJ-42
```

A file picker opens. Select the `.eml` file. The email is posted as a comment on `PROJ-42` with all attachments uploaded.

**Via preview (to review before posting):**

```text
@jira add email
```

The email preview appears. Reply with a ticket key (e.g. `PROJ-42`) to add as a comment, or select a template / issue type to create a new ticket instead.

**Via command palette:** Use **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)**, then reply with a ticket key in the preview.

The comment includes the sender name and received date as a header, followed by the email body in Jira markup. The same [boilerplate step](#removing-confidentiality-headers-footers-and-signatures) runs first for the one email; after `strip`, only the attachments that remain are uploaded, otherwise all of them are.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.email.deleteEmlAfterImport` | `false` | Delete the `.eml` file automatically after the ticket is created |
| `ticketSidekick.jira.defaultProject` | — | Project key used when creating tickets (required for new ticket flow) |
| `ticketSidekick.email.maxBatchSizeMB` | `150` | Largest total size (1–500 MB) of the `.eml` files selected for one batch; a larger batch is rejected before any file is read |
| `ticketSidekick.email.boilerplatePatterns` | `[]` | Your known confidentiality headers, legal footers and signatures, found and offered for removal before import (see above) |

## Create Jira tickets from a Veracode report (.xml)

Export a Detailed Report XML from Veracode, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from Veracode report (.xml)**
2. Select the `.xml` file
3. Pick a template or issue type in the `@jira` chat
4. Review the results (see [Reviewing an import](#reviewing-an-import) below) — new flaws, flaws that already have a ticket, and stale tickets each get their own screen and their own action
5. Tickets are created one per group of related flaws (flaws in the same file with the same CWE, or on the same line, fold into one ticket — see [Folding findings into one ticket](#folding-findings-into-one-ticket)), with severity, CWE (linked to the public CWE definition), file/line location, each flaw's own description, and the category's remediation recommendation

You can also trigger the import from the chat directly:

```text
@jira import veracode report
```

A file picker opens, and you proceed as above.

Each ticket is labeled `veracode`, `veracode-issue-<id>`, and `cwe-<id>` (plus any labels from your chosen template), so re-running the import after a partial run — or after remediating some flaws and re-scanning — will not create duplicate tickets for flaws that already have one.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.veracode.minSeverity` | `4` | Minimum severity (0–5) included by default |
| `ticketSidekick.veracode.includeRemediationStatuses` | `["New", "Open", "Reopened"]` | Remediation statuses included by default |
| `ticketSidekick.veracode.maxReportSizeMB` | `50` | Largest report file (1–200 MB) accepted; a larger file is rejected before it is read |

Only `<staticflaws>` are imported (dynamic/manual analysis findings are out of scope). Each **Create N tickets** creates at most 50 tickets (one page) — reply `next` on the New screen and create again for the remainder of a larger report.

### Reviewing an import

When an import finds more than one kind of result, `@jira` first shows an **overview** listing each group with its count:

- **New** — findings without a ticket yet. Open it to toggle rows (reply row numbers, `include all` / `exclude all`, `next` / `prev` for more pages), fold rows together (`merge 2 4`, `unmerge 2`) or add them to an existing ticket (`add 2 4 to PROJ-123`) — see [Folding findings into one ticket](#folding-findings-into-one-ticket) — hide CVEs you have decided to accept (`accept 2 4`, OSS reports only — see [Accepting CVEs](#accepting-cves-you-have-decided-to-live-with)) — and reply **Create N tickets** (or **ok**) to create the included rows on the visible page.
- **Already ticketed** — findings that already have a ticket. Each row shows its ticket, the ticket's status, what changed since the ticket was made (for example "+2 CVEs, High→Critical" or "+1 flaw"), and a proposed action. The screen lists 20 rows per page: reply `next`, `prev` or `page 3` to move between pages. Click another action in the row, or reply e.g. `A2 new ticket` (for a row on any page) or `all leave`, then reply **Apply** (or **ok**); **Apply** acts on the rows of every page. Veracode and OSS reports offer the same three actions:
  - **rewrite** — rebuilds the existing ticket's title, description and labels from the report and posts a comment naming what was added and what dropped out (see [Folding findings into one ticket](#folding-findings-into-one-ticket)). It replaces text you added to the description by hand. It rebuilds the whole ticket, so set it on all the rows that point to the same ticket or on none of them; **Apply** stops with nothing written otherwise.
  - **new ticket** — creates a complete new ticket for the finding with its current content, titled `… (follow-up to PROJ-123)` and linked to the resolved ticket. Offered only when every ticket for the finding is resolved. See also [Keeping OSS tickets up to date](#keeping-oss-tickets-up-to-date).
  - **leave** — does nothing.

  Rows without changes propose **leave**. A change on an open ticket proposes **rewrite**; a change whose tickets are all resolved proposes **new ticket**.
- **Stale tickets** — open tickets whose finding is no longer in the report. The screen lists 20 tickets per page: reply `next`, `prev` or `page 3` to move between pages. Toggle a ticket by its key (e.g. `PROJ-123`) and reply **Close N tickets** (or **ok**); tickets marked on any page are closed together. You then pick where the tickets go: one of your matching cleanup rules (listed first), or any status your workflow can reach, such as a review status like "Verification". Each run handles one issue type; if your selection mixes issue types, you are asked which one to close first. A resolution is asked only when the target is a closing status and no rule supplies one. Reply **Back** at any point to return without changing anything. A ticket needs a discovered workflow (`@jira discover workflow <project> <issue type>`) to be selectable. Tickets you move to a status that isn't final stay open, so later imports list them again as stale.

Each screen only understands its own replies, and each action only affects its own group — nothing is created, updated or closed until you choose that group's action. Reply **Back to overview** to switch groups and **Done** to finish; the overview keeps track of what you already did (e.g. "50 created · 12 left"). When an import has only one kind of result (always the case for email batches), that screen opens directly and offers **Done** instead of an overview.

### Folding findings into one ticket

Several findings are often one piece of work: ten SQL injections in one repository class, or a dozen `netty-*` artifacts that move to the next version together. A **folded ticket** covers all of them.

**Veracode folds automatically.** Flaws in the same file with the same CWE become one row and one ticket, whatever their lines. Flaws on the same line fold too, whatever their CWE. A flaw with no source file never folds, and a flaw with no CWE never folds by CWE. Waltz folds nothing automatically; every component is its own row.

**Fold more yourself on the New screen** (both importers):

| Reply | What it does |
|---|---|
| `merge 2 4` (or `merge 2,4`) | Combines the named rows into one row — any CWEs, files, components or versions. Works on the rows of the visible page only. |
| `unmerge 2` | Splits a merged row back into the rows it came from. |
| `add 2 4 to PROJ-123` | Adds those rows to an existing ticket (see below). |

A merge is not saved between pages or between imports: moving to another page discards it, and a later import shows the members as separate rows again.

**What a folded ticket looks like.** The title says what it folds instead of listing ids, for example `OrderRepository.java - SQL Injection (7 findings)`, `OrderRepository.java - 7 findings: SQL Injection, Cross-Site Scripting` when CWEs are mixed, `OrderRepository.java +2 files - SQL Injection (7 findings)` across files, or `[OSS] netty-codec:4.1.100 +2 components — High`. The description opens with a banner stating how many findings it folds and a table with one row per finding (issue id or component, severity or rating, location, and so on), followed by a section per finding with its own details. If a description would get too long for Jira, the per-finding text is shortened and a note says so; the table always lists every finding. The ticket carries the labels of every finding in it, so the next import recognizes each of them.

**Add rows to an existing ticket.** `add 2 4 to PROJ-123` works for any ticket, including one a colleague created by hand. It first shows the ticket, warns if it is resolved, and offers two links:

- **Comment** — adds the findings' labels to the ticket and posts one comment listing them. The ticket's description and title stay as they are.
- **Rewrite** — **overwrites the ticket's description and title** with the findings of this report (the added rows plus the Already-ticketed rows that point to this ticket), adds the labels, and posts a comment listing what was added and any finding the ticket recorded that the new description no longer covers. The first screen lists those findings before you click.

Both choices change the ticket's labels. Nothing is written until you click one. If a write fails, the rows stay in New; if only the comment fails, the write stands and the rows leave New.

### Merging related tickets (OSS reports)

Two or more tickets for the same piece of work can be combined. On the overview or the **Already ticketed** screen, reply `merge` with the tickets to cancel, then `into` and the ticket to keep. Name tickets by their `A` number or their key:

```text
merge A5 A6 into A3
merge PROJ-15 PROJ-18 into PROJ-12
```

`@jira` first shows the tickets, the steps and any warnings, and writes nothing. Click **Merge** to go ahead. Then:

1. The kept ticket is rewritten once from the report rows of all the tickets (title, description and the combined labels), and a comment names the tickets it took over and any finding the new text no longer covers.
2. Each cancelled ticket is linked as a duplicate of the kept one, gets `[Merged into PROJ-12]` in front of its title, and a banner above its text. The original text stays below the banner.
3. Each cancelled ticket is closed with resolution Duplicate. You pick the status to move each issue type to.

What to expect:

- **Warnings before you click.** A resolved kept ticket, a ticket that no import created (a rewrite replaces its text, and the finding it would drop are listed), and an already-resolved cancelled ticket (it is rewritten and linked but not closed).
- **Missing Jira pieces.** Without a Duplicate link type the tickets are linked as Relates. Without a Duplicate resolution you pick the resolution from your project's list. The confirmation says so up front.
- **If a step fails,** the merge stops and lists every ticket with its link, the step that failed and the error. Reply **Retry** to run that step again, **Ignore** to skip it and carry on with the rest (the final report lists what is missing), or **Stop here** to end the merge. Steps already done stay done.
- **A ticket Jira closes without the Duplicate resolution** (some workflows reject the field) is named in the final report.
- **Where it works.** The overview and the Already ticketed screen. On the New screen `merge 2 4` still combines rows, and `add 2 4 to PROJ-123` still adds rows to a ticket. The Stale screen has its own **Close tickets**.
- **Later imports.** Nothing is stored. The kept ticket carries every label and stays open, so it is the one later imports propose changes for; the cancelled ticket is resolved and is left alone.

After a merge the review refreshes itself from Jira, unless you have unfinished choices on the screen (excluded or merged New rows, or Already-ticketed actions you changed). In that case the overview says the screens are out of date and offers **Reload report**.

### Reloading the report

Reply **Reload report** (`reload report`) on the overview, or on the only screen of a single-group import, to read the same report file again, check Jira again and rebuild every screen. It also picks up edits to `.jira-oss-accepted.json`. `@jira` says what it will do, and warns first if you would lose choices you have made on the screens. If the report file has moved, it opens the file picker.

## Create Jira tickets from an OSS report (.xlsx)

Export an "OSS Report" from Waltz (or a compatible SCA tool) as `.xlsx`, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)**
2. Select the `.xlsx` file
3. Pick a template or issue type in the `@jira` chat
4. Review the results (see [Reviewing an import](#reviewing-an-import) below), the same way as a Veracode import
5. Tickets are created one per component (use `merge` to fold related components such as a family of `netty-*` artifacts into one ticket — see [Folding findings into one ticket](#folding-findings-into-one-ticket)), with the max vulnerability rating, the dates by which the component must be fixed, the single most critical CVE up front, affected artifact paths, and a table of known vulnerabilities

You can also trigger the import from the chat directly:

```text
@jira import oss report
```

A file picker opens, and you proceed as above.

Each ticket is labeled `oss-dependency` and a sanitized, collision-safe version of the component's name (plus any labels from your chosen template), so re-running the import will not create duplicate tickets for components that already have one.

### Remediation dates and the Jira Due Date

The report says by when each vulnerable component has to be fixed. Each ticket lists these in its **Components** table, which has one row per component with its name, rating, remediation action and these dates:

- **Policy date** — when the policy requires the component to be fixed.
- **Planned date** — your own target, present only for components marked `Remediate`.
- **Plan deadline** — the deadline for filing a remediation plan.
- **Plan status** — the report's own reason when its plan is not valid (for example `Overdue` or `Unplanned`), shown as written and labelled "as of" the date the report was extracted. No overdue-days number is shown anywhere.

A component without dates shows `n/a` in the date cells. A ticket that folds several components lists every component in the same table.

The ticket's Jira **Due Date** is the planned date, or the policy date when there is no planned date; a folded or merged ticket takes the earliest of its components. No Due Date is set when no component has a date, and an existing Due Date is never cleared. If your project does not show the Due Date field, the ticket is still created or rewritten without it: you get a warning, and the dates stay in the description.

### Keeping OSS tickets up to date

Import a newer report and the **Already ticketed** screen compares it with your tickets. A row is a **change** when its component has a new CVE, a higher rating, different dates than the ticket's description records (the plan status is not compared), or when a component that a combined ticket covers is no longer in the report. A ticket made before dates existed records none, so it counts as changed as soon as the report has dates for it. A component that is only hidden by your rating or action settings, or that you accepted, has not left the report.

| Action | What it does | When it is offered |
|---|---|---|
| **rewrite** | Rebuilds the ticket from the report — title, description, labels and **Due Date** — and posts a comment naming the new components, the changed dates, the Due Date it set and any component that dropped out (whose label is taken off). | Always |
| **leave** | Does nothing. | Always |
| **new ticket** | Creates a complete new ticket for the component, with its current content, dates and Due Date, titled `… (follow-up to PROJ-123)` and linked to the resolved ticket. | Only when every ticket of the component is resolved |

A change on an open ticket proposes **rewrite**; a change where every ticket is resolved proposes **new ticket**, because a component that is still in the report is still open work; no change proposes **leave**. Rows that point to the same ticket always propose the same action, because **rewrite** rebuilds the whole ticket. Each changed row shows the dates side by side, for example `planned 2026-12-15→2027-01-31`, so importing an older report over a newer one is visible before you **Apply**. Type the action as e.g. `A2 new ticket`.

Things to know:

- **A rewrite sets the Due Date from the report, even over a date you changed by hand in Jira**, and the result line says so. It also replaces text you added to the description by hand.
- A component that disappears from the report is handled by the **Stale tickets** group, which does not touch the Due Date.
- The first import after upgrading can propose many actions: every open ticket whose component now has dates proposes **rewrite**, and every resolved one that is still in the report proposes **new ticket**. **Apply** runs at most 50 per reply, so repeat it, and look through the **new ticket** rows before you apply them.
- **update** and **re-create** are no longer offered for OSS reports.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.waltz.minVulnRating` | `High` | Minimum "Max Vuln Rating" (Low/Medium/High/Critical) included by default |
| `ticketSidekick.waltz.includeRemediationActions` | `["", "Remediate"]` | Remediation Action values included by default (empty string means the column was blank) |
| `ticketSidekick.waltz.maxReportSizeMB` | `50` | Largest report file (1–200 MB) accepted; a larger file is rejected before it is read |

Each **Create N tickets** creates at most 50 tickets (one page) — reply `next` on the New screen and create again for the remainder. If you re-run the import later, already-created tickets are automatically skipped via the dedup check.

### Accepting CVEs you have decided to live with

Some CVEs are known and accepted (not reachable in your setup, no fix available yet). Record them once and the OSS import stops offering them in **New**.

On the New screen, reply `accept` and the row numbers:

```text
accept 2 4
accept 2 because only reachable from the internal network
```

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
- **Merged rows.** `accept` on a merged row accepts the CVEs of every component in it.
- **CVE entries affect the New screen only.** The Already ticketed and Stale screens are unchanged by them, so a later import can still propose adding an accepted CVE to an existing ticket. To take a whole component off all three screens, accept it as a component (below).

Nothing is hidden silently: the overview (or the New screen, when the import has only one group) shows a line such as "3 accepted CVEs hidden · 1 component below the rating floor". Reply `accepted` to list the entries with their reasons, and `unaccept 2` (or click **Remove**) to delete an entry. A **Remove** link names the entry itself (`unaccept netty-codec CVE-2024-1234`), so a link from an older list never deletes a different entry after the list has changed. A removed entry is offered again right away: OSS reviews rebuild themselves from the report (or, if you have unfinished choices on the screens, mark themselves out of date and offer **Reload report**).

If `.jira-oss-accepted.json` is not valid JSON, the import hides nothing and shows a warning. If it has an entry that cannot be read (for example a mistyped key), that entry is skipped with a warning. In both cases `accept` and `unaccept` leave the file alone until you fix it, so nothing you wrote by hand is lost.

### Accepting a whole component at its version

Some components cannot be fixed at all (no newer version exists, or the risk is accepted). Accept the component at that exact version and the OSS import stops asking about it everywhere:

```text
accept component 2 4
accept component A3 because no newer version exists
```

Use the New screen's row numbers, or the `A` numbers on the Already ticketed screen. The reason is optional. Each component is written to the same `.jira-oss-accepted.json` as an entry with a `version` and no `cve`:

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
- **Already ticketed:** its existing tickets drop off the screen, whether they are open or resolved.
- **Stale:** an existing ticket with no resolution is offered for closing on the Stale screen, even though the report still lists the component. Closing works as for any stale ticket (issue type, target, resolution). A resolved ticket is not offered. Accepting a row on the Already ticketed screen adds its ticket to Stale straight away. A ticket that also covers a component that is still active is left alone.
- **Exact version:** `netty-codec:4.1.100` accepted does not cover `4.1.101`. After you upgrade, the new version is a normal row again.
- **Stays accepted:** a new CVE, a higher rating or a fixed version in the report does not bring the component back. Remove the entry to review it again.
- **Jira is not changed** by accepting. Only closing a stale ticket changes Jira, and only when you ask for it.

The overview shows "2 accepted components hidden" with a **Show accepted** link. The `accepted` list shows component entries as "whole component" with a **Remove** link, which sends `unaccept-component netty-codec 4.1.100`. A removed entry is offered again right away: OSS reviews rebuild themselves from the report (or, if you have unfinished choices on the screens, mark themselves out of date and offer **Reload report**). A version of the extension without this feature skips component entries with a warning and leaves the file alone, so update the extension for the whole team.

## Open Veracode and Waltz tickets by release

`@jira` can list the unresolved Veracode and Waltz tickets of a project by the release they are planned for, with each ticket's Due Date, so you can see what blocks a release and which tickets have no release yet. There are two ways to start it.

- **`@jira /overview PROJ`** searches Jira for the project's unresolved Veracode (`veracode` label) and Waltz (`oss-dependency` label) tickets, with both tools in the same tables. Without a project key it uses your `ticketSidekick.jira.defaultProject`, or asks.
- **`export`** on the overview of a Veracode or Waltz import (or on the only screen of an import with a single kind of result) does the same for that one report and compares it with Jira. Each row also gets a **Report match**: *tracked* (an open ticket for an item of the report), *stale* (an open ticket whose item is no longer in the report) or *in report, no ticket* (a New row, or an item whose tickets are all resolved).

The result is one table per Jira **Fix Version**, ordered by release date, and a last table **Not assigned to a release** for tickets without a Fix Version and, in an import, for report items without a ticket. Each table has a count line and a link to the matching list in Jira. An import's links list the tickets by key, so stale tickets are included; items without a ticket cannot be in a Jira list, and the table says how many there are.

| Column | Meaning |
|---|---|
| Item | The ticket's title (a folded or merged ticket is one row) |
| Rating | The most severe finding (Veracode) or the highest rating (Waltz) |
| Ticket | Key and Jira status |
| Due | The ticket's Jira Due Date |
| Flag | **⚠ overdue** when the Due Date has passed; **⚠ due before release** when the Due Date is earlier than the release date of the ticket's Fix Version, so the release ships after the deadline. A Due Date after the release is not flagged, and a Fix Version without a release date is never flagged. |

A ticket with several Fix Versions appears once, under the earliest release, and names the others. Release dates come from the project's version list in Jira.

Reply with the **Save as CSV** link (in an import: `export csv`) to save the same overview through a save dialog. Veracode tickets give one row per finding (issue id, CWE, module, path, file, line, function), Waltz tickets one row per ticket with its components in the **Members** column and the earliest of their dates. Every row has a **Detail source** column: *report* (the loaded report), *table* (the ticket's findings or components table), *legacy* (an older ticket layout) or *title and labels* (only the ticket's title and labels could be read). Text from tickets is shown as the ticket holds it, which can differ slightly from the report for unusual characters. If Excel opens the file in one column, set `ticketSidekick.jira.overviewCsvDelimiter` to `semicolon`.

### What the tickets record

Every Veracode ticket carries a **Findings** table (issue id, severity, CWE and its name, module, path, file, line, function) and every Waltz ticket a **Components** table (component, rating, remediation action, CVE and artifact counts and the four remediation dates), single-finding and single-component tickets included. The overview reads them back. A very large Veracode ticket (several hundred findings) keeps only issue id, severity, CWE, file and line in its table so it fits Jira's size limit, and says so. A ticket created before these tables existed is read from its older layout or from its title and labels, with less detail; a **rewrite** upgrades it. A ticket whose table disagrees with its labels (for example after a hand edit) is marked *edited*.
