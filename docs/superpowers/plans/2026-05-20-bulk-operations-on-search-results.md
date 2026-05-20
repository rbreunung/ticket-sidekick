# Plan: Bulk operations on search results

## Why

After `@jira show me tickets from filter 12345` the user should be able to
say "transition them to Done" or "set Team Names to 'ASL Cary'" without
having to name the tickets again. Currently search results are streamed and
forgotten — no session survives the turn.

---

## Scope

Two follow-up operations on the tickets returned by any JQL/filter search:

1. **Bulk transition** — `transition them to Done`, `move them to In Progress`
2. **Bulk field update** — `set Team Names to 'ASL Cary'`, `set priority to High`

Both require a confirmation screen before any writes. Cancellation and
per-ticket skipping follow the same pattern as the existing cleanup flow.

---

## New session type: `SearchResultSession`

```typescript
// src/participant/sessionState.ts
export interface SearchResultSession {
  ticketKeys: string[];   // ordered list of keys from the last search
  jql: string;            // the JQL that produced the results (for display)
}
```

Saved to `workspaceState` key `jira.session.searchResult` after every
successful `searchJql` / filter execution. No HTML marker needed — it is a
_background_ session consulted only when the follow-up intent is
`bulkTransition` or `bulkUpdateField`. It is overwritten on every new search
and cleared after a bulk operation completes.

---

## New operations in `ParsedIntent`

Add two new operation types and two new fields:

```typescript
type Operation = ... | 'bulkTransition' | 'bulkUpdateField';

interface ParsedIntent {
  ...
  targetStatus: string | null;       // for bulkTransition, e.g. "Done"
  bulkFieldName: string | null;      // for bulkUpdateField, e.g. "Team Names"
  bulkFieldValue: string | null;     // for bulkUpdateField, e.g. "ASL Cary"
}
```

Intent prompt additions:

```
- bulkTransition: transition/move/close/resolve "them" or "these tickets" or "all of them" to a status; requires a prior search result session; targetStatus is the destination state
- bulkUpdateField: set/update/change a field on "them" or "these tickets"; bulkFieldName is the field name the user gave, bulkFieldValue is the value; requires a prior search result session
```

---

## Field resolution for bulk update

### Step 1 — name → ID

`GET /rest/api/2/field` returns every field with `id`, `name`, and `schema`.
Case-insensitive match on `field.name`.  
New method on `IJiraClient`:

```typescript
getFields(): Promise<JiraFieldMeta[]>

export interface JiraFieldMeta {
  id: string;
  name: string;
  schema: { type: string; items?: string; custom?: string };
}
```

Cache the result in `TicketService` for the lifetime of the handler call
(one `Map<string, JiraFieldMeta>` local variable — no persistent cache needed).

### Step 2 — value shape

After resolving the field ID, call:

```
GET /rest/api/2/issue/{firstTicketKey}/editmeta
```

The response contains per-field metadata including `schema` and
`allowedValues`. Use these rules to wrap the user's string value:

| `schema.type` | `schema.items` / `allowedValues` shape | API value |
| --- | --- | --- |
| `string` | — | `"ASL Cary"` |
| `number` | — | `3` (parse float) |
| `option` | has `value` key | `{ "value": "ASL Cary" }` |
| `array` | items have `name` key | `[{ "name": "ASL Cary" }]` |
| `array` | items have `value` key | `[{ "value": "ASL Cary" }]` |
| `array` | items are strings | `["ASL Cary"]` |
| `user` | — | delegate to `resolveAssignee` |

If the editmeta field is absent (field not editable on that ticket) or the
shape cannot be determined, surface a clear error before touching anything.

New helpers in `TicketService`:

```typescript
resolveFieldId(name: string): Promise<string>          // name → customfield_XXXXX
buildFieldValue(fieldId: string, sampleKey: string, rawValue: string): Promise<unknown>
```

---

## Confirmation screen for bulk field update

Reuse the pattern from `TransitionBatchSession`. Before writing anything,
stream a preview table:

```
**Bulk update: Team Names → ASL Cary**
(12 tickets)

| Key | Summary | Current value |
| --- | --- | --- |
| PROJ-1 | Login bug | — |
| PROJ-2 | ... | Backend |

Reply **ok** to apply, **(c)** to cancel, or list keys to skip (e.g. `skip PROJ-2`).

<!-- jira:bulk-update-review -->
```

Save a `BulkUpdateReviewSession` to `jira.session.bulkUpdateReview`:

```typescript
export interface BulkUpdateReviewSession {
  ticketKeys: string[];
  fieldId: string;
  fieldName: string;      // original user-supplied name (for display)
  fieldValue: unknown;    // already resolved API shape
}
```

