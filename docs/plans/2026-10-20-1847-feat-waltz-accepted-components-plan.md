---
title: Waltz accepted components - Plan
type: feat
date: 2026-10-20
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Waltz accepted components - Plan

## Goal Capsule

- **Objective:** A Waltz OSS component the team has decided to live with, or cannot upgrade because no newer version exists, stops asking for decisions on every import, and its leftover open ticket gets offered for closing.
- **Means:** Component-and-version entries in the existing `.jira-oss-accepted.json`, applied to the New, Already ticketed and Stale screens (KTD1, KTD3).
- **Authority:** The Product Contract below wins on behavior; a KTD wins on mechanism within it. `docs/report-import.md` stays the developer reference and must be updated with the code.
- **Stop conditions:** Stop and ask if the shared entry format cannot keep existing per-CVE files working unchanged (R9), or if refreshing Stale after an accept needs more than the data the review session can hold (KTD5).
- **Execution profile:** Code, test-first per unit where noted. Run `npm run compile` and `npm test` before any commit.

---

## Product Contract

### Summary

A user can accept a Waltz component at an exact version, with an optional reason, from the Already ticketed or New screen. An accepted component is never offered as a new ticket, its existing tickets leave Already ticketed, and an existing ticket with no resolution is offered for closing on the Stale screen. Entries live in `.jira-oss-accepted.json` next to the existing per-CVE entries and stay until removed.

### Problem Frame

Rows for components the team has accepted, or cannot upgrade, return on every Waltz import. They appear under Already ticketed as `leave`, and as New when no ticket exists. The accepted-CVE list does not help with the first case: it only narrows rows that have no ticket yet. Their open tickets stay open indefinitely because nothing flags them for closing. The list should show only what still needs a decision.

### Requirements

**Marking**

- R1. A user can accept a component at its exact version, with an optional reason, from the Already ticketed screen and from the New screen. Nothing is accepted automatically or inferred from the report's fixed-version column.
- R2. Marking only touches the workspace file. Jira tickets are never modified by accepting.

**Effect on the import screens**

- R3. An accepted component is never offered as a new ticket.
- R4. An accepted component's existing tickets do not appear on Already ticketed, whether those tickets are open or resolved.
- R5. An accepted component's existing ticket with no resolution is offered on the Stale screen, even when the report still lists the component. A resolved ticket is not.
- R6. An entry matches one exact component name and version. Another version of the same component is a normal row.
- R7. An accepted component stays accepted when the report shows a new CVE, a higher rating or a fixed version. Only removing the entry brings it back.

**Visibility and storage**

- R8. The overview, or the only screen of a single-group import, shows how many components are accepted, with a link that lists the entries (reason, version) and a Remove link on each.
- R9. Entries share `.jira-oss-accepted.json` and one entry format with the existing per-CVE entries. Existing files and per-CVE behavior work unchanged.
- R10. The file contract is unchanged: reading never throws and hides nothing when the file is broken, and writing never overwrites a file that could not be read in full.

**Scope**

- R11. Waltz only. The Veracode and email imports are unchanged.

### Key Decisions

- Marking is manual only. (session-settled: user-directed — chosen over automatic hiding from the fixed-version column and over suggest-and-confirm: the column may be blank for reasons that are not "no update".) Governs R1.
- An entry covers an exact component and version. (session-settled: user-directed — chosen over matching by name only: an upgraded component must be reviewed again.) Governs R6.
- Accepted components stay accepted until removed. (session-settled: user-directed — chosen over reappearing on a new CVE or rating rise: the user wants hidden to mean hidden.) Governs R7.
- Entries use the same file and format as the per-CVE entries. (session-settled: user-directed — chosen over a separate file: "one format for all".) Governs R9.
- Components can be accepted on both Already ticketed and New. (session-settled: user-approved — proposed with the New-screen `accept` kept CVE-only as the alternative.) Governs R1.
- An accepted component's open ticket goes to Stale. (session-settled: user-directed — stated by the user: accepted components leave Already ticketed and show in Stale when the resolution is empty.) Governs R4, R5.
- Visibility is a count with a link, not a silent hide. (session-settled: user-approved — proposed over a silent hide and over a count without a link.) Governs R8.

### Acceptance Examples

