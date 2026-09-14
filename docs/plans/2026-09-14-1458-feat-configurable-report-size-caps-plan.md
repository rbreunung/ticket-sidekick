---
title: Configurable Report Size Caps - Plan
type: feat
date: 2026-09-14
topic: configurable-report-size-caps
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

**Objective:** A user with a Veracode Detailed Report (or Waltz OSS Report,
or a batch of `.eml` files) larger than the current 20 MB limit can raise
that limit themselves, per report type, without a Ticket Sidekick release.

**Product authority:** User-directed in this session — the fix is a
per-report-type VS Code setting, not a single raised constant or an
unbounded cap.

**Open blockers:** none.

## Product Contract

### Summary

Replace the two hardcoded size ceilings — `MAX_REPORT_BYTES` (20 MB,
shared by Veracode and Waltz) and `MAX_EMAIL_BATCH_BYTES` (150 MB, email
batches) — with one VS Code setting per report type, each with its own
sane default. A 25 MB Veracode Detailed Report, or any report under the
new caps, imports without a code change or release.

### Problem Frame

`reportImport.ts` defines `MAX_REPORT_BYTES = 20 * 1024 * 1024` as the one
size ceiling shared by the Veracode XML and Waltz `.xlsx` importers (email
batches already have their own separate `MAX_EMAIL_BATCH_BYTES` constant).
Veracode Detailed Report XML grows with the number of flaws in scope, and a
25 MB export — an unremarkable size for an active codebase — is rejected
outright with no way for the user to raise the limit short of editing and
rebuilding the extension.

### Requirements

- R1. `ticketSidekick.veracode.maxReportSizeMB` is a new setting (default
  50, minimum 1, maximum 200) that governs the size cap enforced on a
  Veracode Detailed Report import, replacing the shared constant for this
  importer.
- R2. `ticketSidekick.waltz.maxReportSizeMB` is a new setting (default 50,
  minimum 1, maximum 200) that governs the size cap enforced on a Waltz OSS
  Report import, replacing the shared constant for this importer.
- R3. `ticketSidekick.email.maxBatchSizeMB` is a new setting (default 150,
  minimum 1, maximum 500) that governs the size cap enforced on the summed
  size of a selected `.eml` batch, replacing the shared constant for this
  importer.
- R4. Each importer reads its own setting at the point it currently reads
  `MAX_REPORT_BYTES`/`MAX_EMAIL_BATCH_BYTES`, so a value the user changes
  takes effect on the next import with no reload beyond VS Code's normal
  settings-change behavior.
- R5. The size-limit error message for each importer states the limit the
  user is actually bound by (their configured value, not a fixed number),
  so a user who has already raised the cap and still hits it sees the
  correct ceiling.
- R6. An out-of-range or non-numeric setting value falls back to that
  importer's default rather than disabling the cap or crashing the import.

### Key Decisions

- **Per-report-type settings, not one shared constant or an unbounded
  cap.** (session-settled: user-directed — chosen over raising the shared
  fixed cap and over dropping Veracode's cap entirely: the user wants each
  report type independently tunable from Settings rather than another fixed
  number that will eventually be too small again.) Governs R1, R2, R3.
