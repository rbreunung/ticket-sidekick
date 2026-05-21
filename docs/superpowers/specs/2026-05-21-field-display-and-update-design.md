# Design: generalised field display and update

**Date:** 2026-05-21
**Status:** Approved for implementation

---

## Problem

`@jira show` renders seven hardcoded fields and silently drops everything else —
custom fields, date fields, sprint, and any domain-specific metadata. The field
update path (`@jira set …`) is similarly restricted to seven hardcoded names
and cannot address custom fields at all. There is no array-aware set/add/remove,
no value disambiguation, and no typo correction.

---

## Feature overview

### 1 — Generalised field display

All non-null fields returned by `GET /issue/{key}` are displayed. `/field`
metadata provides human-readable names and is used to filter out Jira-internal
technical fields. Fields in `additionalDisplayFields` settings are always shown
even when null.

**Layout rules:**

| Field class | Criterion | Rendered as |
|---|---|---|
| Single-line | string, number, date, user, named-object, short array | Row in metadata table |
| Datetime | `datetime` schema type | Row in metadata table, formatted as `YYYY-MM-DD HH:mm` |
| Multi-line | mimeType `text/*`, ADF content, description-like strings >120 chars | Own `##` heading |
| Sprint | custom field with sprint objects | Own row: active sprint name only |
| Attachment list | `fields.attachment[]` | Separate `## Attachments` section (links) |

The metadata table appears immediately after the ticket heading. Multi-line
sections follow after the table, in the order they appear in the response.

**Excluded fields:** `comments` and `subtasks` are always excluded from the general
field table — they have dedicated rendered sections and must not be iterated by
`formatIssueFields`.

**Null / missing values:**
- Non-null fields not in settings: omitted
- Fields in `additionalDisplayFields` with null value: shown as `_Not set_`

**Date rendering:** ISO string → formatted as `YYYY-MM-DD` in the table.

**Sprint rendering:** extract `name` from the first sprint object whose `state`
is `active`, fall back to the first sprint name if none active.

**User field rendering:** `displayName`.

**Array field rendering:** join names / values with `, `; if the array is long
(>3 items) show first 3 then `… (+N more)`.

---

### 2 — New VS Code settings

| Setting | Type | Default | Purpose |
|---|---|---|---|
| `ticketSidekick.jira.additionalDisplayFields` | `string[]` | `[]` | Field **IDs** always shown even when null; use `@jira show fields on PROJ-123` to discover IDs |
| `ticketSidekick.jira.spellCheck` | `boolean` | `true` | Enable/disable typo correction offers |

Both are per-workspace (workspace settings override user settings in the
standard VS Code manner).

**Implementation note:** Both settings must be declared in `package.json` under
`contributes.configuration` for VS Code to surface them in the Settings UI and for
`ConfigService` to type-check them correctly.

---

### 3 — Generalised single-ticket field update

`@jira set <field name> to <value> [on PROJ-123]`

Replaces the current hardcoded-7-field `updateField` path end-to-end.

**Exception:** The `description` field retains the existing `ContentSession` flow
(LLM-generate + multi-turn refine). It is excluded from `FieldUpdatePreviewSession`;
`setField` routes description updates through `ContentSession` as before.

**Field name resolution — fuzzy matching:**

1. Exact case-insensitive match against `/field` names → use directly
2. Prefix match (input is a prefix of a field name) → use if unique
3. Substring match → use if unique
4. Multiple candidates → stream a numbered list and wait for selection
   (same `FilterSelectionSession`-style pattern already used elsewhere)
5. No match → error with suggestion to use `@jira show fields` to list available
   fields

**Value parsing:**

| Schema type | Input | Built value |
|---|---|---|
| `string` | any text | text as-is |
| `number` | numeric string | `parseFloat` |
| `date` | ISO string `YYYY-MM-DD` | string as-is (Jira accepts ISO) |
| named object (`priority`, `issuetype`, …) | text | `{ name: value }` |
| array of named objects | comma/`and`-separated or quoted list | `[{ name: v }, …]` |
| array of option objects | same | `[{ value: v }, …]` |
| user | name / email / "me" | resolved via `resolveAssignee` |