- AE1. Covers R3. Given `netty-codec:4.1.100` is accepted and has no ticket, when the report lists it, it is not on the New screen.
- AE2. Covers R4, R5. Given `netty-codec:4.1.100` is accepted and has an open ticket, when the import runs, the component is not under Already ticketed and the ticket is under Stale.
- AE3. Covers R4, R5. Given the accepted component's ticket has a resolution, the component is not under Already ticketed and no Stale row appears.
- AE4. Covers R6. Given `netty-codec:4.1.100` is accepted and the report now lists `netty-codec:4.1.101`, the newer version is a normal row.
- AE5. Covers R7. Given an accepted component gains a new Critical CVE in the report, it is still hidden.
- AE6. Covers R9. Given a file holding only `{ component, cve }` entries, the import behaves exactly as before.

### Scope Boundaries

- Veracode and email imports, and any change to Jira tickets when accepting, are outside this plan.
- Closing a stale ticket reuses the existing Stale close (issue type, target, resolution); this plan adds no new close path.
- Hiding rows for other reasons (a filter-style "hide unchanged" control) is not part of this plan.

#### Deferred to Follow-Up Work

- Updating `docs/known-limitations.md` is only needed if implementation surfaces a new limitation.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One entry record, kind by field.** An entry is `{ component, version?, cve?, reason? }`. With `cve` it is a CVE pair matched on component name only, as today, and any `version` on it is ignored. Without `cve` and with `version` it is a component-and-version entry. An entry with neither is skipped with the existing warning. Existing files stay valid, and a hand-edited file with a new entry still parses. Governs R6, R9. (session-settled: user-directed — chosen over a separate file: "one format for all".)
- KTD2. **Match on a normalized name and version.** The component name is `nameVersion` up to its last `:` and the version is the part after it, as `componentNameOf` already splits it. Both compare trimmed and case-insensitively, consistent with how `sanitizeComponentLabel` lowercases the dedup label. Governs R6.
- KTD3. **Apply the list at three points.** New: `narrowGroup` drops accepted members before any per-CVE logic. Already ticketed: a new optional hook on `buildReviewRows` drops a ticketed item before its row id is assigned, so surviving ids stay contiguous and the report's items are never mutated. Stale: the descriptor's active-component predicate treats an accepted component as inactive, so the existing "stale only when every id is inactive" rule applies. Governs R3, R4, R5.
- KTD4. **Hide regardless of ticket state.** A ticketed row for an accepted component is dropped whether its tickets are open or resolved. Stale already searches only unresolved tickets, so a resolved ticket never reaches it. Governs R4, R5.
- KTD5. **Accepting mid-review refreshes Stale from a stored snapshot.** At build time `findStaleTickets` also reports the open marker-labeled tickets it did not flag, with the dedup ids still active for each. The review session stores those candidates with the summary, status and issue type already captured by the search. After an accept, a candidate whose remaining active ids are all accepted joins the Stale list, grouped by the existing `buildStaleTicketGroups`. This avoids a second Jira search and does not need the raw report at reply time, which is cleared after the build. Governs R5. (Rejected: showing the ticket on the next import only, since the point is to close the leftover ticket in the same pass.)
- KTD6. **Reply vocabulary.** `accept component <rows> [because <reason>]` on New (row numbers) and Already ticketed (`A` ids). The existing `accept <rows>` on New keeps meaning "these rows' CVEs". Component entries in the `accepted` list get their own Remove reply form that cannot be read as the `unaccept <component> <CVE>` form. The exact wording is chosen in U4 and pinned by the existing reply-vocabulary disjointness test. Governs R1, R8.
- KTD7. **Count accepted components with the existing hidden counters.** `AcceptedHidden` gains a `components` count, summed over rows dropped from New and Already ticketed. The session schema version is bumped per the convention noted at `CURRENT_SESSION_SCHEMA_VERSION`. Governs R8.

### Assumptions

- Tickets created by Ticket Sidekick carry both the `oss-dependency` marker and the `oss-dep-…` component label, so they are findable by dedup and by the stale search. A hand-made ticket without the marker can be hidden from Already ticketed but cannot appear on Stale.
- An older extension version reading a file with component entries skips them with its existing warning and refuses to write (R10). This is accepted; the manual says to update the extension for the team.