- **Defaults set by the agent, not negotiated per number.** (session-settled:
  user-approved — the user deferred the exact default/min/max values to "a
  reasonable default for each" rather than picking numbers themselves.)
  Governs R1, R2, R3.

### Scope Boundaries

- No change to how a report is parsed or how much of it is held in memory
  at once — this only changes where the ceiling is set and who can move it.
- No new UI beyond the standard VS Code Settings entries; no in-chat setting
  editor.
- Waltz and email caps move to settings alongside Veracode's because they
  shared the same problem shape — a single hardcoded, unconfigurable
  ceiling — not because either was separately reported as broken.

### Outstanding Questions

None.

**Product Contract preservation:** unchanged — planning added no product-scope
change; enrichment below adds only Planning Contract, Implementation Units,
Verification Contract, and Definition of Done.

## Planning Contract

### Key Technical Decisions

- KTD1. A single pure helper, `resolveMaxReportBytes` in `src/utils/reportImport.ts`,
  turns a configured MB value into a validated byte limit — clamping or
  defaulting per R6. All four config-reading call sites (extension.ts's two
  command registrations, `veracodeHandler.ts`, `waltzHandler.ts`,
  `emailHandler.ts`) call this one function instead of re-implementing the
  same range check four times. Governs R6.
- KTD2. `assertSafeVeracodeXml`, `parseVeracodeReport`, `assertSafeWaltzReportSize`,
  `parseWaltzReport`, and `readAndFilterReport` each take an explicit
  `maxBytes` parameter defaulting to the existing `MAX_REPORT_BYTES`
  constant. The default keeps every existing single-argument test call
  compiling unchanged; only the four config-reading call sites pass a
  resolved value explicitly. (session-settled: user-approved — the user
  confirmed extending both the command-palette entry point and the
  `@jira` chat entry point rather than narrowing to the one the bug report
  named.) Governs R4, R5.
- KTD3. Both entry points that read a report today are updated, not only the
  one named in the bug report: extension.ts's `ticket-sidekick.importVeracodeReport`/
  `importWaltzReport` command-palette registrations, and the `@jira`
  chat-driven import flow (`veracodeHandler.ts`/`waltzHandler.ts`, via
  `reportImportHandler.ts`). Both call the same `readAndFilterReport`, so a
  fix to only one would leave the other silently capped at 20 MB. Governs
  R1, R2, R4, R5. (session-settled: user-directed — see KTD2's annotation;
  same decision, cited once per KTD-authoring convention.)
- KTD4. The email batch cap (`checkEmailBatchCaps` in `emailHandler.ts`)
  follows the identical shape: reads `ticketSidekick.email.maxBatchSizeMB`
  through `resolveMaxReportBytes` (KTD1) in place of the hardcoded
  `MAX_EMAIL_BATCH_BYTES` constant. Governs R3, R6.

### Assumptions

- The three new settings' `minimum`/`maximum`/`default` values (veracode/waltz:
  1–200 MB, default 50; email: 1–500 MB, default 150) are the agent's
  reasonable-default judgment call per the brainstorm's Key Decisions — the
  user did not pick exact numbers and can adjust any of the three at any
  time without a further plan.

### Sequencing

U1 has no dependency. U2 depends on U1 only for the setting names it reads
(not for the pure logic itself, which needs no `vscode` import). U3 and U4
depend on U2. U5 depends on U3 and U4.

## Implementation Units

### U1. Add the three settings to `package.json`

**Goal:** Declare `ticketSidekick.veracode.maxReportSizeMB`,
`ticketSidekick.waltz.maxReportSizeMB`, and `ticketSidekick.email.maxBatchSizeMB`
so they appear in VS Code Settings with validated bounds.

**Requirements:** R1, R2, R3

**Dependencies:** none

**Files:**
- `package.json`

**Approach:**
- Add `ticketSidekick.veracode.maxReportSizeMB` (`type: number`, `default: 50`,
  `minimum: 1`, `maximum: 200`) next to the existing `veracode.minSeverity`/
  `veracode.includeRemediationStatuses` properties.
- Add `ticketSidekick.waltz.maxReportSizeMB` with the same bounds/default next
  to `waltz.minVulnRating`/`waltz.includeRemediationActions`.
- Add `ticketSidekick.email.maxBatchSizeMB` (`default: 150`, `minimum: 1`,
  `maximum: 500`) next to the existing `email.deleteEmlAfterImport` property.
- Each `description` states the MB unit and which import it governs, matching
  the wording style of the existing properties in that section.

**Patterns to follow:** `ticketSidekick.veracode.minSeverity`'s
`type`/`default`/`minimum`/`maximum`/`description` shape (`package.json`).

**Test scenarios:**
- Test expectation: none — schema-only addition with no runtime logic;
  `npm run compile` and the existing packaging step validate the JSON.

**Verification:** The three properties appear under their existing
`veracode`/`waltz`/`email` configuration sections and `npm run compile`
passes.

### U2. Thread a configurable byte limit through the pure report-parsing functions

**Goal:** Replace every internal use of the hardcoded `MAX_REPORT_BYTES`
constant inside the `vscode`-free parsing/size-check functions with an
explicit parameter, and add the shared resolver that turns a configured MB
value into a validated byte limit.

**Requirements:** R4, R5, R6 (KTD1, KTD2)

**Dependencies:** U1 (setting names/bounds this unit's resolver validates
against)

**Files:**
- `src/utils/reportImport.ts`
- `src/utils/veracodeReport.ts`
- `src/utils/waltzReport.ts`
- `src/participant/jira/reportImportHandler.ts`
- `src/test/reportImport.test.ts`
- `src/test/veracodeReport.test.ts`
- `src/test/waltzReport.test.ts`

