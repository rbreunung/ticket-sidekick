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
  pre  { background: #172B4D; color: #F4F5F7; padding: 1em; border-radius: 6px; font-size: 1.1rem; }
  pre code { background: none; color: inherit; padding: 0; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 2em; }
  strong { color: #0052CC; }
---

<!-- _class: title -->

# Ticket Sidekick

### Jira + Bitbucket — directly in VS Code  
_No browser. No context switching. No MCP server required._

---

## The situation

- Jira MCP access is gone — copy-pasting ticket numbers, switching browser tabs
- PR reviews: read diff in editor, describe findings in Jira comments, repeat
- Bulk status updates: click through tickets one by one
- Email from a client → create a ticket → upload the attachment → forget one field

**All of this can stay inside VS Code.**

---

## What is Ticket Sidekick?

A VS Code extension with two **Copilot Chat participants**:

| Participant | What it does |
|-------------|-------------|
| `@jira` | Read, create, update tickets · search · bulk transitions · email import |
| `@bitbucket` | PR review with numbered findings · inline comments · follow-up Q&A |

- Natural language — type what you want, not the API call
- Credentials in VS Code SecretStorage — never in settings.json
- Configurable per-repo via `.jira-templates.json`

---

<!-- _class: section-break -->

## `@jira` — Daily ticket work

---

## Reading tickets

Load the full context into your workspace:

```
@jira load PROJ-123
```

Or just show it inline:

```
@jira show PROJ-123
@jira summarise PROJ-123
@jira what do the comments say about the login bug on PROJ-123?
```

- Description, comments, attachments — all rendered as Markdown
- Branch-aware: on branch `feature/PROJ-123-fix-login` the ticket key is auto-detected
- Ask follow-up questions without repeating the ticket key

---

## Writing back

```
@jira add comment: investigated root cause — SQL index missing on user_id
@jira add comment: summarise the findings from our discussion
@jira set priority to High on PROJ-123
@jira update description with the analysis above
```

Content preview before posting — refine if needed, confirm with **post it**.

```
@jira create Bug in PROJ: Login fails on Safari
  Steps to reproduce: ...
```

Templates in `.jira-templates.json` pre-fill custom fields, assignee, sprint, and guide you through a structured description with follow-up questions.

---

<!-- _class: section-break -->

## `@bitbucket` — PR Review

---

## Reviewing a pull request

Paste the PR URL — that's it:

```
@bitbucket https://bitbucket.company.com/projects/PROJ/repos/backend/pull-requests/42
```

Returns **numbered findings** grouped by severity:

| | Severity | Meaning |
|---|---|---|
| 🔴 | **Critical** | Bug, security issue, or data risk — fix before merge |
| 🟡 | **Warning** | Performance problem, code smell, or fragile assumption — worth addressing |
| 🔵 | **Suggestion** | Readability, naming, or structure — low urgency, team call |

```
🔴 #1  Missing null check — UserService.java:87
🟡 #2  N+1 query in loop — OrderRepository.java:134
🔵 #3  Consider extracting helper — PaymentHandler.java:201
```

Then ask follow-ups:

```
@bitbucket explain #2
@bitbucket is #1 actually a problem if the caller already validates input?
```

---

## Posting review comments

Select findings and post as **inline Bitbucket comments** in one step:

```
#1 #2 add to review
```

Preview shows where each comment will land (inline on the diff or activity feed). Confirm with **post it**.

Quick mode for large PRs:

```
@bitbucket review quick https://...url.../pull-requests/55
```

---

<!-- _class: section-break -->

## `@jira` — Power features

---

## Email → Jira ticket

Client sends an email with screenshots. Download the `.eml` from OWA:

```
@jira create ticket from mail
@jira import email
```

A file picker opens → email preview with subject, sender, body, attachments.

- Inline images embedded as thumbnails in the description
- File attachments uploaded to the ticket
- Choose a template or issue type, or just **post it**

Or add it as a **comment on an existing ticket**:

```
@jira add email to PROJ-42
@jira add comment from mail to PROJ-42
```

---

## Bulk cleanup & mass transitions

Close all released bugs in one command:

```
@jira run cleanup "Close released bugs"
```

Review screen before anything runs:

```
| Type     | Key       | Summary              | From   | → To | Resolution |
|----------|-----------|----------------------|--------|------|------------|
| Bug      | PROJ-101  | Login timeout        | Open   | Done | Fixed      |
| Sub-task | ↳ PROJ-102| Fix session handling | Open   | Done | Fixed      |
| Bug      | PROJ-103  | Crash on export      | Review | Done | Fixed      |

ok · (c) · key numbers to skip
```

Scope by fix version:

```
@jira run cleanup "Close released bugs" in released
@jira run cleanup "Close released bugs" in "Release 3.2"
@jira run cleanup "Close released bugs" in "Release*"
```

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

- Templates guide ticket creation with per-turn Q&A
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
@jira show PROJ-123
@jira check               ← verify Jira connection
@bitbucket check          ← verify Bitbucket connection
```

**4. Add templates** — create `.jira-templates.json` in your workspace root

_Questions / feature requests → open an issue or ping me directly_

---

<!-- _class: title -->

# Questions?

`@jira` · `@bitbucket` · Ticket Sidekick

_Slides: `docs/presentation/intro-slides.md`_