**Array operations:**

The intent parser extracts an `arrayOp` field:

- `set` — replace entire array with the new values
- `add` — fetch current value, append new items, deduplicate
- `remove` — fetch current value, remove matching items

For `add` and `remove`, the current value is fetched via `getIssue` before
building the update payload.

**Scope resolution (single vs bulk):**

| Situation | Behaviour |
|---|---|
| Explicit ticket key in prompt | single ticket |
| No ticket key, no active search result | resolve from branch / history as today |
| No ticket key, active search result exists | ask: "Apply to PROJ-123 or to all N tickets from your last search?" |
| User says "for all of them" / "for these tickets" | bulk, no question asked |

**Preview before applying:**

Always stream a confirm screen before writing. Example:

```
Set **Team Names** on PROJ-123 to:
- ASL Cary Everest
- ASL QRF

Reply **ok** to apply, **(c)** to cancel, or tell me how to adjust.
<!-- jira:field-update-preview -->
```

For bulk, the confirm screen lists all tickets and the new value.

The preview uses the existing `ContentSession`-style single-use session tag
`<!-- jira:field-update-preview -->` stored under
`jira.session.fieldUpdatePreview`.

**Value validation:**

After building the candidate value, check against `allowedValues` from editmeta:
- If `allowedValues` is non-empty and the value is not found: stream the allowed
  list as a numbered selection (same disambiguation pattern)
- If `allowedValues` is empty (free-form field): proceed without validation

**Typo correction (when `spellCheck` is `true`):**

Applies only to `schema.type === 'string'` fields (single-line and multi-line /
description). After the user provides a value, the LM is asked:

> "Does the following text contain obvious spelling or grammar errors? If yes,
> return a corrected version. If no, return the text unchanged."

If the LM returns a different string, stream:

```
Suggested correction:

> [corrected text]

Reply **use this** to accept, **keep mine** to use your original, or **(c)** to cancel.
<!-- jira:spell-check -->
```

Stored under `jira.session.spellCheck` with original + corrected + pending
field update context. If `spellCheck` is `false` in settings, skip this step.

---

### 4 — Bulk field update (search result scope)

Reuses the existing `BulkUpdateReviewSession` + `bulkUpdateField` machinery.
The only change is that field resolution goes through the new fuzzy matching
path instead of the hardcoded map.

**`BulkUpdateReviewSession` extension:** Add `arrayOp: 'set' | 'add' | 'remove'`
(default `'set'`) to the existing interface in `sessionState.ts` so the
preview/confirm step can carry the operation for `add`/`remove` bulk flows.

For `add` / `remove` on bulk: fetch current values for each ticket in parallel
(`Promise.all`), build per-ticket payloads, then execute sequentially as today.
Flag in the preview: "Note: current values will be read per ticket before
applying."

---

### 5 — `@jira show fields`

New intent: list all fields available on a given ticket with their IDs and
current values. Useful for discovering field IDs to use in
`additionalDisplayFields` or in `@jira set`.

Output: a table of `Field name | Field ID | Current value`.

If no ticket key is given, the plugin resolves the ticket using the standard
order: explicit key in prompt → current git branch → last ticket in chat
history → input box.

---

### 6 — Sprint field handling

Sprint is a Jira custom field whose API value is an array of sprint objects
`[{ id, name, state, … }]`. Unlike named-object fields (`priority`,
`issuetype`, …), setting a sprint requires an integer `id` — not `{ name }`.

**Display (show + load):** Already covered in §1 — active sprint name shown in
the metadata table, falling back to the first sprint name if none is active.
No change from the display spec.

**Sprint field detection:** A field is treated as a sprint field when its
`schema.custom` (from `/field` metadata) contains `gh-sprint`. This check is
applied in `buildFieldValue` before the standard named-object path.

**New client method — `IJiraClient` + `JiraApiClient`:**

```typescript
findSprints(
  projectKey: string,
  query: string,
): Promise<Array<{ id: number; name: string; state: string }>>
```

