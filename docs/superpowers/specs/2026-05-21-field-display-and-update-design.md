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
| Multi-line | mimeType `text/*`, ADF content, description-like strings >120 chars | Own `##` heading |
| Sprint | custom field with sprint objects | Own row: active sprint name only |
| Attachment list | `fields.attachment[]` | Separate `## Attachments` section (links) |

The metadata table appears immediately after the ticket heading. Multi-line
sections follow after the table, in the order they appear in the response.

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
| `ticketSidekick.jira.additionalDisplayFields` | `string[]` | `[]` | Field names always shown even when null |
| `ticketSidekick.jira.spellCheck` | `boolean` | `true` | Enable/disable typo correction offers |

Both are per-workspace (workspace settings override user settings in the
standard VS Code manner).

---

### 3 — Generalised single-ticket field update

`@jira set <field name> to <value> [on PROJ-123]`

Replaces the current hardcoded-7-field `updateField` path end-to-end.

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

For `add` / `remove` on bulk: fetch current values for each ticket in parallel
(`Promise.all`), build per-ticket payloads, then execute sequentially as today.
Flag in the preview: "Note: current values will be read per ticket before
applying."

---

### 5 — `@jira show fields`

New intent: list all fields available on a given ticket with their IDs and
current values. Useful for discovering field names to use in
`additionalDisplayFields` or in `@jira set`.

Output: a table of `Field name | Field ID | Current value`.

---

## Architecture

### `IJiraClient` — no new methods

All needed endpoints already exist: `getIssue` (returns all fields), `getFields`
(field metadata), `getEditMeta` (allowed values + schema), `updateIssue`.

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
network) that runs the four-step match against a pre-fetched field list:

```typescript
function resolveFieldIdFuzzy(
  input: string,
  fields: JiraFieldMeta[],
): JiraFieldMeta | JiraFieldMeta[] | null
// returns: single match, array of candidates, or null (no match)
```

**`buildArrayValue(fieldId, sampleKey, rawValues, op, currentValue)`** — extends
`buildFieldValue` for array operations.

**`getFieldMeta()`** — convenience wrapper around `client.getFields()` that
caches the result for the lifetime of the request (avoids repeated calls within
one handler turn).

### `sessionState.ts` — new session types

```typescript
export interface FieldUpdatePreviewSession {
  ticketKeys: string[];       // single or bulk
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

Insert before `parseIntent`:
- `<!-- jira:field-update-preview -->` → `FieldUpdatePreviewSession`
- `<!-- jira:spell-check -->` → `SpellCheckSession`

---

## Error handling

- Field not found after fuzzy matching → "Could not find a field matching
  `<input>`. Use `@jira show fields on PROJ-123` to see available fields."
- `getEditMeta` fails (field not editable) → surface Jira error message
- `add`/`remove` fetch fails → abort with error, no update attempted
- Bulk: individual ticket update failure → report per-ticket, continue (same
  as today)
- ISO date format invalid → "Date must be in YYYY-MM-DD format."

---

## Testing

- `resolveFieldIdFuzzy`: exact match, prefix match, substring match, multiple
  candidates, no match
- `formatIssueFields`: single-line fields → table; multi-line → section;
  null field not in always-show → omitted; null field in always-show → `_Not set_`
- `buildArrayValue`: set, add (dedup), remove
- `sessionState`: `FieldUpdatePreviewSession` and `SpellCheckSession` parse
  helpers
- `JiraParticipant.test.ts`: `setField` intent parsed with `arrayOp` and `scope`
- Sprint rendering: active sprint extracted from array; fallback to first
- Date rendering: ISO string → `YYYY-MM-DD` in table

---

## Out of scope

- Field display in search result table (stays: key, summary, status, assignee)
- Creating new Jira fields
- Bulk `add`/`remove` with per-ticket conflict resolution beyond the "current
  value read per ticket" note in preview
- MCP-based field access
