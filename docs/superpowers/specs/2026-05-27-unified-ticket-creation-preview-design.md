# Unified Ticket Creation Preview

## Context

When a user runs `@jira create a ticket \`summary\`` with an inline description, the extension currently creates the ticket immediately after template/type resolution — no preview, no confirmation step.

The existing `ContentSession` / `streamContentPreview` / `handleContentSession` pipeline already provides a preview-and-refine loop for comments and description updates on existing tickets. The goal is to extend that same pipeline to cover ticket creation, giving the user one consistent confirm/adjust/cancel interaction across all write operations.

## Architecture

### `ContentSession` — discriminated union (`sessionState.ts`)

Replace the current flat interface with a union:

```typescript
export type ContentSession =
  | {
      operation: 'addComment' | 'updateDescription';
      ticketKey: string;
      currentContent: string;
      historyContext: string | undefined;
    }
  | {
      operation: 'createTicket';
      projectKey: string;
      summary: string;
      issueType: string;
      templateName: string | null;
      extraFields: Record<string, unknown>;
      currentContent: string;   // description text (markdown)
    };
```

`currentContent` is the refineable text in all variants. The workspaceState key (`jira.session.previewing`), detection order in `JiraParticipant`, and `isConfirmation` / `isCancellation` helpers are unchanged.

### `streamContentPreview` — ticket card renderer (`contentHandler.ts`)

Add a branch for `createTicket` that renders:

```
**Summary:** <summary>
**Type:** <issueType> | **Project:** <projectKey>[  |  **Template:** <templateName>]

**Description:**
<currentContent>

Reply **"create it"** to create the ticket, or tell me how to adjust the description.
<!-- jira:previewing -->
```

Existing `addComment` / `updateDescription` rendering is unchanged.

### `handleContentSession` — creation confirmation branch (`contentHandler.ts`)

On confirmation when `operation === 'createTicket'`:

1. Convert `currentContent` from Markdown → Jira wiki markup via `markdownToJiraWiki`
2. Call `ticketService.createTicket({ project, summary, issuetype, description, ...extraFields })`
3. Stream the result and clear the session

Refinement instructions (non-confirm, non-cancel) regenerate only `currentContent` (the description), same as the existing refinement loop.

No change to the function signature — `ticketService` is already a parameter.

### `continueAfterIssueType` — preview instead of immediate creation (`createHandler.ts`)

**Fast path** (no description sections): instead of calling `finishTicketCreation()` directly, build a `ContentSession` with `operation: 'createTicket'` and call `streamContentPreview()`.

**Section Q&A path** (templates with `descriptionSections`): same change at the end of `finishTicketCreation()` — after all sections are answered and the description is assembled, go to preview instead of the API call.

`ticketService.createTicket()` is only called from `handleContentSession` confirmation, never directly from `createHandler.ts` after this change.

## Data flow

```
@jira create a ticket `summary`
  └─ handleCreateTicket()
       ├─ streamTemplateSelection() ──wait──▶ user picks template
       ├─ parseIntent() → summary, description, issueType, extraFields
       ├─ streamIssueTypeSelection() ──wait──▶ user picks type
       └─ continueAfterIssueType()
            ├─ [section Q&A loop if template has descriptionSections]
            └─ streamContentPreview(ContentSession { operation:'createTicket', ... })
                                          ──wait──▶ user confirms / adjusts / cancels
                                              └─ handleContentSession() → ticketService.createTicket()
```

## Files to modify

| File | Change |
|------|--------|
| `src/participant/sessionState.ts` | `ContentSession` → discriminated union |
| `src/participant/jira/contentHandler.ts` | `streamContentPreview` card branch; `handleContentSession` createTicket confirmation |
| `src/participant/jira/createHandler.ts` | Replace direct `finishTicketCreation` API call with `streamContentPreview` |

## Out of scope

- `EmailContentSession` and `handleCreateFromEmail` — separate flow, not changed
- `updateDescription` / `addComment` behavior — unchanged
- New workspaceState keys — none added

## Verification

1. Run `npm run compile` — no TypeScript errors
2. Run `npm test` — existing tests pass; add tests for:
   - `streamContentPreview` renders a ticket card when `operation === 'createTicket'`
   - `handleContentSession` calls `ticketService.createTicket` on confirmation
   - `handleContentSession` refines `currentContent` on non-confirm input
3. Manual: `@jira create a ticket \`summary\`` with a description block — template selection, type selection, preview card, confirm → ticket created
4. Manual: existing `addComment` and `updateDescription` preview flows still work