Searches all boards for the project via the Agile API
(`/board?projectKeyOrId=…`), returns sprints whose names
case-insensitively contain `query`. Active and future sprints only
(same scope as the existing `getSprintByName`).

`getSprintByName` is **not changed** — `FieldResolver` continues to use it
for template-based creation where the sprint name in config must be exact.
Template misconfiguration throws with the candidate list in the error message.

**Fuzzy resolution for update and inline create:**

1. Exact match (case-insensitive) → use immediately
2. Unique substring match → use immediately
3. Multiple substring matches → numbered disambiguation list, same pattern as
   field name disambiguation; stored as `SprintSelectionSession` with the
   pending field-update context:

   ```
   Multiple sprints match "sprint 4":
   1. Sprint 42 (active)
   2. Sprint 43 (future)

   Reply with a number to select.
   <!-- jira:sprint-selection -->
   ```

4. No match → error: "No active or future sprint matching `<input>` found in
   project PROJ. Use `@jira show fields on PROJ-123` to see current sprint."

**Update payload:** `{ fields: { [fieldId]: { id: sprintId } } }` (integer id).

**Inline create:** When the intent parser extracts a sprint name from a create
prompt, the same `findSprints` fuzzy resolution fires before `createTicket` is
called. If ambiguous, sprint selection completes before the creation session.

**New session type:**

```typescript
export interface SprintSelectionSession {
  candidates: Array<{ id: number; name: string; state: string }>;
  // Discriminated union: covers both the field-update path and inline-create path.
  pending:
    | { kind: 'field-update'; session: FieldUpdatePreviewSession }
    | { kind: 'creation'; sprintFieldId: string };
}
```

Stored under `jira.session.sprintSelection`, tag `<!-- jira:sprint-selection -->`.
Detection order: insert before `<!-- jira:field-update-preview -->`.

**MockJiraClient:** `findSprints` must be implemented in `MockJiraClient` with a
corresponding fixture file in `src/test/fixtures/` (matching real Agile API shape)
to satisfy the project's test architecture rule.

---

## Architecture

### `IJiraClient` — one new method

`findSprints(projectKey, query)` as described in §6. All other needed endpoints
already exist: `getIssue` (returns all fields), `getFields` (field metadata),
`getEditMeta` (allowed values + schema), `updateIssue`.

### `TicketService` changes

**`formatIssue` → replaced by `formatIssueFields`:**

```typescript
function formatIssueFields(
  issue: JiraIssue,
  fieldMeta: JiraFieldMeta[],
  alwaysShowIds: Set<string>,
): { table: string; sections: string[] }
```

Takes the full `/field` list to resolve IDs → names. Returns:
- `table`: the metadata table (all single-line non-null fields + always-show)
- `sections`: array of `## Heading\n\ncontent` strings for multi-line fields

Callers (`getTicket`, `handleLoadTicket`) assemble the final output.

**`resolveFieldIdFuzzy(name, fields)`** — new pure function (testable without
network) that runs the four-step match against a pre-fetched field list. Returns
a discriminated union to eliminate `Array.isArray` checks at every callsite:

```typescript
type FieldResolutionResult =
  | { kind: 'match';      field:  JiraFieldMeta }
  | { kind: 'candidates'; fields: JiraFieldMeta[] }
  | { kind: 'none' }

function resolveFieldIdFuzzy(
  input: string,
  fields: JiraFieldMeta[],
): FieldResolutionResult
```

**`buildArrayValue(fieldId, sampleKey, rawValues, op, currentValue)`** — extends
`buildFieldValue` for array operations.

**`getFieldMeta()`** — thin wrapper around `client.getFields()`. It is called
once in `JiraParticipant` at the start of each handler turn and the result is
passed as a parameter to `formatIssueFields`, `resolveFieldIdFuzzy`, and
`handleSetField`. No instance-level cache is needed or used.

### `sessionState.ts` — new and extended session types

