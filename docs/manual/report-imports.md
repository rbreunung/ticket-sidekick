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

Inline images are uploaded as Jira attachments and embedded as thumbnails at their position in the description. File attachments are uploaded to the ticket. Individual attachments larger than 25 MB are rejected with a clear message rather than failing mid-upload.

## Removing confidentiality headers, footers and signatures

Before an email becomes a ticket or a comment, `@jira` looks for boilerplate in every message of the thread, including quoted and forwarded ones: confidentiality headers at the top, legal footers and disclaimers at the bottom, and signature blocks with their logos. Nothing is removed until you say so.

**Your patterns first.** List the texts your company repeats in the `ticketSidekick.email.boilerplatePatterns` user setting (see [Settings Reference](settings-reference.md#report-import-settings) for the format). Every email is checked against them. Without an end phrase, a header covers the line(s) its start phrase is on — add an end phrase for multi-line headers.

**The model only with your yes.** If an email matches none of your patterns, `@jira` asks once for the whole import whether the Copilot model may look at those emails:

| Reply | What happens |
|---|---|
| `model check` (or `yes`) | Only the emails listed on that screen are sent to the model, one at a time. Emails that matched a pattern are never sent. An email longer than 30,000 characters is never sent and shows *too long for model check* |
| `skip model` (or `no`) | Nothing is sent. Those emails show *nothing detected* and import unchanged |
| `cancel` | Stops the import |

No email content goes to the model without this reply, and the answer is not remembered for the next import. If you stop the chat response while the model check runs, the import pauses at this question: emails already checked keep their result, the rest are not sent, and you reply **model check** or **skip model** to continue. With no patterns configured you see this question on every import. If nothing was found and you skip the model, the import continues straight to the template pick.

**The preview.** One screen lists, per email, its row id, subject, which blocks were found (for example *3 footers, 1 signature*) with a short excerpt and line count of each, and how many images would be dropped. A block marked *capped* hit the 40-line limit before a natural end. Reply:

| Reply | What happens |
|---|---|
| `strip` | Removes the listed blocks, then continues to the template pick (or the comment preview) |
| `keep` | Imports every email unchanged |
| a row id, e.g. `3` (or `2, 4`) | Excludes that email from stripping; reply it again to include it. Excluded emails import unchanged |
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

- **New** — findings without a ticket yet. Open it to toggle rows (reply row numbers, `include all` / `exclude all`, `next` / `prev` for more pages), fold rows together (`merge 2 4`, `unmerge 2`) or add them to an existing ticket (`add 2 4 to PROJ-123`) — see [Folding findings into one ticket](#folding-findings-into-one-ticket) — and reply **Create N tickets** (or **ok**) to create the included rows on the visible page.
- **Already ticketed** — findings that already have a ticket. Each row shows its ticket, the ticket's status, what changed since the ticket was made (for example "+2 CVEs, High→Critical" or "+1 flaw"), and a proposed action. Click another action in the row, or reply e.g. `A2 follow-up` or `all leave`, then reply **Apply** (or **ok**):
  - **update** — adds the new findings to the existing ticket as labels and one comment. For an OSS report, a higher rating also updates the rating at the end of the ticket's summary, unless you renamed the summary.
  - **follow-up** — creates a new ticket with only the new findings and links it to the existing one. Offered only when there are new findings.
  - **rewrite** — rebuilds the existing ticket's title, description and labels from the report and posts a comment naming what was added and what dropped out (see [Folding findings into one ticket](#folding-findings-into-one-ticket)). It rebuilds the whole ticket, so set it on all the rows that point to the same ticket or on none of them; **Apply** stops with nothing written otherwise.
  - **re-create** — creates a fresh, complete ticket.
  - **leave** — does nothing.

  Rows without changes propose **leave**. Changes on an open ticket propose **update**; changes whose tickets are all resolved propose **follow-up** (or **update** when only the rating rose). OSS tickets created before this version show "baseline" the first time: **update** then just records their current CVEs and rating, with no comment. **Update tickets** and **Re-create tickets** run only the rows set to that action.
- **Stale tickets** — open tickets whose finding is no longer in the report. Toggle a ticket by its key (e.g. `PROJ-123`) and reply **Close N tickets** (or **ok**). You then pick where the tickets go: one of your matching cleanup rules (listed first), or any status your workflow can reach, such as a review status like "Verification". Each run handles one issue type; if your selection mixes issue types, you are asked which one to close first. A resolution is asked only when the target is a closing status and no rule supplies one. Reply **Back** at any point to return without changing anything. A ticket needs a discovered workflow (`@jira discover workflow <project> <issue type>`) to be selectable. Tickets you move to a status that isn't final stay open, so later imports list them again as stale.

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

## Create Jira tickets from an OSS report (.xlsx)

Export an "OSS Report" from Waltz (or a compatible SCA tool) as `.xlsx`, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)**
2. Select the `.xlsx` file
3. Pick a template or issue type in the `@jira` chat
4. Review the results (see [Reviewing an import](#reviewing-an-import) below), the same way as a Veracode import
5. Tickets are created one per component (use `merge` to fold related components such as a family of `netty-*` artifacts into one ticket — see [Folding findings into one ticket](#folding-findings-into-one-ticket)), with the max vulnerability rating, the single most critical CVE up front, affected artifact paths, and a table of known vulnerabilities

You can also trigger the import from the chat directly:

```text
@jira import oss report
```

A file picker opens, and you proceed as above.

Each ticket is labeled `oss-dependency` and a sanitized, collision-safe version of the component's name (plus any labels from your chosen template), so re-running the import will not create duplicate tickets for components that already have one.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.waltz.minVulnRating` | `High` | Minimum "Max Vuln Rating" (Low/Medium/High/Critical) included by default |
| `ticketSidekick.waltz.includeRemediationActions` | `["", "Remediate"]` | Remediation Action values included by default (empty string means the column was blank) |
| `ticketSidekick.waltz.maxReportSizeMB` | `50` | Largest report file (1–200 MB) accepted; a larger file is rejected before it is read |

Each **Create N tickets** creates at most 50 tickets (one page) — reply `next` on the New screen and create again for the remainder. If you re-run the import later, already-created tickets are automatically skipped via the dedup check.