**Approach:**
1. In `reportImport.ts`, add `resolveMaxReportBytes(configuredMB: unknown, defaultMB: number, minMB: number, maxMB: number): number` — returns `defaultMB * 1024 * 1024` bytes when `configuredMB` is not a finite number or falls outside `[minMB, maxMB]`, otherwise the clamped value in bytes. `MAX_REPORT_BYTES` stays exported as the fallback default consumed by step 2's default parameters.
2. In `veracodeReport.ts` and `waltzReport.ts`, give `assertSafeVeracodeXml`/`parseVeracodeReport`/`assertSafeWaltzReportSize`/`parseWaltzReport` an explicit `maxBytes = MAX_REPORT_BYTES` parameter (KTD2), used in place of the module-level constant inside each check and error message.
3. In `reportImportHandler.ts`, give `readAndFilterReport` the same `maxBytes = MAX_REPORT_BYTES` parameter, used in its `stat.size` check and thrown message instead of the imported constant.

**Patterns to follow:** the existing "defense-in-depth" comment structure in
`veracodeReport.ts`/`waltzReport.ts` documenting why the size check exists in
two places; keep both call sites' comments accurate once they take a
parameter instead of reading the module constant directly.

**Test scenarios:**
- `resolveMaxReportBytes` returns the default in bytes when given `undefined`.
- `resolveMaxReportBytes` returns the default in bytes when given a
  non-numeric value (e.g. a string).
- `resolveMaxReportBytes` returns the default in bytes when given a value
  below `minMB` or above `maxMB`.
- `resolveMaxReportBytes` returns the configured value in bytes when it is a
  valid in-range number.
- `assertSafeVeracodeXml`/`parseVeracodeReport` accept a raw document under a
  custom `maxBytes` that the existing 20 MB default would have rejected.
- `assertSafeVeracodeXml`/`parseVeracodeReport` still reject a document over
  a custom (smaller or larger) `maxBytes`, with the error message reporting
  that custom limit's MB value.
- Same two scenarios mirrored for `assertSafeWaltzReportSize`/`parseWaltzReport`.
- Existing single-argument test calls (the current `veracodeReport.test.ts`/
  `waltzReport.test.ts` suites) continue to pass unmodified, proving the
  default parameter preserves current behavior.

**Verification:** `npm test` passes, including the new
`resolveMaxReportBytes` and custom-limit scenarios above.

### U3. Wire the Veracode and Waltz entry points to their new settings

**Goal:** Both the command-palette import commands and the `@jira` chat
import flow resolve their own configured size limit and pass it through to
U2's functions, and report that same limit in their error messages.

**Requirements:** R1, R2, R4, R5 (KTD1, KTD2, KTD3)

**Dependencies:** U2

**Files:**
- `src/extension.ts`
- `src/participant/jira/veracodeHandler.ts`
- `src/participant/jira/waltzHandler.ts`
- `src/test/veracodeReport.test.ts`
- `src/test/waltzReport.test.ts`

**Approach:**
1. In `veracodeHandler.ts`/`waltzHandler.ts`, extend `getVeracodeConfig()`/
   `getWaltzConfig()` to also resolve `maxReportSizeMB` via
   `resolveMaxReportBytes` (default 50, bounds 1–200) and pass the byte
   value into `parseVeracodeReport`/`assertSafeVeracodeXml` and
   `parseWaltzReport`/`assertSafeWaltzReportSize` calls inside
   `readAndFilterVeracodeFile`/`readAndFilterWaltzFile`, and into
   `readAndFilterReport`'s new `maxBytes` argument.
2. In `extension.ts`'s two `registerReportImportCommand` registrations,
   resolve the same setting once per invocation (mirroring the existing
   inline `veracodeCfg.get<...>`/`waltzCfg.get<...>` reads already in each
   `filter` closure) and pass it to `readAndFilterReport`; use that same
   resolved byte value — not the imported `MAX_REPORT_BYTES` constant — when
   composing the outer catch block's `Report exceeds the … MB size limit`
   message. Also pass it into that same registration's `parse:` field
   (`parse: raw => parseVeracodeReport(raw, resolvedMaxBytes)` / the Waltz
   equivalent) — `parseVeracodeReport`/`parseWaltzReport` run their own
   defense-in-depth re-check internally (U2), so leaving `parse:` on the
   20 MB default would silently reject a report between 20 MB and the
   user's raised setting right after `readAndFilterReport`'s own check let
   it through.

**Patterns to follow:** `getVeracodeConfig()`'s existing
`cfg.get<number>('veracode.minSeverity') ?? 4` shape (`veracodeHandler.ts`);
the inline `vscode.workspace.getConfiguration('ticketSidekick')` read already
duplicated in each `filter` closure in `extension.ts`.