### Alternatives Considered

- A separate hidden-components file or a `hide` list on the ticket side was rejected by R9's "one format".
- Persisting `rawItems` in the review session so Stale can be recomputed in full was rejected: the report can hold thousands of components, and the stored candidates need only the label strings (KTD5).

### System-Wide Impact

- `findStaleTickets` is shared with Veracode. Its added candidates output must leave Veracode's behavior and result shape unchanged for existing callers.
- `ImportAccepted` gains members and `buildActivePredicate` gains an optional second argument. Veracode and email omit both and stay unchanged.
- The session schema version is one shared constant, so the bump (KTD7) expires every in-flight multi-turn session, not only import reviews (`isSessionExpired`), as earlier bumps did.

### Risks

- The Stale refresh (KTD5) adds state to the session and one more path through `buildStaleTicketGroups`. The unit keeps the new path to merging already-known candidates, so no new Jira search is needed beyond what the group builder does.
- The stale search reads every page of open marker-labeled tickets up to a safety bound of 1000, so the stored candidates are bounded the same way. A ticket beyond that bound reaches Stale on a later import, after the search's "coverage may be incomplete" notice.
- The reply handler must reach a Jira client for `buildStaleTicketGroups`. How it does so (through the ticket service or by threading the client) is settled in U5.

---

## Implementation Units

### U1. Entry format, matching and file service

- **Goal:** Read, write, match and narrow component-and-version entries alongside CVE pairs.
- **Requirements:** R3, R6, R7, R9, R10; KTD1, KTD2.
- **Dependencies:** none.
- **Files:** `src/utils/waltzAccepted.ts`, `src/services/AcceptedListService.ts`, `src/test/waltzAccepted.test.ts`, `src/test/AcceptedListService.test.ts`.
- **Approach:**
  - Extend `AcceptedEntry` and `parseAcceptedFile` to the KTD1 shape; the validity rule changes from "component and cve" to "component and (cve or version)".
  - Add `componentVersionOf` next to `componentNameOf`, a component-entry key, and `isComponentAccepted`.
  - `narrowGroup` drops accepted members first, returns a `hiddenComponents` count, then runs the existing CVE logic on what remains.
  - Add entries for a group's components (`acceptedComponentEntriesOf`), dedupe on add, and remove by component and version.
  - Add the matching service methods; keep the refuse-to-write guard.
- **Patterns to follow:** the existing pair helpers in `src/utils/waltzAccepted.ts` and the service's `add`/`removePair`.
- **Test scenarios:**
  - Covers AE6. A file with only `{ component, cve }` entries parses and narrows exactly as before.
  - A `{ component, version }` entry parses as a component entry; an entry with only a component is skipped with the warning count.
  - An entry with both `cve` and `version` is read as a CVE pair and ignores the version.
  - Covers AE4. `netty-codec:4.1.100` accepted drops that member and keeps `netty-codec:4.1.101`.
  - A name match is case-insensitive and trims whitespace; a version differing only by case matches.
  - A group of two members where one is accepted keeps the other, with its own rating untouched.
  - Adding an already-listed component and version reports zero added; removing one that is not listed returns null.
  - A file that could not be read in full is not rewritten when adding a component entry.
- **Verification:** the existing accepted-CVE tests still pass unchanged, and the new scenarios pass.

### U2. Hide accepted components when the review is built

- **Goal:** Accepted components never reach New or Already ticketed.
- **Requirements:** R3, R4, R8; KTD3, KTD4, KTD7.
- **Dependencies:** U1.
- **Files:** `src/utils/reportImport.ts`, `src/participant/jira/reportImportHandler.ts`, `src/participant/jira/reportImportTypes.ts`, `src/participant/jira/waltzHandler.ts`, `src/participant/session/importTypes.ts`, `src/participant/session/importScreens.ts`, `src/test/reportImport.test.ts`, `src/test/reportImportAccepted.test.ts`, `src/test/reportImportOverview.test.ts`.
- **Approach:**
  - Add an optional drop hook to `buildReviewRows` for items that matched a ticket, applied before the row id is assigned.
  - Extend `ImportAccepted` with `isAccepted` and `componentEntriesOf`; Waltz implements them, Veracode and email omit them.
  - In the build, wire the hook from the loaded entries and count dropped components into `AcceptedHidden.components`.
  - Bump the schema version and extend the hidden-line, `describeAcceptedHidden` and all-hidden message wording.
