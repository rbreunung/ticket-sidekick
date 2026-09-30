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
5. Tickets are created one per flaw, with severity, CWE (linked to the public CWE definition), file/line location, the flaw's own description, and the category's remediation recommendation

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

- **New** — findings without a ticket yet. Open it to toggle rows (reply row numbers, `include all` / `exclude all`, `next` / `prev` for more pages) and reply **Create N tickets** (or **ok**) to create the included rows on the visible page.
- **Already ticketed** — findings that already have a ticket. For Veracode, **Update N tickets** adds a newer finding on the same line to its existing ticket (label + comment). Toggle a row (e.g. `A1`) and reply **Re-create N tickets** to create a fresh ticket anyway.
- **Stale tickets** — open tickets whose finding is no longer in the report. Toggle a ticket by its key (e.g. `PROJ-123`) and reply **Close N tickets** (or **ok**). You then pick where the tickets go: one of your matching cleanup rules (listed first), or any status your workflow can reach, such as a review status like "Verification". Each run handles one issue type; if your selection mixes issue types, you are asked which one to close first. A resolution is asked only when the target is a closing status and no rule supplies one. Reply **Back** at any point to return without changing anything. A ticket needs a discovered workflow (`@jira discover workflow <project> <issue type>`) to be selectable. Tickets you move to a status that isn't final stay open, so later imports list them again as stale.

Each screen only understands its own replies, and each action only affects its own group — nothing is created, updated or closed until you choose that group's action. Reply **Back to overview** to switch groups and **Done** to finish; the overview keeps track of what you already did (e.g. "50 created · 12 left"). When an import has only one kind of result (always the case for email batches), that screen opens directly and offers **Done** instead of an overview.

## Create Jira tickets from an OSS report (.xlsx)

Export an "OSS Report" from Waltz (or a compatible SCA tool) as `.xlsx`, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)**
2. Select the `.xlsx` file
3. Pick a template or issue type in the `@jira` chat
4. Review the results (see [Reviewing an import](#reviewing-an-import) below), the same way as a Veracode import
5. Tickets are created one per component, with the max vulnerability rating, the single most critical CVE up front, affected artifact paths, and a table of known vulnerabilities

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
