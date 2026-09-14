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

Replace the single hardcoded 20 MB `MAX_REPORT_BYTES` cap — shared today by
the Veracode, Waltz, and email-batch importers — with one VS Code setting
per report type, each with its own sane default. A 25 MB Veracode Detailed
Report, or any report under the new caps, imports without a code change or
release.

### Problem Frame

`reportImport.ts` defines `MAX_REPORT_BYTES = 20 * 1024 * 1024` as the one
size ceiling for all three report importers (Veracode XML, Waltz `.xlsx`,
and the summed size of an `.eml` batch). Veracode Detailed Report XML grows
with the number of flaws in scope, and a 25 MB export — an unremarkable
size for an active codebase — is rejected outright with no way for the user
to raise the limit short of editing and rebuilding the extension.

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
  shared the same constant and the same problem shape, not because either
  was separately reported as broken.

### Outstanding Questions

None — Resolve Before Planning: none. Deferred to Planning: the exact
`readAndFilterReport`/`MAX_EMAIL_BATCH_BYTES` call-site wiring (how the
per-importer byte limit is threaded from each `*Handler.ts`'s config read
into the shared, `vscode`-free `reportImport.ts`/`veracodeReport.ts`/
`waltzReport.ts` functions, mirroring the existing `minSeverity`/
`includeRemediationStatuses` pattern in `veracodeHandler.ts`) is
implementation detail for `ce-plan`.
