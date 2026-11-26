---
marp: true
theme: default
paginate: true
style: |
  section {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 1.4rem;
  }
  section.title {
    background: #0052CC;
    color: white;
    text-align: center;
  }
  section.title h1 { font-size: 2.6rem; margin-bottom: 0.3em; }
  section.title p  { font-size: 1.3rem; opacity: 0.85; }
  section.section-break {
    background: #172B4D;
    color: white;
    text-align: center;
    justify-content: center;
  }
  section.section-break h2 { font-size: 2.2rem; }
  h2 { color: #0052CC; border-bottom: 2px solid #0052CC; padding-bottom: 0.2em; }
  code { background: #F4F5F7; color: #172B4D; padding: 0.1em 0.4em; border-radius: 3px; }
  pre  { background: #1e1e1e; color: #d4d4d4; padding: 1em; border-radius: 6px; font-size: 1.1rem; }
  pre code { background: none; color: inherit; padding: 0; }
  /* JSON token colours that read on #1e1e1e */
  pre .hljs-attr   { color: #9cdcfe; }
  pre .hljs-string { color: #ce9178; }
  pre .hljs-number { color: #b5cea8; }
  pre .hljs-literal { color: #569cd6; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 2em; }
  strong { color: #0052CC; }
---

<!-- _class: title -->

# Ticket Sidekick

### Jira + Bitbucket — directly in VS Code  
_No browser. No context switching. No MCP server required._

---

## The situation

- Email from a client → create a ticket → upload the attachment → forget one field
- Jira access to read through description, comments and attachments reliably
- Write back agentic issue analysis to Jira with correct syntax highlight
- Bulk ticket updates: field updates or multi step status transition
- PR reviews: read diff in editor, describe findings in Jira comments, repeat

**All of this can stay inside VS Code.**

---

## What is Ticket Sidekick?

A VS Code extension that gives **GitHub Copilot Chat** tools, skills and boards:

| Piece | What it does |
|-------|-------------|
| **Tools** | Copilot's agent views, finds, creates, comments on, moves and updates Jira tickets, and reads and comments on pull requests |
| **Skills** | `/ts-jira <command>`, `/ts-jira-create`, `/ts-jira-brief`, `/ts-jira-spell-check`, `/ts-jira-template`, `/ts-bitbucket <command>` |
| **Boards** | Editor tabs for the security report, ticket lists with bulk changes, report and email imports, and the pull request review |

- Natural language in Agent mode, or a typed command: your choice
- Writes always show a confirmation with every value first
- Credentials in VS Code SecretStorage — never in settings.json
- Configurable per-repo via `.jira-templates.json`

---

<!-- _class: section-break -->

## Jira — Daily ticket work

---

## Reading tickets

Load the full context into your workspace:

```
/ts-jira load PROJ-123
```

Or ask Copilot in Agent mode:

```
show me PROJ-123
write a developer brief for PROJ-123      (/ts-jira-brief)
what do the comments say about the login bug on PROJ-123?
```

- Description, comments, attachments — all rendered as Markdown
- Branch-aware: on branch `feature/PROJ-123-fix-login` the ticket key is auto-detected
- Ask follow-up questions without repeating the ticket key

---

## Writing back

```
add a comment to PROJ-123: investigated root cause — SQL index missing on user_id
set priority to High on PROJ-123
move PROJ-123 to In Review
```

Copilot shows a **confirmation with every value** before a tool writes.

```
/ts-jira-create Bug in PROJ: Login fails on Safari
```

Templates in `.jira-templates.json` pre-fill custom fields, assignee, sprint, and guide a structured description; the draft is shown before the ticket is created.

---

<!-- _class: section-break -->

## Bitbucket — PR Review Board

---

## Reviewing a pull request

Type the PR link — the review opens as a **board in an editor tab**:

```
/ts-bitbucket review https://bitbucket.company.com/projects/PROJ/repos/backend/pull-requests/42
```

First step: pick the review model and a background for the reviewer (a Jira ticket, your own text, or nothing). Then the staged review runs, with a summary band and **Stop**:

- the regular pass, then the persona passes you pick (security, performance, reliability, maintainability) at the same time, and the critic last
- findings appear as each batch finishes, numbered once, with severity, verified line and confidence
- changes that go against the background are marked *against goal*

Per finding: a discussion that starts with **Explain** and takes follow-ups, or **Discuss in chat** to hand it to Copilot.

---

## Posting review comments

Select findings, edit one **draft comment** each (or **Rewrite** it with an instruction, with Undo), then **Post**:

- native confirmation before anything is written
- inline on a verified line, otherwise on the pull request's activity
- each comment reported, only the failed ones offered again

**Copy for Teams** or as Markdown shares the review as text. Token usage per pass is on the board; `/ts-bitbucket usage` shows the month.

---

<!-- _class: section-break -->

## Jira — Power features

---

## Imports: reports and emails

`Ticket Sidekick: Open Jira Import Board`, `/ts-jira import <kind>` or "import this Veracode report":

- **Veracode** and **Waltz** reports: New, Already ticketed, Stale and Accepted tabs, finding folding, ticket merge, SLA due dates
- **Emails** (`.eml`): boilerplate cleanup with an optional model check, a ticket or a comment per email, inline images and attachments carried over
- Every tab has its own Preview and Apply; nothing is written before you confirm

---

## Bulk cleanup & mass transitions

Close all released bugs on the **ticket list board**:

```
/ts-jira cleanup "Close released bugs"
```

Review table before anything runs:

```
| Type     | Key       | Summary              | From   | → To | Resolution |
|----------|-----------|----------------------|--------|------|------------|
| Bug      | PROJ-101  | Login timeout        | Open   | Done | Fixed      |
| Sub-task | ↳ PROJ-102| Fix session handling | Open   | Done | Fixed      |
| Bug      | PROJ-103  | Crash on export      | Review | Done | Fixed      |
```

Scope by fix version, sprint, assignee or team; Preview, then Apply with progress.

---

## It adapts to how you work

`.jira-templates.json` in the repo root:

```json
{
  "templates": [{
    "name": "Backend Bug",
    "issueType": "Bug",
    "defaultFields": { "labels": ["backend"], "priority": { "name": "High" } },
    "descriptionSections": ["Steps to reproduce", "Expected", "Actual"]
  }],
  "cleanupRules": [{
    "name": "Close released bugs",
    "project": "PROJ",  "issueType": "Bug",  "targetState": "Done",
    "resolution": "Fixed",  "closeSubtasks": true,  "fixVersionFilter": "released"
  }]
}
```

- Templates guide ticket creation (`/ts-jira-create`), and `/ts-jira-template` builds one from a ticket
- Cleanup rules encode your team's release process
- Committed to the repo — everyone picks up changes automatically

---

## Get started

**1. Install**
VS Code → Extensions → search **Ticket Sidekick**

**2. Configure**
- Command Palette → **Set Jira Personal Access Token**
- Settings: `ticketSidekick.jira.baseUrl`, `ticketSidekick.jira.defaultProject`

**3. First commands**
```
/ts-jira check            ← verify Jira connection
/ts-bitbucket check       ← verify Bitbucket connection
show me PROJ-123          ← Agent mode
```

**4. Add templates** — create `.jira-templates.json` in your workspace root

_Questions / feature requests → open an issue or ping me directly_

---

<!-- _class: title -->

# Questions?

Tools · Skills · Boards · Ticket Sidekick

_Slides: `docs/presentation/intro-slides.md`_
