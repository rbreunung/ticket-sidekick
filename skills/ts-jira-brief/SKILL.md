---
name: ts-jira-brief
description: Writes a developer brief of one Jira ticket from its description, comments and relevant attachments, so a developer can start work on it. Type /ts-jira-brief PROJ-123.
disable-model-invocation: true
argument-hint: <ticket key>
---

# Jira developer brief

Write a brief of one Jira ticket that a developer can work from. Use only what the ticket, its comments and its attachments say.

## Steps

1. Call `jira_view_ticket` for the ticket the user means.
2. From its attachment list, pick the attachments that can matter for the work: logs, stack traces, screenshots, specifications, sample data. Skip ones that clearly do not, such as signatures or logos.
3. Call `jira_load_ticket` with the same ticket key and the picked names as `attachments`. If none is relevant, skip this step and the next.
4. Read the picked attachments from `.jira-context/<KEY>/attachments/`, using the paths the load answer names. Note every picked attachment that was not downloaded or that you could not read.
5. Write the brief.

## The brief

Use these eight sections, in this order, as headings:

1. **Problem or goal**: what is wrong, or what should exist when the work is done.
2. **Context**: who is affected, where it happens (system, component, version, environment) and why it matters.
3. **Steps to reproduce**: numbered steps, then the expected result and the actual result.
4. **Acceptance criteria**: a checklist. Mark each criterion you derived yourself rather than found in the ticket with "(derived)".
5. **Decisions and findings from comments**: each with the comment's author and date. A later comment that changes an earlier decision wins; say so.
6. **Current state**: status, assignee, fix version, linked work, and what has been done so far.
7. **Open questions and missing information**: what a developer needs to ask before or while working on it.
8. **Sources used**: the description, each comment and each attachment you used, and every attachment you could not read, with the reason.

A section the ticket does not cover says "not stated in the ticket". Do not fill it with guesses. Cite where each point comes from, for example "(description)", "(comment by Jane Doe, 2026-03-02)" or "(log.txt)".
