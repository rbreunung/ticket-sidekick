---
name: Ticket Sidekick
last_updated: 2026-08-31
---

# Ticket Sidekick Strategy

## Purpose

Ticket and PR knowledge lives siloed inside Jira and Bitbucket, walled off from the AI a developer works with in the editor — so AI assistance in the IDE stays under-informed, and the complex, repetitive workflows each tool demands (field-heavy tickets, transition rules, PR review) have to be done by hand instead of automated with that context.

## Positioning

We treat self-hosted Jira & Bitbucket Data Center (PAT auth, on-prem workflow/agile/team APIs) as fully first-class rather than a cloud-first afterthought — so the information-wall problem gets closed even in enterprise environments that generic cloud-only Copilot integrations can't reach.

## Users

**Primary:** Developers doing routine Jira ticket and Bitbucket PR work as part of their daily flow - they're hiring Ticket Sidekick to handle ticket updates, creation, PR reviews, and keeping their own assigned tickets in track and order, in chat instead of the web UI.

## Boundaries

- No hosted/cloud backend for credentials or API calls — everything stays local (VS Code SecretStorage, direct API calls), never routed through a third-party service.
- No auto-posting review findings or other write-backs to Jira/Bitbucket without a confirmation step first.

_Resist a change when:_ it buys convenience by routing credentials off-device, or by writing to Jira/Bitbucket without a confirmation step first.

<!-- Always present. Things the team keeps being tempted by, plus the resist test. Not a blocker list. -->

## Key metrics

- **Personal reach-for-it test** - whether daily ticket/PR work still gets done through @jira/@bitbucket instead of falling back to the web UI; judged informally, no dashboard.
- **Colleague feedback** - friction reported and features requested by colleagues actually using it; gathered directly, not tracked in a dashboard.

<!-- Intentionally qualitative and short of the usual 3-5: no telemetry is gathered by design. -->

## Tracks

### Onboarding/adoption

Making @jira/@bitbucket easy to discover and start using — Language Model tools, slash commands, disambiguation, walkthroughs.

_Why it serves the approach:_ an information-wall-closing tool only works if developers actually reach for it instead of the web UI.

### AI-context grounding

Feeding the AI real, structured ticket/PR context — templates, report import (Veracode/Waltz), email-to-ticket, workflow-aware field handling, never-guess safeguards — instead of letting it guess.

_Why it serves the approach:_ this is the direct mechanism that closes the information walls named in Purpose.

### Round-trip write-back

Pushing AI-generated output — PR reviews, ticket analysis/descriptions — back into Bitbucket/Jira as first-class artifacts colleagues see there, so it becomes a convention Copilot follows rather than staying trapped in chat.

_Why it serves the approach:_ closing the wall has to work both directions — context in for the AI, and AI output back out to the team, not stuck in a chat transcript.

### Review quality (Bitbucket)

Accurate, trustworthy PR review findings — anchor verification, critic pass, dedup, findings funnel.

_Why it serves the approach:_ DC-first, context-grounded review only earns its place in the write-back track if the output can be trusted enough to actually post.
