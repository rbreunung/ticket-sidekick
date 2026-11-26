---
title: "Ticket create must never guess an issue type, and a failed issue-type fetch must not remove the only way forward"
date: 2026-08-25
last_updated: 2026-11-26
category: logic-errors
module: "src/tools/jiraTools/createTicket.ts (jira_create_ticket handler); src/tools/jiraTools/toolMessages.ts (formatIssueTypeOptionsMessage)"
problem_type: logic_error
component: assistant
symptoms:
  - "A create with no issue type and no template-supplied one was submitted to Jira with the literal 'Task' as its issue type, with nothing to show it was a guess"
  - "A project with no 'Task' issue type answered with an opaque Jira 400; a project that had one got a ticket with a possibly wrong type, created silently"
  - "When the issue-type fetch failed, the 'issue types (no template)' section of the old selection list vanished because it was gated on a non-empty array, leaving the user nothing to pick but templates"
  - "Caught only by a post-implementation code review, not by planning review, the implementer or the tests"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [JiraTools, TicketService]
tags: [issue-type-resolution, silent-default, missing-fallback, failed-fetch, jira-create, code-review-finding]
---

# Ticket create must never guess an issue type, and a failed issue-type fetch must not remove the only way forward

## Problem

When a ticket is created without an issue type, and no template supplies one, the code must not fall back to a plausible literal such as `'Task'`. A guessed type looks like a real value all the way to Jira. It either comes back as an opaque 400 or creates a wrong-typed ticket without anyone noticing. The second half of the rule: when the list of valid issue types cannot be fetched, that failure must not silently remove the only way forward. The caller must still be told what to do next.

## Symptoms

This was first seen in the `@jira` chat participant's combined template and issue-type list, which was removed on 2026-11-16. The same rule now governs the `jira_create_ticket` tool. As observed then:

- A template with no `issueType`, combined with a failed issue-type fetch, was submitted with the literal `'Task'`. A project without that type got a Jira 400. A project with it got a ticket of a possibly wrong type, silently.
- With templates present and the fetch failed, the section listing issue types for a no-template create rendered only when `issueTypes.length > 0`. It disappeared, and the user could only pick a template or cancel. The older two-list code had always offered a free-type fallback in that case, so the merge regressed it.
- Neither problem showed up in planning review or in the implementer's own check. A review pass over the finished diff found both.

## What Didn't Work

- A `??` chain that bottomed out in a literal: `t.issueType ?? issueTypes[0] ?? 'Task'`. `'Task'` is a reasonable guess for many projects, which made it dangerous. Downstream, the list, the payload and Jira's error all treated it as a real choice, and nothing separated "the user chose this" from "the code invented this".
- Gating a section on `array.length > 0` without checking that every path building the array could leave it non-empty. A failed fetch produced an empty array, the section vanished, and no other path offered a way out.

## Solution

`src/tools/jiraTools/createTicket.ts` states in the tool's description that the issue type is never guessed. In the `jira_create_ticket` handler, the issue type comes from only two sources: the `issueType` argument (`requestedType`, trimmed, or undefined) and the issue type of a resolved template. There is no third, hardcoded source.

When both are missing, the handler creates nothing. It calls `ticketService.getIssueTypes(projectKey)`, logs a warning through `onDiag` if that call throws, and returns `formatIssueTypeOptionsMessage(projectKey, issueTypes)` from `src/tools/jiraTools/toolMessages.ts`, preceded by any template note.

`formatIssueTypeOptionsMessage` has two explicit branches:

- With issue types, it says no ticket was created and lists the project's valid types. It tells the caller to call the tool again with one as `issueType`, or with a `templateName`.
- With none, because the fetch failed or returned nothing, it has its own text. It says no ticket was created, that the project's issue types could not be fetched, and that the caller should call again with an explicit `issueType`.

A comment in `toolMessages.ts` records that this mirrors the old chat flow's never-guess handling. It is adapted from an input-box prompt to a returned message, because a tool call has no interactive prompt.

## Why This Works

The failure came from substituting a plausible default for a value that could not be resolved from any real source. One version hid the gap behind a fabricated value that reached Jira. The other hid it by removing the only path that could give a real answer.

The tool avoids both. An unresolved issue type is a stop condition, not a value, so there is nothing for a default to flow through. The failed-fetch case is a separate branch, not an empty list rendered through the success path, so the caller always gets a next step. Because the stop happens before `createTicket` runs, nothing is written to Jira on the unresolved path.

## Prevention

- Any `??` or `||` chain that ends in a hardcoded literal (a string like `'Task'`, a magic number, a default id) needs a stated reason. Ask whether the literal is a verified real value or stands in for "nothing worked". If it is the latter, return an explicit stop or error instead.
- Give the failed-fetch path its own explicit text instead of reusing the success path with an empty list. Gating output on `array.length > 0` is only safe when every path that builds the array can make it non-empty.
- Keep the tests in `src/test/jiraWriteTools.test.ts` under "create ticket": "without a template or issue type lists the issue types and creates nothing" and "creates nothing when the template names no issue type and the issue types cannot be read, and says what to give". The second pins the failed-fetch case, including that nothing is created.
- Review new create or write paths for the same shape: a value resolved from a remote lookup, with a fallback when the lookup fails.

## Related Issues

- [`concurrent-attachment-download-same-filename-race-silently-drops-one.md`](concurrent-attachment-download-same-filename-race-silently-drops-one.md): another silent-failure shape, where work disappears without any signal to the user.
- [`docs/onboarding.md`](../../onboarding.md) states the current never-guess rule and links here for the failure mode.
