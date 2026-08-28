# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## OSS Report Import

### OSS Report
An external open-source-dependency vulnerability scan export (from Waltz or a compatible SCA tool) that this project imports and turns into Jira tickets, one per vulnerable dependency. Distinct from a generic "report" — the name refers specifically to this import source format.

### Component
A single open-source dependency (name + version) named in an OSS Report, together with its worst reported vulnerability rating, affected artifact locations, and known CVEs. An OSS Report describes many Components; each included Component becomes at most one Jira ticket.
*Avoid:* using "Component" for a Jira issue's built-in "Components" field — that is an unrelated concept that happens to share the name (see Flagged ambiguities).

### Already-ticketed
The state of a Component for which a prior import already created a matching Jira ticket, detected by a dedup lookup rather than by re-scanning every ticket by hand. An already-ticketed Component is excluded from ticket creation by default on a later import run, so re-running an import against the same report is safe and only acts on genuinely new Components.

## Bitbucket Review

### Findings funnel
The ordered stages a raw LLM finding passes through before appearing in final review output — cross-batch dedup (a finding surfaced in more than one chunk collapsed to one), anchor verification (unlocatable quotes dropped), confidence folding (below-threshold findings folded into the collapsed section, not removed), and, in deep mode, critic confirmation. "Funnel" refers to this sequence of stages and the per-stage counts it produces, not to any single filter. Logged as one summary line at the end of every review (see `docs/review-process.md`).

## Flagged ambiguities

- "Component" is used exclusively for an OSS-dependency entry from a scanned report, never for Jira's own issue-level "Components" categorization field — these are unrelated concepts that happen to share a name.