- **Patterns to follow:** the existing `narrowNew` wiring and `acceptedHidden` counting in `reportImportHandler.ts`.
- **Test scenarios:**
  - Covers AE1. An accepted component with no ticket is absent from New and counted.
  - Covers AE2, AE3. An accepted component with an open ticket and one with a resolved ticket are both absent from Already ticketed.
  - Surviving ticketed rows keep contiguous `A` ids after a row is dropped.
  - A drop applies to a ticket shared by several rows only for the accepted member's row.
  - Covers AE5. An accepted component with a new CVE in the report is still dropped.
  - The overview line shows the component count with the Show accepted link; an import where only accepted components remain ends with the all-hidden message.
  - A Veracode import's rows, ids and overview are identical to before.
- **Verification:** `src/test/reportImportHandler.test.ts` and the Veracode tests pass unchanged.

### U3. Treat accepted components as inactive for Stale

- **Goal:** An accepted component's open ticket is flagged stale on the next import, and the stale search keeps the data U5 needs.
- **Requirements:** R5; KTD3, KTD5.
- **Dependencies:** U1.
- **Files:** `src/utils/reportImport.ts`, `src/participant/jira/waltzHandler.ts`, `src/participant/jira/reportImportTypes.ts`, `src/participant/jira/reportImportHandler.ts`, `src/participant/session/importTypes.ts`, `src/test/reportImportStale.test.ts`.
- **Approach:**
  - `buildWaltzActiveComponentPredicate` takes the loaded entries and reports a component as inactive when `isComponentAccepted` holds for it. `descriptor.stale.buildActivePredicate` gains an optional second argument for the entries; Veracode ignores it.
  - `findStaleTickets` additionally returns the open tickets it did not flag, with the ids still active for each. Existing fields keep their shape.
  - The build stores those candidates, with the details the search already captured, on the review session.
- **Patterns to follow:** the existing predicate builder and the `issueDetails` capture in the stale search.
- **Test scenarios:**
  - Covers AE2. An open ticket whose only component label is accepted is returned as stale even though the report still lists the component.
  - A ticket covering two components, one accepted and one active, is not stale.
  - Covers AE3. A ticket with a resolution is never searched, so it never appears.
  - Candidates returned for non-stale tickets list only their still-active ids; a ticket with no component labels is neither stale nor a candidate.
  - Veracode's stale result is unchanged for its existing callers.
- **Verification:** the existing stale tests in `src/test/reportImportStale.test.ts` pass unchanged.

### U4. Reply vocabulary and screen text

- **Goal:** Users can accept a component and remove an entry by reply, and the screens tell them how.
- **Requirements:** R1, R8; KTD6.
- **Dependencies:** U1.
- **Files:** `src/participant/session/importReplies.ts`, `src/participant/session/importScreens.ts`, `src/test/reportImportAcceptReplies.test.ts`, `src/test/sessionImportReview.test.ts`.
- **Approach:**
  - Add the `accept component` reply to the New and Already ticketed parsers, with the visible-row check the existing `accept` uses; `A` ids on Already ticketed.
  - Add the component-entry Remove reply form and its action kind next to `unacceptEntry`.
  - Extend `buildAcceptedList` to list both kinds with the component, version, reason and a Remove link, and add the new hints to the New and Already ticketed screens.
  - Extend the vocabulary-description strings used for "didn't understand" replies.
- **Patterns to follow:** `parseAcceptReply`, `parseAcceptedListReply` and `buildAcceptedList`.
- **Test scenarios:**
  - `accept component 2 because no newer version` on New returns the accept action with the row ids and the reason in the casing typed.
  - `accept component A1 A3` on Already ticketed is accepted; a row id from the other screen is rejected naming the row.
  - On New, plain `accept 2` still means CVEs; on Already ticketed, plain `accept A1` is invalid with a hint to the component form.
  - The Remove reply for a component entry cannot be parsed as the `unaccept <component> <CVE>` form, and the reverse; the disjointness test covers the new words.
  - The list screen shows a mixed file with a Remove link on every entry, with untrusted text neutralized.