On confirmation: call `ticketService.updateIssue(key, { [fieldId]: fieldValue })` for
each key sequentially, streaming one line per ticket.  
On skip: same `parseSkipInput` helper already used by cleanup.

---

## Bulk transition

Route directly into the **existing** `TransitionBatchSession` machinery:

1. Fetch transitions for each ticket in `SearchResultSession.ticketKeys`
   (parallel `Promise.all`) — same work `discoverWorkflow` and cleanup do.
2. Use existing `findPath(graph, current, targetStatus)` where graph is
   computed on the fly from the fetched transitions (no cache needed for
   ad-hoc use).
3. Stream the existing review screen via `streamReviewScreen`.
4. The existing confirmation / skip / execute path handles the rest unchanged.

If `targetStatus` requires a resolution (closed-state heuristic already in
`handleRunCleanup`) prompt for it first via the existing `ResolutionSelectionSession`.

---

## New IJiraClient methods

```typescript
getFields(): Promise<JiraFieldMeta[]>;
getEditMeta(issueKey: string): Promise<Record<string, JiraEditMetaField>>;

export interface JiraEditMetaField {
  schema: { type: string; items?: string };
  allowedValues?: Array<{ id?: string; name?: string; value?: string }>;
}
```

---

## Detection order change

Add to the Jira handler detection order, **before** intent parse:

```
... → more-comments → bulk-update-review → check command → comment list → intent parse
```

`bulkTransition` and `bulkUpdateField` intents are handled inside the main
intent-parse branch (they look up `SearchResultSession` there, same as
`searchJql` looks up filter sessions).

---

## Files to create / modify

| File | Change |
| --- | --- |
| `src/jira/IJiraClient.ts` | Add `JiraFieldMeta`, `JiraEditMetaField`, `getFields()`, `getEditMeta()` |
| `src/jira/JiraApiClient.ts` | Implement both methods |
| `src/test/fixtures/fields.json` | Array of `JiraFieldMeta` (subset) |
| `src/test/fixtures/editmeta-PROJ-123.json` | Editmeta response for the test ticket |
| `src/test/mocks/MockJiraClient.ts` | Implement both methods |
| `src/participant/sessionState.ts` | Add `SearchResultSession`, `BulkUpdateReviewSession`, `parseBulkUpdateReview` |
| `src/services/TicketService.ts` | Add `resolveFieldId`, `buildFieldValue`, `bulkUpdateField` |
| `src/participant/JiraParticipant.ts` | Save `SearchResultSession` after search; add `bulkTransition` / `bulkUpdateField` intent routing; add `bulkUpdateReview` session handler |
| `src/test/TicketService.test.ts` | Tests for `resolveFieldId`, `buildFieldValue`, all value-shape cases |
| `src/test/JiraParticipant.test.ts` | Tests for `parseBulkUpdateReview` |

---

## Test plan (TDD — write tests first)

### TicketService — field resolution

| # | Input | Expected |
| --- | --- | --- |
| 1 | `resolveFieldId("Team Names")` | returns `customfield_10500` |
| 2 | `resolveFieldId("team names")` | same (case-insensitive) |
| 3 | `resolveFieldId("nonexistent")` | throws with clear message |
| 4 | `buildFieldValue` — schema `string` | `"ASL Cary"` |
| 5 | `buildFieldValue` — schema `array`, allowedValues have `name` | `[{ "name": "ASL Cary" }]` |
| 6 | `buildFieldValue` — schema `array`, allowedValues have `value` | `[{ "value": "ASL Cary" }]` |
| 7 | `buildFieldValue` — schema `option` | `{ "value": "ASL Cary" }` |
| 8 | `buildFieldValue` — field absent from editmeta | throws with clear message |

### sessionState — parseBulkUpdateReview

| # | Input | Expected |
| --- | --- | --- |
| 9 | `"ok"` | `{ action: "ok", skip: [] }` |
| 10 | `"skip PROJ-2 PROJ-5"` | `{ action: "ok", skip: ["PROJ-2","PROJ-5"] }` |
| 11 | `"c"` / `"cancel"` | `{ action: "cancel" }` |
| 12 | `"something else"` | `{ action: "invalid" }` |

---

## Execution order

1. Write all failing tests (TicketService + sessionState)
2. Add `JiraFieldMeta` / `JiraEditMetaField` types, `getFields` / `getEditMeta` to `IJiraClient`
3. Implement fixture files + `MockJiraClient`
4. Implement `JiraApiClient`
5. Implement `resolveFieldId`, `buildFieldValue`, `bulkUpdateField` in `TicketService`
6. Implement `SearchResultSession`, `BulkUpdateReviewSession`, `parseBulkUpdateReview` in `sessionState`
7. Wire `JiraParticipant`: save search result session, add intent routing, add review-screen handler
8. Full test suite green + `npm run compile` clean
9. Commit
