# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## OSS Report Import

### OSS Report
An external open-source-dependency vulnerability scan export (from Waltz or a compatible SCA tool) that this project imports and turns into Jira tickets, one per vulnerable dependency. Distinct from a generic "report" — the name refers specifically to this import source format.

### Component
A single open-source dependency (name + version) named in an OSS Report, together with its worst reported vulnerability rating, affected artifact locations, and known CVEs. An OSS Report describes many Components; each included Component becomes at most one Jira ticket.
*Avoid:* using "Component" for a Jira issue's built-in "Components" field — that is an unrelated concept that happens to share the name (see Flagged ambiguities).

### Already-ticketed
The state of a Component for which a prior import already created a matching Jira ticket, detected by a dedup lookup rather than by re-scanning every ticket by hand. An already-ticketed Component is excluded from ticket creation by default on a later import run, so re-running an import against the same report is safe and only acts on genuinely new Components. Applies to Veracode findings too. An already-ticketed item can still have a change — a finding or rating none of its tickets record yet — which the user can add to an existing ticket or split into a Follow-up ticket.

### Follow-up ticket
A ticket an import creates for an already-ticketed item that holds only the findings its existing tickets don't record yet, linked "relates to" the item's newest ticket. Used when the existing ticket is resolved or shouldn't take more work. Distinct from a re-created ticket, which repeats the item's full content.

### Fold
A group of findings or components that an import turns into one review row and one ticket instead of one per finding. Veracode folds flaws that share a file and CWE, or a file and a line, automatically; in both importers the user can fold more with `merge`. A ticket created from a fold is a **Folded ticket**: its title says what it folds by count, and its description opens with a banner and an overview table so the fold is visible. A merge lasts only for the page and the import it was made on; the findings it folded stay recorded on the ticket as labels.

### Rewrite
An import action that rebuilds an existing ticket's title, description and labels from the report as if the ticket had always been one fold, and posts a comment naming the findings it added and any it dropped. Offered when adding rows to a ticket (`add … to <KEY>`, as an alternative to a plain comment) and on Already-ticketed rows, where it covers all the rows that point to the ticket or none. Distinct from a re-created ticket, which is a new ticket, and from an update, which only adds labels and a comment.

### Stale ticket
An open Jira ticket carrying an importer's marker label whose findings are all gone from the current report or no longer match the importer's remediation filter. Applies to both Veracode and Waltz imports. A stale ticket is only offered for a transition, never moved automatically, and a ticket moved to a non-final status stays stale on later imports because it is still open.

## Bitbucket Review

### Findings funnel
The ordered stages a raw LLM finding passes through before appearing in final review output — dedup (the same issue surfaced by more than one chunk or pass collapsed to one), outside-PR drops (a finding naming a file that isn't in the PR diff), Pass 2 retractions (a first-pass finding the whole-file second pass explicitly retracted), and, in deep mode, critic confirmation. A finding whose quoted line can't be located is not dropped: it stays in the final count as *location unverified*, and the funnel reports how many. "Funnel" refers to this sequence of stages and the per-stage counts it produces, not to any single filter. Logged as one summary line at the end of every review (see `docs/review-process.md`).

## Template Generation

### Template-shaped field
A ticket field whose value is usually the same across many tickets of a kind — priority, labels, components, and team/sprint-type custom fields — as opposed to a field that is always specific to one ticket (summary, description, comments, status, reporter, dates, the ticket key). Only template-shaped fields are proposed as candidates when generating a `.jira-templates.json` template from an existing reference ticket.

## Flagged ambiguities

- "Component" is used exclusively for an OSS-dependency entry from a scanned report, never for Jira's own issue-level "Components" categorization field — these are unrelated concepts that happen to share a name.