- **Verification:** the vocabulary disjointness test passes with the new words.

### U5. Accept and remove handlers with live effects

- **Goal:** Accepting a component writes the entry and immediately updates the open review.
- **Requirements:** R1, R2, R4, R5, R8; KTD5.
- **Dependencies:** U1, U2, U3, U4.
- **Files:** `src/participant/jira/importAccept.ts`, `src/participant/jira/reportImportHandler.ts`, `src/participant/session/importTypes.ts`, `src/test/reportImportAcceptedHandler.test.ts`.
- **Approach:**
  - Add `acceptComponents` beside `acceptRows`: write the component entries for the named rows, drop the named rows from `allRows` and the visible page (New and Already ticketed), recount `acceptedHidden.components`, and leave the session unchanged when the write fails.
  - For named Already ticketed rows, move any stored candidate whose active ids are now all accepted onto the Stale list through the existing `buildStaleTicketGroups`, keeping toggles and closed marks on tickets already listed.
  - Add the component-entry removal beside `unacceptEntry`. As today, rows already hidden stay hidden in the open review and the entry's rows come back on the next import.
  - Decide how the reply handler reaches the Jira client the group builder needs, and keep that route minimal.
- **Patterns to follow:** `acceptRows`, `unacceptEntry`, and the stale-section merge shape in `reportImportHandler.ts`.
- **Test scenarios:**
  - Covers AE2. Accepting an Already ticketed row with an open ticket removes the row and adds its ticket to Stale, unselected.
  - Covers AE3. Accepting a row whose ticket is resolved removes the row and adds nothing to Stale.
  - Accepting a row whose ticket also covers an active component leaves the ticket off Stale.
  - Accepting from New removes the row, including a merged row's accepted member, and counts it.
  - Tickets already on Stale keep their selection and closed state after another accept.
  - A failed file write leaves rows, Stale and counts exactly as they were and shows the message.
  - Removing an entry confirms that the component returns on the next import and not in this review.
  - Accepting the same row twice reports it as already accepted.
- **Verification:** the existing `accept` handler tests pass unchanged.

### U6. Documentation

- **Goal:** Developers and users can find the new behavior.
- **Requirements:** R1 to R11.
- **Dependencies:** U1 to U5.
- **Files:** `docs/report-import.md`, `docs/manual/report-imports.md`, `CLAUDE.md`.
- **Approach:**
  - `docs/report-import.md`: extend "Accepted CVEs (Waltz)" with the entry kinds, the three application points, the Stale snapshot and the schema bump.
  - `docs/manual/report-imports.md`: add the new replies, the exact-version rule, the effect on the three screens, the file example with a component entry, and the older-extension note.
  - `CLAUDE.md`: update the rows for `waltzAccepted.ts`, `AcceptedListService.ts` and the import files only where their responsibility changed.
- **Test expectation:** none -- documentation only; `src/test/userDocsSync.test.ts` must still pass because no setting or command changed.
- **Verification:** the manual's "New screen only" statement is corrected, and the example file parses with `parseAcceptedFile`.

---

## Verification Contract

| Check | Command or evidence | Applies to |
| --- | --- | --- |
| Type check | `npm run compile` | every unit |
| Unit tests | `npm test` | every unit; green before any commit |
| Accepted-list tests | `src/test/waltzAccepted.test.ts`, `src/test/AcceptedListService.test.ts`, `src/test/reportImportAccepted.test.ts`, `src/test/reportImportAcceptedHandler.test.ts`, `src/test/reportImportAcceptReplies.test.ts` | U1, U2, U4, U5 |
| Stale and overview tests | `src/test/reportImportStale.test.ts`, `src/test/reportImportOverview.test.ts` | U2, U3 |
| User-doc sync | `src/test/userDocsSync.test.ts` | U6 |

The e2e suite is not needed: the changes are in code Vitest can load.

## Definition of Done

- Every AE (AE1 to AE6) has a passing test that names it.
- A pre-existing per-CVE accepted file produces the same import as before (AE6).
- The Veracode and email imports behave exactly as before.
- `npm run compile` and `npm test` pass.
- `docs/report-import.md`, `docs/manual/report-imports.md` and `CLAUDE.md` match the shipped behavior.
- No abandoned experimental code is left in the diff.