**Test scenarios:**
- Covers AE (implicit): a Veracode report between 20 MB and the configured
  Veracode limit imports successfully through both entry points, where the
  current behavior would reject it.
- A Veracode/Waltz report over the *configured* (non-default) limit is
  rejected, with the shown error message stating that configured MB value.
- An out-of-range `maxReportSizeMB` setting (e.g. `0` or `500`) falls back to
  the 50 MB default rather than disabling the cap.
- Waltz mirrors the same three scenarios.

**Verification:** `npm test` passes; a manual or e2e check confirms the
command-palette flow's error message reflects a changed setting value.

### U4. Wire the email batch cap to its new setting

**Goal:** `checkEmailBatchCaps` resolves `ticketSidekick.email.maxBatchSizeMB`
through the same shared helper instead of the hardcoded
`MAX_EMAIL_BATCH_BYTES` constant.

**Requirements:** R3, R4, R5 (KTD1, KTD4)

**Dependencies:** U2

**Files:**
- `src/participant/jira/emailHandler.ts`
- `src/test/emailHandler.test.ts`

**Approach:**
1. Add a small `getEmailMaxBatchBytes()` helper (matching
   `getVeracodeConfig()`'s shape) that reads `email.maxBatchSizeMB` and
   resolves it via `resolveMaxReportBytes` (default 150, bounds 1–500).
2. In `checkEmailBatchCaps`, replace the `MAX_EMAIL_BATCH_BYTES` comparison
   and the `capMb` used in its message with this resolved value.

**Patterns to follow:** `getVeracodeConfig()` (`veracodeHandler.ts`);
`checkEmailBatchCaps`'s existing `BATCH_LIMIT` check, left unchanged.

**Test scenarios:**
- A batch under the default 150 MB total still passes (unchanged behavior).
- A batch under a configured, raised `maxBatchSizeMB` that would have failed
  the old fixed 150 MB constant now passes.
- A batch over a configured (smaller) `maxBatchSizeMB` is rejected, with the
  message stating that configured MB value.
- An out-of-range or non-numeric `maxBatchSizeMB` falls back to the 150 MB
  default.

**Verification:** `npm test` passes.

### U5. Regression pass across all three importers

**Goal:** Confirm the default-unset-setting behavior is byte-for-byte
unchanged from today, so users who never touch these settings see no
difference besides the fix.

**Requirements:** R6

**Dependencies:** U3, U4

**Files:**
- `src/test/veracodeReport.test.ts`
- `src/test/waltzReport.test.ts`
- `src/test/emailHandler.test.ts`
- `src/test/reportImportHandler.test.ts`

**Approach:**
- Run the full existing suites for these four files and confirm every
  pre-existing test (the 20/21 MB boundary cases included) still passes
  unmodified, proving the new default-parameter/resolver plumbing is
  behavior-preserving when no setting is configured.

**Test scenarios:**
- Test expectation: none beyond U2–U4's own new scenarios — this unit is a
  full-suite confirmation pass, not new behavior.

**Verification:** `npm test` passes with no regressions in any of the four
files' existing test counts.

## Verification Contract

- `npm run compile` — TypeScript type check; must pass before `npm test`.
- `npm test` — Vitest unit tests covering U2 (`resolveMaxReportBytes`,
  parameterized size checks), U3 (Veracode/Waltz entry-point wiring), U4
  (email batch cap), and U5 (regression pass). No `vscode` import is needed
  for U2's tests; U3/U4's config-reading wrapper functions
  (`getVeracodeConfig`, `getWaltzConfig`, the new email helper) stay covered
  indirectly through the exported functions that call them, matching how
  `minSeverity`/`includeRemediationStatuses` are tested today.
- `npm run test:e2e` is not required for this change (no new command, chat
  route, or UI surface) but may be run manually to confirm the command-palette
  error message reads correctly end-to-end.

## Definition of Done

- All three settings (R1, R2, R3) exist in `package.json` with the stated
  bounds and appear in VS Code Settings.
- A Veracode, Waltz, or email import that would have failed the old 20 MB /
  150 MB constant succeeds once its report/batch is under the user's
  configured limit (R4).
- Every size-limit error message states the limit actually in effect for
  that import (R5).
- An invalid setting value falls back to the default rather than disabling
  the cap or crashing (R6).
- `npm run compile` and `npm test` are green.
- No leftover dead code: `MAX_REPORT_BYTES`/`MAX_EMAIL_BATCH_BYTES` remain
  only as the default-parameter fallbacks KTD2 relies on, not as
  still-hardcoded enforcement anywhere U2–U4 touched.
