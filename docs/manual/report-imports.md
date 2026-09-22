# Report Imports (Email, Veracode, Waltz)

Part of `@jira` — turns a `.eml` email, a Veracode Detailed Report, or a Waltz OSS Report into Jira tickets. See the main [README](../../README.md) for setup and core commands first.

## Create Jira ticket from email (.eml)

Download the email from OWA using **More actions → Download message** to save a `.eml` file, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira ticket from email (.eml)**
2. Select the `.eml` file from your Downloads folder
3. A preview appears in the `@jira` chat with subject, sender, date, body, and attachments
4. Reply with a template number, an issue type number, or **post it** to create the ticket

You can also trigger the import from the chat directly:

```text
@jira create ticket from mail
@jira import email
```

A file picker opens, the preview appears, and you proceed as above.

Inline images are uploaded as Jira attachments and embedded as thumbnails at their position in the description. File attachments are uploaded to the ticket. Individual attachments larger than 25 MB are rejected with a clear message rather than failing mid-upload.

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

The comment includes the sender name and received date as a header, followed by the full email body in Jira markup. All attachments are uploaded to the ticket.

**Settings:**

| Setting | Default | Description |
|---|---|---|
| `ticketSidekick.email.deleteEmlAfterImport` | `false` | Delete the `.eml` file automatically after the ticket is created |
| `ticketSidekick.jira.defaultProject` | — | Project key used when creating tickets (required for new ticket flow) |

## Create Jira tickets from a Veracode report (.xml)

Export a Detailed Report XML from Veracode, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from Veracode report (.xml)**
2. Select the `.xml` file
3. Pick a template or issue type in the `@jira` chat
4. Review the flaw list — already-ticketed flaws are shown separately and excluded by default; reply with row numbers to toggle inclusion/exclusion, or **ok** to proceed
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

Only `<staticflaws>` are imported (dynamic/manual analysis findings are out of scope). A batch creates at most 50 tickets per run — re-run the import to process the remainder of a larger report.

## Create Jira tickets from an OSS report (.xlsx)

Export an "OSS Report" from Waltz (or a compatible SCA tool) as `.xlsx`, then:

1. Run **Command Palette → Ticket Sidekick: Create Jira tickets from OSS report (.xlsx)**
2. Select the `.xlsx` file
3. Pick a template or issue type in the `@jira` chat
4. Review the component list — already-ticketed components are shown separately and excluded by default; reply with row numbers to toggle inclusion/exclusion, or **ok** to proceed
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

A batch creates at most 50 tickets per run — re-run the import afterward to process the remainder of a larger report; already-created tickets are automatically skipped next time via the dedup check.