```typescript
// Extend the existing BulkUpdateReviewSession with arrayOp:
export interface BulkUpdateReviewSession {
  ticketKeys: string[];
  fieldId: string;
  fieldName: string;
  fieldValue: unknown;
  arrayOp: 'set' | 'add' | 'remove';  // NEW — default 'set'
}

// New: field-name disambiguation when multiple candidates match
export interface FieldSelectionSession {
  candidates: JiraFieldMeta[];
  pending: {
    fieldValue: string;
    arrayOp: 'set' | 'add' | 'remove';
    ticketKeys: string[];
  };
}
// Stored under jira.session.fieldSelection, tag <!-- jira:selecting-field -->

export interface FieldUpdatePreviewSession {
  ticketKeys: string[];       // one entry for single-ticket, many for bulk
  fieldId: string;
  fieldName: string;
  fieldValue: unknown;
  isArray: boolean;
  arrayOp: 'set' | 'add' | 'remove';
}

export interface SpellCheckSession {
  original: string;
  corrected: string;
  pending: FieldUpdatePreviewSession;
}

// SprintSelectionSession — see §6 for full definition
```

### `JiraParticipant` intent schema changes

Add to `contentSource`-adjacent fields:

```
"fieldName": string | null      — human-readable field name from prompt
"fieldValue": string | null     — raw value string (may be comma/and-separated)
"arrayOp": "set"|"add"|"remove" — default "set"
"scope": "single"|"bulk"|null   — null = resolve from context
```

Replace hardcoded `updateField` routing with new `setField` operation that goes
through fuzzy resolution → editmeta validation → optional spell-check →
preview → confirm.

### Session detection order additions

Insert after `content` (`ContentSession`) and before `more-comments`
(`MoreCommentsSession`), in this order:

1. `<!-- jira:sprint-selection -->` → `SprintSelectionSession`
2. `<!-- jira:selecting-field -->` → `FieldSelectionSession`
3. `<!-- jira:field-update-preview -->` → `FieldUpdatePreviewSession`
4. `<!-- jira:spell-check -->` → `SpellCheckSession`

Updated full detection order: resolution selection → transition review →
filter selection → bulk-update-review → template selection → issue type
selection → creation → content → **sprint selection → field selection →
field-update-preview → spell-check** → more-comments → check command →
comment list → intent parse.

---

## Error handling

- Field not found after fuzzy matching → "Could not find a field matching
  `<input>`. Use `@jira show fields on PROJ-123` to see available fields."
- `getEditMeta` fails (field not editable) → surface Jira error message
- `add`/`remove` fetch fails → abort with error, no update attempted
- Bulk: individual ticket update failure → report per-ticket, continue (same
  as today)
- ISO date format invalid → "Date must be in YYYY-MM-DD format."
- Sprint not found after fuzzy matching → "No active or future sprint matching
  `<input>` found in project PROJ. Use `@jira show fields on PROJ-123` to see
  the current sprint."

---

## Testing

- `resolveFieldIdFuzzy`: exact match, prefix match, substring match, multiple
  candidates, no match
- `formatIssueFields`: single-line fields → table; multi-line → section;
  null field not in always-show → omitted; null field in always-show → `_Not set_`
- `buildArrayValue`: set, add (dedup), remove
- `sessionState`: `FieldUpdatePreviewSession`, `SpellCheckSession`, and
  `SprintSelectionSession` parse helpers
- `JiraParticipant.test.ts`: `setField` intent parsed with `arrayOp` and `scope`
- Sprint rendering: active sprint extracted from array; fallback to first
- Sprint fuzzy resolution: exact match, unique substring, multiple candidates
  → disambiguation list, no match → error
- `findSprints`: returns only active and future sprints; substring match is
  case-insensitive; `MockJiraClient` implementation backed by a fixture file
- `@jira show fields`: output table contains all three columns (Field name |
  Field ID | Current value); resolves ticket from branch when no key given
- Date rendering: ISO string → `YYYY-MM-DD` in table
- Datetime rendering: ISO datetime string → `YYYY-MM-DD HH:mm` in table

---

## Out of scope

- Field display in search result table (stays: key, summary, status, assignee)
- Creating new Jira fields
- Bulk `add`/`remove` with per-ticket conflict resolution beyond the "current
  value read per ticket" note in preview
- MCP-based field access
