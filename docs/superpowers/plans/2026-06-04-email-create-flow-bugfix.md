# Fix: `@jira create from email` — Missing Type/Template Selection and Chat-Only Flow

**Date:** 2026-06-04  
**Branch:** `claude/jira-create-email-command-cRKFw`

## Problem

Two bugs in the EML email-to-ticket flow:

1. **`@jira create from email` in chat just says "use the Command Palette"** instead of opening an inline file picker. Users expect the chat command to work independently.

2. **After using the Command Palette, no template or issue-type selection is shown** — the ticket is created immediately with the wrong default type. Root cause: if `jiraClient.getProject()` fails transiently in `extension.ts` at command time, `availableIssueTypes` ends up `undefined`. With no templates configured (`availableTemplates` also `undefined`), `streamEmailContentPreview` shows only the simplified "post it" prompt — no numbered list, no type selection — and the ticket is created with the hardcoded `'Story'` default.

## Approach

### Bug 1 — In-chat file picker

When `handleCreateFromEmail` finds no session in `workspaceState`, instead of showing an error, run the same file-picker flow that `handleAddEmailFromChat` already uses. Extract a shared private helper `loadEmailSessionFromPicker` so both handlers reuse the same code.

### Bug 2 — Retry missing issue types

When `handleCreateFromEmail` finds a session but `availableIssueTypes` is missing/empty, retry `jiraClient.getProject()` before calling `streamEmailContentPreview`. This recovers from transient failures that happened at command time.

### `selectDefaultIssueType` helper

The `Story > Task > first > 'Story'` default-type logic is duplicated in `extension.ts` and `handleAddEmailFromChat`. Extract it as a named export from `sessionState.ts` so it is unit-testable and shared everywhere.

## Files Changed

| File | Change |
|---|---|
| `src/participant/sessionState.ts` | Add `selectDefaultIssueType(issueTypes)` export |
| `src/test/JiraParticipant.test.ts` | Add unit tests for `selectDefaultIssueType` (TDD first) |
| `src/participant/jira/emailHandler.ts` | Extract `loadEmailSessionFromPicker` helper; fix `handleCreateFromEmail` |
| `src/extension.ts` | Use `selectDefaultIssueType` instead of inline ternary |
